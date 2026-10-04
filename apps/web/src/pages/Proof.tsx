import { addressUrl, BRAND, BURN_ADDRESS, CHAINS, type ChainKey, type LedgerAccountView, type ProofResponse, type ReconciliationItem, type WalletBalance } from '@bellwether/shared';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { StaleNote } from '../components/DataState';
import { CopyButton } from '../components/CopyButton';
import { Figure, FigureRow, figureStatus } from '../components/Figure';
import { Icon } from '../components/Icon';
import { ExtLink } from '../components/Links';
import { Medallion } from '../components/Medallion';
import { Muted, Section } from '../components/Primitives';
import { Reveal } from '../components/Reveal';
import { StatusDot } from '../components/StatusDot';
import { Term } from '../components/Term';
import { API_BASE } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { compact, etDateTime, etTime, eth, pct, relTime, shortAddr, usd } from '../lib/format';
import { useNow, useTitle } from '../lib/hooks';
import { useLeaderboard, useProof, useStatus } from '../lib/queries';
import { revalidate } from '../lib/useApi';
import { apiRoot, CodeBlock } from './info/CodeBlock';
import '../styles/proof.css';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const RAW = `${API_BASE}/proof`;

/** Venue balances label the asset e.g. "USDC (margin equity)"; they are still dollars. */
const isUsd = (unit: string) => unit === 'USD' || unit.startsWith('USDC');

function amount(n: number, unit: string, opts: { signed?: boolean } = {}): string {
  if (unit === 'ETH') return eth(n, opts);
  if (isUsd(unit)) return usd(n, opts);
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${unit}`;
}

/** Where a reconciliation line's "actually held" comes from (mirrors the engine's reconciler). */
function heldWhere(i: ReconciliationItem): string {
  if (i.chain === 'hyperliquid' && i.asset === 'USDC') return `${CHAINS.hyperliquid.name} and ${CHAINS.arbitrum.name}`;
  return CHAINS[i.chain].name;
}

/** Drift so small it prints as zero in the asset's unit. */
function negligible(i: ReconciliationItem): boolean {
  return Math.abs(i.drift) < (isUsd(i.asset) ? 0.005 : 0.00005);
}

type Line = 'match' | 'surplus' | 'tolerated' | 'short';
function lineState(i: ReconciliationItem): Line {
  if (!i.ok) return 'short';
  if (negligible(i)) return 'match';
  return i.drift > 0 ? 'surplus' : 'tolerated';
}

/** Ledger accounts grouped by the reconciliation line they add up to (mirrors the engine's reconciler). */
const GROUPS: { id: string; title: string; note: string; accounts: string[]; subtract?: string[]; asset?: string; chain?: ChainKey }[] = [
  {
    id: 'eth',
    title: `Held as ETH on ${CHAINS.rhc.name}`,
    note: 'Budgets waiting to be bridged or spent on buybacks, less gas the wallet fronted for tokens whose budgets were empty. The result is what the ledger says the wallet should hold.',
    accounts: ['trading_eth', 'token_buyback_eth', 'protocol_buyback_eth', 'gas_debt_eth'],
    subtract: ['gas_debt_eth'],
    asset: 'ETH',
    chain: 'rhc',
  },
  {
    id: 'usd',
    title: 'Held as USDC for trading',
    note: 'Collateral on Hyperliquid and USDC on Arbitrum. The reconciliation adds unrealized PnL on open positions.',
    accounts: ['trading_usd', 'deployed_usd', 'profit_token_usd', 'profit_protocol_usd'],
    asset: 'USDC',
    chain: 'hyperliquid',
  },
  {
    id: 'totals',
    title: 'Running totals',
    note: 'Lifetime counters, not balances. They never reconcile against a wallet.',
    accounts: ['fees_eth', 'buyback_spent_eth', 'gas_eth', 'realized_pnl_usd'],
  },
];

function cadence(ms: number | null): string {
  if (ms === null || ms <= 0) return 'on a schedule';
  if (ms < 90_000) return 'every minute';
  return `every ${Math.round(ms / 60_000)} minutes`;
}

// ─── Head: the verdict is the headline ───────────────────────────────────────

function Verdict({ p, loading, failed }: { p: ProofResponse | undefined; loading: boolean; failed: boolean }) {
  if (!p) {
    if (failed) {
      return (
        <h1 className="proof-verdict">
          Live check unavailable.
        </h1>
      );
    }
    return <h1 className="proof-verdict proof-verdict--pending">{loading ? 'Checking the books…' : 'The books'}</h1>;
  }
  const { checkedAt, items } = p.reconciliation;
  if (checkedAt === null || items.length === 0) {
    return (
      <h1 className="proof-verdict">
        No check yet. <Muted>The first reconciliation hasn’t finished.</Muted>
      </h1>
    );
  }
  const short = items.filter((i) => !i.ok);
  if (short.length > 0) {
    return (
      <h1 className="proof-verdict proof-verdict--down">
        Out of balance. <Muted>{short.length === 1 ? `${short[0]!.asset} is short on ${heldWhere(short[0]!)}.` : `${short.length} assets are short.`}</Muted>
      </h1>
    );
  }
  return (
    <h1 className="proof-verdict">
      The books balance.
    </h1>
  );
}

/** One plain sentence per reconciliation line, under the headline. */
function verdictDetail(items: ReconciliationItem[]): string {
  return items
    .map((i) => {
      const where = heldWhere(i);
      switch (lineState(i)) {
        case 'match':
          return `${i.asset} on ${where} matches the ledger.`;
        case 'surplus':
          return `${i.asset} on ${where} is ${amount(i.drift, i.asset)} over the ledger${i.asset === 'ETH' && i.chain === 'rhc' ? ', the float kept for gas' : ''}.`;
        case 'tolerated':
          return `${i.asset} on ${where} is ${amount(-i.drift, i.asset)} under the ledger, inside tolerance.`;
        case 'short':
          return `${i.asset} on ${where} is ${amount(-i.drift, i.asset)} short of the ledger.`;
      }
    })
    .join(' ');
}

// ─── §1 Reconciliation ───────────────────────────────────────────────────────

function Beam({ expected, actual }: { expected: number; actual: number }) {
  const max = Math.max(Math.abs(expected), Math.abs(actual));
  const scale = (v: number) => (max > 0 ? Math.max(0, v) / max : 0);
  return (
    <span className="beam" aria-hidden="true">
      <span className="beam__track">
        <span className="beam__bar beam__bar--ledger" style={{ '--w': scale(expected) } as CSSProperties} />
      </span>
      <span className="beam__track">
        <span className="beam__bar beam__bar--held" style={{ '--w': scale(actual) } as CSSProperties} />
      </span>
    </span>
  );
}

const LINE_TEXT: Record<Line, string> = { match: 'Balanced', surplus: 'Surplus', tolerated: 'Within tolerance', short: 'Short' };
const LINE_TIP: Record<Line, string> = {
  match: 'The wallet holds what the ledger says it should.',
  surplus: 'The wallet holds more than the ledger expects. Expected for ETH on Robinhood Chain, which keeps a float for gas; dust adds a little too.',
  tolerated: 'The wallet holds slightly less than the ledger, within the engine’s tolerance for rounding and fees.',
  short: 'The wallet holds less than the ledger says it should, beyond tolerance. The engine records a risk event when this starts.',
};

function Reconciliation({ p, paper }: { p: ProofResponse; paper: boolean }) {
  const { items } = p.reconciliation;
  if (items.length === 0) {
    return <p className="muted">The reconciler hasn’t finished its first run. This table fills in when it does.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="table table--stack recon">
        <caption className="sr-only">What the ledger says the engine holds against what it actually holds, per asset</caption>
        <thead>
          <tr>
            <th scope="col">Asset</th>
            <th scope="col">Held on</th>
            <th scope="col" className="r">
              Ledger says
            </th>
            <th scope="col" className="r">
              Actually held
            </th>
            <th scope="col" className="recon__beam-col">
              <span className="sr-only">Ledger against held</span>
              <span aria-hidden="true" className="recon__legend">
                <span className="recon__key recon__key--ledger" /> ledger <span className="recon__key recon__key--held" /> held
              </span>
            </th>
            <th scope="col" className="r">
              Difference
            </th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const state = lineState(i);
            return (
              <tr key={`${i.chain}:${i.asset}`} data-state={state}>
                <th scope="row" data-label="">
                  <span className="num recon__asset">{i.asset}</span>
                </th>
                <td data-label="Held on">{heldWhere(i)}</td>
                <td data-label="Ledger says" className="r num">
                  {amount(i.expected, i.asset)}
                </td>
                <td data-label="Actually held" className="r num">
                  <span>
                    {amount(i.actual, i.asset)}
                    {paper && <span className="paper-tag">PAPER</span>}
                  </span>
                </td>
                <td data-label="" className="recon__beam-col">
                  <Beam expected={i.expected} actual={i.actual} />
                </td>
                <td data-label="Difference" className={`r num${state === 'short' ? ' down' : ''}`}>
                  {negligible(i) ? '0' : amount(i.drift, i.asset, { signed: true })}
                </td>
                <td data-label="Verdict">
                  <span className={`verdict verdict--${state}`}>
                    <span aria-hidden="true">{state === 'short' ? '!' : '✓'}</span> <Term tip={LINE_TIP[state]}>{LINE_TEXT[state]}</Term>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── §2 Wallets ──────────────────────────────────────────────────────────────

const WALLET_CHAINS: ChainKey[] = ['rhc', 'arbitrum', 'hyperliquid'];

function WalletAddress({ address }: { address: string }) {
  return (
    <div className="wallet-id">
      <p className="label">Protocol wallet · the same key on every chain</p>
      <p className="wallet-id__addr num">
        <span className="break">{address}</span>
        <CopyButton text={address} what="protocol wallet" iconOnly className="icon-btn icon-btn--sm" />
      </p>
      <ul className="wallet-id__links">
        {WALLET_CHAINS.map((c) => (
          <li key={c}>
            <ExtLink href={addressUrl(c, address)}>{CHAINS[c].name}</ExtLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Wallets({ p, wallet }: { p: ProofResponse; wallet: string | null | undefined }) {
  const paper = p.mode === 'paper';
  const address = p.wallets.find((w) => w.address.toLowerCase() !== ZERO_ADDRESS)?.address ?? null;
  const configured = wallet !== null && address !== null;
  const total = p.wallets.every((w) => w.usd !== null) ? p.wallets.reduce((s, w) => s + (w.usd ?? 0), 0) : null;
  return (
    <>
      {configured ? (
        <WalletAddress address={address} />
      ) : (
        <p className="muted wallet-id">The operator hasn’t configured the protocol wallet yet. Balances below read as empty until they do.</p>
      )}
      {paper && configured && (
        <p className="proof-note small">
          The address is real; these balances are the engine’s simulated wallet, so the explorers above won’t show them.
        </p>
      )}
      <div className="table-wrap">
        <table className="table table--stack wallets">
          <caption className="sr-only">Protocol wallet balances by chain and asset</caption>
          <thead>
            <tr>
              <th scope="col">Chain</th>
              <th scope="col">Asset</th>
              <th scope="col" className="r">
                Balance
              </th>
              <th scope="col" className="r">
                Value (USD)
              </th>
              {!paper && (
                <th scope="col" className="r">
                  Explorer
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {p.wallets.map((w) => (
              <WalletRow key={`${w.chain}:${w.asset}`} w={w} paper={paper} configured={configured} />
            ))}
          </tbody>
          {total !== null && (
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  Total
                </th>
                <td className="r num">
                  <span>
                    {usd(total)}
                    {paper && <span className="paper-tag">PAPER</span>}
                  </span>
                </td>
                {!paper && <td aria-hidden="true" />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}

function WalletRow({ w, paper, configured }: { w: WalletBalance; paper: boolean; configured: boolean }) {
  // The engine only returns explorer URLs for live balances; paper balances never link.
  const href = configured && w.address.toLowerCase() !== ZERO_ADDRESS ? w.url : null;
  return (
    <tr>
      <th scope="row" data-label="">
        {CHAINS[w.chain].name}
      </th>
      <td data-label="Asset" className="num">
        {w.asset}
      </td>
      <td data-label="Balance" className="r num">
        <span>
          {amount(w.amount, w.asset)}
          {paper && <span className="paper-tag">PAPER</span>}
        </span>
      </td>
      <td data-label="Value (USD)" className="r num">
        {w.usd === null ? <span title="No ETH price available right now">—</span> : usd(w.usd)}
      </td>
      {!paper && (
        <td data-label="Explorer" className="r">
          {href ? (
            <ExtLink href={href} className="small">
              View
            </ExtLink>
          ) : (
            <span className="muted small">—</span>
          )}
        </td>
      )}
    </tr>
  );
}

// ─── §3 Ledger ───────────────────────────────────────────────────────────────

function Ledger({ p }: { p: ProofResponse }) {
  const byKey = new Map(p.ledger.map((a) => [a.account, a]));
  const known = new Set(GROUPS.flatMap((g) => g.accounts));
  const other = p.ledger.filter((a) => !known.has(a.account));
  const groups = [...GROUPS, ...(other.length ? [{ id: 'other', title: 'Other accounts', note: 'Accounts this page doesn’t group yet.', accounts: other.map((a) => a.account) }] : [])];
  return (
    <div className="ledger">
      {groups.map((g, gi) => {
        const rows = g.accounts.map((k) => byKey.get(k)).filter((a): a is LedgerAccountView => a !== undefined);
        if (rows.length === 0) return null;
        const line = 'asset' in g ? p.reconciliation.items.find((i) => i.asset === g.asset && i.chain === g.chain) : undefined;
        const minus = ('subtract' in g && g.subtract) || [];
        const sum = rows.reduce((s, a) => s + (minus.includes(a.account) ? -a.balance : a.balance), 0);
        const unit = rows[0]!.unit;
        return (
          <Reveal key={g.id} className="ledger__group" delay={gi * 80}>
            <h3 className="ledger__title">{g.title}</h3>
            <p className="ledger__note small">{g.note}</p>
            <dl className="ledger__rows">
              {rows.map((a) => (
                <div key={a.account} className="ledger__row">
                  <dt>
                    <span className="ledger__label">{a.label}</span>
                    <code className="ledger__key">{a.account}</code>
                  </dt>
                  <dd className="num">
                    {minus.includes(a.account) && a.balance !== 0 ? '−' : ''}
                    {a.unit === 'ETH' ? eth(a.balance) : usd(a.balance)}
                  </dd>
                </div>
              ))}
              {line && (
                <div className="ledger__row ledger__row--sum">
                  <dt>
                    <span className="ledger__label">Sum now</span>
                    <span className="ledger__key">{g.id === 'usd' ? 'plus unrealized PnL, reconciled in §1' : 'reconciled in §1 at every check'}</span>
                  </dt>
                  <dd className="num">{unit === 'ETH' ? eth(sum) : usd(sum)}</dd>
                </div>
              )}
            </dl>
          </Reveal>
        );
      })}
    </div>
  );
}

// ─── §4 Burn address ─────────────────────────────────────────────────────────

type BurnSort = 'tokens' | 'share' | 'eth';
const BURN_COLS: { key: BurnSort; label: string }[] = [
  { key: 'tokens', label: 'Tokens burned' },
  { key: 'share', label: 'Share of supply' },
  { key: 'eth', label: 'ETH spent' },
];

function BurnTable({ paper }: { paper: boolean }) {
  const q = useLeaderboard('burned');
  const [sort, setSort] = useState<{ key: BurnSort; dir: 1 | -1 }>({ key: 'share', dir: -1 });
  const rows = useMemo(() => {
    const value = (r: NonNullable<typeof q.data>['rows'][number]) =>
      sort.key === 'tokens' ? r.book.tokensBurned : sort.key === 'share' ? r.book.supplyBurnedPct : r.book.buybackEth;
    return [...(q.data?.rows ?? [])].sort((a, b) => sort.dir * (value(a) - value(b)));
  }, [q.data, sort]);

  if (!q.data) {
    return <p className="muted small">{q.error ? `Burn totals unavailable: ${errorMessage(q.error)}` : 'Connecting to the engine…'}</p>;
  }
  if (rows.length === 0) return <p className="muted">No tokens registered yet, so nothing has been burned here.</p>;
  return (
    <div className="table-wrap">
      <p className="burns__caption small">
        Burned per token, from the engine’s ledger{q.updatedAt ? ` · as of ${etTime(q.updatedAt, { seconds: true })}` : ''}
        {q.stale && ' (stale)'}
      </p>
      <table className="table table--stack burns">
        <caption className="sr-only">Tokens burned per token, from the engine’s ledger. Sortable by column.</caption>
        <thead>
          <tr>
            <th scope="col">Token</th>
            {BURN_COLS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th key={c.key} scope="col" className="r" aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="sort" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
                    {c.label}
                    <Icon name="sort" size={12} className="sort__icon" />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.address}>
              <th scope="row" data-label="" className="stack-full">
                <Link to={`/t/${r.address}`} className="burns__tok">
                  <Medallion image={r.image} symbol={r.symbol} address={r.address} size={28} />
                  <span>{r.name}</span>
                  <span className="num muted">${r.symbol}</span>
                </Link>
              </th>
              <td data-label="Tokens burned" className="r num">
                <span>
                  {r.book.tokensBurned > 0 ? compact(r.book.tokensBurned) : '0'}
                  {paper && r.book.tokensBurned > 0 && <span className="paper-tag">PAPER</span>}
                </span>
              </td>
              <td data-label="Share of supply" className="r num">
                {pct(r.book.supplyBurnedPct, { digits: 3 })}
              </td>
              <td data-label="ETH spent" className="r num">
                {eth(r.book.buybackEth)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BurnAddress({ paper }: { paper: boolean }) {
  return (
    <div className="grid burn">
      <div className="col-5 burn__id">
        <p className="label">Burn address · {CHAINS.rhc.name}</p>
        <p className="burn__addr num">
          {(BURN_ADDRESS.slice(2).match(/.{4}/g) ?? []).map((part, i) => (
            <span key={i}>{i === 0 ? `0x${part}` : part}</span>
          ))}
        </p>
        <p className="burn__claim">Nobody holds a key to this address. Tokens sent here can never move again.</p>
        <div className="row">
          <ExtLink href={addressUrl('rhc', BURN_ADDRESS)} className="small">
            Open in the explorer
          </ExtLink>
          <CopyButton text={BURN_ADDRESS} what="burn address" />
        </div>
        {paper && <p className="proof-note small">Paper burns are simulated, so they don’t appear at this address on-chain.</p>}
      </div>
      <div className="col-7">
        <BurnTable paper={paper} />
      </div>
    </div>
  );
}

// ─── §5 Verify it yourself ───────────────────────────────────────────────────

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="step">
      <span className="step__n" aria-hidden="true">
        {n}
      </span>
      <div>
        <h3 className="step__title">{title}</h3>
        <div className="step__body">{children}</div>
      </div>
    </li>
  );
}

function Guide({ wallet, paper }: { wallet: string | null | undefined; paper: boolean }) {
  const root = apiRoot(API_BASE);
  const walletLink = (chain: ChainKey, text: string) => (wallet ? <ExtLink href={addressUrl(chain, wallet)}>{text}</ExtLink> : text);
  return (
    <div className="grid guide">
      <div className="col-7">
        {paper && <p className="proof-note small guide__paper">The engine is in paper mode, so steps 3 to 5 will show the real wallet, not the simulated activity on this site.</p>}
        <ol className="steps">
          <Step n={1} title="Find the protocol wallet">
            {wallet ? (
              <p>
                It is <code className="break">{wallet}</code>. The same key signs on {CHAINS.rhc.name}, {CHAINS.arbitrum.name} and Hyperliquid, and it’s printed in the footer of every page.
              </p>
            ) : wallet === null ? (
              <p>Not configured yet. Once the operator sets it, it appears here and in the footer.</p>
            ) : (
              <p>It appears here and in the footer whenever the engine is reachable.</p>
            )}
          </Step>
          <Step n={2} title="Check a token’s fee recipient">
            <p>
              On the launchpad, or in the token’s launch transaction, the creator-fee recipient must be that wallet: “Creator wallet” on Pons, “Reward recipient” on LaunchHood. The{' '}
              <Link to="/launch">launch wizard</Link> runs the same check before it registers anything.
            </p>
          </Step>
          <Step n={3} title="Follow the fees">
            <p>On {walletLink('rhc', `the ${CHAINS.rhc.name} explorer`)} you’ll see fee claims come in, buybacks go out to Uniswap, and bridge transfers leave for {CHAINS.arbitrum.name}.</p>
          </Step>
          <Step n={4} title="Check the burns">
            <p>
              Every buyback ends with a transfer to <ExtLink href={addressUrl('rhc', BURN_ADDRESS)}>{shortAddr(BURN_ADDRESS)}</ExtLink>. Its token balances only ever go up. Each receipt on the site links to its
              transaction.
            </p>
          </Step>
          <Step n={5} title="Check the trades">
            <p>
              Positions live on Hyperliquid. {walletLink('hyperliquid', 'Open the wallet in Hyperliquid’s explorer')} and compare it with the open positions on the <Link to="/app">live page</Link>.
            </p>
          </Step>
          <Step n={6} title="Compare with the raw data">
            <p>
              Everything on this page comes from <ExtLink href={RAW}>{`${API_BASE}/proof`}</ExtLink>. Script against it, diff it over time, and hold us to it.
            </p>
          </Step>
        </ol>
      </div>
      <div className="col-5 guide__code">
        <CodeBlock label="Reconciliation" lang="shell" code={`curl -s ${root}/proof | jq '.reconciliation'`} />
        <CodeBlock label="Recent burns" lang="shell" code={`curl -s '${root}/activity?limit=200' \\\n  | jq '.events[] | select(.kind == "buyback")'`} />
        <CodeBlock label="Burned per token" lang="shell" code={`curl -s '${root}/leaderboard?by=burned' \\\n  | jq '.rows[] | {symbol, burned: .book.tokensBurned}'`} />
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const INDEX = [
  { id: 'reconciliation', label: 'Reconciliation' },
  { id: 'wallets', label: 'Wallets' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'burns', label: 'Burn address' },
  { id: 'verify', label: 'Verify it yourself' },
];

export default function Proof() {
  useTitle('Proof');
  const q = useProof();
  const status = useStatus().data;
  const wallet = status?.protocolWallet;
  const now = useNow(15_000);
  const p = q.data;
  const paper = p?.mode === 'paper';
  const fstatus = figureStatus(q);

  // Refetch the moment the reconciler finishes a run (the status stream carries worker heartbeats).
  const reconciler = status?.workers.find((w) => w.id === 'reconciler');
  const lastRun = reconciler?.lastOkAt ?? null;
  const seen = useRef(lastRun);
  useEffect(() => {
    if (lastRun !== null && seen.current !== null && lastRun !== seen.current) revalidate('proof');
    seen.current = lastRun;
  }, [lastRun]);
  const interval = reconciler?.lastRunAt && reconciler.nextRunAt ? reconciler.nextRunAt - reconciler.lastRunAt : null;

  const checkedAt = p?.reconciliation.checkedAt ?? null;
  const ledger = new Map(p?.ledger.map((a) => [a.account, a.balance]));
  const held = p && p.wallets.every((w) => w.usd !== null) ? p.wallets.reduce((s, w) => s + (w.usd ?? 0), 0) : null;
  const items = p?.reconciliation.items ?? [];
  const passing = items.filter((i) => i.ok).length;

  return (
    <div className="proof">
      <header className="container proof-head">
        <p className="label proof-head__label">
          <span>Proof of reserves</span>
          {p && (
            <StatusDot tone={q.stale ? 'offline' : items.some((i) => !i.ok) ? 'offline' : checkedAt ? 'live' : 'pending'}>
              {q.stale ? 'Live check unavailable' : checkedAt ? `Reconciled ${cadence(interval)}` : 'Waiting for the first check'}
            </StatusDot>
          )}
        </p>
        <Verdict p={p} loading={q.loading} failed={Boolean(q.error)} />
        <p className="lead proof-head__lede">
          The engine compares what its ledger says it holds against what its wallets actually hold.{p && items.length > 0 ? ` ${verdictDetail(items)}` : ''}
        </p>
        <p className="proof-head__meta small">
          {checkedAt ? (
            <>
              Last check{' '}
              <time dateTime={new Date(checkedAt).toISOString()} title={etDateTime(checkedAt)}>
                {relTime(checkedAt, now)}
              </time>{' '}
              ({etTime(checkedAt)})
            </>
          ) : (
            <span>Last check —</span>
          )}
          {reconciler?.nextRunAt && !q.stale && (
            <>
              <span aria-hidden="true"> · </span>next {relTime(reconciler.nextRunAt, now) === 'just now' ? 'any moment' : relTime(reconciler.nextRunAt, now)}
            </>
          )}
          <span aria-hidden="true"> · </span>
          <ExtLink href={RAW}>Raw JSON</ExtLink>
        </p>
        <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
        {q.error && !p && (
          <p className="proof-note small">
            {q.error.offline ? 'The engine isn’t answering, so this page shows no balances rather than guesses. It retries on its own.' : `${errorMessage(q.error)} Retrying automatically.`}
          </p>
        )}

        <FigureRow label="Proof summary" className="proof-figures">
          <Figure label="Held across wallets" value={held} kind="usd" paper={paper} asOf={checkedAt} status={fstatus} onRetry={q.refresh} source={{ label: 'Raw JSON', href: RAW }} />
          <Figure label="Creator fees claimed, all time" value={p ? (ledger.get('fees_eth') ?? null) : undefined} kind="eth" unit="ETH" paper={paper} asOf={q.updatedAt} status={fstatus} onRetry={q.refresh} source={{ label: 'Ledger', to: '#ledger' }} />
          <Figure label="Spent on buyback & burn" value={p ? (ledger.get('buyback_spent_eth') ?? null) : undefined} kind="eth" unit="ETH" paper={paper} asOf={q.updatedAt} status={fstatus} onRetry={q.refresh} source={{ label: 'Burns', to: '#burns' }} />
          <Figure label="Reconciliation lines passing" value={p && items.length ? passing : undefined} kind="int" unit={items.length ? `of ${items.length}` : undefined} asOf={checkedAt} status={fstatus} onRetry={q.refresh} source={{ label: 'Details', to: '#reconciliation' }} />
        </FigureRow>

        <nav className="proof-index" aria-label="On this page">
          <ol>
            {INDEX.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>
                  <span className="proof-index__n">§{i + 1}</span> {s.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </header>

      {p && (
        <>
          <Section id="reconciliation" n={1} label="Reconciliation" title={<>Ledger against wallet.</>} lede={<>Holding more than the ledger expects is normal: gas float and dust. Holding less, beyond a small tolerance, is drift, and it is shown here, never hidden.</>}>
            <Reveal>
              <Reconciliation p={p} paper={paper} />
            </Reveal>
          </Section>

          <Section id="wallets" n={2} label="Wallets & balances" title={<>One key, <Muted>three chains.</Muted></>} lede={`Fees arrive on ${CHAINS.rhc.name}, trading money is bridged through ${CHAINS.arbitrum.name}, and positions sit on Hyperliquid.`}>
            <Reveal>
              <Wallets p={p} wallet={wallet} />
            </Reveal>
          </Section>

          <Section id="ledger" n={3} label="Ledger accounts" title={<>Every account, <Muted>by name and key.</Muted></>} lede={`The engine books every claim, split, swap, bridge and trade into these accounts in integer units. The key in mono is the field name in ${API_BASE}/proof.`}>
            <Ledger p={p} />
          </Section>

          <Section id="burns" n={4} label="Burn address" title={<>Where every ring ends.</>} lede={`Every ${BRAND.name} buyback sends the tokens it bought to this address, with no exceptions and no treasury mode.`}>
            <Reveal>
              <BurnAddress paper={paper} />
            </Reveal>
          </Section>
        </>
      )}

      <Section id="verify" n={p ? 5 : undefined} label="Verify it yourself" title={<>Don’t trust this page. <Muted>Check it.</Muted></>} lede="Six checks, each against a public source this site doesn’t control.">
        <Guide wallet={wallet} paper={paper} />
      </Section>
    </div>
  );
}
