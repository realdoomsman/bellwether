import {
  BRAND,
  BURN_ADDRESS,
  CHAINS,
  DEFAULT_STRATEGY,
  FEE_SPLIT_BURN_ONLY,
  FEE_SPLIT_TRADING,
  LAUNCHPAD_IDS,
  LAUNCHPADS,
  PROFIT_SPLIT,
  STOCK_MARKETS,
  STRATEGIES,
  STRATEGY_IDS,
  type FeeSplit,
} from '@bellwether/shared';
import { useEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { CopyButton } from '../components/CopyButton';
import { WorkerList } from '../components/EngineStatus';
import { ExtLink } from '../components/Links';
import { Muted } from '../components/Primitives';
import { leverageRange, sessionsText } from '../components/StrategyFacts';
import { GLOSSARY, Term } from '../components/Term';
import { useToast } from '../components/Toast';
import { FAQ, RISKS } from '../content/copy';
import { API_BASE } from '../lib/api';
import { etDateTime, pct, pct0, usd } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { useConfig, useStatus, useTokens } from '../lib/queries';
import { ApiReference } from './docs/ApiReference';
import { ExitLadderDiagram } from './docs/ExitLadder';
import { useScrollSpy } from './docs/useScrollSpy';
import { apiRoot, CodeBlock } from './info/CodeBlock';
import '../styles/docs.css';

const SECTIONS = [
  { id: 'overview', label: 'What it is' },
  { id: 'how-it-works', label: 'How the money moves' },
  { id: 'fee-split', label: 'The fee split' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'exit-ladder', label: 'The exit ladder' },
  { id: 'risk-controls', label: 'Risk controls' },
  { id: 'transparency', label: 'Receipts and proof' },
  { id: 'launch-guide', label: 'Launch guide' },
  { id: 'settings', label: 'Changing settings' },
  { id: 'api', label: 'API reference' },
  { id: 'faq', label: 'Questions' },
  { id: 'glossary', label: 'Glossary' },
  { id: 'risks', label: 'Risks and disclaimer' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];
const SECTION_IDS = SECTIONS.map((s) => s.id);

const TICKER = `$${BRAND.ticker}`;
/** Sub-percent underlying moves keep one decimal. */
const move = (n: number) => pct(n, { digits: 1 });
const BUILT = etDateTime(Date.parse(__BUILD_TIME__));

function cadence(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  return ms < 90_000 ? 'every minute' : `every ${Math.round(ms / 60_000)} minutes`;
}

/** A glossary entry ("Term: definition") split into its term and a capitalized definition. */
function definition(text: string): { term: string; body: string } {
  const cut = text.indexOf(':');
  return { term: text.slice(0, cut), body: text.charAt(cut + 2).toUpperCase() + text.slice(cut + 3) };
}

/** The sticky side contents from 1024px (matches docs.css); a disclosure under the head below that. */
const WIDE = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 1024px)') : null;
function useWide(): boolean {
  return useSyncExternalStore(
    (l) => {
      WIDE?.addEventListener('change', l);
      return () => WIDE?.removeEventListener('change', l);
    },
    () => WIDE?.matches ?? true,
  );
}

/** Numbered section with a copy-link anchor on its heading. */
function Doc({ id, children, title }: { id: SectionId; title: ReactNode; children: ReactNode }) {
  const notify = useToast();
  const n = SECTION_IDS.indexOf(id) + 1;
  return (
    <section id={id} className="doc" aria-labelledby={`${id}-h`}>
      <p className="label doc__n">§{n}</p>
      <h2 id={`${id}-h`} className="doc__h">
        <a
          href={`#${id}`}
          className="doc__anchor"
          aria-label={`Copy link to §${n}`}
          onClick={(e) => {
            e.preventDefault();
            const url = `${window.location.origin}${window.location.pathname}#${id}`;
            history.replaceState(history.state, '', `#${id}`);
            document.getElementById(id)?.scrollIntoView({ block: 'start' });
            navigator.clipboard.writeText(url).then(
              () => notify(`Copied link to §${n}`, 'success'),
              () => notify('Couldn’t reach the clipboard; the link is in the address bar.', 'error'),
            );
          }}
        >
          #
        </a>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Margin note beside the text on wide screens, inline under it otherwise. */
function Side({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside className="side">
      <p className="side__label">{label}</p>
      <div className="side__body">{children}</div>
    </aside>
  );
}

function SplitRow({ split, label }: { split: FeeSplit; label: string }) {
  const parts = [
    { key: 'trade', share: split.trading, text: 'trading book' },
    { key: 'token', share: split.tokenBuyback, text: 'buys back and burns your token' },
    { key: 'bell', share: split.protocolBuyback, text: `buys back and burns ${TICKER}` },
  ].filter((p) => p.share > 0);
  return (
    <div className="split">
      <p className="split__label">{label}</p>
      <div className="split__bar" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} className={`split__seg split__seg--${p.key}`} style={{ '--share': p.share } as CSSProperties} />
        ))}
      </div>
      <ul className="split__legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className={`split__key split__seg--${p.key}`} aria-hidden="true" />
            <span className="num">{p.share.toFixed(2)} ETH</span> {p.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

const EXAMPLE_MESSAGE = [
  `${BRAND.name} settings change`,
  '',
  `Site: ${BRAND.links.site}`,
  `Chain: ${CHAINS.rhc.name} (${CHAINS.rhc.chainId})`,
  'Token: $EXAMPLE 0x…',
  '',
  `Strategy: ${STRATEGIES.steady.label} (steady)`,
  'Market: NVDA',
  'Side: long',
  'Max leverage: 4x',
  '',
  'Nonce: <one-time id>',
  'Expires: <10 minutes from the request, UTC>',
  '',
  `Only sign this on ${BRAND.links.site}. It proves you deployed the token and applies exactly these settings; nothing is sent on-chain.`,
].join('\n');

function Toc({ active, onPick }: { active: string; onPick?: () => void }) {
  return (
    <ol className="toc__list">
      {SECTIONS.map((s) => (
        <li key={s.id}>
          <a href={`#${s.id}`} aria-current={active === s.id ? 'location' : undefined} onClick={onPick}>
            {s.label}
          </a>
        </li>
      ))}
    </ol>
  );
}

export default function Docs() {
  useTitle('Docs');
  const article = useRef<HTMLElement>(null);
  const progress = useRef<HTMLSpanElement>(null);
  const mobileToc = useRef<HTMLDetailsElement>(null);
  const wide = useWide();
  const active = useScrollSpy(SECTION_IDS, article, progress);
  const { hash } = useLocation();
  const config = useConfig().data;
  const status = useStatus().data;
  const sampleToken = useTokens().data?.tokens.find((t) => t.status === 'active')?.address ?? null;
  const ladder = STRATEGIES[DEFAULT_STRATEGY].exits;
  const reconciler = status?.workers.find((w) => w.id === 'reconciler');
  const reconcileEvery = cadence(reconciler?.lastRunAt && reconciler.nextRunAt ? reconciler.nextRunAt - reconciler.lastRunAt : null);
  const wallet = config?.protocolWallet ?? null;

  useEffect(() => {
    if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [hash]);

  return (
    <div className="container docs">
      <header className="docs-head">
        <p className="label">Documentation</p>
        <h1>
          How {BRAND.name} works. <Muted>Every rule, with the number the engine uses.</Muted>
        </h1>
        <p className="lead">
          Figures on this page are imported from <code>@bellwether/shared</code>, the same module the engine runs, so the docs can’t drift from what it does. Live values are marked as such.
        </p>
        <p className="docs-head__meta small">
          <span>Built {BUILT}</span>
          <span aria-hidden="true">·</span>
          <span>{status ? `Engine v${status.version} answering, ${status.mode === 'paper' ? 'paper mode' : 'live'}` : 'Engine status —'}</span>
        </p>
      </header>

      {!wide && (
        <details ref={mobileToc} className="toc-m">
          <summary>On this page</summary>
          <nav aria-label="On this page">
            <Toc active={active} onPick={() => mobileToc.current?.removeAttribute('open')} />
          </nav>
        </details>
      )}

      <div className="docs__grid">
        {wide && (
          <nav className="toc" aria-label="On this page">
            <p className="label toc__head">On this page</p>
            <div className="toc__body">
              <span className="toc__track" aria-hidden="true">
                <span ref={progress} className="toc__fill" />
              </span>
              <Toc active={active} />
            </div>
          </nav>
        )}

        <article ref={article} className="doc-body">
          <Doc id="overview" title={`What ${BRAND.name} is`}>
            <Side label="The name">
              A bellwether is the stock that leads the market. On this site the bell rings for every buyback and burn, and only for a real one.
            </Side>
            <p>
              {BRAND.name} is a fee engine for memecoins on {CHAINS.rhc.name}. A token launched on {LAUNCHPADS.pons.name} or {LAUNCHPADS.launchhood.name} names the {BRAND.name} protocol wallet as its creator-fee
              recipient. From then on the engine claims the token’s fees, burns a share of every claim at once, and trades the rest as leveraged long <Term id="perp">perps</Term> on a US stock the creator picks.
              When a trade closes in profit, most of the profit buys back and burns the token too.
            </p>
            <p>
              Two tokens gain from every fee: the memecoin that earned it, and {TICKER}. Everything the engine buys back goes to the <Term id="burnAddress">burn address</Term>. Nothing is held in a treasury.
            </p>
          </Doc>

          <Doc id="how-it-works" title="How the money moves">
            <p>The engine is a set of workers that run on a schedule, each doing one job and writing every step to a double-entry ledger.</p>
            <ol className="flow">
              <li>
                <strong>Claim.</strong> The fee claimer collects accrued creator fees from each registered token’s launchpad on {CHAINS.rhc.name}. For {LAUNCHPADS.pons.name} V2 tokens it withdraws the creator
                share from the {LAUNCHPADS.pons.name} fee escrow.
              </li>
              <li>
                <strong>Split.</strong> Each claim is split on the spot, in integer wei, into the trading book, the token’s burn budget and the {TICKER} burn budget (<a href="#fee-split">§3</a>).
              </li>
              <li>
                <strong>Burn.</strong> The buyback worker swaps burn budgets for tokens on Uniswap and sends them to the burn address. Each buyback must first pass price guards on its own price impact and, on V3
                pools, the pool’s time-weighted price. If a guard fails, the budget waits for the next run.
              </li>
              <li>
                <strong>Fund.</strong> The treasury worker bridges trading budgets from {CHAINS.rhc.name} to USDC on {CHAINS.arbitrum.name}, then deposits it on Hyperliquid as collateral.
              </li>
              <li>
                <strong>Trade.</strong> The trader opens a long on the token’s market when its strategy’s session and the entry <Term id="signal">signal</Term> allow. Positions are pooled per market; each token owns
                a share of the collateral and the result.
              </li>
              <li>
                <strong>Guard.</strong> The guardian runs the stops, the exit ladder and the liquidation buffer on every cycle, in every session.
              </li>
              <li>
                <strong>Recycle.</strong> Realized profit is split {pct0(PROFIT_SPLIT.tokenBuyback)} to the token’s burn and {pct0(PROFIT_SPLIT.protocolBuyback)} to {TICKER}’s. Returned collateral stays in the
                token’s book for the next trade.
              </li>
              <li>
                <strong>Reconcile.</strong> The reconciler compares the ledger with real balances{reconcileEvery ? ` ${reconcileEvery}` : ''} and publishes the result on <Link to="/proof">Proof</Link>.
              </li>
            </ol>
            <h3 className="doc__h3">The workers, right now</h3>
            <p className="small muted">Live from the engine’s status. Times are relative; hover a last run for the ET time.</p>
            {status ? <WorkerList status={status} /> : <p className="muted small">Connecting to the engine…</p>}
          </Doc>

          <Doc id="fee-split" title="The fee split">
            <Side label="Exact to the wei">
              Splits are computed in basis points on integer wei, so the parts always add up to the claim. Rounding dust goes to the token’s burn.
            </Side>
            <p>Every claimed fee is divided the moment it lands. The split depends only on whether the token’s strategy trades.</p>
            <SplitRow split={FEE_SPLIT_TRADING} label="Of every 1 ETH claimed, trading strategies" />
            <SplitRow split={FEE_SPLIT_BURN_ONLY} label={`Of every 1 ETH claimed, ${STRATEGIES.burn.label}`} />
            <div className="table-wrap">
              <table className="table table--stack">
                <caption className="sr-only">How claimed fees and realized profit are split</caption>
                <thead>
                  <tr>
                    <th scope="col">Applies to</th>
                    <th scope="col" className="r">
                      Trading book
                    </th>
                    <th scope="col" className="r">
                      Token burn
                    </th>
                    <th scope="col" className="r">
                      {TICKER} burn
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" data-label="">Fees, trading strategies</th>
                    <td data-label="Trading book" className="r num">{pct0(FEE_SPLIT_TRADING.trading)}</td>
                    <td data-label="Token burn" className="r num">{pct0(FEE_SPLIT_TRADING.tokenBuyback)}</td>
                    <td data-label={`${TICKER} burn`} className="r num">{pct0(FEE_SPLIT_TRADING.protocolBuyback)}</td>
                  </tr>
                  <tr>
                    <th scope="row" data-label="">Fees, {STRATEGIES.burn.label}</th>
                    <td data-label="Trading book" className="r num">{pct0(FEE_SPLIT_BURN_ONLY.trading)}</td>
                    <td data-label="Token burn" className="r num">{pct0(FEE_SPLIT_BURN_ONLY.tokenBuyback)}</td>
                    <td data-label={`${TICKER} burn`} className="r num">{pct0(FEE_SPLIT_BURN_ONLY.protocolBuyback)}</td>
                  </tr>
                  <tr>
                    <th scope="row" data-label="">Realized trading profit</th>
                    <td data-label="Trading book" className="r num">—</td>
                    <td data-label="Token burn" className="r num">{pct0(PROFIT_SPLIT.tokenBuyback)}</td>
                    <td data-label={`${TICKER} burn`} className="r num">{pct0(PROFIT_SPLIT.protocolBuyback)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Because {pct0(FEE_SPLIT_TRADING.tokenBuyback + FEE_SPLIT_TRADING.protocolBuyback)} of every fee is burned at claim time, supply goes down with every claim even if every trade loses. Losses only ever
              come out of the trading book.
            </p>
          </Doc>

          <Doc id="strategies" title="Strategies">
            <p>Each token runs one strategy. The deployer picks it at launch and can change it later by signing a message (<a href="#settings">§9</a>).</p>
            <div className="table-wrap">
              <table className="table table--stack">
                <caption className="sr-only">Strategy parameters</caption>
                <thead>
                  <tr>
                    <th scope="col">Strategy</th>
                    <th scope="col">
                      <Term id="leverage">Leverage</Term>
                    </th>
                    <th scope="col">New entries</th>
                    <th scope="col" className="r">
                      Hard stop <span className="th-unit">(collateral)</span>
                    </th>
                    <th scope="col" className="r">
                      Daily loss halt <span className="th-unit">(budget)</span>
                    </th>
                    <th scope="col" className="r">
                      Extra signal
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {STRATEGY_IDS.map((id) => {
                    const s = STRATEGIES[id];
                    return (
                      <tr key={id}>
                        <th scope="row" data-label="">
                          {s.label}
                          {id === DEFAULT_STRATEGY && <span className="muted small"> · default</span>}
                        </th>
                        <td data-label="Leverage" className="num">
                          {s.trades ? leverageRange(s) : '—'}
                        </td>
                        <td data-label="New entries">{sessionsText(s)}</td>
                        <td data-label="Hard stop (collateral)" className="r num">
                          {s.trades ? pct0(s.stopLoss) : '—'}
                        </td>
                        <td data-label="Daily loss halt (budget)" className="r num">
                          {s.trades ? pct0(s.dailyLossLimit) : '—'}
                        </td>
                        <td data-label="Extra signal" className="r num">
                          {s.trades ? `+${s.entryThresholdBonus}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p>
              A token gets the lowest of three caps: its own maximum leverage, its strategy’s maximum, and the venue’s limit for that market
              {config ? <>, which is at most <span className="num">{config.venueMaxLeverage}×</span> on the venue right now</> : ''}. “Extra signal” is added to the engine’s base entry threshold, so higher means
              pickier entries. Stops and exits run in every session whatever the strategy.
            </p>
          </Doc>

          <Doc id="exit-ladder" title="The exit ladder">
            <p>Every position follows the same ladder, measured as a move in the underlying stock’s price:</p>
            <ExitLadderDiagram ladder={ladder} />
            <ol className="flow flow--plain">
              <li>
                At <span className="num">+{move(ladder.breakevenArmMove)}</span> the stop moves to breakeven.
              </li>
              <li>
                At <span className="num">+{move(ladder.tp1Move)}</span> it takes profit on <span className="num">{pct0(ladder.tp1Fraction)}</span> of the position.
              </li>
              <li>
                At <span className="num">+{move(ladder.tp2Move)}</span> it takes profit on <span className="num">{pct0(ladder.tp2Fraction)}</span> of what remains.
              </li>
              <li>
                The rest trails: it closes when the price pulls back <span className="num">{move(ladder.trailPullback)}</span> from the best price seen.
              </li>
            </ol>
            <p>
              Leverage multiplies these moves. At 10×, a <span className="num">{move(ladder.tp1Move)}</span> move in the stock is about <span className="num">{pct0(ladder.tp1Move * 10)}</span> on collateral.
            </p>
          </Doc>

          <Doc id="risk-controls" title="Risk controls">
            <dl className="defs">
              <div>
                <dt>Kill switch</dt>
                <dd>
                  A global switch the operator can flip. While it’s on, no new positions open and no buybacks run; exits and stops keep working.{' '}
                  {status && <span className="live-val">Right now: {status.killSwitch ? 'on' : 'off'}.</span>}
                </dd>
              </div>
              <div>
                <dt>Hard stop</dt>
                <dd>A position closes when its loss reaches the strategy’s stop, measured on collateral.</dd>
              </div>
              <div>
                <dt>Daily loss halt</dt>
                <dd>When a token’s realized losses in a UTC day reach its strategy’s limit, it opens nothing new until the next day.</dd>
              </div>
              <div>
                <dt>Liquidation buffer</dt>
                <dd>
                  The guardian watches the distance to the <Term id="liquidation">liquidation price</Term> and reduces or closes positions that get too close, before the venue does it for us.
                </dd>
              </div>
              <div>
                <dt>Minimum collateral</dt>
                <dd>
                  A token doesn’t trade until its book holds at least {config ? <span className="num">{usd(config.minCollateralUsd)}</span> : 'the engine’s minimum'}, so tiny positions don’t bleed fees.
                </dd>
              </div>
              <div>
                <dt>Venue pauses</dt>
                <dd>If a venue pauses a market or itself, no new entries go there. Ostium was dropped after it paused its markets following an oracle exploit in July 2026.</dd>
              </div>
            </dl>
          </Doc>

          <Doc id="transparency" title="Receipts and proof">
            <Side label="Paper mode">{definition(GLOSSARY.paper).body}</Side>
            <p>
              Every action is an event with its transaction references: claims and burns on {CHAINS.rhc.name}, bridges on {CHAINS.arbitrum.name}, orders on {CHAINS.hyperliquid.name}. Each burn on the site opens a
              receipt with the amounts, the venue, the time in ET and the transactions.
            </p>
            <p>
              The <Link to="/proof">Proof page</Link> shows the wallet’s balances on every chain, every ledger account, and the latest reconciliation of the two. The same data is at{' '}
              <ExtLink href={`${API_BASE}/proof`}>{`${API_BASE}/proof`}</ExtLink>. In paper mode, transaction references start with <code>paper:</code> and never link anywhere.
            </p>
          </Doc>

          <Doc id="launch-guide" title="Launch guide">
            <p>
              You need a wallet on {CHAINS.rhc.name} (chain ID <span className="num">{CHAINS.rhc.chainId}</span>) with a little ETH for gas. The <Link to="/launch">launch wizard</Link> walks through the same steps
              with live checks.
            </p>
            <div className="wallet-line">
              <p className="label">Fee recipient to paste</p>
              {wallet ? (
                <p className="wallet-line__addr num">
                  <span className="break">{wallet}</span>
                  <CopyButton text={wallet} what="protocol wallet" iconOnly className="icon-btn icon-btn--sm" />
                </p>
              ) : (
                <p className="muted small">{config ? 'Not configured yet: launching is paused until the operator sets it.' : 'Connecting to the engine…'}</p>
              )}
            </div>
            {LAUNCHPAD_IDS.map((id) => {
              const lp = LAUNCHPADS[id];
              return (
                <div key={id} className="pad">
                  <h3 className="doc__h3">{id === 'pons' ? `${lp.name} (V2)` : lp.name}</h3>
                  <ol className="flow flow--plain">
                    <li>
                      Open <ExtLink href={lp.url}>{lp.url.replace(/^https:\/\/(www\.)?/, '')}</ExtLink> and start a new token.
                    </li>
                    <li>
                      Under <strong>{lp.feeFieldLocation}</strong>, paste the protocol wallet into <strong>{lp.feeField}</strong>.
                    </li>
                    {lp.requirements.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                    <li>Launch. {lp.launchFeeEth === null ? 'You pay gas only.' : <>The launchpad charges <span className="num">{lp.launchFeeEth} ETH</span> plus gas.</>}</li>
                    <li>
                      Register the token address at <Link to="/launch">{BRAND.domain}/launch</Link>.
                    </li>
                  </ol>
                  {id === 'pons' && (
                    <p className="small dim">
                      How {lp.name} V2 pays: fees build up on the token’s bonding curve, then on the Uniswap V4 hook once the token graduates. {lp.name} credits the creator’s share to its fee escrow, and the engine
                      withdraws it from there. {lp.name} V2 only pays ETH creator fees for ETH-paired launches, which is why the paired asset must stay ETH.
                    </p>
                  )}
                  {lp.caveats.length > 0 && (
                    <ul className="caveats">
                      {lp.caveats.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            <h3 className="doc__h3">What registration checks</h3>
            <ol className="flow flow--plain">
              <li>The address is a token contract on {CHAINS.rhc.name}.</li>
              <li>The launchpad you named actually launched it.</li>
              <li>Its creator-fee recipient is the protocol wallet.</li>
              <li>
                It doesn’t impersonate {BRAND.name} or {TICKER}.
              </li>
              <li>It isn’t registered already.</li>
            </ol>
            <p>
              {config ? (config.autoApprove ? 'Right now, tokens that pass go live immediately.' : 'Right now, tokens that pass wait for operator review before they trade.') : ''} Forgot to register? The engine also
              scans the chain for launches that name its wallet and registers them on the default strategy, {STRATEGIES[DEFAULT_STRATEGY].label}. The deployer can change that afterwards.
            </p>
          </Doc>

          <Doc id="settings" title="Changing settings">
            <Side label="Why a signature">
              The message names the site, so a look-alike site can’t reuse your signature. It names every setting, so it can’t be redeemed for different ones. It works once and expires after ten minutes.
            </Side>
            <p>Only the wallet that deployed the token can change its strategy, market or maximum leverage. It takes one signature and no gas.</p>
            <ol className="flow flow--plain">
              <li>On the token’s page, connect the deploying wallet and choose the new settings.</li>
              <li>
                The site asks the engine for a challenge (<code>POST /api/tokens/:address/settings/challenge</code> with the complete settings). The engine checks them and returns the exact message to sign.
              </li>
              <li>Your wallet shows that message. Read it, then sign (EIP-191 personal_sign). Nothing is sent on-chain.</li>
              <li>
                The site sends the ticket and signature back (<code>POST /api/tokens/:address/settings</code> with <code>{'{ nonce, signature }'}</code>). The engine checks the signer is the deployer, applies exactly
                those settings, and logs the change in the token’s activity.
              </li>
            </ol>
            <CodeBlock label="What you sign (example; your wallet shows the real token, nonce and expiry)" what="example message" code={EXAMPLE_MESSAGE} wrap />
          </Doc>

          <Doc id="api" title="API reference">
            <p>
              Every route lives under <code>{API_BASE}</code> and returns JSON. Amounts are plain numbers in the unit the field names (<code>…Eth</code>, <code>…Usd</code>, and <code>…Pct</code> as a fraction).
              Timestamps are unix milliseconds. Errors are non-2xx with <code>{'{ error, code, details? }'}</code>. Types live in <code>@bellwether/shared</code>.
            </p>
            <CodeBlock label="Try it" lang="shell" code={`curl -s ${apiRoot(API_BASE)}/stats | jq`} wrap />
            <ApiReference sampleToken={sampleToken} />
          </Doc>

          <Doc id="faq" title="Questions">
            <div className="qa">
              {FAQ.map((f) => (
                <div key={f.id} id={`faq-${f.id}`} className="qa__item">
                  <h3 className="qa__q">{f.q}</h3>
                  {f.a}
                </div>
              ))}
            </div>
          </Doc>

          <Doc id="glossary" title="Glossary">
            <dl className="defs">
              {Object.entries(GLOSSARY).map(([key, text]) => {
                const { term, body } = definition(text);
                return (
                  <div key={key}>
                    <dt>{term}</dt>
                    <dd>{body}</dd>
                  </div>
                );
              })}
            </dl>
          </Doc>

          <Doc id="risks" title="Risks and disclaimer">
            <div className="qa">
              {RISKS.map((r) => (
                <div key={r.id} id={`risk-${r.id}`} className="qa__item">
                  <h3 className="qa__q">{r.title}</h3>
                  <p>{r.body}</p>
                </div>
              ))}
            </div>
            <p className="disclaimer">
              {BRAND.protocolName} is experimental, unaudited software provided as is. Nothing on this site is an offer, a solicitation or financial advice, and you are responsible for following the laws that apply
              to you. Markets traded: {STOCK_MARKETS.map((m) => m.symbol).join(', ')}, subject to venue availability. Burned tokens go to <code className="break">{BURN_ADDRESS}</code>.
            </p>
          </Doc>
        </article>
      </div>
    </div>
  );
}
