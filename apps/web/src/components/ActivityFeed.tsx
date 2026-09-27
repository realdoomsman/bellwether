import type { ActivityEvent, ActivityKind, ActivityResponse } from '@bellwether/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { compact, etDateTime, eth } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useActivity, usePaperMode } from '../lib/queries';
import { isPaperEvent, KIND_GLYPH, KIND_LABEL, KIND_TONE, printAmount, printVerb, subject } from './activityMeta';
import { Empty, ErrorNotice, Loading, StaleNote } from './DataState';
import { Icon } from './Icon';
import { BellGlyph } from './Logo';
import { ReceiptTrigger } from './Receipt';
import { Segmented } from './Segmented';

/*
 * Activity, grouped so the log reads like a ledger rather than a wall: routine runs collapse into one
 * row (claims per 10 minutes, burns per engine run), burns carry the bell and a brass rule, trades
 * carry ▲▼, and every row opens its receipt. New arrivals slide in once; history never animates.
 */

const TRADE_KINDS: Partial<Record<ActivityKind, true>> = { open: true, reduce: true, close: true, stop: true, liquidated: true };

/** Collapse windows for routine events (bridging comes in two steps). Everything else stays one row per event. */
const BATCH_MS: Partial<Record<ActivityKind, number>> = { claim: 10 * 60_000, buyback: 60_000, bridge: 10 * 60_000 };

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const ET_DAY_NAME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
const ET_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY_MS = 86_400_000;

export interface FeedItem {
  key: string;
  kind: ActivityKind;
  /** Time of the newest event in the item. */
  at: number;
  /** Newest first; more than one for a collapsed run. */
  events: ActivityEvent[];
}

interface Day {
  id: string;
  label: string;
  items: FeedItem[];
  events: ActivityEvent[];
}

/** Live page plus paged history, newest first, each event once. */
function merge(live: ActivityEvent[], older: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<string>();
  const out: ActivityEvent[] = [];
  for (const e of [...live, ...older]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => b.at - a.at || Number(b.id) - Number(a.id));
}

/** Collapse runs of claims and burns; an item keeps its key as it grows, so it never remounts. */
export function feedItems(events: ActivityEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  const runs = new Map<string, FeedItem>();
  for (const e of events) {
    const window = BATCH_MS[e.kind];
    if (window === undefined) {
      items.push({ key: e.id, kind: e.kind, at: e.at, events: [e] });
      continue;
    }
    const key = `${e.kind}:${Math.floor(e.at / window)}`;
    const run = runs.get(key);
    if (run) run.events.push(e);
    else {
      const item = { key, kind: e.kind, at: e.at, events: [e] };
      runs.set(key, item);
      items.push(item);
    }
  }
  return items;
}

function dayLabel(at: number, now: number): string {
  const d = ET_DAY.format(at);
  if (d === ET_DAY.format(now)) return 'Today';
  if (d === ET_DAY.format(now - DAY_MS)) return 'Yesterday';
  return ET_DAY_NAME.format(at);
}

/** Split newest-first events into ET days, each with its collapsed rows. */
function byDay(events: ActivityEvent[], now: number): Day[] {
  const days: Day[] = [];
  for (const e of events) {
    const id = ET_DAY.format(e.at);
    let day = days[days.length - 1];
    if (!day || day.id !== id) {
      day = { id, label: dayLabel(e.at, now), items: [], events: [] };
      days.push(day);
    }
    day.events.push(e);
  }
  for (const d of days) d.items = feedItems(d.events);
  return days;
}

/**
 * Which rows arrived after the list first rendered: `new` rows slide in, `grew` runs flash their
 * count. Anything older than the first render (paged history) is neither, so it never animates.
 */
function useArrivals(items: FeedItem[]): (item: FeedItem) => 'new' | 'grew' | undefined {
  const base = useRef<{ sizes: Map<string, number>; newest: number } | null>(null);
  base.current ??= { sizes: new Map(items.map((i) => [i.key, i.events.length])), newest: items.reduce((m, i) => Math.max(m, i.at), 0) };
  const b = base.current;
  return (item) => {
    const size = b.sizes.get(item.key);
    if (size === undefined) return item.at > b.newest ? 'new' : undefined;
    return item.events.length > size ? 'grew' : undefined;
  };
}

/** Paging into older history with the engine's `nextBefore` cursor. */
function useOlder(load: (before: number) => Promise<ActivityResponse>, first: number | null) {
  const [older, setOlder] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = cursor === undefined ? first : cursor;
  const more = async () => {
    if (next === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const page = await load(next);
      setOlder((prev) => [...prev, ...page.events]);
      setCursor(page.nextBefore);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { older, next, busy, error, more };
}

function Glyph({ kind }: { kind: ActivityKind }) {
  return (
    <span className="feed__glyph" aria-hidden="true">
      {kind === 'buyback' ? <BellGlyph /> : KIND_GLYPH[kind]}
    </span>
  );
}

/** One event as a print (dashboard) or in the engine's own words (token page). Opens its receipt. */
function EventRow({ e, paper, words, time = true }: { e: ActivityEvent; paper: boolean; words: boolean; time?: boolean }) {
  const amount = printAmount(e);
  const who = subject(e);
  const simulated = paper || isPaperEvent(e);
  return (
    <ReceiptTrigger event={e} paper={paper} className="feed__row">
      {time && (
        <time className="feed__time" dateTime={new Date(e.at).toISOString()} title={etDateTime(e.at)}>
          {ET_HM.format(e.at)}
        </time>
      )}
      <Glyph kind={e.kind} />
      {words ? (
        <span className="feed__text">{e.title}</span>
      ) : (
        <span className="feed__text">
          {who ? (
            <>
              <span className="feed__who">{who}</span> <span className="feed__verb">{printVerb(e)}</span>
            </>
          ) : (
            <span className="feed__who">{KIND_LABEL[e.kind]}</span>
          )}
        </span>
      )}
      {!words && amount && (
        <span className="feed__amt">
          {amount}
          {e.kind === 'buyback' && e.tokenSymbol ? <span className="feed__unit"> ${e.tokenSymbol}</span> : null}
        </span>
      )}
      {simulated && <span className="paper-tag">PAPER</span>}
      <span className="sr-only">, open receipt</span>
    </ReceiptTrigger>
  );
}

/** The tokens in a run: the one symbol, or how many (the full list is in the title). */
function runTokens(events: ActivityEvent[]): { short: string; full: string } {
  const symbols = [...new Set(events.map((e) => (e.tokenSymbol ? `$${e.tokenSymbol}` : null)).filter((s): s is string => s !== null))];
  return { short: symbols.length === 1 ? `for ${symbols[0]}` : symbols.length > 1 ? `across ${symbols.length} tokens` : '', full: symbols.join(', ') };
}

const RUN_NOUN: Partial<Record<ActivityKind, [string, string]>> = { claim: ['claim', 'claims'], buyback: ['burn', 'burns'], bridge: ['bridge step', 'bridge steps'] };

/** A collapsed run: "7 burns · $GOOSE, $ASH and 5 more · 0.0055 ETH", expanding to each receipt. */
function RunRow({ item, paper, words, grew }: { item: FeedItem; paper: boolean; words: boolean; grew: boolean }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const id = useId();
  const n = item.events.length;
  const [one, many] = RUN_NOUN[item.kind] ?? ['event', 'events'];
  const spent = item.events.reduce((s, e) => s + (e.amountEth ?? 0), 0);
  const oldest = item.events[item.events.length - 1]?.at ?? item.at;
  const who = words ? null : runTokens(item.events);
  const simulated = paper || item.events.some(isPaperEvent);
  return (
    <>
      <button
        type="button"
        className="feed__row"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setMounted(true);
          setOpen((v) => !v);
        }}
      >
        <time className="feed__time" dateTime={new Date(item.at).toISOString()} title={oldest === item.at ? etDateTime(item.at) : `${etDateTime(oldest)} to ${etDateTime(item.at)}`}>
          {ET_HM.format(item.at)}
        </time>
        <Glyph kind={item.kind} />
        <span className="feed__text">
          <span className="feed__who">
            <span key={n} className={`feed__count${grew ? ' is-bumped' : ''}`}>
              {n}
            </span>{' '}
            {n === 1 ? one : many}
          </span>{' '}
          {who?.short && (
            <span className="feed__verb" title={who.full}>
              {who.short}
            </span>
          )}
        </span>
        {spent > 0 && <span className="feed__amt">{eth(spent)}</span>}
        {simulated && <span className="paper-tag">PAPER</span>}
        <Icon name="chevronDown" size={14} className="feed__chev" />
      </button>
      <div className="fold" id={id} data-open={open || undefined}>
        <div>
          {mounted && (
            <ol className="feed__run">
              {item.events.map((e) => (
                <li key={e.id}>
                  <EventRow e={e} paper={paper} words={words} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </>
  );
}

function FeedList({ items, paper, words, arrival }: { items: FeedItem[]; paper: boolean; words: boolean; arrival: (i: FeedItem) => 'new' | 'grew' | undefined }) {
  return (
    <ol className="feed">
      {items.map((item) => {
        const a = arrival(item);
        const tone = KIND_TONE[item.kind];
        return (
          <li key={item.key} className={`feed__item feed__item--${tone}${item.events.length > 1 ? ' feed__item--run' : ''}`} data-arrival={a === 'new' ? 'new' : undefined}>
            <div className="feed__in">
              {item.events.length > 1 ? (
                <RunRow item={item} paper={paper} words={words} grew={a === 'grew'} />
              ) : (
                item.events[0] && <EventRow e={item.events[0]} paper={paper} words={words} />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ── Live dashboard feed ─────────────────────────────────────────────────── */

type LiveFilter = 'all' | 'burns' | 'trades' | 'claims';
const LIVE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'burns', label: 'Burns' },
  { value: 'trades', label: 'Trades' },
  { value: 'claims', label: 'Claims' },
] as const satisfies readonly { value: LiveFilter; label: string }[];

const LIVE_MATCH: Record<LiveFilter, (k: ActivityKind) => boolean> = {
  all: () => true,
  burns: (k) => k === 'buyback',
  trades: (k) => TRADE_KINDS[k] === true,
  claims: (k) => k === 'claim',
};

const FILTER_NOUN: Record<Exclude<LiveFilter, 'all'>, string> = { burns: 'buybacks', trades: 'trades', claims: 'fee claims' };

/** A filter that matches nothing on the loaded pages looks this many pages further back on its own. */
const LOOK_BACK_PAGES = 4;

function LiveList({ live, older, filter, paper }: { live: ActivityEvent[]; older: ActivityEvent[]; filter: LiveFilter; paper: boolean }) {
  const now = useNow(60_000);
  const all = merge(live, older);
  const events = all.filter((e) => LIVE_MATCH[filter](e.kind));
  const days = byDay(events, now);
  const arrival = useArrivals(feedItems(merge(live, [])));
  if (days.length === 0) return <p className="feed__none">{filter === 'all' ? 'No activity yet.' : `No ${FILTER_NOUN[filter]} in the latest ${all.length} events.`}</p>;
  return (
    <div className="feed-days">
      {days.map((d) => (
        <section key={d.id} className="feed-day" aria-label={d.label}>
          <h3 className="feed-day__head">
            {d.label} <span className="feed-day__tz">ET</span>
          </h3>
          <FeedList items={d.items} paper={paper} words={false} arrival={arrival} />
        </section>
      ))}
    </div>
  );
}

/** The live dashboard's activity column: heading, filter, the grouped feed and older pages. */
export function LiveActivity({ titleId }: { titleId: string }) {
  const q = useActivity();
  const paper = usePaperMode();
  const [filter, setFilter] = useState<LiveFilter>('all');
  // Older pages come 200 at a time (the API's maximum): routine claims and burns fill a page fast.
  const pages = useOlder((before) => api.activity({ before, limit: 200 }), q.data?.nextBefore ?? null);
  const [lookedBack, setLookedBack] = useState(0);
  const matched = !q.data || merge(q.data.events, pages.older).some((e) => LIVE_MATCH[filter](e.kind));

  // Picking "Trades" when the newest events are all claims shouldn't show an empty list if older pages have trades.
  useEffect(() => {
    if (matched || pages.next === null || pages.busy || pages.error || lookedBack >= LOOK_BACK_PAGES) return;
    setLookedBack((n) => n + 1);
    void pages.more();
  }, [matched, pages.next, pages.busy, pages.error, lookedBack]);

  let body;
  if (!q.data) {
    body = q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Activity" compact /> : <Loading label="activity" height={40} count={6} />;
  } else if (q.data.events.length === 0 && pages.older.length === 0) {
    body = <Empty title="Nothing yet">Claims, trades and burns appear here the moment the engine makes them, each with its receipt.</Empty>;
  } else {
    body = (
      <>
        <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
        <LiveList live={q.data.events} older={pages.older} filter={filter} paper={paper} />
        {pages.next !== null && (
          <button type="button" className="btn btn--ghost btn--sm btn--block feed__more" onClick={() => void pages.more()} disabled={pages.busy}>
            {pages.busy ? 'Loading…' : 'Load older activity'}
          </button>
        )}
        {pages.error && <p className="field__hint field__hint--error">{pages.error}</p>}
      </>
    );
  }

  return (
    <>
      <div className="panel-head">
        <h2 id={titleId} className="panel-head__title">
          Activity
        </h2>
        <Segmented
          label="Show"
          size="sm"
          options={LIVE_FILTERS}
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setLookedBack(0);
          }}
        />
      </div>
      <div className="live-activity__scroll">{body}</div>
    </>
  );
}

/* ── Token timeline ──────────────────────────────────────────────────────── */

type TimelineFilter = 'key' | 'all';
const TIMELINE_FILTERS = [
  { value: 'key', label: 'Burns & trades' },
  { value: 'all', label: 'Everything' },
] as const satisfies readonly { value: TimelineFilter; label: string }[];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "12 claims (0.024 ETH) · 3 burns (284K $GOOSE) · 0 trades" */
function daySummary(events: ActivityEvent[], symbol: string): string[] {
  let claims = 0;
  let claimedEth = 0;
  let burns = 0;
  let burned = 0;
  let trades = 0;
  const other: string[] = [];
  for (const e of events) {
    if (e.kind === 'claim') {
      claims += 1;
      claimedEth += e.amountEth ?? 0;
    } else if (e.kind === 'buyback') {
      burns += 1;
      burned += e.tokensBurned ?? 0;
    } else if (TRADE_KINDS[e.kind]) trades += 1;
    else if (e.kind !== 'bridge') other.push(KIND_LABEL[e.kind].toLowerCase());
  }
  return [
    `${plural(claims, 'claim', 'claims')}${claims ? ` (${eth(claimedEth)})` : ''}`,
    `${plural(burns, 'burn', 'burns')}${burns ? ` (${compact(burned)} $${symbol})` : ''}`,
    plural(trades, 'trade', 'trades'),
    ...new Set(other),
  ];
}

function TimelineDay({
  day,
  symbol,
  filter,
  paper,
  defaultOpen,
  arrival,
  onShowAll,
  partial,
}: {
  day: Day;
  symbol: string;
  filter: TimelineFilter;
  paper: boolean;
  defaultOpen: boolean;
  arrival: (i: FeedItem) => 'new' | 'grew' | undefined;
  onShowAll: () => void;
  /** Older events of this day exist but aren't loaded, so its counts cover only part of it. */
  partial: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  // "Burns & trades": everything that changes the token's state; claims and bridging are routine.
  const items = filter === 'all' ? day.items : feedItems(day.events.filter((e) => e.kind !== 'claim' && e.kind !== 'bridge'));
  const claims = day.events.filter((e) => e.kind === 'claim').length;
  return (
    <li className="tl-day">
      <button type="button" className="tl-day__head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span className="tl-day__name">{day.label}</span>
        <span className="tl-day__sum dots">
          {daySummary(day.events, symbol).map((part) => (
            <span key={part}>{part}</span>
          ))}
          {partial && <span className="tl-day__partial">since {ET_HM.format(day.events[day.events.length - 1]?.at ?? 0)} ET; earlier not loaded</span>}
        </span>
        <Icon name="chevronDown" size={16} className="tl-day__chev" />
      </button>
      <div className="fold" id={id} data-open={open || undefined}>
        <div>
          {items.length > 0 ? (
            <FeedList items={items} paper={paper} words arrival={arrival} />
          ) : (
            <p className="tl-day__none">
              No burns or trades this day.{' '}
              {claims > 0 && (
                <button type="button" className="link-btn" onClick={onShowAll}>
                  Show the {plural(claims, 'claim', 'claims')}
                </button>
              )}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * A token's history as one summary line per ET day ("Today · 12 claims (0.024 ETH) · 3 burns …");
 * a day expands to its rows. Defaults to burns and trades; "Everything" adds claims and bridging.
 */
export function TokenTimeline({ token, symbol, events, titleId }: { token: string; symbol: string; events: ActivityEvent[]; titleId: string }) {
  const paper = usePaperMode();
  const now = useNow(60_000);
  const [filter, setFilter] = useState<TimelineFilter>('key');
  // The token detail carries the newest 50 events; a full page means there may be more.
  const last = events[events.length - 1];
  const pages = useOlder((before) => api.activity({ token, before, limit: 200 }), events.length >= 50 && last ? Number(last.id) : null);
  const all = merge(events, pages.older);
  const days = byDay(all, now);
  const arrival = useArrivals(feedItems(merge(events, [])));

  return (
    <>
      <div className="panel-head">
        <h2 id={titleId} className="panel-head__title">
          Activity
        </h2>
        <Segmented label="Show" size="sm" options={TIMELINE_FILTERS} value={filter} onChange={setFilter} />
      </div>
      {days.length === 0 ? (
        <Empty title="Nothing yet">Registration, claims, trades and burns for ${symbol} will be listed here as the engine records them.</Empty>
      ) : (
        <>
          <ol className="tl">
            {days.map((d, i) => (
              <TimelineDay
                key={d.id}
                day={d}
                symbol={symbol}
                filter={filter}
                paper={paper}
                defaultOpen={i === 0}
                arrival={arrival}
                onShowAll={() => setFilter('all')}
                partial={pages.next !== null && i === days.length - 1}
              />
            ))}
          </ol>
          {pages.next !== null && (
            <button type="button" className="btn btn--secondary btn--sm tl__more" onClick={() => void pages.more()} disabled={pages.busy}>
              {pages.busy ? 'Loading…' : 'Load older activity'}
            </button>
          )}
          {pages.error && <p className="field__hint field__hint--error">{pages.error}</p>}
        </>
      )}
    </>
  );
}
