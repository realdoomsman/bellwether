import { LAUNCHPADS, STRATEGIES } from '@stepup/shared';
import { SplitBar } from '../../components/StrategyFacts';
import { leverage, shortAddr } from '../../lib/format';
import type { Draft } from './draft';

/** Running recap of the creator's choices, visible on every step. */
export function Summary({ draft }: { draft: Draft }) {
  const s = STRATEGIES[draft.strategy];
  const pending = <span className="muted">not chosen</span>;
  return (
    <aside className="summary card" aria-labelledby="summary-title">
      <h2 id="summary-title" className="panel-label">
        Your token
      </h2>
      <dl className="kv summary__kv">
        <div>
          <dt>Launchpad</dt>
          <dd>{draft.launchpad ? LAUNCHPADS[draft.launchpad].name : pending}</dd>
        </div>
        <div>
          <dt>Market</dt>
          <dd className="num">{draft.market ? `${draft.market} · long` : pending}</dd>
        </div>
        <div>
          <dt>Strategy</dt>
          <dd>{s.label}</dd>
        </div>
        <div>
          <dt>Max leverage</dt>
          <dd className="num">{!s.trades ? 'No trading' : draft.maxLeverage === null ? pending : leverage(draft.maxLeverage)}</dd>
        </div>
        <div>
          <dt>Fee recipient set</dt>
          <dd>{draft.walletConfirmed ? 'Confirmed' : pending}</dd>
        </div>
        {draft.address && (
          <div>
            <dt>Token</dt>
            <dd className="num">{shortAddr(draft.address)}</dd>
          </div>
        )}
      </dl>
      <SplitBar strategy={s} />
      <p className="field__hint">Saved in this browser, so you can go launch and come back.</p>
    </aside>
  );
}
