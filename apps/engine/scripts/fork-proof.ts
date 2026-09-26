/**
 * FORK PROOF of every Robinhood Chain write path, using the real live integrations and the real engine
 * workers against a local anvil fork of RHC mainnet. Nothing is sent to a real chain: anvil is spawned
 * here, the protocol key is a throwaway generated per run, and every account is funded with anvil cheats.
 *
 *   node scripts/fork-proof.ts          (needs Foundry's anvil; ANVIL_BIN overrides ~/.foundry/bin/anvil)
 *
 * Covers Pons V1 (V3 pool; launching is whitelist-gated, so the fork impersonates the factory owner to
 * whitelist the throwaway key), Pons V2 (bonding curve → graduation → Uniswap V4) and LaunchHood (V3):
 * launch with the protocol key as fee wallet, verify, generate real trading fees, claim, buy back and
 * burn, then the claimer/buyback/reconciler workers of a live-mode engine booking the same flows.
 * Arbitrum, Hyperliquid and Relay are only read (wallet balances, prices, markets), never written.
 */
import { encodeFunctionData, erc20Abi, formatEther, parseEther } from 'viem';
import type { Account, Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BURN_ADDRESS, FEE_SPLIT_TRADING, STRATEGIES, splitWei } from '@stepup/shared';
import type { LaunchpadId } from '@stepup/shared';
import { createApp } from '../src/api/app.ts';
import { loadConfig } from '../src/config.ts';
import type { EngineConfig } from '../src/config.ts';
import { kvGet, openDb } from '../src/db.ts';
import { createEngine } from '../src/engine.ts';
import { createLiveIntegrations } from '../src/integrations/index.ts';
import { PONS_V2_ESCROW_ABI, PONS_V2_HOOK_ABI, PonsV2Phase, ponsV2PoolKey, readPonsV2Launch, v4PoolId } from '../src/integrations/ponsv2.ts';
import type { PonsV2Launch } from '../src/integrations/ponsv2.ts';
import type { Integrations, Launchpad, NetworkConfig } from '../src/ports.ts';
import { Scheduler } from '../src/scheduler.ts';
import { weiToGwei } from '../src/units.ts';
import type { ReconciliationSnapshot } from '../src/workers/reconciler.ts';
import { RECONCILIATION_KEY } from '../src/workers/reconciler.ts';
import { workerDefs } from '../src/workers/index.ts';
import { startFork } from './fork/anvil.ts';
import type { Fork } from './fork/anvil.ts';
import { makeTrader, proveBurnHeld, proveImpactGuard, proveTwapGuard } from './fork/dex.ts';
import {
  balanceOf,
  createGraduatedPool,
  curveBuy,
  curveSell,
  launchLaunchHood,
  launchPonsV1,
  launchPonsV2,
  PONS_V2_CURVE_TRADE_ABI,
  PONS_V2_FEE_POLICY_ABI,
  readV2Phase,
  trader,
  v3Buy,
  v3Sell,
} from './fork/pads.ts';
import { v4Buy, v4Sell } from './fork/v4.ts';

const PORT = Number(process.env.FORK_PROOF_PORT ?? 8545);
const V3_FEE_TIER = 10_000;
const BUYBACK_SLIPPAGE_BPS = 150;
const WETH = loadConfig({}).network.contracts.weth;
/** The V3 buyback guard's TWAP window (seconds). */
const TWAP_WINDOW_SEC = 900;
const STARTED = Date.now();

// ─── report ──────────────────────────────────────────────────────────────────
interface Check {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
let current = '';
function section(title: string): void {
  current = title;
  console.log(`\n== ${title}`);
}
function check(name: string, ok: boolean, detail = ''): boolean {
  checks.push({ section: current, name, ok, detail });
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}
function note(line: string): void {
  console.log(`   ${line}`);
}
const eth = (wei: bigint) => `${formatEther(wei)} ETH`;

// ─── fork helpers ────────────────────────────────────────────────────────────
/** Gas the wallet paid in blocks (from, to]: every tx it sent, gasUsed × effectiveGasPrice. */
async function gasSpent(fork: Fork, wallet: Address, from: bigint, to: bigint): Promise<bigint> {
  let total = 0n;
  for (let b = from + 1n; b <= to; b++) {
    const block = await fork.pub.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of block.transactions) {
      if (tx.from.toLowerCase() !== wallet.toLowerCase()) continue;
      const r = await fork.pub.getTransactionReceipt({ hash: tx.hash });
      total += r.gasUsed * r.effectiveGasPrice;
    }
  }
  return total;
}

/** Moves fork time forward (e.g. past a launch's opening snipe tax) and mines. */
async function advance(fork: Fork, seconds: number, blocks = 1): Promise<void> {
  await fork.test.increaseTime({ seconds });
  await fork.test.mine({ blocks });
}

// ─── reusable proofs ─────────────────────────────────────────────────────────
/**
 * `claimable` then `claim` from the protocol wallet, checked against on-chain deltas: ETH received equals
 * the claimable amount, the wallet's ETH moved by exactly that minus gas, no WETH is left, the claimed
 * memecoin reached the burn address and nothing stayed in the wallet.
 */
async function proveClaim(fork: Fork, pad: Launchpad, wallet: Address, token: Address, label: string, expectTokens: boolean): Promise<bigint> {
  const weth = WETH;
  const claimable = await pad.claimable(token);
  check(`${label}: claimable > 0`, claimable !== null && claimable > 0n, claimable === null ? 'null' : eth(claimable));
  const [ethBefore, deadBefore, heldBefore, block0] = await Promise.all([
    fork.pub.getBalance({ address: wallet }),
    balanceOf(fork, token, BURN_ADDRESS),
    balanceOf(fork, token, wallet),
    fork.pub.getBlockNumber(),
  ]);
  const res = await pad.claim(token);
  if (!check(`${label}: claim returned a result`, res !== null)) return 0n;
  const block1 = await fork.pub.getBlockNumber();
  const [ethAfter, deadAfter, heldAfter, wethLeft, gas] = await Promise.all([
    fork.pub.getBalance({ address: wallet }),
    balanceOf(fork, token, BURN_ADDRESS),
    balanceOf(fork, token, wallet),
    fork.pub.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
    gasSpent(fork, wallet, block0, block1),
  ]);
  note(`claim tx ${res!.tx.hash}${res!.tokensBurned ? `, burn tx ${res!.tokensBurned.tx.hash}` : ''}; ${block1 - block0} tx(s), gas ${eth(gas)}`);
  check(`${label}: amountWei == claimable`, res!.amountWei === claimable, `${eth(res!.amountWei)} vs ${claimable === null ? 'null' : eth(claimable)}`);
  check(`${label}: wallet ETH delta == amountWei - gas`, ethAfter - ethBefore === res!.amountWei - gas, `delta ${eth(ethAfter - ethBefore)}`);
  check(`${label}: no WETH left (unwrapped)`, wethLeft === 0n, `${wethLeft}`);
  const burned = res!.tokensBurned?.amount ?? 0n;
  check(`${label}: tokensBurned == burn-address delta`, deadAfter - deadBefore === burned, `${burned} raw`);
  if (expectTokens) check(`${label}: memecoin fees were claimed and burned`, burned > 0n, `${burned} raw`);
  check(`${label}: wallet token balance unchanged`, heldAfter === heldBefore, `${heldBefore} → ${heldAfter}`);
  return res!.amountWei;
}

/** `quote` then `buyAndBurn`: the burn address gains exactly amountOut, the wallet keeps nothing, slippage within budget. */
async function proveBuyback(fork: Fork, io: Integrations, net: NetworkConfig, wallet: Address, token: Address, label: string, amountIn: bigint): Promise<void> {
  // V3 buybacks price against the pool's 15-minute TWAP; a pool traded seconds ago on a fresh fork has none yet.
  if (!(await readPonsV2Launch(fork.pub, net.contracts.ponsV2Factory, token))) await advance(fork, TWAP_WINDOW_SEC + 1);
  const q = await io.dex.quote(token, amountIn);
  if (!check(`${label}: dex.quote found a pool`, q !== null, q ? `${q.amountOut} raw @ fee ${q.feeTier}` : 'null')) return;
  const [deadBefore, heldBefore, ethBefore, block0] = await Promise.all([
    balanceOf(fork, token, BURN_ADDRESS),
    balanceOf(fork, token, wallet),
    fork.pub.getBalance({ address: wallet }),
    fork.pub.getBlockNumber(),
  ]);
  let res;
  try {
    res = await io.dex.buyAndBurn(token, amountIn, BUYBACK_SLIPPAGE_BPS);
  } catch (err) {
    check(`${label}: buyAndBurn`, false, err instanceof Error ? err.message : String(err));
    return;
  }
  const block1 = await fork.pub.getBlockNumber();
  const [deadAfter, heldAfter, ethAfter, gas] = await Promise.all([
    balanceOf(fork, token, BURN_ADDRESS),
    balanceOf(fork, token, wallet),
    fork.pub.getBalance({ address: wallet }),
    gasSpent(fork, wallet, block0, block1),
  ]);
  note(`swap tx ${res.swapTx.hash}, burn tx ${res.burnTx?.hash ?? 'NONE'}`);
  check(`${label}: burn tx sent`, res.burnTx !== null);
  check(`${label}: burn-address delta == amountOut`, deadAfter - deadBefore === res.amountOut, `${res.amountOut} raw`);
  check(`${label}: wallet token balance unchanged`, heldAfter === heldBefore);
  const floor = (q!.amountOut * BigInt(10_000 - BUYBACK_SLIPPAGE_BPS)) / 10_000n;
  check(`${label}: amountOut >= quote × (1 - 1.5%)`, res.amountOut >= floor, `quote ${q!.amountOut}`);
  check(`${label}: wallet ETH delta == -(amountIn + gas)`, ethBefore - ethAfter === amountIn + gas, `${eth(ethBefore - ethAfter)}`);
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  section(`Fork (anvil on :${PORT})`);
  const fork = await startFork(PORT);
  try {
    const forkBlock = await fork.pub.getBlockNumber();
    note(`forked RHC mainnet at block ${forkBlock}`);

    const pk = generatePrivateKey();
    const k = privateKeyToAccount(pk);
    await fork.fund(k.address, '100');
    // Scan the escrow from shortly before the fork: the throwaway key has no earlier history.
    const config = loadConfig({
      ENGINE_MODE: 'live',
      LIVE_CONFIRM: 'real-funds',
      PROTOCOL_PRIVATE_KEY: pk,
      ROBINHOOD_RPC_URL: fork.url,
      DB_PATH: ':memory:',
      PONS_V2_FROM_BLOCK: String(forkBlock - 20_000n),
    });
    const net = config.network;
    const io = createLiveIntegrations(config.live!);
    note(`protocol wallet (throwaway) ${k.address}`);

    // Every launch happens up front, before the engine's tx sender caches the key's nonce.
    section('Launch');
    const v1 = await launchPonsV1(fork, net, k, 'FPV1');
    note(`Pons V1 token ${v1.token} (tx ${v1.tx})`);
    const v2 = await launchPonsV2(fork, net, k, 'FPV2');
    note(`Pons V2 token ${v2.token}, curve ${v2.curve} (tx ${v2.tx})`);
    const v2b = await launchPonsV2(fork, net, k, 'FPV2B');
    note(`Pons V2 token #2 ${v2b.token}, curve ${v2b.curve} (tx ${v2b.tx})`);
    const lh = await launchLaunchHood(fork, net, k, 'FPLH');
    note(`LaunchHood token ${lh.token} (tx ${lh.tx})`);
    // Opening snipe taxes (V2, seconds) and launch-window wallet caps (V1/LaunchHood, blocks) expire.
    await advance(fork, 60, 400);

    section('Verify');
    for (const [label, id, token] of [
      ['Pons V1', 'pons', v1.token],
      ['Pons V2', 'pons', v2.token],
      ['Pons V2 #2', 'pons', v2b.token],
      ['LaunchHood', 'launchhood', lh.token],
    ] as const) {
      const r = await io.launchpads[id].verify(token);
      check(`${label}: verify ok`, r.ok, r.detail);
      check(`${label}: deployer == protocol wallet`, r.deployer?.toLowerCase() === k.address.toLowerCase(), `${r.deployer}`);
    }
    const wrong = await io.launchpads.launchhood.verify(v2.token);
    check('Pons V2 token rejected by launchhood.verify', !wrong.ok && wrong.failure === 'wrong-launchpad', wrong.detail);

    const traders = await Promise.all([trader(fork), trader(fork), trader(fork)]);
    const [t1, t2, t3] = traders as [Account, Account, Account];

    // ── Pons V1 ──
    section('Pons V1: fees → claim → buyback');
    for (const t of traders) await v3Buy(fork, net, t, v1.token, V3_FEE_TIER, parseEther('1'));
    await v3Sell(fork, net, t1, v1.token, V3_FEE_TIER, (await balanceOf(fork, v1.token, t1.address)) / 2n);
    await v3Sell(fork, net, t2, v1.token, V3_FEE_TIER, (await balanceOf(fork, v1.token, t2.address)) / 2n);
    await proveClaim(fork, io.launchpads.pons, k.address, v1.token, 'V1 claim', true);
    await proveBuyback(fork, io, net, k.address, v1.token, 'V1 buyback', parseEther('0.05'));
    await proveGuards(fork, io, config, v1.token, 'V1 (V3)');

    // ── LaunchHood ──
    section('LaunchHood: fees → claim → buyback');
    for (const t of traders) await v3Buy(fork, net, t, lh.token, V3_FEE_TIER, parseEther('1'));
    await v3Sell(fork, net, t1, lh.token, V3_FEE_TIER, (await balanceOf(fork, lh.token, t1.address)) / 2n);
    await proveClaim(fork, io.launchpads.launchhood, k.address, lh.token, 'LaunchHood claim', true);
    await proveBuyback(fork, io, net, k.address, lh.token, 'LaunchHood buyback', parseEther('0.05'));

    // ── Pons V2 on the curve ──
    section('Pons V2: curve fees → claim (own sweep), escrow attribution across two tokens');
    const operator = await fork.pub.readContract({ address: net.contracts.ponsV2Hook, abi: PONS_V2_FEE_POLICY_ABI, functionName: 'feeSweepOperator' });
    await fork.fund(operator, '1');
    for (const t of traders) await curveBuy(fork, t, v2.curve, parseEther('0.5'));
    await curveSell(fork, t1, v2.curve, v2.token, (await balanceOf(fork, v2.token, t1.address)) / 2n);
    for (const t of [t1, t2]) await curveBuy(fork, t, v2b.curve, parseEther('0.3'));
    // Token #2's fees are swept by the Pons operator (as its keeper does), crediting the escrow for us.
    await fork.impersonate(operator, { to: v2b.curve, data: encodeSweepFees() });
    const escrowBalance = () =>
      fork.pub.readContract({ address: net.contracts.ponsV2FeeEscrow, abi: PONS_V2_ESCROW_ABI, functionName: 'balanceOf', args: [k.address] });
    const v2bCredited = await escrowBalance();
    check('operator sweep credited token #2 fees to the escrow', v2bCredited > 0n, eth(v2bCredited));
    await proveClaim(fork, io.launchpads.pons, k.address, v2.token, 'V2 curve claim', false);
    check("claiming token #1 left token #2's credit in the escrow", (await escrowBalance()) === v2bCredited, eth(await escrowBalance()));
    const v2bClaimed = await proveClaim(fork, io.launchpads.pons, k.address, v2b.token, 'V2 #2 claim (operator-swept)', false);
    check('token #2 claim == its operator-swept credit', v2bClaimed === v2bCredited, `${eth(v2bClaimed)} vs ${eth(v2bCredited)}`);
    check('escrow emptied', (await escrowBalance()) === 0n);

    // ── Pons V2 graduation → V4 ──
    section('Pons V2: graduation → V4 fees → claim → buyback');
    await curveBuy(fork, t3, v2.curve, parseEther('6'));
    check('the crossing buy swept the curve (phase Swept)', (await readV2Phase(fork, net, v2.token)) === PonsV2Phase.Swept);
    check('dex.quote has no route while the pool is not seeded', (await io.dex.quote(v2.token, parseEther('0.01'))) === null);
    await createGraduatedPool(fork, net, t3, v2.token);
    const phase = await readV2Phase(fork, net, v2.token);
    check('createGraduatedPool seeded the V4 pool (phase PoolCreated)', phase === PonsV2Phase.Pool, `phase ${phase}`);
    const launch = (await readPonsV2Launch(fork.pub, net.contracts.ponsV2Factory, v2.token))!;
    const poolId = v4PoolId(ponsV2PoolKey(launch, net.contracts.ponsV2Hook));
    const registered = await fork.pub.readContract({ address: net.contracts.ponsV2Hook, abi: PONS_V2_HOOK_ABI, functionName: 'launches', args: [poolId] });
    check('computed V4 pool id is registered on the Pons hook for this token', registered[0] && registered[2].toLowerCase() === v2.token.toLowerCase(), poolId);
    // ETH → token swaps charge the hook fee in the memecoin: only the Pons operator may convert it (keeper sweep).
    for (const t of [t1, t2]) await v4Buy(fork, net, t, launch, parseEther('1'));
    await fork.impersonate(operator, { to: net.contracts.ponsV2Hook, data: encodeSweepPoolFees(poolId) });
    // token → ETH swaps charge it in ETH, which the creator (us) may sweep.
    await v4Sell(fork, net, t3, launch, (await balanceOf(fork, v2.token, t3.address)) / 3n);
    await proveClaim(fork, io.launchpads.pons, k.address, v2.token, 'V2 pool claim (operator + own hook sweep)', false);
    await proveBuyback(fork, io, net, k.address, v2.token, 'V2 buyback (V4)', parseEther('0.05'));
    await proveGuards(fork, io, config, v2.token, 'V2 (V4)');

    // ── Engine ──
    await proveEngine(fork, config, io, k, { v1: v1.token, v2: launch, lh: lh.token, traders: [t1, t2, t3], operator });
  } finally {
    await fork.stop();
  }
  report();
}

/** The Dex price guards (TWAP deviation on V3, price impact on V3/V4) and `burnHeld`, via scripts/fork/dex.ts. */
async function proveGuards(fork: Fork, io: Integrations, config: EngineConfig, token: Address, label: string): Promise<void> {
  const ctx = { fork, io, cfg: config.live!, token, newTrader: makeTrader(fork) };
  for (const c of [...(await proveTwapGuard(ctx)), ...(await proveImpactGuard(ctx)), ...(await proveBurnHeld(ctx))]) {
    check(`${label}: ${c.name}`, c.ok, c.detail);
  }
}

function encodeSweepFees(): Hex {
  return encodeFunctionData({ abi: PONS_V2_CURVE_TRADE_ABI, functionName: 'sweepFees', args: [0n] });
}

function encodeSweepPoolFees(poolId: Hex): Hex {
  // The operator converts memecoin fees at the pool price; any positive floor passes on an untouched fork pool.
  return encodeFunctionData({ abi: PONS_V2_HOOK_ABI, functionName: 'sweepPoolFees', args: [poolId, 1n, 1n] });
}

interface EngineTokens {
  v1: Address;
  v2: PonsV2Launch;
  lh: Address;
  traders: [Account, Account, Account];
  operator: Address;
}

/**
 * The engine as main.ts builds it (live config, in-memory DB), registering the fork tokens through the
 * real API route, then the claimer, buyback and reconciler workers run through the scheduler. Only those
 * three workers are registered: treasury/trader/guardian would write to real Arbitrum/Hyperliquid.
 */
async function proveEngine(fork: Fork, config: EngineConfig, io: Integrations, k: Account, t: EngineTokens): Promise<void> {
  const net = config.network;
  section('Engine (live mode on the fork): register via API');
  const db = openDb(':memory:');
  const engine = createEngine({ config, db, io });
  const scheduler = new Scheduler(
    db,
    workerDefs(engine).filter((d) => d.id === 'claimer' || d.id === 'buyback' || d.id === 'reconciler'),
  );
  const { app } = createApp(engine, scheduler);
  const tokens: { label: string; id: LaunchpadId; token: Address }[] = [
    { label: 'Pons V1', id: 'pons', token: t.v1 },
    { label: 'Pons V2', id: 'pons', token: t.v2.token },
    { label: 'LaunchHood', id: 'launchhood', token: t.lh },
  ];
  for (const x of tokens) {
    const res = await app.request('/api/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: x.token, launchpad: x.id, strategy: 'balanced', side: 'long', market: 'AAPL', maxLeverage: STRATEGIES.balanced.minLeverage }),
    });
    const body = (await res.json()) as { activated?: boolean; error?: { message?: string } };
    check(`${x.label}: POST /api/tokens → 201 active`, res.status === 201 && body.activated === true, `${res.status} ${JSON.stringify(body).slice(0, 160)}`);
  }

  // Fresh trading fees on every token.
  const [t1, t2, t3] = t.traders;
  for (const tr of [t1, t2]) await v3Buy(fork, net, tr, t.v1, V3_FEE_TIER, parseEther('1'));
  await v3Sell(fork, net, t3, t.v1, V3_FEE_TIER, (await balanceOf(fork, t.v1, t3.address)) / 2n);
  for (const tr of [t1, t2]) await v3Buy(fork, net, tr, t.lh, V3_FEE_TIER, parseEther('1'));
  await v3Sell(fork, net, t3, t.lh, V3_FEE_TIER, (await balanceOf(fork, t.lh, t3.address)) / 2n);
  await v4Buy(fork, net, t1, t.v2, parseEther('1'));
  await fork.impersonate(t.operator, { to: net.contracts.ponsV2Hook, data: encodeSweepPoolFees(v4PoolId(ponsV2PoolKey(t.v2, net.contracts.ponsV2Hook))) });
  await v4Sell(fork, net, t2, t.v2, (await balanceOf(fork, t.v2.token, t2.address)) / 2n);

  section('Engine: claimer');
  const expected = new Map<Address, bigint>();
  for (const x of tokens) expected.set(x.token, (await io.launchpads[x.id].claimable(x.token)) ?? 0n);
  const deadBefore = new Map<Address, bigint>();
  for (const x of tokens) deadBefore.set(x.token, await balanceOf(fork, x.token, BURN_ADDRESS));
  let ethBefore = await fork.pub.getBalance({ address: k.address });
  let block0 = await fork.pub.getBlockNumber();
  const claimRun = await scheduler.runNow('claimer');
  check('claimer run ok', claimRun.ok, claimRun.summary);
  let gas = await gasSpent(fork, k.address, block0, await fork.pub.getBlockNumber());
  let totalWei = 0n;
  for (const x of tokens) {
    const wei = expected.get(x.token)!;
    totalWei += wei;
    const book = engine.ledger.book(x.token);
    const claimTx = db.get<{ tx_hash: string }>("SELECT tx_hash FROM ledger WHERE token = ? AND ref_kind = 'claim' LIMIT 1", [x.token]);
    note(`${x.label}: ledger claim tx ${claimTx?.tx_hash ?? 'none'}`);
    const gwei = weiToGwei(wei);
    const split = splitWei(BigInt(gwei), FEE_SPLIT_TRADING);
    check(`${x.label}: fees_eth == claimed on-chain`, book.fees_eth === gwei && gwei > 0, `${book.fees_eth} gwei vs ${eth(wei)}`);
    check(
      `${x.label}: split 60/25/15 exact`,
      book.trading_eth === Number(split.trading) && book.token_buyback_eth === Number(split.tokenBuyback) && book.protocol_buyback_eth === Number(split.protocolBuyback),
      `trading ${book.trading_eth}, token buyback ${book.token_buyback_eth}, protocol buyback ${book.protocol_buyback_eth} gwei`,
    );
    const burned = db.all<{ amount_out: string }>("SELECT amount_out FROM burns WHERE token = ? AND kind = 'claim'", [x.token]).reduce((s, r) => s + BigInt(r.amount_out), 0n);
    const delta = (await balanceOf(fork, x.token, BURN_ADDRESS)) - deadBefore.get(x.token)!;
    check(`${x.label}: claim burns row == burn-address delta`, burned === delta, `${burned} raw`);
  }
  const ethAfterClaims = await fork.pub.getBalance({ address: k.address });
  check('wallet ETH delta == Σ claimed - gas', ethAfterClaims - ethBefore === totalWei - gas, `${eth(ethAfterClaims - ethBefore)}, gas ${eth(gas)}`);

  section('Engine: buyback');
  // The V3 TWAP guard compares against the last 15 minutes: let the pools sit after the fee trades above.
  await advance(fork, TWAP_WINDOW_SEC + 1);
  const budgets = new Map<Address, number>();
  for (const x of tokens) {
    budgets.set(x.token, engine.ledger.book(x.token).token_buyback_eth);
    deadBefore.set(x.token, await balanceOf(fork, x.token, BURN_ADDRESS));
  }
  ethBefore = await fork.pub.getBalance({ address: k.address });
  block0 = await fork.pub.getBlockNumber();
  const buyRun = await scheduler.runNow('buyback');
  check('buyback run ok', buyRun.ok, buyRun.summary);
  gas = await gasSpent(fork, k.address, block0, await fork.pub.getBlockNumber());
  let spentWei = 0n;
  for (const x of tokens) {
    const budget = budgets.get(x.token)!;
    const book = engine.ledger.book(x.token);
    spentWei += BigInt(book.buyback_spent_eth) * 1_000_000_000n;
    check(`${x.label}: buyback_spent_eth == token buyback budget`, book.buyback_spent_eth === budget && budget > 0, `${book.buyback_spent_eth} of ${budget} gwei`);
    check(`${x.label}: token buyback budget spent`, book.token_buyback_eth === 0, `${book.token_buyback_eth} gwei left`);
    const rows = db.all<{ amount_out: string; burn_hash: string | null }>("SELECT amount_out, burn_hash FROM burns WHERE token = ? AND kind = 'token'", [x.token]);
    const burned = rows.reduce((s, r) => s + BigInt(r.amount_out), 0n);
    const delta = (await balanceOf(fork, x.token, BURN_ADDRESS)) - deadBefore.get(x.token)!;
    check(`${x.label}: buyback burns row == burn-address delta`, rows.length === 1 && burned === delta && delta > 0n, `${burned} raw, burn tx ${rows[0]?.burn_hash}`);
  }
  const ethAfterBuys = await fork.pub.getBalance({ address: k.address });
  check('wallet ETH delta == -(Σ spent + gas)', ethBefore - ethAfterBuys === spentWei + gas, `${eth(ethBefore - ethAfterBuys)}, gas ${eth(gas)}`);

  section('Engine: reconciler');
  const recRun = await scheduler.runNow('reconciler');
  check('reconciler run ok', recRun.ok, recRun.summary);
  const snap = kvGet<ReconciliationSnapshot>(db, RECONCILIATION_KEY);
  const ethItem = snap?.items.find((i) => i.asset === 'ETH' && i.chain === 'rhc');
  check('reconciliation ETH@rhc ok', ethItem?.ok === true, ethItem ? `expected ${ethItem.expected}, actual ${ethItem.actual}` : 'missing');
  await scheduler.stop();
  db.close();
}

function report(): void {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed in ${Math.round((Date.now() - STARTED) / 1000)}s`);
  for (const c of failed) console.log(`FAIL [${c.section}] ${c.name}: ${c.detail}`);
  console.log(failed.length === 0 && checks.length > 0 ? 'FORK PROOF PASSED' : 'FORK PROOF FAILED');
  process.exitCode = failed.length === 0 && checks.length > 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`\nFORK PROOF ABORTED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  report();
  process.exitCode = 1;
});
