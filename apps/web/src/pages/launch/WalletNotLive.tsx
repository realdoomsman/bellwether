import { BRAND } from '@bellwether/shared';
import { Link } from 'react-router';
import { Icon } from '../../components/Icon';

/** The engine has no protocol wallet yet: launching is on hold. Never shows an address. */
export function WalletNotLive() {
  return (
    <div className="lw-hold" role="status">
      <Icon name="wallet" size={20} />
      <div className="lw-hold__body">
        <p className="lw-hold__title">{BRAND.name}’s protocol wallet isn’t live yet, so launching is on hold.</p>
        <p className="lw-hold__text">
          You can plan your token now; steps 3 and 4 open as soon as the wallet is published here. Don’t launch with any fee recipient until then: an address you find elsewhere is not {BRAND.name}’s, and fees sent there can’t be
          recovered. Meanwhile, watch the <Link to="/app">live engine</Link> or read the <Link to="/docs">docs</Link>.
        </p>
      </div>
    </div>
  );
}
