import { addressUrl, BRAND, BURN_ADDRESS } from '@bellwether/shared';
import { Link } from 'react-router';
import { shortAddr } from '../lib/format';
import { useStatus } from '../lib/queries';
import { CopyButton } from './CopyButton';
import { NAV } from './Header';
import { ExtLink } from './Links';
import { Mark } from './Logo';

export function Footer() {
  const status = useStatus().data;

  return (
    <footer className="site-footer">
      <div className="container site-footer__grid">
        <div className="site-footer__brand">
          <div className="row">
            <Mark size={32} />
            <span className="site-footer__name">{BRAND.name}</span>
          </div>
          <p className="dim">{BRAND.tagline}</p>
          <p className="muted small">Creator fees → US-stock perps → buyback &amp; burn. Every action is logged with its transaction.</p>
        </div>

        <nav aria-label="Footer" className="site-footer__col">
          <h2 className="site-footer__h">Product</h2>
          <ul>
            {NAV.map((n) => (
              <li key={n.to}>
                <Link to={n.to}>{n.label}</Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="site-footer__col">
          <h2 className="site-footer__h">On-chain</h2>
          <dl className="site-footer__dl">
            <div>
              <dt>Protocol wallet</dt>
              <dd>
                {status?.protocolWallet ? (
                  <>
                    <span className="row">
                      <code className="num">{shortAddr(status.protocolWallet)}</code>
                      <CopyButton text={status.protocolWallet} what="protocol wallet" iconOnly className="icon-btn icon-btn--sm" />
                    </span>
                    <span className="row small">
                      <ExtLink href={addressUrl('rhc', status.protocolWallet)}>Robinhood Chain</ExtLink>
                      <ExtLink href={addressUrl('arbitrum', status.protocolWallet)}>Arbitrum</ExtLink>
                      <ExtLink href={addressUrl('hyperliquid', status.protocolWallet)}>Hyperliquid</ExtLink>
                    </span>
                  </>
                ) : (
                  <span className="muted">{status ? 'Not configured yet' : 'Shown when the engine is reachable'}</span>
                )}
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
                  <span className="muted">{status ? 'Not launched yet — beware of impostors' : '—'}</span>
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
          </dl>
        </div>

        <div className="site-footer__col">
          <h2 className="site-footer__h">Community</h2>
          <ul>
            <li>
              <ExtLink href={BRAND.links.x}>X / Twitter</ExtLink>
            </li>
            <li>
              <ExtLink href={BRAND.links.github}>GitHub</ExtLink>
            </li>
          </ul>
        </div>
      </div>
      <div className="container site-footer__legal">
        <p>
          Unaudited software. Leveraged perps can be liquidated. The engine holds the protocol wallet key off-chain. Nothing here is financial advice.{' '}
          <Link to="/docs#risks">Read the risks</Link>.
        </p>
        <p className="muted">
          © {new Date().getFullYear()} {BRAND.protocolName} · {BRAND.domain}
        </p>
      </div>
    </footer>
  );
}
