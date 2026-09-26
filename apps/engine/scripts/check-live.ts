/**
 * READ-ONLY smoke test of every integration against the real networks.
 * Uses the reference Fill protocol wallet (fees from real Pons launches) so there is live data.
 * Never signs: the integrations are built without a key, and the script asserts writes are refused.
 *
 *   node --env-file-if-exists=.env scripts/check-live.ts
 */
import { formatEther, formatUnits, parseEther } from 'viem';
import type { Address } from 'viem';
import { isStockSymbol } from '@stepup/shared';
import { loadConfig } from '../src/config.ts';
import { createReadOnlyIntegrations, ReadOnlyError } from '../src/integrations/index.ts';
import type { NetworkConfig } from '../src/ports.ts';
import { createChainClients } from '../src/integrations/chains.ts';

/** Fill Protocol's fee wallet: real Pons launches route creator fees to it, so there is live data to read. */
const REFERENCE_PROTOCOL_ADDRESS: Address = '0x2cdE129778a416279d9f6F1E9B5c3abb302D1CD7';
/** $FILL, launched on Pons with the reference protocol wallet as Creator wallet. */
const FILL: Address = '0x7f0404070cf6FB703af9f3B89f84Af3FFE2A54B3';
/** A LaunchHood launch whose reward recipient is its own creator (negative fee-routing case). */
const LAUNCHHOOD_TOKEN: Address = '0x907ebbd017a4222a6c8d8fce377efc40e7fac0de';
/** Canonical QuoterV2 from Uniswap's Robinhood Chain deployment list. */
const QUOTER_V2: Address = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
/**
 * The reference wallet has had no launch activity for ~40M blocks, and old-era log queries on the
 * public RPC time out. To exercise discovery on real launches, also scan for the fee wallets of two
 * recent launches (other creators' wallets, used read-only as stand-in protocol addresses).
 */
const DISCOVERY_DEMOS: { wallet: Address; from: bigint; expect: Address }[] = [
  { wallet: '0x2b593ca3cd5dccc623adba48545b491693891ab8', from: 72_000_000n, expect: '0x95efad01ffab32ae00fe9f16ca23a81b2802cd54' },
  { wallet: '0x23b5355e6EAf0795Ef81D77368403C3daE3551F0', from: 69_800_000n, expect: LAUNCHHOOD_TOKEN },
];

const base = loadConfig({ ...process.env, ENGINE_MODE: 'paper' }).network;
const net: NetworkConfig = { ...base, protocolAddress: REFERENCE_PROTOCOL_ADDRESS };
const io = createReadOnlyIntegrations(net);
const rhc = createChainClients(net).rhc;
let failures = 0;

async function section(title: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  console.log(`\n== ${title}`);
  try {
    await fn();
    console.log(`   (${Date.now() - started} ms)`);
  } catch (err) {
    failures++;
    console.log(`   FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

console.log(`protocol wallet ${net.protocolAddress}`);

await section('Robinhood Chain', async () => {
  const [chainId, block] = await Promise.all([rhc.getChainId(), rhc.getBlockNumber()]);
  console.log(`   chainId ${chainId}, block ${block}`);
});

await section('Hyperliquid venue', async () => {
  const venue = io.venues[0]!;
  console.log(`   ${venue.name} health ${json(await venue.health())}`);
  const markets = await venue.markets();
  const stocks = markets.filter((m) => isStockSymbol(m.symbol));
  console.log(`   ${markets.length} markets, ${stocks.length} in the stock list:`);
  for (const m of stocks) console.log(`   ${m.venueSymbol.padEnd(11)} max ${String(m.maxLeverage).padStart(2)}x  mark ${m.markPrice}  open ${m.open}`);
  console.log(`   others: ${markets.filter((m) => !isStockSymbol(m.symbol)).map((m) => m.symbol).join(' ')}`);
  console.log(`   free collateral ${await venue.freeCollateralUsd()} USD, positions ${json(await venue.positions())}`);
});

await section('Stock prices', async () => {
  const candles = await io.prices.candles('AAPL', '5m', 12);
  console.log(`   AAPL 5m: ${candles.length} candles, last 3:`);
  for (const c of candles.slice(-3)) console.log(`   ${new Date(c.t).toISOString()} o ${c.o} h ${c.h} l ${c.l} c ${c.c} v ${c.v}`);
  console.log(`   AAPL quote ${json(await io.prices.quote('AAPL'))}`);
  console.log(`   ETH/USD ${await io.prices.ethUsd()}`);
});

await section('Pons verify $FILL (expect ok)', async () => {
  const r = await io.launchpads.pons.verify(FILL);
  console.log(`   ${json(r)}`);
  if (!r.ok || !r.deployer) throw new Error('expected ok:true with a deployer');
});

await section('Negative verifies', async () => {
  const weth = await io.launchpads.pons.verify(net.contracts.weth);
  console.log(`   pons.verify(WETH): ok ${weth.ok}, ${weth.failure}: ${weth.detail}`);
  const eoa = await io.launchpads.pons.verify('0x000000000000000000000000000000000000bEEF');
  console.log(`   pons.verify(EOA): ok ${eoa.ok}, ${eoa.failure}: ${eoa.detail}`);
  const wrongPad = await io.launchpads.launchhood.verify(FILL);
  console.log(`   launchhood.verify($FILL): ok ${wrongPad.ok}, ${wrongPad.failure}: ${wrongPad.detail}`);
  const lh = await io.launchpads.launchhood.verify(LAUNCHHOOD_TOKEN);
  console.log(`   launchhood.verify(${LAUNCHHOOD_TOKEN}): ok ${lh.ok}, ${lh.failure}: ${lh.detail} (deployer ${lh.deployer}, ${lh.metadata?.symbol})`);
  if (weth.ok || eoa.ok || wrongPad.ok || lh.ok) throw new Error('a negative case verified');
});

await section('Pons claimable $FILL', async () => {
  const wei = await io.launchpads.pons.claimable(FILL);
  console.log(`   ${wei === null ? 'unknown' : `${formatEther(wei)} ETH (WETH)`}`);
  console.log(`   launchhood claimable (not our token): ${json(await io.launchpads.launchhood.claimable(LAUNCHHOOD_TOKEN))}`);
});

await section('Uniswap quote 0.001 ETH -> $FILL', async () => {
  const amount = parseEther('0.001');
  const q = await io.dex.quote(FILL, amount);
  console.log(`   ${net.contracts.uniswapQuoter ? 'QuoterV2' : 'router dry-run'}: ${q ? `${formatUnits(q.amountOut, 18)} FILL @ fee tier ${q.feeTier}` : 'no pool'}`);
  const other = createReadOnlyIntegrations({
    ...net,
    contracts: { ...net.contracts, uniswapQuoter: net.contracts.uniswapQuoter ? null : QUOTER_V2 },
  });
  const q2 = await other.dex.quote(FILL, amount);
  console.log(`   ${net.contracts.uniswapQuoter ? 'router dry-run' : 'QuoterV2'}: ${q2 ? `${formatUnits(q2.amountOut, 18)} FILL @ fee tier ${q2.feeTier}` : 'no pool'}`);
});

await section('GeckoTerminal $FILL', async () => {
  console.log(`   market ${json(await io.tokenData.market(FILL))}`);
  const candles = await io.tokenData.candles(FILL, '1h', 24);
  console.log(`   1h candles: ${candles.length}, last ${json(candles.at(-1) ?? null)}`);
});

await section('Relay quote 0.1 ETH (RHC) -> USDC (Arbitrum)', async () => {
  console.log(`   ${json(await io.bridge.quote(parseEther('0.1')))}`);
});

await section('Wallet balances', async () => {
  console.log(`   ${json(await io.wallet.balances())}`);
  console.log(`   $FILL held: ${formatUnits(await io.wallet.tokenBalance(FILL), 18)}`);
});

await section('Discovery (recent window)', async () => {
  const latest = await rhc.getBlockNumber();
  const r = await io.discovery.scan(latest - 500_000n);
  console.log(`   blocks ${latest - 500_000n}..${r.toBlock}: ${json(r.candidates)}`);
});

await section('Discovery demo (recent launches, stand-in fee wallets)', async () => {
  for (const demo of DISCOVERY_DEMOS) {
    const scanner = createReadOnlyIntegrations({ ...net, protocolAddress: demo.wallet });
    const r = await scanner.discovery.scan(demo.from);
    console.log(`   wallet ${demo.wallet} blocks ${demo.from}..${r.toBlock}: ${json(r.candidates)}`);
    if (!r.candidates.some((c) => c.token.toLowerCase() === demo.expect.toLowerCase())) throw new Error(`expected ${demo.expect}`);
    const pad = r.candidates.find((c) => c.token.toLowerCase() === demo.expect.toLowerCase())!.launchpad;
    const v = await scanner.launchpads[pad].verify(demo.expect);
    console.log(`   ${pad}.verify(${demo.expect}) for that wallet: ok ${v.ok}, ${v.detail} (deployer ${v.deployer}, ${v.metadata?.symbol})`);
  }
});

await section('Writes are refused (read-only)', async () => {
  for (const [what, attempt] of [
    ['pons.claim', () => io.launchpads.pons.claim(FILL)],
    ['dex.buyAndBurn', () => io.dex.buyAndBurn(FILL, 1n, 100)],
    ['venue.open', () => io.venues[0]!.open({ symbol: 'AAPL', side: 'long', collateralUsd: 10, leverage: 2, maxSlippageBps: 50 })],
    ['bridge.ethToUsdc', () => io.bridge.ethToUsdc(1n, 0.01)],
  ] as const) {
    try {
      await attempt();
      throw new Error(`${what} did not refuse`);
    } catch (err) {
      if (!(err instanceof ReadOnlyError)) throw err;
      console.log(`   ${what}: ${err.message}`);
    }
  }
});

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
