import {
  BRAND,
  BURN_ADDRESS,
  CHAINS,
  FEE_SPLIT_BURN_ONLY,
  FEE_SPLIT_TRADING,
  LAUNCHPAD_IDS,
  LAUNCHPADS,
  PROFIT_SPLIT,
  STOCK_MARKETS,
  STRATEGIES,
  STRATEGY_IDS,
} from '@floor/shared';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ExtLink } from '../components/Links';
import { leverageRange, sessionsText } from '../components/StrategyFacts';
import { FAQ, RISKS } from '../content/copy';
import { API_BASE } from '../lib/api';
import { pct, pct0, usd } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { useConfig } from '../lib/queries';
import '../styles/docs.css';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'fee-split', label: 'Fee split' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'exit-ladder', label: 'Exit ladder' },
  { id: 'risk-controls', label: 'Risk controls' },
  { id: 'transparency', label: 'Transparency' },
  { id: 'launch-guide', label: 'Launch guide' },
  { id: 'api', label: 'API reference' },
  { id: 'faq', label: 'FAQ' },
  { id: 'risks', label: 'Risks & disclaimer' },
] as const;

const ROUTES: { method: 'GET' | 'POST'; path: string; returns: string; note: string }[] = [
  { method: 'GET', path: '/health', returns: 'HealthResponse', note: 'Liveness, mode and version.' },
  { method: 'GET', path: '/status', returns: 'StatusResponse', note: 'Mode, kill switch, market session, venues, worker heartbeats, protocol wallet.' },
  { method: 'GET', path: '/stats', returns: 'StatsResponse', note: 'Protocol totals plus 30 days of daily history.' },
  { method: 'GET', path: '/config', returns: 'ConfigResponse', note: 'Protocol wallet, $FLOOR address, auto-approve, minimum collateral, venue leverage cap.' },
  { method: 'GET', path: '/markets', returns: 'MarketsResponse', note: 'Candidate stock markets with venue availability, leverage cap, price and entry signal.' },
  { method: 'GET', path: '/markets/:symbol/candles?interval=5m|15m|1h|1d', returns: 'CandlesResponse', note: 'Underlying perp candles.' },
  { method: 'GET', path: '/tokens', returns: 'TokensResponse', note: 'Active, paused and pending tokens.' },
  { method: 'GET', path: '/tokens/:address', returns: 'TokenDetailResponse', note: 'One token incl. rejected/retired: book, decision, position, trades, activity.' },
  { method: 'GET', path: '/tokens/:address/verify?launchpad=', returns: 'VerifyResponse', note: 'Dry-run registration checks.' },
  { method: 'POST', path: '/tokens', returns: 'RegisterResponse', note: 'Register a token. Body: RegisterRequest.' },
  { method: 'GET', path: '/tokens/:address/candles?interval=', returns: 'TokenCandlesResponse', note: 'Token DEX candles (empty before graduation).' },
  { method: 'GET', path: '/tokens/:address/settings/challenge', returns: 'SettingsChallenge', note: 'Message for the deployer to personal_sign.' },
  { method: 'POST', path: '/tokens/:address/settings', returns: 'TokenSummary', note: 'Change strategy, market or leverage. Body: SettingsUpdateRequest.' },
  { method: 'GET', path: '/positions', returns: 'PositionsResponse', note: 'Open positions with per-token shares.' },
  { method: 'GET', path: '/trades?limit=', returns: 'TradesResponse', note: 'Recent trades (default 50, max 200).' },
  { method: 'GET', path: '/activity?before=&limit=&token=', returns: 'ActivityResponse', note: 'Unified event log, paged by `before`.' },
  { method: 'GET', path: '/leaderboard?by=burned|pnl|fees', returns: 'LeaderboardResponse', note: 'Ranked tokens.' },
  { method: 'GET', path: '/proof', returns: 'ProofResponse', note: 'Wallet balances, ledger accounts, reconciliation.' },
  { method: 'GET', path: '/stream', returns: 'StreamEvent (SSE)', note: 'Server-sent events: activity, stats, positions, status.' },
];

function useActiveSection(): string {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: '-80px 0px -65% 0px' },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);
  return active;
}

/** Underlying price moves in the exit ladder are sub-percent, so they keep one decimal. */
const move = (n: number) => pct(n, { digits: 1 });

export default function Docs() {
  useTitle('Docs');
  const active = useActiveSection();
  const { hash } = useLocation();
  const config = useConfig().data;
  const ladder = STRATEGIES.balanced.exits;

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <div className="container page docs">
      <header className="page-head">
        <div>
          <p className="page-head__eyebrow">Docs</p>
          <h1>How {BRAND.name} works</h1>
          <p>Everything the engine does, with the exact numbers it uses. Numbers on this page come from the same code the engine runs.</p>
        </div>
      </header>

      <div className="docs__grid">
        <nav className="toc" aria-label="On this page">
          <p className="panel-label">On this page</p>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} aria-current={active === s.id ? 'location' : undefined}>
                  {s.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="prose">
          <section id="overview">
            <h2>Overview</h2>
            <p>
              {BRAND.name} gives memecoins a trading floor. Tokens launched on {CHAINS.rhc.name} launchpads set their creator-fee recipient to the {BRAND.name} protocol wallet. The {BRAND.name} engine — an off-chain program —
              claims those fees, burns part of them immediately, and trades the rest as leveraged US-stock perpetuals. Realized profit is used to buy back and burn more.
            </p>
            <p>
              Two tokens benefit: the memecoin that generated the fees, and ${BRAND.ticker}, the protocol token. Burned tokens always go to <code className="break">{BURN_ADDRESS}</code>.
            </p>
          </section>

          <section id="how-it-works">
            <h2>How it works</h2>
            <ol>
              <li>
                <strong>Claim.</strong> The claimer worker collects accrued creator fees (ETH) from each registered token’s launchpad on {CHAINS.rhc.name}.
              </li>
              <li>
                <strong>Split.</strong> Each claim is split exactly (integer wei math; rounding dust goes to the token burn) into the trading book, the token burn budget and the ${BRAND.ticker} burn budget.
              </li>
              <li>
                <strong>Burn.</strong> The buyback worker swaps burn budgets for tokens on Uniswap V3 on {CHAINS.rhc.name} and sends them to the burn address.
              </li>
              <li>
                <strong>Fund.</strong> The treasury worker bridges the trading share to USDC on {CHAINS.arbitrum.name} and into Hyperliquid.
              </li>
              <li>
                <strong>Trade.</strong> The trader opens a long perp on the token’s chosen stock when the strategy’s session and entry signal allow it. Positions are pooled per market; each token owns a share.
              </li>
              <li>
                <strong>Guard.</strong> The guardian manages stops, the exit ladder and liquidation buffers every cycle, in every session.
              </li>
              <li>
                <strong>Recycle profit.</strong> Realized profit is split {pct0(PROFIT_SPLIT.tokenBuyback)} / {pct0(PROFIT_SPLIT.floorBuyback)} into token and ${BRAND.ticker} burns. Returned collateral stays in the book.
              </li>
              <li>
                <strong>Reconcile.</strong> The reconciler compares the ledger with real on-chain and venue balances and publishes the result.
              </li>
            </ol>
          </section>

          <section id="fee-split">
            <h2>Fee split</h2>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">How claimed fees are split</caption>
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
                      ${BRAND.ticker} burn
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Fees · trading strategies</th>
                    <td className="r num">{pct0(FEE_SPLIT_TRADING.trading)}</td>
                    <td className="r num">{pct0(FEE_SPLIT_TRADING.tokenBuyback)}</td>
                    <td className="r num">{pct0(FEE_SPLIT_TRADING.floorBuyback)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Fees · Burn only</th>
                    <td className="r num">{pct0(FEE_SPLIT_BURN_ONLY.trading)}</td>
                    <td className="r num">{pct0(FEE_SPLIT_BURN_ONLY.tokenBuyback)}</td>
                    <td className="r num">{pct0(FEE_SPLIT_BURN_ONLY.floorBuyback)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Realized trading profit</th>
                    <td className="r num">—</td>
                    <td className="r num">{pct0(PROFIT_SPLIT.tokenBuyback)}</td>
                    <td className="r num">{pct0(PROFIT_SPLIT.floorBuyback)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Because {pct0(FEE_SPLIT_TRADING.tokenBuyback + FEE_SPLIT_TRADING.floorBuyback)} of every fee is burned at claim time, the floor rises even if trading loses. Losses only ever come out of the trading book.
            </p>
          </section>

          <section id="strategies">
            <h2>Strategies</h2>
            <p>Each token picks one. The deployer can change it later from the token page by signing a message.</p>
            <div className="table-wrap">
              <table className="table table--stack">
                <caption className="sr-only">Strategy parameters</caption>
                <thead>
                  <tr>
                    <th scope="col">Strategy</th>
                    <th scope="col">Leverage</th>
                    <th scope="col">New entries</th>
                    <th scope="col" className="r">
                      Hard stop
                    </th>
                    <th scope="col" className="r">
                      Daily loss halt
                    </th>
                    <th scope="col" className="r">
                      Extra signal needed
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
                        </th>
                        <td data-label="Leverage" className="num">
                          {leverageRange(s)}
                        </td>
                        <td data-label="New entries">{sessionsText(s)}</td>
                        <td data-label="Hard stop" className="r num">
                          {s.trades ? `${pct0(s.stopLoss)} of collateral` : '—'}
                        </td>
                        <td data-label="Daily loss halt" className="r num">
                          {s.trades ? `${pct0(s.dailyLossLimit)} of budget` : '—'}
                        </td>
                        <td data-label="Extra signal needed" className="r num">
                          {s.trades ? `+${s.entryThresholdBonus}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p>
              The leverage a token actually gets is the lowest of its own cap, its strategy’s maximum and the venue’s limit for that market
              {config ? ` (currently at most ${config.venueMaxLeverage}× on the venue)` : ''}. Exits and stops run in every session regardless of strategy.
            </p>
          </section>

          <section id="exit-ladder">
            <h2>Exit ladder</h2>
            <p>Every position follows the same ladder, measured as a move in the underlying stock price:</p>
            <ol>
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
                After that, the rest trails: it closes when price pulls back <span className="num">{move(ladder.trailPullback)}</span> from the best price seen.
              </li>
            </ol>
            <p>With leverage, a {move(ladder.tp1Move)} stock move is a much larger move in collateral — at 10× it is about {pct0(ladder.tp1Move * 10)}.</p>
          </section>

          <section id="risk-controls">
            <h2>Risk controls</h2>
            <dl className="defs">
              <dt>Kill switch</dt>
              <dd>A global switch the operator can flip. While on, no new positions and no buybacks; exits and stops keep running. It is shown in a banner on every page.</dd>
              <dt>Hard stop</dt>
              <dd>Each position closes when its loss reaches the strategy’s stop as a fraction of collateral.</dd>
              <dt>Daily loss halt</dt>
              <dd>When a token’s realized losses in a UTC day reach its strategy’s limit, it stops opening positions until the next day.</dd>
              <dt>Liquidation buffer</dt>
              <dd>The guardian watches distance to liquidation and reduces or closes positions that get too close, before the venue does.</dd>
              <dt>Caps</dt>
              <dd>
                Leverage is capped by token, strategy and venue. Trading waits until a token’s book holds at least {config ? usd(config.minCollateralUsd) : 'the engine’s minimum'} of collateral, so tiny positions don’t
                bleed fees.
              </dd>
              <dt>Venue pauses</dt>
              <dd>If the venue pauses a market or itself, no new entries are made there. Ostium was dropped after it paused following its July 2026 oracle exploit.</dd>
            </dl>
          </section>

          <section id="transparency">
            <h2>Transparency</h2>
            <p>
              Every action is an event with its transaction references: claims and burns on {CHAINS.rhc.name}, bridges on {CHAINS.arbitrum.name}, orders on {CHAINS.hyperliquid.name}. The{' '}
              <Link to="/proof">Proof page</Link> shows balances, ledger accounts and reconciliation. In paper mode, every transaction reference is labeled “paper” and never links anywhere.
            </p>
          </section>

          <section id="launch-guide">
            <h2>Launch guide</h2>
            <p>
              You need a wallet on {CHAINS.rhc.name} (chain ID {CHAINS.rhc.chainId}) with a little ETH. The <Link to="/launch">launch wizard</Link> walks through this with live checks.
            </p>
            {LAUNCHPAD_IDS.map((id) => {
              const lp = LAUNCHPADS[id];
              return (
                <div key={id} className="docs__lp">
                  <h3>{lp.name}</h3>
                  <ol>
                    <li>
                      Open <ExtLink href={lp.url}>{lp.url.replace(/^https:\/\//, '')}</ExtLink> and start a new token.
                    </li>
                    <li>
                      In <strong>{lp.feeFieldLocation}</strong>, paste the {BRAND.name} protocol wallet into <strong>{lp.feeField}</strong>.
                    </li>
                    <li>Launch{lp.launchFeeEth === null ? ' (gas only)' : ` (${lp.launchFeeEth} ETH fee plus gas)`}.</li>
                    <li>
                      Register the token address on <Link to="/launch?step=4">floor.fun/launch</Link>.
                    </li>
                  </ol>
                </div>
              );
            })}
          </section>

          <section id="api">
            <h2>API reference</h2>
            <p>
              All routes live under <code>{API_BASE}</code> and return JSON. Amounts are plain numbers in the unit named by the field (<code>Eth</code>, <code>Usd</code>, <code>Pct</code> as a fraction). Timestamps are unix
              milliseconds. Errors are non-2xx with <code>{'{ error, code, details? }'}</code>. Types are in <code>@floor/shared</code>.
            </p>
            <ul className="routes">
              {ROUTES.map((r) => (
                <li key={`${r.method} ${r.path}`}>
                  <p className="routes__sig">
                    <span className={`routes__method routes__method--${r.method.toLowerCase()}`}>{r.method}</span>
                    <code>{r.path}</code>
                  </p>
                  <p className="routes__note">
                    <code className="amber">{r.returns}</code> — {r.note}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section id="faq">
            <h2>FAQ</h2>
            {FAQ.map((f) => (
              <div key={f.q} className="docs__qa">
                <h3>{f.q}</h3>
                {f.a}
              </div>
            ))}
          </section>

          <section id="risks">
            <h2>Risks &amp; disclaimer</h2>
            {RISKS.map((r) => (
              <div key={r.title} className="docs__qa">
                <h3>{r.title}</h3>
                <p>{r.body}</p>
              </div>
            ))}
            <p className="docs__disclaimer">
              {BRAND.protocolName} is experimental, unaudited software provided as is. Nothing on this site is an offer, a solicitation or financial advice. You are responsible for complying with the laws that apply to you.
              Markets traded: {STOCK_MARKETS.map((m) => m.symbol).join(', ')}, subject to venue availability.
            </p>
          </section>
        </article>
      </div>
    </div>
  );
}
