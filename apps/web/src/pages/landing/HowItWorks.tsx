import { BRAND, FEE_SPLIT_TRADING, LAUNCHPADS, type ActivityEvent } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { isPaperEvent, KIND_GLYPH, KIND_LABEL, KIND_TONE, printAmount, printVerb, subject } from '../../components/activityMeta';
import { CopyButton } from '../../components/CopyButton';
import { BellGlyph } from '../../components/Logo';
import { Arrow, Muted, Section } from '../../components/Primitives';
import { ReceiptTrigger } from '../../components/Receipt';
import { etTime, int, pct0, shortAddr } from '../../lib/format';
import { useActivity, usePaperMode, useStats, useStatus } from '../../lib/queries';

const BURNED_AT_CLAIM = pct0(FEE_SPLIT_TRADING.tokenBuyback + FEE_SPLIT_TRADING.protocolBuyback);
const FLOW_KINDS: Partial<Record<ActivityEvent['kind'], true>> = { claim: true, buyback: true, open: true, reduce: true, close: true, stop: true };

/** Step 1: the exact field to fill on each launchpad, and the real protocol wallet to paste. */
function FeeRecipient() {
  const status = useStatus();
  const wallet = status.data?.protocolWallet ?? null;
  return (
    <div className="ld-how__art ld-how__field">
      <dl className="ld-how__pads">
        {Object.values(LAUNCHPADS).map((l) => (
          <div key={l.id}>
            <dt>{l.name}</dt>
            <dd>
              “{l.feeField}” <span className="muted">in {l.feeFieldLocation}</span>
            </dd>
          </div>
        ))}
      </dl>
      <div className="ld-how__wallet">
        <span className="label">Paste the {BRAND.name} protocol wallet</span>
        {wallet ? (
          <span className="ld-how__wallet-row">
            <code className="num">{shortAddr(wallet, 8, 6)}</code>
            <CopyButton text={wallet} what="protocol wallet address" />
          </span>
        ) : (
          <span className="small muted">{status.data ? 'Not configured yet. Launching opens once the operator sets it.' : status.error ? 'Engine unreachable. The address loads when it’s back.' : 'Connecting to the engine…'}</span>
        )}
      </div>
    </div>
  );
}

/** Step 2: what registration verifies, and where the queue stands right now. */
function Checks() {
  const s = useStats().data;
  return (
    <div className="ld-how__art">
      <ul className="ld-how__checks">
        <li>The launchpad’s factory created the token</li>
        <li>Its creator fees route to the protocol wallet</li>
        <li>It isn’t a look-alike of ${BRAND.ticker} or another token</li>
      </ul>
      <p className="ld-how__art-foot small">
        {s ? (
          <>
            <span className="num">{int(s.tokensActive)}</span> tokens live{s.tokensPending > 0 && <>, <span className="num">{int(s.tokensPending)}</span> in review</>}.{' '}
          </>
        ) : null}
        <Link to="/launch" className="tertiary">
          <Arrow>Register a token</Arrow>
        </Link>
      </p>
    </div>
  );
}

/** Step 3: the engine's latest real claims, burns and trades, each opening its receipt. */
function LatestPrints() {
  const q = useActivity();
  const paper = usePaperMode();
  const all = q.data?.events ?? [];
  let events = all.filter((e) => FLOW_KINDS[e.kind]).slice(0, 4);
  // "It rings" should show a ring: keep the latest burn in view even when claims crowd it out.
  const burn = all.find((e) => e.kind === 'buyback');
  if (burn && !events.includes(burn)) events = [...events.slice(0, 3), burn];
  let body: ReactNode;
  if (events.length > 0) {
    body = (
      <ol className="ld-how__prints">
        {events.map((e) => {
          const who = subject(e);
          const amount = printAmount(e);
          return (
            <li key={e.id}>
              <ReceiptTrigger event={e} paper={paper} className={`print print--${KIND_TONE[e.kind]}`} label={`${KIND_LABEL[e.kind]}${who ? ` ${who}` : ''}${amount ? ` ${amount}` : ''} at ${etTime(e.at)}. Open receipt`}>
                <time className="print__time" dateTime={new Date(e.at).toISOString()}>
                  {etTime(e.at)}
                </time>
                <span className="print__glyph" aria-hidden="true">
                  {KIND_GLYPH[e.kind] ?? <BellGlyph />}
                </span>
                {who && <span className="print__who">{who}</span>}
                <span className="print__verb">{printVerb(e)}</span>
                {amount && <span className="print__amt">{amount}</span>}
                {(paper || isPaperEvent(e)) && <span className="paper-tag">PAPER</span>}
              </ReceiptTrigger>
            </li>
          );
        })}
      </ol>
    );
  } else if (q.data) {
    body = <p className="small muted">Nothing has run yet. The first print lands with the first claimed fee.</p>;
  } else {
    body = <p className="small muted">{q.error ? 'Engine unreachable. The latest prints load when it’s back.' : 'Connecting to the engine…'}</p>;
  }
  return (
    <div className="ld-how__art">
      <p className="label ld-how__art-label">Latest from the engine</p>
      {body}
    </div>
  );
}

const STEPS = [
  {
    title: 'Launch on the launchpad',
    body: `Create your token on ${LAUNCHPADS.pons.name} or ${LAUNCHPADS.launchhood.name} as you normally would. In the advanced settings, set the creator-fee recipient to the ${BRAND.name} protocol wallet.`,
    art: <FeeRecipient />,
  },
  {
    title: 'Register it here',
    body: `Paste the token address and pick a strategy and a market. ${BRAND.name} checks on-chain that the token is what it says it is before the engine touches a fee.`,
    art: <Checks />,
  },
  {
    title: 'It rings',
    body: `The engine claims fees as they accrue and burns ${BURNED_AT_CLAIM} on the spot. The rest trades US-stock perps in your strategy’s sessions, and realized profit is burned too. Every step lands on the tape with a receipt.`,
    art: <LatestPrints />,
  },
];

/** §3 How it works: three steps, each with the real artifact of that step beside it. */
export function HowItWorks({ n }: { n: number }) {
  return (
    <Section
      id="how"
      n={n}
      label="How it works"
      className="ld-how"
      title={
        <>
          Three steps. <Muted>Then it runs on its own.</Muted>
        </>
      }
      lede="No contract to deploy and nothing to hold. You set one field on the launchpad; the engine does the rest, in public."
    >
      <ol className="ld-how__steps">
        {STEPS.map((step, i) => (
          <li key={step.title} className="ld-how__step">
            <span className="ld-how__n fig" aria-hidden="true">
              {i + 1}
            </span>
            <div className="ld-how__text">
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
            {step.art}
          </li>
        ))}
      </ol>
    </Section>
  );
}
