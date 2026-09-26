/**
 * Fork proofs of the Uniswap buyback path (src/integrations/uniswap.ts): live integrations built on an anvil
 * fork buy and burn a real token, and the price guards refuse manipulated or oversized buybacks.
 * Every proof returns checks instead of exiting. Guard proofs run inside an evm snapshot that is reverted.
 * Time is warped past the TWAP window where a V3 pool needs history (fork blocks otherwise come ~seconds apart).
 */
import { encodeFunctionData, erc20Abi, formatEther, formatUnits, isAddressEqual, parseAbi, parseEther } from 'viem';
import type { Account, Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BURN_ADDRESS } from '@stepup/shared';
import { PriceGuardError, shortError } from '../../src/integrations/errors.ts';
import { NATIVE, PonsV2Phase, ponsV2PoolKey, readPonsV2Launch } from '../../src/integrations/ponsv2.ts';
import type { V4PoolKey } from '../../src/integrations/ponsv2.ts';
import {
  OBSERVATION_CARDINALITY,
  TWAP_WINDOW_SEC,
  minAmountOut,
  priceImpactBps,
  referenceAmount,
  v4BuyCalldata,
} from '../../src/integrations/uniswap.ts';
import type { Integrations, LiveConfig } from '../../src/ports.ts';
import type { Fork } from './anvil.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DexProofContext {
  fork: Fork;
  /** Live integrations built on the fork: `createLiveIntegrations(cfg)` with `ROBINHOOD_RPC_URL = fork.url`. */
  io: Integrations;
  /** The config `io` was built from; its protocol wallet must be funded on the fork. */
  cfg: LiveConfig;
  token: Address;
  /** A fresh funded account for third-party trades (see `makeTrader`). */
  newTrader: () => Promise<Account>;
}

type Route = { version: 3; fee: number; pool: Address } | { version: 4; key: V4PoolKey };

const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const V3_FACTORY_ABI = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)']);
const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function increaseObservationCardinalityNext(uint16 observationCardinalityNext)',
]);

/** A throwaway account (key never leaves this process) funded with `eth` on the fork. */
export function makeTrader(fork: Fork, eth = '10000'): () => Promise<Account> {
  return async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    await fork.fund(account.address, eth);
    return account;
  };
}

function check(checks: Check[], name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function balanceOf(ctx: DexProofContext, who: Address): Promise<bigint> {
  return ctx.fork.pub.readContract({ address: ctx.token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}

async function warp(fork: Fork, seconds: number): Promise<void> {
  await fork.test.increaseTime({ seconds });
  await fork.test.mine({ blocks: 1 });
}

async function routeOf(ctx: DexProofContext): Promise<Route> {
  const { contracts } = ctx.cfg;
  const launch = await readPonsV2Launch(ctx.fork.pub, contracts.ponsV2Factory, ctx.token);
  if (launch) {
    if (launch.phase !== PonsV2Phase.Pool || !isAddressEqual(launch.pairToken, NATIVE)) throw new Error(`${ctx.token}: Pons V2 launch has no native V4 pool`);
    return { version: 4, key: ponsV2PoolKey(launch, contracts.ponsV2Hook) };
  }
  const q = await ctx.io.dex.quote(ctx.token, parseEther('0.001'));
  if (!q) throw new Error(`${ctx.token}: no Uniswap pool`);
  const factory = await ctx.fork.pub.readContract({ address: contracts.uniswapRouter, abi: ROUTER_ABI, functionName: 'factory' });
  const pool = await ctx.fork.pub.readContract({ address: factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [ctx.token, contracts.weth, q.feeTier] });
  return { version: 3, fee: q.feeTier, pool };
}

const describe = (r: Route) => (r.version === 4 ? `V4 pool (fee ${r.key.fee}, tickSpacing ${r.key.tickSpacing}, hook ${r.key.hooks})` : `V3 pool ${r.pool} (fee ${r.fee})`);

async function send(ctx: DexProofContext, account: Account, tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex> {
  const hash = await ctx.fork.wallet(account).sendTransaction(tx);
  const receipt = await ctx.fork.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    // Replay on the parent state for the revert reason.
    const reason = await ctx.fork.pub
      .call({ account, ...tx, blockNumber: receipt.blockNumber - 1n })
      .then(() => 'replay succeeded', (err: unknown) => shortError(err));
    throw new Error(`trader tx ${hash} reverted (gas used ${receipt.gasUsed}): ${reason}`);
  }
  return hash;
}

/** A third-party market buy of `value` wei, tokens to the trader. */
async function traderBuy(ctx: DexProofContext, route: Route, account: Account, value: bigint): Promise<Hex> {
  const { contracts } = ctx.cfg;
  if (route.version === 4) {
    const deadline = (await ctx.fork.pub.getBlock()).timestamp + 600n;
    return send(ctx, account, { to: contracts.uniswapUniversalRouter, value, data: v4BuyCalldata(route.key, value, 0n, deadline) });
  }
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{ tokenIn: contracts.weth, tokenOut: ctx.token, fee: route.fee, recipient: account.address, amountIn: value, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
  });
  return send(ctx, account, { to: contracts.uniswapRouter, value, data });
}

/** Smallest doubling of 0.01 ETH whose buy moves the price by at least `targetBps` (per the engine's own quotes). */
async function amountWithImpact(ctx: DexProofContext, targetBps: number): Promise<{ amount: bigint; impact: number }> {
  for (let amount = parseEther('0.01'); amount <= parseEther('100000'); amount *= 2n) {
    const ref = referenceAmount(amount);
    const [full, small] = await Promise.all([ctx.io.dex.quote(ctx.token, amount), ctx.io.dex.quote(ctx.token, ref)]);
    if (!full || !small) continue;
    const impact = priceImpactBps({ amountIn: ref, amountOut: small.amountOut }, { amountIn: amount, amountOut: full.amountOut });
    if (impact >= targetBps) return { amount, impact };
  }
  throw new Error(`${ctx.token}: no buy up to 100000 ETH moves the price ${targetBps} bps`);
}

/** Runs `fn` in an evm snapshot, then reverts it; the wallet nonce is restored so the engine's nonce cache stays valid. */
async function sandboxed<T>(ctx: DexProofContext, fn: () => Promise<T>): Promise<T> {
  const { pub, test } = ctx.fork;
  const id = await test.snapshot();
  try {
    return await fn();
  } finally {
    const nonce = await pub.getTransactionCount({ address: ctx.cfg.protocolAddress });
    await test.revert({ id });
    await test.setNonce({ address: ctx.cfg.protocolAddress, nonce });
  }
}

async function ensureFunded(ctx: DexProofContext, wei: bigint): Promise<void> {
  const have = await ctx.fork.pub.getBalance({ address: ctx.cfg.protocolAddress });
  if (have < wei) await ctx.fork.fund(ctx.cfg.protocolAddress, formatEther(wei));
}

/** Expects `buyAndBurn` to throw PriceGuardError of `kind` without sending a single wallet tx. */
async function expectGuard(ctx: DexProofContext, checks: Check[], name: string, kind: PriceGuardError['kind'], amount: bigint): Promise<void> {
  const nonce = await ctx.fork.pub.getTransactionCount({ address: ctx.cfg.protocolAddress });
  try {
    const res = await ctx.io.dex.buyAndBurn(ctx.token, amount, 150);
    check(checks, name, false, `buyback went through: swap ${res.swapTx.hash}, ${res.amountOut} out`);
  } catch (err) {
    const ok = err instanceof PriceGuardError && err.kind === kind;
    check(checks, name, ok, err instanceof PriceGuardError ? `PriceGuardError(${err.kind}): ${err.message}` : `unexpected: ${String(err)}`);
  }
  const after = await ctx.fork.pub.getTransactionCount({ address: ctx.cfg.protocolAddress });
  check(checks, `${name}: nothing sent`, after === nonce, `wallet nonce ${nonce} → ${after}`);
}

/**
 * Quote + buyAndBurn: every bought token lands at the burn address, the wallet keeps none, and the output
 * honours the slippage budget against the quote.
 */
export async function proveBuyback(ctx: DexProofContext, amountInWei = parseEther('0.001'), maxSlippageBps = 150): Promise<Check[]> {
  const checks: Check[] = [];
  const route = await routeOf(ctx);
  // A V3 launchpad pool keeps one observation: without a quiet TWAP window behind us, observe() reverts ('OLD').
  if (route.version === 3) await warp(ctx.fork, TWAP_WINDOW_SEC + 1);
  const q = await ctx.io.dex.quote(ctx.token, amountInWei);
  check(checks, 'quote', q !== null, q ? `${formatEther(amountInWei)} ETH → ${q.amountOut} raw via ${describe(route)}` : 'no quote');
  if (!q) return checks;
  await ensureFunded(ctx, amountInWei + parseEther('1'));
  const [deadBefore, walletBefore] = await Promise.all([balanceOf(ctx, BURN_ADDRESS), balanceOf(ctx, ctx.cfg.protocolAddress)]);
  let res;
  try {
    res = await ctx.io.dex.buyAndBurn(ctx.token, amountInWei, maxSlippageBps);
  } catch (err) {
    check(checks, 'buyAndBurn', false, err instanceof Error ? err.message : String(err));
    return checks;
  }
  const [deadAfter, walletAfter] = await Promise.all([balanceOf(ctx, BURN_ADDRESS), balanceOf(ctx, ctx.cfg.protocolAddress)]);
  const swapReceipt = await ctx.fork.pub.getTransactionReceipt({ hash: res.swapTx.hash as Hex });
  check(checks, 'buyAndBurn', res.burnTx !== null, `swap ${res.swapTx.hash} (to ${swapReceipt.to}), burn ${res.burnTx?.hash ?? 'none'}`);
  check(checks, 'burn address delta == amountOut', deadAfter - deadBefore === res.amountOut, `dead +${deadAfter - deadBefore}, amountOut ${res.amountOut}`);
  check(checks, 'wallet token balance unchanged', walletAfter === walletBefore, `${walletBefore} → ${walletAfter}`);
  const floor = minAmountOut(q.amountOut, maxSlippageBps);
  check(checks, 'amountOut within slippage of quote', res.amountOut >= floor, `amountOut ${res.amountOut} vs quote ${q.amountOut} (floor ${floor}, ${maxSlippageBps} bps)`);
  return checks;
}

/**
 * V3 only (V4 pools have no on-chain TWAP; returns no checks): another account pumps the pool right before
 * the buyback, which must then refuse with PriceGuardError('twap-deviation').
 */
export async function proveTwapGuard(ctx: DexProofContext, amountInWei = parseEther('0.001')): Promise<Check[]> {
  const route = await routeOf(ctx);
  if (route.version !== 3) return [];
  const checks: Check[] = [];
  await sandboxed(ctx, async () => {
    const trader = await ctx.newTrader();
    const slot0 = await ctx.fork.pub.readContract({ address: route.pool, abi: V3_POOL_ABI, functionName: 'slot0' });
    if (slot0[4] < OBSERVATION_CARDINALITY) {
      // What the engine's first buyback does; done here so the proof does not depend on proveBuyback running first.
      await send(ctx, trader, {
        to: route.pool,
        data: encodeFunctionData({ abi: V3_POOL_ABI, functionName: 'increaseObservationCardinalityNext', args: [OBSERVATION_CARDINALITY] }),
      });
    }
    await warp(ctx.fork, TWAP_WINDOW_SEC + 1); // a quiet window: the TWAP is the pre-pump price
    const pump = await amountWithImpact(ctx, ctx.cfg.buybackMaxTwapDeviationBps * 3);
    const before = await ctx.fork.pub.readContract({ address: route.pool, abi: V3_POOL_ABI, functionName: 'slot0' });
    const hash = await traderBuy(ctx, route, trader, pump.amount);
    const after = await ctx.fork.pub.readContract({ address: route.pool, abi: V3_POOL_ABI, functionName: 'slot0' });
    check(checks, 'pump by another account', true, `${formatEther(pump.amount)} ETH buy ${hash}: tick ${before[1]} → ${after[1]}, cardinality ${after[3]}`);
    await ensureFunded(ctx, amountInWei + parseEther('1'));
    await expectGuard(ctx, checks, 'TWAP guard trips after the pump', 'twap-deviation', amountInWei);
  });
  return checks;
}

/** An oversized buyback (≥ 2× the impact cap on the engine's own quotes) must refuse with PriceGuardError('price-impact'). */
export async function proveImpactGuard(ctx: DexProofContext): Promise<Check[]> {
  const checks: Check[] = [];
  const route = await routeOf(ctx);
  await sandboxed(ctx, async () => {
    if (route.version === 3) await warp(ctx.fork, TWAP_WINDOW_SEC + 1);
    const big = await amountWithImpact(ctx, ctx.cfg.buybackMaxPriceImpactBps * 2);
    await ensureFunded(ctx, big.amount + parseEther('10'));
    await expectGuard(ctx, checks, `impact guard trips for ${formatEther(big.amount)} ETH (${describe(route)}, quoted impact ${big.impact.toFixed(0)} bps)`, 'price-impact', big.amount);
  });
  return checks;
}

/** Tokens already held by the wallet (a buyback whose burn failed) are burned exactly; over-burning is refused. */
export async function proveBurnHeld(ctx: DexProofContext): Promise<Check[]> {
  const checks: Check[] = [];
  const route = await routeOf(ctx);
  const trader = await ctx.newTrader();
  await traderBuy(ctx, route, trader, parseEther('0.001'));
  const bought = await balanceOf(ctx, trader.address);
  const amount = bought / 2n;
  await send(ctx, trader, { to: ctx.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ctx.cfg.protocolAddress, amount] }) });
  const [deadBefore, walletBefore] = await Promise.all([balanceOf(ctx, BURN_ADDRESS), balanceOf(ctx, ctx.cfg.protocolAddress)]);
  try {
    await ctx.io.dex.burnHeld(ctx.token, walletBefore + 1n);
    check(checks, 'burnHeld refuses more than held', false, 'did not refuse');
  } catch (err) {
    check(checks, 'burnHeld refuses more than held', /holds only/.test(String(err)), err instanceof Error ? err.message : String(err));
  }
  const ref = await ctx.io.dex.burnHeld(ctx.token, amount);
  const [deadAfter, walletAfter] = await Promise.all([balanceOf(ctx, BURN_ADDRESS), balanceOf(ctx, ctx.cfg.protocolAddress)]);
  check(
    checks,
    'burnHeld burns the held amount',
    deadAfter - deadBefore === amount && walletBefore - walletAfter === amount,
    `burn ${ref.hash}: ${formatUnits(amount, 18)} tokens, dead +${deadAfter - deadBefore}, wallet -${walletBefore - walletAfter}`,
  );
  return checks;
}
