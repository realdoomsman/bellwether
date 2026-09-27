import type { ActivityEvent, TokenDetailResponse } from '@bellwether/shared';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { Bell } from '../../components/Bell';
import type { FigureStatus } from '../../components/Figure';
import { Icon } from '../../components/Icon';
import { Reveal } from '../../components/Reveal';
import { RollingNumber } from '../../components/RollingNumber';
import { compact, etDateTime, etTime, eth, int, relTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { burnedLabel, burnFormat } from './burn';

type Token = TokenDetailResponse['token'];

/** Milestones on the log-scale rule, as fractions of supply. */
const TICKS = [0.0001, 0.001, 0.01, 0.1, 0.25, 0.5, 1] as const;
const LOG_MIN = -4; // 0.01%

function tickLabel(v: number): string {
  return `${(v * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** Position on the rule: log10 from 0.01% (left edge) to 100% (right edge). */
function along(frac: number): number {
  return frac <= 10 ** LOG_MIN ? 0 : Math.min(1, (Math.log10(frac) - LOG_MIN) / -LOG_MIN);
}

/**
 * Where the burn stands on a log scale from 0.01% to 100% of supply, with the next milestone and,
 * when total supply is known, how many tokens it takes to get there. Fills once on first view.
 */
function BurnGauge({ frac, symbol, totalSupply }: { frac: number; symbol: string; totalSupply: number | null }) {
  const next = TICKS.find((v) => v > frac) ?? null;
  const toGo = next !== null && totalSupply ? (next - frac) * totalSupply : null;
  const x = along(frac);
  return (
    <Reveal className="gauge">
      <div
        className="gauge__rule"
        role="meter"
        aria-label="Share of supply burned, on a log scale from 0.01% to 100%"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={frac * 100}
        aria-valuetext={`${burnedLabel(frac)} of supply burned${next !== null ? `; next milestone ${tickLabel(next)}` : ''}`}
      >
        <span className="gauge__fill" style={{ '--x': x } as CSSProperties} />
        {TICKS.map((v) => (
          <span
            key={v}
            className={`gauge__tick${v === TICKS[0] ? ' gauge__tick--start' : v === 1 ? ' gauge__tick--end' : v === 0.25 || v === 0.5 ? ' gauge__tick--minor' : ''}`}
            data-passed={frac >= v || undefined}
            style={{ '--x': along(v) } as CSSProperties}
          >
            <span className="gauge__label">{tickLabel(v)}</span>
          </span>
        ))}
        <span className="gauge__mark" style={{ '--x': x } as CSSProperties} aria-hidden="true" />
      </div>
      <p className="gauge__cap">
        {next === null ? (
          'Every token burned.'
        ) : (
          <>
            Next milestone <strong>{tickLabel(next)}</strong>
            {toGo !== null && (
              <>
                : <span className="num">{compact(toGo)}</span> more ${symbol} to burn
              </>
            )}
            .
          </>
        )}
      </p>
    </Reveal>
  );
}

/**
 * The figure: "7.29% of $GOOSE supply burned for good", the burn rule, and the numbers behind it.
 * The mini bell swings when this token burns and opens its latest receipt.
 */
export function BurnFigure({ t, activity, asOf, status, onRetry, paper }: { t: Token; activity: ActivityEvent[]; asOf: number | null; status: FigureStatus; onRetry: () => void; paper: boolean }) {
  const now = useNow(15_000);
  const b = t.book;
  const lastBurn = activity.find((e) => e.kind === 'buyback');
  const burned = b.tokensBurned > 0;

  return (
    <section className="tkn-burn" aria-labelledby="burn-title" data-status={status}>
      <div className="tkn-burn__top">
        <h2 id="burn-title" className="tkn-label">
          Supply burned
        </h2>
        <Bell variant="mini" token={t.address} />
      </div>
      {burned ? (
        <>
          <p className="tkn-burn__fig">
            <RollingNumber
              value={b.supplyBurnedPct}
              format={burnFormat(b.supplyBurnedPct)}
              className="tkn-burn__num"
            />
            {paper && <span className="paper-tag">PAPER</span>}
          </p>
          <p className="tkn-burn__of">of ${t.symbol} supply burned for good</p>
        </>
      ) : (
        <>
          <p className="tkn-burn__none">No ${t.symbol} burned yet.</p>
          <p className="tkn-burn__of">
            {t.status === 'pending'
              ? 'Burns start once the token is approved and its first fees are claimed.'
              : b.tokenBuybackBudgetEth > 0
                ? `${eth(b.tokenBuybackBudgetEth)} is queued for the first buyback.`
                : 'The first buyback comes with the first claimed fee.'}
          </p>
        </>
      )}

      <BurnGauge frac={b.supplyBurnedPct} symbol={t.symbol} totalSupply={t.totalSupply} />

      <dl className="tkn-burn__stats">
        <div>
          <dt>Tokens burned</dt>
          <dd className="num" title={burned ? `${int(b.tokensBurned)} $${t.symbol}` : undefined}>
            {compact(b.tokensBurned)}
          </dd>
        </div>
        <div>
          <dt>Spent on buybacks</dt>
          <dd className="num">{eth(b.buybackEth)}</dd>
        </div>
        <div>
          <dt>Queued for the next burn</dt>
          <dd className="num">{eth(b.tokenBuybackBudgetEth)}</dd>
        </div>
        <div>
          <dt>Last burn</dt>
          <dd>
            {lastBurn ? (
              <time dateTime={new Date(lastBurn.at).toISOString()} title={etDateTime(lastBurn.at)}>
                {relTime(Math.min(lastBurn.at, now), now)}
              </time>
            ) : burned ? (
              'earlier'
            ) : (
              'none yet'
            )}
          </dd>
        </div>
      </dl>

      <p className="tkn-note">
        {status === 'offline' ? (
          <>
            <span>Engine unreachable{asOf ? ` · last update ${etTime(asOf)}` : ''}</span>
            <button type="button" className="link-btn" onClick={onRetry}>
              <Icon name="refresh" size={12} /> Retry
            </button>
          </>
        ) : (
          <>
            <span className={status === 'stale' ? 'muted' : undefined}>
              as of {asOf ? etTime(asOf, { seconds: true }) : '—'}
              {status === 'stale' && ' (stale)'}
            </span>
            <span aria-hidden="true">·</span>
            <Link to="/proof">Proof</Link>
          </>
        )}
      </p>
    </section>
  );
}
