import { SESSION_LABEL, STOCK_MARKETS, type MarketView } from '@bellwether/shared';
import { useRef, useState, type KeyboardEvent } from 'react';
import { SignalBar } from '../../components/Board';
import { ErrorNotice } from '../../components/DataState';
import { figureStatus } from '../../components/Figure';
import { Icon } from '../../components/Icon';
import { Term } from '../../components/Term';
import { etTime, leverage, pct, price, tone } from '../../lib/format';
import { useMarkets } from '../../lib/queries';
import { useSessionClock } from '../../lib/session';

/** A market row: live venue data when the engine answered, just the symbol and name before that. */
type Row = Pick<MarketView, 'symbol' | 'name' | 'sector'> & { live: MarketView | null };

/** Last price that flashes up/down for 600 ms when it changes (the span remounts per price to replay it). */
function Last({ value }: { value: number | null }) {
  const [prev, setPrev] = useState(value);
  const [flash, setFlash] = useState<'up' | 'down' | undefined>(undefined);
  if (value !== prev) {
    setPrev(value);
    setFlash(prev !== null && value !== null ? (value > prev ? 'up' : 'down') : undefined);
  }
  return (
    <span key={value ?? 'none'} className="num board__px" data-flash={flash}>
      {price(value)}
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
 * Compact board of the venue's stock perps as a radio group: live last price, 24 h change, the
 * engine's entry signal and the venue's leverage cap. Search filters; Enter in search picks the top match.
 */
export function MarketPicker({ value, onChange }: { value: string | null; onChange: (symbol: string, market: MarketView | null) => void }) {
  const q = useMarkets();
  const state = figureStatus(q);
  const clock = useSessionClock();
  const [query, setQuery] = useState('');
  const body = useRef<HTMLTableSectionElement>(null);

  const rows: Row[] = q.data
    ? [...q.data.markets].sort((a, b) => Number(b.available) - Number(a.available)).map((m) => ({ symbol: m.symbol, name: m.name, sector: m.sector, live: m }))
    : STOCK_MARKETS.map((m) => ({ ...m, live: null }));
  const needle = query.trim().toLowerCase();
  const visible = needle ? rows.filter((m) => `${m.symbol} ${m.name} ${m.sector}`.toLowerCase().includes(needle)) : rows;
  const pickable = (m: Row) => m.live?.available !== false;

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Enter here picks the top match instead of submitting the step.
      e.preventDefault();
      const top = visible.find(pickable);
      if (top) onChange(top.symbol, top.live);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      body.current?.querySelector<HTMLInputElement>('input:checked, input:not(:disabled)')?.focus();
    }
  };

  const venue = q.data ? (q.data.venue === 'paper' ? 'Paper venue, Hyperliquid prices' : q.data.venue ? 'Hyperliquid' : 'No venue') : null;
  const tradable = q.data ? q.data.markets.filter((m) => m.available).length : null;

  return (
    <div className="lw-mkts" data-status={state}>
      <div className="lw-mkts__bar">
        <div className="search lw-mkts__search">
          <Icon name="search" />
          <input
            className="input"
            type="search"
            placeholder={`Search ${rows.length} stocks`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            aria-label="Search markets"
            aria-controls="lw-mkts-table"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p className="lw-mkts__meta">
          {venue && <span>{venue}</span>}
          {tradable !== null && (
            <span>
              {tradable} of {rows.length} tradable
            </span>
          )}
          <span>US session: {SESSION_LABEL[clock.session]}</span>
          {q.updatedAt !== null && (
            <span>
              as of <time dateTime={new Date(q.updatedAt).toISOString()}>{etTime(q.updatedAt, { seconds: true })}</time>
              {state === 'stale' || state === 'offline' ? ' (stale)' : ''}
            </span>
          )}
        </p>
      </div>

      {q.error && !q.data && (
        <ErrorNotice
          error={q.error}
          onRetry={q.refresh}
          what="Live prices and venue limits"
          compact
          offlineHint="You can still plan your token. Availability and leverage caps are checked again when you register."
        />
      )}

      <div className="lw-mkts__scroll">
        <table className="lw-mkts__table" id="lw-mkts-table">
          <caption className="sr-only">Stock perps your token can trade. Pick one.</caption>
          <thead>
            <tr>
              <th scope="col" className="lw-mkts__pick">
                <span className="sr-only">Pick</span>
              </th>
              <th scope="col">Symbol</th>
              <th scope="col" className="lw-mkts__name">
                Name
              </th>
              <th scope="col" className="r">
                Last
              </th>
              <th scope="col" className="r">
                24h
              </th>
              <th scope="col" className="lw-mkts__sig">
                <Term id="signal">Signal</Term>
              </th>
              <th scope="col" className="r lw-mkts__lev">
                Max lev.
              </th>
            </tr>
          </thead>
          <tbody ref={body}>
            {visible.map((m) => {
              const on = value === m.symbol;
              const off = !pickable(m);
              const nameId = `lw-mkt-${m.symbol}`;
              return (
                <tr key={m.symbol} data-on={on || undefined} data-off={off || undefined} onClick={() => !off && onChange(m.symbol, m.live)}>
                  <td className="lw-mkts__pick">
                    <input
                      type="radio"
                      name="market"
                      value={m.symbol}
                      checked={on}
                      disabled={off}
                      onChange={() => onChange(m.symbol, m.live)}
                      className="lw-radio__input"
                      aria-labelledby={nameId}
                    />
                    <span className="lw-radio" aria-hidden="true" />
                  </td>
                  <th scope="row" id={nameId} className="lw-mkts__sym">
                    <span className="lw-mkts__ticker">{m.symbol}</span>
                    <span className="lw-mkts__sub">
                      {m.name}
                      {m.live && (off ? ' · not on venue' : ` · ≤${leverage(m.live.maxLeverage)}`)}
                    </span>
                  </th>
                  <td className="lw-mkts__name">{m.name}</td>
                  <td className="r">{m.live?.available ? <Last value={m.live.price} /> : <span className="num muted">—</span>}</td>
                  <td className="r">{m.live ? <Change frac={m.live.change24hPct} /> : <span className="num muted">—</span>}</td>
                  <td className="lw-mkts__sig">{m.live ? off ? <span className="muted">Not on venue</span> : <SignalBar signal={m.live.signal} /> : <span className="muted">—</span>}</td>
                  <td className="r num lw-mkts__lev">{m.live ? leverage(m.live.maxLeverage) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <p className="lw-mkts__none">
            No stock matches “{query.trim()}”.{' '}
            <button type="button" className="link-btn" onClick={() => setQuery('')}>
              Clear search
            </button>
          </p>
        )}
      </div>
      {!q.data && !q.error && (
        <p className="lw-mkts__state" role="status">
          Connecting to the engine for live prices…
        </p>
      )}
    </div>
  );
}
