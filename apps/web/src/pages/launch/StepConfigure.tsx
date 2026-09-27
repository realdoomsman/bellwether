import { leverageBounds, STRATEGIES, type MarketView } from '@bellwether/shared';
import { useEffect, type ReactNode } from 'react';
import { useMarkets } from '../../lib/queries';
import type { Draft } from './draft';
import { FeeSplit } from './FeeSplit';
import { Leverage } from './Leverage';
import { MarketPicker } from './MarketPicker';
import { StepHead, StepNav } from './StepFrame';
import { StrategyPicker } from './StrategyPicker';

function Part({ n, title, aside, children }: { n: string; title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="lw-part" aria-label={typeof title === 'string' ? title : undefined}>
      <div className="lw-part__head">
        <h3 className="lw-sub">
          <span className="lw-sub__n num">{n}</span>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function StepConfigure({ draft, update, back, next, walletLive }: { draft: Draft; update: (p: Partial<Draft>) => void; back: () => void; next: () => void; walletLive: boolean | null }) {
  const markets = useMarkets();
  const s = STRATEGIES[draft.strategy];
  const market: MarketView | null = markets.data?.markets.find((m) => m.symbol === draft.market) ?? null;
  // Same bound the engine enforces at registration: leverageBounds(strategy, market's venue cap).
  const venueCap = market?.maxLeverage ?? null;
  const bounds = leverageBounds(draft.strategy, venueCap ?? s.maxLeverage);
  const lev = !s.trades || bounds === 'unavailable' ? null : Math.min(bounds.max, Math.max(bounds.min, draft.maxLeverage ?? bounds.max));

  // Keep the stored cap inside the current bounds as the market and strategy change.
  useEffect(() => {
    if (draft.maxLeverage !== lev) update({ maxLeverage: lev });
  }, [lev, draft.maxLeverage, update]);

  const offVenue = market?.available === false;
  const blocked = s.trades && bounds === 'unavailable';
  const canNext = draft.market !== null && !offVenue && !blocked && walletLive !== false;
  let why: string | undefined;
  if (!draft.market) why = 'Pick a stock to continue.';
  else if (offVenue) why = `${draft.market} isn’t on the venue right now. Pick another stock.`;
  else if (blocked) why = `${s.label} can’t trade ${draft.market}. Pick another strategy or stock.`;
  else if (walletLive === false) why = 'Launching opens once the wallet is live.';

  return (
    <form
      className="lw-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (canNext) next();
      }}
    >
      <StepHead
        n={2}
        title="Configure the engine"
        lede="Choose the stock your token’s trading book goes long on, how the engine trades it, and the most leverage it may use. The token’s deployer can change these later with a signature."
      />

      <Part n="2.1" title="Market">
        <MarketPicker value={draft.market} onChange={(symbol) => update({ market: symbol })} />
        <p className="lw-dir">
          <span className="lw-dir__long">
            <span aria-hidden="true">▲</span> Long
          </span>{' '}
          only for now. Shorts aren’t available yet, so every token’s book trades long.
        </p>
      </Part>

      <Part n="2.2" title="Strategy">
        <StrategyPicker value={draft.strategy} onChange={(strategy) => update({ strategy })} />
      </Part>

      <Part n="2.3" title="Leverage cap">
        <Leverage
          strategy={draft.strategy}
          symbol={draft.market}
          venueCap={venueCap}
          bounds={bounds}
          value={lev}
          onChange={(maxLeverage) => update({ maxLeverage })}
          onStrategy={(strategy) => update({ strategy })}
        />
      </Part>

      <Part n="2.4" title="Where 1 ETH of fees goes">
        <FeeSplit strategy={draft.strategy} market={draft.market} lev={lev} />
      </Part>

      <StepNav onBack={back} canNext={canNext} why={why} />
    </form>
  );
}
