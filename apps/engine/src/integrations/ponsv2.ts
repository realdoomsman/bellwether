/**
 * Pons V2 (docs.ponsfamily.com/v2, source github.com/ponsdotdev/ponsfamily contractsV2): a launch trades on
 * its own ETH bonding curve, then graduates into a Uniswap V4 pool (fee 0, tick spacing from the launch
 * record) behind a shared hook that charges the trade fee. Fees accrue on the curve (before graduation)
 * or the hook (after), a sweep splits them, and the creator's share is credited to a fee escrow that
 * the creator fee recipient withdraws from.
 */
import {
  BaseError,
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  HttpRequestError,
  isAddressEqual,
  keccak256,
  numberToHex,
  parseAbi,
  RpcRequestError,
  toFunctionSelector,
  zeroAddress,
} from 'viem';
import type { Address } from 'viem';
import type { Hex } from '../ports.ts';
import type { Client } from './chains.ts';
import { shortError } from './errors.ts';
import { addressTopic } from './hex.ts';

export const PONS_V2_FACTORY_ABI = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
]);

export const PONS_V2_CURVE_ABI = parseAbi([
  'function token() view returns (address)',
  'function sweepFees(uint256 minBuybackTokensOut)',
  'event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)',
]);

export const PONS_V2_HOOK_ABI = parseAbi([
  'function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
  'function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)',
  'event PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackSpent, uint256 creatorAmount, uint256 tokensLocked)',
]);

export const PONS_V2_ESCROW_ABI = parseAbi([
  'function balanceOf(address recipient) view returns (uint256)',
  'function balanceOfToken(address recipient, address token) view returns (uint256)',
  'function claim(uint256 amount) returns (uint256)',
  'function claimToken(address token) returns (uint256)',
  'event Credited(address indexed recipient, address indexed source, uint256 amount)',
  'event Claimed(address indexed recipient, uint256 amount)',
]);

/** Graduation phase of a V2 launch (`LaunchedToken.phase`). */
export const PonsV2Phase = { Curve: 0, Swept: 1, Pool: 2, Rescued: 3 } as const;

export interface PonsV2Launch {
  token: Address;
  curve: Address;
  /** EOA that sent the launch transaction. */
  deployer: Address;
  creatorFeeRecipient: Address;
  /** Zero address = native ETH. */
  pairToken: Address;
  poolFee: number;
  tickSpacing: number;
  buybackEnabled: boolean;
  phase: number;
}

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** The V2 factory's record of `token`, or null when the V2 factory did not launch it. */
export async function readPonsV2Launch(rhc: Client, factory: Address, token: Address): Promise<PonsV2Launch | null> {
  const r = await rhc.readContract({ address: factory, abi: PONS_V2_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] });
  if (!r.exists || !isAddressEqual(r.token, token)) return null;
  return {
    token: r.token,
    curve: r.curve,
    deployer: r.deployer,
    creatorFeeRecipient: r.creatorFeeRecipient,
    pairToken: r.pairToken,
    poolFee: r.poolFee,
    tickSpacing: r.tickSpacing,
    buybackEnabled: r.buybackEnabled,
    phase: r.phase,
  };
}

/** The graduated pool's V4 key: currencies sorted by address (native ETH = 0x0 is always currency0), shared hook. */
export function ponsV2PoolKey(launch: Pick<PonsV2Launch, 'token' | 'pairToken' | 'poolFee' | 'tickSpacing'>, hook: Address): V4PoolKey {
  const [currency0, currency1] =
    BigInt(launch.pairToken) < BigInt(launch.token) ? [launch.pairToken, launch.token] : [launch.token, launch.pairToken];
  return { currency0, currency1, fee: launch.poolFee, tickSpacing: launch.tickSpacing, hooks: hook };
}

export function v4PoolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export const NATIVE = zeroAddress;

/** The token a V2 bonding curve trades, or null when `curve` is not a curve the V2 factory recorded. */
export async function ponsV2TokenOfCurve(rhc: Client, factory: Address, curve: Address): Promise<Address | null> {
  let token: Address;
  try {
    token = await rhc.readContract({ address: curve, abi: PONS_V2_CURVE_ABI, functionName: 'token' });
  } catch {
    return null; // not a curve
  }
  const launch = await readPonsV2Launch(rhc, factory, token);
  return launch && isAddressEqual(launch.curve, curve) ? token : null;
}

// ─── Fee escrow attribution ──────────────────────────────────────────────────

const CLAIM_AMOUNT_SELECTOR = toFunctionSelector('claim(uint256)');
/** `claim(uint256)` calldata: selector + one word. A tagged claim appends the 20-byte token address. */
const CLAIM_CALLDATA_CHARS = 2 + 8 + 64;
const CREDITED_TOPIC = encodeEventTopics({ abi: PONS_V2_ESCROW_ABI, eventName: 'Credited' })[0];
const CLAIMED_TOPIC = encodeEventTopics({ abi: PONS_V2_ESCROW_ABI, eventName: 'Claimed' })[0];
const POOL_FEES_SWEPT_TOPIC = encodeEventTopics({ abi: PONS_V2_HOOK_ABI, eventName: 'PoolFeesSwept' })[0];
const MAX_SCAN_BLOCKS = 2_000_000n;
const MIN_SCAN_BLOCKS = 10_000n;

/**
 * Escrow `claim(amount)` calldata tagged with the token whose fees it withdraws. Solidity ignores trailing
 * calldata, so the tag costs nothing on-chain and lets the claim be attributed from the chain alone.
 */
export function taggedClaimData(amount: bigint, token: Address): Hex {
  return `${CLAIM_AMOUNT_SELECTOR}${amount.toString(16).padStart(64, '0')}${token.slice(2).toLowerCase()}`;
}

/** The token a `claim(uint256)` call was tagged with (see `taggedClaimData`), or null for any other calldata. */
export function claimTag(input: Hex): Address | null {
  if (input.length !== CLAIM_CALLDATA_CHARS + 40 || !input.toLowerCase().startsWith(CLAIM_AMOUNT_SELECTOR)) return null;
  return `0x${input.slice(CLAIM_CALLDATA_CHARS).toLowerCase()}`;
}

export interface EscrowLedgerDeps {
  rhc: Client;
  factory: Address;
  hook: Address;
  escrow: Address;
  wallet: Address;
  fromBlock: bigint;
}

export interface EscrowLedger {
  /**
   * Native ETH the escrow holds for the wallet on account of `token`: everything credited by the token's
   * curve or pool sweeps, minus the wallet's claims tagged with the token. Untagged claims (made outside
   * the engine) are not attributable, so callers cap the result by the escrow balance.
   */
  unclaimed(token: Address): Promise<bigint>;
}

function isRateLimited(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk((e) => (e instanceof HttpRequestError && e.status === 429) || (e instanceof RpcRequestError && e.code === 429)) !== null
  );
}

interface EscrowEntry {
  kind: 'credited' | 'claimed';
  token: string;
  amount: bigint;
}

/**
 * The escrow keeps one native balance per recipient across every launch, so which token earned what is
 * read from its logs: each `Credited(wallet, source)` comes from a launch's curve, or from the shared
 * hook in the same transaction as that pool's `PoolFeesSwept(poolId)`. Scanned incrementally and cached.
 */
export function createEscrowLedger(deps: EscrowLedgerDeps): EscrowLedger {
  const { rhc, factory, hook, escrow, wallet } = deps;
  const totals = { credited: new Map<string, bigint>(), claimed: new Map<string, bigint>() };
  const curveTokens = new Map<string, Address | null>();
  const poolTokens = new Map<string, Address | null>();
  let scannedTo = deps.fromBlock - 1n;
  let syncing: Promise<void> | null = null;

  async function tokenOfCurve(curve: Address): Promise<Address | null> {
    const key = curve.toLowerCase();
    if (!curveTokens.has(key)) curveTokens.set(key, await ponsV2TokenOfCurve(rhc, factory, curve));
    return curveTokens.get(key) ?? null;
  }

  async function tokenOfHookCredit(txHash: Hex, logIndex: number): Promise<Address | null> {
    const receipt = await rhc.getTransactionReceipt({ hash: txHash });
    // The hook credits the creator (then the protocol) and only then emits that pool's PoolFeesSwept.
    const swept = receipt.logs.find((l) => isAddressEqual(l.address, hook) && l.topics[0] === POOL_FEES_SWEPT_TOPIC && l.logIndex > logIndex);
    const poolId = swept?.topics[1];
    if (!poolId) return null;
    if (!poolTokens.has(poolId)) {
      const info = await rhc.readContract({ address: hook, abi: PONS_V2_HOOK_ABI, functionName: 'launches', args: [poolId] });
      poolTokens.set(poolId, info[0] ? info[2] : null);
    }
    return poolTokens.get(poolId) ?? null;
  }

  /** Entries of one block range; applied only once the whole range was read, so a retried range never double counts. */
  async function scan(from: bigint, to: bigint): Promise<EscrowEntry[]> {
    const logs = await rhc.request({
      method: 'eth_getLogs',
      params: [{ address: escrow, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics: [[CREDITED_TOPIC, CLAIMED_TOPIC], addressTopic(wallet)] }],
    });
    const entries: EscrowEntry[] = [];
    for (const l of logs) {
      if (!l.transactionHash || l.logIndex === null) continue;
      const ev = decodeEventLog({ abi: PONS_V2_ESCROW_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (ev.eventName === 'Credited') {
        const { source, amount } = ev.args;
        const token = isAddressEqual(source, hook) ? await tokenOfHookCredit(l.transactionHash, Number(l.logIndex)) : await tokenOfCurve(source);
        if (token) entries.push({ kind: 'credited', token: token.toLowerCase(), amount });
      } else if (ev.eventName === 'Claimed') {
        const tx = await rhc.getTransaction({ hash: l.transactionHash });
        const tag = tx.to && isAddressEqual(tx.to, escrow) ? claimTag(tx.input) : null;
        if (tag) entries.push({ kind: 'claimed', token: tag, amount: ev.args.amount });
      }
    }
    return entries;
  }

  async function sync(): Promise<void> {
    const latest = await rhc.getBlockNumber();
    let chunk = MAX_SCAN_BLOCKS;
    while (scannedTo < latest) {
      const from = scannedTo + 1n;
      const to = from + chunk - 1n < latest ? from + chunk - 1n : latest;
      let entries: EscrowEntry[];
      try {
        entries = await scan(from, to);
      } catch (err) {
        if (chunk > MIN_SCAN_BLOCKS && !isRateLimited(err)) {
          chunk /= 4n;
          continue;
        }
        throw new Error(`Pons V2 fee escrow log scan failed for blocks ${from}-${to}: ${shortError(err)}`);
      }
      for (const e of entries) totals[e.kind].set(e.token, (totals[e.kind].get(e.token) ?? 0n) + e.amount);
      scannedTo = to;
      if (chunk < MAX_SCAN_BLOCKS) chunk *= 2n;
    }
  }

  return {
    async unclaimed(token) {
      // One scan at a time; concurrent callers share it. A failed scan keeps its progress and resumes next call.
      syncing ??= sync().finally(() => (syncing = null));
      await syncing;
      const key = token.toLowerCase();
      const owed = (totals.credited.get(key) ?? 0n) - (totals.claimed.get(key) ?? 0n);
      return owed > 0n ? owed : 0n;
    },
  };
}
