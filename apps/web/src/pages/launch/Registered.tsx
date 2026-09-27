import { BRAND } from '@bellwether/shared';
import { useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { BellView, type BellHandle } from '../../components/Bell';
import { Icon } from '../../components/Icon';
import { Popover } from '../../components/Popover';
import { Muted } from '../../components/Primitives';
import { Receipt, ReceiptBody } from '../../components/Receipt';
import { api } from '../../lib/api';
import { strike } from '../../lib/bellSound';
import { etTime, relTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { prefersReducedMotion } from '../../lib/prefs';
import { usePaperMode, useToken } from '../../lib/queries';
import { useApi } from '../../lib/useApi';
import { StepHead, StepHeadingRef } from './StepFrame';

/**
 * The end of a launch. The bell swings once, and only for the registration that just happened (a real
 * engine event); coming back to this page later shows the same state, still. The receipt is the engine's
 * own `registered` activity entry.
 */
export function Registered({ address, activated, fresh, reset }: { address: string; activated: boolean; fresh: boolean; reset: () => void }) {
  const token = useToken(address).data?.token;
  const events = useApi(`activity:token:${address.toLowerCase()}`, (s) => api.activity({ token: address, limit: 20 }, s)).data?.events;
  const receipt = events?.find((e) => e.kind === 'registered') ?? null;
  const paper = usePaperMode();
  const now = useNow(15_000);
  const bell = useRef<BellHandle>(null);
  const stage = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const heading = useContext(StepHeadingRef);

  // The moment of registration: bring the result into view, then strike once when it has settled.
  useEffect(() => {
    if (!fresh) return;
    const h = heading?.current;
    h?.focus({ preventScroll: true });
    const top = h?.getBoundingClientRect().top;
    const moved = top !== undefined && (top < 0 || top > window.innerHeight / 2);
    if (moved) h?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    const t = window.setTimeout(
      () => {
        bell.current?.ring();
        strike();
      },
      moved ? 520 : 200,
    );
    return () => clearTimeout(t);
  }, [fresh, heading]);

  const sym = token ? `$${token.symbol}` : 'Your token';
  const live = (token?.status ?? (activated ? 'active' : 'pending')) === 'active';

  return (
    <div className="lw-step lw-done">
      <StepHead
        n={4}
        kicker={receipt ? `Registered at ${etTime(receipt.at)}` : 'Registered'}
        title={
          <>
            {sym} is registered. <Muted>{live ? 'Its first burn rings the bell.' : 'Pending review.'}</Muted>
          </>
        }
      />
      <div className="lw-done__grid">
        <div className="lw-done__bell">
          <BellView
            ref={bell}
            label={receipt ? 'Show the registration receipt' : 'Registered'}
            stageRef={stage}
            onPress={() => setOpen((v) => !v)}
            captionKey={fresh ? 'registered' : undefined}
            caption={
              <>
                <span className="bell__ticker">{sym}</span>
                <span>registered</span>
                {receipt && <span className="muted">{relTime(Math.min(receipt.at, now), now)}</span>}
              </>
            }
          />
        </div>
        <div className="lw-done__body">
          <p className="lw-done__lede">
            {live
              ? `The engine claims ${sym}’s creator fees on its next cycle. Every claim buys back and burns ${sym}, each burn rings the bell with a public receipt, and trading starts once the book reaches its minimum.`
              : `New tokens on this engine are reviewed before it starts claiming. ${sym}’s page shows its status the whole time, and nothing is hidden while it waits.`}
            {paper && ` This engine runs in paper mode: ${BRAND.name}’s claims, trades and burns for ${sym} are simulated.`}
          </p>
          {receipt && <Receipt event={receipt} paper={paper} className="lw-done__receipt" />}
          <div className="lw-done__actions">
            <Link to={`/t/${address}`} className="btn btn--primary btn--lg">
              Open {sym}’s page <Icon name="arrowRight" />
            </Link>
            <button type="button" className="btn btn--ghost" onClick={reset}>
              Launch another token
            </button>
          </div>
        </div>
      </div>
      <Popover open={open} onClose={() => setOpen(false)} anchor={stage} label="Registration receipt" className={receipt ? 'popover--receipt' : undefined}>
        {receipt ? (
          <div className="receipt">
            <ReceiptBody event={receipt} paper={paper} />
          </div>
        ) : (
          <p className="popover__text">The engine’s receipt for this registration is still loading.</p>
        )}
      </Popover>
    </div>
  );
}
