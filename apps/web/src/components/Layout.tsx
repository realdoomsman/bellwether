import { useEffect, useRef, useState } from 'react';
import { Outlet, ScrollRestoration, useLocation, useNavigation } from 'react-router';
import { useStatus } from '../lib/queries';
import { useSessionClock } from '../lib/session';
import { useEngineHealth } from './EngineStatus';
import { Footer } from './Footer';
import { Header } from './Header';
import { Icon } from './Icon';

const DISMISS_KEY = 'bw:paper-line-dismissed';

function sessionDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Calm disclosure lines above the header (never hazard stripes): paper mode (dismissible for the
 * session; PAPER labels stay on amounts), the kill switch and engine reachability (not dismissible).
 */
function Disclosures() {
  const status = useStatus().data;
  const health = useEngineHealth();
  const [dismissed, setDismissed] = useState(sessionDismissed);
  const lines = [];
  if (status?.mode === 'paper' && !dismissed) {
    lines.push(
      <p key="paper" className="disclosure">
        <span>
          <strong>Paper trading:</strong> prices are live from Hyperliquid; trades and burns are simulated. <a href="#fn-paper">What this means →</a>
        </span>
        <button
          type="button"
          className="disclosure__close"
          aria-label="Hide the paper trading notice for this session"
          onClick={() => {
            setDismissed(true);
            try {
              sessionStorage.setItem(DISMISS_KEY, '1');
            } catch {
              // Storage disabled: hidden for this page view only.
            }
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </p>,
    );
  }
  if (status?.killSwitch) {
    lines.push(
      <p key="kill" className="disclosure disclosure--alert" role="status">
        <span>
          <strong>Kill switch on:</strong> no new positions or buybacks. Exits and stops still run.
        </span>
      </p>,
    );
  }
  if (health === 'offline') {
    lines.push(
      <p key="offline" className="disclosure disclosure--alert" role="status">
        <span>
          <strong>Engine unreachable:</strong> {status ? 'showing last known values, marked stale.' : 'nothing has loaded yet; pages fill in once it’s back.'} Retrying automatically.
        </span>
      </p>,
    );
  }
  return lines.length > 0 ? (
    <aside className="disclosures" aria-label="Site notices">
      {lines}
    </aside>
  ) : null;
}

/** Mirrors the US market session onto <html data-session> for the hero sky tint. */
function SessionAttribute() {
  const { session } = useSessionClock();
  useEffect(() => {
    document.documentElement.dataset.session = session;
  }, [session]);
  return null;
}

/**
 * Canonical and og:url follow the route. index.html ships the home page's with the public origin
 * filled in by the engine; anywhere that isn't an absolute URL (the dev server), the page's own origin.
 */
function CanonicalUrl() {
  const { pathname } = useLocation();
  useEffect(() => {
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) return;
    const origin = /^https?:\/\/[^/]/.test(canonical.href) ? new URL(canonical.href).origin : location.origin;
    const url = origin + pathname;
    canonical.href = url;
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', url);
  }, [pathname]);
  return null;
}

export function Layout() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const main = useRef<HTMLElement>(null);
  const shownPath = useRef(pathname);
  // The first route paints without the fade (it holds the LCP element); later navigations fade in.
  const firstPath = useRef(pathname);
  const navigated = useRef(false);
  if (pathname !== firstPath.current) navigated.current = true;

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
      <SessionAttribute />
      <CanonicalUrl />
      <div className="rails" aria-hidden="true" />
      <Disclosures />
      <Header />
      <main id="main" ref={main} tabIndex={-1} className="main">
        <div key={pathname} className={navigated.current ? 'route route--enter' : 'route'}>
          <Outlet />
        </div>
      </main>
      <Footer />
      {/* Every cold load has location.key "default"; keying those by path stops one page's saved scroll
          position being restored on another. */}
      <ScrollRestoration getKey={(location) => (location.key === 'default' ? location.pathname : location.key)} />
    </>
  );
}
