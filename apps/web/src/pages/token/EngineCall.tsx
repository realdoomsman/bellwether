import { STRATEGIES, type TokenDetailResponse } from '@bellwether/shared';
import type { CSSProperties } from 'react';
import { VerdictPill } from '../../components/Badges';
import { sessionsText } from '../../components/StrategyFacts';
import { Term } from '../../components/Term';
import { etDateTime, relTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useSessionClock } from '../../lib/session';

type Token = TokenDetailResponse['token'];

/** −100…100 score on a 0…1 track. */
function onTrack(score: number): number {
  return Math.max(0, Math.min(1, (score + 100) / 200));
}

/** The engine's decision for this token, in its own words, set as a pull quote. */
export function EngineCall({ t }: { t: Token }) {
  const now = useNow(15_000);
  const clock = useSessionClock();
  const d = t.decision;
  const s = STRATEGIES[t.strategy];
  const signal = d.signalScore !== undefined && d.signalThreshold !== undefined ? { score: d.signalScore, need: d.signalThreshold } : null;

  return (
    <section className="tkn-call" aria-labelledby="call-title">
      <h2 id="call-title" className="tkn-label">
        The engine’s call right now
      </h2>
      <blockquote className="tkn-call__quote">
        <p>{d.message}</p>
      </blockquote>
      <p className="tkn-call__meta dots">
        <VerdictPill verdict={d.verdict} />
        <span>
          decided{' '}
          <time dateTime={new Date(d.at).toISOString()} title={etDateTime(d.at)}>
            {relTime(Math.min(d.at, now), now)}
          </time>
        </span>
      </p>
      {signal && (
        <div className="tkn-signal">
          <p className="tkn-signal__head">
            <Term id="signal">Entry signal</Term> on <span className="num">{t.market}</span>
            <span className="num tkn-signal__val">
              {signal.score} <span className="muted">/ needs {signal.need}</span>
            </span>
          </p>
          <div
            className="tkn-signal__track"
            role="meter"
            aria-valuemin={-100}
            aria-valuemax={100}
            aria-valuenow={signal.score}
            aria-label={`Entry signal ${signal.score}; ${s.label} needs ${signal.need}`}
          >
            <span className="tkn-signal__zero" aria-hidden="true" />
            <span className="tkn-signal__fill" style={{ '--from': onTrack(Math.min(0, signal.score)), '--to': onTrack(Math.max(0, signal.score)) } as CSSProperties} />
            <span className="tkn-signal__need" style={{ '--at': onTrack(signal.need) } as CSSProperties} aria-hidden="true" />
          </div>
        </div>
      )}
      <dl className="tkn-call__facts">
        <div>
          <dt>Strategy</dt>
          <dd>{s.label}</dd>
        </div>
        <div>
          <dt>Enters</dt>
          <dd>{sessionsText(s)}</dd>
        </div>
        <div>
          <dt>US market now</dt>
          <dd>
            {clock.label}, {clock.detail}
          </dd>
        </div>
      </dl>
    </section>
  );
}
