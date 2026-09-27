import { BRAND, feeSplitFor, SESSION_LABEL, type Strategy } from '@bellwether/shared';
import { pct0 } from '../lib/format';

export function leverageRange(s: Strategy): string {
  return s.trades ? `${s.minLeverage}–${s.maxLeverage}×` : 'No trading';
}

export function sessionsText(s: Strategy): string {
  if (!s.trades) return 'Never trades';
  if (s.sessions.length === 5) return 'Around the clock';
  return s.sessions.map((x) => SESSION_LABEL[x]).join(', ');
}

/** Fee split at a glance: trade / token burn / protocol-token burn, with the numbers as text. */
export function SplitBar({ strategy }: { strategy: Strategy }) {
  const split = feeSplitFor(strategy.id);
  const parts = [
    { key: 'trade', label: 'trade', share: split.trading },
    { key: 'burn', label: 'burn', share: split.tokenBuyback },
    { key: 'protocol', label: `$${BRAND.ticker}`, share: split.protocolBuyback },
  ].filter((p) => p.share > 0);
  return (
    <div className="splitbar">
      <div className="splitbar__bar" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} className={`splitbar__seg splitbar__seg--${p.key}`} style={{ flexGrow: p.share }} />
        ))}
      </div>
      <p className="splitbar__legend num">{parts.map((p) => `${pct0(p.share)} ${p.label}`).join(' · ')}</p>
    </div>
  );
}

/** The concrete, enforced numbers behind a strategy. */
export function StrategyFacts({ strategy: s }: { strategy: Strategy }) {
  return (
    <>
      <dl className="kv">
        <div>
          <dt>Leverage</dt>
          <dd className="num">{leverageRange(s)}</dd>
        </div>
        <div>
          <dt>Entries</dt>
          <dd>{sessionsText(s)}</dd>
        </div>
        <div>
          <dt>Hard stop</dt>
          <dd className="num">{s.trades ? `${pct0(s.stopLoss)} of collateral` : '—'}</dd>
        </div>
        <div>
          <dt>Daily loss halt</dt>
          <dd className="num">{s.trades ? `${pct0(s.dailyLossLimit)} of budget` : '—'}</dd>
        </div>
      </dl>
      <SplitBar strategy={s} />
    </>
  );
}
