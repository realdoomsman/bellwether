import { BRAND, feeSplitFor, PROFIT_SPLIT, STRATEGIES, type StrategyId } from '@bellwether/shared';
import type { CSSProperties } from 'react';
import { RollingNumber } from '../../components/RollingNumber';
import { Term } from '../../components/Term';
import { leverage, pct0 } from '../../lib/format';

/**
 * What 1 ETH of claimed creator fees does under this configuration. Protocol constants (shared
 * FEE_SPLIT), not engine figures, so no as-of. The bar re-divides with transforms when the strategy changes.
 */
export function FeeSplit({ strategy, market, lev }: { strategy: StrategyId; market: string | null; lev: number | null }) {
  const s = STRATEGIES[strategy];
  const split = feeSplitFor(strategy);
  const parts = [
    {
      key: 'trade',
      share: split.trading,
      title: 'Trading book',
      note: s.trades ? (
        <>
          Collateral for a long <Term id="perp">{market ?? 'stock'} perp</Term>
          {lev !== null && <> at up to {leverage(lev)}</>}
        </>
      ) : (
        'Unused: burn only never trades'
      ),
    },
    { key: 'burn', share: split.tokenBuyback, title: 'Buys and burns your token', note: 'Right away, when the fee is claimed' },
    { key: 'bell', share: split.protocolBuyback, title: `Buys and burns $${BRAND.ticker}`, note: 'The protocol token, same moment' },
  ];
  let offset = 0;

  return (
    <figure className="lw-split">
      <div className="lw-split__bar" aria-hidden="true">
        {parts.map((p) => {
          const style = { '--from': offset, '--share': p.share } as CSSProperties;
          offset += p.share;
          return <span key={p.key} className={`lw-split__seg lw-split__seg--${p.key}`} style={style} />;
        })}
      </div>
      <ol className="lw-split__parts">
        {parts.map((p) => (
          <li key={p.key} className={`lw-split__part lw-split__part--${p.key}`} data-zero={p.share === 0 || undefined}>
            <span className="lw-split__swatch" aria-hidden="true" />
            <span className="lw-split__eth">
              <RollingNumber value={p.share} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} />
              <span className="lw-split__unit">ETH</span>
            </span>
            <span className="lw-split__title">{p.title}</span>
            <span className="lw-split__note">{p.note}</span>
          </li>
        ))}
      </ol>
      <figcaption className="lw-split__foot">
        Per 1 ETH of claimed creator fees, as fixed in the protocol. Realized trading profit is split again: {pct0(PROFIT_SPLIT.tokenBuyback)} burns your token, {pct0(PROFIT_SPLIT.protocolBuyback)} burns $
        {BRAND.ticker}. Losses only ever reduce the trading book.
      </figcaption>
    </figure>
  );
}
