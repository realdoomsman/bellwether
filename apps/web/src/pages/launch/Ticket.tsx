import { LAUNCHPADS, STOCK_MARKETS, STRATEGIES } from '@bellwether/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StatusDot } from '../../components/StatusDot';
import { SplitBar } from '../../components/StrategyFacts';
import { api, isAddress } from '../../lib/api';
import { leverage, shortAddr } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import type { Draft } from './draft';
import { LaunchpadMark } from './LaunchpadMark';
import type { VerifiedToken } from './StepVerify';

/** A value on the ticket; one that appears after the ticket first rendered is inked in (rises 4 px). */
function Val({ fresh, children }: { fresh: boolean; children: ReactNode }) {
  const [ink] = useState(fresh);
  return <span className={ink ? 'lw-ticket__val is-new' : 'lw-ticket__val'}>{children}</span>;
}

/** A blank on the slip: a dotted rule where the value will be written. */
const BLANK = (
  <span className="lw-ticket__blank">
    <span className="sr-only">Not yet</span>
  </span>
);

/**
 * "Your token": the draft as a receipt slip that fills in as the creator moves through the wizard.
 * Saved in this browser (draft.ts), so leaving for the launchpad and coming back loses nothing.
 */
export function Ticket({
  draft,
  verified,
  wallet,
  onReset,
  variant,
}: {
  draft: Draft;
  verified: VerifiedToken | null;
  wallet: string | null;
  onReset: () => void;
  variant: 'aside' | 'fold';
}) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const fresh = mounted.current;

  const lp = draft.launchpad ? LAUNCHPADS[draft.launchpad] : null;
  const market = draft.market ? STOCK_MARKETS.find((m) => m.symbol === draft.market) ?? null : null;
  const s = STRATEGIES[draft.strategy];
  const token = draft.registered ? draft.registered.address : isAddress(draft.address.trim()) ? draft.address.trim() : null;
  const registered = draft.registered?.address ?? null;
  // After registration the engine knows the token; same cache key as useToken on the token page.
  const known = useApi(registered ? `token:${registered.toLowerCase()}` : null, (s) => api.token(registered ?? '', s)).data?.token ?? null;
  const tokenMeta = known ?? (verified && token && verified.address.toLowerCase() === token.toLowerCase() ? verified : null);
  const started = draft.launchpad !== null || draft.market !== null;

  let status: ReactNode;
  if (draft.registered) status = draft.registered.activated ? <StatusDot tone="live">Registered</StatusDot> : <StatusDot tone="pending">Pending review</StatusDot>;
  else if (tokenMeta) status = <span className="lw-ticket__stamp">Verified</span>;
  else if (draft.walletConfirmed) status = <span className="lw-ticket__stamp">Launched</span>;
  else status = <span className="lw-ticket__stamp lw-ticket__stamp--draft">Draft</span>;

  const rows: { key: string; label: string; value: ReactNode | null; id: string }[] = [
    {
      key: 'launchpad',
      label: 'Launchpad',
      id: lp?.id ?? '',
      value: lp && (
        <>
          <LaunchpadMark id={lp.id} size={20} /> {lp.name}
        </>
      ),
    },
    {
      key: 'market',
      label: 'Market',
      id: draft.market ?? '',
      value: draft.market && (
        <>
          <span className="num">{draft.market}</span> {market && <span className="lw-ticket__dim">{market.name}</span>}{' '}
          <span className="lw-ticket__long">
            <span aria-hidden="true">▲</span> long
          </span>
        </>
      ),
    },
    { key: 'strategy', label: 'Strategy', id: draft.market ? s.id : '', value: draft.market && s.label },
    {
      key: 'leverage',
      label: 'Leverage cap',
      id: draft.market ? `${s.id}:${draft.maxLeverage}` : '',
      value: draft.market && (s.trades ? draft.maxLeverage !== null && <span className="num">up to {leverage(draft.maxLeverage)}</span> : 'No trading'),
    },
    {
      key: 'wallet',
      label: 'Fee recipient',
      id: draft.walletConfirmed ? 'set' : '',
      value: draft.walletConfirmed && (
        <>
          <span className="num">{wallet ? shortAddr(wallet) : 'Protocol wallet'}</span> <span className="lw-ticket__dim">set at launch</span>
        </>
      ),
    },
    {
      key: 'token',
      label: 'Token',
      id: `${token ?? ''}:${tokenMeta?.symbol ?? ''}`,
      value: token && (
        <>
          {tokenMeta && <span className="lw-ticket__sym num">${tokenMeta.symbol}</span>} <span className="num">{shortAddr(token)}</span>
        </>
      ),
    },
  ];

  const body = (
    <>
      <dl className="lw-ticket__rows">
        {rows.map((r) => (
          <div key={r.key}>
            <dt>{r.label}</dt>
            <dd>
              {r.value ? (
                <Val key={r.id} fresh={fresh}>
                  {r.value}
                </Val>
              ) : (
                BLANK
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="lw-ticket__split">
        {draft.market ? (
          <Val key={`split:${s.trades}`} fresh={fresh}>
            <SplitBar strategy={s} />
          </Val>
        ) : (
          <p className="lw-ticket__hint">The fee split appears once you pick a market and strategy.</p>
        )}
      </div>
      <p className="lw-ticket__foot">
        <span>Saved in this browser, so you can go launch and come back.</span>
        {started && (
          <button type="button" className="link-btn lw-ticket__reset" onClick={onReset}>
            Start over
          </button>
        )}
      </p>
    </>
  );

  if (variant === 'fold') {
    const line = [lp?.name, draft.market, draft.market ? (s.trades && draft.maxLeverage !== null ? `${s.label} ${leverage(draft.maxLeverage)}` : s.label) : null].filter(Boolean).join(' · ');
    return (
      <details className="lw-ticket lw-ticket--fold receipt">
        <summary className="lw-ticket__summary">
          <span className="lw-ticket__title">Your token</span>
          <span className="lw-ticket__line">{line || 'Nothing chosen yet'}</span>
          {status}
        </summary>
        {body}
      </details>
    );
  }

  return (
    <aside className="lw-ticket receipt" aria-labelledby="lw-ticket-title">
      <div className="lw-ticket__head">
        <h2 id="lw-ticket-title" className="lw-ticket__title">
          Your token
        </h2>
        {status}
      </div>
      {body}
    </aside>
  );
}
