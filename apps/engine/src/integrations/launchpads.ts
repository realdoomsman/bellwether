/**
 * Robinhood Chain launchpads (Pons, LaunchHood). Their contracts are unverified; the views and
 * calls below were identified from bytecode selectors and confirmed against live launches.
 *
 * Origin: each factory keeps a registry, getLaunchedToken(token), that is all zeros for tokens it
 * did not launch and names the launching EOA for tokens it did.
 * Fee routing is read from each launchpad's locker (holds the locked Uniswap V3 LP, pays its fees):
 *   Pons       feeRecipientTokens(wallet, i) enumerates the tokens whose creator fees go to wallet;
 *              collectFees(token) pays the recipient.
 *   LaunchHood rewardRecipient(positionOf(token)); collect(positionId) pays the recipient.
 * If a locker getter stops answering (contract replaced), verification falls back to the launch
 * transaction naming the protocol wallet, as the reference did.
 * Lockers pay LP fees in WETH and in the memecoin itself; WETH is unwrapped and the memecoin burned.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  MethodNotFoundRpcError,
  MethodNotSupportedRpcError,
  parseAbi,
} from 'viem';
import type { Address, Log } from 'viem';
import { LAUNCHPAD_IDS, LAUNCHPADS } from '@floor/shared';
import type { LaunchpadId } from '@floor/shared';
import type { Hex, Launchpad, LaunchpadVerifyFailure, LaunchpadVerifyResult, NetworkConfig, TokenMetadata, TxReceiptRef } from '../ports.ts';
import { log } from '../log.ts';
import type { Client } from './chains.ts';
import { findLaunch, launchMentions } from './creation.ts';
import { burnRequest, transfersTo, WETH_ABI } from './erc20.ts';
import { ReadOnlyError, shortError } from './errors.ts';
import { addressTopic } from './hex.ts';
import type { Send, TxSender } from './tx.ts';

// Registry getters return larger structs; only the leading static fields are declared and decoded.
const PONS_FACTORY_ABI = parseAbi(['function getLaunchedToken(address token) view returns (address launched, address deployer)']);
const PONS_LOCKER_ABI = parseAbi([
  'function feeRecipientTokenCount(address recipient) view returns (uint256)',
  'function feeRecipientTokens(address recipient, uint256 index) view returns (address)',
  'function collectFees(address token) returns (uint256, uint256)',
]);
const LAUNCHHOOD_FACTORY_ABI = parseAbi([
  'function LOCKER() view returns (address)',
  'function isLaunchHoodToken(address token) view returns (bool)',
  'function getLaunchedToken(address token) view returns (address creator)',
]);
const LAUNCHHOOD_LOCKER_ABI = parseAbi([
  'function positionOf(address token) view returns (uint256)',
  'function rewardRecipient(uint256 positionId) view returns (address)',
  'function collect(uint256 positionId)',
]);
const TOKEN_IMAGE_ABI = parseAbi(['function logo() view returns (string)', 'function image() view returns (string)']);
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Pseudo-emitter of native ETH transfers in `eth_simulateV1` with traceTransfers. */
const NATIVE_TRANSFER_EMITTER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

interface FeeRouting {
  ok: boolean;
  detail: string;
}

interface ClaimCall {
  to: Address;
  data: Hex;
}

export interface LaunchOrigin {
  launchpad: LaunchpadId;
  /** EOA that launched the token. */
  deployer: Address;
}

interface PadSpec {
  id: LaunchpadId;
  factory: Address;
  /** Launching EOA if this launchpad's factory launched `token`, else null. */
  deployerOf(token: Address): Promise<Address | null>;
  /** Authoritative on-chain check; null when the launchpad exposes no getter to answer it. */
  feeRouting(token: Address): Promise<FeeRouting | null>;
  /** Null when the launchpad holds nothing to claim for this token. */
  claimCall(token: Address): Promise<ClaimCall | null>;
}

export interface LaunchpadDeps {
  rhc: Client;
  net: NetworkConfig;
  /** Null = read-only. */
  sender: TxSender | null;
}

/** A getter that reverts or returns nothing means "this contract has no such view", not a network failure. */
function isMissingView(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
}

function isUnsupportedRpc(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof MethodNotFoundRpcError || e instanceof MethodNotSupportedRpcError) !== null;
}

function howTo(id: LaunchpadId, wallet: Address): string {
  const lp = LAUNCHPADS[id];
  return `Set the ${lp.feeField} field (${lp.feeFieldLocation}) to ${wallet} at launch.`;
}

function imageUrl(uri: string | undefined): string | null {
  const u = uri?.trim();
  if (!u) return null;
  if (u.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${u.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  return /^https?:\/\//.test(u) ? u : null;
}

async function readMetadata(rhc: Client, token: Address): Promise<TokenMetadata | null> {
  const [name, symbol, decimals, totalSupply, logo, image] = await rhc.multicall({
    allowFailure: true,
    contracts: [
      { address: token, abi: erc20Abi, functionName: 'name' },
      { address: token, abi: erc20Abi, functionName: 'symbol' },
      { address: token, abi: erc20Abi, functionName: 'decimals' },
      { address: token, abi: erc20Abi, functionName: 'totalSupply' },
      { address: token, abi: TOKEN_IMAGE_ABI, functionName: 'logo' },
      { address: token, abi: TOKEN_IMAGE_ABI, functionName: 'image' },
    ],
  });
  if (name.status !== 'success' || symbol.status !== 'success' || decimals.status !== 'success' || totalSupply.status !== 'success') {
    return null;
  }
  return {
    name: name.result,
    symbol: symbol.result,
    decimals: decimals.result,
    totalSupply: totalSupply.result,
    image: imageUrl(logo.result) ?? imageUrl(image.result),
  };
}

function ponsSpec(rhc: Client, net: NetworkConfig): PadSpec {
  const { ponsFactory: factory, ponsLocker: locker } = net.contracts;
  const wallet = net.protocolAddress;
  return {
    id: 'pons',
    factory,
    async deployerOf(token) {
      const [launched, deployer] = await rhc.readContract({ address: factory, abi: PONS_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] });
      return isAddressEqual(launched, token) ? deployer : null;
    },
    async feeRouting(token) {
      try {
        const count = await rhc.readContract({ address: locker, abi: PONS_LOCKER_ABI, functionName: 'feeRecipientTokenCount', args: [wallet] });
        const tokens =
          count === 0n
            ? []
            : await rhc.multicall({
                allowFailure: false,
                batchSize: 0,
                contracts: Array.from({ length: Number(count) }, (_, i) => ({
                  address: locker,
                  abi: PONS_LOCKER_ABI,
                  functionName: 'feeRecipientTokens' as const,
                  args: [wallet, BigInt(i)] as const,
                })),
              });
        return tokens.some((t) => isAddressEqual(t, token))
          ? { ok: true, detail: `Pons routes this token's creator fees to ${wallet}.` }
          : { ok: false, detail: `Pons does not route this token's creator fees to ${wallet}. ${howTo('pons', wallet)}` };
      } catch (err) {
        if (isMissingView(err)) return null;
        throw err;
      }
    },
    async claimCall(token) {
      return { to: locker, data: encodeFunctionData({ abi: PONS_LOCKER_ABI, functionName: 'collectFees', args: [token] }) };
    },
  };
}

function launchhoodSpec(rhc: Client, net: NetworkConfig): PadSpec {
  const factory = net.contracts.launchhoodFactory;
  const wallet = net.protocolAddress;
  let locker: Promise<Address> | null = null;
  const getLocker = (): Promise<Address> => {
    if (net.contracts.launchhoodLocker) return Promise.resolve(net.contracts.launchhoodLocker);
    locker ??= rhc.readContract({ address: factory, abi: LAUNCHHOOD_FACTORY_ABI, functionName: 'LOCKER' }).catch((err: unknown) => {
      locker = null;
      throw err;
    });
    return locker;
  };
  const positionOf = async (token: Address) => {
    const address = await getLocker();
    const id = await rhc.readContract({ address, abi: LAUNCHHOOD_LOCKER_ABI, functionName: 'positionOf', args: [token] });
    return { locker: address, id };
  };
  return {
    id: 'launchhood',
    factory,
    async deployerOf(token) {
      const [isOurs, creator] = await rhc.multicall({
        allowFailure: false,
        contracts: [
          { address: factory, abi: LAUNCHHOOD_FACTORY_ABI, functionName: 'isLaunchHoodToken', args: [token] },
          { address: factory, abi: LAUNCHHOOD_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] },
        ],
      });
      return isOurs ? creator : null;
    },
    async feeRouting(token) {
      try {
        const pos = await positionOf(token);
        if (pos.id === 0n) return { ok: false, detail: 'The LaunchHood locker holds no LP position for this token.' };
        const recipient = await rhc.readContract({ address: pos.locker, abi: LAUNCHHOOD_LOCKER_ABI, functionName: 'rewardRecipient', args: [pos.id] });
        return isAddressEqual(recipient, wallet)
          ? { ok: true, detail: `LaunchHood reward recipient is ${wallet}.` }
          : { ok: false, detail: `Reward recipient is ${recipient}, expected ${wallet}. ${howTo('launchhood', wallet)}` };
      } catch (err) {
        if (isMissingView(err)) return null;
        throw err;
      }
    },
    async claimCall(token) {
      const pos = await positionOf(token);
      if (pos.id === 0n) return null;
      return { to: pos.locker, data: encodeFunctionData({ abi: LAUNCHHOOD_LOCKER_ABI, functionName: 'collect', args: [pos.id] }) };
    },
  };
}

function makeLaunchpad(spec: PadSpec, identify: (token: Address) => Promise<LaunchOrigin | null>, deps: LaunchpadDeps, factories: Record<LaunchpadId, Address>): Launchpad {
  const { rhc, net, sender } = deps;
  const wallet = net.protocolAddress;
  const name = LAUNCHPADS[spec.id].name;

  /** Reference fallback when the locker has no fee-recipient getter: the launch tx must name the wallet. */
  async function launchTxRouting(token: Address): Promise<FeeRouting> {
    const launch = await findLaunch(rhc, net.blockscoutUrl, factories, token);
    if (!launch) throw new Error(`the ${name} launch transaction for ${token} could not be found`);
    if (launchMentions(launch, wallet) || isAddressEqual(launch.deployer, wallet)) {
      return { ok: true, detail: `The ${name} launch transaction names ${wallet}.` };
    }
    return {
      ok: false,
      detail: `The ${name} launch transaction never names ${wallet} (launched by ${launch.deployer}). ${howTo(spec.id, wallet)}`,
    };
  }

  /**
   * What a claim would pay the protocol wallet right now, via eth_simulateV1 transfer tracing.
   * Null if there is nothing to claim, the claim reverts, or the RPC cannot simulate.
   */
  async function previewClaim(token: Address): Promise<{ call: ClaimCall; eth: bigint; tokens: bigint } | null> {
    const call = await spec.claimCall(token);
    if (!call) return null;
    let logs: readonly Log[];
    try {
      const [block] = await rhc.simulateBlocks({
        blocks: [{ calls: [{ account: wallet, to: call.to, data: call.data }] }],
        traceTransfers: true,
      });
      const result = block?.calls[0];
      if (!result || result.status !== 'success') return null;
      logs = result.logs ?? [];
    } catch (err) {
      if (isMissingView(err) || isUnsupportedRpc(err)) return null;
      throw err;
    }
    const walletTopic = addressTopic(wallet);
    const weth = net.contracts.weth.toLowerCase();
    let eth = 0n;
    let tokens = 0n;
    for (const l of logs) {
      if (l.topics[0] !== TRANSFER_TOPIC || l.topics[2]?.toLowerCase() !== walletTopic) continue;
      const emitter = l.address.toLowerCase();
      const value = BigInt(l.data);
      if (emitter === NATIVE_TRANSFER_EMITTER || emitter === weth) eth += value;
      else if (emitter === token.toLowerCase()) tokens += value;
    }
    return { call, eth, tokens };
  }

  async function unwrapAllWeth(send: Send): Promise<void> {
    const weth = net.contracts.weth;
    try {
      const balance = await rhc.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] });
      if (balance === 0n) return;
      await send({ to: weth, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'withdraw', args: [balance] }), what: 'WETH unwrap' });
    } catch (err) {
      // The claim itself landed; leftover WETH is swept by the next claim's unwrap.
      log.error('WETH unwrap after fee claim failed', { error: shortError(err) });
    }
  }

  return {
    id: spec.id,

    async verify(token): Promise<LaunchpadVerifyResult> {
      let deployer: Address | null = null;
      let metadata: TokenMetadata | null = null;
      const fail = (failure: LaunchpadVerifyFailure, detail: string): LaunchpadVerifyResult => ({ ok: false, failure, detail, deployer, metadata });

      let code: Hex | undefined;
      try {
        code = await rhc.getCode({ address: token });
      } catch (err) {
        return fail('lookup-failed', `Robinhood Chain RPC error: ${shortError(err)}`);
      }
      if (!code || code === '0x') return fail('no-contract', `No contract is deployed at ${token} on Robinhood Chain.`);

      let origin: LaunchOrigin | null;
      try {
        [metadata, origin] = await Promise.all([readMetadata(rhc, token), identify(token)]);
      } catch (err) {
        return fail('lookup-failed', `Could not read the launchpad registries: ${shortError(err)}`);
      }
      if (!origin) {
        const names = LAUNCHPAD_IDS.map((id) => LAUNCHPADS[id].name).join(' or ');
        return fail('wrong-launchpad', `This token was not launched by ${names}.`);
      }
      deployer = origin.deployer;
      if (origin.launchpad !== spec.id) {
        return fail('wrong-launchpad', `This token was launched on ${LAUNCHPADS[origin.launchpad].name}, not ${name}.`);
      }

      let routing: FeeRouting;
      try {
        routing = (await spec.feeRouting(token)) ?? (await launchTxRouting(token));
      } catch (err) {
        return fail('lookup-failed', `Could not read ${name} fee routing: ${shortError(err)}`);
      }
      if (!routing.ok) return fail('fee-recipient-mismatch', routing.detail);
      return { ok: true, failure: null, detail: routing.detail, deployer, metadata };
    },

    async claimable(token) {
      const preview = await previewClaim(token);
      return preview ? preview.eth : null;
    },

    async claim(token) {
      if (!sender) throw new ReadOnlyError(`${name} fee claim`);
      return sender.exclusive(async (send) => {
        const preview = await previewClaim(token);
        if (!preview || (preview.eth === 0n && preview.tokens === 0n)) return null;
        const { call } = preview;

        const nativeBefore = await rhc.getBalance({ address: wallet });
        const claimed = await send({ ...call, what: `${name} fee claim` });
        const nativeAfter = await rhc.getBalance({ address: wallet, blockNumber: claimed.receipt.blockNumber });
        const native = nativeAfter - nativeBefore + claimed.gasCostWei;
        const weth = transfersTo(claimed.receipt.logs, net.contracts.weth, wallet);
        const tokens = transfersTo(claimed.receipt.logs, token, wallet);

        await unwrapAllWeth(send);
        let tokensBurned: { amount: bigint; tx: TxReceiptRef } | null = null;
        if (tokens > 0n) {
          try {
            tokensBurned = { amount: tokens, tx: (await send(burnRequest(token, tokens))).ref };
          } catch (err) {
            log.error('Burning claimed memecoin fees failed; tokens remain in the protocol wallet', {
              token,
              amount: tokens,
              error: shortError(err),
            });
          }
        }
        return { amountWei: (native > 0n ? native : 0n) + weth, tx: claimed.ref, tokensBurned };
      });
    },
  };
}

export interface LaunchpadSet {
  launchpads: Record<LaunchpadId, Launchpad>;
  /** Which supported launchpad launched `token` (and who launched it), from the factories' registries. */
  identify(token: Address): Promise<LaunchOrigin | null>;
}

export function createLaunchpads(deps: LaunchpadDeps): LaunchpadSet {
  const specs: Record<LaunchpadId, PadSpec> = { pons: ponsSpec(deps.rhc, deps.net), launchhood: launchhoodSpec(deps.rhc, deps.net) };
  const factories: Record<LaunchpadId, Address> = { pons: specs.pons.factory, launchhood: specs.launchhood.factory };
  async function identify(token: Address): Promise<LaunchOrigin | null> {
    const deployers = await Promise.all(LAUNCHPAD_IDS.map((id) => specs[id].deployerOf(token)));
    const i = deployers.findIndex((d) => d !== null);
    return i < 0 ? null : { launchpad: LAUNCHPAD_IDS[i]!, deployer: deployers[i]! };
  }
  return {
    launchpads: { pons: makeLaunchpad(specs.pons, identify, deps, factories), launchhood: makeLaunchpad(specs.launchhood, identify, deps, factories) },
    identify,
  };
}
