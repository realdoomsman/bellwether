/** Builds API response shapes (from @stepup/shared) out of the book, positions and caches. */
import {
  BURN_ADDRESS,
  STOCK_MARKETS,
  marketSession,
  type ActivityEvent,
  type Address,
  type ConfigResponse,
  type LedgerAccountView,
  type MarketsResponse,
  type PositionView,
  type ProofResponse,
  type StatsResponse,
  type StatusResponse,
  type TokenDetailResponse,
  type TokenSummary,
  type TradeView,
  type WorkerHealth,
} from '@stepup/shared';
import { toTxRef } from './activity.ts';
import { kvGet } from './db.ts';
import { VERSION, killSwitchOn, utcDayStart, type Engine } from './engine.ts';
import { stopPrice, strictestRules } from './exits.ts';
import { ACCOUNTS, ACCOUNT_IDS, emptyBook, type Book } from './ledger.ts';
import { stockMaxLeverage } from './market.ts';
import {
  burnTotals,
  openPositions,
  participantStrategies,
  sharesOf,
  tradeOutcomes,
  type BurnTotals,
  type PositionRow,
  type TradeOutcomes,
  type TradeRow,
} from './positions.ts';
import { getToken, listTokens, type TokenRow } from './tokens.ts';
import { gweiToEth, microToUsd, rawToUnits } from './units.ts';
import { RECONCILIATION_KEY, type ReconciliationSnapshot } from './workers/reconciler.ts';

const DEFAULT_DECIMALS = 18;

/** Aggregates loaded once per response so list views stay O(queries), not O(tokens × queries). */
export interface Aggregates {
  books: Map<Address, Book>;
  outcomes: TradeOutcomes;
  burns: BurnTotals;
  positions: PositionView[];
  positionOf: Map<Address, { position: PositionView; share: number }>;
  ethUsd: number | null;
}

export function loadAggregates(engine: Engine): Aggregates {
  const positions = openPositions(engine.db).map((p) => positionView(engine, p));
  const positionOf = new Map<Address, { position: PositionView; share: number }>();
  for (const p of positions) for (const s of p.shares) positionOf.set(s.token, { position: p, share: s.share });
  return {
    books: engine.ledger.books(),
    outcomes: tradeOutcomes(engine.db),
    burns: burnTotals(engine.db),
    positions,
    positionOf,
    ethUsd: engine.market.peekEthUsd() ?? null,
  };
}

export function positionView(engine: Engine, p: PositionRow): PositionView {
  const shares = sharesOf(engine.db, p.id);
  const deployed = engine.ledger.deployedIn(p.id);
  const rules = strictestRules(participantStrategies(engine.db, p.id), p.stopLoss);
  const collateral = microToUsd(p.collateralMicro);
  const unrealized = microToUsd(p.unrealizedPnlMicro);
  return {
    id: p.id,
    venue: p.venue,
    market: p.market,
    side: p.side,
    leverage: p.leverage,
    sizeUsd: microToUsd(p.sizeMicro),
    collateralUsd: collateral,
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    liquidationPrice: p.liquidationPrice,
    unrealizedPnlUsd: unrealized,
    unrealizedPnlPct: collateral > 0 ? unrealized / collateral : 0,
    stage: p.stage,
    stopPrice: stopPrice(p, rules.stopLoss, rules.ladder),
    openedAt: p.openedAt,
    shares: shares.map((s) => ({
      token: s.token,
      symbol: getToken(engine.db, s.token)?.symbol ?? '?',
      share: s.share,
      collateralUsd: microToUsd(deployed.get(s.token) ?? 0),
    })),
  };
}

export function tokenSummary(engine: Engine, t: TokenRow, agg: Aggregates): TokenSummary {
  const b = agg.books.get(t.address) ?? emptyBook();
  const eth = agg.ethUsd;
  const held = agg.positionOf.get(t.address);
  const burnedRaw = agg.burns.byTarget.get(t.address) ?? 0n;
  const outcome = agg.outcomes.byToken.get(t.address);
  const market = engine.market.peekTokenMarket(t.address);
  const usdToEth = (micro: number) => (eth ? microToUsd(micro) / eth : 0);
  return {
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    image: t.image,
    launchpad: t.launchpad,
    status: t.status,
    market: t.market,
    side: t.side,
    strategy: t.strategy,
    maxLeverage: t.maxLeverage,
    createdAt: t.createdAt,
    book: {
      feesClaimedEth: gweiToEth(b.fees_eth),
      // Trading ETH not yet bridged counts toward the budget at the current ETH price.
      tradingBudgetUsd: microToUsd(b.trading_usd) + (eth ? gweiToEth(b.trading_eth) * eth : 0),
      tokenBuybackBudgetEth: gweiToEth(b.token_buyback_eth) + usdToEth(b.profit_token_usd),
      protocolBuybackBudgetEth: gweiToEth(b.protocol_buyback_eth) + usdToEth(b.profit_protocol_usd),
      deployedUsd: microToUsd(b.deployed_usd),
      realizedPnlUsd: microToUsd(b.realized_pnl_usd),
      unrealizedPnlUsd: held ? held.position.unrealizedPnlUsd * held.share : 0,
      buybackEth: gweiToEth(b.buyback_spent_eth),
      tokensBurned: rawToUnits(burnedRaw, t.decimals),
      supplyBurnedPct: t.totalSupply && t.totalSupply > 0n ? Number((burnedRaw * 1_000_000n) / t.totalSupply) / 1_000_000 : 0,
      trades: outcome?.trades ?? 0,
      wins: outcome?.wins ?? 0,
    },
    decision: t.decision,
    priceUsd: market?.priceUsd ?? null,
    change24hPct: market?.change24hPct ?? null,
  };
}

export function tradeView(t: TradeRow): TradeView {
  return {
    id: t.id,
    positionId: t.positionId,
    venue: t.venue,
    market: t.market,
    side: t.side,
    action: t.action,
    reason: t.reason,
    sizeUsd: microToUsd(t.sizeMicro),
    price: t.price,
    realizedPnlUsd: microToUsd(t.realizedPnlMicro),
    feeUsd: microToUsd(t.feeMicro),
    at: t.at,
    tx: t.tx ? toTxRef(t.tx) : null,
  };
}

export function tokenDetail(
  engine: Engine,
  t: TokenRow,
  agg: Aggregates,
  extra: { trades: TradeView[]; activity: ActivityEvent[] },
): TokenDetailResponse {
  return {
    token: {
      ...tokenSummary(engine, t, agg),
      deployer: t.deployer,
      totalSupply: t.totalSupply === null ? null : rawToUnits(t.totalSupply, t.decimals),
      decimals: t.decimals,
      rejectedReason: t.rejectedReason,
    },
    position: agg.positionOf.get(t.address)?.position ?? null,
    trades: extra.trades,
    activity: extra.activity,
  };
}

export function statsResponse(engine: Engine, agg: Aggregates): StatsResponse {
  const totals = engine.ledger.totals();
  const counts = new Map(
    engine.db.all<{ status: string; n: number }>('SELECT status, count(*) AS n FROM tokens GROUP BY status').map((r) => [r.status, r.n]),
  );
  const protocolToken = engine.config.protocolToken;
  const protocolDecimals = protocolToken ? (getToken(engine.db, protocolToken)?.decimals ?? DEFAULT_DECIMALS) : DEFAULT_DECIMALS;
  const unrealized = agg.positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);

  const DAY = 86_400_000;
  const since = utcDayStart(engine.clock()) - 29 * DAY;
  const fees = engine.ledger.daily('fees_eth', since);
  const buybacks = engine.ledger.daily('buyback_spent_eth', since);
  const pnl = engine.ledger.daily('realized_pnl_usd', since);
  const history = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(since + i * DAY).toISOString().slice(0, 10);
    return {
      day,
      feesEth: gweiToEth(fees.get(day) ?? 0),
      buybackEth: gweiToEth(buybacks.get(day) ?? 0),
      realizedPnlUsd: microToUsd(pnl.get(day) ?? 0),
    };
  });

  return {
    tokensActive: counts.get('active') ?? 0,
    tokensPending: counts.get('pending') ?? 0,
    feesClaimedEth: gweiToEth(totals.fees_eth),
    buybackEth: gweiToEth(totals.buyback_spent_eth),
    buybackCount: agg.burns.buybacks,
    burnedUsd: microToUsd(agg.burns.usdMicro),
    protocolBurned: protocolToken ? rawToUnits(agg.burns.byTarget.get(protocolToken) ?? 0n, protocolDecimals) : 0,
    tradingEquityUsd: microToUsd(totals.trading_usd + totals.deployed_usd) + unrealized,
    realizedPnlUsd: microToUsd(totals.realized_pnl_usd),
    unrealizedPnlUsd: unrealized,
    trades: agg.outcomes.trades,
    wins: agg.outcomes.wins,
    losses: agg.outcomes.losses,
    openPositions: agg.positions.length,
    history,
  };
}

export async function statusResponse(engine: Engine, workers: WorkerHealth[]): Promise<StatusResponse> {
  return {
    mode: engine.config.mode,
    armed: engine.config.mode === 'live' && engine.config.live !== null,
    killSwitch: killSwitchOn(engine),
    session: marketSession(new Date(engine.clock())),
    venue: await engine.market.venueStatus(),
    workers,
    protocolWallet: engine.config.walletConfigured ? engine.config.network.protocolAddress : null,
    protocolToken: engine.config.protocolToken,
    burnMode: 'burn',
    version: VERSION,
    startedAt: engine.startedAt,
  };
}

export function proofResponse(engine: Engine): ProofResponse {
  const totals = engine.ledger.totals();
  const snapshot = kvGet<ReconciliationSnapshot>(engine.db, RECONCILIATION_KEY);
  const ledger: LedgerAccountView[] = ACCOUNT_IDS.map((account) => {
    const def = ACCOUNTS[account];
    return {
      account,
      label: def.label,
      unit: def.unit === 'gwei' ? 'ETH' : 'USD',
      balance: def.unit === 'gwei' ? gweiToEth(totals[account]) : microToUsd(totals[account]),
    };
  });
  return {
    mode: engine.config.mode,
    wallets: snapshot?.wallets ?? [],
    ledger,
    reconciliation: { checkedAt: snapshot?.checkedAt ?? null, items: snapshot?.items ?? [] },
    burnAddress: BURN_ADDRESS,
  };
}

export async function marketsResponse(engine: Engine): Promise<MarketsResponse> {
  const [status, venueMarkets] = await Promise.all([engine.market.venueStatus(), engine.market.venueMarkets().catch(() => [])]);
  const tokenCounts = new Map(
    engine.db
      .all<{ market: string; n: number }>(`SELECT market, count(*) AS n FROM tokens WHERE status = 'active' GROUP BY market`)
      .map((r) => [r.market, r.n]),
  );
  const quotes = await Promise.all(STOCK_MARKETS.map((m) => engine.market.quote(m.symbol).catch(() => null)));
  return {
    venue: status.active,
    markets: STOCK_MARKETS.map((m, i) => {
      const vm = venueMarkets.find((v) => v.symbol === m.symbol);
      const signal = engine.market.peekSignalRefreshing(m.symbol);
      const quote = quotes[i];
      return {
        symbol: m.symbol,
        name: m.name,
        sector: m.sector,
        available: vm !== undefined,
        maxLeverage: vm?.maxLeverage ?? 0,
        price: vm?.markPrice ?? quote?.price ?? null,
        change24hPct: quote?.change24hPct ?? null,
        signal: signal ? { score: signal.score, bias: signal.bias } : null,
        tokens: tokenCounts.get(m.symbol) ?? 0,
      };
    }),
  };
}

export async function configResponse(engine: Engine): Promise<ConfigResponse> {
  return {
    mode: engine.config.mode,
    protocolWallet: engine.config.walletConfigured ? engine.config.network.protocolAddress : null,
    protocolToken: engine.config.protocolToken,
    autoApprove: engine.config.autoApprove,
    minCollateralUsd: engine.config.risk.minCollateralUsd,
    venueMaxLeverage: stockMaxLeverage(await engine.market.venueMarkets().catch(() => [])),
  };
}

export function summaries(engine: Engine, tokens: readonly TokenRow[]): TokenSummary[] {
  const agg = loadAggregates(engine);
  return tokens.map((t) => tokenSummary(engine, t, agg));
}

export function publicTokens(engine: Engine): TokenRow[] {
  return listTokens(engine.db, ['active', 'paused', 'pending']);
}
