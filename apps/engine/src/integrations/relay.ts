/**
 * Relay (relay.link): Robinhood Chain ETH → Arbitrum USDC, delivered to the protocol wallet.
 * Every quote is checked before signing: single deposit tx on RHC from our wallet, exact value, `to` is
 * one of the pinned Relay depository contracts (config, not Relay's own API), the calldata is exactly
 * `depositNative(wallet, orderId)` for a non-zero order id, recipient and output currency match, the
 * reported impact is numeric and bounded, and the output clears a floor derived from the engine's own
 * ETH/USD price. The quote's request id is handed to the caller before signing so an unconfirmed deposit
 * can be looked up later (`depositStatus`).
 */
import { decodeFunctionData, encodeFunctionData, formatUnits, isAddressEqual, parseAbi } from 'viem';
import type { Address } from 'viem';
import { CHAINS } from '@bellwether/shared';
import type { Bridge, BridgeDepositStatus, Hex, NetworkConfig } from '../ports.ts';
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
    /** Relay's id for the order; `/intents/status` looks it up. */
    requestId?: string;
    items: { data: { from: Address; to: Address; data: Hex; value: string; chainId: number } }[];
  }[];
  /** The depository order id the deposit calldata must carry. */
  protocol?: { v2?: { orderId?: string } };
  details: {
    recipient: Address;
    currencyOut: { currency: { chainId: number; address: Address }; amount: string };
    totalImpact: { percent: string };
  };
}

/** The fields of Relay's /intents/status entry the bridge relies on. */
export interface RelayStatus {
  /** waiting | depositing | pending | submitted | success | delayed | refund | failure. */
  status: string;
  inTxHashes?: string[];
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
  const percent: unknown = q.details.totalImpact?.percent;
  // Relay reports impact in percent, negative = loss. Ports use fractions. A missing or non-numeric impact
  // must not become NaN: every `NaN > max` check passes.
  const raw = typeof percent === 'number' ? percent : typeof percent === 'string' && percent.trim() !== '' ? Number(percent) : Number.NaN;
  const impactPct = Math.abs(raw) / 100;
  if (!Number.isFinite(impactPct)) throw new Error(`Relay quote rejected: price impact ${JSON.stringify(percent)} is not a number`);
  return {
    expectedUsdc: Number(formatUnits(BigInt(q.details.currencyOut.amount), USDC_DECIMALS)),
    impactPct,
  };
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO32 = `0x${'0'.repeat(64)}`;

export function fetchRelayStatus(apiUrl: string, requestId: string): Promise<RelayStatus> {
  return fetchJson<RelayStatus>('Relay status', `${apiUrl}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { timeoutMs: 20_000 });
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
 * Everything a quote must satisfy before its deposit tx is signed: one `depositNative(wallet, orderId)` tx on RHC
 * from `wallet` with the exact value to a pinned Relay depository, USDC on Arbitrum to `wallet`, a numeric impact
 * within bounds and at least `minUsdc` out. Returns the deposit tx (calldata re-encoded locally), the request id and
 * the expected output; throws `Relay quote rejected: …` otherwise.
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
  if (!(impactPct <= expect.maxImpactPct)) {
    reject(`price impact ${(impactPct * 100).toFixed(2)}% exceeds ${(expect.maxImpactPct * 100).toFixed(2)}%`);
  }
  if (!(expectedUsdc >= expect.minUsdc)) reject(`output $${expectedUsdc.toFixed(2)} is below the $${expect.minUsdc.toFixed(2)} floor from the engine's ETH/USD price`);
  if (chain.id !== ORIGIN || chain.disabled || !chain.depositEnabled) reject(`Relay deposits on chain ${ORIGIN} are disabled`);
  if (!expect.depositContracts.some((a) => isAddressEqual(a, deposit.to))) {
    reject(`tx target ${deposit.to} is not a pinned Relay depository on chain ${ORIGIN}`);
  }
  let args: readonly [Address, Hex] | null = null;
  try {
    args = decodeFunctionData({ abi: DEPOSITORY_ABI, data: deposit.data }).args;
  } catch {
    reject('tx calldata is not a Relay depositNative call');
  }
  const [depositor, orderId] = args!;
  if (!isAddressEqual(depositor, wallet)) reject(`deposit credits ${depositor}, not the protocol wallet`);
  if (orderId.toLowerCase() === ZERO32) reject('deposit carries a zero order id');
  const quotedOrder = q.protocol?.v2?.orderId;
  if (quotedOrder !== undefined && quotedOrder.toLowerCase() !== orderId.toLowerCase()) {
    reject(`deposit order id ${orderId} is not the quoted order ${quotedOrder}`);
  }
  // Sign only calldata we encoded ourselves: anything Relay appended past the two arguments is dropped by
  // the decoder above, so a byte-for-byte mismatch means the payload is not the plain call we checked.
  const data = encodeFunctionData({ abi: DEPOSITORY_ABI, functionName: 'depositNative', args: [wallet, orderId] });
  if (deposit.data.toLowerCase() !== data.toLowerCase()) reject('tx calldata carries bytes beyond depositNative(depositor, id)');
  const requestId = step!.requestId;
  if (requestId === undefined || !BYTES32.test(requestId)) reject(`missing or malformed request id ${JSON.stringify(requestId)}`);
  return { deposit: { to: deposit.to, data, value: amountWei }, requestId: requestId!, expectedUsdc };
}

/** Relay has seen a deposit for the request once it leaves `waiting`. */
const RELAY_WAITING = 'waiting';

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

    async ethToUsdc(amountWei, maxImpactPct, minUsdc, hooks) {
      if (!sender) throw new ReadOnlyError('Relay bridge');
      const q = await fetchRelayQuote(apiUrl, wallet, net.contracts.arbitrumUsdc, amountWei);
      const chain = await chains.get(String(ORIGIN), () => fetchRelayOriginChain(apiUrl));
      const { deposit, requestId, expectedUsdc } = validateRelayQuote(q, {
        wallet,
        amountWei,
        arbitrumUsdc: net.contracts.arbitrumUsdc,
        maxImpactPct,
        minUsdc,
        depositContracts,
        chain,
      });
      hooks?.prepared?.({ requestId, expectedUsdc });
      const sent = await sender.exclusive((send) =>
        send({
          ...deposit,
          what: `Relay bridge ${formatUnits(amountWei, 18)} ETH`,
          onBroadcast: (hash, nonce) => hooks?.broadcast?.({ chain: 'rhc', hash }, nonce),
        }),
      );
      return { expectedUsdc, tx: sent.ref, gasWei: sent.gasCostWei };
    },

    async depositStatus({ requestId, hash, nonce = null }): Promise<BridgeDepositStatus> {
      if (!sender) throw new ReadOnlyError('Relay bridge');
      // Relay's view finds a deposit whose hash was never recorded; the chain decides whether the ETH left.
      let relay: RelayStatus | null = null;
      try {
        relay = await fetchRelayStatus(apiUrl, requestId);
      } catch (err) {
        // Without a recorded hash Relay is the only witness: never call a deposit unknown because it was unreachable.
        if (hash === null && !(err instanceof HttpError && err.status >= 400 && err.status < 500)) throw err;
      }
      const txHash = hash ?? relay?.inTxHashes?.find((h) => BYTES32.test(h)) ?? null;
      if (txHash === null) return relay && relay.status !== RELAY_WAITING ? { state: 'pending' } : { state: 'unknown' };
      // The nonce is read first: a receipt still missing after it means the tx had not mined when the nonce was used up.
      const mined = hash !== null && nonce !== null ? await sender.minedNonce() : null;
      const sent = await sender.lookup(txHash as Hex);
      if (!sent) return mined !== null && mined > nonce! ? { state: 'dropped' } : { state: 'pending' };
      // A hash reported by Relay alone must be our own deposit before it settles anything.
      if (!isAddressEqual(sent.receipt.from, wallet)) return { state: 'unknown' };
      if (sent.receipt.status !== 'success') return { state: 'reverted', tx: sent.ref, gasWei: sent.gasCostWei };
      if (relay?.status === 'refund') return { state: 'refunded', tx: sent.ref, gasWei: sent.gasCostWei };
      return { state: 'landed', tx: sent.ref, gasWei: sent.gasCostWei, filled: relay?.status === 'success' };
    },
  };
}
