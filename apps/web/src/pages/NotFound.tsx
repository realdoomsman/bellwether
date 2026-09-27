import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { Monogram } from '../components/Logo';
import { isAddress } from '../lib/api';
import { useTitle } from '../lib/hooks';

export default function NotFound() {
  useTitle('Not found');
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const hintId = useId();
  return (
    <div className="container page lost">
      <Monogram size={64} className="lost__mark" />
      <h1>No bell rings here.</h1>
      <p className="lead">The page you asked for isn’t here. If you followed a token link, the address may be mistyped.</p>
      <form
        className="lost__search"
        onSubmit={(e) => {
          e.preventDefault();
          const address = value.trim();
          if (isAddress(address)) navigate(`/t/${address}`);
          else setInvalid(true);
        }}
      >
        <label htmlFor={inputId} className="field__label">
          Look up a token by address
        </label>
        <div className="search">
          <Icon name="search" />
          <input
            id={inputId}
            className="input input--mono"
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            value={value}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? hintId : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(false);
            }}
          />
        </div>
        {invalid && (
          <p id={hintId} className="field__hint">
            That isn’t a token address: it should be 0x followed by 40 hex characters.
          </p>
        )}
      </form>
      <div className="row lost__actions">
        <Link to="/" className="btn btn--primary">
          Back to the start
        </Link>
        <Link to="/app" className="btn btn--secondary">
          Watch the engine live
        </Link>
      </div>
    </div>
  );
}
