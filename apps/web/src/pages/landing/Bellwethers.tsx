import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { Medallion } from '../../components/Medallion';
import { Arrow, Muted, Section } from '../../components/Primitives';
import { compact, eth, pct } from '../../lib/format';
import { useLeaderboard, usePaperMode } from '../../lib/queries';

const TOP = 5;

/** §7 The bellwethers: the five tokens that have burned the largest share of their supply. */
export function Bellwethers({ n }: { n: number }) {
  const q = useLeaderboard('burned');
  const paper = usePaperMode();
  const rows = q.data?.rows.filter((r) => r.book.tokensBurned > 0).slice(0, TOP);

  let body;
  if (rows && rows.length > 0) {
    const lead = rows[0]?.book.supplyBurnedPct || 1;
    body = (
      <ol className="ld-bw">
        {rows.map((r) => (
          <li key={r.address}>
            <Link to={`/t/${r.address}`} className="ld-bw__row">
              <span className="ld-bw__rank fig" aria-hidden="true">
                {r.rank}
              </span>
              <Medallion image={r.image} symbol={r.symbol} address={r.address} size={40} />
              <span className="ld-bw__who">
                <span className="ld-bw__sym num">${r.symbol}</span>
                <span className="ld-bw__name">{r.name}</span>
              </span>
              <span className="ld-bw__pct">
                <span className="fig">{pct(r.book.supplyBurnedPct, { digits: 2 })}</span>
                <span className="ld-bw__cap">of supply burned</span>
                <span className="ld-bw__meter" aria-hidden="true" style={{ '--p': r.book.supplyBurnedPct / lead } as CSSProperties} />
              </span>
              <span className="ld-bw__meta num">
                {compact(r.book.tokensBurned)} tokens · {eth(r.book.buybackEth)}
                {paper && <span className="paper-tag">PAPER</span>}
              </span>
              <span className="ld-bw__go" aria-hidden="true">
                →
              </span>
            </Link>
          </li>
        ))}
      </ol>
    );
  } else if (rows) {
    body = <p className="ld-bw__empty">No token has burned yet. The first buyback puts its token on this list.</p>;
  } else {
    body = <p className="ld-bw__empty">{q.error ? 'Engine unreachable. The ranking loads when it’s back.' : 'Connecting to the engine…'}</p>;
  }

  return (
    <Section
      id="bellwethers"
      n={n}
      label="The bellwethers"
      className="ld-bellwethers"
      title={
        <>
          Who’s leading. <Muted>Ranked by share of supply burned, so small caps compete fairly.</Muted>
        </>
      }
      aside={
        <Link to="/leaderboard" className="tertiary">
          <Arrow>See all</Arrow>
        </Link>
      }
    >
      {body}
    </Section>
  );
}
