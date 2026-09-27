import { BRAND } from '@bellwether/shared';
import { Link } from 'react-router';
import { Section } from '../../components/Primitives';
import { RISKS } from '../../content/copy';
import { Fn, type FootnoteId } from '../../content/footnotes';

/** Risks that have a site-wide footnote get its superscript, so the footer and this list agree. */
const FOOTNOTE: Partial<Record<string, FootnoteId>> = { leverage: 'leverage', custody: 'custody', unaudited: 'advice' };

/** Risks: a plain numbered list in the page's own voice, not an alert box. */
export function Risks() {
  return (
    <Section
      id="risks"
      label="Risks"
      className="ld-risks"
      title="Read this before you launch."
      lede={`${BRAND.name} trades leveraged derivatives with real money, run by off-chain software. Things can and do go wrong.`}
      aside={
        <Link to="/docs#risks" className="tertiary">
          Full disclaimer <span className="arrow" aria-hidden="true">→</span>
        </Link>
      }
    >
      <ol className="ld-risks__list">
        {RISKS.map((r) => {
          const fn = FOOTNOTE[r.id];
          return (
            <li key={r.id} id={`risk-${r.id}`}>
              <h3 className="ld-risks__title">
                {r.title}
                {fn && <Fn id={fn} />}
              </h3>
              <p>{r.body}</p>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
