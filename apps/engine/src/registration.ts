/** Token registration shared by the API (creator-initiated) and discovery (auto). */
import {
  BRAND,
  STRATEGIES,
  effectiveLeverageCap,
  type Address,
  type LaunchpadId,
  type Side,
  type StrategyId,
  type TokenStatus,
} from '@stepup/shared';
import { activity, type Engine } from './engine.ts';
import type { LaunchpadVerifyResult, TokenMetadata } from './ports.ts';
import { decision, insertToken, type TokenRow } from './tokens.ts';

const HOMOGLYPHS: Record<string, string> = { '0': 'o', '1': 'l', '|': 'l', '!': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '$': 's' };
const BRAND_NAMES = [BRAND.ticker, BRAND.name, `${BRAND.name}protocol`, `${BRAND.name}fun`, `${BRAND.name}dotfun`].map(normalizeBrand);

function normalizeBrand(s: string): string {
  return [...s.normalize('NFKD').toLowerCase()]
    .map((ch) => HOMOGLYPHS[ch] ?? ch)
    .join('')
    .replace(/[^a-z]/g, '');
}

/** True when name/symbol pose as the protocol token / brand and the token is not the official one. */
export function isImpersonation(meta: Pick<TokenMetadata, 'name' | 'symbol'>, token: Address, protocolToken: Address | null): boolean {
  if (protocolToken && token.toLowerCase() === protocolToken.toLowerCase()) return false;
  const symbol = normalizeBrand(meta.symbol.replace(/^\$/, ''));
  const name = normalizeBrand(meta.name);
  return (
    BRAND_NAMES.includes(symbol) ||
    BRAND_NAMES.includes(name) ||
    name.startsWith(normalizeBrand(BRAND.protocolName)) ||
    name === normalizeBrand(`${BRAND.name} token`)
  );
}

export interface LeverageBounds {
  min: number;
  max: number;
}

/** Leverage a creator may request for `strategy` on a market whose venue cap is `venueCap`. */
export function leverageBounds(strategy: StrategyId, venueCap: number): LeverageBounds {
  const s = STRATEGIES[strategy];
  return { min: s.minLeverage, max: effectiveLeverageCap(strategy, s.maxLeverage, venueCap) };
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
