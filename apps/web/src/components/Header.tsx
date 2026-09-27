import { BRAND } from '@bellwether/shared';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Dialog } from './Dialog';
import { EngineIndicator } from './EngineStatus';
import { Icon } from './Icon';
import { Lockup } from './Logo';
import { SessionLine } from './SessionLine';
import { AnnounceToggle, SoundToggle, ThemeToggle } from './Toggles';

export const NAV = [
  { to: '/app', label: 'Live' },
  { to: '/launch', label: 'Launch' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/proof', label: 'Proof' },
  { to: '/docs', label: 'Docs' },
] as const;

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <header className="hdr" data-scrolled={scrolled || undefined}>
      <div className="container hdr__inner">
        <Link to="/" className="hdr__brand" aria-label={`${BRAND.name}, home`}>
          <Lockup />
        </Link>
        <nav aria-label="Primary" className="hdr__nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className="hdr__link">
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="hdr__right">
          <SessionLine className="hdr__session" />
          <SessionLine compact className="hdr__session-dot" />
          <EngineIndicator className="hdr__engine" />
          <span className="hdr__theme">
            <ThemeToggle />
          </span>
          <Link to="/launch" className="btn btn--primary btn--sm hdr__cta">
            <span className="hdr__cta-long">Launch a token</span>
            <span className="hdr__cta-short">Launch</span>
          </Link>
          <button type="button" className="icon-btn hdr__menu" aria-label="Open menu" aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>
            <Icon name="menu" size={20} />
          </button>
        </div>
      </div>
      <Dialog open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" className="dialog--sheet">
        <nav aria-label="Mobile" className="sheet-nav">
          <NavLink to="/" end className="sheet-nav__link">
            Home
          </NavLink>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className="sheet-nav__link">
              {n.label}
            </NavLink>
          ))}
        </nav>
        <dl className="sheet-meta">
          <div>
            <dt>US market</dt>
            <dd>
              <SessionLine />
            </dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>
              <EngineIndicator />
            </dd>
          </div>
          <div>
            <dt>Theme</dt>
            <dd>
              <ThemeToggle variant="labeled" />
            </dd>
          </div>
          <div>
            <dt>Bell</dt>
            <dd className="row">
              <SoundToggle />
              <AnnounceToggle />
            </dd>
          </div>
        </dl>
        <Link to="/launch" className="btn btn--primary btn--block">
          Launch a token <Icon name="arrowRight" />
        </Link>
      </Dialog>
    </header>
  );
}
