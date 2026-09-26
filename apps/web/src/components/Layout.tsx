import { useEffect, useRef } from 'react';
import { Outlet, ScrollRestoration, useLocation, useNavigation } from 'react-router';
import { useStatus } from '../lib/queries';
import { useEngineHealth } from './EngineStatus';
import { Footer } from './Footer';
import { Header } from './Header';
import { Icon } from './Icon';

function SystemBanners() {
  const status = useStatus().data;
  const health = useEngineHealth();
  return (
    <div className="banners">
      {status?.mode === 'paper' && (
        <p className="banner banner--paper">
          <strong>Paper mode</strong> — simulated trades and burns, no real funds.
        </p>
      )}
      {status?.killSwitch && (
        <p className="banner banner--alert" role="status">
          <Icon name="shield" /> <strong>Kill switch on</strong> — no new positions or buybacks. Exits and stops still run.
        </p>
      )}
      {health === 'offline' && (
        <p className="banner banner--offline" role="status">
          <span className="banner__dots" aria-hidden="true" />
          <strong>Engine offline</strong> — live numbers are hidden until it reconnects. Retrying automatically.
        </p>
      )}
    </div>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const main = useRef<HTMLElement>(null);
  const shownPath = useRef(pathname);

  // Move focus to the new page on client-side navigation so screen readers announce it.
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    main.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {navigation.state === 'loading' && <div className="route-progress" role="progressbar" aria-label="Loading page" />}
      <div className="chrome">
        <SystemBanners />
        <Header />
      </div>
      <main id="main" ref={main} tabIndex={-1} className="main">
        <Outlet />
      </main>
      <Footer />
      <ScrollRestoration />
    </>
  );
}
