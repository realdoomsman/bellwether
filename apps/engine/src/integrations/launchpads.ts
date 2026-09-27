/**
 * Robinhood Chain launchpads (Pons V1 + V2, LaunchHood). The V1 contracts are unverified; their views and
 * calls were identified from bytecode selectors and confirmed against live launches. Pons V2 is published
 * (see ponsv2.ts).
 *
 * Origin: each factory keeps a registry, getLaunchedToken(token), that is empty for tokens it did not
 * launch and names the launching EOA for tokens it did. Pons tokens come from either Pons factory; which
 * one is detected per token and the launchpad id stays `pons`.
 * Fee routing:
 *   Pons V1    the locker (holds the locked Uniswap V3 LP) enumerates feeRecipientTokens(wallet, i);
 *              collectFees(token) pays the recipient in WETH and the memecoin.
 *   Pons V2    the factory record's creatorFeeRecipient. Fees accrue on the token's bonding curve, then on
 *              the shared V4 hook; a sweep (the Pons operator's, or ours when no internal swap is needed)
 *              credits the recipient's native balance in the fee escrow, which the recipient withdraws.
 *   LaunchHood rewardRecipient(positionOf(token)) on its locker; collect(positionId) pays the recipient
 *              (50% of LP fees) in native ETH and the memecoin.
 * If a V1 locker getter stops answering (contract replaced), verification falls back to the launch
 * transaction naming the protocol wallet, as the reference did.
 * Claims unwrap any WETH received and burn any memecoin received.
 */
import { decodeEventLog, encodeFunctionData, erc20Abi, isAddressEqual, parseAbi, zeroAddress } from 'viem';
import type { Address, Log } from 'viem';
import { LAUNCHPAD_IDS, LAUNCHPADS } from '@bellwether/shared';
import type { LaunchpadId } from '@bellwether/shared';
import type { Hex, Launchpad, LaunchpadVerifyFailure, LaunchpadVerifyResult, NetworkConfig, TokenMetadata, TxReceiptRef } from '../ports.ts';
import { log } from '../log.ts';
import type { Client } from './chains.ts';
import { findLaunch, launchMentions } from './creation.ts';
import { burnRequest, transfersTo, WETH_ABI } from './erc20.ts';
import { isMissingView, isUnsupportedRpc, ReadOnlyError, shortError } from './errors.ts';
import { addressTopic } from './hex.ts';
import type { Send, Sent, TxSender } from './tx.ts';
import {
  createEscrowLedger,
  PONS_V2_CURVE_ABI,
  PONS_V2_ESCROW_ABI,
  PONS_V2_HOOK_ABI,
  PonsV2Phase,
  ponsV2PoolKey,
  readPonsV2Launch,
  taggedClaimData,
  v4PoolId,
} from './ponsv2.ts';
import type { EscrowLedger, PonsV2Launch } from './ponsv2.ts';

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
  /** Calls that pay this token's fees to the wallet, sent in order; empty when there is nothing to claim. */
  claimCalls(token: Address): Promise<ClaimCall[]>;
}

export interface LaunchpadDeps {
  rhc: Client;
  net: NetworkConfig;
  /** Null = read-only. */
  sender: TxSender | null;
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
  const { ponsFactory: factory, ponsLocker: locker, ponsV2Factory, ponsV2Hook, ponsV2FeeEscrow: escrow } = net.contracts;
  const wallet = net.protocolAddress;
  let ledger: EscrowLedger | null = null;
  const escrowLedger = () =>
    (ledger ??= createEscrowLedger({ rhc, factory: ponsV2Factory, hook: ponsV2Hook, escrow, wallet, fromBlock: BigInt(net.ponsV2FromBlock) }));

  async function v1Routing(token: Address): Promise<FeeRouting | null> {
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
  }

  function v2Routing(launch: PonsV2Launch): FeeRouting {
    if (!isAddressEqual(launch.creatorFeeRecipient, wallet)) {
      return { ok: false, detail: `Creator wallet is ${launch.creatorFeeRecipient}, expected ${wallet}. ${howTo('pons', wallet)}` };
    }
    if (!isAddressEqual(launch.pairToken, zeroAddress)) {
      return { ok: false, detail: `This launch is paired with ${launch.pairToken} and pays creator fees in it; only ETH-paired launches are supported.` };
    }
    return { ok: true, detail: `Pons pays this token's creator fees to ${wallet}.` };
  }

  /** Our own sweep of the token's pending fees, when the curve/hook lets the creator sweep them (no internal swap needed). */
  function v2SweepCall(launch: PonsV2Launch): ClaimCall | null {
    if (launch.phase === PonsV2Phase.Curve) {
      return { to: launch.curve, data: encodeFunctionData({ abi: PONS_V2_CURVE_ABI, functionName: 'sweepFees', args: [0n] }) };
    }
    if (launch.phase === PonsV2Phase.Pool) {
      const poolId = v4PoolId(ponsV2PoolKey(launch, ponsV2Hook));
      return { to: ponsV2Hook, data: encodeFunctionData({ abi: PONS_V2_HOOK_ABI, functionName: 'sweepPoolFees', args: [poolId, 0n, 0n] }) };
    }
    return null;
  }

  /** Native ETH a call would credit the wallet in the escrow (0 if it reverts or credits nothing). */
  async function simulatedCredit(call: ClaimCall): Promise<bigint> {
    try {
      const [block] = await rhc.simulateBlocks({ blocks: [{ calls: [{ account: wallet, to: call.to, data: call.data }] }] });
      const result = block?.calls[0];
      if (!result || result.status !== 'success') return 0n;
      let credited = 0n;
      for (const l of result.logs ?? []) {
        if (!isAddressEqual(l.address, escrow)) continue;
        try {
          const ev = decodeEventLog({ abi: PONS_V2_ESCROW_ABI, data: l.data, topics: l.topics });
          if (ev.eventName === 'Credited' && isAddressEqual(ev.args.recipient, wallet)) credited += ev.args.amount;
        } catch {
          // other escrow events
        }
      }
      return credited;
    } catch (err) {
      if (isMissingView(err) || isUnsupportedRpc(err)) return 0n;
      throw err;
    }
  }

  async function v2ClaimCalls(launch: PonsV2Launch): Promise<ClaimCall[]> {
    const calls: ClaimCall[] = [];
    const sweep = v2SweepCall(launch);
    const swept = sweep ? await simulatedCredit(sweep) : 0n;
    if (sweep && swept > 0n) calls.push(sweep);
    const [unclaimed, balance, heldTokens] = await Promise.all([
      escrowLedger().unclaimed(launch.token),
      rhc.readContract({ address: escrow, abi: PONS_V2_ESCROW_ABI, functionName: 'balanceOf', args: [wallet] }),
      rhc.readContract({ address: escrow, abi: PONS_V2_ESCROW_ABI, functionName: 'balanceOfToken', args: [wallet, launch.token] }),
    ]);
    const owed = (unclaimed < balance ? unclaimed : balance) + swept;
    if (owed > 0n) calls.push({ to: escrow, data: taggedClaimData(owed, launch.token) });
    // Released Pons buyback-vault vests credit the memecoin itself; claiming it lets the claim burn it.
    if (heldTokens > 0n) calls.push({ to: escrow, data: encodeFunctionData({ abi: PONS_V2_ESCROW_ABI, functionName: 'claimToken', args: [launch.token] }) });
    return calls;
  }

  return {
    id: 'pons',
    factory,
    async deployerOf(token) {
      const [[launched, deployer], v2] = await Promise.all([
        rhc.readContract({ address: factory, abi: PONS_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] }),
        readPonsV2Launch(rhc, ponsV2Factory, token),
      ]);
      if (isAddressEqual(launched, token)) return deployer;
      return v2?.deployer ?? null;
    },
    async feeRouting(token) {
      const v2 = await readPonsV2Launch(rhc, ponsV2Factory, token);
      return v2 ? v2Routing(v2) : v1Routing(token);
    },
    async claimCalls(token) {
      const v2 = await readPonsV2Launch(rhc, ponsV2Factory, token);
      if (v2) return v2ClaimCalls(v2);
      return [{ to: locker, data: encodeFunctionData({ abi: PONS_LOCKER_ABI, functionName: 'collectFees', args: [token] }) }];
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
    async claimCalls(token) {
      const pos = await positionOf(token);
      if (pos.id === 0n) return [];
      return [{ to: pos.locker, data: encodeFunctionData({ abi: LAUNCHHOOD_LOCKER_ABI, functionName: 'collect', args: [pos.id] }) }];
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
   * What claiming would pay the protocol wallet right now: the launchpad's claim calls simulated in one
   * block via eth_simulateV1 with transfer tracing. Null if there is nothing to claim, a call reverts, or
   * the RPC cannot simulate.
   */
  async function previewClaim(token: Address): Promise<{ calls: ClaimCall[]; eth: bigint; tokens: bigint } | null> {
    const calls = await spec.claimCalls(token);
    if (calls.length === 0) return null;
    let logs: Log[];
    try {
      const [block] = await rhc.simulateBlocks({
        blocks: [{ calls: calls.map((c) => ({ account: wallet, to: c.to, data: c.data })) }],
        traceTransfers: true,
      });
      if (!block || block.calls.length !== calls.length || block.calls.some((r) => r.status !== 'success')) return null;
      logs = block.calls.flatMap((r) => r.logs ?? []);
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
    return { calls, eth, tokens };
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

    async claimablePreview(token) {
      const preview = await previewClaim(token);
      return preview ? { wei: preview.eth, tokens: preview.tokens } : null;
    },

    async claim(token) {
      if (!sender) throw new ReadOnlyError(`${name} fee claim`);
      return sender.exclusive(async (send) => {
        const preview = await previewClaim(token);
        if (!preview || (preview.eth === 0n && preview.tokens === 0n)) return null;

        const nativeBefore = await rhc.getBalance({ address: wallet });
        let gas = 0n;
        let weth = 0n;
        let tokens = 0n;
        let paid: Sent | null = null;
        let last: Sent | null = null;
        for (const [i, call] of preview.calls.entries()) {
          const what = `${name} fee claim${preview.calls.length > 1 ? ` (${i + 1}/${preview.calls.length})` : ''}`;
          let sent: Sent;
          try {
            sent = await send({ ...call, what });
          } catch (err) {
            // Nothing received yet: nothing to book, the next run retries. Once a call paid the wallet, the
            // claim must report what it got rather than throw it away.
            if (!paid) throw err;
            log.error('Fee claim step failed after the wallet was paid; reporting what was received', { token, what, error: shortError(err) });
            break;
          }
          const before = weth + tokens;
          gas += sent.gasCostWei;
          weth += transfersTo(sent.receipt.logs, net.contracts.weth, wallet);
          tokens += transfersTo(sent.receipt.logs, token, wallet);
          const nativeNow = await rhc.getBalance({ address: wallet, blockNumber: sent.receipt.blockNumber });
          if (weth + tokens > before || nativeNow - nativeBefore + gas > 0n) paid ??= sent;
          last = sent;
        }
        const nativeAfter = await rhc.getBalance({ address: wallet, blockNumber: last!.receipt.blockNumber });
        const native = nativeAfter - nativeBefore + gas;

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
        return { amountWei: (native > 0n ? native : 0n) + weth, tx: (paid ?? last!).ref, tokensBurned };
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
