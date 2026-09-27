import { BRAND } from '@bellwether/shared';
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';

/** Blocking notice for steps 3–4 while the engine has no protocol wallet configured. Never shows an address. */
export function WalletNotLive() {
  return (
    <div className="notice notice--hold" role="status">
      <div className="notice__icon" aria-hidden="true">
        <Icon name="wallet" size={20} />
      </div>
      <div className="notice__body">
        <p className="notice__title">{BRAND.name}’s protocol wallet isn’t live yet.</p>
        <p className="notice__text">
          Don’t launch with a fee recipient until it is. Any address you find elsewhere is not {BRAND.name}’s — fees sent there can’t be recovered. Explore the{' '}
          <Link to="/app">live board</Link> and <Link to="/docs">docs</Link> in the meantime; this step unlocks as soon as the wallet is published.
        </p>
      </div>
    </div>
  );
}
