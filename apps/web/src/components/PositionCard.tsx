import type { PositionView } from '@bellwether/shared';
import { Link } from 'react-router';
import { leverage, pct, price, relTime, tone, usd } from '../lib/format';
import { StagePill } from './Badges';
import { Pnl } from './Stat';

/** Fraction of mark price the market can move against the position before liquidation. */
function liqDistance(p: PositionView): number | null {
  if (p.liquidationPrice === null || p.markPrice <= 0) return null;
  const d = p.side === 'long' ? (p.markPrice - p.liquidationPrice) / p.markPrice : (p.liquidationPrice - p.markPrice) / p.markPrice;
  return Math.max(0, d);
}

/**
 * Price ladder: where mark sits between liquidation and the best of entry/mark. Markers are
 * absolutely positioned on a 0..1 scale; text carries the same information for screen readers.
 */
function Ladder({ p }: { p: PositionView }) {
  const points = [p.entryPrice, p.markPrice, p.stopPrice, p.liquidationPrice].filter((v): v is number => v !== null && v > 0);
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || hi * 0.01 || 1;
  const at = (v: number) => `${(((v - lo) / span) * 100).toFixed(2)}%`;
  const dist = liqDistance(p);
  const danger = dist !== null && dist < 0.5 / p.leverage;
  return (
    <div className="ladder">
      <div className="ladder__track" aria-hidden="true">
        {p.liquidationPrice !== null && <span className="ladder__mark ladder__mark--liq" style={{ left: at(p.liquidationPrice) }} title={`Liquidation ${price(p.liquidationPrice)}`} />}
        {p.stopPrice !== null && <span className="ladder__mark ladder__mark--stop" style={{ left: at(p.stopPrice) }} title={`Stop ${price(p.stopPrice)}`} />}
        <span className="ladder__mark ladder__mark--entry" style={{ left: at(p.entryPrice) }} title={`Entry ${price(p.entryPrice)}`} />
        <span className={`ladder__mark ladder__mark--now ${p.unrealizedPnlUsd >= 0 ? 'up' : 'down'}`} style={{ left: at(p.markPrice) }} title={`Mark ${price(p.markPrice)}`} />
      </div>
      <div className="ladder__legend" aria-hidden="true">
        <span>
          <i className="ladder__key ladder__key--liq" />
          Liq
        </span>
        <span>
          <i className="ladder__key ladder__key--stop" />
          Stop
        </span>
        <span>
          <i className="ladder__key ladder__key--entry" />
          Entry
        </span>
        <span>
          <i className="ladder__key ladder__key--now" />
          Mark
        </span>
      </div>
      <p className={`ladder__text ${danger ? 'amber' : 'dim'}`}>
        {dist === null ? 'No liquidation price reported' : `${pct(dist)} from liquidation${danger ? ' — close to the edge' : ''}`}
      </p>
    </div>
  );
}

export function PositionCard({ position: p, focusToken }: { position: PositionView; focusToken?: string }) {
  const pnlPct = pct(p.unrealizedPnlPct, { signed: true });
  return (
    <article className="pos card" aria-label={`${p.market} ${p.side} ${leverage(p.leverage)} position`}>
      <header className="pos__head">
        <div>
          <h3 className="pos__market">
            {p.market}
            <span className="pos__perp">-PERP</span>
          </h3>
          <p className="pos__meta">
            <span className={p.side === 'long' ? 'up' : 'down'}>{p.side === 'long' ? '▲ Long' : '▼ Short'}</span> · <span className="num">{leverage(p.leverage)}</span> · {p.venue === 'paper' ? 'Paper venue' : 'Hyperliquid'}
          </p>
        </div>
        <StagePill stage={p.stage} />
      </header>

      <div className="pos__pnl">
        <Pnl value={p.unrealizedPnlUsd} />
        <span className={`num pos__pct ${tone(pnlPct)}`}>{pnlPct} on collateral</span>
      </div>

      <dl className="pos__grid">
        <div>
          <dt>Size</dt>
          <dd className="num">{usd(p.sizeUsd)}</dd>
        </div>
        <div>
          <dt>Collateral</dt>
          <dd className="num">{usd(p.collateralUsd)}</dd>
        </div>
        <div>
          <dt>Entry</dt>
          <dd className="num">{price(p.entryPrice)}</dd>
        </div>
        <div>
          <dt>Mark</dt>
          <dd className="num">{price(p.markPrice)}</dd>
        </div>
        <div>
          <dt>Stop</dt>
          <dd className="num">{price(p.stopPrice)}</dd>
        </div>
        <div>
          <dt>Liquidation</dt>
          <dd className="num">{price(p.liquidationPrice)}</dd>
        </div>
      </dl>

      <Ladder p={p} />

      {p.shares.length > 0 && (
        <div className="pos__shares">
          <p className="panel-label">Owned by</p>
          <ul>
            {p.shares.map((s) => (
              <li key={s.token} className={focusToken && s.token.toLowerCase() === focusToken.toLowerCase() ? 'is-focus' : ''}>
                <Link to={`/t/${s.token}`}>${s.symbol}</Link>
                <span className="pos__bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, s.share * 100)}%` }} />
                </span>
                <span className="num">{pct(s.share)}</span>
                <span className="num muted">{usd(s.collateralUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="pos__time muted">Opened {relTime(p.openedAt)}</p>
    </article>
  );
}
