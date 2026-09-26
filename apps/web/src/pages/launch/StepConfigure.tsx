import { effectiveLeverageCap, STOCK_MARKETS, STRATEGIES, STRATEGY_IDS, type StrategyId } from '@stepup/shared';
import { useEffect, useId, useState, type CSSProperties } from 'react';
import { ErrorNotice } from '../../components/DataState';
import { Icon } from '../../components/Icon';
import { Change } from '../../components/Stat';
import { leverageRange, sessionsText } from '../../components/StrategyFacts';
import { leverage, pct0, price } from '../../lib/format';
import { useConfig, useMarkets } from '../../lib/queries';
import type { Draft } from './draft';
import { Plan } from './Plan';

interface MarketOption {
  symbol: string;
  name: string;
  sector: string;
  /** null = unknown (engine offline). */
  available: boolean | null;
  maxLeverage: number | null;
  price: number | null;
  change: number | null;
  tokens: number | null;
}

export function StepConfigure({ draft, update, back, next }: { draft: Draft; update: (p: Partial<Draft>) => void; back: () => void; next: () => void }) {
  const markets = useMarkets();
  const config = useConfig();
  const [query, setQuery] = useState('');
  const sliderId = useId();

  const options: MarketOption[] = markets.data
    ? markets.data.markets.map((m) => ({ symbol: m.symbol, name: m.name, sector: m.sector, available: m.available, maxLeverage: m.maxLeverage, price: m.price, change: m.change24hPct, tokens: m.tokens }))
    : STOCK_MARKETS.map((m) => ({ ...m, available: null, maxLeverage: null, price: null, change: null, tokens: null }));
  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((m) => `${m.symbol} ${m.name} ${m.sector}`.toLowerCase().includes(q)) : options;
  const selected = options.find((m) => m.symbol === draft.market) ?? null;

  const s = STRATEGIES[draft.strategy];
  const venueCap = config.data?.venueMaxLeverage ?? null;
  const cap = effectiveLeverageCap(draft.strategy, selected?.maxLeverage ?? s.maxLeverage, venueCap ?? s.maxLeverage);
  const capKnown = selected?.maxLeverage != null && venueCap !== null;
  const tooLow = s.trades && selected !== null && cap < s.minLeverage;
  const lev = s.trades && !tooLow ? Math.min(cap, Math.max(s.minLeverage, draft.maxLeverage ?? cap)) : null;

  // Keep the stored leverage inside the current bounds as market/strategy change.
  useEffect(() => {
    if (draft.maxLeverage !== lev) update({ maxLeverage: lev });
  }, [lev, draft.maxLeverage, update]);

  const unavailable = selected?.available === false;
  const canContinue = selected !== null && !unavailable && !tooLow;
  const fill = lev === null || cap === s.minLeverage ? '100%' : `${((lev - s.minLeverage) / (cap - s.minLeverage)) * 100}%`;

  return (
    <div className="step">
      <fieldset className="step__group">
        <legend className="step__legend">1. Pick the stock your token trades</legend>
        {markets.error && !markets.data && (
          <ErrorNotice
            error={markets.error}
            onRetry={markets.refresh}
            what="Live venue availability"
            compact
            offlineHint="You can still plan your token. Availability and leverage caps are re-checked when you register."
          />
        )}
        <div className="search">
          <Icon name="search" />
          <input className="input" type="search" placeholder="Search AAPL, Nvidia, Semis…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search markets" />
        </div>
        <div className="markets">
          {visible.map((m) => (
            <label key={m.symbol} className={`choice mkt ${m.available === false ? 'mkt--off' : ''}`}>
              <input type="radio" name="market" value={m.symbol} checked={draft.market === m.symbol} disabled={m.available === false} onChange={() => update({ market: m.symbol })} />
              <span className="mkt__top">
                <span className="mkt__sym">{m.symbol}</span>
                {m.available === false ? <span className="mkt__lev num">Not on venue</span> : m.maxLeverage !== null && <span className="mkt__lev num">≤{leverage(m.maxLeverage)}</span>}
              </span>
              <span className="mkt__name">{m.name}</span>
              <span className="mkt__px num">
                {price(m.price)}{' '}
                {m.change !== null && <Change frac={m.change} />}
              </span>
              {m.tokens !== null && m.tokens > 0 && <span className="mkt__tokens">{m.tokens} token{m.tokens === 1 ? '' : 's'}</span>}
            </label>
          ))}
          {visible.length === 0 && <p className="muted">No market matches “{query}”.</p>}
        </div>
      </fieldset>

      <div className="step__group">
        <p className="step__legend">2. Direction</p>
        <p className="side">
          <span className="side__on">
            <span aria-hidden="true">▲</span> Long
          </span>
          <span className="muted">Shorts aren’t available yet — every token trades long for now.</span>
        </p>
      </div>

      <fieldset className="step__group">
        <legend className="step__legend">3. Strategy</legend>
        <div className="choices choices--4">
          {STRATEGY_IDS.map((id: StrategyId) => {
            const st = STRATEGIES[id];
            return (
              <label key={id} className="choice strat">
                <input type="radio" name="strategy" value={id} checked={draft.strategy === id} onChange={() => update({ strategy: id })} />
                <span className="strat__name">
                  {st.label}
                  {id === 'balanced' && <span className="pill pill--amber">Default</span>}
                </span>
                <span className="strat__tag">{st.tagline}</span>
                <span className="strat__facts num">
                  {leverageRange(st)}
                  {st.trades && ` · stop ${pct0(st.stopLoss)}`}
                </span>
                <span className="strat__sessions">{sessionsText(st)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {s.trades && (
        <div className="step__group">
          <label className="step__legend" htmlFor={sliderId}>
            4. Max leverage
          </label>
          {tooLow ? (
            <p className="callout">
              <Icon name="warn" /> {selected?.symbol} is capped at {leverage(cap)} on the venue, below {s.label}’s minimum of {leverage(s.minLeverage)}. Pick a lower-leverage strategy or another market.
            </p>
          ) : (
            <>
              <div className="lev">
                <output htmlFor={sliderId} className="lev__value led">
                  {lev === null ? '—' : leverage(lev)}
                </output>
                <input
                  id={sliderId}
                  className="range"
                  type="range"
                  min={s.minLeverage}
                  max={cap}
                  step={1}
                  value={lev ?? cap}
                  disabled={cap === s.minLeverage}
                  onChange={(e) => update({ maxLeverage: Number(e.target.value) })}
                  style={{ '--fill': fill } as CSSProperties}
                />
                <div className="spread field__hint num">
                  <span>{leverage(s.minLeverage)}</span>
                  <span>{leverage(cap)}</span>
                </div>
              </div>
              <p className="field__hint">
                This is the most leverage the engine may use for your token.{' '}
                {capKnown
                  ? `Cap is the lowest of ${s.label} (${leverage(s.maxLeverage)}), ${selected?.symbol} on the venue (${leverage(selected?.maxLeverage ?? 0)}) and the venue limit (${leverage(venueCap ?? 0)}).`
                  : 'Venue limits are unknown while the engine is offline; they are re-checked when you register.'}
              </p>
            </>
          )}
        </div>
      )}

      <Plan draft={draft} />

      <div className="step__nav">
        <button type="button" className="btn btn--ghost" onClick={back}>
          <Icon name="arrowLeft" /> Back
        </button>
        <button type="button" className="btn btn--primary" disabled={!canContinue} onClick={next}>
          Continue <Icon name="arrowRight" />
        </button>
      </div>
      {!selected && <p className="field__hint step__why">Pick a market to continue.</p>}
    </div>
  );
}
