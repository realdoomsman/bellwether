import { BRAND, DEFAULT_STRATEGY, feeSplitFor, PROFIT_SPLIT, STRATEGIES, STRATEGY_IDS, type StrategyId } from '@bellwether/shared';
import { useId, useState, type CSSProperties } from 'react';
import { Segmented } from '../../components/Segmented';
import { leverageRange } from '../../components/StrategyFacts';
import { eth, pct0 } from '../../lib/format';

const STRATEGY_OPTIONS = STRATEGY_IDS.map((id) => ({ value: id, label: STRATEGIES[id].label }));

export function FeeCalculator() {
  const [amount, setAmount] = useState(1);
  const [strategy, setStrategy] = useState<StrategyId>(DEFAULT_STRATEGY);
  const sliderId = useId();
  const split = feeSplitFor(strategy);
  const s = STRATEGIES[strategy];
  const trading = amount * split.trading;
  const tokenBurn = amount * split.tokenBuyback;
  const protocolBurn = amount * split.protocolBuyback;
  const fill = `${((amount - 0.1) / (10 - 0.1)) * 100}%`;

  const buckets = [
    { key: 'trade', share: split.trading, value: trading, title: 'Trading book', note: s.trades ? `Bridged to USDC on Hyperliquid. Trades US-stock perps at ${leverageRange(s)}.` : 'Burn only never trades.' },
    { key: 'burn', share: split.tokenBuyback, value: tokenBurn, title: 'Burn your token', note: 'Bought on Uniswap V3 on Robinhood Chain and sent to 0x…dEaD right away.' },
    { key: 'protocol', share: split.protocolBuyback, value: protocolBurn, title: `Burn $${BRAND.ticker}`, note: `Buys and burns $${BRAND.ticker}, the protocol token.` },
  ].filter((b) => b.share > 0);

  return (
    <div className="calc">
      <div className="calc__controls card">
        <div className="field">
          <label className="field__label" htmlFor={sliderId}>
            Creator fees claimed
          </label>
          <output htmlFor={sliderId} className="calc__amount">
            <span className="fig">{amount.toFixed(amount < 1 ? 2 : 1)}</span> <span className="calc__unit">ETH</span>
          </output>
          <input
            id={sliderId}
            className="range"
            type="range"
            min={0.1}
            max={10}
            step={0.1}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            style={{ '--fill': fill } as CSSProperties}
          />
          <div className="spread field__hint">
            <span>0.1 ETH</span>
            <span>10 ETH</span>
          </div>
        </div>
        <div className="field">
          <span className="field__label" aria-hidden="true">
            Strategy
          </span>
          <Segmented label="Strategy" options={STRATEGY_OPTIONS} value={strategy} onChange={setStrategy} />
          <p className="field__hint">{s.tagline}</p>
        </div>
      </div>

      <figure className="flow" aria-label={`Of ${eth(amount)} in fees: ${buckets.map((b) => `${eth(b.value)} to ${b.title.toLowerCase()}`).join(', ')}.`}>
        <div className="flow__source">
          <span className="panel-label">In</span>
          <span className="num">{eth(amount)} creator fees</span>
        </div>
        <div className="flow__bar" aria-hidden="true">
          {buckets.map((b) => (
            <span key={b.key} className={`flow__seg flow__seg--${b.key}`} style={{ flexGrow: b.share }}>
              <span className="num">{pct0(b.share)}</span>
            </span>
          ))}
        </div>
        <div className="flow__dests">
          {buckets.map((b) => (
            <div key={b.key} className={`flow__dest flow__dest--${b.key}`}>
              <p className="flow__pct num">{pct0(b.share)}</p>
              <p className="flow__eth num">{eth(b.value)}</p>
              <p className="flow__title">{b.title}</p>
              <p className="flow__note">{b.note}</p>
              {b.key === 'trade' && (
                <div className="flow__profit">
                  <p className="panel-label">If a trade closes in profit</p>
                  <div className="flow__mini" aria-hidden="true">
                    <span style={{ flexGrow: PROFIT_SPLIT.tokenBuyback }}>{pct0(PROFIT_SPLIT.tokenBuyback)}</span>
                    <span style={{ flexGrow: PROFIT_SPLIT.protocolBuyback }}>{pct0(PROFIT_SPLIT.protocolBuyback)}</span>
                  </div>
                  <p className="flow__note">
                    {pct0(PROFIT_SPLIT.tokenBuyback)} of realized profit burns your token, {pct0(PROFIT_SPLIT.protocolBuyback)} burns ${BRAND.ticker}. Losses stay in the book — nothing is promised.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
        <figcaption className="flow__caption">
          <strong className="num brass">{eth(tokenBurn + protocolBurn)}</strong> ({pct0(split.tokenBuyback + split.protocolBuyback)}) is burned the moment fees are claimed — before any trade happens.
        </figcaption>
      </figure>
    </div>
  );
}
