/**
 * Uniswap V3 on Robinhood Chain: quotes and ETH → token buybacks whose proceeds are burned.
 * Launchpad tokens graduate into WETH-paired V3 pools; SwapRouter02 wraps msg.value itself.
 */
import { encodeFunctionData, erc20Abi, parseAbi } from 'viem';
import type { Address } from 'viem';
import type { BuybackResult, Dex, NetworkConfig } from '../ports.ts';
import type { Client } from './chains.ts';
import { burnRequest } from './erc20.ts';
import { ReadOnlyError, shortError } from './errors.ts';
import type { TxSender } from './tx.ts';

const FEE_TIERS = [10_000, 3_000, 500, 100] as const;

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

/** Least acceptable output for a quote under a slippage budget in basis points (rounds down). */
export function minAmountOut(quoted: bigint, maxSlippageBps: number): bigint {
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps >= 10_000) {
    throw new RangeError(`maxSlippageBps must be an integer in [0, 10000), got ${maxSlippageBps}`);
  }
  return (quoted * BigInt(10_000 - maxSlippageBps)) / 10_000n;
}

export interface UniswapDeps {
  rhc: Client;
  net: NetworkConfig;
  sender: TxSender | null;
}

export function createUniswap({ rhc, net, sender }: UniswapDeps): Dex {
  const { weth, uniswapRouter, uniswapQuoter } = net.contracts;
  const wallet = net.protocolAddress;

  async function quoteTier(token: Address, amountIn: bigint, fee: number): Promise<bigint> {
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

  async function quote(token: Address, amountInWei: bigint): Promise<{ amountOut: bigint; feeTier: number } | null> {
    if (amountInWei <= 0n) throw new RangeError('quote amount must be positive');
    const results = await Promise.allSettled(FEE_TIERS.map((fee) => quoteTier(token, amountInWei, fee)));
    let best: { amountOut: bigint; feeTier: number } | null = null;
    for (const [i, r] of results.entries()) {
      if (r.status === 'fulfilled' && r.value > 0n && (!best || r.value > best.amountOut)) {
        best = { amountOut: r.value, feeTier: FEE_TIERS[i]! };
      }
    }
    return best;
  }

  return {
    quote,

    async buyAndBurn(token, amountInWei, maxSlippageBps): Promise<BuybackResult> {
      if (!sender) throw new ReadOnlyError('Uniswap buyback');
      return sender.exclusive(async (send) => {
        const q = await quote(token, amountInWei);
        if (!q) throw new Error(`no Uniswap V3 WETH pool with liquidity for ${token}`);
        const amountOutMinimum = minAmountOut(q.amountOut, maxSlippageBps);
        const balanceCall = { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] } as const;

        const before = await rhc.readContract(balanceCall);
        const swap = await send({
          to: uniswapRouter,
          value: amountInWei,
          data: encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: 'exactInputSingle',
            args: [
              {
                tokenIn: weth,
                tokenOut: token,
                fee: q.feeTier,
                recipient: wallet,
                amountIn: amountInWei,
                amountOutMinimum,
                sqrtPriceLimitX96: 0n,
              },
            ],
          }),
          what: `Uniswap buyback of ${token}`,
        });
        // Balance delta, not the router's amountOut: fee-on-transfer tokens credit less than they report.
        const received = (await rhc.readContract({ ...balanceCall, blockNumber: swap.receipt.blockNumber })) - before;
        if (received <= 0n) throw new Error(`buyback swap ${swap.ref.hash} credited no ${token}`);
        let burn;
        try {
          burn = await send(burnRequest(token, received));
        } catch (err) {
          throw new Error(`bought ${received} of ${token} in ${swap.ref.hash} but the burn failed: ${shortError(err)}`);
        }
        return { amountInWei, amountOut: received, swapTx: swap.ref, burnTx: burn.ref };
      });
    },
  };
}
