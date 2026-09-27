import { BRAND } from '@bellwether/shared';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Dialog } from './Dialog';
import { EngineIndicator } from './EngineStatus';
import { Icon } from './Icon';
import { Wordmark } from './Logo';

export const NAV = [
  { to: '/app', label: 'App' },
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
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  return (
    <header className={`site-header ${scrolled ? 'site-header--scrolled' : ''}`}>
      <div className="container site-header__inner">
        <Link to="/" className="brand" aria-label={`${BRAND.name} — home`}>
          <Wordmark className="brand__wordmark" />
        </Link>
        <nav aria-label="Primary" className="nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className="nav__link">
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="site-header__actions">
          <EngineIndicator />
          <Link to="/launch" className="btn btn--primary btn--sm site-header__cta">
            Launch a token
          </Link>
          <button type="button" className="icon-btn site-header__menu" aria-label="Open menu" aria-haspopup="dialog" onClick={() => setMenuOpen(true)}>
            <Icon name="menu" size={20} />
          </button>
        </div>
      </div>
      <Dialog open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" className="dialog--sheet">
        <nav aria-label="Mobile" className="mobile-nav">
          <NavLink to="/" end className="mobile-nav__link">
            Home
          </NavLink>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className="mobile-nav__link">
              {n.label}
            </NavLink>
          ))}
        </nav>
        <Link to="/launch" className="btn btn--primary btn--block">
          Launch a token <Icon name="arrowRight" />
        </Link>
      </Dialog>
    </header>
  );
}
