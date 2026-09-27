import { BRAND, BURN_ADDRESS, CHAINS, DEFAULT_STRATEGY, feeSplitFor, PROFIT_SPLIT, STRATEGIES, STRATEGY_IDS, type StrategyId } from '@bellwether/shared';
import { useId, useState, type CSSProperties } from 'react';
import { Muted, Section } from '../../components/Primitives';
import { Reveal } from '../../components/Reveal';
import { RollingNumber } from '../../components/RollingNumber';
import { Segmented } from '../../components/Segmented';
import { leverageRange, sessionsText } from '../../components/StrategyFacts';
import { Term } from '../../components/Term';
import { eth, pct0, shortAddr } from '../../lib/format';
import { useSessionClock } from '../../lib/session';

const MIN_ETH = 0.1;
const MAX_ETH = 10;
const TICKER = `$${BRAND.ticker}`;
const OPTIONS = STRATEGY_IDS.map((id) => ({ value: id, label: STRATEGIES[id].label }));

/** Ledger precision for the split: three decimals keeps the three destinations aligned as they roll. */
const ETH_FORMAT = { minimumFractionDigits: 3, maximumFractionDigits: 3 } as const;

type BucketKey = 'trade' | 'token' | 'bell';

function EthFigure({ value }: { value: number }) {
  return value === 0 ? <span className="ld-split__zero">0</span> : <RollingNumber value={value} format={ETH_FORMAT} />;
}

/**
 * §2 How the money moves: the fee split as an annual-report figure. Drag the ETH claimed, pick a
 * strategy; the 100% bar re-divides and each destination's figure rolls to its new value. Every
 * number is the engine's own constant (FEE_SPLIT / PROFIT_SPLIT / STRATEGIES in @bellwether/shared).
 */
export function FeeSplit({ n }: { n: number }) {
  const [amount, setAmount] = useState(1);
  const [id, setId] = useState<StrategyId>(DEFAULT_STRATEGY);
  const [flash, setFlash] = useState<{ n: number; keys: BucketKey[] }>({ n: 0, keys: [] });
  const sliderId = useId();
  const clock = useSessionClock();
  const s = STRATEGIES[id];
  const split = feeSplitFor(id);
  const burnedShare = split.tokenBuyback + split.protocolBuyback;
  const burnRoute = `Uniswap V3 → ${shortAddr(BURN_ADDRESS)}`;

  const buckets: { key: BucketKey; share: number; title: string; note: string; route: string }[] = [
    {
      key: 'trade',
      share: split.trading,
      title: 'Trades stock perps',
      note: s.trades
        ? `Bridged to USDC on Hyperliquid and traded as US-stock perps at ${leverageRange(s)} leverage, entering in: ${sessionsText(s).toLowerCase()}.`
        : `${s.label} never trades. This share buys back your token instead.`,
      route: s.trades ? `${CHAINS.rhc.name} → Arbitrum → Hyperliquid` : 'Not used',
    },
    {
      key: 'token',
      share: split.tokenBuyback,
      title: 'Burns your token',
      note: `Bought on ${CHAINS.rhc.name} the moment fees are claimed and sent to the burn address, where nobody can move it.`,
      route: burnRoute,
    },
    {
      key: 'bell',
      share: split.protocolBuyback,
      title: `Burns ${TICKER}`,
      note: `Buys back ${TICKER}, the protocol token, the same way. Every token launched here feeds it.`,
      route: burnRoute,
    },
  ];

  let x = 0;
  const placed = buckets.map((b) => {
    const at = { ...b, x, value: amount * b.share };
    x += b.share;
    return at;
  });

  const pick = (next: StrategyId) => {
    if (next === id) return;
    const was = feeSplitFor(id);
    const now = feeSplitFor(next);
    const keys: BucketKey[] = [];
    if (was.trading !== now.trading) keys.push('trade');
    if (was.tokenBuyback !== now.tokenBuyback) keys.push('token');
    if (was.protocolBuyback !== now.protocolBuyback) keys.push('bell');
    setFlash((f) => ({ n: f.n + 1, keys }));
    setId(next);
  };

  const entersNow = s.sessions.includes(clock.session);
  const sessionNote = !s.trades
    ? `${s.label} burns every claimed fee in full. No trading book, no session to wait for.`
    : entersNow
      ? `${clock.label} now: ${s.label} may open a position this session when the signal is strong enough.`
      : `${clock.label} now: ${s.label} waits for its sessions (${sessionsText(s).toLowerCase()}). Burns happen at claim either way.`;

  const described = placed.map((b) => `${pct0(b.share)}, ${eth(b.value)}, ${b.title.toLowerCase()}`).join('; ');

  return (
    <Section
      id="fees"
      n={n}
      label="How the money moves"
      className="ld-money"
      title={
        <>
          Every fee has a job. <Muted>Trade the market, buy back, burn, with a receipt for each step.</Muted>
        </>
      }
      lede="Drag the amount and pick a strategy. These are the exact splits the engine enforces on every claim: no projections, no assumed returns."
    >
      <div className="ld-split">
        <div className="ld-split__controls">
          <div className="field ld-split__amount-field">
            <label className="field__label" htmlFor={sliderId}>
              Creator fees claimed
            </label>
            <output htmlFor={sliderId} className="ld-split__amount" aria-live="off">
              <span className="fig">{amount.toFixed(1)}</span>
              <span className="ld-split__unit">ETH</span>
            </output>
            <input
              id={sliderId}
              className="range ld-split__range"
              type="range"
              min={MIN_ETH}
              max={MAX_ETH}
              step={0.1}
              value={amount}
              aria-valuetext={`${amount.toFixed(1)} ETH`}
              style={{ '--fill': `${((amount - MIN_ETH) / (MAX_ETH - MIN_ETH)) * 100}%` } as CSSProperties}
              onChange={(e) => setAmount(Number(e.currentTarget.value))}
            />
            <div className="ld-split__scale num" aria-hidden="true">
              <span>{MIN_ETH} ETH</span>
              <span>{MAX_ETH} ETH</span>
            </div>
          </div>
          <div className="field">
            <span className="field__label" aria-hidden="true">
              Strategy
            </span>
            <Segmented label="Strategy" options={OPTIONS} value={id} onChange={pick} size="sm" />
            <p className="ld-split__tagline">
              <strong>{s.tagline}.</strong> {s.trades ? `${leverageRange(s)} leverage, hard stop at ${pct0(s.stopLoss)} of collateral.` : 'The trading share is burned too.'}
            </p>
          </div>
          <p className="ld-split__session small">{sessionNote}</p>
        </div>

        <Reveal as="figure" className="ld-split__figure">
          <figcaption className="ld-split__caption">
            <span className="label">Fig. {n}</span> Where {eth(amount)} of claimed fees goes under {s.label}
          </figcaption>

          <div className="ld-split__chart" role="img" aria-label={`Of ${eth(amount)} claimed: ${described}.`}>
            <div className="ld-split__pcts" aria-hidden="true">
              {placed.map((b) => (
                <span key={b.key} className="ld-split__pct" data-empty={b.share === 0 || undefined} style={{ '--c': b.x + b.share / 2 } as CSSProperties}>
                  <RollingNumber value={b.share} format={{ style: 'percent', maximumFractionDigits: 0 }} className="num" />
                </span>
              ))}
            </div>
            <div className="ld-split__bar" aria-hidden="true">
              {placed.map((b) => (
                <span key={b.key} className={`ld-split__seg ld-split__seg--${b.key}`} style={{ '--x': b.x, '--w': b.share } as CSSProperties} />
              ))}
              {placed.slice(1).map((b) => (
                <span key={b.key} className="ld-split__cut" style={{ '--x': b.x } as CSSProperties} />
              ))}
            </div>
          </div>

          <ol className="ld-split__dests">
            {placed.map((b) => (
              <li key={b.key} className={`ld-split__dest ld-split__dest--${b.key}`} data-empty={b.share === 0 || undefined}>
                {flash.keys.includes(b.key) && <span key={flash.n} className="ld-split__flash" aria-hidden="true" />}
                <p className="ld-split__dest-head">
                  <span className={`ld-split__key ld-split__key--${b.key}`} aria-hidden="true" />
                  {b.title}
                  <span className="num ld-split__dest-pct">{pct0(b.share)}</span>
                </p>
                <p className="ld-split__dest-fig fig">
                  <EthFigure value={b.value} />
                  <span className="ld-split__unit">ETH</span>
                </p>
                <p className="ld-split__note">{b.note}</p>
                <p className="ld-split__route num">{b.route}</p>
              </li>
            ))}
          </ol>

          <div className="ld-split__loop" data-off={!s.trades || undefined} aria-hidden="true">
            <span className="ld-split__loop-down" />
            <span className="ld-split__loop-across" />
            <span className="ld-split__loop-up ld-split__loop-up--token" />
            <span className="ld-split__loop-up ld-split__loop-up--bell" />
            <span className="ld-split__loop-tag ld-split__loop-tag--start">Realized profit</span>
            <span className="ld-split__loop-tag ld-split__loop-tag--token num">{pct0(PROFIT_SPLIT.tokenBuyback)}</span>
            <span className="ld-split__loop-tag ld-split__loop-tag--bell num">{pct0(PROFIT_SPLIT.protocolBuyback)}</span>
          </div>

          <div className="ld-split__totals">
            <p className="ld-split__total">
              <span className="label">Burned at claim, before any trade</span>
              <span className="ld-split__total-fig fig">
                <EthFigure value={amount * burnedShare} />
                <span className="ld-split__unit">ETH</span>
              </span>
              <span className="small muted">{pct0(burnedShare)} of every claim. It can’t be lost to a bad trade.</span>
            </p>
            <p className="ld-split__total">
              <span className="label">When a trade closes in profit</span>
              {s.trades ? (
                <span className="ld-split__profit">
                  {pct0(PROFIT_SPLIT.tokenBuyback)} of realized profit burns your token and {pct0(PROFIT_SPLIT.protocolBuyback)} burns {TICKER}. Losses stay in the trading book; they never touch what’s already burned.
                </span>
              ) : (
                <span className="ld-split__profit">{s.label} has no trading book, so there’s no profit to return. Every claim is burned in full.</span>
              )}
            </p>
          </div>
          <p className="ld-split__source small muted">
            Splits are the engine’s own constants from its shared config, the same code that executes each <Term id="buyback">buyback</Term>. Nothing on this figure is a forecast.
          </p>
        </Reveal>
      </div>
    </Section>
  );
}
