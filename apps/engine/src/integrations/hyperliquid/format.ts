/**
 * Hyperliquid number rules (perps), per https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
 * and https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
 */
const PERP_MAX_DECIMALS = 6;
const MAX_SIG_FIGS = 5;

/** Builder-deployed (HIP-3) perps: 100000 + perp_dex_index * 10000 + index_in_meta. */
export function builderAssetId(perpDexIndex: number, universeIndex: number): number {
  if (!Number.isInteger(perpDexIndex) || perpDexIndex < 1) throw new RangeError(`invalid perp dex index ${perpDexIndex}`);
  if (!Number.isInteger(universeIndex) || universeIndex < 0 || universeIndex >= 10_000) {
    throw new RangeError(`invalid universe index ${universeIndex}`);
  }
  return 100_000 + perpDexIndex * 10_000 + universeIndex;
}

/**
 * Valid order price: at most 5 significant figures and at most (6 - szDecimals) decimals.
 * Integer prices are always valid, so prices >= 100000 round to whole numbers.
 */
export function roundPrice(px: number, szDecimals: number): number {
  if (!(px > 0) || !Number.isFinite(px)) throw new RangeError(`invalid price ${px}`);
  if (px >= 10 ** MAX_SIG_FIGS) return Math.round(px);
  const maxDecimals = Math.max(0, PERP_MAX_DECIMALS - szDecimals);
  return Number(Number(px.toPrecision(MAX_SIG_FIGS)).toFixed(maxDecimals));
}

/** Order size rounded DOWN to the asset's lot (szDecimals), never exceeding `size`. */
export function floorSize(size: number, szDecimals: number): number {
  if (!(size >= 0) || !Number.isFinite(size)) throw new RangeError(`invalid size ${size}`);
  const factor = 10 ** szDecimals;
  // Tolerance absorbs binary noise like 0.3 / 0.1 = 2.9999999999999996.
  return Math.floor(size * factor + 1e-9) / factor;
}

/** Number → wire string exactly like the official SDKs' float_to_wire (8 decimals, trailing zeros stripped). */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new RangeError(`float_to_wire causes rounding: ${x}`);
  const trimmed = rounded.replace(/\.?0+$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}
