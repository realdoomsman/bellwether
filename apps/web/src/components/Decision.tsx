import type { Decision as DecisionT } from '@floor/shared';
import { relTime } from '../lib/format';
import { VerdictPill } from './Badges';

/** The engine's current decision for a token, in its own words, plus the signal gauge when relevant. */
export function Decision({ decision, large = false }: { decision: DecisionT; large?: boolean }) {
  const { signalScore, signalThreshold } = decision;
  const hasSignal = signalScore !== undefined && signalThreshold !== undefined;
  return (
    <div className={`decision ${large ? 'decision--large' : ''}`}>
      <div className="row">
        <VerdictPill verdict={decision.verdict} />
        <span className="muted small">decided {relTime(decision.at)}</span>
      </div>
      <p className="decision__msg">{decision.message}</p>
      {hasSignal && (
        <div className="signal">
          <div
            className="signal__track"
            role="meter"
            aria-valuemin={-100}
            aria-valuemax={100}
            aria-valuenow={signalScore}
            aria-label={`Entry signal ${signalScore}, needs ${signalThreshold}`}
          >
            <span className="signal__fill" style={{ width: `${Math.max(0, Math.min(100, (signalScore + 100) / 2))}%` }} />
            <span className="signal__need" style={{ left: `${Math.max(0, Math.min(100, (signalThreshold + 100) / 2))}%` }} />
          </div>
          <span className="num small dim">
            signal {signalScore} / needs {signalThreshold}
          </span>
        </div>
      )}
    </div>
  );
}
