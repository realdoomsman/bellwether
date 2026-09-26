import { Link } from 'react-router';
import { FloorLine } from '../components/FloorLine';
import { useTitle } from '../lib/hooks';

export default function NotFound() {
  useTitle('Not found');
  return (
    <div className="container page lost">
      <p className="lost__code led" aria-hidden="true">
        404
      </p>
      <h1>This floor doesn’t exist.</h1>
      <p className="dim">The page you asked for isn’t here. If you followed a token link, the address may be mistyped.</p>
      <div className="row lost__actions">
        <Link to="/" className="btn btn--primary">
          Back to the floor
        </Link>
        <Link to="/app" className="btn btn--ghost">
          Open the app
        </Link>
      </div>
      <FloorLine steps={5} className="lost__line" />
    </div>
  );
}
