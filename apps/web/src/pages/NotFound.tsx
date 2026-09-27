import { useId, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Icon } from '../components/Icon';
import { Monogram } from '../components/Logo';
import { isAddress } from '../lib/api';
import { useTitle } from '../lib/hooks';
import { useTokens } from '../lib/queries';

const DIRECTORY = [
  { to: '/app', label: 'Live', note: 'What the engine is doing right now.' },
  { to: '/leaderboard', label: 'Leaderboard', note: 'The bellwethers, ranked by burns, PnL and fees.' },
  { to: '/launch', label: 'Launch', note: 'Launch a token with its fees routed here.' },
  { to: '/proof', label: 'Proof', note: 'Balances, ledger and reconciliation.' },
  { to: '/docs', label: 'Docs', note: 'Every rule, with its numbers.' },
];

export default function NotFound() {
  useTitle('Not found');
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const tokens = useTokens().data?.tokens;
  const [value, setValue] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const inputId = useId();
  const hintId = useId();
  return (
    <div className="container page lost">
      <Monogram size={64} className="lost__mark" />
      <h1>No bell rings here.</h1>
      <p className="lead">
        Nothing is published at <code className="break">{pathname}</code>. If you followed a token link, the address may be mistyped; look it up below.
      </p>
      <form
        className="lost__search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const query = value.trim();
          if (isAddress(query)) return navigate(`/t/${query}`);
          const needle = query.replace(/^\$/, '').toLowerCase();
          const match = needle ? tokens?.find((t) => t.symbol.toLowerCase() === needle || t.name.toLowerCase() === needle) : undefined;
          if (match) return navigate(`/t/${match.address}`);
          setHint(
            !needle
              ? 'Enter a token address, ticker or name.'
              : tokens
                ? `No registered token is called “${query}”. Addresses are 0x followed by 40 hex characters.`
                : 'The engine isn’t answering, so only full 0x addresses work right now.',
          );
        }}
      >
        <label htmlFor={inputId} className="field__label">
          Find a token by address, ticker or name
        </label>
        <div className="search">
          <Icon name="search" />
          <input
            id={inputId}
            className="input input--mono"
            placeholder="0x… or $TICKER"
            spellCheck={false}
            autoComplete="off"
            value={value}
            aria-invalid={hint ? true : undefined}
            aria-describedby={hint ? hintId : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setHint(null);
            }}
          />
        </div>
        {hint && (
          <p id={hintId} className="field__hint field__hint--error">
            {hint}
          </p>
        )}
      </form>
      <nav aria-label="Where to go instead" style={{ width: 'min(100%, 520px)' }}>
        <dl className="kv">
          {DIRECTORY.map((d) => (
            <div key={d.to}>
              <dt>
                <Link to={d.to}>{d.label}</Link>
              </dt>
              <dd>{d.note}</dd>
            </div>
          ))}
        </dl>
      </nav>
    </div>
  );
}
