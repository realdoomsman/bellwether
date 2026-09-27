/**
 * FORK PROOF of the Arbitrum → Hyperliquid deposit: the Hyperliquid venue's real `topUpMargin` against a
 * local anvil fork of Arbitrum One. Nothing is sent to a real chain: the key is a throwaway generated per
 * run and its USDC/ETH exist only on the fork (anvil_setStorageAt / anvil_setBalance).
 *
 *   node scripts/hl-deposit-fork-proof.ts   (needs Foundry's anvil; ANVIL_BIN overrides ~/.foundry/bin/anvil)
 *
 * Proven on the fork: the Bridge2 code check, the 5 USDC minimum, the cent-floored amount, and the USDC
 * `transfer` to Bridge2 moving exactly that from the wallet to the real Bridge2 contract, gas paid in ETH.
 *
 * Not provable without funds: Hyperliquid's validators only credit deposits seen on the real Arbitrum, so
 * the credit is simulated. The proof injects an `HlInfo` whose default-dex `withdrawable` is the USDC that
 * Bridge2 received on the fork; everything else (markets, spot token ids, /exchange) is the real mainnet
 * API. The venue then signs the real `sendAsset` into the builder dex and posts it to Hyperliquid, which
 * rejects it because the throwaway account never deposited, naming the address it recovered from the
 * signature: that address must be the throwaway wallet.
 */
import { decodeEventLog, encodeAbiParameters, erc20Abi, formatUnits, getAddress, isAddressEqual, keccak256, recoverTypedDataAddress, serializeSignature, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import { HlInfo } from '../src/integrations/hyperliquid/info.ts';
import type { HlClearinghouse } from '../src/integrations/hyperliquid/info.ts';
import { SEND_ASSET_FIELDS } from '../src/integrations/hyperliquid/signing.ts';
import type { HlSignature } from '../src/integrations/hyperliquid/signing.ts';
import { createHyperliquidVenue } from '../src/integrations/hyperliquid/venue.ts';
import { createTxSender } from '../src/integrations/tx.ts';
import type { TxReceiptRef } from '../src/ports.ts';
import { ARBITRUM_TARGET, startFork } from './fork/anvil.ts';
import type { Fork } from './fork/anvil.ts';
import { check, note, run, section } from './fork/report.ts';

const PORT = Number(process.env.HL_FORK_PROOF_PORT ?? 8546);
/** FiatTokenV2_2 `balanceAndBlacklistStates` mapping slot (Circle's USDC on Arbitrum). */
const USDC_BALANCE_SLOT = 9n;
const net = loadConfig({ ENGINE_MODE: 'paper' }).network;
const { arbitrumUsdc: USDC, hyperliquidBridge: BRIDGE2 } = net.contracts;

/** Every body POSTed to Hyperliquid's /exchange (the venue's signed actions, as sent). */
const exchangePosts: { action: Record<string, unknown> & { type: string; signatureChainId: Hex }; nonce: number; signature: HlSignature }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input instanceof Request ? input.url : input).endsWith('/exchange') && typeof init?.body === 'string') exchangePosts.push(JSON.parse(init.body));
  return realFetch(input, init);
};

const usdc = (raw: bigint) => `${formatUnits(raw, 6)} USDC`;

async function usdcOf(fork: Fork, who: Address): Promise<bigint> {
  return fork.pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
}

/** Sets `who`'s Arbitrum USDC balance on the fork by writing its storage slot. */
async function setUsdc(fork: Fork, who: Address, raw: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, USDC_BALANCE_SLOT]));
  await fork.test.setStorageAt({ address: USDC, index: slot, value: `0x${raw.toString(16).padStart(64, '0')}` });
  const got = await usdcOf(fork, who);
  if (got !== raw) throw new Error(`USDC balance slot write did not take (balanceOf ${got}, wanted ${raw})`);
}

/**
 * Real mainnet Hyperliquid info API, except the default perp dex's `withdrawable`: Hyperliquid cannot see
 * a fork, so it reports the USDC Bridge2 received from `wallet` on the fork (what the validators would credit).
 */
class ForkCreditedInfo extends HlInfo {
  readonly #fork: Fork;
  readonly #wallet: Address;
  readonly #bridgeBefore: bigint;
  creditReads = 0;
  constructor(apiUrl: string, fork: Fork, wallet: Address, bridgeBefore: bigint) {
    super(apiUrl);
    this.#fork = fork;
    this.#wallet = wallet;
    this.#bridgeBefore = bridgeBefore;
  }
  override async clearinghouse(user: Address, dex: string | null): Promise<HlClearinghouse> {
    const real = await super.clearinghouse(user, dex);
    if (dex !== null || !isAddressEqual(user, this.#wallet)) return real;
    this.creditReads++;
    const credited = (await usdcOf(this.#fork, BRIDGE2)) - this.#bridgeBefore;
    return { ...real, withdrawable: formatUnits(credited, 6) };
  }
}

async function main(): Promise<void> {
  section(`Arbitrum fork (anvil on :${PORT})`);
  const fork = await startFork(PORT, ARBITRUM_TARGET);
  try {
    note(`forked ${ARBITRUM_TARGET.name} at block ${await fork.pub.getBlockNumber()}`);
    const account = privateKeyToAccount(generatePrivateKey());
    const me = account.address;
    note(`throwaway wallet ${me}; USDC ${USDC}; Bridge2 ${BRIDGE2}; Hyperliquid ${net.hyperliquidApiUrl} dex ${net.hyperliquidDex}`);
    await fork.fund(me, '1');
    const bridgeCode = await fork.pub.getCode({ address: BRIDGE2 });
    check('Bridge2 has code on the fork', !!bridgeCode && bridgeCode.length > 2, `${((bridgeCode?.length ?? 2) - 2) / 2} bytes`);

    const sender = createTxSender({ chain: 'arbitrum', client: fork.pub, signer: fork.wallet(account) });
    const trader = { account, arbitrum: fork.pub, arbitrumSender: sender, arbitrumUsdc: USDC, bridge: BRIDGE2 };
    const venueWith = (info: HlInfo, bridge: Address = BRIDGE2) =>
      createHyperliquidVenue({ info, dex: net.hyperliquidDex, user: me, trader: { ...trader, bridge } });

    section('Below the 5 USDC Bridge2 minimum: no deposit');
    await setUsdc(fork, me, 4_999_999n);
    let block0 = await fork.pub.getBlockNumber();
    const small = await venueWith(new ForkCreditedInfo(net.hyperliquidApiUrl, fork, me, await usdcOf(fork, BRIDGE2))).topUpMargin();
    check('4.999999 USDC: nothing sent, nothing moved', small.txs.length === 0 && small.movedUsd === 0, JSON.stringify(small));
    check('no tx mined', (await fork.pub.getBlockNumber()) === block0 && (await usdcOf(fork, me)) === 4_999_999n);

    section('Bridge without code: refused');
    await setUsdc(fork, me, 50_000_000n);
    const nowhere: Address = '0x000000000000000000000000000000000000dEaD';
    try {
      await venueWith(new HlInfo(net.hyperliquidApiUrl), nowhere).topUpMargin();
      check('deposit to a code-less bridge refused', false, 'UNEXPECTED success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check('deposit to a code-less bridge refused', /has no code/.test(msg) && (await usdcOf(fork, me)) === 50_000_000n, msg);
    }

    section('topUpMargin: 123.456789 USDC → Bridge2 (real venue code, fork chain)');
    const funded = 123_456_789n;
    const expectDeposit = 123_450_000n; // floored to whole cents
    await setUsdc(fork, me, funded);
    const bridgeBefore = await usdcOf(fork, BRIDGE2);
    const ethBefore = await fork.pub.getBalance({ address: me });
    block0 = await fork.pub.getBlockNumber();
    const info = new ForkCreditedInfo(net.hyperliquidApiUrl, fork, me, bridgeBefore);
    const t0 = Date.now();
    let outcome: string;
    let result: { movedUsd: number; txs: TxReceiptRef[] } | null = null;
    try {
      result = await venueWith(info).topUpMargin();
      outcome = `UNEXPECTED success ${JSON.stringify(result)}`;
    } catch (err) {
      outcome = err instanceof Error ? err.message : String(err);
    }
    note(`topUpMargin returned after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${outcome}`);

    const block1 = await fork.pub.getBlockNumber();
    const txs: Hex[] = [];
    for (let b = block0 + 1n; b <= block1; b++) {
      const blk = await fork.pub.getBlock({ blockNumber: b, includeTransactions: true });
      for (const tx of blk.transactions) if (isAddressEqual(tx.from, me)) txs.push(tx.hash);
    }
    check('exactly one Arbitrum tx sent', txs.length === 1, txs.join(', '));
    const receipt = await fork.pub.getTransactionReceipt({ hash: txs[0]! });
    check('deposit tx succeeded, to the USDC contract', receipt.status === 'success' && isAddressEqual(receipt.to!, USDC), `${receipt.status}, to ${receipt.to}`);
    const transfers = receipt.logs
      .filter((l) => isAddressEqual(l.address, USDC))
      .map((l) => decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }))
      .filter((e) => e.eventName === 'Transfer');
    const t = transfers[0]?.args as { from: Address; to: Address; value: bigint } | undefined;
    check(
      'single USDC Transfer(wallet → Bridge2, 123.45 USDC)',
      transfers.length === 1 && !!t && isAddressEqual(t.from, me) && isAddressEqual(t.to, BRIDGE2) && t.value === expectDeposit,
      t ? `${t.from} → ${t.to} ${usdc(t.value)}` : 'none',
    );
    const walletAfter = await usdcOf(fork, me);
    const bridgeAfter = await usdcOf(fork, BRIDGE2);
    check('wallet USDC delta == -123.45 (sub-cent dust kept)', funded - walletAfter === expectDeposit, `${usdc(funded)} → ${usdc(walletAfter)}`);
    check('Bridge2 USDC delta == +123.45', bridgeAfter - bridgeBefore === expectDeposit, usdc(bridgeAfter - bridgeBefore));
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    const ethAfter = await fork.pub.getBalance({ address: me });
    check('wallet ETH delta == gas only', ethBefore - ethAfter === gas, `${formatUnits(ethBefore - ethAfter, 18)} ETH, gas ${receipt.gasUsed} × ${receipt.effectiveGasPrice}`);
    check('sender tx value was 0 ETH', (await fork.pub.getTransaction({ hash: txs[0]! })).value === 0n);

    // Credit (simulated) → sendAsset signed by the venue and posted to real Hyperliquid mainnet.
    check('venue waited for the (simulated) default-dex credit', info.creditReads >= 3, `${info.creditReads} default-dex reads`);
    const post = exchangePosts.find((p) => p.action.type === 'sendAsset');
    const a = post?.action;
    const collateral = await info.spotTokenId((await info.dex(net.hyperliquidDex)).collateralToken);
    check(
      'sendAsset moves exactly the credited 123.45 USDC from the default dex into the builder dex, to ourselves',
      !!a && a.amount === '123.45' && a.sourceDex === '' && a.destinationDex === net.hyperliquidDex && a.token === collateral && isAddressEqual(a.destination as Address, me),
      JSON.stringify(a),
    );
    const signer = post
      ? await recoverTypedDataAddress({
          domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: Number(BigInt(post.action.signatureChainId)), verifyingContract: zeroAddress },
          types: { 'HyperliquidTransaction:SendAsset': SEND_ASSET_FIELDS },
          primaryType: 'HyperliquidTransaction:SendAsset',
          message: post.action,
          signature: serializeSignature({ r: post.signature.r, s: post.signature.s, v: BigInt(post.signature.v) }),
        })
      : null;
    check('sendAsset signature recovers to the throwaway wallet (locally)', signer !== null && isAddressEqual(signer, me), `${signer}`);
    const named = (outcome.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((x) => getAddress(x));
    check(
      'Hyperliquid mainnet rejected it only for the missing deposit, naming the throwaway wallet',
      result === null && /Must deposit before performing actions/.test(outcome) && named.some((x) => isAddressEqual(x, me)),
      outcome,
    );
    note('Hyperliquid crediting the Bridge2 deposit and the sendAsset succeeding need a real funded deposit: not provable on a fork.');
  } finally {
    await fork.stop();
  }
}

run('HL DEPOSIT FORK PROOF', main);
