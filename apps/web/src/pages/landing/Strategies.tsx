import { BRAND, DEFAULT_STRATEGY, PROFIT_SPLIT, STRATEGIES, STRATEGY_IDS, type Strategy, type StrategyId } from '@bellwether/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Arrow, Muted, Section } from '../../components/Primitives';
import { Segmented } from '../../components/Segmented';
import { leverageRange, sessionsText, SplitBar } from '../../components/StrategyFacts';
import { Term } from '../../components/Term';
import { pct0 } from '../../lib/format';

const LIST = STRATEGY_IDS.map((id) => STRATEGIES[id]);
const OPTIONS = LIST.map((s) => ({ value: s.id, label: s.label }));

/** Spec rows, rendered from the shared strategy config so the site and the engine can't drift. */
const ROWS: { label: ReactNode; text: string; cell: (s: Strategy) => ReactNode }[] = [
  { label: 'Leverage', text: 'Leverage', cell: (s) => leverageRange(s) },
  { label: 'Enters in', text: 'Enters in', cell: (s) => sessionsText(s) },
  {
    label: (
      <>
        Entry <Term id="signal">signal</Term>
      </>
    ),
    text: 'Entry signal',
    cell: (s) => (s.trades ? s.entryThresholdBonus > 0 ? `Base + ${s.entryThresholdBonus}` : 'Base threshold' : '—'),
  },
  { label: 'Hard stop', text: 'Hard stop', cell: (s) => (s.trades ? `${pct0(s.stopLoss)} of collateral` : '—') },
  { label: 'Daily loss halt', text: 'Daily loss halt', cell: (s) => (s.trades ? `${pct0(s.dailyLossLimit)} of budget` : '—') },
  {
    label: 'Take profit',
    text: 'Take profit',
    cell: (s) =>
      s.trades
        ? `Close ${pct0(s.exits.tp1Fraction)} at +${(s.exits.tp1Move * 100).toFixed(1)}%, ${pct0(s.exits.tp2Fraction)} of the rest at +${(s.exits.tp2Move * 100).toFixed(1)}%, then trail ${(s.exits.trailPullback * 100).toFixed(1)}%`
        : '—',
  },
  { label: 'Fee split', text: 'Fee split', cell: (s) => <SplitBar strategy={s} /> },
  {
    label: 'Profit split',
    text: 'Profit split',
    cell: (s) => (s.trades ? `${pct0(PROFIT_SPLIT.tokenBuyback)} burns your token, ${pct0(PROFIT_SPLIT.protocolBuyback)} burns $${BRAND.ticker}` : 'No trading, no profit'),
  },
];

/** §5 Strategies: a spec comparison table, not cards. Phones pick one strategy's ruled spec sheet at a time. */
export function Strategies({ n }: { n: number }) {
  const [picked, setPicked] = useState<StrategyId>(DEFAULT_STRATEGY);
  const sheet = STRATEGIES[picked];
  return (
    <Section
      id="strategies"
      n={n}
      label="Strategies"
      className="ld-strategies"
      title={
        <>
          Pick how hard it trades. <Muted>Every strategy burns on every claim.</Muted>
        </>
      }
      lede="They differ only in how the trading share is used. The creator can change it later by signing a message from the deployer wallet."
      aside={
        <Link to="/docs#strategies" className="tertiary">
          <Arrow>Full rules in the docs</Arrow>
        </Link>
      }
    >
      <div className="ld-strat">
        <table className="ld-strat__table">
          <caption className="sr-only">Strategies compared: leverage, sessions, entries, stops and fee splits</caption>
          <thead>
            <tr>
              <td className="ld-strat__corner" />
              {LIST.map((s) => (
                <th key={s.id} scope="col" className="ld-strat__head">
                  <span className="ld-strat__name">
                    {s.label}
                    {s.id === DEFAULT_STRATEGY && <span className="ld-strat__default">Default</span>}
                  </span>
                  <span className="ld-strat__tag">{s.tagline}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.text}>
                <th scope="row">{r.label}</th>
                {LIST.map((s) => (
                  <td key={s.id}>{r.cell(s)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ld-strat__sheets">
          <Segmented label="Strategy" options={OPTIONS} value={picked} onChange={setPicked} size="sm" />
          <section key={sheet.id} className="ld-strat__sheet" aria-label={`${sheet.label} strategy`}>
            <h3 className="ld-strat__name">
              {sheet.label}
              {sheet.id === DEFAULT_STRATEGY && <span className="ld-strat__default">Default</span>}
            </h3>
            <p className="ld-strat__tag">{sheet.tagline}</p>
            <dl className="kv">
              {ROWS.map((r) => (
                <div key={r.text}>
                  <dt>{r.text}</dt>
                  <dd>{r.cell(sheet)}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </Section>
  );
}
