import type { TradeAction, TradeView } from '@bellwether/shared';
import { useState } from 'react';
import { etDateTime, price, relTime, usd } from '../lib/format';
import { useMediaQuery, useNow } from '../lib/hooks';
import { KIND_GLYPH, KIND_TONE } from './activityMeta';
import { TxLinks } from './Links';
import { Pnl } from './Stat';

const ACTION_LABEL: Record<TradeAction, string> = { open: 'Open', reduce: 'Take profit', close: 'Close', stop: 'Stop', liquidated: 'Liquidated' };

function Action({ t }: { t: TradeView }) {
  const tone = KIND_TONE[t.action];
  return (
    <span className="trade-act">
      <span className={`trade-act__glyph ${tone === 'up' || tone === 'down' ? tone : ''}`} aria-hidden="true">
        {KIND_GLYPH[t.action]}
      </span>
      {ACTION_LABEL[t.action]}
    </span>
  );
}

function Side({ t }: { t: TradeView }) {
  return (
    <span className="trade-side">
      <span className="trade-mkt">
        {t.market}
        <span className="trade-mkt__perp">-PERP</span>
      </span>
      <span className={t.side === 'long' ? 'up' : 'down'}>{t.side === 'long' ? 'Long' : 'Short'}</span>
    </span>
  );
}

/**
 * Engine trades, newest first: when, market, action and the engine's reason, then the money. Below
 * 768 px each trade is a two-line row (what happened and its result, then the details), never a card.
 * `limit` shows the newest few with a control to reveal the rest.
 */
export function TradesTable({ trades, caption, limit }: { trades: TradeView[]; caption: string; limit?: number }) {
  const now = useNow();
  // Phones read each trade as one two-line cell; only the layout on screen is rendered.
  const twoLine = useMediaQuery('(max-width: 767px)');
  const [all, setAll] = useState(false);
  const shown = all || limit === undefined ? trades : trades.slice(0, limit);
  const hidden = trades.length - shown.length;
  return (
    <div className="trades">
      <div className="table-wrap">
        <table className="table xtable trades__table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {twoLine ? (
              <tr>
                <th scope="col" className="xtable__m">
                  Trade
                </th>
              </tr>
            ) : (
              <tr>
                <th scope="col" className="xtable__d">
                  When
                </th>
                <th scope="col" className="xtable__d">
                  Market
                </th>
                <th scope="col" className="xtable__d">
                  Action
                </th>
                <th scope="col" className="xtable__d xtable__wide">
                  Reason
                </th>
                <th scope="col" className="xtable__d r">
                  Size
                </th>
                <th scope="col" className="xtable__d r">
                  Price
                </th>
                <th scope="col" className="xtable__d r">
                  Realized
                </th>
                <th scope="col" className="xtable__d r xtable__wide">
                  Fee
                </th>
                <th scope="col" className="xtable__d">
                  Tx
                </th>
              </tr>
            )}
          </thead>
          <tbody>
            {shown.map((t) =>
              twoLine ? (
                <tr key={t.id}>
                  <td className="xtable__m">
                    <span className="xtable__line">
                      <span className="xtable__lead">
                        <Action t={t} /> <span className="trade-mkt">{t.market}</span>
                      </span>
                      {t.action === 'open' ? <span className="num">{usd(t.sizeUsd)}</span> : <Pnl value={t.realizedPnlUsd} />}
                    </span>
                    <span className="xtable__sub dots">
                      <time dateTime={new Date(t.at).toISOString()}>{relTime(Math.min(t.at, now), now)}</time>
                      <span>{t.reason}</span>
                      <span className="num">
                        {usd(t.sizeUsd)} at {price(t.price)}
                      </span>
                      {t.tx && <TxLinks txs={[t.tx]} />}
                    </span>
                  </td>
                </tr>
              ) : (
                <tr key={t.id}>
                  <td className="xtable__d num trades__when">
                    <time dateTime={new Date(t.at).toISOString()} title={etDateTime(t.at)}>
                      {relTime(Math.min(t.at, now), now)}
                    </time>
                  </td>
                  <td className="xtable__d">
                    <Side t={t} />
                  </td>
                  <td className="xtable__d">
                    <Action t={t} />
                    <span className="trades__why-inline">{t.reason}</span>
                  </td>
                  <td className="xtable__d xtable__wide trades__why">{t.reason}</td>
                  <td className="xtable__d r num">{usd(t.sizeUsd)}</td>
                  <td className="xtable__d r num">{price(t.price)}</td>
                  <td className="xtable__d r">{t.action === 'open' ? <span className="muted">—</span> : <Pnl value={t.realizedPnlUsd} />}</td>
                  <td className="xtable__d r num xtable__wide">{usd(t.feeUsd)}</td>
                  <td className="xtable__d">{t.tx ? <TxLinks txs={[t.tx]} /> : <span className="muted">—</span>}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <button type="button" className="link-btn trades__more" onClick={() => setAll(true)}>
          Show {hidden} older {hidden === 1 ? 'trade' : 'trades'}
        </button>
      )}
    </div>
  );
}
