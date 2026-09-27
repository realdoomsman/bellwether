import { CopyButton } from '../../components/CopyButton';
import '../../styles/docs.css';

/** Sunken mono block with a copy button: shell commands and JSON samples on Docs and Proof. */
export function CodeBlock({ code, label, what = 'command', lang, wrap = false }: { code: string; label?: string; what?: string; lang?: string; wrap?: boolean }) {
  return (
    <figure className={wrap ? 'code code--wrap' : 'code'}>
      {(label || lang) && (
        <figcaption className="code__head">
          <span>{label}</span>
          {lang && <span className="code__lang">{lang}</span>}
        </figcaption>
      )}
      <div className="code__body">
        <pre tabIndex={0}>
          <code>{code}</code>
        </pre>
        <CopyButton text={code} what={what} iconOnly className="icon-btn icon-btn--sm code__copy" />
      </div>
    </figure>
  );
}

/** Absolute API root for copyable commands: the page origin when the API is same-origin (`/api`). */
export function apiRoot(base: string): string {
  return /^https?:\/\//.test(base) ? base : `${window.location.origin}${base}`;
}
