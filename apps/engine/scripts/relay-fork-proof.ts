/**
 * FORK PROOF of the Relay bridge deposit (Robinhood Chain ETH → Arbitrum USDC): the live integrations'
 * `bridge.ethToUsdc` fetches a REAL Relay /quote for the throwaway wallet, validates it, and sends the
 * deposit through the engine's tx sender to a local anvil fork of RHC, where it runs against the real
 * Relay depository contract. Nothing is sent to a real chain.
 *
 *   node scripts/relay-fork-proof.ts   (needs Foundry's anvil; ANVIL_BIN overrides ~/.foundry/bin/anvil)
 *
 * Not provable without funds: the destination fill. Relay's solver only fills deposits it sees on the real
 * RHC, so USDC arriving on Arbitrum for this order id cannot be shown from a fork.
 */
import { decodeEventLog, decodeFunctionData, formatEther, formatUnits, isAddressEqual, parseAbi, parseEther } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import { createLiveIntegrations } from '../src/integrations/index.ts';
import { DEFAULT_RELAY_DEPOSIT_CONTRACTS } from '../src/integrations/relay.ts';
import { startFork } from './fork/anvil.ts';
import { check, note, run, section } from './fork/report.ts';

const PORT = Number(process.env.RELAY_FORK_PROOF_PORT ?? 8547);
const AMOUNT = parseEther('0.05');
/** Relay v2 depository: the call the quote makes and the event it emits for native deposits. */
const DEPOSITORY_ABI = parseAbi([
  'function depositNative(address depositor, bytes32 id)',
  'event RelayNativeDeposit(address from, uint256 amount, bytes32 id)',
]);

/** Every Relay /quote response the bridge fetched (its full JSON, including the request id). */
interface QuoteJson {
  steps: { requestId?: string }[];
  protocol?: { v2?: { orderId?: string } };
  details: { currencyOut: { amount: string } };
}
const quotes: QuoteJson[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  if (String(input instanceof Request ? input.url : input).endsWith('/quote') && res.ok) quotes.push((await res.clone().json()) as QuoteJson);
  return res;
};

async function main(): Promise<void> {
  section(`RHC fork (anvil on :${PORT})`);
  const fork = await startFork(PORT);
  try {
    note(`forked RHC mainnet at block ${await fork.pub.getBlockNumber()}`);
    const pk = generatePrivateKey();
    const me = privateKeyToAccount(pk).address;
    await fork.fund(me, '1');
    const config = loadConfig({ ENGINE_MODE: 'live', LIVE_CONFIRM: 'real-funds', PROTOCOL_PRIVATE_KEY: pk, ROBINHOOD_RPC_URL: fork.url, DB_PATH: ':memory:' });
    const io = createLiveIntegrations(config.live!);
    const depository = DEFAULT_RELAY_DEPOSIT_CONTRACTS[0]!;
    const code = await fork.pub.getCode({ address: depository });
    check('pinned Relay depository has code on RHC', !!code && code.length > 2, `${depository}, ${((code?.length ?? 2) - 2) / 2} bytes`);

    section(`bridge.ethToUsdc(${formatEther(AMOUNT)} ETH): real Relay quote → validation → deposit on the fork`);
    const ethUsd = await io.prices.ethUsd();
    // The treasury's floor: the engine's own ETH/USD price less the allowed impact.
    const maxImpact = config.risk.bridgeMaxImpactPct;
    const minUsdc = Number(formatEther(AMOUNT)) * ethUsd * (1 - maxImpact);
    const quoted = await io.bridge.quote(AMOUNT);
    note(`quote: ${quoted?.expectedUsdc} USDC, impact ${((quoted?.impactPct ?? 0) * 100).toFixed(3)}%; floor ${minUsdc.toFixed(2)} USDC at $${ethUsd.toFixed(2)}/ETH`);
    const ethBefore = await fork.pub.getBalance({ address: me });
    const block0 = await fork.pub.getBlockNumber();
    const res = await io.bridge.ethToUsdc(AMOUNT, maxImpact, minUsdc);
    note(`deposit tx ${res.tx.hash} on ${res.tx.chain}, expected ${res.expectedUsdc} USDC`);
    check('bridge returned an RHC tx and a positive expected output >= floor', res.tx.chain === 'rhc' && res.expectedUsdc >= minUsdc, `${res.expectedUsdc} >= ${minUsdc.toFixed(2)}`);

    const hash = res.tx.hash as Hex;
    const receipt = await fork.pub.getTransactionReceipt({ hash });
    const tx = await fork.pub.getTransaction({ hash });
    check('deposit tx succeeded against the real depository', receipt.status === 'success' && isAddressEqual(receipt.to!, depository), `${receipt.status}, to ${receipt.to}`);
    check('tx value == 0.05 ETH exactly, sent by the wallet', tx.value === AMOUNT && isAddressEqual(tx.from, me), `${formatEther(tx.value)} ETH from ${tx.from}`);
    const call = decodeFunctionData({ abi: DEPOSITORY_ABI, data: tx.input });
    const [depositor, orderId] = call.args;
    check('calldata is depositNative(our wallet, id)', call.functionName === 'depositNative' && isAddressEqual(depositor, me), `depositor ${depositor}, id ${orderId}`);
    // ethToUsdc fetched its own quote after `quote()`: the last /quote response is the one it signed.
    const q = quotes.at(-1);
    const quotedOrder = q?.protocol?.v2?.orderId;
    check("deposit id == the signed quote's Relay v2 orderId", !!quotedOrder && quotedOrder.toLowerCase() === orderId.toLowerCase(), `${quotedOrder} (Relay requestId ${q?.steps[0]?.requestId})`);

    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    const ethAfter = await fork.pub.getBalance({ address: me });
    check('wallet ETH dropped by exactly value + gas', ethBefore - ethAfter === AMOUNT + gas, `${formatEther(ethBefore - ethAfter)} = ${formatEther(AMOUNT)} + gas ${formatEther(gas)}`);
    check('exactly one block mined (one tx)', (await fork.pub.getBlockNumber()) === block0 + 1n);

    const deposits = receipt.logs
      .filter((l) => isAddressEqual(l.address, depository))
      .flatMap((l) => {
        try {
          return [decodeEventLog({ abi: DEPOSITORY_ABI, data: l.data, topics: l.topics })];
        } catch {
          note(`undecoded depository log: topics ${l.topics.join(',')} data ${l.data}`);
          return [];
        }
      })
      .filter((e) => e.eventName === 'RelayNativeDeposit');
    const ev = deposits[0]?.args;
    check(
      'depository emitted RelayNativeDeposit(our wallet, 0.05 ETH, order id)',
      deposits.length === 1 && !!ev && isAddressEqual(ev.from, me) && ev.amount === AMOUNT && ev.id.toLowerCase() === orderId.toLowerCase(),
      ev ? `from ${ev.from}, ${formatEther(ev.amount)} ETH, id ${ev.id}` : `${receipt.logs.length} logs, none decoded`,
    );
    const held = (await fork.pub.getBalance({ address: depository, blockNumber: receipt.blockNumber })) - (await fork.pub.getBalance({ address: depository, blockNumber: receipt.blockNumber - 1n }));
    check('depository ETH balance grew by exactly 0.05 ETH', held === AMOUNT, `${formatEther(held)} ETH`);
    note(`quoted output ${formatUnits(BigInt(q?.details.currencyOut.amount ?? '0'), 6)} USDC to ${me} on Arbitrum.`);
    note('Destination fill (USDC credited on Arbitrum for this order id) needs a real deposit: not provable on a fork.');
  } finally {
    await fork.stop();
  }
}

run('RELAY FORK PROOF', main);
