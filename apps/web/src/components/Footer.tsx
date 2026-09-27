import { addressUrl, BRAND, BURN_ADDRESS } from '@bellwether/shared';
import { Link } from 'react-router';
import { FOOTNOTES } from '../content/footnotes';
import { relTime, shortAddr } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useStatus } from '../lib/queries';
import { CopyButton } from './CopyButton';
import { HEALTH_TONE, useEngineHealth } from './EngineStatus';
import { NAV } from './Header';
import { ExtLink } from './Links';
import { Monogram } from './Logo';
import { StatusDot } from './StatusDot';
import { ThemeToggle } from './Toggles';

/** A past run never reads "in 2s": the engine's clock may be slightly ahead of this one. */
function ranAgo(at: number | null | undefined, now: number): string {
  return at ? relTime(Math.min(at, now), now) : 'not yet';
}

function EngineHeartbeat() {
  const status = useStatus().data;
  const health = useEngineHealth();
  const now = useNow(15_000);
  const worker = (id: string) => status?.workers.find((w) => w.id === id);
  const claimer = worker('claimer');
  const buyback = worker('buyback');
  return (
    <div className="ftr__status">
      <StatusDot tone={HEALTH_TONE[health]}>{health === 'live' || health === 'polling' ? 'Engine running' : health === 'offline' ? 'Engine unreachable' : 'Connecting…'}</StatusDot>
      {status && (
        <ul className="ftr__beats">
          <li>Fee claimer ran {ranAgo(claimer?.lastOkAt, now)}</li>
          <li>Buyback ran {ranAgo(buyback?.lastOkAt, now)}</li>
          <li>
            {status.mode === 'paper' ? 'Paper mode' : 'Live mode'} · v{status.version}
          </li>
        </ul>
      )}
    </div>
  );
}

export function Footer() {
  const status = useStatus().data;

  return (
    <footer className="ftr">
      <div className="container">
        <div className="ftr__grid">
          <nav aria-label="Footer" className="ftr__col">
            <h2 className="ftr__h">Product</h2>
            <ul>
              {NAV.map((n) => (
                <li key={n.to}>
                  <Link to={n.to}>{n.label}</Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="ftr__col">
            <h2 className="ftr__h">On-chain</h2>
            <dl className="ftr__dl">
              <div>
                <dt>Protocol wallet</dt>
                <dd>
                  {status?.protocolWallet ? (
                    <>
                      <span className="row">
                        <ExtLink href={addressUrl('rhc', status.protocolWallet)}>
                          <code className="num">{shortAddr(status.protocolWallet)}</code>
                        </ExtLink>
                        <CopyButton text={status.protocolWallet} what="protocol wallet" iconOnly className="icon-btn icon-btn--sm" />
                      </span>
                      <span className="ftr__alt">
                        Also on <ExtLink href={addressUrl('arbitrum', status.protocolWallet)}>Arbitrum</ExtLink> and{' '}
                        <ExtLink href={addressUrl('hyperliquid', status.protocolWallet)}>Hyperliquid</ExtLink>
                      </span>
                    </>
                  ) : (
                    <span className="muted">{status ? 'Not configured yet' : 'Shown when the engine is reachable'}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Burn address</dt>
                <dd>
                  <ExtLink href={addressUrl('rhc', BURN_ADDRESS)}>
                    <code className="num">{shortAddr(BURN_ADDRESS)}</code>
                  </ExtLink>
                </dd>
              </div>
              <div>
                <dt>${BRAND.ticker}</dt>
                <dd>
                  {status?.protocolToken ? (
                    <span className="row">
                      <ExtLink href={addressUrl('rhc', status.protocolToken)}>
                        <code className="num">{shortAddr(status.protocolToken)}</code>
                      </ExtLink>
                      <CopyButton text={status.protocolToken} what={`$${BRAND.ticker} contract address`} iconOnly className="icon-btn icon-btn--sm" />
                    </span>
                  ) : (
                    <span className="muted">{status ? 'Not launched. Beware of impostors.' : '—'}</span>
                  )}
                </dd>
              </div>
            </dl>
          </div>

          <div className="ftr__col">
            <h2 className="ftr__h">Community</h2>
            <ul>
              <li>
                <ExtLink href={BRAND.links.x}>X @{BRAND.links.x.split('/').pop()}</ExtLink>
              </li>
              <li>
                <ExtLink href={BRAND.links.github}>GitHub</ExtLink>
              </li>
            </ul>
          </div>

          <div className="ftr__col">
            <h2 className="ftr__h">Status</h2>
            <EngineHeartbeat />
          </div>
        </div>

        <ol className="ftr__notes" aria-label="Footnotes">
          {FOOTNOTES.map((f) => (
            <li key={f.id} id={`fn-${f.id}`}>
              {f.body}
            </li>
          ))}
        </ol>

        <div className="ftr__mark" aria-hidden="true">
          <Monogram size={96} className="ftr__monogram" />
          <span className="ftr__wordmark">{BRAND.name}</span>
        </div>

        <div className="ftr__legal">
          <p>
            © {new Date().getFullYear()} {BRAND.protocolName} · {BRAND.domain}
          </p>
          <ThemeToggle variant="labeled" />
        </div>
      </div>
    </footer>
  );
}
