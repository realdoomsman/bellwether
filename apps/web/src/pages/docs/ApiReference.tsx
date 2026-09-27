import { BRAND } from '@bellwether/shared';
import { useState } from 'react';
import { ExtLink } from '../../components/Links';
import { API_BASE } from '../../lib/api';
import { etTime } from '../../lib/format';
import { CodeBlock } from '../info/CodeBlock';

interface Endpoint {
  method: 'GET' | 'POST';
  path: string;
  returns: string;
  summary: string;
  /** Request body, as a sample. */
  body?: string;
  /** Concrete path for a live GET (placeholders filled with real values), or null when it can't be fetched as JSON. */
  live?: string | null;
}

const MAX_ITEMS = 2;

/** Arrays trimmed to a couple of items so a live sample stays readable; reports whether anything was cut. */
function trimJson(value: unknown): { value: unknown; trimmed: boolean } {
  let trimmed = false;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      if (v.length > MAX_ITEMS) trimmed = true;
      return v.slice(0, MAX_ITEMS).map(walk);
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), trimmed };
}

type Sample = { state: 'idle' | 'loading' } | { state: 'error'; message: string } | { state: 'done'; json: string; trimmed: boolean; at: number };

function LiveSample({ path }: { path: string }) {
  const [sample, setSample] = useState<Sample>({ state: 'idle' });
  const load = async () => {
    setSample({ state: 'loading' });
    try {
      const res = await fetch(API_BASE + path, { headers: { accept: 'application/json' } });
      const { value, trimmed } = trimJson(await res.json());
      setSample({ state: 'done', json: JSON.stringify(value, null, 2), trimmed, at: Date.now() });
    } catch {
      setSample({ state: 'error', message: `The ${BRAND.name} engine didn’t answer with JSON. Try again in a moment.` });
    }
  };
  return (
    <details
      className="ep__sample"
      onToggle={(e) => {
        if (e.currentTarget.open && sample.state === 'idle') void load();
      }}
    >
      <summary>Live response</summary>
      {sample.state === 'done' ? (
        <CodeBlock
          label={`GET ${API_BASE + path} · ${etTime(sample.at, { seconds: true })}${sample.trimmed ? ` · arrays trimmed to ${MAX_ITEMS}` : ''}`}
          lang="json"
          what="response"
          code={sample.json}
        />
      ) : sample.state === 'error' ? (
        <p className="ep__status small">
          {sample.message}{' '}
          <button type="button" className="link-btn" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : (
        <p className="ep__status small">Fetching {API_BASE + path}…</p>
      )}
    </details>
  );
}

function EndpointRow({ ep }: { ep: Endpoint }) {
  return (
    <li className="ep">
      <div className="ep__sig">
        <span className={`ep__method ep__method--${ep.method.toLowerCase()}`}>{ep.method}</span>
        <code className="ep__path">{ep.path}</code>
        {ep.live && (
          <ExtLink href={API_BASE + ep.live} className="ep__try small">
            Open JSON
          </ExtLink>
        )}
      </div>
      <p className="ep__summary">{ep.summary}</p>
      <p className="ep__returns small">
        Returns <code>{ep.returns}</code>
      </p>
      {ep.body && <CodeBlock label="Request body" lang="json" what="request body" code={ep.body} />}
      {ep.live && <LiveSample path={ep.live} />}
    </li>
  );
}

export function ApiReference({ sampleToken }: { sampleToken: string | null }) {
  const tokenLive = sampleToken ? `/tokens/${sampleToken}` : null;
  const groups: { title: string; endpoints: Endpoint[] }[] = [
    {
      title: 'Engine',
      endpoints: [
        { method: 'GET', path: '/health', returns: 'HealthResponse', summary: 'Liveness, mode, version and uptime.', live: '/health' },
        { method: 'GET', path: '/status', returns: 'StatusResponse', summary: 'Mode, kill switch, market session, venues, worker heartbeats and the protocol wallet.', live: '/status' },
        { method: 'GET', path: '/stats', returns: 'StatsResponse', summary: 'Protocol totals plus 30 days of daily history.', live: '/stats' },
        { method: 'GET', path: '/config', returns: 'ConfigResponse', summary: `Protocol wallet, $${BRAND.ticker} address, auto-approve, minimum collateral and the venue’s leverage cap.`, live: '/config' },
        {
          method: 'GET',
          path: '/stream',
          returns: 'StreamEvent (server-sent events)',
          summary: 'A live feed of activity, stats, positions and status events, each a JSON payload named by its event type. Reconnect with the standard EventSource retry.',
          live: null,
        },
      ],
    },
    {
      title: 'Markets',
      endpoints: [
        { method: 'GET', path: '/markets', returns: 'MarketsResponse', summary: 'Candidate stock markets with venue availability, leverage cap, price and entry signal.', live: '/markets' },
        { method: 'GET', path: '/markets/:symbol/candles?interval=5m|15m|1h|1d', returns: 'CandlesResponse', summary: 'Candles for the underlying perp.', live: '/markets/AAPL/candles?interval=1d' },
      ],
    },
    {
      title: 'Tokens',
      endpoints: [
        { method: 'GET', path: '/tokens', returns: 'TokensResponse', summary: 'Active, paused and pending tokens with their books and the engine’s current decision.', live: '/tokens' },
        { method: 'GET', path: '/tokens/:address', returns: 'TokenDetailResponse', summary: 'One token, including rejected and retired ones: book, decision, position, trades and activity.', live: tokenLive },
        { method: 'GET', path: '/tokens/:address/candles?interval=', returns: 'TokenCandlesResponse', summary: 'The token’s DEX candles. Empty before it graduates to a pool.', live: sampleToken ? `/tokens/${sampleToken}/candles?interval=1h` : null },
        { method: 'GET', path: '/tokens/:address/verify?launchpad=pons|launchhood', returns: 'VerifyResponse', summary: 'Dry-run of the registration checks: contract, launchpad, fee recipient, impersonation, not already registered.' },
        {
          method: 'POST',
          path: '/tokens',
          returns: 'RegisterResponse',
          summary: 'Register a token. Runs the same checks as verify; `activated` says whether it went live or waits for review.',
          body: `{\n  "address": "${sampleToken ?? '0x…'}",\n  "launchpad": "pons",\n  "market": "AAPL",\n  "side": "long",\n  "strategy": "balanced",\n  "maxLeverage": 10\n}`,
        },
      ],
    },
    {
      title: 'Creator settings',
      endpoints: [
        {
          method: 'POST',
          path: '/tokens/:address/settings/challenge',
          returns: 'SettingsChallenge',
          summary:
            'Step one. Post the complete settings you want (not a patch). The engine validates them and returns `message`, the exact text for the deployer to personal_sign, plus an opaque `nonce` ticket, `expiresAt`, the `deployer` it expects, and the normalized `change`.',
          body: '{\n  "strategy": "steady",\n  "market": "NVDA",\n  "side": "long",\n  "maxLeverage": 4\n}',
        },
        {
          method: 'POST',
          path: '/tokens/:address/settings',
          returns: 'TokenSummary',
          summary:
            'Step two. Send the ticket back with the deployer’s signature over `message`. The engine applies exactly the challenged settings, once. Errors: `invalid_nonce` (unknown or used), `nonce_expired`, `bad_signature`, `no_deployer`.',
          body: '{\n  "nonce": "<nonce from the challenge>",\n  "signature": "0x…"\n}',
        },
      ],
    },
    {
      title: 'Trading and the record',
      endpoints: [
        { method: 'GET', path: '/positions', returns: 'PositionsResponse', summary: 'Open positions, pooled per market, with each token’s share.', live: '/positions' },
        { method: 'GET', path: '/trades?limit=', returns: 'TradesResponse', summary: 'Recent trades, newest first. Default 50, at most 200.', live: '/trades?limit=5' },
        { method: 'GET', path: '/activity?before=&limit=&token=', returns: 'ActivityResponse', summary: 'The unified event log: claims, bridges, trades, buybacks, risk events. Page older events with `before=nextBefore`.', live: '/activity?limit=5' },
        { method: 'GET', path: '/leaderboard?by=burned|pnl|fees', returns: 'LeaderboardResponse', summary: 'Active and paused tokens ranked by share of supply burned, total PnL or fees claimed.', live: '/leaderboard?by=burned' },
        { method: 'GET', path: '/proof', returns: 'ProofResponse', summary: 'Wallet balances, ledger accounts and the latest reconciliation.', live: '/proof' },
      ],
    },
  ];

  return (
    <div className="api">
      {groups.map((g) => (
        <section key={g.title} className="api__group" aria-label={`${g.title} endpoints`}>
          <h3 className="api__title">{g.title}</h3>
          <ul className="api__list">
            {g.endpoints.map((ep) => (
              <EndpointRow key={`${ep.method} ${ep.path}`} ep={ep} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
