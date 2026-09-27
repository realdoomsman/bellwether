/**
 * Relay (relay.link): Robinhood Chain ETH → Arbitrum USDC, delivered to the protocol wallet.
 * Every quote is checked before signing: single deposit tx on RHC from our wallet, exact value, `to` is
 * one of the pinned Relay depository contracts (config, not Relay's own API), the calldata is a plain
 * `depositNative` crediting our wallet, recipient and output currency match, and the output clears a
 * floor derived from the engine's own ETH/USD price.
 */
import { decodeFunctionData, formatUnits, isAddressEqual, parseAbi } from 'viem';
import type { Address } from 'viem';
import { CHAINS } from '@bellwether/shared';
import type { Bridge, Hex, NetworkConfig } from '../ports.ts';
import { ReadOnlyError } from './errors.ts';
import { HttpError, fetchJson, TtlCache } from './http.ts';
import type { TxSender } from './tx.ts';

export const DEFAULT_RELAY_API_URL = 'https://api.relay.link';
const USDC_DECIMALS = 6;
const CHAINS_TTL_MS = 10 * 60_000;
/** Relay v2 depository entry point for native deposits (what `/quote` returns for RHC ETH). */
const DEPOSITORY_ABI = parseAbi(['function depositNative(address depositor, bytes32 id)']);
/**
 * Relay's v2 depository on Robinhood Chain: `protocol.v2.depository` in Relay's /chains entry for 4663 and
 * the `to` of its live ETH→USDC quotes (checked 2026-09). Overridable with RELAY_DEPOSIT_CONTRACTS.
 */
export const DEFAULT_RELAY_DEPOSIT_CONTRACTS: readonly Address[] = ['0x4cd00e387622c35bddb9b4c962c136462338bc31'];

export interface RelayQuote {
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

/** The fields of Relay's /chains entry the bridge relies on. */
export interface RelayChain {
  id: number;
  disabled: boolean;
  depositEnabled: boolean;
}

const ORIGIN = CHAINS.rhc.chainId!;
const DESTINATION = CHAINS.arbitrum.chainId!;

/** EXACT_INPUT quote: `amountWei` of RHC ETH from `wallet` → Arbitrum USDC delivered to `wallet`. */
export function fetchRelayQuote(apiUrl: string, wallet: Address, arbitrumUsdc: Address, amountWei: bigint): Promise<RelayQuote> {
  return fetchJson<RelayQuote>('Relay quote', `${apiUrl}/quote`, {
    timeoutMs: 20_000,
    body: {
      user: wallet,
      recipient: wallet,
      originChainId: ORIGIN,
      destinationChainId: DESTINATION,
      originCurrency: '0x0000000000000000000000000000000000000000',
      destinationCurrency: arbitrumUsdc,
      amount: amountWei.toString(),
      tradeType: 'EXACT_INPUT',
    },
  });
}

/** Relay's chain entry for Robinhood Chain (deposit flags). */
export async function fetchRelayOriginChain(apiUrl: string): Promise<RelayChain> {
  const res = await fetchJson<{ chains: RelayChain[] }>('Relay chains', `${apiUrl}/chains`);
  const c = res.chains.find((x) => x.id === ORIGIN);
  if (!c) throw new Error(`Relay does not list chain ${ORIGIN}`);
  return c;
}

function summarize(q: RelayQuote) {
  return {
    expectedUsdc: Number(formatUnits(BigInt(q.details.currencyOut.amount), USDC_DECIMALS)),
    // Relay reports impact in percent, negative = loss. Ports use fractions.
    impactPct: Math.abs(Number(q.details.totalImpact.percent)) / 100,
  };
}

export interface RelayQuoteExpectation {
  wallet: Address;
  amountWei: bigint;
  arbitrumUsdc: Address;
  maxImpactPct: number;
  /** Least USDC the deposit must promise, from the engine's own ETH/USD price (Relay's impact is self-reported). */
  minUsdc: number;
  /** Pinned Relay depository contracts on RHC the deposit may target. */
  depositContracts: readonly Address[];
  /** Relay's origin chain entry (see `fetchRelayOriginChain`). */
  chain: RelayChain;
}

/**
 * Everything a quote must satisfy before its deposit tx is signed: one `depositNative(wallet, id)` tx on RHC
 * from `wallet` with the exact value to a pinned Relay depository, USDC on Arbitrum to `wallet`, bounded
 * impact and at least `minUsdc` out. Returns the deposit tx and expected output; throws `Relay quote rejected: …` otherwise.
 */
export function validateRelayQuote(q: RelayQuote, expect: RelayQuoteExpectation) {
  const { wallet, amountWei, chain } = expect;
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
  if (deposit.chainId !== ORIGIN) reject(`tx is for chain ${deposit.chainId}, not ${ORIGIN}`);
  if (!isAddressEqual(deposit.from, wallet)) reject(`tx sender ${deposit.from} is not the protocol wallet`);
  if (BigInt(deposit.value) !== amountWei) reject(`tx value ${deposit.value} != requested ${amountWei}`);
  if (!isAddressEqual(q.details.recipient, wallet)) reject(`recipient ${q.details.recipient} is not the protocol wallet`);
  const out = q.details.currencyOut.currency;
  if (out.chainId !== DESTINATION || !isAddressEqual(out.address, expect.arbitrumUsdc)) {
    reject(`output ${out.address} on chain ${out.chainId} is not Arbitrum USDC`);
  }
  if (!(expectedUsdc > 0)) reject('zero output');
  if (impactPct > expect.maxImpactPct) {
    reject(`price impact ${(impactPct * 100).toFixed(2)}% exceeds ${(expect.maxImpactPct * 100).toFixed(2)}%`);
  }
  if (expectedUsdc < expect.minUsdc) reject(`output $${expectedUsdc.toFixed(2)} is below the $${expect.minUsdc.toFixed(2)} floor from the engine's ETH/USD price`);
  if (chain.id !== ORIGIN || chain.disabled || !chain.depositEnabled) reject(`Relay deposits on chain ${ORIGIN} are disabled`);
  if (!expect.depositContracts.some((a) => isAddressEqual(a, deposit.to))) {
    reject(`tx target ${deposit.to} is not a pinned Relay depository on chain ${ORIGIN}`);
  }
  let depositor: Address | null = null;
  try {
    depositor = decodeFunctionData({ abi: DEPOSITORY_ABI, data: deposit.data }).args[0];
  } catch {
    reject('tx calldata is not a Relay depositNative call');
  }
  if (!isAddressEqual(depositor!, wallet)) reject(`deposit credits ${depositor}, not the protocol wallet`);
  return { deposit, expectedUsdc };
}

export interface RelayDeps {
  net: NetworkConfig;
  apiUrl: string;
  /** Pinned Relay depository contracts on RHC (RELAY_DEPOSIT_CONTRACTS). */
  depositContracts: readonly Address[];
  sender: TxSender | null;
}

export function createRelayBridge({ net, apiUrl, depositContracts, sender }: RelayDeps): Bridge {
  const wallet = net.protocolAddress;
  const chains = new TtlCache<RelayChain>(CHAINS_TTL_MS);

  return {
    async quote(amountWei) {
      try {
        return summarize(await fetchRelayQuote(apiUrl, wallet, net.contracts.arbitrumUsdc, amountWei));
      } catch (err) {
        // 4xx = Relay has no route for this amount right now (too small, liquidity, ...).
        if (err instanceof HttpError && err.status >= 400 && err.status < 500) return null;
        throw err;
      }
    },

    async ethToUsdc(amountWei, maxImpactPct, minUsdc) {
      if (!sender) throw new ReadOnlyError('Relay bridge');
      const q = await fetchRelayQuote(apiUrl, wallet, net.contracts.arbitrumUsdc, amountWei);
      const chain = await chains.get(String(ORIGIN), () => fetchRelayOriginChain(apiUrl));
      const { deposit, expectedUsdc } = validateRelayQuote(q, {
        wallet,
        amountWei,
        arbitrumUsdc: net.contracts.arbitrumUsdc,
        maxImpactPct,
        minUsdc,
        depositContracts,
        chain,
      });
      const sent = await sender.exclusive((send) =>
        send({ to: deposit.to, data: deposit.data, value: amountWei, what: `Relay bridge ${formatUnits(amountWei, 18)} ETH` }),
      );
      return { expectedUsdc, tx: sent.ref };
    },
  };
}
