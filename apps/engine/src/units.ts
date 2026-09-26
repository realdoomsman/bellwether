/**
 * Unit conversions. The ledger stores ETH as integer gwei and USD as integer micro-USD;
 * chain calls use wei (bigint). Convert only at the edges, only through these helpers.
 */
export const GWEI_PER_ETH = 1_000_000_000;
export const MICRO_PER_USD = 1_000_000;
const WEI_PER_GWEI = 1_000_000_000n;

function assertSafe(n: number, what: string): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} out of safe integer range: ${n}`);
  return n;
}

/** Truncates sub-gwei dust. */
export function weiToGwei(wei: bigint): number {
  if (wei < 0n) throw new RangeError('negative wei');
  return assertSafe(Number(wei / WEI_PER_GWEI), 'gwei');
}

export function gweiToWei(gwei: number): bigint {
  return BigInt(assertSafe(gwei, 'gwei')) * WEI_PER_GWEI;
}

export function ethToGwei(eth: number): number {
  return assertSafe(Math.round(eth * GWEI_PER_ETH), 'gwei');
}

export function gweiToEth(gwei: number): number {
  return gwei / GWEI_PER_ETH;
}

export function usdToMicro(usd: number): number {
  return assertSafe(Math.round(usd * MICRO_PER_USD), 'micro-USD');
}

export function microToUsd(micro: number): number {
  return micro / MICRO_PER_USD;
}

export function weiToEth(wei: bigint): number {
  return gweiToEth(weiToGwei(wei));
}

/** Raw ERC-20 units to a display number (precision loss is fine for display). */
export function rawToUnits(raw: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

/** gwei amount worth `micro` micro-USD at `ethUsd`, floored. */
export function microToGweiAt(micro: number, ethUsd: number): number {
  if (!(ethUsd > 0)) throw new RangeError(`invalid ETH price ${ethUsd}`);
  return assertSafe(Math.floor((micro * 1000) / ethUsd), 'gwei');
}

/** micro-USD value of `gwei` at `ethUsd`, rounded. */
export function gweiToMicroAt(gwei: number, ethUsd: number): number {
  if (!(ethUsd > 0)) throw new RangeError(`invalid ETH price ${ethUsd}`);
  return assertSafe(Math.round((gwei * ethUsd) / 1000), 'micro-USD');
}

/**
 * Split an integer `total` across `weights` so parts sum exactly to `total`
 * (largest-remainder method). Each part is <= its weight when total <= sum(weights).
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  assertSafe(total, 'allocation total');
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0 || sum <= 0) {
    if (abs === 0) return weights.map(() => 0);
    throw new RangeError('cannot allocate a non-zero total over zero weights');
  }
  const exact = weights.map((w) => (abs * w) / sum);
  const parts = exact.map(Math.floor);
  let rest = abs - parts.reduce((s, p) => s + p, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) parts[order[k]!.i]! += 1;
  return parts.map((p) => p * sign);
}
