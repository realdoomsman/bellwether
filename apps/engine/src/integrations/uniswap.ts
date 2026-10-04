/**
 * Uniswap on Robinhood Chain: quotes and ETH → token buybacks whose proceeds are burned.
 * Pons V1 / LaunchHood tokens graduate into WETH-paired V3 pools (SwapRouter02 wraps msg.value itself);
 * Pons V2 tokens graduate into native-ETH V4 pools behind the shared Pons hook (UniversalRouter V4_SWAP).
 * A buyback first has to pass price guards: its own price impact, and its price against a time-weighted
 * reference (V3: the pool's TWAP; V4: the engine's rolling samples of `spotPrice`, passed in by the caller).
 */
import { encodeAbiParameters, encodeFunctionData, erc20Abi, formatEther, isAddressEqual, parseAbi, parseAbiParameters, TransactionReceiptNotFoundError } from 'viem';
import type { Address } from 'viem';
import { BURN_ADDRESS } from '@bellwether/shared';
import type { BuybackResult, BroadcastTx, Dex, Hex, NetworkConfig, TxOutcome } from '../ports.ts';
import { log } from '../log.ts';
import type { Client } from './chains.ts';
import { burnRequest, transfersTo } from './erc20.ts';
import { PriceGuardError, ReadOnlyError, shortError } from './errors.ts';
import { NATIVE, PonsV2Phase, ponsV2PoolKey, readPonsV2Launch } from './ponsv2.ts';
import type { V4PoolKey } from './ponsv2.ts';
import { meter, UnconfirmedTxError } from './tx.ts';
import type { Send, Sent, SendRequest, TxSender } from './tx.ts';

const FEE_TIERS = [10_000, 3_000, 500, 100] as const;
/** TWAP window of the V3 manipulation guard (and the span the engine's V4 reference samples must cover). */
export const TWAP_WINDOW_SEC = 900;
/**
 * Observation slots a V3 pool needs so `observe([TWAP_WINDOW_SEC, 0])` keeps working while it trades
 * (one slot per block with a swap). Launchpad pools start at 1; the first buyback grows them once.
 */
export const OBSERVATION_CARDINALITY = 300;
/** Smallest reference trade of the price-impact guard; also the trade size `spotPrice` samples. */
const MIN_REFERENCE_WEI = 10n ** 12n;
/** UniversalRouter command and v4-periphery actions (universal-router 2.1.2 Commands.sol, v4-periphery Actions.sol). */
const V4_SWAP_COMMAND = '0x10';
const V4_ACTIONS = '0x060c0f'; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
/** A swap still unmined this long after it was built reverts instead of filling at a stale minimum. */
const SWAP_DEADLINE_SEC = 600n;

const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  // SwapRouter02 (PeripheryValidationExtended): reverts 'Transaction too old' once block.timestamp > deadline.
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);
const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
const V3_FACTORY_ABI = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)']);
const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function increaseObservationCardinalityNext(uint16 observationCardinalityNext)',
]);
const V4_QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
/** IV4Router.ExactInputSingleParams as of v4-periphery 545a5d2 (pinned by universal-router 2.1.2). */
const V4_EXACT_IN_SINGLE_PARAMS = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
);
const CURRENCY_AMOUNT_PARAMS = parseAbiParameters('address currency, uint256 amount');
const V4_SWAP_INPUT = parseAbiParameters('bytes actions, bytes[] params');

/** Least acceptable output for a quote under a slippage budget in basis points (rounds down). */
export function minAmountOut(quoted: bigint, maxSlippageBps: number): bigint {
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps >= 10_000) {
    throw new RangeError(`maxSlippageBps must be an integer in [0, 10000), got ${maxSlippageBps}`);
  }
  return (quoted * BigInt(10_000 - maxSlippageBps)) / 10_000n;
}

/** Arithmetic mean tick between two tick-cumulative observations `windowSec` apart, rounded toward −∞ like OracleLibrary.consult. */
export function meanTick(olderCumulative: bigint, newerCumulative: bigint, windowSec: number): number {
  const delta = newerCumulative - olderCumulative;
  const window = BigInt(windowSec);
  let tick = delta / window;
  if (delta < 0n && delta % window !== 0n) tick--;
  return Number(tick);
}

/** Raw token units per wei of WETH at `tick` of a token/WETH V3 pool (the pool prices token1 in token0: 1.0001^tick). */
export function tokensPerWethAtTick(tick: number, tokenIsToken0: boolean): number {
  return 1.0001 ** (tokenIsToken0 ? -tick : tick);
}

/**
 * How much worse (bps) receiving `amountOut` for `amountIn` is than the fair output at `fairPrice` (out per in)
 * net of the pool's LP fee (`feePips`, millionths). Negative when the trade beats the fair price.
 */
export function twapDeviationBps(amountIn: bigint, amountOut: bigint, fairPrice: number, feePips: number): number {
  const fairOut = Number(amountIn) * fairPrice * (1 - feePips / 1_000_000);
  return (1 - Number(amountOut) / fairOut) * 10_000;
}

/** Reference trade size of the price-impact guard: 1/1000 of the trade, at least MIN_REFERENCE_WEI, never above the trade. */
export function referenceAmount(amountIn: bigint): bigint {
  const ref = amountIn / 1_000n;
  if (ref >= MIN_REFERENCE_WEI) return ref;
  return amountIn < MIN_REFERENCE_WEI ? amountIn : MIN_REFERENCE_WEI;
}

/** Price impact (bps) of `full` relative to the execution price of a small `ref` trade in the same pool; Infinity if `ref` buys nothing. */
export function priceImpactBps(ref: { amountIn: bigint; amountOut: bigint }, full: { amountIn: bigint; amountOut: bigint }): number {
  if (ref.amountOut <= 0n) return Infinity;
  const ratioPpm = (full.amountOut * ref.amountIn * 1_000_000n) / (full.amountIn * ref.amountOut);
  return (1 - Number(ratioPpm) / 1_000_000) * 10_000;
}

/**
 * UniversalRouter `execute` calldata spending `amountIn` native ETH (sent as msg.value) on currency1 of a
 * native-ETH V4 pool (native is always currency0), delivered to the caller: SWAP_EXACT_IN_SINGLE, then
 * SETTLE_ALL pays the PoolManager from the router's ETH, TAKE_ALL sends the output (at least `amountOutMinimum`).
 */
export function v4BuyCalldata(key: V4PoolKey, amountIn: bigint, amountOutMinimum: bigint, deadline: bigint): Hex {
  if (!isAddressEqual(key.currency0, NATIVE)) throw new Error(`V4 pool ${key.currency0}/${key.currency1} is not paired with native ETH`);
  const params: Hex[] = [
    encodeAbiParameters(V4_EXACT_IN_SINGLE_PARAMS, [
      { poolKey: key, zeroForOne: true, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: '0x' },
    ]),
    encodeAbiParameters(CURRENCY_AMOUNT_PARAMS, [NATIVE, amountIn]),
    encodeAbiParameters(CURRENCY_AMOUNT_PARAMS, [key.currency1, amountOutMinimum]),
  ];
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [V4_SWAP_COMMAND, [encodeAbiParameters(V4_SWAP_INPUT, [V4_ACTIONS, params])], deadline],
  });
}

export interface PriceGuardLimits {
  maxTwapDeviationBps: number;
  maxPriceImpactBps: number;
}

export interface UniswapDeps {
  rhc: Client;
  net: NetworkConfig;
  sender: TxSender | null;
  /** Buyback price guards; null for read-only integrations (which refuse buybacks anyway). */
  limits: PriceGuardLimits | null;
}

/** V4 routes are native-ETH Pons V2 pools, so the buy is always zeroForOne. */
type PoolRoute = { version: 3; fee: number } | { version: 4; key: V4PoolKey };

interface RoutedQuote {
  amountOut: bigint;
  route: PoolRoute;
}

const bps = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : String(x));

export function createUniswap({ rhc, net, sender, limits }: UniswapDeps): Dex {
  const { weth, uniswapRouter, uniswapQuoter, uniswapV4Quoter, uniswapUniversalRouter, ponsV2Factory, ponsV2Hook } = net.contracts;
  const wallet = net.protocolAddress;
  let v3Factory: Promise<Address> | null = null;

  async function quoteV3(token: Address, amountIn: bigint, fee: number): Promise<bigint> {
    if (uniswapQuoter) {
      const { result } = await rhc.simulateContract({
        address: uniswapQuoter,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: weth, tokenOut: token, amountIn, fee, sqrtPriceLimitX96: 0n }],
      });
      return result[0];
    }
    // No quoter: dry-run the router swap itself, funding the caller via a state override.
    const { result } = await rhc.simulateContract({
      account: wallet,
      address: uniswapRouter,
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: weth, tokenOut: token, fee, recipient: wallet, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
      value: amountIn,
      stateOverride: [{ address: wallet, balance: amountIn + 10n ** 18n }],
    });
    return result;
  }

  async function quoteV4(key: V4PoolKey, amountIn: bigint): Promise<bigint> {
    const { result } = await rhc.simulateContract({
      address: uniswapV4Quoter,
      abi: V4_QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne: true, exactAmount: amountIn, hookData: '0x' }],
    });
    return result[0];
  }

  /** Pons V2 launches trade only in their native-ETH V4 pool once graduated (none before); everything else on V3. */
  async function bestQuote(token: Address, amountIn: bigint): Promise<RoutedQuote | null> {
    if (amountIn <= 0n) throw new RangeError('quote amount must be positive');
    const launch = await readPonsV2Launch(rhc, ponsV2Factory, token);
    if (launch) {
      if (launch.phase !== PonsV2Phase.Pool || !isAddressEqual(launch.pairToken, NATIVE)) return null;
      const route: PoolRoute = { version: 4, key: ponsV2PoolKey(launch, ponsV2Hook) };
      const amountOut = await quoteV4(route.key, amountIn).catch(() => 0n);
      return amountOut > 0n ? { amountOut, route } : null;
    }
    const results = await Promise.allSettled(FEE_TIERS.map((fee) => quoteV3(token, amountIn, fee)));
    let best: RoutedQuote | null = null;
    for (const [i, r] of results.entries()) {
      if (r.status === 'fulfilled' && r.value > 0n && (!best || r.value > best.amountOut)) {
        best = { amountOut: r.value, route: { version: 3, fee: FEE_TIERS[i]! } };
      }
    }
    return best;
  }

  async function v3Pool(token: Address, fee: number): Promise<Address> {
    v3Factory ??= rhc.readContract({ address: uniswapRouter, abi: ROUTER_ABI, functionName: 'factory' }).catch((err: unknown) => {
      v3Factory = null;
      throw err;
    });
    return rhc.readContract({ address: await v3Factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [token, weth, fee] });
  }

  /**
   * Launchpad V3 pools keep one observation, so `observe` reverts ('OLD') whenever the pool traded within the
   * TWAP window. Growing the ring once (a few hundred cold slots, fractions of a cent on RHC) lets a TWAP build up.
   * Best-effort: runs before any swap, and a failure only leaves the TWAP check to refuse ('no-twap') later.
   */
  async function ensureObservations(send: Send, token: Address, pool: Address): Promise<void> {
    try {
      const slot0 = await rhc.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'slot0' });
      if (slot0[4] >= OBSERVATION_CARDINALITY) return;
      const grown = await send({
        to: pool,
        data: encodeFunctionData({ abi: V3_POOL_ABI, functionName: 'increaseObservationCardinalityNext', args: [OBSERVATION_CARDINALITY] }),
        what: `grow TWAP history of the ${token} pool`,
      });
      log.info('Grew Uniswap V3 pool observation cardinality for the buyback TWAP guard', { token, pool, from: slot0[4], to: OBSERVATION_CARDINALITY, tx: grown.ref.hash });
    } catch (err) {
      log.warn('Growing Uniswap V3 pool observation cardinality failed', { token, pool, error: shortError(err) });
    }
  }

  /**
   * Throws PriceGuardError when the buy would move the price too far, or pays too much over its time-weighted
   * reference: the V3 pool's TWAP, or for V4 the caller's `referencePrice` (required: V4 has no on-chain TWAP).
   */
  async function guardPrice(send: Send, token: Address, amountIn: bigint, q: RoutedQuote, max: PriceGuardLimits, referencePrice: number | undefined): Promise<void> {
    const refIn = referenceAmount(amountIn);
    let refOut: bigint;
    try {
      refOut = await (q.route.version === 4 ? quoteV4(q.route.key, refIn) : quoteV3(token, refIn, q.route.fee));
    } catch (err) {
      throw new PriceGuardError('price-impact', `reference quote of ${formatEther(refIn)} ETH for ${token} failed: ${shortError(err)}`);
    }
    const impact = priceImpactBps({ amountIn: refIn, amountOut: refOut }, { amountIn, amountOut: q.amountOut });
    if (impact > max.maxPriceImpactBps) {
      throw new PriceGuardError(
        'price-impact',
        `buying ${token} with ${formatEther(amountIn)} ETH would move its price ${bps(impact)} bps (max ${max.maxPriceImpactBps})`,
      );
    }
    // V4: neither PoolManager nor the Pons hook (beforeInitialize + afterSwap only) keeps a price accumulator, and
    // StateView exposes only spot state, so the time-weighted reference comes from the engine's own samples of
    // `spotPrice` (fees included, so no fee is netted out here). An impact cap alone would pass a buy into a pool
    // whose price was pushed up beforehand: the reference trade is quoted at the same inflated spot.
    if (q.route.version === 4) {
      if (referencePrice === undefined || !(referencePrice > 0)) {
        throw new PriceGuardError('no-twap', `no time-weighted reference price for the ${token} V4 pool yet; refusing to buy blind`);
      }
      const deviation = twapDeviationBps(amountIn, q.amountOut, referencePrice, 0);
      if (deviation > max.maxTwapDeviationBps) {
        throw new PriceGuardError(
          'twap-deviation',
          `buying ${token} with ${formatEther(amountIn)} ETH pays ${bps(deviation)} bps over its rolling reference price (max ${max.maxTwapDeviationBps})`,
        );
      }
      return;
    }

    const { fee } = q.route;
    const pool = await v3Pool(token, fee);
    await ensureObservations(send, token, pool);
    let tick: number;
    try {
      const [cumulatives] = await rhc.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'observe', args: [[TWAP_WINDOW_SEC, 0]] });
      tick = meanTick(cumulatives[0]!, cumulatives[1]!, TWAP_WINDOW_SEC);
    } catch (err) {
      throw new PriceGuardError(
        'no-twap',
        `no ${TWAP_WINDOW_SEC}s TWAP for the ${token} pool ${pool} (${shortError(err)}); refusing to buy blind, retry once it has history`,
      );
    }
    const fair = tokensPerWethAtTick(tick, BigInt(token) < BigInt(weth));
    const deviation = twapDeviationBps(amountIn, q.amountOut, fair, fee);
    if (deviation > max.maxTwapDeviationBps) {
      throw new PriceGuardError(
        'twap-deviation',
        `buying ${token} with ${formatEther(amountIn)} ETH pays ${bps(deviation)} bps over its ${TWAP_WINDOW_SEC}s TWAP (max ${max.maxTwapDeviationBps})`,
      );
    }
  }

  /** The swap tx, with a deadline on both routes so a delayed tx reverts instead of filling at a stale minimum. */
  async function swapRequest(token: Address, route: PoolRoute, amountIn: bigint, amountOutMinimum: bigint): Promise<SendRequest> {
    const deadline = (await rhc.getBlock()).timestamp + SWAP_DEADLINE_SEC;
    if (route.version === 3) {
      const swap = encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [{ tokenIn: weth, tokenOut: token, fee: route.fee, recipient: wallet, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
      });
      return {
        to: uniswapRouter,
        value: amountIn,
        data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [deadline, [swap]] }),
        what: `Uniswap V3 buyback of ${token}`,
      };
    }
    return {
      to: uniswapUniversalRouter,
      value: amountIn,
      data: v4BuyCalldata(route.key, amountIn, amountOutMinimum, deadline),
      what: `Uniswap V4 buyback of ${token}`,
    };
  }

  const balanceCall = (token: Address) => ({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }) as const;

  /**
   * Tokens the swap credited: balance delta at its block (fee-on-transfer safe); else the delta at the latest block
   * (we still hold the send lock, so none of our txs moved it); else the receipt's Transfers to us. Never throws.
   */
  async function credited(swap: Sent, token: Address, before: bigint): Promise<bigint> {
    try {
      return (await rhc.readContract({ ...balanceCall(token), blockNumber: swap.receipt.blockNumber })) - before;
    } catch (err) {
      log.warn('Buyback balance read at the swap block failed; reading the latest balance instead', { token, tx: swap.ref.hash, error: shortError(err) });
    }
    try {
      return (await rhc.readContract(balanceCall(token))) - before;
    } catch (err) {
      log.warn('Buyback balance read failed; counting the receipt Transfers instead', { token, tx: swap.ref.hash, error: shortError(err) });
      return transfersTo(swap.receipt.logs, token, wallet);
    }
  }

  const gasOf = (spent: { gasWei: bigint } | null) => spent?.gasWei ?? 0n;

  return {
    async quote(token, amountInWei) {
      const q = await bestQuote(token, amountInWei);
      return q && { amountOut: q.amountOut, feeTier: q.route.version === 4 ? q.route.key.fee : q.route.fee };
    },

    async spotPrice(token) {
      const launch = await readPonsV2Launch(rhc, ponsV2Factory, token);
      if (!launch || launch.phase !== PonsV2Phase.Pool || !isAddressEqual(launch.pairToken, NATIVE)) return null;
      const out = await quoteV4(ponsV2PoolKey(launch, ponsV2Hook), MIN_REFERENCE_WEI);
      return out > 0n ? Number(out) / Number(MIN_REFERENCE_WEI) : null;
    },

    async buyAndBurn(token, amountInWei, maxSlippageBps, opts = {}): Promise<BuybackResult> {
      if (!sender || !limits) throw new ReadOnlyError('Uniswap buyback');
      return sender.exclusive(async (rawSend) => {
        const { send, spent } = meter(rawSend);
        const q = await bestQuote(token, amountInWei);
        if (!q) throw new Error(`no Uniswap pool with liquidity for ${token}`);
        const amountOutMinimum = minAmountOut(q.amountOut, maxSlippageBps);
        try {
          await guardPrice(send, token, amountInWei, q, limits, opts.referencePrice);
        } catch (err) {
          // A refusal after growing the V3 observation ring still spent that tx's gas: report it for booking.
          if (err instanceof PriceGuardError) err.spent = spent();
          throw err;
        }
        const request = await swapRequest(token, q.route, amountInWei, amountOutMinimum);
        const before = await rhc.readContract(balanceCall(token));
        const onSwapBroadcast = opts.onSwapBroadcast;

        let swap: Sent;
        try {
          swap = await send({ ...request, onBroadcast: onSwapBroadcast && ((hash, nonce) => onSwapBroadcast({ hash, nonce })) });
        } catch (err) {
          // Pre-broadcast failures spent nothing. Once broadcast (onSwapBroadcast fired), the outcome is resolved by hash.
          throw new Error(`${shortError(err)}; if that swap landed, its ${token} stays unburned in ${wallet} until its tx is looked up`);
        }

        // The swap spent protocol ETH: from here on only report, never throw, so the caller books it.
        const bought = await credited(swap, token, before);
        const base = { amountInWei, swapTx: swap.ref, burnTx: null };
        if (bought <= 0n) {
          log.error('Buyback swap landed but credited no tokens', { token, tx: swap.ref.hash, amountOut: String(bought) });
          return { ...base, amountOut: 0n, gasWei: gasOf(spent()) };
        }
        let burnUnconfirmed: BroadcastTx | null = null;
        try {
          const burn = await send(burnRequest(token, bought));
          return { ...base, amountOut: bought, burnTx: burn.ref, gasWei: gasOf(spent()) };
        } catch (err) {
          if (err instanceof UnconfirmedTxError) burnUnconfirmed = { hash: err.hash, nonce: err.nonce };
          log.error('Buyback burn failed; bought tokens remain in the protocol wallet', {
            token,
            amount: String(bought),
            swapTx: swap.ref.hash,
            error: shortError(err),
          });
        }
        return { ...base, amountOut: bought, gasWei: gasOf(spent()), burnUnconfirmed };
      });
    },

    async burnHeld(token, amount, onBroadcast) {
      if (!sender) throw new ReadOnlyError('Burning held tokens');
      if (amount <= 0n) throw new RangeError('burn amount must be positive');
      return sender.exclusive(async (send) => {
        // Clamped to the balance: a burn that already landed unconfirmed, or a fee-on-transfer token credited less
        // than its Transfer said, must not wedge the retry forever.
        const held = await rhc.readContract(balanceCall(token));
        const burn = held < amount ? held : amount;
        if (burn <= 0n) return { amount: 0n, tx: null, gasWei: 0n };
        if (burn < amount) log.warn('Burning only what the protocol wallet still holds', { token, requested: String(amount), held: String(held) });
        const sent = await send({ ...burnRequest(token, burn), onBroadcast: onBroadcast && ((hash, nonce) => onBroadcast({ hash, nonce })) });
        return { amount: burn, tx: sent.ref, gasWei: sent.gasCostWei };
      });
    },

    async lookupTx({ hash, nonce }, token): Promise<TxOutcome> {
      const h = hash as Hex;
      // The nonce is read first: a receipt still missing after it means the tx had not mined when the nonce was used up.
      const mined = await rhc.getTransactionCount({ address: wallet, blockTag: 'latest' });
      let receipt;
      try {
        receipt = await rhc.getTransactionReceipt({ hash: h });
      } catch (err) {
        if (!(err instanceof TransactionReceiptNotFoundError)) throw err;
        // Not mined (yet): once the wallet's mined nonce passed it, another tx took that nonce and this one never will.
        return mined > nonce ? { status: 'dropped' } : { status: 'pending' };
      }
      const tx = await rhc.getTransaction({ hash: h });
      return {
        status: 'mined',
        ok: receipt.status === 'success',
        tx: { chain: 'rhc', hash },
        gasWei: receipt.gasUsed * receipt.effectiveGasPrice,
        valueWei: tx.value,
        received: transfersTo(receipt.logs, token, wallet),
        burned: transfersTo(receipt.logs, token, BURN_ADDRESS),
      };
    },
  };
}
