import { STRATEGIES, type TokenSummary } from '@bellwether/shared';
import { Empty, ErrorNotice, Loading, StaleNote } from '../../components/DataState';
import { Pnl } from '../../components/Stat';
import { usd } from '../../lib/format';
import { usePaperMode, usePositions, useTokens } from '../../lib/queries';
import { useSessionClock } from '../../lib/session';
import { PositionTable } from './Positions';

/** "$A", "$A and $B", "$A, $B and 3 more" */
function symbols(tokens: TokenSummary[]): string {
  const s = tokens.map((t) => `$${t.symbol}`);
  if (s.length <= 2) return s.join(' and ');
  return s.length === 3 ? `${s[0]}, ${s[1]} and ${s[2]}` : `${s[0]}, ${s[1]} and ${s.length - 2} more`;
}

/** Why tokens aren't in a position, in the engine's own words, grouped so each reason is said once. */
function flatReasons(tokens: TokenSummary[]): string[] {
  const trading = tokens.filter((t) => t.status === 'active' && STRATEGIES[t.strategy].trades);
  if (trading.length === 0) return [tokens.length === 0 ? 'No tokens are registered yet.' : 'No live token trades: burn-only tokens never open positions.'];
  const byMessage = new Map<string, TokenSummary[]>();
  for (const t of trading) byMessage.set(t.decision.message, [...(byMessage.get(t.decision.message) ?? []), t]);
  return [...byMessage.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([message, ts]) => `${symbols(ts)}: ${message.replace(/\.$/, '')}.`);
}

/** Left column of the live dashboard: pooled positions as instrument rows, or why there are none. */
export function OpenPositions({ titleId }: { titleId: string }) {
  const q = usePositions();
  const tokens = useTokens().data?.tokens;
  const clock = useSessionClock();
  const paper = usePaperMode();
  const positions = q.data?.positions ?? [];
  const notional = positions.reduce((s, p) => s + p.sizeUsd, 0);
  const margin = positions.reduce((s, p) => s + p.collateralUsd, 0);
  const open = positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);

  let body;
  if (!q.data) {
    body = q.error ? <ErrorNotice error={q.error} onRetry={q.refresh} what="Positions" compact /> : <Loading label="positions" height={56} count={2} />;
  } else if (positions.length === 0) {
    body = (
      <Empty title="The book is flat: no open positions.">
        {tokens ? (
          <ul className="flat-why">
            {flatReasons(tokens).map((line) => (
              <li key={line}>{line}</li>
            ))}
            {clock.tone !== 'open' && (
              <li>
                US stocks: {clock.label.toLowerCase()}, {clock.detail}. The perps trade 24/7; strategies that wait for US hours enter then.
              </li>
            )}
          </ul>
        ) : (
          'Each token’s row below says exactly why it isn’t trading.'
        )}
      </Empty>
    );
  } else {
    const holding = new Set(positions.flatMap((p) => p.shares.map((sh) => sh.token.toLowerCase())));
    const waiting = tokens?.filter((t) => t.status === 'active' && STRATEGIES[t.strategy].trades && !holding.has(t.address.toLowerCase())) ?? [];
    body = (
      <>
        <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
        <PositionTable positions={positions} caption="Open pooled positions; expand a row for its exit ladder and per-token shares" />
        <p className="panel-foot">Positions are pooled per market. Each token owns the share its collateral paid for, and exits follow one ladder: two take-profits, then a trailing stop.</p>
        {waiting.length > 0 && (
          <div className="waiting">
            <p className="waiting__h">Not in a position yet</p>
            <ul className="flat-why">
              {flatReasons(waiting).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="panel-head">
        <h2 id={titleId} className="panel-head__title">
          Open positions {positions.length > 0 && <span className="panel-head__count num">{positions.length}</span>}
        </h2>
        {positions.length > 0 && (
          <p className="panel-head__sum">
            <span>
              <span className="num">{usd(notional)}</span> notional
            </span>
            <span>
              <span className="num">{usd(margin)}</span> margin
            </span>
            <span>
              open <Pnl value={open} />
            </span>
            {paper && <span className="paper-tag">PAPER</span>}
          </p>
        )}
      </div>
      {body}
    </>
  );
}
