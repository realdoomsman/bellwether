import { BRAND } from '@stepup/shared';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { useTitle } from '../lib/hooks';
import NotFound from './NotFound';

/** Render-time crash or failed lazy chunk (e.g. after a deploy). Keeps header/footer usable. */
export default function RouteError() {
  const error = useRouteError();
  useTitle('Something broke');
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  const chunk = error instanceof Error && /dynamically imported module|Loading chunk/i.test(error.message);
  return (
    <div className="container page lost">
      <h1>{chunk ? `A newer version of ${BRAND.name} is available.` : 'Something broke on this page.'}</h1>
      <p className="dim">{chunk ? 'Reload to get the latest version.' : 'The rest of the site still works. Reloading usually fixes it.'}</p>
      {error instanceof Error && !chunk && <pre className="lost__err">{error.message}</pre>}
      <div className="row lost__actions">
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link to="/" className="btn btn--ghost">
          Go home
        </Link>
      </div>
    </div>
  );
}
