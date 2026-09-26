import { marketSession, SESSION_LABEL, STOCK_MARKETS, type MarketView } from '@floor/shared';
import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { BiasChip, Pill } from '../../components/Badges';
import { FlapText } from '../../components/FlapText';
import { priceDigits, pct } from '../../lib/format';
import { useMarkets, useStatus } from '../../lib/queries';

/** Tiles visible on narrow screens before "Show all". Must match the nth-child rule in landing.css. */
const COLLAPSED_TILES = 6;

/** Columns the legend cell spans so the last row is always full: the gap, or a whole row when there is none. */
const fill = (tiles: number, cols: number) => cols - (tiles % cols);

/** Signal key that closes the grid's last row, so the board never ends on a lone empty cell. */
function Legend({ tiles }: { tiles: number }) {
  const few = Math.min(tiles, COLLAPSED_TILES);
  const style = { '--all2': fill(tiles, 2), '--all3': fill(tiles, 3), '--few2': fill(few, 2), '--few3': fill(few, 3) } as CSSProperties;
  return (
    <li className="board__legend" style={style}>
      <span className="board__legend-title">
        Signal <span className="board__legend-range num">score −100 to 100</span>
      </span>
      <span className="board__legend-key">
        <Pill tone="up">▲ Long</Pill> entry met
      </span>
      <span className="board__legend-key">
        <Pill tone="neutral">Wait</Pill>
        <Pill tone="down">▼ Short</Pill> no entry
      </span>
    </li>
  );
}

function Tile({ m }: { m: MarketView }) {
  const change = m.change24hPct;
  const dir = change === null || change === 0 ? '' : change > 0 ? 'up' : 'down';
  return (
    <li className={`board__tile ${m.available ? '' : 'board__tile--off'}`}>
      <div className="board__sym">
        <span className="board__ticker">{m.symbol}</span>
        <span className="board__name">{m.name}</span>
      </div>
      {m.price === null ? (
        <span className="board__price board__price--off" role="img" aria-label="No price" />
      ) : (
        <FlapText text={priceDigits(m.price)} className="board__price led" />
      )}
      <div className="board__foot">
        <span className={`num board__chg ${dir}`}>
          {dir && <span aria-hidden="true">{dir === 'up' ? '▲ ' : '▼ '}</span>}
          {pct(change, { signed: true, digits: 2 })}
        </span>
        {m.available ? <BiasChip signal={m.signal} /> : <span className="board__na">Not on venue</span>}
      </div>
    </li>
  );
}

/** Unlit board: the candidate symbols are static config; prices are unknown, so no digits light up. */
function DarkTiles() {
  return (
    <>
      {STOCK_MARKETS.map((m) => (
        <li key={m.symbol} className="board__tile board__tile--dark" aria-hidden="true">
          <div className="board__sym">
            <span className="board__ticker">{m.symbol}</span>
            <span className="board__name">{m.name}</span>
          </div>
          <span className="board__price board__price--off" />
          <div className="board__foot">
            <span className="num board__chg">—</span>
          </div>
        </li>
      ))}
    </>
  );
}

export function FloorBoard() {
  const markets = useMarkets();
  const session = useStatus().data?.session ?? marketSession();
  const [expanded, setExpanded] = useState(false);
  const list = markets.data ? [...markets.data.markets].sort((a, b) => Number(b.available) - Number(a.available)) : null;
  const dark = !list;

  return (
    <section className={`board ${dark ? 'board--dark' : ''} ${expanded ? 'board--expanded' : ''}`} aria-labelledby="board-title">
      <header className="board__head">
        <h2 id="board-title" className="board__title">
          <span className={`board__lamp ${dark ? '' : 'is-on'}`} aria-hidden="true" />
          The floor
        </h2>
        <p className="board__meta num">
          {markets.data ? (markets.data.venue === 'paper' ? 'Paper venue' : markets.data.venue ? 'Hyperliquid · xyz' : 'No venue') : 'Offline'} · {SESSION_LABEL[session]}
        </p>
      </header>

      {list ? (
        <ul className="board__grid" aria-label="Stock perp markets">
          {list.map((m) => (
            <Tile key={m.symbol} m={m} />
          ))}
          <Legend tiles={list.length} />
        </ul>
      ) : (
        <div className="board__darkwrap">
          <ul className="board__grid">
            <DarkTiles />
            <Legend tiles={STOCK_MARKETS.length} />
          </ul>
          <p className="board__overlay" role="status">
            {markets.error ? (
              <>
                <strong>Board dark.</strong> The engine is offline, so no prices are shown.
              </>
            ) : (
              <>Warming up the board…</>
            )}
          </p>
        </div>
      )}

      <footer className="board__foot-row">
        <button type="button" className="btn btn--ghost btn--sm board__more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? 'Show fewer' : `Show all ${list?.length ?? STOCK_MARKETS.length}`}
        </button>
        <Link to="/launch" className="board__cta small">
          Pick one for your token →
        </Link>
      </footer>
    </section>
  );
}
