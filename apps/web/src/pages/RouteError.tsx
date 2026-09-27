import { BRAND } from '@bellwether/shared';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Monogram } from '../components/Logo';
import { useTitle } from '../lib/hooks';
import NotFound from './NotFound';

/** Render-time crash or failed lazy chunk (e.g. after a deploy). Keeps header/footer usable. */
export default function RouteError() {
  const error = useRouteError();
  useTitle('Something broke');
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  const chunk = error instanceof Error && /dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message);
  return (
    <div className="container page lost">
      <Monogram size={64} className="lost__mark" />
      <h1>{chunk ? `A newer ${BRAND.name} is out.` : 'This page stopped ringing.'}</h1>
      <p className="lead">
        {chunk
          ? 'The site was updated while this tab was open. Reload to get the latest version; nothing you did is lost.'
          : 'Something broke while drawing this page. The engine and the rest of the site are unaffected, and reloading usually fixes it.'}
      </p>
      {error instanceof Error && !chunk && <pre className="lost__err">{error.message}</pre>}
      <div className="row lost__actions">
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link to="/" className="btn btn--ghost">
          Go to the front page
        </Link>
        {!chunk && (
          <a className="tertiary" href={`${BRAND.links.github}/issues/new`} target="_blank" rel="noopener noreferrer">
            Report it on GitHub<span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>
    </div>
  );
}
