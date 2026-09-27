import { LAUNCHPADS, STRATEGIES, type TokenDetailResponse } from '@bellwether/shared';
import { AddressChip } from '../../components/Links';
import { Medallion } from '../../components/Medallion';
import { Change } from '../../components/Stat';
import { StatusDot } from '../../components/StatusDot';
import { etDateTime, leverage, price, relTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { ShareButton } from './ShareCard';

type Token = TokenDetailResponse['token'];

/** Medallion, serif name, $TICKER and one facts line; the address (explorer link + copy) and share on the right. */
export function TokenHeader({ t, asOf }: { t: Token; asOf: number | null }) {
  const s = STRATEGIES[t.strategy];
  return (
    <header className="tkn-head">
      <Medallion image={t.image} symbol={t.symbol} address={t.address} size={72} className="tkn-head__medal" />
      <div className="tkn-head__id">
        <h1 className="tkn-head__name">{t.name}</h1>
        <p className="tkn-head__facts dots">
          <span className="tkn-head__sym num">${t.symbol}</span>
          <span>{LAUNCHPADS[t.launchpad].name}</span>
          <span>
            <span className="num">{t.market}</span> {t.side}
          </span>
          <span>{s.trades ? `${s.label} ≤ ${leverage(t.maxLeverage)}` : s.label}</span>
          {t.priceUsd !== null && (
            <span>
              <span className="num">{price(t.priceUsd)}</span>
              {t.change24hPct !== null && (
                <>
                  {' '}
                  <Change frac={t.change24hPct} /> <span className="muted">24h</span>
                </>
              )}
            </span>
          )}
        </p>
      </div>
      <div className="tkn-head__actions">
        <AddressChip address={t.address} what="token address" />
        <ShareButton t={t} asOf={asOf} />
      </div>
    </header>
  );
}

/** Only non-default states get a line: pending review, paused, rejected, retired. */
export function TokenStatusLine({ t }: { t: Token }) {
  const now = useNow(60_000);
  const registered = (
    <time dateTime={new Date(t.createdAt).toISOString()} title={etDateTime(t.createdAt)}>
      registered {relTime(Math.min(t.createdAt, now), now)}
    </time>
  );
  if (t.status === 'active') return null;
  return (
    <p className={`tkn-status tkn-status--${t.status}`} role="status">
      <span className="dots">
      {t.status === 'pending' && (
        <>
          <StatusDot tone="pending">Pending review</StatusDot>
          {registered}
          <span>The engine starts claiming fees once it’s approved. Fees keep accruing on the launchpad meanwhile.</span>
        </>
      )}
      {t.status === 'paused' && (
        <>
          <StatusDot tone="idle">Paused</StatusDot>
          <span>The engine isn’t opening new positions or buying back for ${t.symbol}.</span>
        </>
      )}
      {t.status === 'rejected' && (
        <>
          <StatusDot tone="offline">Rejected</StatusDot>
          <span>{t.rejectedReason ?? 'No reason was recorded.'}</span>
          <span>The engine doesn’t claim fees or trade for this token.</span>
        </>
      )}
      {t.status === 'retired' && (
        <>
          <StatusDot tone="idle">Retired</StatusDot>
          <span>The engine no longer claims, trades or burns for ${t.symbol}. Its ledger stays here for the record.</span>
        </>
      )}
      </span>
    </p>
  );
}
