import { addressUrl, BRAND, BURN_ADDRESS, CHAINS, type ProofResponse, type WalletBalance } from '@stepup/shared';
import { Link } from 'react-router';
import { Pill } from '../components/Badges';
import { ErrorNotice, Loading, StaleNote } from '../components/DataState';
import { Icon } from '../components/Icon';
import { AddressChip, ExtLink } from '../components/Links';
import { API_BASE } from '../lib/api';
import { dateTime, eth, relTime, shortAddr, usd } from '../lib/format';
import { useNow, useTitle } from '../lib/hooks';
import { useProof, useStatus } from '../lib/queries';
import '../styles/proof.css';

function amount(n: number, unit: string): string {
  if (unit === 'ETH') return eth(n);
  // Venue balances label the asset e.g. "USDC (margin equity)"; they're still dollars.
  if (unit === 'USD' || unit.startsWith('USDC')) return usd(n);
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${unit}`;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function WalletRow({ w, paper, configured }: { w: WalletBalance; paper: boolean; configured: boolean }) {
  // Without a configured wallet the engine reports the zero address; never render it or link to it.
  const hasAddress = configured && w.address.toLowerCase() !== ZERO_ADDRESS;
  const href = hasAddress ? (w.url ?? (paper ? null : addressUrl(w.chain, w.address))) : null;
  return (
    <tr>
      <td data-label="Chain">{CHAINS[w.chain].name}</td>
      <td data-label="Asset" className="num">
        {w.asset}
      </td>
      <td data-label="Balance" className="r num">
        {amount(w.amount, w.asset)}
      </td>
      <td data-label="USD" className="r num">
        {usd(w.usd)}
      </td>
      <td data-label="Address">
        {!hasAddress ? (
          <span className="muted nowrap">Not configured yet</span>
        ) : href ? (
          <ExtLink href={href} className="num">
            {shortAddr(w.address)}
          </ExtLink>
        ) : (
          <span className="num muted" title="Paper mode: simulated balance, no explorer page">
            {shortAddr(w.address)} · paper
          </span>
        )}
      </td>
    </tr>
  );
}

function Wallets({ p, configured }: { p: ProofResponse; configured: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table table--stack">
        <caption className="sr-only">Protocol wallet balances by chain</caption>
        <thead>
          <tr>
            <th scope="col">Chain</th>
            <th scope="col">Asset</th>
            <th scope="col" className="r">
              Balance
            </th>
            <th scope="col" className="r">
              USD
            </th>
            <th scope="col">Address</th>
          </tr>
        </thead>
        <tbody>
          {p.wallets.map((w) => (
            <WalletRow key={`${w.chain}:${w.asset}:${w.address}`} w={w} paper={p.mode === 'paper'} configured={configured} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ledger({ p }: { p: ProofResponse }) {
  return (
    <ul className="ledger">
      {p.ledger.map((a) => (
        <li key={a.account} className="ledger__row">
          <span>
            <span className="ledger__label">{a.label}</span>
            <code className="ledger__acct">{a.account}</code>
          </span>
          <span className="num">{a.unit === 'ETH' ? eth(a.balance) : usd(a.balance)}</span>
        </li>
      ))}
    </ul>
  );
}

function Reconciliation({ p }: { p: ProofResponse }) {
  const now = useNow();
  const { checkedAt, items } = p.reconciliation;
  const drifting = items.filter((i) => !i.ok).length;
  return (
    <>
      <p className="recon__summary">
        {checkedAt === null ? (
          <span className="muted">Not checked yet — the reconciler hasn’t completed a run.</span>
        ) : (
          <>
            {drifting === 0 ? <Pill tone="amber">All balanced</Pill> : <Pill tone="warn">{drifting} drifting</Pill>}{' '}
            <span className="muted">
              checked{' '}
              <time dateTime={new Date(checkedAt).toISOString()} title={dateTime(checkedAt)}>
                {relTime(checkedAt, now)}
              </time>
            </span>
          </>
        )}
      </p>
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">Ledger versus actual balances</caption>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Chain</th>
                <th scope="col" className="r">
                  Ledger says
                </th>
                <th scope="col" className="r">
                  Actually held
                </th>
                <th scope="col" className="r">
                  Drift
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={`${i.chain}:${i.asset}`}>
                  <td data-label="Asset" className="num">
                    {i.asset}
                  </td>
                  <td data-label="Chain">{CHAINS[i.chain].name}</td>
                  <td data-label="Ledger says" className="r num">
                    {amount(i.expected, i.asset)}
                  </td>
                  <td data-label="Actually held" className="r num">
                    {amount(i.actual, i.asset)}
                  </td>
                  <td data-label="Drift" className="r num">
                    {i.drift === 0 ? '0' : amount(i.drift, i.asset)}
                  </td>
                  <td data-label="Status">{i.ok ? <Pill tone="amber">OK</Pill> : <Pill tone="warn">Drift</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** `wallet`: undefined while status loads, null when the operator hasn't configured one. */
function Guide({ wallet }: { wallet: string | null | undefined }) {
  return (
    <ol className="guide">
      <li>
        <h3>Find the protocol wallet</h3>
        <p>
          {wallet ? (
            <>
              It’s <AddressChip address={wallet} what="protocol wallet" full />. The same key is used on every chain.
            </>
          ) : wallet === null ? (
            'Not configured yet. Once the operator publishes it, it appears here and in the footer — the same key on every chain.'
          ) : (
            'It’s shown in the footer and on this page whenever the engine is reachable.'
          )}
        </p>
      </li>
      <li>
        <h3>Check a token’s fee recipient</h3>
        <p>On the launchpad or the explorer, confirm the token’s creator-fee recipient is that wallet. The launch wizard runs the same check before registering anything.</p>
      </li>
      <li>
        <h3>Follow the fees</h3>
        <p>
          On{' '}
          {wallet ? <ExtLink href={addressUrl('rhc', wallet)}>{CHAINS.rhc.name}’s explorer</ExtLink> : `${CHAINS.rhc.name}’s explorer`}, you’ll see fee claims arrive, Uniswap buybacks go out, and bridge transfers toward Arbitrum.
        </p>
      </li>
      <li>
        <h3>Check the burns</h3>
        <p>
          Every buyback ends with a transfer to <ExtLink href={addressUrl('rhc', BURN_ADDRESS)}>{shortAddr(BURN_ADDRESS)}</ExtLink>. Its token balances only ever go up.
        </p>
      </li>
      <li>
        <h3>Check the trades</h3>
        <p>
          Positions live on Hyperliquid.{' '}
          {wallet ? <ExtLink href={addressUrl('hyperliquid', wallet)}>Open the wallet in Hyperliquid’s explorer</ExtLink> : 'Look the wallet up in Hyperliquid’s explorer'} and compare with the{' '}
          <Link to="/app">open positions</Link>.
        </p>
      </li>
      <li>
        <h3>Compare with the raw data</h3>
        <p>
          The numbers on this page come from <ExtLink href={`${API_BASE}/proof`}>{`${API_BASE}/proof`}</ExtLink>. Script against it, diff it, keep us honest.
        </p>
      </li>
    </ol>
  );
}

export default function Proof() {
  useTitle('Proof');
  const q = useProof();
  const wallet = useStatus().data?.protocolWallet;
  const p = q.data;

  return (
    <div className="container page proof">
      <header className="page-head">
        <div>
          <p className="page-head__eyebrow">Proof</p>
          <h1>Verify everything</h1>
          <p>What the engine holds, what its ledger says it should hold, and whether the two agree. Plus how to check all of it without trusting this page.</p>
        </div>
        {p?.mode === 'paper' && <Pill tone="warn">Paper mode — simulated balances</Pill>}
      </header>

      {!p ? (
        q.error ? (
          <ErrorNotice error={q.error} onRetry={q.refresh} what="Proof of reserves" />
        ) : (
          <Loading label="proof of reserves" height={120} count={3} />
        )
      ) : (
        <>
          <StaleNote stale={q.stale} updatedAt={q.updatedAt} />
          <section className="block" aria-labelledby="wallets-title">
            <div className="block-head">
              <h2 id="wallets-title">Wallets &amp; balances</h2>
            </div>
            {p.wallets.length > 0 ? <Wallets p={p} configured={wallet !== null} /> : <p className="muted">No wallets reported.</p>}
          </section>

          <div className="grid-2 block">
            <section aria-labelledby="ledger-title">
              <div className="block-head">
                <h2 id="ledger-title">Ledger accounts</h2>
              </div>
              {p.ledger.length > 0 ? <Ledger p={p} /> : <p className="muted">The ledger is empty.</p>}
            </section>
            <section aria-labelledby="burn-title">
              <div className="block-head">
                <h2 id="burn-title">Burn address</h2>
              </div>
              <div className="card burn">
                <Icon name="flame" size={22} className="amber" />
                <AddressChip address={p.burnAddress} what="burn address" full />
                <p className="dim small">Nobody holds a key for this address. Tokens sent here are gone for good — every {BRAND.name} buyback ends here, with no exceptions.</p>
              </div>
            </section>
          </div>

          <section className="block" aria-labelledby="recon-title">
            <div className="block-head">
              <h2 id="recon-title">Reconciliation</h2>
              <p className="muted small">Ledger vs. real balances. Small drift from gas and funding is expected; it is shown, never hidden.</p>
            </div>
            <Reconciliation p={p} />
          </section>
        </>
      )}

      <section className="block" aria-labelledby="guide-title">
        <div className="block-head">
          <h2 id="guide-title">Verify it yourself</h2>
        </div>
        <Guide wallet={wallet} />
      </section>
    </div>
  );
}
