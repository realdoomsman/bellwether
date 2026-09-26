import { BRAND, BURN_ADDRESS, FEE_SPLIT_BURN_ONLY, FEE_SPLIT_TRADING, LAUNCHPADS, PROFIT_SPLIT, STOCK_MARKETS, STRATEGIES } from '@stepup/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { pct0 } from '../lib/format';

/** Long-form copy shared by the landing page and the docs, so the two never disagree. */

export interface QA {
  q: string;
  a: ReactNode;
}

export const FAQ: QA[] = [
  {
    q: `What is ${BRAND.name}?`,
    a: (
      <p>
        A protocol for memecoins on Robinhood Chain. You launch a token on {LAUNCHPADS.pons.name} or {LAUNCHPADS.launchhood.name} with the {BRAND.name} wallet as its creator-fee recipient. The {BRAND.name} engine claims those fees,
        burns part of them into your token and ${BRAND.ticker} right away, and trades the rest as US-stock perps. Realized profit buys back and burns more.
      </p>
    ),
  },
  {
    q: 'Where exactly do the fees go?',
    a: (
      <p>
        Every claimed fee is split on the spot: {pct0(FEE_SPLIT_TRADING.trading)} to the trading book, {pct0(FEE_SPLIT_TRADING.tokenBuyback)} buys back and burns your token, {pct0(FEE_SPLIT_TRADING.protocolBuyback)} buys back and
        burns ${BRAND.ticker}. With the Burn only strategy it is {pct0(FEE_SPLIT_BURN_ONLY.tokenBuyback)} to your token and {pct0(FEE_SPLIT_BURN_ONLY.protocolBuyback)} to ${BRAND.ticker}. When a trade closes in profit,{' '}
        {pct0(PROFIT_SPLIT.tokenBuyback)} of the profit burns your token and {pct0(PROFIT_SPLIT.protocolBuyback)} burns ${BRAND.ticker}.
      </p>
    ),
  },
  {
    q: 'What does the engine trade?',
    a: (
      <p>
        Perpetual futures on US stocks — {STOCK_MARKETS.map((m) => m.symbol).join(', ')} — on Hyperliquid’s HIP-3 equity exchange, with USDC collateral bridged from Arbitrum. Which of those markets are open right now depends on
        the venue; the <Link to="/app">app</Link> shows live availability and leverage caps.
      </p>
    ),
  },
  {
    q: 'When does it trade?',
    a: (
      <p>
        Only in the sessions your strategy allows: {STRATEGIES.steady.label} trades regular NYSE hours, {STRATEGIES.balanced.label} adds pre-market and after hours, {STRATEGIES.degen.label} trades every session the venue
        offers. Exits and stops run in every session. The engine also needs a strong enough entry signal — if it isn’t there, it waits and tells you why.
      </p>
    ),
  },
  {
    q: 'What if a trade loses?',
    a: (
      <p>
        The loss comes out of your token’s trading book. Each strategy has a hard stop on collateral and a daily loss halt; leveraged positions can still be liquidated in fast markets. The share of fees that was already
        burned is never at risk — it is gone for good the moment fees are claimed.
      </p>
    ),
  },
  {
    q: 'Are tokens really burned?',
    a: (
      <p>
        Yes, always. Bought-back tokens are sent to <code className="break">{BURN_ADDRESS}</code>, an address nobody controls. There is no “hold in treasury” mode. Every burn in the activity feed links to its transaction.
      </p>
    ),
  },
  {
    q: 'Can I change my strategy later?',
    a: (
      <p>
        Yes. On your token’s page, connect the wallet that deployed the token, pick the new strategy, market or max leverage, and sign the message shown on screen (no gas, no approval). It names the site, your token and every setting, and works once. Nobody else can change it.
      </p>
    ),
  },
  {
    q: `What is $${BRAND.ticker}?`,
    a: (
      <p>
        The protocol token. {pct0(FEE_SPLIT_TRADING.protocolBuyback)} of every claimed fee and {pct0(PROFIT_SPLIT.protocolBuyback)} of all realized trading profit buy it back and burn it. The official contract address is shown in the
        footer when configured — anything else using the name is an impostor, and {BRAND.name} refuses to register look-alikes.
      </p>
    ),
  },
  {
    q: 'What is paper mode?',
    a: (
      <p>
        A mode where the engine uses real prices and real on-chain reads but simulates every trade, claim and burn. A banner is shown on every page, and paper transactions are labeled “paper” and never linked to an explorer.
      </p>
    ),
  },
  {
    q: 'Why not Ostium?',
    a: <p>Ostium paused its markets after an oracle exploit in July 2026. {BRAND.name} does not route to a venue in that state; Hyperliquid is the only venue today.</p>,
  },
  {
    q: 'Is it audited?',
    a: <p>No. The code is open source and every action is on-chain and reconciled publicly on the Proof page, but there has been no third-party audit. Size your expectations accordingly.</p>,
  },
];

export interface Risk {
  title: string;
  body: ReactNode;
}

export const RISKS: Risk[] = [
  {
    title: 'Leverage and liquidation',
    body: `Positions use ${STRATEGIES.steady.minLeverage}–${STRATEGIES.degen.maxLeverage}× leverage. Stops can slip in fast markets and positions can be liquidated. A token’s trading book can go to zero.`,
  },
  {
    title: 'Off-chain engine custody',
    body: 'The engine is an off-chain program that holds the protocol wallet’s private key. There is no smart-contract vault: a bug, an operator mistake or a key compromise could lose funds.',
  },
  {
    title: 'Venue risk',
    body: 'Stock perps are young markets. Venues can halt, change rules or be exploited — Ostium was paused after its July 2026 oracle exploit. Funds on a venue are exposed to that venue.',
  },
  {
    title: 'Market gaps and hours',
    body: 'Perps trade while the underlying stock market is closed. Prices can gap at the open, and weekend or overnight liquidity is thin.',
  },
  {
    title: 'Bridging and swaps',
    body: 'Fees move from Robinhood Chain to Arbitrum and Hyperliquid and back. Bridges and swaps add delay, slippage and their own risks.',
  },
  {
    title: 'Unaudited, not advice',
    body: 'The software is unaudited. Memecoins are extremely volatile and buybacks do not guarantee any price. Nothing here is financial advice.',
  },
];
