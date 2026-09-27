import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Arrow, Muted, Section } from '../../components/Primitives';
import { FAQ } from '../../content/copy';

/** At most eight questions on the landing; the rest live in the docs. */
const PICK = ['what', 'fees', 'when', 'losses', 'burns', 'custody', 'bell', 'audit'];
const ITEMS = PICK.flatMap((id) => FAQ.filter((f) => f.id === id));

/**
 * §8 Questions. Desktop: the questions as a vertical tab list, the answer beside it. Phones: a
 * disclosure list. Both render from the shared copy, so the docs and the landing never disagree.
 */
export function Questions({ n }: { n: number }) {
  const [active, setActive] = useState(0);
  const base = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const item = ITEMS[active] ?? ITEMS[0];

  const move = (to: number) => {
    const next = (to + ITEMS.length) % ITEMS.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <Section
      id="faq"
      n={n}
      label="Questions"
      className="ld-faq"
      title={
        <>
          Straight answers. <Muted>Every number and rule is in the docs.</Muted>
        </>
      }
      aside={
        <Link to="/docs#faq" className="tertiary">
          <Arrow>All questions</Arrow>
        </Link>
      }
    >
      <div className="ld-faq__tabs">
        <div className="ld-faq__list" role="tablist" aria-orientation="vertical" aria-label="Questions">
          {ITEMS.map((f, i) => (
            <button
              key={f.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${f.id}`}
              aria-selected={i === active}
              aria-controls={`${base}-panel`}
              tabIndex={i === active ? 0 : -1}
              className="ld-faq__q"
              onClick={() => setActive(i)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') move(i + 1);
                else if (e.key === 'ArrowUp') move(i - 1);
                else if (e.key === 'Home') move(0);
                else if (e.key === 'End') move(ITEMS.length - 1);
                else return;
                e.preventDefault();
              }}
            >
              <span className="ld-faq__n num" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              {f.q}
            </button>
          ))}
        </div>
        {item && (
          <div className="ld-faq__panel" role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${item.id}`} tabIndex={0}>
            <div className="ld-faq__answer" key={item.id}>
              <h3 className="ld-faq__panel-q">{item.q}</h3>
              {item.a}
            </div>
          </div>
        )}
      </div>

      <div className="ld-faq__stack">
        {ITEMS.map((f) => (
          <details key={f.id} className="ld-faq__item">
            <summary>{f.q}</summary>
            <div className="ld-faq__a">{f.a}</div>
          </details>
        ))}
      </div>
    </Section>
  );
}
