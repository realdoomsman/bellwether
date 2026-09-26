import { BRAND, CHAINS, STRATEGIES, STRATEGY_IDS } from '@stepup/shared';
import { useEffect, type CSSProperties } from 'react';
import { Link, useLocation } from 'react-router';
import { CopyButton } from '../components/CopyButton';
import { Icon } from '../components/Icon';
import { StepLine } from '../components/StepLine';
import { StrategyFacts } from '../components/StrategyFacts';
import { FAQ, RISKS } from '../content/copy';
import { shortAddr } from '../lib/format';
import { useTitle } from '../lib/hooks';
import { useStatus } from '../lib/queries';
import '../styles/landing.css';
import { FeeCalculator } from './landing/FeeCalculator';
import { LiveStats } from './landing/LiveStats';
import { MarketBoard } from './landing/MarketBoard';

const STEPS = [
  {
    title: `Launch with the ${BRAND.name} wallet`,
    body: `Create your token on Pons or LaunchHood as usual. In the advanced settings, paste the ${BRAND.name} protocol wallet as the fee recipient.`,
  },
  {
    title: 'Register it here',
    body: `Paste the token address. ${BRAND.name} checks on-chain that it came from the launchpad and that its fees really route to ${BRAND.name}.`,
  },
  {
    title: 'It starts stepping up',
    body: 'The engine claims fees, burns part of them at once, trades stock perps with the rest and burns realized profit. Every step is logged with a transaction.',
  },
];

const PROOF_POINTS = [
  { icon: 'bolt', title: 'Every action has a receipt', body: 'Claims, bridges, trades and burns link to their transactions on Robinhood Chain, Arbitrum or Hyperliquid.' },
  { icon: 'shield', title: 'Books that reconcile', body: 'The internal ledger is checked against real on-chain and venue balances. Drift is shown, not hidden.' },
  { icon: 'flame', title: 'Burns you can see', body: 'Bought-back tokens go to 0x…dEaD. No treasury, no “hold” mode, no quiet exceptions.' },
] as const;

function ProtocolTokenCard() {
  const token = useStatus().data?.protocolToken;
  if (!token) return null;
  return (
    <div className="hero__ca">
      <span className="panel-label">${BRAND.ticker}</span>
      <code className="num">{shortAddr(token, 8, 6)}</code>
      <CopyButton text={token} what={`$${BRAND.ticker} contract address`} />
    </div>
  );
}

export default function Landing() {
  useTitle(null);
  const { hash } = useLocation();

  // Deep links like /#faq: the section exists on first render, so a single scroll is enough.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__bg" aria-hidden="true" />
        <div className="container hero__grid">
          <div className="hero__copy">
            <p className="eyebrow">
              {CHAINS.rhc.name} · US-stock perps · Buyback &amp; burn
            </p>
            <h1 id="hero-title" className="hero__title">
              Every fee is a <span className="hero__em">step up.</span>
            </h1>
            <p className="hero__pitch">{BRAND.pitch}</p>
            <div className="hero__ctas">
              <Link to="/launch" className="btn btn--primary btn--lg">
                Launch a token <Icon name="arrowRight" />
              </Link>
              <Link to="/app" className="btn btn--secondary btn--lg">
                Watch it step up
              </Link>
            </div>
            <ul className="hero__chips">
              <li>Pons + LaunchHood</li>
              <li>Hyperliquid equity perps</li>
              <li>Always burned, never held</li>
            </ul>
            <ProtocolTokenCard />
          </div>
          <MarketBoard />
        </div>
        <StepLine steps={7} className="hero__line" />
      </section>

      <section className="section container" id="fees" aria-labelledby="fees-title">
        <div className="section-head">
          <p className="eyebrow">The split</p>
          <h2 id="fees-title">What happens to 1 ETH of fees</h2>
          <p>Drag the amount, pick a strategy. These are the exact numbers the engine enforces — no projections, no assumed returns.</p>
        </div>
        <FeeCalculator />
      </section>

      <section className="section container" id="how" aria-labelledby="how-title">
        <div className="section-head">
          <p className="eyebrow">How it works</p>
          <h2 id="how-title">Three steps. Then it runs itself.</h2>
        </div>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="steps__item" style={{ '--step': i } as CSSProperties}>
              <span className="steps__num led" aria-hidden="true">
                0{i + 1}
              </span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="section container" id="stats" aria-labelledby="stats-title">
        <div className="section-head">
          <p className="eyebrow">Live</p>
          <h2 id="stats-title">Every step, right now</h2>
          <p>Straight from the engine. Streams live; if the engine is unreachable you’ll see that instead of numbers.</p>
        </div>
        <LiveStats />
      </section>

      <section className="section container" id="strategies" aria-labelledby="strategies-title">
        <div className="section-head">
          <p className="eyebrow">Strategies</p>
          <h2 id="strategies-title">Pick how hard it trades</h2>
          <p>Every strategy burns on every claim. They differ in how the trading share is used — and you can change it later.</p>
        </div>
        <div className="strategy-grid">
          {STRATEGY_IDS.map((id) => {
            const s = STRATEGIES[id];
            return (
              <article key={id} className={`strategy-card card ${id === 'balanced' ? 'strategy-card--default' : ''}`}>
                <header className="spread">
                  <h3>{s.label}</h3>
                  {id === 'balanced' && <span className="pill pill--amber">Default</span>}
                </header>
                <p className="strategy-card__tag">{s.tagline}</p>
                <p className="dim small">{s.description}</p>
                <StrategyFacts strategy={s} />
              </article>
            );
          })}
        </div>
      </section>

      <section className="section container" id="verify" aria-labelledby="verify-title">
        <div className="verify card">
          <div className="section-head">
            <p className="eyebrow">Transparency</p>
            <h2 id="verify-title">Verify everything</h2>
            <p>Don’t trust the dashboard. Check the wallets, the ledger and the burns yourself.</p>
          </div>
          <ul className="verify__list">
            {PROOF_POINTS.map((p) => (
              <li key={p.title}>
                <Icon name={p.icon} size={20} className="amber" />
                <h3>{p.title}</h3>
                <p className="dim">{p.body}</p>
              </li>
            ))}
          </ul>
          <Link to="/proof" className="btn btn--secondary">
            Open the proof page <Icon name="arrowRight" />
          </Link>
        </div>
      </section>

      <section className="section container faq-layout" id="faq" aria-labelledby="faq-title">
        <div className="section-head faq-layout__head">
          <p className="eyebrow">FAQ</p>
          <h2 id="faq-title">Questions, answered straight</h2>
          <p>
            Still unsure? The <Link to="/docs">docs</Link> have every number and rule the engine follows.
          </p>
        </div>
        <div className="faq">
          {FAQ.map((f) => (
            <details key={f.q} className="faq__item">
              <summary>{f.q}</summary>
              <div className="faq__a">{f.a}</div>
            </details>
          ))}
        </div>
      </section>

      <section className="section container" id="risks" aria-labelledby="risks-title">
        <div className="risks">
          <div className="section-head">
            <p className="eyebrow">
              <Icon name="warn" size={14} /> Risks
            </p>
            <h2 id="risks-title">Read this before you launch</h2>
            <p>{BRAND.name} trades leveraged derivatives with real money, run by an off-chain engine. Things can and do go wrong.</p>
          </div>
          <ul className="risks__list">
            {RISKS.map((r) => (
              <li key={r.title}>
                <h3>{r.title}</h3>
                <p>{r.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="container cta-band" aria-labelledby="cta-title">
        <h2 id="cta-title">Give your memecoin a way up.</h2>
        <div className="row">
          <Link to="/launch" className="btn btn--primary btn--lg">
            Launch a token
          </Link>
          <Link to="/docs" className="btn btn--ghost btn--lg">
            Read the docs
          </Link>
        </div>
      </section>
    </>
  );
}
