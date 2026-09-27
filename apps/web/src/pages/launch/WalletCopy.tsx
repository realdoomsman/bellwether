import { addressUrl, BRAND, type LaunchpadInfo } from '@bellwether/shared';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ExtLink } from '../../components/Links';

const COPIED_MS = 1_600;

/**
 * The one thing a creator must get exactly right: the protocol wallet, set large in groups of four so it
 * can be checked by eye after pasting, with a copy button that answers in place. Manual selection copies
 * the bare address (the groups are spacing, not characters).
 */
export function WalletCopy({ wallet, lp, onCopy }: { wallet: string; lp: LaunchpadInfo; onCopy: () => void }) {
  const [copied, setCopied] = useState(0);
  const [failed, setFailed] = useState(false);
  const addr = useRef<HTMLParagraphElement>(null);
  const groups = wallet.slice(2).match(/.{1,4}/g) ?? [];

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(0), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setFailed(false);
      setCopied(Date.now());
      onCopy();
    } catch {
      // No clipboard access (permissions, old browser): select it so a manual copy is one keystroke.
      setFailed(true);
      const sel = window.getSelection();
      if (sel && addr.current) sel.selectAllChildren(addr.current);
    }
  };

  return (
    <div className="lw-wallet">
      <p className="lw-wallet__label">
        Paste this as the <strong>{lp.feeField}</strong> on {lp.name}
      </p>
      <p ref={addr} key={copied || 'idle'} className="lw-wallet__addr" data-flash={copied ? '' : undefined} translate="no">
        {groups.map((g, i) => (
          <Fragment key={i}>
            {i > 0 && <wbr />}
            <span className={i === 0 || i === groups.length - 1 ? 'lw-wallet__g lw-wallet__g--edge' : 'lw-wallet__g'}>{i === 0 ? `0x${g}` : g}</span>
          </Fragment>
        ))}
      </p>
      <div className="lw-wallet__actions">
        <button type="button" className="btn btn--primary btn--lg lw-wallet__copy" onClick={copy} data-copied={copied ? '' : undefined}>
          <span className="lw-wallet__copy-face" key={copied ? 'done' : 'copy'}>
            <Icon name={copied ? 'check' : 'copy'} />
            {copied ? 'Copied' : 'Copy wallet address'}
          </span>
        </button>
        <ExtLink href={addressUrl('rhc', wallet)} className="lw-wallet__explorer">
          View on Blockscout
        </ExtLink>
      </div>
      <p className="lw-wallet__note" role="status">
        {failed
          ? 'Your browser blocked the clipboard. The address is selected: press Ctrl+C (⌘C on a Mac) to copy it.'
          : copied
            ? `Copied. Now paste it into ${lp.feeField} on ${lp.name}, then check it starts ${`0x${groups[0]}`} and ends ${groups[groups.length - 1]}.`
            : `Read from this engine’s configuration. It is ${BRAND.name}’s only wallet; an address you find anywhere else isn’t ours.`}
      </p>
    </div>
  );
}
