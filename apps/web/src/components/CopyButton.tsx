import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useToast } from './Toast';

export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  what,
  className = 'btn btn--ghost btn--sm',
  iconOnly = false,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  /** Used in the accessible name and toast, e.g. "protocol wallet". */
  what: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const notify = useToast();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1_800);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      notify(`Copied ${what}`, 'success');
    } catch {
      notify(`Couldn't access the clipboard. Select the ${what} and copy it manually.`, 'error');
    }
  };

  return (
    <button type="button" className={className} onClick={copy} aria-label={`${copied ? copiedLabel : label} ${what}`} data-copied={copied || undefined}>
      <Icon name={copied ? 'check' : 'copy'} />
      {!iconOnly && <span>{copied ? copiedLabel : label}</span>}
    </button>
  );
}
