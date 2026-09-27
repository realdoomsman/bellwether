/** Token registration shared by the API (creator-initiated) and discovery (auto). */
import {
  BRAND,
  STRATEGIES,
  type Address,
  type LaunchpadId,
  type Side,
  type StrategyId,
  type TokenStatus,
} from '@bellwether/shared';
import { activity, type Engine } from './engine.ts';
import type { LaunchpadVerifyResult, TokenMetadata } from './ports.ts';
import { decision, insertToken, type TokenRow } from './tokens.ts';

const HOMOGLYPHS: Record<string, string> = { '0': 'o', '1': 'l', '|': 'l', '!': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '$': 's' };
/**
 * Cyrillic / Greek / Armenian letters that render like Latin ones (lower-cased input), per the
 * TR39 confusables table. NFKD does not fold these, so without the map `Stеpup` (Cyrillic е) would
 * strip to `stpup`.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', ь: 'b', с: 'c', ԁ: 'd', е: 'e', є: 'e', ғ: 'f', һ: 'h', н: 'h', і: 'i', ӏ: 'l', ј: 'j', к: 'k', м: 'm', п: 'n',
  о: 'o', р: 'p', ԛ: 'q', г: 'r', ѕ: 's', т: 't', џ: 'u', ц: 'u', ѵ: 'v', ԝ: 'w', ш: 'w', х: 'x', у: 'y', ү: 'y', з: 'z', э: 'e', ԍ: 'g',
  // Greek
  α: 'a', β: 'b', ϲ: 'c', δ: 'd', ε: 'e', ϝ: 'f', η: 'n', ι: 'i', ϳ: 'j', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y',
  ζ: 'z', σ: 'o', ω: 'w', π: 'n',
  // Armenian
  ս: 'u', օ: 'o', ո: 'n', հ: 'h', ց: 'g', զ: 'q', ւ: 'l',
};
const BRAND_NAMES = [BRAND.ticker, BRAND.name, `${BRAND.name}protocol`, `${BRAND.name}fun`, `${BRAND.name}dotfun`].map(normalizeBrand);

/** Latin skeleton of `s`: compatibility-folded, confusables mapped to Latin, everything else dropped. */
function normalizeBrand(s: string): string {
  return [...s.normalize('NFKD').toLowerCase()]
    .map((ch) => CONFUSABLES[ch] ?? HOMOGLYPHS[ch] ?? ch)
    .join('')
    .replace(/[^a-z]/g, '');
}

/** Edit distance between `a` and `b` is at most 1 (one substitution, insertion or deletion). */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return a.length - head - tail <= 1 && b.length - head - tail <= 1;
}

/**
 * Whether `raw` borrows letters from another script that pass for Latin. Such names get a looser check
 * (one edit from a brand name) since look-alike glyphs rarely map 1:1: Cyrillic `СТЕР` reads as `STEP`
 * but its skeleton is `ctep`. Plain-ASCII names still need an exact skeleton match.
 */
function mixesScripts(raw: string): boolean {
  return [...raw.normalize('NFKD').toLowerCase()].some((ch) => Object.hasOwn(CONFUSABLES, ch));
}

/** True when name/symbol pose as the protocol token / brand and the token is not the official one. */
export function isImpersonation(meta: Pick<TokenMetadata, 'name' | 'symbol'>, token: Address, protocolToken: Address | null): boolean {
  if (protocolToken && token.toLowerCase() === protocolToken.toLowerCase()) return false;
  const posesAsBrand = (raw: string, skeleton: string) =>
    mixesScripts(raw) ? BRAND_NAMES.some((b) => withinOneEdit(skeleton, b)) : BRAND_NAMES.includes(skeleton);
  const symbol = normalizeBrand(meta.symbol.replace(/^\$/, ''));
  const name = normalizeBrand(meta.name);
  return (
    posesAsBrand(meta.symbol, symbol) ||
    posesAsBrand(meta.name, name) ||
    name.startsWith(normalizeBrand(BRAND.protocolName)) ||
    name === normalizeBrand(`${BRAND.name} token`)
  );
}

export interface RegisterInput {
  address: Address;
  launchpad: LaunchpadId;
  market: string;
  side: Side;
  strategy: StrategyId;
  maxLeverage: number;
  verified: LaunchpadVerifyResult & { metadata: TokenMetadata };
  autoDiscovered: boolean;
}

/** Inserts a verified token (active when auto-approve is on, else pending) and logs it. */
export function registerToken(engine: Engine, input: RegisterInput): TokenRow {
  const at = engine.clock();
  const status: TokenStatus = engine.config.autoApprove ? 'active' : 'pending';
  const meta = input.verified.metadata;
  const row: TokenRow = {
    address: input.address,
    name: meta.name,
    symbol: meta.symbol,
    image: meta.image,
    launchpad: input.launchpad,
    status,
    market: input.market,
    side: input.side,
    strategy: input.strategy,
    maxLeverage: STRATEGIES[input.strategy].trades ? input.maxLeverage : 0,
    deployer: input.verified.deployer,
    totalSupply: meta.totalSupply,
    decimals: meta.decimals,
    autoDiscovered: input.autoDiscovered,
    demo: false,
    rejectedReason: null,
    decision:
      status === 'active'
        ? decision('collecting-fees', 'Active — waiting for the first creator fee claim', at)
        : decision('pending-review', 'Registered — waiting for review before the engine touches it', at),
    createdAt: at,
    updatedAt: at,
  };
  engine.db.transaction(() => {
    insertToken(engine.db, row);
    const token = { address: row.address, symbol: row.symbol };
    activity(engine, {
      kind: 'registered',
      token,
      title: `${input.autoDiscovered ? 'Discovered' : 'Registered'} $${row.symbol} (${row.name})`,
      market: row.market,
    });
    if (status === 'active') activity(engine, { kind: 'activated', token, title: `$${row.symbol} is live, trading ${row.market}`, market: row.market });
  });
  return row;
}
