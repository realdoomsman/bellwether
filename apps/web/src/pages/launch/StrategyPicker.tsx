import { feeSplitFor, SESSION_LABEL, STRATEGIES, STRATEGY_IDS, type StrategyId } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { Segmented } from '../../components/Segmented';
import { leverageRange, sessionsText } from '../../components/StrategyFacts';
import { Term } from '../../components/Term';
import { pct0 } from '../../lib/format';
import { useSessionClock } from '../../lib/session';

const OPTIONS = STRATEGY_IDS.map((id) => ({ value: id, label: STRATEGIES[id].label }));

/**
 * Strategy as a segmented control, then the enforced numbers of all four side by side with the chosen
 * column set in ink, so the trade-off is visible instead of described. "Right now" uses the live session.
 */
export function StrategyPicker({ value, onChange }: { value: StrategyId; onChange: (id: StrategyId) => void }) {
  const clock = useSessionClock();
  const s = STRATEGIES[value];
  const rows: { key: string; label: ReactNode; cell: (id: StrategyId) => ReactNode }[] = [
    { key: 'lev', label: <Term id="leverage">Leverage</Term>, cell: (id) => (STRATEGIES[id].trades ? <span className="num">{leverageRange(STRATEGIES[id])}</span> : leverageRange(STRATEGIES[id])) },
    { key: 'sessions', label: <Term id="session">New entries</Term>, cell: (id) => sessionsText(STRATEGIES[id]) },
    {
      key: 'now',
      label: `Right now (${SESSION_LABEL[clock.session]})`,
      cell: (id) => {
        const st = STRATEGIES[id];
        if (!st.trades) return <span className="muted">Burns only</span>;
        return st.sessions.includes(clock.session) ? 'May enter' : <span className="muted">Waits</span>;
      },
    },
    { key: 'exits', label: 'Exits and stops', cell: (id) => (STRATEGIES[id].trades ? '24/7' : '—') },
    { key: 'stop', label: 'Hard stop', cell: (id) => <span className="num">{STRATEGIES[id].trades ? `${pct0(STRATEGIES[id].stopLoss)}` : '—'}</span> },
    { key: 'halt', label: 'Daily loss halt', cell: (id) => <span className="num">{STRATEGIES[id].trades ? pct0(STRATEGIES[id].dailyLossLimit) : '—'}</span> },
    { key: 'burn', label: 'Fees burned at claim', cell: (id) => <span className="num">{pct0(1 - feeSplitFor(id).trading)}</span> },
  ];

  return (
    <div className="lw-strat">
      <div className="lw-strat__control">
        <Segmented label="Strategy" options={OPTIONS} value={value} onChange={onChange} />
        <p className="lw-strat__desc" aria-live="polite">
          <strong>{s.tagline}.</strong> {s.description.replace(/ The default\.$/, '').replace(/(\d+)-(\d+)x/g, '$1–$2×').replace(/-(\d+%)/g, '−$1')}
        </p>
      </div>
      <div className="lw-strat__wrap">
        <table className="lw-strat__table">
          <caption className="sr-only">Strategy comparison; the chosen strategy is {s.label}.</caption>
          <thead>
            <tr>
              <td />
              {STRATEGY_IDS.map((id) => (
                <th key={id} scope="col" data-on={id === value || undefined} aria-current={id === value ? 'true' : undefined}>
                  {STRATEGIES[id].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                {STRATEGY_IDS.map((id) => (
                  <td key={id} data-on={id === value || undefined}>
                    {r.cell(id)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
