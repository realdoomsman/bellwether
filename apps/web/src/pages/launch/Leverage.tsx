import { STRATEGIES, STRATEGY_IDS, leverageBounds, type LeverageBounds, type StrategyId } from '@bellwether/shared';
import { useId, type CSSProperties } from 'react';
import { RollingNumber } from '../../components/RollingNumber';
import { Term } from '../../components/Term';
import { leverage, pct } from '../../lib/format';

/**
 * Leverage cap: a slider that snaps to the whole values the engine accepts, bounded by the shared
 * `leverageBounds` (strategy range, capped by the market's venue limit). When the venue caps the market
 * below the strategy's minimum the strategy can't run there, and the fix is offered instead of a slider.
 */
export function Leverage({
  strategy,
  symbol,
  venueCap,
  bounds,
  value,
  onChange,
  onStrategy,
}: {
  strategy: StrategyId;
  symbol: string | null;
  /** The market's venue cap; null while unknown (no market yet, or the engine is unreachable). */
  venueCap: number | null;
  bounds: LeverageBounds | 'unavailable';
  value: number | null;
  onChange: (lev: number) => void;
  onStrategy: (id: StrategyId) => void;
}) {
  const id = useId();
  const s = STRATEGIES[strategy];

  if (!s.trades) {
    return (
      <p className="lw-lev__none">
        {s.label} never trades, so there’s no leverage to cap. The trading share of every fee buys back and burns your token instead.
      </p>
    );
  }

  if (bounds === 'unavailable') {
    const fits = STRATEGY_IDS.filter((x) => STRATEGIES[x].trades && venueCap !== null && leverageBounds(x, venueCap) !== 'unavailable');
    return (
      <div className="lw-lev__blocked" role="alert">
        <p>
          <strong>{s.label} can’t trade {symbol}.</strong> It needs at least {leverage(s.minLeverage)}, and the venue caps {symbol} at {leverage(venueCap ?? 0)}.
        </p>
        <div className="row">
          {fits.map((x) => (
            <button key={x} type="button" className="btn btn--secondary btn--sm" onClick={() => onStrategy(x)}>
              Use {STRATEGIES[x].label}
            </button>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onStrategy('burn')}>
            Use Burn only
          </button>
        </div>
      </div>
    );
  }

  const v = value ?? bounds.max;
  const span = bounds.max - bounds.min;
  const ticks = Array.from({ length: span + 1 }, (_, i) => bounds.min + i);
  const stopMove = Math.abs(s.stopLoss) / v;

  let why: string;
  if (venueCap === null) why = `${s.label} allows ${leverage(s.minLeverage)}–${leverage(s.maxLeverage)}. The venue’s limit for ${symbol ?? 'your stock'} is unknown until the engine answers; it’s checked again when you register.`;
  else if (venueCap < s.maxLeverage) why = `${s.label} allows up to ${leverage(s.maxLeverage)}, but the venue caps ${symbol} at ${leverage(venueCap)}.`;
  else why = `${s.label} allows ${leverage(s.minLeverage)}–${leverage(s.maxLeverage)}; the venue allows ${symbol} up to ${leverage(venueCap)}.`;

  return (
    <div className="lw-lev">
      <div className="lw-lev__read">
        <output className="lw-lev__fig" htmlFor={id} aria-live="off">
          <RollingNumber value={v} suffix="×" />
        </output>
        <p className="lw-lev__cap">
          <Term id="leverage">Most leverage</Term> the engine may use for your token
        </p>
      </div>
      <div className="lw-lev__slider" style={{ '--at': span === 0 ? 1 : (v - bounds.min) / span } as CSSProperties}>
        <input
          id={id}
          className="lw-lev__range"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={v}
          disabled={span === 0}
          aria-label="Maximum leverage"
          aria-valuetext={`${v} times`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <div className="lw-lev__ticks" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} className="lw-lev__tick" data-on={t <= v || undefined} style={{ '--x': span === 0 ? 1 : (t - bounds.min) / span } as CSSProperties}>
              {(ticks.length <= 8 || t === bounds.min || t === bounds.max || t % 5 === 0) && <span className="lw-lev__tick-label num">{leverage(t)}</span>}
            </span>
          ))}
        </div>
      </div>
      <p className="lw-lev__why">
        {why} At {leverage(v)}, a <span className="num">{pct(stopMove)}</span> move against the position hits the <span className="num">{pct(s.stopLoss, { digits: 0 })}</span> hard stop.
      </p>
    </div>
  );
}
