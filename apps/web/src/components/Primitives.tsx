import { useId, type ElementType, type ReactNode } from 'react';

/** 1312 px column between the page rails, with the fluid outer gutter. */
export function Container({ as: Tag = 'div', className, children }: { as?: ElementType; className?: string; children: ReactNode }) {
  return <Tag className={className ? `container ${className}` : 'container'}>{children}</Tag>;
}

/**
 * A page section: separated by space and a full-width hairline, headed by an editorial label
 * ("§2 How the money moves"), a serif H2 and an optional lede. Two-tone titles: wrap the
 * continuation in <Muted>.
 */
export function Section({
  id,
  n,
  label,
  title,
  lede,
  aside,
  className,
  children,
}: {
  id?: string;
  n?: number;
  label?: string;
  title?: ReactNode;
  lede?: ReactNode;
  /** Right-aligned header content (a link, a control). */
  aside?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section id={id} className={className ? `section ${className}` : 'section'} aria-labelledby={title ? titleId : undefined}>
      <div className="container">
        {(label || title) && (
          <header className="section__head">
            <div className="section__titles">
              {label && (
                <p className="label section__label">
                  {n !== undefined && <span className="section__n">§{n}</span>}
                  {label}
                </p>
              )}
              {title && <h2 id={titleId}>{title}</h2>}
              {lede && <p className="lead section__lede">{lede}</p>}
            </div>
            {aside && <div className="section__aside">{aside}</div>}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}

/** Second tone of a two-tone headline. */
export function Muted({ children }: { children: ReactNode }) {
  return <span className="muted-tone">{children}</span>;
}

/** 12-column grid with 24 px gutters; columns stack below 900 px. */
export function Grid({ className, children, as: Tag = 'div' }: { className?: string; children: ReactNode; as?: ElementType }) {
  return <Tag className={className ? `grid ${className}` : 'grid'}>{children}</Tag>;
}

export function Col({ span, start, className, children, as: Tag = 'div' }: { span: number; start?: number; className?: string; children: ReactNode; as?: ElementType }) {
  const cls = [`col-${span}`, start ? `col-start-${start}` : '', className ?? ''].filter(Boolean).join(' ');
  return <Tag className={cls}>{children}</Tag>;
}

/** Hairline rule; `strong` for table-header weight. */
export function Rule({ strong = false, className }: { strong?: boolean; className?: string }) {
  return <hr className={`rule${strong ? ' rule--strong' : ''}${className ? ` ${className}` : ''}`} />;
}

/** Tertiary action: text with an arrow that shifts 2 px on hover. */
export function Arrow({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <span className="arrow" aria-hidden="true">
        {' →'}
      </span>
    </>
  );
}
