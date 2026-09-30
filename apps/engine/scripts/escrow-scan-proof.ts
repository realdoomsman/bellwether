/**
 * PRODUCTION-SCALE PROOF of the Pons V2 fee-escrow ledger's first scan, READ-ONLY against the real public
 * Robinhood Chain RPC (no key, no writes).
 *
 * For the production protocol wallet and for the busiest real creator found in recent escrow events, a
 * fresh ledger scans from PONS_V2_FROM_BLOCK to head through a client configured exactly like the
 * engine's, and the run is measured: wall time, requests by method, HTTP 429s, node errors. Completeness
 * is checked independently of the ledger: Σ Credited − Σ Claimed over every escrow log the scan fetched
 * up to a recent block must equal the escrow's `balanceOf(wallet)` at that block.
 *
 *   node scripts/escrow-scan-proof.ts [extra wallets…]
 */
import { createPublicClient, decodeEventLog, encodeEventTopics, formatEther, http, numberToHex } from 'viem';
import type { Address, Hex } from 'viem';
import { loadConfig } from '../src/config.ts';
import { RPC_OPTIONS, robinhoodChain } from '../src/integrations/chains.ts';
import type { Client } from '../src/integrations/chains.ts';
import { createEscrowLedger, PONS_V2_ESCROW_ABI } from '../src/integrations/ponsv2.ts';
import { check, note, run, section } from './fork/report.ts';

const PRODUCTION_WALLET: Address = '0x9838d8AA9bEc9209558a65A9950094927EA358cc';
/** Recent window searched for the busiest real creator. */
const DISCOVERY_BLOCKS = 400_000n;
const MAX_CREATOR_SOURCES = 10;
const net = loadConfig({ ENGINE_MODE: 'paper' }).network;
const CLAIMER_INTERVAL_MS = loadConfig({ ENGINE_MODE: 'paper' }).intervals.claimer;
const { ponsV2Factory: factory, ponsV2Hook: hook, ponsV2FeeEscrow: escrow } = net.contracts;
const CREDITED = encodeEventTopics({ abi: PONS_V2_ESCROW_ABI, eventName: 'Credited' })[0];
/** How long one scan may run before it is reported as failed: twice the claimer interval. */
const SCAN_BUDGET_MS = Number(process.env.SCAN_BUDGET_MS ?? 2 * CLAIMER_INTERVAL_MS);

interface Stats {
  requests: number;
  byMethod: Map<string, number>;
  http429: number;
  nodeErrors: Map<string, number>;
  /** Escrow logs returned to getLogs, keyed by (tx, logIndex) so a retried range is not double counted. */
  escrowLogs: Map<string, { topics: Hex[]; data: Hex; block: bigint }>;
  /** Highest `toBlock` of an escrow getLogs request so far (scan progress). */
  scannedTo: bigint;
}

function newStats(): Stats {
  return { requests: 0, byMethod: new Map(), http429: 0, nodeErrors: new Map(), escrowLogs: new Map(), scannedTo: 0n };
}

interface RpcBody {
  method: string;
  params?: { address?: string; toBlock?: Hex }[];
}

/** The engine's RHC client (same timeout/retry options) with request accounting. */
function countingClient(stats: Stats): Client {
  return createPublicClient({
    chain: robinhoodChain(net.rhcRpcUrl),
    transport: http(net.rhcRpcUrl, {
      ...RPC_OPTIONS,
      onFetchRequest(_req, init) {
        const body = JSON.parse(String(init.body)) as RpcBody | RpcBody[];
        for (const b of Array.isArray(body) ? body : [body]) {
          stats.requests++;
          stats.byMethod.set(b.method, (stats.byMethod.get(b.method) ?? 0) + 1);
          const q = b.params?.[0];
          if (b.method === 'eth_getLogs' && q?.toBlock && q.address?.toLowerCase() === escrow.toLowerCase()) {
            const to = BigInt(q.toBlock);
            if (to > stats.scannedTo) stats.scannedTo = to;
          }
        }
      },
      async onFetchResponse(res) {
        if (res.status === 429) {
          stats.http429++;
          return;
        }
        const text = await res.clone().text();
        let j: { result?: unknown; error?: { code: number; message: string } };
        try {
          j = JSON.parse(text);
        } catch {
          stats.nodeErrors.set(`HTTP ${res.status} non-JSON`, (stats.nodeErrors.get(`HTTP ${res.status} non-JSON`) ?? 0) + 1);
          return;
        }
        if (j.error) {
          const key = j.error.code === 429 ? 'rpc 429' : `${j.error.code} ${j.error.message.slice(0, 60)}`;
          if (j.error.code === 429) stats.http429++;
          else stats.nodeErrors.set(key, (stats.nodeErrors.get(key) ?? 0) + 1);
          return;
        }
        if (Array.isArray(j.result)) {
          for (const l of j.result as { address?: string; topics?: Hex[]; data?: Hex; transactionHash?: string; logIndex?: string; blockNumber?: Hex }[]) {
            if (l.address?.toLowerCase() === escrow.toLowerCase() && l.topics && l.data && l.transactionHash && l.blockNumber) {
              stats.escrowLogs.set(`${l.transactionHash}:${l.logIndex}`, { topics: l.topics, data: l.data, block: BigInt(l.blockNumber) });
            }
          }
        }
      },
    }),
  });
}

/**
 * The busiest real creator in the last DISCOVERY_BLOCKS: the recipient with the most escrow credits among
 * those credited by at most MAX_CREATOR_SOURCES sources (a creator has a few curves plus the shared hook;
 * the Pons protocol fee recipient is credited by every launch and is not a creator).
 */
async function busiestCreator(rhc: Client, exclude: Set<string>): Promise<{ wallet: Address; credits: number; recipients: number }> {
  const head = await rhc.getBlockNumber();
  const counts = new Map<string, { credits: number; sources: Set<string> }>();
  let chunk = 100_000n;
  for (let from = head - DISCOVERY_BLOCKS; from <= head; ) {
    const to = from + chunk - 1n < head ? from + chunk - 1n : head;
    let logs: { topics: Hex[] }[];
    try {
      logs = await rhc.request({ method: 'eth_getLogs', params: [{ address: escrow, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics: [CREDITED] }] });
    } catch (err) {
      if (chunk <= 1_000n) throw err;
      chunk /= 4n;
      continue;
    }
    for (const l of logs) {
      const r = `0x${l.topics[1]!.slice(26)}`;
      const c = counts.get(r) ?? { credits: 0, sources: new Set<string>() };
      c.credits++;
      c.sources.add(l.topics[2]!);
      counts.set(r, c);
    }
    from = to + 1n;
  }
  const ranked = [...counts].filter(([a, c]) => !exclude.has(a) && c.sources.size <= MAX_CREATOR_SOURCES).sort((a, b) => b[1].credits - a[1].credits);
  const top = [...counts].sort((a, b) => b[1].credits - a[1].credits)[0];
  if (top) note(`most credited recipient overall: ${top[0]} ×${top[1].credits} from ${top[1].sources.size} sources (protocol fee recipient, not a creator)`);
  note(`top creators: ${ranked.slice(0, 5).map(([a, c]) => `${a} ×${c.credits}/${c.sources.size} sources`).join(', ')}`);
  const [wallet, c] = ranked[0]!;
  return { wallet: wallet as Address, credits: c.credits, recipients: counts.size };
}

async function proveScan(label: string, wallet: Address): Promise<void> {
  section(`${label}: ${wallet}`);
  const stats = newStats();
  const rhc = countingClient(stats);
  const ledger = createEscrowLedger({ rhc, factory, hook, escrow, wallet, fromBlock: BigInt(net.ponsV2FromBlock) });
  const t0 = Date.now();
  let error: string | null = null;
  const progress = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    note(`  ${sec}s: requests ${stats.requests} (${[...stats.byMethod].map(([m, n]) => `${m}×${n}`).join(' ')}), 429s ${stats.http429}, escrow logs ${stats.escrowLogs.size}, requested up to block ${stats.scannedTo}`);
  }, 60_000);
  let deadline: NodeJS.Timeout | undefined;
  try {
    // Any token: the first call runs the full scan. Abandoned (not awaited further) after SCAN_BUDGET_MS.
    await Promise.race([
      ledger.unclaimed(wallet),
      new Promise((_, reject) => (deadline = setTimeout(() => reject(new Error(`scan still running after ${SCAN_BUDGET_MS / 1000}s (abandoned)`)), SCAN_BUDGET_MS))),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(progress);
    clearTimeout(deadline);
  }
  const ms = Date.now() - t0;
  const methods = [...stats.byMethod].map(([m, n]) => `${m}×${n}`).join(' ');
  const errors = [...stats.nodeErrors].map(([m, n]) => `${m} ×${n}`).join('; ') || 'none';
  note(`scan ${error ? 'FAILED' : 'done'} in ${(ms / 1000).toFixed(1)}s, ${stats.requests} requests (${methods}), 429s ${stats.http429}, node errors: ${errors}`);
  check(`${label}: full scan from ${net.ponsV2FromBlock} completes`, error === null, error ?? `${stats.escrowLogs.size} escrow logs`);
  check(`${label}: within the claimer interval`, ms < CLAIMER_INTERVAL_MS, `${(ms / 1000).toFixed(1)}s < ${CLAIMER_INTERVAL_MS / 1000}s`);
  if (error) return;

  // Balance at a fixed recent block; the incremental sync below reads past it, so every log up to it is in hand.
  const at = await rhc.getBlockNumber();
  const balance = await rhc.readContract({ address: escrow, abi: PONS_V2_ESCROW_ABI, functionName: 'balanceOf', args: [wallet], blockNumber: at });

  // What every later claimer run pays: one incremental sync (re-reads ESCROW_RESCAN_BLOCKS + new blocks).
  const before = stats.requests;
  const logsBefore = stats.byMethod.get('eth_getLogs') ?? 0;
  const t1 = Date.now();
  await ledger.unclaimed(wallet);
  const incMs = Date.now() - t1;
  const incLogs = (stats.byMethod.get('eth_getLogs') ?? 0) - logsBefore;
  check(`${label}: next sync is incremental (one getLogs range)`, incLogs <= 2 && incMs < 30_000, `${stats.requests - before} requests (${incLogs} eth_getLogs incl. 429 retries), ${(incMs / 1000).toFixed(1)}s`);

  let credited = 0n;
  let claimed = 0n;
  for (const l of stats.escrowLogs.values()) {
    if (l.block > at) continue;
    const ev = decodeEventLog({ abi: PONS_V2_ESCROW_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    if (ev.eventName === 'Credited' && ev.args.recipient.toLowerCase() === wallet.toLowerCase()) credited += ev.args.amount;
    if (ev.eventName === 'Claimed' && ev.args.recipient.toLowerCase() === wallet.toLowerCase()) claimed += ev.args.amount;
  }
  check(
    `${label}: Σ Credited − Σ Claimed over the scanned logs up to block ${at} == escrow balanceOf at ${at}`,
    credited - claimed === balance,
    `${formatEther(credited)} − ${formatEther(claimed)} = ${formatEther(credited - claimed)} vs ${formatEther(balance)} ETH`,
  );
}

async function main(): Promise<void> {
  const probe = newStats();
  const rhc = countingClient(probe);
  section('Setup');
  note(`RHC ${net.rhcRpcUrl}, head ${await rhc.getBlockNumber()}, escrow ${escrow}, scan from ${net.ponsV2FromBlock}, claimer interval ${CLAIMER_INTERVAL_MS / 1000}s`);
  const busy = await busiestCreator(rhc, new Set([PRODUCTION_WALLET.toLowerCase()]));
  note(`busiest creator ${busy.wallet}: ${busy.credits} credits (of ${busy.recipients} recipients) in the window`);
  await proveScan('production protocol wallet', PRODUCTION_WALLET);
  await proveScan('busiest real creator', busy.wallet);
  for (const w of process.argv.slice(2)) await proveScan('extra wallet', w as Address);
}

run('ESCROW SCAN PROOF', main, { exit: true });
