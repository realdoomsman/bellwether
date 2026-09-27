import { BRAND, BURN_ADDRESS, feeSplitFor, PROFIT_SPLIT, STRATEGIES } from '@bellwether/shared';
import { sessionsText } from '../../components/StrategyFacts';
import { leverage, pct0, shortAddr, usd } from '../../lib/format';
import { useConfig } from '../../lib/queries';
import type { Draft } from './draft';

/** Plain-language terms: exactly what the engine will do with this configuration, before anything is registered. */
export function Plan({ draft, symbol }: { draft: Draft; symbol: string | null }) {
  const minCollateral = useConfig().data?.minCollateralUsd ?? null;
  const s = STRATEGIES[draft.strategy];
  const split = feeSplitFor(draft.strategy);
  const token = symbol ? `$${symbol}` : 'your token';
  const market = draft.market ?? 'your chosen stock';

  return (
    <section className="lw-plan" aria-labelledby="lw-plan-title">
      <h3 id="lw-plan-title" className="lw-sub">
        What the engine will do for {token}
      </h3>
      <ol className="lw-plan__list">
        {s.trades ? (
          <>
            <li>
              <span className="num">{pct0(split.tokenBuyback)}</span> of every claimed fee buys back and burns {token} right away, and <span className="num">{pct0(split.protocolBuyback)}</span> burns ${BRAND.ticker}.
            </li>
            <li>
              <span className="num">{pct0(split.trading)}</span> funds a long {market} perp at up to <span className="num">{leverage(draft.maxLeverage ?? s.maxLeverage)}</span>, entering only in: {sessionsText(s).toLowerCase()}.
            </li>
            <li>
              A hard stop at <span className="num">{pct0(s.stopLoss)}</span> of collateral; new entries halt for the day after losing <span className="num">{pct0(s.dailyLossLimit)}</span> of the trading budget.
            </li>
            <li>
              Realized profit: <span className="num">{pct0(PROFIT_SPLIT.tokenBuyback)}</span> burns {token}, <span className="num">{pct0(PROFIT_SPLIT.protocolBuyback)}</span> burns ${BRAND.ticker}. Losses only reduce the trading book.
            </li>
            {minCollateral !== null && <li>Trading starts once the book holds at least {usd(minCollateral)} of collateral; until then fees accumulate.</li>}
          </>
        ) : (
          <>
            <li>Never trades.</li>
            <li>
              <span className="num">{pct0(split.tokenBuyback)}</span> of every claimed fee buys back and burns {token}; <span className="num">{pct0(split.protocolBuyback)}</span> burns ${BRAND.ticker}.
            </li>
          </>
        )}
        <li>
          Burned tokens go to <span className="num">{shortAddr(BURN_ADDRESS)}</span>, always. There is no hold mode, and every burn gets a public receipt.
        </li>
      </ol>
    </section>
  );
}
