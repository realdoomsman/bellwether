/**
 * Relay (relay.link): Robinhood Chain ETH → Arbitrum USDC, delivered to the protocol wallet.
 * Every quote is checked before signing: single deposit tx on RHC from our wallet, exact value,
 * `to` is one of Relay's published contracts for the chain, recipient and output currency match.
 */
import { formatUnits, isAddressEqual } from 'viem';
import type { Address } from 'viem';
import { CHAINS } from '@floor/shared';
import type { Bridge, Hex, NetworkConfig } from '../ports.ts';
import { ReadOnlyError } from './errors.ts';
import { HttpError, fetchJson, TtlCache } from './http.ts';
import type { TxSender } from './tx.ts';

export const DEFAULT_RELAY_API_URL = 'https://api.relay.link';
const USDC_DECIMALS = 6;
const CHAINS_TTL_MS = 10 * 60_000;

interface RelayQuote {
  steps: {
    id: string;
    kind: string;
    items: { data: { from: Address; to: Address; data: Hex; value: string; chainId: number } }[];
  }[];
  details: {
    recipient: Address;
    currencyOut: { currency: { chainId: number; address: Address }; amount: string };
    totalImpact: { percent: string };
  };
}

interface RelayChain {
  id: number;
  disabled: boolean;
  depositEnabled: boolean;
  contracts?: Record<string, unknown>;
  protocol?: { v2?: { depository?: string } };
}

/** Every address-looking string anywhere in Relay's published contract set for a chain. */
function publishedContracts(chain: RelayChain): Address[] {
  const out: Address[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) out.push(v as Address);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(chain.contracts);
  visit(chain.protocol);
  return out;
}

export interface RelayDeps {
  net: NetworkConfig;
  apiUrl: string;
  sender: TxSender | null;
}

export function createRelayBridge({ net, apiUrl, sender }: RelayDeps): Bridge {
  const wallet = net.protocolAddress;
  const origin = CHAINS.rhc.chainId!;
  const destination = CHAINS.arbitrum.chainId!;
  const chains = new TtlCache<RelayChain>(CHAINS_TTL_MS);

  function fetchQuote(amountWei: bigint): Promise<RelayQuote> {
    return fetchJson<RelayQuote>('Relay quote', `${apiUrl}/quote`, {
      timeoutMs: 20_000,
      body: {
        user: wallet,
        recipient: wallet,
        originChainId: origin,
        destinationChainId: destination,
        originCurrency: '0x0000000000000000000000000000000000000000',
        destinationCurrency: net.contracts.arbitrumUsdc,
        amount: amountWei.toString(),
        tradeType: 'EXACT_INPUT',
      },
    });
  }

  function summarize(q: RelayQuote) {
    return {
      expectedUsdc: Number(formatUnits(BigInt(q.details.currencyOut.amount), USDC_DECIMALS)),
      // Relay reports impact in percent, negative = loss. Ports use fractions.
      impactPct: Math.abs(Number(q.details.totalImpact.percent)) / 100,
    };
  }

  return {
    async quote(amountWei) {
      try {
        return summarize(await fetchQuote(amountWei));
      } catch (err) {
        // 4xx = Relay has no route for this amount right now (too small, liquidity, ...).
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) return null;
        throw err;
      }
    },

    async ethToUsdc(amountWei, maxImpactPct) {
      if (!sender) throw new ReadOnlyError('Relay bridge');
      const q = await fetchQuote(amountWei);
      const { expectedUsdc, impactPct } = summarize(q);
      const step = q.steps[0];
      const tx = step?.items[0]?.data;
      const reject = (why: string): never => {
        throw new Error(`Relay quote rejected: ${why}`);
      };
      if (q.steps.length !== 1 || step?.kind !== 'transaction' || step.items.length !== 1 || !tx) {
        reject(`expected one deposit transaction, got ${JSON.stringify(q.steps.map((s) => `${s.id}:${s.kind}x${s.items.length}`))}`);
      }
      const deposit = tx!;
      if (deposit.chainId !== origin) reject(`tx is for chain ${deposit.chainId}, not ${origin}`);
      if (!isAddressEqual(deposit.from, wallet)) reject(`tx sender ${deposit.from} is not the protocol wallet`);
      if (BigInt(deposit.value) !== amountWei) reject(`tx value ${deposit.value} != requested ${amountWei}`);
      if (!isAddressEqual(q.details.recipient, wallet)) reject(`recipient ${q.details.recipient} is not the protocol wallet`);
      const out = q.details.currencyOut.currency;
      if (out.chainId !== destination || !isAddressEqual(out.address, net.contracts.arbitrumUsdc)) {
        reject(`output ${out.address} on chain ${out.chainId} is not Arbitrum USDC`);
      }
      if (!(expectedUsdc > 0)) reject('zero output');
      if (impactPct > maxImpactPct) reject(`price impact ${(impactPct * 100).toFixed(2)}% exceeds ${(maxImpactPct * 100).toFixed(2)}%`);

      const chain = await chains.get(String(origin), async () => {
        const res = await fetchJson<{ chains: RelayChain[] }>('Relay chains', `${apiUrl}/chains`);
        const c = res.chains.find((x) => x.id === origin);
        if (!c) throw new Error(`Relay does not list chain ${origin}`);
        return c;
      });
      if (chain.disabled || !chain.depositEnabled) reject(`Relay deposits on chain ${origin} are disabled`);
      if (!publishedContracts(chain).some((a) => isAddressEqual(a, deposit.to))) {
        reject(`tx target ${deposit.to} is not a published Relay contract on chain ${origin}`);
      }

      const sent = await sender.exclusive((send) =>
        send({ to: deposit.to, data: deposit.data, value: amountWei, what: `Relay bridge ${formatUnits(amountWei, 18)} ETH` }),
      );
      return { expectedUsdc, tx: sent.ref };
    },
  };
}
