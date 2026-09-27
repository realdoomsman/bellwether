import { SESSION_LABEL, STOCK_MARKETS, type MarketsResponse, type MarketView } from '@bellwether/shared';
import { useState } from 'react';
import { leverage, pct, price, tone } from '../lib/format';
import { useMarkets } from '../lib/queries';
import { useSessionClock } from '../lib/session';
import { figureStatus, type FigureStatus } from './Figure';
import { Icon } from './Icon';
import { Term } from './Term';

/** Mirrors the engine's BIAS_THRESHOLD (apps/engine/src/signal.ts): scores inside ±25 are "wait". */
const WAIT_BAND = 25;

type SortKey = 'symbol' | 'price' | 'change' | 'signal' | 'tokens' | 'lev';
const SORT_VALUE: Record<SortKey, (m: MarketView) => number | string> = {
  symbol: (m) => m.symbol,
  price: (m) => m.price ?? -Infinity,
  change: (m) => m.change24hPct ?? -Infinity,
  signal: (m) => m.signal?.score ?? -Infinity,
  tokens: (m) => m.tokens,
  lev: (m) => m.maxLeverage,
};

/** −100..100 signal as a centred bar: fill toward the bias, the wait band shaded around zero. */
export function SignalBar({ signal }: { signal: MarketView['signal'] }) {
  if (!signal) return <span className="muted">No signal</span>;
  const { score, bias } = signal;
  const half = Math.min(100, Math.abs(score)) / 2;
  const word = bias === 'long' ? 'Long' : bias === 'short' ? 'Short' : 'Wait';
  return (
    <span className={`signal-cell signal-cell--${bias}`}>
      <span className="signal-cell__word">
        {word} <span className="num">{score < 0 ? `−${-score}` : score}</span>
      </span>
      <span className="signal-bar" role="img" aria-label={`Entry signal ${score} of ±100: ${word.toLowerCase()}`}>
        <span className="signal-bar__wait" style={{ left: `${50 - WAIT_BAND / 2}%`, width: `${WAIT_BAND}%` }} />
        <span className="signal-bar__fill" style={score >= 0 ? { left: '50%', width: `${half}%` } : { left: `${50 - half}%`, width: `${half}%` }} />
        <span className="signal-bar__zero" />
      </span>
    </span>
  );
}

/** Last price with a 600 ms up/down flash when it changes (the span remounts per price to replay it). */
function PriceCell({ m }: { m: MarketView }) {
  const [prev, setPrev] = useState(m.price);
  const [flash, setFlash] = useState<'up' | 'down' | undefined>(undefined);
  if (m.price !== prev) {
    setPrev(m.price);
    setFlash(prev !== null && m.price !== null ? (m.price > prev ? 'up' : 'down') : undefined);
  }
  return (
    <span key={m.price ?? 'none'} className="num board__px" data-flash={flash}>
      {price(m.price)}
    </span>
  );
}

function Change({ frac }: { frac: number | null }) {
  const text = pct(frac, { signed: true, digits: 2 });
  const t = tone(text);
  return (
    <span className={`num ${t}`}>
      {t && <span aria-hidden="true">{t === 'up' ? '▲ ' : '▼ '}</span>}
      {text}
    </span>
  );
}

/**
 * The Board: stock-perp markets typeset like a newspaper stock table. Prices flash on change,
 * the signal shows as text plus a centred bar, and headers sort. On phones the signal becomes a
 * second line under the symbol.
 */
export function Board({ limit, caption = true }: { limit?: number; caption?: boolean }) {
  const q = useMarkets();
  return <BoardView data={q.data} status={figureStatus(q)} limit={limit} caption={caption} />;
}

/** The board as a view: `data` undefined renders the unlit board (symbols from config, no prices). */
export function BoardView({ data, status: state, limit, caption = true }: { data: MarketsResponse | undefined; status: FigureStatus; limit?: number; caption?: boolean }) {
  const clock = useSessionClock();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);

  const markets = data ? [...data.markets] : null;
  if (markets) {
    if (sort) {
      const get = SORT_VALUE[sort.key];
      markets.sort((a, b) => {
        const x = get(a);
        const y = get(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      });
    } else {
      markets.sort((a, b) => Number(b.available) - Number(a.available));
    }
  }
  const rows = markets ? markets.slice(0, limit) : null;
  const venue = data ? (data.venue === 'paper' ? 'paper venue, Hyperliquid prices' : data.venue ? 'Hyperliquid' : 'no venue') : null;

  const header = (key: SortKey, label: string, align: 'l' | 'r' = 'r', cls = '') => {
    const active = sort?.key === key;
    return (
      <th scope="col" className={`${align === 'r' ? 'r' : ''} ${cls}`} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          className="sort"
          onClick={() => setSort(active ? (sort.dir === -1 ? { key, dir: 1 } : null) : { key, dir: key === 'symbol' ? 1 : -1 })}
        >
          {label}
          <Icon name="sort" size={12} className="sort__icon" />
        </button>
      </th>
    );
  };

  return (
    <div className="board" data-status={state}>
      <table className="table board__table">
        {caption && (
          <caption className="board__caption">
            <span>Hyperliquid equity perps</span>
            {venue && <span>{venue}</span>}
            <span>
              US session: {SESSION_LABEL[clock.session]}
              {state === 'stale' || state === 'offline' ? <span className="muted"> · prices paused, engine unreachable</span> : null}
            </span>
          </caption>
        )}
        <thead>
          <tr>
            {header('symbol', 'Symbol', 'l')}
            <th scope="col" className="board__name-col">
              Name
            </th>
            {header('price', 'Last')}
            {header('change', '24h')}
            {header('signal', 'Signal', 'l', 'board__sig-col')}
            {header('tokens', 'Tokens', 'r', 'board__opt')}
            {header('lev', 'Max lev.', 'r', 'board__opt')}
          </tr>
        </thead>
        <tbody>
          {rows
            ? rows.map((m) => (
                <tr key={m.symbol} className={m.available ? undefined : 'is-off'}>
                  <th scope="row" className="board__sym">
                    <span className="board__ticker">{m.symbol}</span>
                    <span className="board__sub">{m.available ? <SignalBar signal={m.signal} /> : 'Not on venue'}</span>
                  </th>
                  <td className="board__name-col">{m.name}</td>
                  <td className="r">{m.available ? <PriceCell m={m} /> : <span className="num muted">—</span>}</td>
                  <td className="r">
                    <Change frac={m.change24hPct} />
                  </td>
                  <td className="board__sig-col">{m.available ? <SignalBar signal={m.signal} /> : <span className="muted">Not on venue</span>}</td>
                  <td className="r num board__opt">{m.tokens > 0 ? m.tokens : <span className="muted">—</span>}</td>
                  <td className="r num board__opt">{leverage(m.maxLeverage)}</td>
                </tr>
              ))
            : STOCK_MARKETS.slice(0, limit).map((m) => (
                <tr key={m.symbol} aria-hidden="true">
                  <th scope="row" className="board__sym">
                    <span className="board__ticker">{m.symbol}</span>
                  </th>
                  <td className="board__name-col">{m.name}</td>
                  <td className="r num muted">—</td>
                  <td className="r num muted">—</td>
                  <td className="board__sig-col muted">—</td>
                  <td className="r num muted board__opt">—</td>
                  <td className="r num muted board__opt">—</td>
                </tr>
              ))}
        </tbody>
      </table>
      {!rows && (
        <p className="board__state" role="status">
          {state === 'offline' ? 'Engine unreachable: no prices have loaded yet. The board fills in when it reconnects.' : 'Loading prices…'}
        </p>
      )}
      <p className="board__legend">
        <Term id="signal">Signal</Term> is the engine’s entry score from −100 to 100; the shaded band (±{WAIT_BAND}) means wait.
      </p>
    </div>
  );
}
