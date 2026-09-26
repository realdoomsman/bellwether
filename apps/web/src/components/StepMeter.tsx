import { Led } from './Led';
import { compact, eth, pct } from '../lib/format';

/** Supply-burned milestones. Log-spaced so early burns are visible and every step is earned. */
const STEPS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25] as const;

export function StepMeter({ burnedPct, tokensBurned, buybackEth, symbol }: { burnedPct: number; tokensBurned: number; buybackEth: number; symbol: string }) {
  const reached = STEPS.filter((s) => burnedPct >= s).length;
  const next = STEPS[reached];
  return (
    <div className="meter">
      <div className="meter__readout">
        <p className="panel-label">Step meter</p>
        <p className="meter__value">
          <Led text={pct(burnedPct, { digits: burnedPct < 0.01 ? 3 : 2 })} />
        </p>
        <p className="dim">of ${symbol} supply burned forever</p>
        <dl className="kv meter__kv">
          <div>
            <dt>Tokens burned</dt>
            <dd className="num">{compact(tokensBurned)}</dd>
          </div>
          <div>
            <dt>ETH spent buying back</dt>
            <dd className="num">{eth(buybackEth)}</dd>
          </div>
          <div>
            <dt>Next step</dt>
            <dd className="num">{next === undefined ? 'All steps reached' : pct(next)}</dd>
          </div>
        </dl>
      </div>
      <div className="meter__stairs" role="img" aria-label={`${reached} of ${STEPS.length} burn steps reached`}>
        {STEPS.map((s, i) => (
          <div key={s} className={`meter__step ${i < reached ? 'is-on' : ''}`} style={{ height: `${18 + i * 11}%` }}>
            <span className="meter__step-label num">{pct(s)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
