import { STRATEGIES, type ActivityEvent, type MarketsResponse } from '@bellwether/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { BiasChip, Pill, StagePill, StatusPill, VerdictPill } from '../components/Badges';
import { Bell, BellView, RingCaption, type BellHandle } from '../components/Bell';
import { Board, BoardView } from '../components/Board';
import { CandleChart } from '../components/CandleChart';
import { CopyButton } from '../components/CopyButton';
import { Empty, EngineDark, ErrorNotice, Loading, StaleNote } from '../components/DataState';
import { Dialog } from '../components/Dialog';
import { EngineIndicator, EngineStatusBar } from '../components/EngineStatus';
import { Figure, FigureRow, figureStatus } from '../components/Figure';
import { Icon } from '../components/Icon';
import { BellGlyph, Lockup, Monogram, Wordmark } from '../components/Logo';
import { Medallion } from '../components/Medallion';
import { Popover } from '../components/Popover';
import { Arrow, Col, Grid, Muted, Rule, Section } from '../components/Primitives';
import { Receipt, ReceiptTrigger } from '../components/Receipt';
import { Reveal } from '../components/Reveal';
import { Segmented } from '../components/Segmented';
import { SessionLine } from '../components/SessionLine';
import { Sparkline } from '../components/Sparkline';
import { StatusDot } from '../components/StatusDot';
import { Tape, TapeView } from '../components/Tape';
import { Term } from '../components/Term';
import { useToast } from '../components/Toast';
import { AnnounceToggle, SoundToggle, ThemeToggle } from '../components/Toggles';
import { Fn } from '../content/footnotes';
import { ApiRequestError } from '../lib/api';
import { useNow, useTitle } from '../lib/hooks';
import { useActivity, useMarketCandles, useMarkets, usePaperMode, useStats, useTokens } from '../lib/queries';
import '../styles/kit.css';

/* Static examples are labelled as such on the page; every other value comes from the engine. */
const STATIC_PAPER_BURN: ActivityEvent = {
  id: 'kit-static-burn',
  kind: 'buyback',
  at: Date.parse('2026-09-25T18:03:00Z'),
  token: '0x5dA72d47026B80232d85861F5B6aD53029C28A2c',
  tokenSymbol: 'EXAMPLE',
  title: 'Static example: bought back and burned $EXAMPLE',
  amountEth: 0.0019,
  tokensBurned: 94_860,
  txs: [{ chain: 'rhc', hash: 'paper:kit-example', url: null }],
};

const STATIC_MARKETS: MarketsResponse = {
  venue: 'paper',
  markets: [
    { symbol: 'EXA', name: 'Static example, long bias', sector: 'Example', available: true, maxLeverage: 10, price: 101.25, change24hPct: 0.0123, signal: { score: 62, bias: 'long' }, tokens: 3 },
    { symbol: 'EXB', name: 'Static example, wait', sector: 'Example', available: true, maxLeverage: 20, price: 48.1, change24hPct: -0.004, signal: { score: -8, bias: 'wait' }, tokens: 0 },
    { symbol: 'EXC', name: 'Static example, short bias', sector: 'Example', available: true, maxLeverage: 5, price: 9.87, change24hPct: -0.031, signal: { score: -47, bias: 'short' }, tokens: 1 },
    { symbol: 'EXD', name: 'Static example, not on venue', sector: 'Example', available: false, maxLeverage: 10, price: null, change24hPct: null, signal: null, tokens: 0 },
  ],
};

const STATIC_SERIES = [2, 3, 3, 5, 4, 6, 7, 6, 9, 11, 10, 13, 12, 15];

const OFFLINE_ERROR = new ApiRequestError(0, 'engine_offline', 'The engine is unreachable right now.');
const INVALID_ERROR = new ApiRequestError(400, 'invalid_address', 'Invalid address');

const COLOR_TOKENS = ['--paper', '--paper-2', '--paper-3', '--rule', '--rule-strong', '--ink', '--ink-2', '--ink-3', '--brass', '--brass-ink', '--up', '--down'] as const;
const TYPE_SCALE = [
  { cls: 'display', label: 'Display · serif 320 · 48 → 104', sample: 'Every fee rings the bell.' },
  { cls: 'h1', label: 'H1 · serif 340 · 40 → 72', sample: 'The books balance.' },
  { cls: 'h2', label: 'H2 · serif 360 · 30 → 44', sample: 'How the money moves' },
  { cls: 'h3', label: 'H3 · Geist 500 · 22', sample: 'Open positions' },
  { cls: 'lead', label: 'Lead · Geist 400 · 18 → 19', sample: 'The engine claims your fees, trades tokenized-stock perps, and buys back and burns your token.' },
  { cls: 'kit-body', label: 'Body · Geist 400 · 16/26', sample: 'Every step comes with a receipt you can check on-chain.' },
  { cls: 'small', label: 'Small · Geist 400 · 14', sample: 'Positions are pooled per market; each token owns a share.' },
  { cls: 'label', label: 'Label · Geist 500 · 12, sentence case', sample: '§2 How the money moves' },
  { cls: 'num', label: 'Data · Geist Mono · 13, tabular, slashed zero', sample: '0.0019 ETH · 94,860 · $16,393.11' },
];

/** A labelled specimen block. */
function Spec({ title, note, children, wide = false }: { title: string; note?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`spec${wide ? ' spec--wide' : ''}`}>
      <div className="spec__head">
        <h3 className="spec__title">{title}</h3>
        {note && <p className="spec__note">{note}</p>}
      </div>
      <div className="spec__body">{children}</div>
    </div>
  );
}

function StaticTag() {
  return <span className="kit-static">Static example, not live data</span>;
}

function Swatches() {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const read = () => {
      const css = getComputedStyle(document.documentElement);
      setValues(Object.fromEntries(COLOR_TOKENS.map((t) => [t, css.getPropertyValue(t).trim()])));
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return (
    <ul className="swatches">
      {COLOR_TOKENS.map((t) => (
        <li key={t}>
          <span className="swatch" style={{ background: `var(${t})` }} />
          <code>{t}</code>
          <span className="num muted">{values[t]}</span>
        </li>
      ))}
    </ul>
  );
}

function BellStates() {
  const preview = useRef<BellHandle>(null);
  const now = useNow(15_000);
  return (
    <div className="kit-row kit-row--bells">
      <div className="kit-cell">
        <p className="label">Fresh ring caption · paper</p>
        <BellView
          ref={preview}
          label="Static example"
          captionKey="static"
          caption={<RingCaption event={STATIC_PAPER_BURN} count={3} paper now={now} />}
          counter={<>Counter as in the live bell</>}
          controls={
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => preview.current?.ring()}>
              Preview the swing (kit only)
            </button>
          }
        />
        <StaticTag />
      </div>
      <div className="kit-cell">
        <p className="label">$BELL tenor strike</p>
        <TenorPreview />
        <StaticTag />
      </div>
      <div className="kit-cell">
        <p className="label">Offline</p>
        <BellView label="Static example, offline" offline caption="Engine unreachable. Last ring 14:02 ET." />
        <StaticTag />
      </div>
      <div className="kit-cell">
        <p className="label">Mini (token header, 56 px)</p>
        <BellView variant="mini" label="Static example, mini" />
        <StaticTag />
      </div>
    </div>
  );
}

function TenorPreview() {
  const ref = useRef<BellHandle>(null);
  return (
    <BellView
      ref={ref}
      label="Static example, tenor"
      caption="Tenor rings: brass-ink, thicker, for $BELL burns"
      controls={
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => ref.current?.ring({ tenor: true })}>
          Preview tenor (kit only)
        </button>
      }
    />
  );
}

function Overlays() {
  const [dialog, setDialog] = useState(false);
  const [pop, setPop] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const notify = useToast();
  return (
    <div className="row">
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => setDialog(true)}>
        Open dialog
      </button>
      <button ref={anchor} type="button" className="btn btn--secondary btn--sm" aria-expanded={pop} onClick={() => setPop((v) => !v)}>
        Open popover
      </button>
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => notify('Copied protocol wallet', 'success')}>
        Toast: success
      </button>
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => notify('Couldn’t access the clipboard.', 'error')}>
        Toast: error
      </button>
      <CopyButton text="0x000000000000000000000000000000000000dEaD" what="burn address" />
      <Dialog open={dialog} onClose={() => setDialog(false)} title="Dialog title">
        <p className="dim">Native modal dialog: focus is trapped, Escape and the backdrop close it, focus returns to the opener.</p>
        <div className="row kit-gap">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setDialog(false)}>
            Confirm
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
      <Popover open={pop} onClose={() => setPop(false)} anchor={anchor} label="Example popover">
        <p className="popover__title">Popover</p>
        <p className="popover__text">Anchored, flips above when there’s no room, closes on Escape or an outside click.</p>
      </Popover>
    </div>
  );
}

function LiveCandles() {
  const markets = useMarkets();
  const symbol = markets.data?.markets.find((m) => m.available)?.symbol ?? null;
  const q = useMarketCandles(symbol, '1h');
  if (!symbol || !q.data) return q.error ? <ErrorNotice error={q.error} what="Candles" compact onRetry={q.refresh} /> : <Loading label="candles" height={280} />;
  if (q.data.candles.length === 0) return <Empty title="No candles for this interval">The venue returned no price history for {symbol}.</Empty>;
  return (
    <>
      <p className="label kit-gap-sm">{symbol}-PERP · 1h · live from the venue</p>
      <CandleChart candles={q.data.candles} label={`${symbol} perp, 1h candles`} height={280} />
    </>
  );
}

export default function Kit() {
  useTitle('Design kit');
  const stats = useStats();
  const activity = useActivity();
  const tokens = useTokens();
  const paper = usePaperMode();
  const [seg, setSeg] = useState<'all' | 'burns' | 'trades'>('all');

  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  const s = stats.data;
  const events = activity.data?.events ?? [];
  const latestOf = (pred: (e: ActivityEvent) => boolean) => events.find(pred) ?? null;
  const realBurn = latestOf((e) => e.kind === 'buyback');
  const realClaim = latestOf((e) => e.kind === 'claim');
  const realTrade = latestOf((e) => e.kind === 'open' || e.kind === 'close' || e.kind === 'reduce' || e.kind === 'stop');
  const someTokens = tokens.data?.tokens.slice(0, 5) ?? [];
  const history = s?.history ?? [];

  return (
    <div className="kit">
      <header className="container kit__head">
        <p className="label">Internal · not linked · noindex</p>
        <h1>Design kit</h1>
        <p className="lead">
          Every Bellwether component in every state, in the current theme. Live blocks read the engine; anything else is marked <StaticTag />. Contract:{' '}
          <code>apps/web/DESIGN.md</code>.
        </p>
        <div className="row kit-gap">
          <ThemeToggle variant="labeled" />
          <SoundToggle />
          <AnnounceToggle />
        </div>
      </header>

      <Section n={1} label="Tokens" title={<>Paper and ink, <Muted>one brass accent.</Muted></>}>
        <Grid>
          <Col span={7}>
            <Spec title="Color" note="Switch themes above; values update live. --brass is fills only, never text.">
              <Swatches />
            </Spec>
          </Col>
          <Col span={5}>
            <Spec title="Motion" note="Struck, not floated.">
              <dl className="kv">
                <div><dt>Press</dt><dd className="num">80ms</dd></div>
                <div><dt>Fast (hover, fades)</dt><dd className="num">120ms ease-out</dd></div>
                <div><dt>UI (entries)</dt><dd className="num">240ms (0.22,1,0.36,1)</dd></div>
                <div><dt>Panels, sheets</dt><dd className="num">420ms (0.32,0.72,0,1)</dd></div>
                <div><dt>Reveal</dt><dd className="num">500ms ease-out, 80ms stagger</dd></div>
                <div><dt>Price flash</dt><dd className="num">600ms</dd></div>
                <div><dt>Bell swing / rings</dt><dd className="num">1400 / 1600ms</dd></div>
                <div><dt>Tape</dt><dd className="num">40 px/s linear</dd></div>
              </dl>
            </Spec>
          </Col>
        </Grid>
        <Spec title="Type" note="Newsreader for display, H1–H2 and figures only; Geist for everything interactive; Geist Mono for data." wide>
          <ul className="type-scale">
            {TYPE_SCALE.map((t) => (
              <li key={t.cls}>
                <span className="label">{t.label}</span>
                <span className={t.cls}>{t.sample}</span>
              </li>
            ))}
            <li>
              <span className="label">Figure · serif 300 · lining tabular</span>
              <span className="fig kit-fig">$16,393.11</span>
            </li>
          </ul>
        </Spec>
      </Section>

      <Section n={2} label="Brand" title="The candle-bell">
        <div className="kit-row">
          <Spec title="Monogram" note="16, 24, 64 (engraved)">
            <div className="row kit-brand">
              <Monogram size={16} />
              <Monogram size={24} />
              <Monogram size={64} />
            </div>
          </Spec>
          <Spec title="Lockup and wordmark">
            <div className="kit-brand-stack">
              <Lockup />
              <Wordmark className="kit-wordmark" />
            </div>
          </Spec>
          <Spec title="Inline glyph" note="0.8–1em, vertical-align −0.12em">
            <p className="h2">
              Every burn rings <BellGlyph className="brass" />
            </p>
          </Spec>
        </div>
      </Section>

      <Section n={3} label="Controls" title="Buttons, links and inputs">
        <Grid>
          <Col span={6}>
            <Spec title="Buttons" note="Primary ink, secondary hairline, tertiary text. Press: translateY(1px) scale(.985), 80ms. No glow.">
              <div className="row">
                <button type="button" className="btn btn--primary">
                  Launch a token
                </button>
                <button type="button" className="btn btn--secondary">
                  Read the docs
                </button>
                <Link to="/app" className="tertiary">
                  <Arrow>Watch the engine live</Arrow>
                </Link>
              </div>
              <div className="row kit-gap">
                <button type="button" className="btn btn--primary btn--lg">
                  Large
                </button>
                <button type="button" className="btn btn--primary btn--sm">
                  Small
                </button>
                <button type="button" className="btn btn--ghost btn--sm">
                  Ghost
                </button>
                <button type="button" className="btn btn--primary btn--sm" disabled>
                  Disabled
                </button>
                <button type="button" className="icon-btn" aria-label="Copy">
                  <Icon name="copy" />
                </button>
                <button type="button" className="icon-btn icon-btn--sm" aria-label="Close">
                  <Icon name="close" size={14} />
                </button>
              </div>
            </Spec>
            <Spec title="Segmented and toggles">
              <div className="row">
                <Segmented
                  label="Activity filter"
                  value={seg}
                  onChange={setSeg}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'burns', label: 'Burns' },
                    { value: 'trades', label: 'Trades' },
                  ]}
                />
                <Segmented label="Small segmented" size="sm" value={seg} onChange={setSeg} options={[{ value: 'all', label: 'All' }, { value: 'burns', label: 'Burns' }]} />
              </div>
              <div className="row kit-gap">
                <ThemeToggle />
                <SoundToggle />
                <AnnounceToggle />
              </div>
            </Spec>
          </Col>
          <Col span={6}>
            <Spec title="Inputs">
              <div className="kit-form">
                <label className="field">
                  <span className="field__label">Token address</span>
                  <input className="input input--mono" placeholder="0x…" />
                  <span className="field__hint">Paste the address from the launchpad.</span>
                </label>
                <label className="field">
                  <span className="field__label">Invalid</span>
                  <input className="input input--mono" defaultValue="0x12" aria-invalid="true" />
                  <span className="field__hint field__hint--error">That isn’t a token address: 0x followed by 40 hex characters.</span>
                </label>
                <label className="field">
                  <span className="field__label">Strategy</span>
                  <select className="select" defaultValue="balanced">
                    {Object.values(STRATEGIES).map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">ETH claimed</span>
                  <input className="range" type="range" min={0.1} max={10} step={0.1} defaultValue={1} />
                </label>
                <label className="check">
                  <input type="checkbox" defaultChecked /> <span>Wallet on Robinhood Chain</span>
                </label>
              </div>
            </Spec>
          </Col>
        </Grid>
      </Section>

      <Section
        n={4}
        label="Layout"
        title={
          <>
            Sections, rails and rules. <Muted>A two-tone headline drops its continuation to ink-3.</Muted>
          </>
        }
        lede="12 columns in 1312 px with 24 px gutters; page rails at the container edges; sections separated by space and one hairline."
        aside={<Link to="/docs" className="tertiary"><Arrow>Section aside</Arrow></Link>}
      >
        <Grid className="kit-grid">
          <Col span={7}>
            <div className="kit-col">7 columns</div>
          </Col>
          <Col span={5}>
            <div className="kit-col">5 columns</div>
          </Col>
          <Col span={4}>
            <div className="kit-col">4</div>
          </Col>
          <Col span={4}>
            <div className="kit-col">4</div>
          </Col>
          <Col span={4}>
            <div className="kit-col">4</div>
          </Col>
        </Grid>
        <Rule className="kit-gap" />
        <Rule strong className="kit-gap" />
        <div className="kit-row kit-gap">
          <Reveal className="kit-col">Reveal 0 ms</Reveal>
          <Reveal className="kit-col" delay={80}>
            Reveal 80 ms
          </Reveal>
          <Reveal className="kit-col" delay={160}>
            Reveal 160 ms
          </Reveal>
        </div>
      </Section>

      <Section n={5} label="Status" title="Dots, sessions, glossary">
        <Grid>
          <Col span={6}>
            <Spec title="StatusDot" note="Dot + text, never a pill. Only non-default states.">
              <div className="row">
                <StatusDot tone="live">Live</StatusDot>
                <StatusDot tone="pending">Reconnecting…</StatusDot>
                <StatusDot tone="offline">Offline</StatusDot>
                <StatusDot tone="idle">Waiting</StatusDot>
              </div>
            </Spec>
            <Spec title="Engine (live)">
              <div className="stack">
                <EngineIndicator />
                <EngineStatusBar />
              </div>
            </Spec>
            <Spec title="Session line (live)" note="Engine session with the client clock as fallback; the button opens what each strategy does now.">
              <div className="row">
                <SessionLine />
                <SessionLine compact />
              </div>
            </Spec>
          </Col>
          <Col span={6}>
            <Spec title="Term" note="Dotted underline; definition on hover or focus, 120 ms.">
              <p>
                The <Term id="mark">mark price</Term> sets your <Term id="liquidation">liquidation price</Term> at a given <Term id="leverage">leverage</Term>. Each{' '}
                <Term id="buyback">buyback</Term> sends tokens to the <Term id="burnAddress">burn address</Term>; in <Term id="paper">paper mode</Term> it’s simulated. Strategies enter by{' '}
                <Term id="session">session</Term> and <Term id="signal">signal</Term> on a <Term id="perp">perp</Term>; <Term id="funding">funding</Term> is paid hourly.
              </p>
            </Spec>
            <Spec title="Badges (dot + text)">
              <div className="row">
                <StatusPill status="pending" />
                <StatusPill status="paused" />
                <StatusPill status="rejected" />
                <VerdictPill verdict="in-position" />
                <VerdictPill verdict="waiting-session" />
                <StagePill stage="tp1" />
              </div>
              <div className="row kit-gap">
                <BiasChip signal={{ score: 55, bias: 'long' }} />
                <BiasChip signal={{ score: -3, bias: 'wait' }} />
                <Pill>Neutral</Pill>
                <Pill tone="brass">Default</Pill>
                <Pill tone="down">Drift</Pill>
                <span>
                  0.0019 ETH<span className="paper-tag">PAPER</span>
                </span>
                <span>
                  Footnote<Fn id="leverage" />
                </span>
              </div>
            </Spec>
          </Col>
        </Grid>
      </Section>

      <Section n={6} label="Figures" title={<>Ledger figures. <Muted>Exact, rolling, sourced.</Muted></>}>
        <p className="label kit-gap-sm">Live</p>
        <FigureRow label="Live engine figures">
          <Figure label="Burned (USD at burn)" value={s?.burnedUsd} kind="usd" asOf={stats.updatedAt} status={figureStatus(stats)} source={{ label: 'Proof', to: '/proof' }} paper={paper} onRetry={stats.refresh} />
          <Figure label="Fees claimed" value={s?.feesClaimedEth} kind="eth" unit="ETH" asOf={stats.updatedAt} status={figureStatus(stats)} source={{ label: 'Proof', to: '/proof' }} paper={paper} />
          <Figure label="Buybacks" value={s?.buybackCount} kind="int" asOf={stats.updatedAt} status={figureStatus(stats)} />
          <Figure label="Tokens live" value={s?.tokensActive} kind="int" asOf={stats.updatedAt} status={figureStatus(stats)} sub={s && s.tokensPending > 0 ? `+${s.tokensPending} pending review` : undefined} />
        </FigureRow>
        <p className="label kit-gap">
          States <StaticTag />
        </p>
        <FigureRow label="Figure states">
          <Figure label="Loading" value={null} status="loading" />
          <Figure label="Stale (reconnecting)" value={16393.11} kind="usd" asOf={Date.parse('2026-09-27T18:03:12Z')} status="stale" />
          <Figure label="Offline" value={6.089} kind="eth" unit="ETH" asOf={Date.parse('2026-09-27T18:02:00Z')} status="offline" onRetry={() => undefined} />
          <Figure label="Paper amount" value={0.2931} kind="eth" unit="ETH" paper asOf={Date.parse('2026-09-27T18:03:12Z')} source={{ label: 'Proof', to: '/proof' }} />
        </FigureRow>
        <FigureRow label="Large figure">
          <Figure size="lg" label="Share of $EXAMPLE supply burned (static)" value={0.0729} kind="pct" sub="72.9M tokens · 0.7688 ETH spent on buybacks" asOf={Date.parse('2026-09-27T18:03:12Z')} />
        </FigureRow>
        <Grid className="kit-gap">
          <Col span={6}>
            <Spec title="Sparkline (live)" note="Renders only with ≥ 7 non-zero days; otherwise the fallback text.">
              <Sparkline values={history.map((h) => h.buybackEth)} tone="brass" stepped label="ETH spent on buybacks per day, last 30 days" />
            </Spec>
          </Col>
          <Col span={6}>
            <Spec title="Sparkline tones" note={<StaticTag />}>
              <div className="kit-sparks">
                <Sparkline values={STATIC_SERIES} tone="brass" stepped label="Static example, stepped brass" />
                <Sparkline values={STATIC_SERIES} tone="ink" label="Static example, ink" />
                <Sparkline values={STATIC_SERIES} tone="up" label="Static example, up" />
                <Sparkline values={[...STATIC_SERIES].reverse()} tone="down" label="Static example, down" />
              </div>
            </Spec>
          </Col>
        </Grid>
      </Section>

      <Section n={7} label="The Bell" title={<>The bell rings <Muted>only when the engine burns.</Muted></>}>
        <Grid>
          <Col span={5}>
            <p className="label kit-gap-sm">Live</p>
            <Bell settle />
          </Col>
          <Col span={7}>
            <BellStates />
          </Col>
        </Grid>
      </Section>

      <section className="section kit-tape" aria-label="The tape">
        <div className="container">
          <p className="label section__label">
            <span className="section__n">§8</span>The tape
          </p>
          <p className="label kit-gap-sm">Live</p>
        </div>
        <Tape />
        <div className="container">
          <p className="label kit-gap">
            Reduced motion: static scrollable list <StaticTag />
          </p>
        </div>
        <TapeView events={[STATIC_PAPER_BURN, ...events]} paper={paper} still label="Tape example, reduced motion" />
        <div className="container">
          <p className="label kit-gap">Loading</p>
        </div>
        <TapeView events={undefined} paper={paper} label="Tape example, loading" />
        <div className="container">
          <p className="label kit-gap">Offline</p>
        </div>
        <TapeView events={undefined} paper={paper} offline label="Tape example, offline" />
        <div className="container">
          <p className="label kit-gap">Empty</p>
        </div>
        <TapeView events={[]} paper={paper} label="Tape example, empty" />
      </section>

      <Section n={9} label="Receipts" title="Every step, with a receipt">
        <div className="kit-row kit-row--receipts">
          {realBurn && <Receipt event={realBurn} paper={paper} />}
          {realClaim && <Receipt event={realClaim} paper={paper} />}
          {realTrade && <Receipt event={realTrade} paper={paper} />}
          <div>
            <Receipt event={STATIC_PAPER_BURN} paper />
            <StaticTag />
          </div>
        </div>
        <div className="row kit-gap">
          {events[0] && (
            <ReceiptTrigger event={events[0]} paper={paper} className="btn btn--secondary btn--sm">
              Open the latest receipt (live)
            </ReceiptTrigger>
          )}
          {!realBurn && <p className="muted small">No burn yet on this engine; the inline receipts above show whatever real events exist.</p>}
        </div>
      </Section>

      <Section n={10} label="The board" title="Markets, typeset like a stock table">
        <p className="label kit-gap-sm">Live</p>
        <Board />
        <p className="label kit-gap">
          Signals and flashes <StaticTag />
        </p>
        <BoardView data={STATIC_MARKETS} status="live" caption={false} />
        <p className="label kit-gap">Loading</p>
        <BoardView data={undefined} status="loading" limit={3} caption={false} />
        <p className="label kit-gap">Offline</p>
        <BoardView data={undefined} status="offline" limit={3} caption={false} />
      </Section>

      <Section n={11} label="Tokens" title="Medallions">
        <div className="kit-row">
          {someTokens.map((t) => (
            <div key={t.address} className="kit-medal">
              <Medallion image={t.image} symbol={t.symbol} address={t.address} size={72} />
              <div className="row">
                <Medallion image={t.image} symbol={t.symbol} address={t.address} size={48} />
                <Medallion image={t.image} symbol={t.symbol} address={t.address} size={32} />
                <Medallion image={t.image} symbol={t.symbol} address={t.address} size={20} />
              </div>
              <span className="num small">${t.symbol}</span>
            </div>
          ))}
          {someTokens.length === 0 && (tokens.error ? <ErrorNotice error={tokens.error} what="Tokens" compact /> : <Loading label="tokens" height={72} />)}
        </div>
      </Section>

      <Section n={12} label="Charts" title="Candles in theme colors">
        <LiveCandles />
      </Section>

      <Section n={13} label="States" title="Loading, empty, stale, offline, error">
        <Grid>
          <Col span={6}>
            <Spec title="Loading">
              <Loading label="example" height={16} count={3} />
            </Spec>
            <Spec title="Stale">
              <StaleNote stale updatedAt={Date.parse('2026-09-27T18:02:00Z')} />
            </Spec>
            <Spec title="Empty">
              <Empty title="No open positions." action={<Link to="/launch" className="btn btn--primary btn--sm">Launch a token</Link>}>
                Next possible entry: Monday 09:30 ET for Steady; Balanced waits for a signal of 50.
              </Empty>
            </Spec>
          </Col>
          <Col span={6}>
            <Spec title="Error (offline)">
              <ErrorNotice error={OFFLINE_ERROR} what="Positions" onRetry={() => undefined} />
            </Spec>
            <Spec title="Error (4xx)">
              <ErrorNotice error={INVALID_ERROR} what="Token" onRetry={() => undefined} />
            </Spec>
            <Spec title="Whole page offline">
              <EngineDark>
                <button type="button" className="btn btn--secondary btn--sm">
                  <Icon name="refresh" /> Retry
                </button>
              </EngineDark>
            </Spec>
          </Col>
        </Grid>
      </Section>

      <Section n={14} label="Overlays" title="Dialog, sheet, popover, toast">
        <Overlays />
        <p className="small muted kit-gap">The mobile menu sheet is the header’s menu button below 980 px.</p>
      </Section>
    </div>
  );
}
