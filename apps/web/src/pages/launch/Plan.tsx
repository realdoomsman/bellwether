import { BRAND, feeSplitFor, PROFIT_SPLIT, STRATEGIES } from '@stepup/shared';
import { sessionsText } from '../../components/StrategyFacts';
import { leverage, pct0, usd } from '../../lib/format';
import { useConfig } from '../../lib/queries';
import type { Draft } from './draft';

/** Plain-language description of exactly what the engine will do with this configuration. */
export function Plan({ draft }: { draft: Draft }) {
  const minCollateral = useConfig().data?.minCollateralUsd ?? null;
  const s = STRATEGIES[draft.strategy];
  const split = feeSplitFor(draft.strategy);
  const market = draft.market ?? 'your chosen stock';

  return (
    <div className="plan" aria-live="polite">
      <p className="panel-label">What the engine will do</p>
      <ol className="plan__list">
        {s.trades ? (
          <>
            <li>
              <strong className="num">{pct0(split.tokenBuyback)}</strong> of every claimed fee buys back and burns your token right away; <strong className="num">{pct0(split.protocolBuyback)}</strong> burns ${BRAND.ticker}.
            </li>
            <li>
              <strong className="num">{pct0(split.trading)}</strong> funds a <strong>long {market}</strong> perp at up to <strong className="num">{draft.maxLeverage === null ? leverage(s.maxLeverage) : leverage(draft.maxLeverage)}</strong>, entering only in: {sessionsText(s).toLowerCase()}.
            </li>
            <li>
              Hard stop at <span className="num">{pct0(s.stopLoss)}</span> of collateral; new entries halt for the day after losing <span className="num">{pct0(s.dailyLossLimit)}</span> of the trading budget.
            </li>
            <li>
              Realized profit: <span className="num">{pct0(PROFIT_SPLIT.tokenBuyback)}</span> burns your token, <span className="num">{pct0(PROFIT_SPLIT.protocolBuyback)}</span> burns ${BRAND.ticker}. Losses reduce the book.
            </li>
            {minCollateral !== null && <li>Trading starts once your book holds at least {usd(minCollateral)} of collateral; until then fees accumulate.</li>}
          </>
        ) : (
          <>
            <li>Never trades.</li>
            <li>
              <strong className="num">{pct0(split.tokenBuyback)}</strong> of every claimed fee buys back and burns your token; <strong className="num">{pct0(split.protocolBuyback)}</strong> burns ${BRAND.ticker}.
            </li>
          </>
        )}
        <li>Burned tokens go to 0x…dEaD. Always — there is no hold mode.</li>
      </ol>
    </div>
  );
}
