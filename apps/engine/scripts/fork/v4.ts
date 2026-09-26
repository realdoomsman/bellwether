/** Uniswap V4 trades by throwaway traders on a Pons V2 pool (UniversalRouter; sells approve through Permit2). */
import { encodeAbiParameters, encodeFunctionData, erc20Abi, maxUint160, maxUint256, parseAbi, parseAbiParameters } from 'viem';
import type { Account, Hex } from 'viem';
import type { NetworkConfig } from '../../src/ports.ts';
import type { PonsV2Launch } from '../../src/integrations/ponsv2.ts';
import { ponsV2PoolKey } from '../../src/integrations/ponsv2.ts';
import { v4BuyCalldata } from '../../src/integrations/uniswap.ts';
import type { Fork } from './anvil.ts';
import { sendAs } from './pads.ts';
import type { Sent } from './pads.ts';

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const EXACT_IN_SINGLE = parseAbiParameters(
  '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 minHopPriceX36, bytes hookData)',
);
const CURRENCY_AMOUNT = parseAbiParameters('address currency, uint256 amount');
const DEADLINE = 2n ** 48n;

export async function v4Buy(fork: Fork, net: NetworkConfig, account: Account, launch: PonsV2Launch, amountIn: bigint): Promise<Sent> {
  const key = ponsV2PoolKey(launch, net.contracts.ponsV2Hook);
  return sendAs(fork, account, { to: net.contracts.uniswapUniversalRouter, value: amountIn, data: v4BuyCalldata(key, amountIn, 0n, DEADLINE) });
}

/** token (currency1) → native ETH (currency0). */
export async function v4Sell(fork: Fork, net: NetworkConfig, account: Account, launch: PonsV2Launch, amountIn: bigint): Promise<Sent> {
  const router = net.contracts.uniswapUniversalRouter;
  const key = ponsV2PoolKey(launch, net.contracts.ponsV2Hook);
  await sendAs(fork, account, { to: launch.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] }) });
  await sendAs(fork, account, {
    to: PERMIT2,
    data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [launch.token, router, maxUint160, 2 ** 47] }),
  });
  const params: Hex[] = [
    encodeAbiParameters(EXACT_IN_SINGLE, [{ poolKey: key, zeroForOne: false, amountIn, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: '0x' }]),
    encodeAbiParameters(CURRENCY_AMOUNT, [key.currency1, amountIn]),
    encodeAbiParameters(CURRENCY_AMOUNT, [key.currency0, 0n]),
  ];
  const input = encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), ['0x060c0f', params]);
  return sendAs(fork, account, {
    to: router,
    data: encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: 'execute', args: ['0x10', [input], DEADLINE] }),
  });
}
