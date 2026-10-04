import { BRAND, BURN_ADDRESS, CHAINS, FEE_SPLIT_BURN_ONLY, FEE_SPLIT_TRADING, LAUNCHPADS, PROFIT_SPLIT, STOCK_MARKETS, STRATEGIES } from '@bellwether/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Term } from '../components/Term';
import { pct0, shortAddr } from '../lib/format';
import { siteHost } from '../lib/site';

/**
 * Long-form copy shared by the landing page and the docs, so the two never disagree. Every number
 * comes from @bellwether/shared, the same module the engine runs. Answers are plain <p> blocks; risk
 * bodies are inline content (callers wrap them in their own <p>).
 */

export interface QA {
  /** Stable anchor, e.g. /docs#faq-custody. */
  id: string;
  q: string;
  a: ReactNode;
}

const TICKER = `$${BRAND.ticker}`;
const burnedAtClaim = FEE_SPLIT_TRADING.tokenBuyback + FEE_SPLIT_TRADING.protocolBuyback;

export const FAQ: QA[] = [
  {
    id: 'what',
    q: `What is ${BRAND.name}?`,
    a: (
      <p>
        A fee engine for memecoins on {CHAINS.rhc.name}. You launch a token on {LAUNCHPADS.pons.name} or {LAUNCHPADS.launchhood.name} and name the {BRAND.name} wallet as its creator-fee recipient. The engine
        claims those fees, buys back and burns part of them straight away, and trades the rest as US-stock perps. When a trade closes in profit, the profit buys back and burns more. Every burn is a ring of the bell, and
        every ring comes with a receipt.
      </p>
    ),
  },
  {
    id: 'fees',
    q: 'Where does each fee go?',
    a: (
      <p>
        It is split the moment it is claimed: {pct0(FEE_SPLIT_TRADING.trading)} funds your token’s trading book, {pct0(FEE_SPLIT_TRADING.tokenBuyback)} buys back and burns your token, and{' '}
        {pct0(FEE_SPLIT_TRADING.protocolBuyback)} buys back and burns {TICKER}. On the {STRATEGIES.burn.label} strategy it is {pct0(FEE_SPLIT_BURN_ONLY.tokenBuyback)} to your token and{' '}
        {pct0(FEE_SPLIT_BURN_ONLY.protocolBuyback)} to {TICKER}. Realized trading profit is split {pct0(PROFIT_SPLIT.tokenBuyback)} to your token’s burn and {pct0(PROFIT_SPLIT.protocolBuyback)} to {TICKER}’s.
      </p>
    ),
  },
  {
    id: 'trades',
    q: 'What does the engine trade?',
    a: (
      <p>
        Long <Term id="perp">perps</Term> on US stocks ({STOCK_MARKETS.map((m) => m.symbol).join(', ')}) on Hyperliquid, with USDC collateral bridged in from {CHAINS.arbitrum.name}. Each token picks one market.
        Whether a market is tradable right now, and at what leverage, is up to the venue; the <Link to="/app">live page</Link> shows both.
      </p>
    ),
  },
  {
    id: 'when',
    q: 'When does it trade?',
    a: (
      <p>
        The perps trade 24/7, nights, weekends and holidays included, so when to enter is a risk choice your strategy makes. {STRATEGIES.steady.label} enters only during regular NYSE hours,{' '}
        {STRATEGIES.balanced.label} adds pre-market and after hours, and {STRATEGIES.degen.label} enters around the clock. Every entry also needs a strong enough <Term id="signal">signal</Term>; when there isn’t
        one it waits and says so on your token’s page. Stops and exits run 24/7 for every strategy.
      </p>
    ),
  },
  {
    id: 'losses',
    q: 'What happens when a trade loses?',
    a: (
      <p>
        The loss comes out of your token’s trading book and nowhere else. Every strategy has a hard stop and a daily loss halt, but stops can slip and leveraged positions can be liquidated, so the book can reach zero. The{' '}
        {pct0(burnedAtClaim)} burned at claim time is never at risk: it was gone before any trade opened.
      </p>
    ),
  },
  {
    id: 'burns',
    q: 'Are the burns real?',
    a: (
      <p>
        On the live engine, yes. Bought-back tokens go to <code className="break">{shortAddr(BURN_ADDRESS, 10, 6)}</code>, an address nobody holds a key to, and each burn links to its transaction. There is no treasury
        mode. In paper mode the burns are simulated: they are labelled PAPER and never link to an explorer.
      </p>
    ),
  },
  {
    id: 'custody',
    q: 'Who holds the keys?',
    a: (
      <p>
        The engine does. It is off-chain software, run by the {BRAND.name} operator, that holds the protocol wallet’s private key on a server: a hot key, not a smart-contract vault and not a multisig. It has to sign
        claims, swaps, bridges and orders around the clock. Whoever controls that key controls whatever the wallet holds at that moment: unspent burn budgets, bridge transfers in flight, and the trading book on
        Hyperliquid. The <Link to="/proof">Proof page</Link> shows those balances and reconciles them against the ledger.
      </p>
    ),
  },
  {
    id: 'settings',
    q: 'Can I change my token’s settings later?',
    a: (
      <p>
        Yes, if you deployed it. On the token’s page, connect the deploying wallet, choose the strategy, market and maximum leverage, and sign the message shown. It names the site, the chain, your token and every setting,
        expires after ten minutes, and works once. Signing costs no gas and sends nothing on-chain. Only sign it on {siteHost()}.
      </p>
    ),
  },
  {
    id: 'bell',
    q: `What is ${TICKER}?`,
    a: (
      <p>
        {BRAND.name}’s own token. {pct0(FEE_SPLIT_TRADING.protocolBuyback)} of every claimed fee and {pct0(PROFIT_SPLIT.protocolBuyback)} of every realized profit buy it back and burn it. Its contract address is
        published in the site footer once it exists. Until then, anything calling itself {TICKER} is an impostor, and the engine refuses to register tokens that imitate it.
      </p>
    ),
  },
  {
    id: 'paper',
    q: 'What is paper mode?',
    a: (
      <p>
        A dry run. Prices and on-chain reads are real, but the engine’s claims, trades, bridges and burns are simulated and no funds move. While it is on, a line at the top of every page says so and every simulated
        amount carries a PAPER label.
      </p>
    ),
  },
  {
    id: 'ostium',
    q: 'Why Hyperliquid and not Ostium?',
    a: (
      <p>
        Ostium paused its markets after an oracle exploit in July 2026. The engine does not trade on a venue in that state, so Hyperliquid is the only venue today. If a venue pauses a market, new entries there stop and the
        pause is shown on the live page.
      </p>
    ),
  },
  {
    id: 'audit',
    q: 'Has it been audited?',
    a: (
      <p>
        No. The code is open source, every action is recorded with its transactions, and the ledger is reconciled in public, but no third party has audited the engine. Treat it as experimental software.
      </p>
    ),
  },
];

export interface Risk {
  id: string;
  title: string;
  body: ReactNode;
}

export const RISKS: Risk[] = [
  {
    id: 'leverage',
    title: 'Leverage and liquidation',
    body: `Positions run at ${STRATEGIES.steady.minLeverage}× to ${STRATEGIES.degen.maxLeverage}× leverage depending on the strategy. At 10× a 10% move against a position wipes out its collateral. Stops can slip in fast markets, positions can be liquidated, and a token’s trading book can go to zero.`,
  },
  {
    id: 'custody',
    title: 'A hot key, not a vault',
    body: 'The engine is off-chain software that holds the protocol wallet’s private key on a server. There is no smart-contract vault and no multisig. A bug, an operator mistake or a stolen key could lose whatever the wallet and its venue account hold at the time.',
  },
  {
    id: 'venue',
    title: 'Venue risk',
    body: 'Stock perps are young markets. A venue can halt trading, change its rules, or be exploited: Ostium paused its markets after an oracle exploit in July 2026. Collateral on a venue is exposed to that venue.',
  },
  {
    id: 'hours',
    title: 'Gaps and thin hours',
    body: 'The perps trade 24/7, but outside US hours there is no live stock price: the venue prices them off its own order book within capped bands, and they snap back to the real price at the next US open. Prices can gap then, and overnight, weekend and holiday liquidity is thin, so fills (stops included) can be worse than the mark.',
  },
  {
    id: 'plumbing',
    title: 'Bridges, swaps and launchpads',
    body: `Fees move from ${CHAINS.rhc.name} to ${CHAINS.arbitrum.name} to Hyperliquid and back, and buybacks swap on thin DEX pools. Each hop adds delay, slippage and its own contract risk. Launchpads control how fees are paid: ${LAUNCHPADS.launchhood.name}’s admin can change a token’s reward recipient.`,
  },
  {
    id: 'unaudited',
    title: 'Unaudited, and not advice',
    body: 'The software has not been audited. Memecoins are extremely volatile, and buybacks guarantee no price. Nothing on this site is financial advice or an offer.',
  },
];
