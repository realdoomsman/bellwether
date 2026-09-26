/**
 * Proves the Hyperliquid write path encodes and signs correctly WITHOUT funds.
 *
 * Hyperliquid's /exchange recovers the signer of every action; for an address that never deposited it
 * rejects with an error naming the RECOVERED address. If that is the throwaway key's address, the msgpack
 * encoding, action hash, nonce, EIP-712 domain and signature are all right. Negative controls (corrupted
 * signature, action tampered after signing, wrong network flag) must recover a different address.
 *
 * Also validates a real Relay RHC→Arbitrum USDC quote with the exact check `relay.ts` applies before
 * signing, and shows that check rejects tampered quotes. Nothing here can move funds: the key is
 * generated fresh, never printed, and never holds anything.
 *
 *   node scripts/hl-proof.ts
 */
import { getAddress, isAddressEqual, parseEther } from 'viem';
import type { Address, LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import { floorSize } from '../src/integrations/hyperliquid/format.ts';
import { HlInfo } from '../src/integrations/hyperliquid/info.ts';
import type { HlAsset } from '../src/integrations/hyperliquid/info.ts';
import { SEND_ASSET_FIELDS, signL1Action, signUserSignedAction } from '../src/integrations/hyperliquid/signing.ts';
import type { HlSignature } from '../src/integrations/hyperliquid/signing.ts';
import {
  createHyperliquidVenue,
  iocOrderAction,
  postExchange,
  sendAssetAction,
  updateLeverageAction,
} from '../src/integrations/hyperliquid/venue.ts';
import { DEFAULT_RELAY_DEPOSIT_CONTRACTS, fetchRelayOriginChain, fetchRelayQuote, validateRelayQuote } from '../src/integrations/relay.ts';
import type { RelayQuote } from '../src/integrations/relay.ts';

const TESTNET_API_URL = 'https://api.hyperliquid-testnet.xyz';
const RELAY_API_URL = 'https://api.relay.link';
const SYMBOL = 'AAPL';
const SLIPPAGE_BPS = 50;

// Defaults only: never read the environment, so no configured key can ever be picked up.
const cfg = loadConfig({ ENGINE_MODE: 'paper' });
const net = cfg.network;
let failures = 0;

function check(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
}

function addressesIn(text: string): Address[] {
  return (text.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => getAddress(a));
}

/** POSTs through the venue's own `postExchange`; returns the address Hyperliquid says signed it. */
async function recoveredSigner(info: HlInfo, action: Record<string, unknown>, nonce: number, signature: HlSignature): Promise<{ addr: Address | null; msg: string }> {
  try {
    const res = await postExchange(info, action, nonce, signature);
    return { addr: null, msg: `UNEXPECTED ok: ${JSON.stringify(res)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { addr: addressesIn(msg)[0] ?? null, msg };
  }
}

async function expectSigner(label: string, info: HlInfo, action: Record<string, unknown>, nonce: number, sig: HlSignature, signer: Address) {
  const { addr, msg } = await recoveredSigner(info, action, nonce, sig);
  check(addr !== null && isAddressEqual(addr, signer), label, `recovered ${addr ?? '(none)'} ${addr && isAddressEqual(addr, signer) ? '==' : '!='} signer — ${msg}`);
}

async function expectOtherSigner(label: string, info: HlInfo, action: Record<string, unknown>, nonce: number, sig: HlSignature, signer: Address) {
  const { addr, msg } = await recoveredSigner(info, action, nonce, sig);
  // A rejection that names no address at all (e.g. signature unparseable) also shows the check is meaningful.
  check(addr === null ? !msg.startsWith('UNEXPECTED') : !isAddressEqual(addr, signer), label, `recovered ${addr ?? '(none)'} != signer — ${msg}`);
}

/** Same signature with `s` bumped by one: still a well-formed signature, but over a different key. */
function corrupt(sig: HlSignature): HlSignature {
  return { ...sig, s: `0x${(BigInt(sig.s) + 1n).toString(16).padStart(64, '0')}` };
}

function checkOrderPrice(a: HlAsset, action: { orders: { p: string; s: string }[] }, isBuy: boolean): void {
  const o = action.orders[0]!;
  const px = Number(o.p);
  const decimals = o.p.split('.')[1]?.length ?? 0;
  const sigFigs = o.p.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;
  const bound = a.markPx * (1 + ((isBuy ? 1 : -1) * SLIPPAGE_BPS) / 10_000);
  const ok =
    decimals <= 6 - a.szDecimals &&
    (sigFigs <= 5 || Number.isInteger(px)) &&
    Math.abs(px - bound) / bound < 1e-4 &&
    Number(o.s) * a.markPx >= 10 &&
    (o.s.split('.')[1]?.length ?? 0) <= a.szDecimals;
  check(ok, `${isBuy ? 'buy' : 'sell'} order rounding`, `mark ${a.markPx} → p=${o.p} (${decimals} dp, ${sigFigs} sf; bound ${bound.toFixed(4)}), s=${o.s} (szDecimals ${a.szDecimals})`);
}

async function proveNetwork(name: string, apiUrl: string): Promise<void> {
  console.log(`\n== Hyperliquid ${name} (${apiUrl})`);
  const info = new HlInfo(apiUrl);
  const account: LocalAccount = privateKeyToAccount(generatePrivateKey());
  const me = account.address;
  // sendAsset to a second address so a message naming the destination can't be mistaken for the signer.
  const destination = privateKeyToAccount(generatePrivateKey()).address;
  console.log(`  throwaway signer ${me}; isMainnet=${info.isMainnet}`);

  const dex = await info.dex(net.hyperliquidDex, true);
  const a = dex.assets.find((x) => x.symbol === SYMBOL);
  if (!a || !(a.markPx > 0)) {
    check(false, `${net.hyperliquidDex}:${SYMBOL} listed`, 'missing or no mark');
    return;
  }
  console.log(`  ${a.coin}: perpDex #${dex.index}, assetId ${a.assetId}, szDecimals ${a.szDecimals}, maxLev ${a.maxLeverage}, mark ${a.markPx}`);
  let nonce = Date.now();

  // (0) The real venue object end to end: open() signs updateLeverage via its own nonce + l1 path.
  const venue = createHyperliquidVenue({
    info,
    dex: net.hyperliquidDex,
    user: me,
    // open() never touches Arbitrum; only the account is used.
    trader: { account, arbitrum: null as never, arbitrumSender: null as never, arbitrumUsdc: net.contracts.arbitrumUsdc, bridge: net.contracts.hyperliquidBridge },
  });
  try {
    await venue.open({ symbol: SYMBOL, side: 'long', collateralUsd: 5, leverage: 3, maxSlippageBps: SLIPPAGE_BPS });
    check(false, 'venue.open (updateLeverage)', 'UNEXPECTED success');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const addr = addressesIn(msg)[0] ?? null;
    check(addr !== null && isAddressEqual(addr, me), 'venue.open → updateLeverage', `recovered ${addr ?? '(none)'} — ${msg}`);
  }

  // (1) updateLeverage, isolated.
  const lev = updateLeverageAction(a, Math.min(3, a.maxLeverage));
  await expectSigner('updateLeverage (isolated)', info, lev, ++nonce, await signL1Action(account, lev, nonce, info.isMainnet), me);

  // (2) IOC limit orders at mark ± slippage (open buy, reduce-only sell).
  // Just over the $10 minimum notional, on the lot grid (same sizing helper as venue.open).
  const size = floorSize(12 / a.markPx + 10 ** -a.szDecimals, a.szDecimals);
  const buy = iocOrderAction(a, true, size, SLIPPAGE_BPS, false);
  checkOrderPrice(a, buy, true);
  const buyNonce = ++nonce;
  const buySig = await signL1Action(account, buy, buyNonce, info.isMainnet);
  await expectSigner('order IOC buy', info, buy, buyNonce, buySig, me);
  const sell = iocOrderAction(a, false, size, SLIPPAGE_BPS, true);
  checkOrderPrice(a, sell, false);
  await expectSigner('order IOC sell reduce-only', info, sell, ++nonce, await signL1Action(account, sell, nonce, info.isMainnet), me);

  // Negative controls on (2).
  await expectOtherSigner('NEG order, corrupted signature', info, buy, buyNonce, corrupt(buySig), me);
  const tampered = { ...buy, orders: [{ ...buy.orders[0]!, p: sell.orders[0]!.p }] };
  await expectOtherSigner('NEG order, price changed after signing', info, tampered, buyNonce, buySig, me);
  await expectOtherSigner('NEG order, nonce changed after signing', info, buy, buyNonce + 1, buySig, me);
  const wrongNet = await signL1Action(account, buy, ++nonce, !info.isMainnet);
  await expectOtherSigner(`NEG order, signed for ${info.isMainnet ? 'testnet' : 'mainnet'}`, info, buy, nonce, wrongNet, me);

  // (3) sendAsset default perp dex → builder dex (topUpMargin's user-signed action).
  const token = await info.spotTokenId(dex.collateralToken);
  const sendNonce = ++nonce;
  const send = sendAssetAction(info.isMainnet, destination, net.hyperliquidDex, token, 12.34, sendNonce);
  const sendSig = await signUserSignedAction(account, send, 'HyperliquidTransaction:SendAsset', SEND_ASSET_FIELDS);
  console.log(`  sendAsset: ${JSON.stringify(send)}`);
  await expectSigner('sendAsset → builder dex', info, send, sendNonce, sendSig, me);
  await expectOtherSigner('NEG sendAsset, corrupted signature', info, send, sendNonce, corrupt(sendSig), me);
  await expectOtherSigner('NEG sendAsset, amount changed after signing', info, { ...send, amount: '99.99' }, sendNonce, sendSig, me);
  const wrongChain = sendAssetAction(!info.isMainnet, destination, net.hyperliquidDex, token, 12.34, ++nonce);
  await expectOtherSigner(
    `NEG sendAsset, hyperliquidChain ${wrongChain.hyperliquidChain} signed but ${send.hyperliquidChain} posted`,
    info,
    { ...wrongChain, hyperliquidChain: send.hyperliquidChain },
    nonce,
    await signUserSignedAction(account, wrongChain, 'HyperliquidTransaction:SendAsset', SEND_ASSET_FIELDS),
    me,
  );

  // (4) Other signed actions: the venue signs only updateLeverage, order and sendAsset. The Bridge2
  // deposit in topUpMargin is a plain Arbitrum USDC transfer (no Hyperliquid signature).
  console.log('  (4) no other Hyperliquid-signed action exists in venue.ts (Bridge2 deposit is an ERC-20 transfer)');
}

async function proveRelay(): Promise<void> {
  console.log(`\n== Relay quote validation (${RELAY_API_URL})`);
  const wallet = privateKeyToAccount(generatePrivateKey()).address;
  const amountWei = parseEther('0.05');
  const [q, chain] = await Promise.all([
    fetchRelayQuote(RELAY_API_URL, wallet, net.contracts.arbitrumUsdc, amountWei),
    fetchRelayOriginChain(RELAY_API_URL),
  ]);
  const expect = {
    wallet,
    amountWei,
    arbitrumUsdc: net.contracts.arbitrumUsdc,
    maxImpactPct: cfg.risk.bridgeMaxImpactPct,
    minUsdc: 0,
    depositContracts: DEFAULT_RELAY_DEPOSIT_CONTRACTS,
    chain,
  };
  const tx = q.steps[0]?.items[0]?.data;
  console.log(`  quote for ${wallet}: steps ${q.steps.map((s) => `${s.id}:${s.kind}x${s.items.length}`).join(',')}, to ${tx?.to}, value ${tx?.value}, out ${q.details.currencyOut.amount} (impact ${q.details.totalImpact.percent}%)`);
  try {
    const { deposit, expectedUsdc } = validateRelayQuote(q, expect);
    check(true, 'real quote passes validateRelayQuote', `deposit to ${deposit.to}, expected ${expectedUsdc} USDC`);
  } catch (err) {
    check(false, 'real quote passes validateRelayQuote', err instanceof Error ? err.message : String(err));
  }

  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  const withTx = (patch: Partial<NonNullable<typeof tx>>): RelayQuote => ({
    ...q,
    steps: [{ ...q.steps[0]!, items: [{ ...q.steps[0]!.items[0]!, data: { ...tx!, ...patch } }] }],
  });
  const tampered: [string, RelayQuote][] = [
    ['wrong recipient', { ...q, details: { ...q.details, recipient: stranger } }],
    ['wrong tx `to`', withTx({ to: stranger })],
    ['wrong tx value', withTx({ value: (amountWei + 1n).toString() })],
    ['wrong tx sender', withTx({ from: stranger })],
    ['wrong tx chain', withTx({ chainId: 1 })],
    ['wrong output token', { ...q, details: { ...q.details, currencyOut: { ...q.details.currencyOut, currency: { ...q.details.currencyOut.currency, address: stranger } } } }],
    ['extra step', { ...q, steps: [...q.steps, q.steps[0]!] }],
    // depositNative(depositor, id): swap the depositor word's address for someone else's.
    ['deposit credits another address', withTx({ data: `0x${tx!.data.slice(2, 34)}${stranger.slice(2).toLowerCase()}${tx!.data.slice(74)}` })],
  ];
  for (const [label, bad] of tampered) {
    try {
      validateRelayQuote(bad, expect);
      check(false, `NEG relay ${label}`, 'accepted');
    } catch (err) {
      check(true, `NEG relay ${label}`, err instanceof Error ? err.message : String(err));
    }
  }
}

async function section(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
  }
}

await section(() => proveNetwork('mainnet', net.hyperliquidApiUrl));
const testnetDexes = await new HlInfo(TESTNET_API_URL).post<({ name: string } | null)[]>({ type: 'perpDexs' });
if (testnetDexes.some((d) => d?.name === net.hyperliquidDex)) await section(() => proveNetwork('testnet', TESTNET_API_URL));
else console.log(`\n== Hyperliquid testnet: skipped (no "${net.hyperliquidDex}" perp dex listed)`);
await section(proveRelay);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
