import { Link } from 'react-router';
import { Monogram } from '../../components/Logo';

/** The closing line: one display sentence, one action. Also where the "Engine today" bar bows out. */
export function Closing() {
  return (
    <section className="section ld-closing" aria-labelledby="closing-title" data-today-end>
      <div className="container ld-closing__inner">
        <Monogram size={88} className="ld-closing__mark" />
        <h2 id="closing-title" className="display ld-closing__title">
          Ring the opening bell for your token.
        </h2>
        <div className="ld-closing__actions">
          <Link to="/launch" className="btn btn--primary btn--lg">
            Launch a token
          </Link>
          <Link to="/docs" className="btn btn--secondary btn--lg">
            Read the docs
          </Link>
        </div>
      </div>
    </section>
  );
}
