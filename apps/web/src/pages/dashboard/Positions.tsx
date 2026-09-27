import { STRATEGIES, type PositionView } from '@bellwether/shared';
import { Fragment, useId, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { StagePill } from '../../components/Badges';
import { Icon } from '../../components/Icon';
import { Medallion } from '../../components/Medallion';
import { Pnl } from '../../components/Stat';
import { Term } from '../../components/Term';
import { etDateTime, leverage, pct, pct0, price, relTime, tone, usd } from '../../lib/format';
import { useNow } from '../../lib/hooks';

/** Every trading strategy shares one exit ladder (strategies.ts), so the pooled position follows it. */
const LADDER = STRATEGIES.balanced.exits;
/** Under this distance to liquidation the meter turns to the down color. */
const DANGER = 0.1;

/** Fraction of the mark price the market can still move against the position before liquidation. */
function liqDistance(p: PositionView): number | null {
  if (p.liquidationPrice === null || p.markPrice <= 0) return null;
  const d = p.side === 'long' ? (p.markPrice - p.liquidationPrice) / p.markPrice : (p.liquidationPrice - p.markPrice) / p.markPrice;
  return Math.max(0, d);
}

/** Last price with a 600 ms up/down wash when it changes (the span remounts per price to replay it). */
function MarkPrice({ value }: { value: number }) {
  const [prev, setPrev] = useState(value);
  const [flash, setFlash] = useState<'up' | 'down' | undefined>(undefined);
  if (value !== prev) {
    setPrev(value);
    setFlash(value > prev ? 'up' : 'down');
  }
  return (
    <span key={value} className="num px" data-flash={flash}>
      {price(value)}
    </span>
  );
}

/**
 * Distance to liquidation: the bar is the share of the cushion the position opened with that is still
 * left, the label the move that would liquidate it now. Turns to the down color under 10%.
 */
function LiqMeter({ p }: { p: PositionView }) {
  const d = liqDistance(p);
  if (d === null || p.liquidationPrice === null) return <span className="muted small">None reported</span>;
  const atEntry = Math.abs(p.entryPrice - p.liquidationPrice) / p.entryPrice;
  const left = atEntry > 0 ? Math.min(1, d / atEntry) : 0;
  const danger = d < DANGER;
  return (
    <span
      className={`liq${danger ? ' liq--danger' : ''}`}
      title={`Liquidation at ${price(p.liquidationPrice)}: the mark is ${pct(d)} ${p.side === 'long' ? 'above' : 'below'} it`}
    >
      <span className="liq__bar" aria-hidden="true">
        <span className="liq__fill" style={{ '--liq': left } as CSSProperties} />
      </span>
      <span className="num">{pct(d)}</span>
      <span className="sr-only"> from liquidation at {price(p.liquidationPrice)}</span>
    </span>
  );
}

function Market({ p }: { p: PositionView }) {
  return (
    <span className="pmkt">
      <span className="pmkt__sym">
        {p.market}
        <span className="pmkt__perp">-PERP</span>
      </span>
      <span className="pmkt__side">
        <span className={p.side === 'long' ? 'up' : 'down'}>{p.side === 'long' ? '▲ Long' : '▼ Short'}</span>
        <span className="num">{leverage(p.leverage)}</span>
        {p.stage !== 'open' && <StagePill stage={p.stage} />}
      </span>
    </span>
  );
}

function Holders({ p, focusToken }: { p: PositionView; focusToken?: string }) {
  const focus = focusToken?.toLowerCase();
  const mine = focus ? p.shares.find((s) => s.token.toLowerCase() === focus) : undefined;
  if (mine) {
    return (
      <span className="holders">
        <span className="num">{pct(mine.share)}</span>
        <span className="muted small ptable__long">{p.shares.length > 1 ? `of ${p.shares.length} tokens` : 'sole owner'}</span>
      </span>
    );
  }
  const first = p.shares[0];
  return (
    <span className="holders">
      <span className="holders__stack" aria-hidden="true">
        {p.shares.slice(0, 3).map((s) => (
          <Medallion key={s.token} image={null} symbol={s.symbol} address={s.token} size={20} />
        ))}
      </span>
      {p.shares.length === 1 && first ? (
        <Link to={`/t/${first.token}`} className="holders__one num">
          ${first.symbol}
        </Link>
      ) : (
        <span className="small">{p.shares.length} tokens</span>
      )}
    </span>
  );
}

type RungState = 'done' | 'next' | 'later' | 'here' | 'entry' | 'risk';
interface Rung {
  key: string;
  label: string;
  note: string;
  price: number;
  state: RungState;
}

/** The exits the engine will take, in price order with the favorable side on top, around the mark. */
function rungs(p: PositionView, now: number): Rung[] {
  const dir = p.side === 'long' ? 1 : -1;
  const target = (move: number) => p.entryPrice * (1 + dir * move);
  const tp1Taken = p.stage === 'tp1' || p.stage === 'tp2' || p.stage === 'trailing';
  const tp2Taken = p.stage === 'tp2' || p.stage === 'trailing';
  const list: Rung[] = [
    {
      key: 'tp2',
      label: 'Take profit 2',
      note: tp2Taken ? 'taken' : `closes ${pct0(LADDER.tp2Fraction)} of the rest, then trails ${pct(LADDER.trailPullback)}`,
      price: target(LADDER.tp2Move),
      state: tp2Taken ? 'done' : tp1Taken ? 'next' : 'later',
    },
    {
      key: 'tp1',
      label: 'Take profit 1',
      note: tp1Taken ? 'taken' : `closes ${pct0(LADDER.tp1Fraction)}`,
      price: target(LADDER.tp1Move),
      state: tp1Taken ? 'done' : 'next',
    },
    { key: 'mark', label: 'Mark', note: 'now', price: p.markPrice, state: 'here' },
    { key: 'entry', label: 'Entry', note: `opened ${relTime(Math.min(p.openedAt, now), now)}`, price: p.entryPrice, state: 'entry' },
  ];
  if (p.stopPrice !== null) {
    list.push({
      key: 'stop',
      label: p.stage === 'trailing' ? 'Trailing stop' : p.stage === 'open' ? 'Stop' : 'Stop, moved up',
      note: 'closes the rest',
      price: p.stopPrice,
      state: 'risk',
    });
  }
  if (p.liquidationPrice !== null) list.push({ key: 'liq', label: 'Liquidation', note: 'the venue closes it', price: p.liquidationPrice, state: 'risk' });
  return list.sort((a, b) => dir * (b.price - a.price));
}

/** Expanded row: the exit ladder, which tokens own the position, and its facts. */
function PositionDetail({ p, focusToken }: { p: PositionView; focusToken?: string }) {
  const now = useNow(15_000);
  const focus = focusToken?.toLowerCase();
  return (
    <div className="pdetail">
      <section className="pdetail__col pdetail__ladder" aria-label={`${p.market} exit ladder`}>
        <p className="pdetail__h">Exit ladder</p>
        <ol className="rungs">
          {rungs(p, now).map((r) => {
            const dist = r.state === 'here' ? null : pct((r.price - p.markPrice) / p.markPrice, { signed: true });
            return (
              <li key={r.key} className={`rung rung--${r.state}`} aria-current={r.state === 'here' ? 'true' : undefined}>
                <span className="rung__dot" aria-hidden="true" />
                <span className="rung__label">
                  {r.key === 'liq' ? <Term id="liquidation">{r.label}</Term> : r.key === 'mark' ? <Term id="mark">{r.label}</Term> : r.label}
                  <span className="rung__note">
                    {r.state === 'done' && <span aria-hidden="true">✓ </span>}
                    {r.note}
                  </span>
                </span>
                <span className="rung__px num">{price(r.price)}</span>
                <span className={`rung__dist num ${dist ? tone(dist) : ''}`}>{dist ?? ''}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="pdetail__col" aria-label="Tokens sharing this position">
        <p className="pdetail__h">{p.shares.length === 1 ? 'Owned by' : `Shared by ${p.shares.length} tokens`}</p>
        <ul className="shares">
          {p.shares.map((s) => (
            <li key={s.token} className={s.token.toLowerCase() === focus ? 'is-focus' : undefined}>
              <Medallion image={null} symbol={s.symbol} address={s.token} size={24} />
              <Link to={`/t/${s.token}`} className="shares__sym num">
                ${s.symbol}
              </Link>
              <span className="shares__bar" aria-hidden="true">
                <span style={{ '--share': s.share } as CSSProperties} />
              </span>
              <span className="shares__pct num">{pct(s.share)}</span>
              <span className="shares__usd num">{usd(s.collateralUsd)}</span>
              <span className="shares__pnl">
                <Pnl value={p.unrealizedPnlUsd * s.share} />
              </span>
            </li>
          ))}
        </ul>
        <p className="pdetail__note">Each token owns the share of the pooled position its collateral paid for, and takes the same share of the PnL.</p>
      </section>

      <section className="pdetail__col" aria-label={`${p.market} position facts`}>
        <p className="pdetail__h">Position</p>
        <dl className="kv pdetail__kv">
          <div>
            <dt>Opened</dt>
            <dd>
              <time dateTime={new Date(p.openedAt).toISOString()}>{etDateTime(p.openedAt)}</time>
            </dd>
          </div>
          <div>
            <dt>Notional</dt>
            <dd className="num">{usd(p.sizeUsd)}</dd>
          </div>
          <div>
            <dt>Collateral</dt>
            <dd className="num">{usd(p.collateralUsd)}</dd>
          </div>
          <div>
            <dt>
              <Term id="leverage">Leverage</Term>
            </dt>
            <dd className="num">{leverage(p.leverage)}</dd>
          </div>
          <div>
            <dt>Venue</dt>
            <dd>{p.venue === 'paper' ? 'Paper, Hyperliquid prices' : 'Hyperliquid'}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

/**
 * Open positions as instrument rows: market and side, size, entry, mark (flashes on change), distance
 * to liquidation, open PnL and who owns it. A row expands to its exit ladder and per-token shares.
 * Below 768 px each position is a two-line row.
 */
export function PositionTable({ positions, focusToken, openByDefault = false, caption }: { positions: PositionView[]; focusToken?: string; openByDefault?: boolean; caption: string }) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  // A detail panel mounts the first time its row opens and stays for the closing fold; closed rows
  // that were never opened don't carry the ladder and shares in the DOM.
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
  const baseId = useId();
  const toggle = (id: string) => {
    setMounted((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <table className="ptable">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Market</th>
          <th scope="col" className="r">
            Size
          </th>
          <th scope="col" className="r ptable__wide">
            Entry
          </th>
          <th scope="col" className="r">
            <Term id="mark">Mark</Term>
          </th>
          <th scope="col">
            <Term id="liquidation">To liquidation</Term>
          </th>
          <th scope="col" className="r">
            Open PnL
          </th>
          <th scope="col">{focusToken ? 'Share' : 'Tokens'}</th>
          <th scope="col">
            <span className="sr-only">Details</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const open = openByDefault !== toggled.has(p.id);
          const detailId = `${baseId}-${p.id}`;
          const onCollateral = pct(p.unrealizedPnlPct, { signed: true });
          const d = liqDistance(p);
          return (
            <Fragment key={p.id}>
              <tr
                className="ptable__row"
                data-open={open || undefined}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('a, button, .term')) toggle(p.id);
                }}
              >
                <th scope="row" className="ptable__mkt">
                  <Market p={p} />
                </th>
                <td className="r ptable__d">
                  <span className="num">{usd(p.sizeUsd)}</span>
                  <span className="ptable__sub num">{usd(p.collateralUsd)} margin</span>
                </td>
                <td className="r num ptable__d ptable__wide">{price(p.entryPrice)}</td>
                <td className="r ptable__d">
                  <MarkPrice value={p.markPrice} />
                </td>
                <td className="ptable__d">
                  <LiqMeter p={p} />
                </td>
                <td className="r ptable__pnl">
                  <Pnl value={p.unrealizedPnlUsd} />
                  <span className={`ptable__sub num ${tone(onCollateral)}`}>
                    {onCollateral}
                    <span className="ptable__long"> on margin</span>
                  </span>
                </td>
                <td className="ptable__d">
                  <Holders p={p} focusToken={focusToken} />
                </td>
                <td className="ptable__tog">
                  <button type="button" className="icon-btn" aria-expanded={open} aria-controls={detailId} aria-label={`${open ? 'Hide' : 'Show'} the ${p.market} exit ladder and shares`} onClick={() => toggle(p.id)}>
                    <Icon name="chevronDown" />
                  </button>
                </td>
                <td className="ptable__m">
                  <span className="num">{usd(p.sizeUsd)}</span>
                  <span>
                    mark <MarkPrice value={p.markPrice} />
                  </span>
                  {d !== null && <span className={`num${d < DANGER ? ' down' : ''}`}>{pct(d)} to liq.</span>}
                  <Holders p={p} focusToken={focusToken} />
                </td>
              </tr>
              <tr className="ptable__detail" data-open={open || undefined}>
                <td colSpan={8}>
                  <div className="fold" id={detailId} data-open={open || undefined}>
                    <div>
                      {(open || mounted.has(p.id)) && <PositionDetail p={p} focusToken={focusToken} />}
                    </div>
                  </div>
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
