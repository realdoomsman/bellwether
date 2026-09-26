/**
 * Hyperliquid HIP-3 equity perps (builder dex `xyz`) as a Venue.
 * Positions are isolated; "market" orders are IOC limits at mark ± slippage.
 * Builder-dex margin is segregated: USDC must be moved from the default perp dex into the
 * builder dex (`sendAsset`) before it can margin trades.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeFunctionData, erc20Abi, formatUnits } from 'viem';
import type { Address, LocalAccount } from 'viem';
import type { Side } from '@stepup/shared';
import type { Fill, OpenRequest, TxReceiptRef, Venue, VenueMarket, VenuePosition } from '../../ports.ts';
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
const CREDIT_POLL_MS = 10_000;
const CREDIT_TIMEOUT_MS = 180_000;
const FILL_POLL_MS = 700;
const FILL_POLL_ATTEMPTS = 10;

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
  // Isolated marginUsed includes unrealized PnL; the posted collateral excludes it.
  const margin = Number(p.marginUsed);
  return p.leverage.type === 'isolated' ? margin - Number(p.unrealizedPnl) : margin;
}

export function createHyperliquidVenue(opts: HyperliquidVenueOptions): Venue {
  const { info, dex, user, trader } = opts;
  let lastNonce = 0;
  let tail: Promise<unknown> = Promise.resolve();

  /** HL writes run one at a time: nonces stay strictly increasing and reduce/open never race. */
  function serialized<T>(what: string, fn: (t: HlTrader) => Promise<T>): Promise<T> {
    if (!trader) return Promise.reject(new ReadOnlyError(what));
    const run = tail.then(() => fn(trader));
    tail = run.catch(() => undefined);
    return run;
  }

  async function exchange(action: Record<string, unknown>, sign: (nonce: number) => Promise<HlSignature>, nonce: number) {
    const signature = await sign(nonce);
    const res = await fetchJson<ExchangeResponse>(`Hyperliquid exchange ${String(action.type)}`, `${info.apiUrl}/exchange`, {
      body: { action, nonce, signature },
    });
    if (res.status !== 'ok') throw new Error(`Hyperliquid ${String(action.type)} rejected: ${JSON.stringify(res.response)}`);
    return res;
  }

  function nextNonce(): number {
    lastNonce = Math.max(Date.now(), lastNonce + 1);
    return lastNonce;
  }

  function l1(t: HlTrader, action: Record<string, unknown>) {
    return exchange(action, (nonce) => signL1Action(t.account, action, nonce, true), nextNonce());
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
    const slip = slippageBps / 10_000;
    const px = roundPrice(a.markPx * (isBuy ? 1 + slip : 1 - slip), a.szDecimals);
    const res = await l1(t, {
      type: 'order',
      orders: [{ a: a.assetId, b: isBuy, p: floatToWire(px), s: floatToWire(size), r: reduceOnly, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });
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

  async function toFill(
    a: HlAsset,
    side: Side,
    order: { oid: number; totalSz: number; avgPx: number },
    since: number,
    extra: { fallbackPnlUsd: number; collateralReleasedUsd: number },
  ): Promise<Fill> {
    const fills = await fillsOf(order.oid, since, order.totalSz);
    const tx: TxReceiptRef = { chain: 'hyperliquid', hash: fills[0]?.hash ?? `oid:${order.oid}` };
    if (fills.length === 0) {
      log.warn('Hyperliquid fills not indexed yet; using order response', { oid: order.oid, symbol: a.symbol });
      return {
        symbol: a.symbol,
        side,
        sizeUsd: order.totalSz * order.avgPx,
        price: order.avgPx,
        feeUsd: 0,
        realizedPnlUsd: extra.fallbackPnlUsd,
        collateralReleasedUsd: extra.collateralReleasedUsd,
        tx,
      };
    }
    const sz = fills.reduce((s, f) => s + Number(f.sz), 0);
    const notional = fills.reduce((s, f) => s + Number(f.sz) * Number(f.px), 0);
    return {
      symbol: a.symbol,
      side,
      sizeUsd: notional,
      price: notional / sz,
      feeUsd: fills.reduce((s, f) => s + Number(f.fee), 0),
      realizedPnlUsd: fills.reduce((s, f) => s + Number(f.closedPnl), 0),
      collateralReleasedUsd: extra.collateralReleasedUsd,
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
    const action = {
      type: 'sendAsset',
      signatureChainId: ARBITRUM_SIGNATURE_CHAIN_ID,
      hyperliquidChain: 'Mainnet',
      destination: user.toLowerCase(),
      sourceDex: '',
      destinationDex: dex,
      token: await info.spotTokenId(d.collateralToken),
      amount: amountUsd.toFixed(2),
      fromSubAccount: '',
      nonce,
    } as const;
    await exchange(action, () => signUserSignedAction(t.account, action, 'HyperliquidTransaction:SendAsset', SEND_ASSET_FIELDS), nonce);
  }

  async function waitForDefaultDexCredit(atLeastUsd: number): Promise<void> {
    const deadline = Date.now() + CREDIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(CREDIT_POLL_MS);
      const main = await info.clearinghouse(user, null);
      if (Number(main.withdrawable) >= atLeastUsd) return;
    }
    log.warn('Hyperliquid deposit not credited yet; next top-up moves it', { expectUsd: atLeastUsd });
  }

  return {
    id: 'hyperliquid',
    name: `Hyperliquid (${dex})`,

    async health() {
      try {
        const d = await info.dex(dex);
        if (!d.assets.some((a) => !a.isDelisted && a.markPx > 0)) {
          return { paused: true, reason: `Hyperliquid ${dex} has no live markets` };
        }
        return { paused: false, reason: null };
      } catch (err) {
        return { paused: true, reason: `Hyperliquid ${dex} unavailable: ${shortError(err)}` };
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
        const leverage = Math.min(Math.floor(req.leverage), a.maxLeverage);
        try {
          await l1(t, { type: 'updateLeverage', asset: a.assetId, isCross: false, leverage });
        } catch (err) {
          // Leverage can't change under an open isolated position; adding to it keeps the existing setting.
          const existing = (await builderDexPositions()).some((p) => p.coin === a.coin);
          if (!existing) throw err;
          log.warn('Hyperliquid updateLeverage refused on existing position', { symbol: a.symbol, error: shortError(err) });
        }
        const size = floorSize((req.collateralUsd * leverage) / a.markPx, a.szDecimals);
        if (size * a.markPx < MIN_ORDER_USD) {
          throw new Error(`${a.symbol} order of $${(size * a.markPx).toFixed(2)} is below Hyperliquid's $${MIN_ORDER_USD} minimum`);
        }
        const since = Date.now();
        const order = await placeIoc(t, a, req.side === 'long', size, req.maxSlippageBps, false);
        return toFill(a, req.side, order, since, { fallbackPnlUsd: 0, collateralReleasedUsd: 0 });
      });
    },

    reduce(symbol: string, fraction: number, maxSlippageBps: number): Promise<Fill> {
      return serialized('Hyperliquid reduce', async (t) => {
        if (!(fraction > 0 && fraction <= 1)) throw new RangeError(`reduce fraction must be in (0, 1], got ${fraction}`);
        const a = await asset(symbol);
        const pos = (await builderDexPositions()).find((p) => p.coin === a.coin);
        if (!pos) throw new Error(`no open ${a.symbol} position on Hyperliquid ${dex}`);
        const szi = Number(pos.szi);
        const held = Math.abs(szi);
        const size = fraction === 1 ? held : floorSize(held * fraction, a.szDecimals);
        if (size <= 0) throw new Error(`reducing ${fraction} of ${held} ${a.symbol} rounds to zero`);
        const side: Side = szi > 0 ? 'long' : 'short';
        const since = Date.now();
        const order = await placeIoc(t, a, side === 'short', size, maxSlippageBps, true);
        const entry = Number(pos.entryPx);
        return toFill(a, side, order, since, {
          fallbackPnlUsd: (order.avgPx - entry) * order.totalSz * (side === 'long' ? 1 : -1),
          collateralReleasedUsd: positionCollateral(pos) * Math.min(1, order.totalSz / held),
        });
      });
    },

    topUpMargin() {
      return serialized('Hyperliquid margin top-up', async (t) => {
        const txs: TxReceiptRef[] = [];
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
          await waitForDefaultDexCredit(before + depositUsd - 0.01);
        }
        const main = await info.clearinghouse(user, null);
        const movable = Math.floor(Number(main.withdrawable) * 100) / 100;
        if (movable < MIN_DEX_TRANSFER_USD) return { movedUsd: 0, txs };
        await sendAssetToDex(t, movable);
        log.info('Moved USDC into Hyperliquid builder dex', { dex, usd: movable });
        return { movedUsd: movable, txs };
      });
    },
  };
}
