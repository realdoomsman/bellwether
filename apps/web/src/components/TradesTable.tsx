import type { TradeAction, TradeView } from '@floor/shared';
import { dateTime, price, relTime, usd } from '../lib/format';
import { useNow } from '../lib/hooks';
import { TxLinks } from './Links';
import { Pnl } from './Stat';

const ACTION_LABEL: Record<TradeAction, string> = { open: 'Open', reduce: 'Take profit', close: 'Close', stop: 'Stop', liquidated: 'Liquidated' };

/** Engine trades, newest first. Collapses to labelled cards below 768px. */
export function TradesTable({ trades, caption }: { trades: TradeView[]; caption: string }) {
  const now = useNow();
  return (
    <div className="table-wrap">
      <table className="table table--stack trades">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Market</th>
            <th scope="col">Action</th>
            <th scope="col" className="r">
              Size
            </th>
            <th scope="col" className="r">
              Price
            </th>
            <th scope="col" className="r">
              Realized
            </th>
            <th scope="col" className="r">
              Fee
            </th>
            <th scope="col">Tx</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td data-label="When" className="num">
                <time dateTime={new Date(t.at).toISOString()} title={dateTime(t.at)}>
                  {relTime(t.at, now)}
                </time>
              </td>
              <td data-label="Market">
                <div>
                  <span className="trade-act num">{t.market}</span>
                  <span className="trade-why">
                    <span className={t.side === 'long' ? 'up' : 'down'}>{t.side === 'long' ? '▲ Long' : '▼ Short'}</span>
                  </span>
                </div>
              </td>
              <td data-label="Action">
                <div>
                  <span className="trade-act">{ACTION_LABEL[t.action]}</span>
                  <span className="trade-why">{t.reason}</span>
                </div>
              </td>
              <td data-label="Size" className="r num">
                {usd(t.sizeUsd)}
              </td>
              <td data-label="Price" className="r num">
                {price(t.price)}
              </td>
              <td data-label="Realized" className="r">
                {t.action === 'open' ? <span className="muted">—</span> : <Pnl value={t.realizedPnlUsd} />}
              </td>
              <td data-label="Fee" className="r num">
                {usd(t.feeUsd)}
              </td>
              <td data-label="Tx">{t.tx ? <TxLinks txs={[t.tx]} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
