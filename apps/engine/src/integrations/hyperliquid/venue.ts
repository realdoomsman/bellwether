/**
 * Hyperliquid HIP-3 equity perps (builder dex `xyz`) as a Venue.
 * Positions are isolated; "market" orders are IOC limits at mark ± slippage.
 * Builder-dex margin is segregated: USDC must be moved from the default perp dex into the
 * builder dex (`sendAsset`) before it can margin trades.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeFunctionData, erc20Abi, formatUnits } from 'viem';
import type { Address, LocalAccount } from 'viem';
import type { Side } from '@bellwether/shared';
import type { ExitFill, Fill, OpenRequest, TxReceiptRef, Venue, VenueMarket, VenuePosition } from '../../ports.ts';
import { log } from '../../log.ts';
import type { Client } from '../chains.ts';
import { ReadOnlyError, shortError } from '../errors.ts';
import { fetchJson } from '../http.ts';
import type { TxSender } from '../tx.ts';
import { floatToWire, floorSize, roundPrice } from './format.ts';
import type { HlAsset, HlFill, HlInfo, HlPosition } from './info.ts';
import { SEND_ASSET_FIELDS, signL1Action, signUserSignedAction } from './signing.ts';
import type { HlSignature } from './signing.ts';

const MIN_ORDER_USD = 10;
/** Bridge2 rule: deposits below 5 USDC are lost. */
const MIN_BRIDGE_DEPOSIT_USDC = 5;
const MIN_DEX_TRANSFER_USD = 1;
const USDC_DECIMALS = 6;
const ARBITRUM_SIGNATURE_CHAIN_ID = '0xa4b1';
const CREDIT_WAIT = { pollMs: 10_000, timeoutMs: 180_000 };
const FILL_POLL_MS = 700;
const FILL_POLL_ATTEMPTS = 10;
/** Base perp taker rate (tier 0, no discounts): the fee estimate when `userFees` can't be read is never under it. */
const BASE_TAKER_RATE = 0.00045;
const ZERO_HASH = /^0x0*$/;

export interface HlTrader {
  account: LocalAccount;
  arbitrum: Client;
  arbitrumSender: TxSender;
  arbitrumUsdc: Address;
  /** Hyperliquid Bridge2 on Arbitrum. */
  bridge: Address;
}

export interface HyperliquidVenueOptions {
  info: HlInfo;
  dex: string;
  user: Address;
  /** Null = read-only: every write throws ReadOnlyError. */
  trader: HlTrader | null;
  /** How long a top-up polls for a Bridge2 deposit to be credited (defaults: every 10 s for 3 min). */
  creditWait?: { pollMs: number; timeoutMs: number };
}

interface OrderStatus {
  filled?: { totalSz: string; avgPx: string; oid: number };
  resting?: { oid: number };
  error?: string;
}

interface ExchangeResponse {
  status: 'ok' | 'err';
  response: string | { type: string; data?: { statuses: (OrderStatus | string)[] } };
}

function positionCollateral(p: HlPosition): number {
  // Isolated marginUsed is the position's equity, rawUsd + szi × mark (checked against live xyz positions), so it
  // includes unrealized PnL; the posted collateral (funding included) excludes it.
  const margin = Number(p.marginUsed);
  return p.leverage.type === 'isolated' ? margin - Number(p.unrealizedPnl) : margin;
}

/**
 * Taker fee rate of `a` for a user paying `userCrossRate` with `referralDiscount` (Hyperliquid docs, Trading → Fees,
 * "Fee formula for developers"): HIP-3 perps scale the rate by the deployer fee scale, growth mode cuts it by 90%.
 * xyz is margined in USDC, not an aligned quote asset, so no aligned-collateral discount applies.
 */
export function takerFeeRate(userCrossRate: number, referralDiscount: number, a: Pick<HlAsset, 'deployerFeeScale' | 'growthMode'>): number {
  const hip3Scale = a.deployerFeeScale < 1 ? a.deployerFeeScale + 1 : a.deployerFeeScale * 2;
  return userCrossRate * hip3Scale * (a.growthMode ? 0.1 : 1) * (1 - referralDiscount);
}

export function updateLeverageAction(a: HlAsset, leverage: number) {
  return { type: 'updateLeverage', asset: a.assetId, isCross: false, leverage };
}

/** "Market" order: IOC limit at mark ± slippage, price rounded to the asset's tick rules. */
export function iocOrderAction(a: HlAsset, isBuy: boolean, size: number, slippageBps: number, reduceOnly: boolean) {
  const slip = slippageBps / 10_000;
  const px = roundPrice(a.markPx * (isBuy ? 1 + slip : 1 - slip), a.szDecimals);
  return {
    type: 'order',
    orders: [{ a: a.assetId, b: isBuy, p: floatToWire(px), s: floatToWire(size), r: reduceOnly, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  };
}

/** Moves `amountUsd` of the collateral token (`name:tokenId`) from the default perp dex into `dex`. */
export function sendAssetAction(isMainnet: boolean, user: Address, dex: string, token: string, amountUsd: number, nonce: number) {
  return {
    type: 'sendAsset',
    signatureChainId: ARBITRUM_SIGNATURE_CHAIN_ID,
    hyperliquidChain: isMainnet ? 'Mainnet' : 'Testnet',
    destination: user.toLowerCase(),
    sourceDex: '',
    destinationDex: dex,
    token,
    amount: amountUsd.toFixed(2),
    fromSubAccount: '',
    nonce,
  } as const;
}

/** POSTs a signed action to /exchange; throws on `status: "err"` with the venue's message. */
export async function postExchange(info: HlInfo, action: Record<string, unknown>, nonce: number, signature: HlSignature) {
  const res = await fetchJson<ExchangeResponse>(`Hyperliquid exchange ${String(action.type)}`, `${info.apiUrl}/exchange`, {
    body: { action, nonce, signature },
  });
  if (res.status !== 'ok') throw new Error(`Hyperliquid ${String(action.type)} rejected: ${JSON.stringify(res.response)}`);
  return res;
}

export function createHyperliquidVenue(opts: HyperliquidVenueOptions): Venue {
  const { info, dex, user, trader, creditWait = CREDIT_WAIT } = opts;
  let lastNonce = 0;
  let tail: Promise<unknown> = Promise.resolve();

  /** HL writes run one at a time: nonces stay strictly increasing and reduce/open never race. */
  function serialized<T>(what: string, fn: (t: HlTrader) => Promise<T>): Promise<T> {
    if (!trader) return Promise.reject(new ReadOnlyError(what));
    const run = tail.then(() => fn(trader));
    tail = run.catch(() => undefined);
    return run;
  }

  function nextNonce(): number {
    lastNonce = Math.max(Date.now(), lastNonce + 1);
    return lastNonce;
  }

  async function l1(t: HlTrader, action: Record<string, unknown>) {
    const nonce = nextNonce();
    return postExchange(info, action, nonce, await signL1Action(t.account, action, nonce, info.isMainnet));
  }

  /** Fresh (uncached) market data: used to price orders. */
  async function asset(symbol: string): Promise<HlAsset> {
    const d = await info.dex(dex, true);
    const a = d.assets.find((x) => x.symbol === symbol.toUpperCase());
    if (!a || a.isDelisted) throw new Error(`${symbol} is not listed on Hyperliquid ${dex}`);
    if (!(a.markPx > 0)) throw new Error(`${symbol} has no mark price on Hyperliquid ${dex}`);
    return a;
  }

  async function placeIoc(t: HlTrader, a: HlAsset, isBuy: boolean, size: number, slippageBps: number, reduceOnly: boolean) {
    const res = await l1(t, iocOrderAction(a, isBuy, size, slippageBps, reduceOnly));
    const status = typeof res.response === 'object' ? res.response.data?.statuses[0] : undefined;
    if (!status || typeof status === 'string') throw new Error(`Hyperliquid order: unexpected status ${JSON.stringify(status)}`);
    if (status.error) throw new Error(`Hyperliquid order rejected: ${status.error}`);
    if (!status.filled) throw new Error(`Hyperliquid IOC order did not fill: ${JSON.stringify(status)}`);
    return { oid: status.filled.oid, totalSz: Number(status.filled.totalSz), avgPx: Number(status.filled.avgPx) };
  }

  /** Venue-reported fills of `oid` (fee, closed PnL, L1 tx hash). Fills are indexed right after the order returns. */
  async function fillsOf(oid: number, since: number, totalSz: number): Promise<HlFill[]> {
    let fills: HlFill[] = [];
    for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
      // Exchange timestamps vs our clock: look back a minute; the oid filter keeps it exact.
      fills = (await info.userFillsSince(user, since - 60_000)).filter((f) => f.oid === oid);
      if (fills.reduce((s, f) => s + Number(f.sz), 0) >= totalSz - 1e-9) return fills;
      await sleep(FILL_POLL_MS);
    }
    return fills;
  }

  /** Taker fee rate this account pays on `a`; the base rate when the user's tier can't be read (never under-booked). */
  async function feeRate(a: HlAsset): Promise<number> {
    try {
      const fees = await info.userFees(user);
      const rate = Number(fees.userCrossRate);
      const referral = Number(fees.activeReferralDiscount) || 0;
      if (rate > 0) return takerFeeRate(rate, referral, a);
    } catch (err) {
      log.warn('Hyperliquid userFees lookup failed; estimating fees at the base rate', { error: shortError(err) });
    }
    return takerFeeRate(BASE_TAKER_RATE, 0, a);
  }

  async function toFill(
    a: HlAsset,
    side: Side,
    order: { oid: number; totalSz: number; avgPx: number },
    since: number,
    /** `leverage`: the open's margin leverage (null for reduces, which commit no margin). */
    extra: { fallbackPnlUsd: number; collateralReleasedUsd: number; leverage: number | null },
  ): Promise<Fill> {
    // The order already filled: a failed fills read must not lose it, so it falls back to the order response.
    const fills = await fillsOf(order.oid, since, order.totalSz).catch((err: unknown) => {
      log.warn('Hyperliquid fills lookup failed; using order response', { oid: order.oid, symbol: a.symbol, error: shortError(err) });
      return [];
    });
    // Some fills carry an all-zero hash (seen on live maker fills); the oid identifies the order then.
    const hash = fills.find((f) => !ZERO_HASH.test(f.hash))?.hash;
    const tx: TxReceiptRef = { chain: 'hyperliquid', hash: hash ?? `oid:${order.oid}` };
    const sz = fills.reduce((s, f) => s + Number(f.sz), 0);
    const notional = fills.reduce((s, f) => s + Number(f.sz) * Number(f.px), 0);
    let feeUsd = fills.reduce((s, f) => s + Number(f.fee), 0);
    let realizedPnlUsd = fills.reduce((s, f) => s + Number(f.closedPnl), 0);
    let sizeUsd = notional;
    let filledSz = sz;
    const missingSz = order.totalSz - sz;
    if (missingSz > 1e-9) {
      // Size the venue filled but hasn't indexed: priced from the order response, its fee from the fee schedule
      // (exact up to rounding), its PnL from the entry price. A fill is never booked fee-free.
      log.warn('Hyperliquid fills not (fully) indexed; estimating the rest from the order response', { oid: order.oid, symbol: a.symbol, missingSz });
      const missingNotional = Math.max(0, order.totalSz * order.avgPx - notional);
      feeUsd += missingNotional * (await feeRate(a));
      realizedPnlUsd += extra.fallbackPnlUsd * (missingSz / order.totalSz);
      sizeUsd += missingNotional;
      filledSz = order.totalSz;
    }
    return {
      symbol: a.symbol,
      side,
      sizeUsd,
      price: sizeUsd / filledSz,
      feeUsd,
      realizedPnlUsd,
      collateralReleasedUsd: extra.collateralReleasedUsd,
      collateralUsedUsd: extra.leverage ? sizeUsd / extra.leverage : 0,
      tx,
    };
  }

  async function builderDexPositions(): Promise<HlPosition[]> {
    const st = await info.clearinghouse(user, dex);
    return st.assetPositions.map((p) => p.position).filter((p) => Number(p.szi) !== 0);
  }

  async function sendAssetToDex(t: HlTrader, amountUsd: number): Promise<void> {
    const d = await info.dex(dex);
    const nonce = nextNonce();
    const action = sendAssetAction(info.isMainnet, user, dex, await info.spotTokenId(d.collateralToken), amountUsd, nonce);
    await postExchange(info, action, nonce, await signUserSignedAction(t.account, action, 'HyperliquidTransaction:SendAsset', SEND_ASSET_FIELDS));
  }

  /** Polls the default dex until a Bridge2 deposit is credited; false when it isn't within `creditWait.timeoutMs`. */
  async function waitForDefaultDexCredit(atLeastUsd: number): Promise<boolean> {
    const deadline = Date.now() + creditWait.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(creditWait.pollMs);
      // A failed read is not a verdict: keep polling until the deadline.
      const main = await info.clearinghouse(user, null).catch(() => null);
      if (main && Number(main.withdrawable) >= atLeastUsd) return true;
    }
    log.warn('Hyperliquid deposit not credited yet; next top-up moves it', { expectUsd: atLeastUsd });
    return false;
  }

  return {
    id: 'hyperliquid',
    name: `Hyperliquid (${dex})`,

    async health() {
      try {
        const d = await info.dex(dex);
        if (!d.assets.some((a) => !a.isDelisted && a.markPx > 0)) {
          return { paused: true, reason: `Hyperliquid's ${dex} equity markets aren't live right now, so new trades are paused` };
        }
        return { paused: false, reason: null };
      } catch (err) {
        // Public text stays plain; the upstream error goes to the log only.
        log.warn('Hyperliquid health check failed', { dex, error: shortError(err) });
        return { paused: true, reason: `Hyperliquid isn't answering market-data requests, so new trades are paused until it does` };
      }
    },

    async markets(): Promise<VenueMarket[]> {
      const d = await info.dex(dex);
      return d.assets
        .filter((a) => !a.isDelisted)
        .map((a) => ({ symbol: a.symbol, venueSymbol: a.coin, maxLeverage: a.maxLeverage, open: a.markPx > 0, markPrice: a.markPx }));
    },

    async freeCollateralUsd() {
      const st = await info.clearinghouse(user, dex);
      return Number(st.withdrawable) || 0;
    },

    async positions(): Promise<VenuePosition[]> {
      return (await builderDexPositions()).map((p) => {
        const szi = Number(p.szi);
        const sizeUsd = Math.abs(Number(p.positionValue));
        const liq = p.liquidationPx === null ? null : Number(p.liquidationPx);
        return {
          symbol: p.coin.startsWith(`${dex}:`) ? p.coin.slice(dex.length + 1) : p.coin,
          side: szi > 0 ? 'long' : 'short',
          sizeUsd,
          collateralUsd: positionCollateral(p),
          entryPrice: Number(p.entryPx),
          markPrice: sizeUsd / Math.abs(szi),
          leverage: p.leverage.value,
          unrealizedPnlUsd: Number(p.unrealizedPnl),
          liquidationPrice: liq !== null && liq > 0 ? liq : null,
        };
      });
    },

    open(req: OpenRequest): Promise<Fill> {
      return serialized('Hyperliquid open', async (t) => {
        if (!(req.collateralUsd > 0) || !(req.leverage >= 1)) throw new RangeError(`invalid open request ${JSON.stringify(req)}`);
        const a = await asset(req.symbol);
        let leverage = Math.min(Math.floor(req.leverage), a.maxLeverage);
        try {
          await l1(t, updateLeverageAction(a, leverage));
        } catch (err) {
          // Leverage can't change under an open isolated position; an add is margined at the position's leverage,
          // so it is sized at that leverage (the margin stays `collateralUsd`), and never at a higher one than asked.
          const existing = (await builderDexPositions()).find((p) => p.coin === a.coin);
          if (!existing) throw err;
          if (existing.leverage.type !== 'isolated' || existing.leverage.value > leverage) {
            throw new Error(
              `${a.symbol} position on Hyperliquid ${dex} runs ${existing.leverage.type} at ${existing.leverage.value}x; refusing to add at ${leverage}x (${shortError(err)})`,
            );
          }
          log.warn('Hyperliquid updateLeverage refused on existing position; sizing at its leverage', {
            symbol: a.symbol,
            requested: leverage,
            leverage: existing.leverage.value,
            error: shortError(err),
          });
          leverage = existing.leverage.value;
        }
        const size = floorSize((req.collateralUsd * leverage) / a.markPx, a.szDecimals);
        if (size * a.markPx < MIN_ORDER_USD) {
          throw new Error(`${a.symbol} order of $${(size * a.markPx).toFixed(2)} is below Hyperliquid's $${MIN_ORDER_USD} minimum`);
        }
        const since = Date.now();
        const order = await placeIoc(t, a, req.side === 'long', size, req.maxSlippageBps, false);
        return toFill(a, req.side, order, since, { fallbackPnlUsd: 0, collateralReleasedUsd: 0, leverage });
      });
    },

    reduce(symbol: string, fraction: number, maxSlippageBps: number): Promise<ExitFill> {
      return serialized('Hyperliquid reduce', async (t) => {
        if (!(fraction > 0 && fraction <= 1)) throw new RangeError(`reduce fraction must be in (0, 1], got ${fraction}`);
        const a = await asset(symbol);
        const pos = (await builderDexPositions()).find((p) => p.coin === a.coin);
        if (!pos) throw new Error(`no open ${a.symbol} position on Hyperliquid ${dex}`);
        const szi = Number(pos.szi);
        const held = Math.abs(szi);
        // Hyperliquid rejects orders under $10 (MinTradeNtl); only a reduce-only order closing the position exactly is
        // exempt. A partial reduce that small (or rounding to zero lots) closes the whole position instead: an exit
        // step that can never fill would be retried and fail on every pass, and closing is the risk-reducing side.
        const partial = fraction < 1 ? floorSize(held * fraction, a.szDecimals) : held;
        const worstNotional = partial * a.markPx * (1 - maxSlippageBps / 10_000);
        const size = partial < held && worstNotional >= MIN_ORDER_USD ? partial : held;
        if (size !== partial) {
          log.info('Hyperliquid partial reduce is below the $10 minimum; closing the whole position', { symbol: a.symbol, fraction, notional: worstNotional });
        }
        const side: Side = szi > 0 ? 'long' : 'short';
        const since = Date.now();
        const order = await placeIoc(t, a, side === 'short', size, maxSlippageBps, true);
        // IOC: the order may fill only part of `size`; the rest is cancelled and stays open on the venue.
        const closedFraction = order.totalSz >= held - 1e-12 ? 1 : order.totalSz / held;
        const entry = Number(pos.entryPx);
        const fill = await toFill(a, side, order, since, {
          fallbackPnlUsd: (order.avgPx - entry) * order.totalSz * (side === 'long' ? 1 : -1),
          collateralReleasedUsd: positionCollateral(pos) * closedFraction,
          leverage: null,
        });
        return { ...fill, closedFraction, complete: order.totalSz >= size - 1e-12 };
      });
    },

    topUpMargin() {
      return serialized('Hyperliquid margin top-up', async (t) => {
        const txs: TxReceiptRef[] = [];
        let uncredited: { usd: number; tx: TxReceiptRef } | undefined;
        const raw = await t.arbitrum.readContract({ address: t.arbitrumUsdc, abi: erc20Abi, functionName: 'balanceOf', args: [user] });
        const cents = raw / 10n ** BigInt(USDC_DECIMALS - 2);
        const depositUsd = Number(cents) / 100;
        if (depositUsd >= MIN_BRIDGE_DEPOSIT_USDC) {
          const code = await t.arbitrum.getCode({ address: t.bridge });
          if (!code || code === '0x') throw new Error(`Hyperliquid bridge ${t.bridge} has no code on Arbitrum; refusing to deposit`);
          const before = Number((await info.clearinghouse(user, null)).withdrawable);
          const amount = cents * 10n ** BigInt(USDC_DECIMALS - 2);
          const sent = await t.arbitrumSender.exclusive((send) =>
            send({
              to: t.arbitrumUsdc,
              data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [t.bridge, amount] }),
              what: `Hyperliquid deposit ${formatUnits(amount, USDC_DECIMALS)} USDC`,
            }),
          );
          txs.push(sent.ref);
          log.info('Hyperliquid deposit sent', { usdc: depositUsd, tx: sent.ref.hash });
          // Left Arbitrum, not on Hyperliquid yet: reported so the reconciler counts it as in flight.
          if (!(await waitForDefaultDexCredit(before + depositUsd - 0.01))) uncredited = { usd: depositUsd, tx: sent.ref };
        }
        const main = await info.clearinghouse(user, null);
        const movable = Math.floor(Number(main.withdrawable) * 100) / 100;
        if (movable < MIN_DEX_TRANSFER_USD) return { movedUsd: 0, txs, uncredited };
        await sendAssetToDex(t, movable);
        log.info('Moved USDC into Hyperliquid builder dex', { dex, usd: movable });
        return { movedUsd: movable, txs, uncredited };
      });
    },

    async depositCredited(tx: TxReceiptRef, sentAt: number) {
      // Hyperliquid books a Bridge2 deposit under the hash of the Arbitrum transfer that funded it. `sentAt` may be
      // taken when the top-up returned, after the credit wait: look back past that wait and clock skew.
      const updates = await info.ledgerUpdatesSince(user, sentAt - creditWait.timeoutMs - 5 * 60_000);
      return updates.some((u) => u.delta.type === 'deposit' && u.hash.toLowerCase() === tx.hash.toLowerCase());
    },
  };
}
