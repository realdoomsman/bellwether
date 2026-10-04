/**
 * Launchpad and market actions for fork proofs, performed as ordinary users would: launching tokens
 * with the protocol key as the fee wallet, and trading them from throwaway trader accounts.
 */
import { decodeEventLog, encodeFunctionData, erc20Abi, getAddress, keccak256, maxUint256, parseAbi, toHex, zeroAddress } from 'viem';
import type { Account, Address, Hex, TransactionReceipt } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { NetworkConfig } from '../../src/ports.ts';
import { PONS_V2_FACTORY_ABI } from '../../src/integrations/ponsv2.ts';
import { FORK_RECEIPT_TIMEOUT_MS } from './anvil.ts';
import type { Fork } from './anvil.ts';

const PONS_V1_FACTORY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function launchFee() view returns (uint256)',
  'function setWhitelistedLauncher(address launcher, bool allowed)',
  'function launchToken((string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creator) params, uint256 launchConfigId, uint256 dexId, bytes32 salt) payable',
]);
/** Pons V1 factory launch event (token, creator, pool indexed). */
const PONS_V1_LAUNCH_TOPIC = '0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a';

const PONS_V2_LAUNCH_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'function launchToken(TokenParams params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function launchFee() view returns (uint256)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]);

export const PONS_V2_CURVE_TRADE_ABI = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'function sellableTokens() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function sweepFees(uint256 minBuybackTokensOut)',
]);

export const PONS_V2_FEE_POLICY_ABI = parseAbi(['function feeSweepOperator() view returns (address)']);

const LAUNCHHOOD_FACTORY_ABI = parseAbi([
  'function launchToken((string name, string symbol, string uri, address rewardRecipient) meta, uint256 dexConfigId, uint256 launchConfigId, bytes32 salt, uint256 minTokensOut) payable',
]);
/** LaunchHood factory TokenLaunched(token indexed, creator indexed, pool indexed, …). */
const LAUNCHHOOD_LAUNCH_TOPIC_PREFIX = '0x235e34a4';

const SWAP_ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

const SOCIALS = { twitter: '', telegram: '', discord: '', website: '', farcaster: '' };

export interface Sent {
  hash: Hex;
  receipt: TransactionReceipt;
}

export async function sendAs(fork: Fork, account: Account, tx: { to: Address; data?: Hex; value?: bigint }): Promise<Sent> {
  const hash = await fork.wallet(account).sendTransaction({ ...tx, gas: 15_000_000n });
  const receipt = await fork.pub.waitForTransactionReceipt({ hash, timeout: FORK_RECEIPT_TIMEOUT_MS });
  if (receipt.status !== 'success') throw new Error(`tx ${hash} to ${tx.to} reverted`);
  return { hash, receipt };
}

/** A fresh throwaway account funded on the fork. */
export async function trader(fork: Fork, eth = '1000'): Promise<Account> {
  const account = privateKeyToAccount(generatePrivateKey());
  await fork.fund(account.address, eth);
  return account;
}

const randomSalt = (): Hex => keccak256(toHex(`${Date.now()}-${Math.random()}`));

/**
 * Pons V1: public launching is closed (`launchToken` reverts NotWhitelisted() for everyone). On the fork
 * only, the factory owner whitelists `creator`, which then launches with itself as the Creator wallet.
 */
export async function launchPonsV1(fork: Fork, net: NetworkConfig, creator: Account, symbol: string): Promise<{ token: Address; tx: Hex }> {
  const factory = net.contracts.ponsFactory;
  const owner = await fork.pub.readContract({ address: factory, abi: PONS_V1_FACTORY_ABI, functionName: 'owner' });
  await fork.fund(owner, '1');
  await fork.impersonate(owner, {
    to: factory,
    data: encodeFunctionData({ abi: PONS_V1_FACTORY_ABI, functionName: 'setWhitelistedLauncher', args: [creator.address, true] }),
  });
  const fee = await fork.pub.readContract({ address: factory, abi: PONS_V1_FACTORY_ABI, functionName: 'launchFee' });
  const sent = await sendAs(fork, creator, {
    to: factory,
    value: fee,
    data: encodeFunctionData({
      abi: PONS_V1_FACTORY_ABI,
      functionName: 'launchToken',
      args: [{ name: `Fork Proof ${symbol}`, symbol, logo: '', description: 'fork proof', socials: SOCIALS, creator: creator.address }, 0n, 0n, randomSalt()],
    }),
  });
  const ev = sent.receipt.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase() && l.topics[0] === PONS_V1_LAUNCH_TOPIC);
  if (!ev?.topics[1]) throw new Error(`Pons V1 launch ${sent.hash} emitted no launch event`);
  return { token: getAddress(`0x${ev.topics[1].slice(26)}`), tx: sent.hash };
}

/** Pons V2: an ordinary public launch, ETH-paired, creator fees to `creator`, buybacks off. */
export async function launchPonsV2(fork: Fork, net: NetworkConfig, creator: Account, symbol: string): Promise<{ token: Address; curve: Address; tx: Hex }> {
  const factory = net.contracts.ponsV2Factory;
  const [economics, fee] = await Promise.all([
    fork.pub.readContract({ address: factory, abi: PONS_V2_LAUNCH_ABI, functionName: 'previewLaunchEconomics', args: [0n, zeroAddress] }),
    fork.pub.readContract({ address: factory, abi: PONS_V2_LAUNCH_ABI, functionName: 'launchFee' }),
  ]);
  const sent = await sendAs(fork, creator, {
    to: factory,
    value: fee,
    data: encodeFunctionData({
      abi: PONS_V2_LAUNCH_ABI,
      functionName: 'launchToken',
      args: [
        {
          name: `Fork Proof ${symbol}`,
          symbol,
          logo: '',
          description: 'fork proof',
          socials: SOCIALS,
          creatorFeeRecipient: creator.address,
          creatorTaxBps: 0,
          buybackEnabled: false,
          expectedEconomics: economics,
          salt: randomSalt(),
        },
        0n,
        zeroAddress,
      ],
    }),
  });
  for (const l of sent.receipt.logs) {
    if (l.address.toLowerCase() !== factory.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: PONS_V2_LAUNCH_ABI, eventName: 'TokenLaunched', data: l.data, topics: l.topics });
      return { token: ev.args.token, curve: ev.args.curve, tx: sent.hash };
    } catch {
      // other factory events
    }
  }
  throw new Error(`Pons V2 launch ${sent.hash} emitted no TokenLaunched`);
}

/** LaunchHood: permissionless launch with `creator` as the Reward recipient. */
export async function launchLaunchHood(fork: Fork, net: NetworkConfig, creator: Account, symbol: string): Promise<{ token: Address; tx: Hex }> {
  const factory = net.contracts.launchhoodFactory;
  const sent = await sendAs(fork, creator, {
    to: factory,
    data: encodeFunctionData({
      abi: LAUNCHHOOD_FACTORY_ABI,
      functionName: 'launchToken',
      args: [{ name: `Fork Proof ${symbol}`, symbol, uri: '', rewardRecipient: creator.address }, 0n, 0n, randomSalt(), 0n],
    }),
  });
  const ev = sent.receipt.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase() && l.topics[0]?.startsWith(LAUNCHHOOD_LAUNCH_TOPIC_PREFIX));
  if (!ev?.topics[1]) throw new Error(`LaunchHood launch ${sent.hash} emitted no TokenLaunched`);
  return { token: getAddress(`0x${ev.topics[1].slice(26)}`), tx: sent.hash };
}

export async function balanceOf(fork: Fork, token: Address, holder: Address): Promise<bigint> {
  return fork.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
}

/** Uniswap V3 (SwapRouter02): ETH → token. */
export async function v3Buy(fork: Fork, net: NetworkConfig, account: Account, token: Address, fee: number, amountIn: bigint): Promise<Sent> {
  return sendAs(fork, account, {
    to: net.contracts.uniswapRouter,
    value: amountIn,
    data: encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: net.contracts.weth, tokenOut: token, fee, recipient: account.address, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    }),
  });
}

/** Uniswap V3 (SwapRouter02): token → WETH. */
export async function v3Sell(fork: Fork, net: NetworkConfig, account: Account, token: Address, fee: number, amountIn: bigint): Promise<Sent> {
  await sendAs(fork, account, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [net.contracts.uniswapRouter, maxUint256] }) });
  return sendAs(fork, account, {
    to: net.contracts.uniswapRouter,
    data: encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{ tokenIn: token, tokenOut: net.contracts.weth, fee, recipient: account.address, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    }),
  });
}

export async function curveBuy(fork: Fork, account: Account, curve: Address, quoteIn: bigint): Promise<Sent> {
  return sendAs(fork, account, {
    to: curve,
    value: quoteIn,
    data: encodeFunctionData({ abi: PONS_V2_CURVE_TRADE_ABI, functionName: 'buy', args: [quoteIn, 0n, account.address] }),
  });
}

export async function curveSell(fork: Fork, account: Account, curve: Address, token: Address, tokensIn: bigint): Promise<Sent> {
  await sendAs(fork, account, { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [curve, maxUint256] }) });
  return sendAs(fork, account, {
    to: curve,
    data: encodeFunctionData({ abi: PONS_V2_CURVE_TRADE_ABI, functionName: 'sell', args: [tokensIn, 0n, account.address] }),
  });
}

export async function readV2Phase(fork: Fork, net: NetworkConfig, token: Address): Promise<number> {
  const r = await fork.pub.readContract({ address: net.contracts.ponsV2Factory, abi: PONS_V2_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] });
  return r.phase;
}

const PONS_V2_GRADUATION_ABI = parseAbi(['function createGraduatedPool(address token) returns (uint256 positionId)']);

/**
 * Graduation phase 2: the crossing buy only sweeps the curve (phase Swept); seeding the V4 pool is a
 * separate permissionless call (Pons' keeper normally makes it), done here by any account.
 */
export async function createGraduatedPool(fork: Fork, net: NetworkConfig, account: Account, token: Address): Promise<Sent> {
  return sendAs(fork, account, {
    to: net.contracts.ponsV2Factory,
    data: encodeFunctionData({ abi: PONS_V2_GRADUATION_ABI, functionName: 'createGraduatedPool', args: [token] }),
  });
}
