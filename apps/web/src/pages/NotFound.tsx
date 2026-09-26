import { Link } from 'react-router';
import { StepLine } from '../components/StepLine';
import { useTitle } from '../lib/hooks';

export default function NotFound() {
  useTitle('Not found');
  return (
    <div className="container page lost">
      <p className="lost__code led" aria-hidden="true">
        404
      </p>
      <h1>This step doesn’t exist.</h1>
      <p className="dim">The page you asked for isn’t here. If you followed a token link, the address may be mistyped.</p>
      <div className="row lost__actions">
        <Link to="/" className="btn btn--primary">
          Back to the start
        </Link>
        <Link to="/app" className="btn btn--ghost">
          Open the app
        </Link>
      </div>
      <StepLine steps={5} className="lost__line" />
    </div>
  );
}
