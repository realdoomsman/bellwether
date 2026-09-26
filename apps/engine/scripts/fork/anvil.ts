/**
 * Local anvil fork of Robinhood Chain for fork proofs. Never touches a real chain's state:
 * every write goes to the local fork, funded with anvil cheatcodes.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, createTestClient, createWalletClient, http, parseEther } from 'viem';
import type { Account, Address, Chain, Hex, PublicClient, TestClient, Transport, WalletClient } from 'viem';
import { robinhoodChain } from '../../src/integrations/chains.ts';

export const RHC_MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com';

export interface Fork {
  url: string;
  chain: Chain;
  pub: PublicClient<Transport, Chain>;
  test: TestClient<'anvil', Transport, Chain>;
  wallet(account: Account): WalletClient<Transport, Chain, Account>;
  /** Funds `address` with `eth` ETH via anvil_setBalance. */
  fund(address: Address, eth: string): Promise<void>;
  /** Sends a tx from `from` without its key (anvil impersonation) and waits for a successful receipt. */
  impersonate(from: Address, tx: { to: Address; data?: Hex; value?: bigint }): Promise<Hex>;
  stop(): Promise<void>;
}

function anvilBinary(): string {
  const exe = process.platform === 'win32' ? 'anvil.exe' : 'anvil';
  return process.env.ANVIL_BIN ?? path.join(homedir(), '.foundry', 'bin', exe);
}

/**
 * Spawns anvil forking RHC mainnet at the latest block and mines one local block (forked calls fail
 * with "Excess blob gas not set" until the fork has a block of its own).
 */
export async function startFork(port: number, forkUrl = RHC_MAINNET_RPC): Promise<Fork> {
  const url = `http://127.0.0.1:${port}`;
  // The public RHC RPC answers bursts with HTTP 429 and a 60 s reset: keep anvil's own throttle and retry patiently.
  const child: ChildProcess = spawn(
    anvilBinary(),
    [
      ...['--fork-url', forkUrl, '--chain-id', '4663', '--hardfork', 'prague', '--port', String(port), '--silent'],
      ...['--retries', '30', '--fork-retry-backoff', '3000', '--compute-units-per-second', '100'],
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  let exited = false;
  child.once('exit', () => (exited = true));
  const kill = async () => {
    if (exited) return;
    child.kill();
    for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    if (!exited) child.kill('SIGKILL');
  };
  const onExit = () => child.kill();
  process.once('exit', onExit);

  const chain = robinhoodChain(url);
  const transport = http(url, { timeout: 120_000 });
  const pub = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 200 });
  const test = createTestClient({ chain, transport, mode: 'anvil' });
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (exited) throw new Error(`anvil exited: ${stderr.trim() || 'no output'}`);
      try {
        await pub.getChainId();
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('anvil did not become ready within 60s');
        await sleep(250);
      }
    }
    await test.mine({ blocks: 1 });
  } catch (err) {
    await kill();
    throw err;
  }

  return {
    url,
    chain,
    pub,
    test,
    wallet: (account) => createWalletClient({ chain, transport, account }),
    async fund(address, eth) {
      await test.setBalance({ address, value: parseEther(eth) });
    },
    async impersonate(from, tx) {
      await test.impersonateAccount({ address: from });
      try {
        const hash = await createWalletClient({ chain, transport }).sendTransaction({ account: from, ...tx });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error(`impersonated tx from ${from} reverted: ${hash}`);
        return hash;
      } finally {
        await test.stopImpersonatingAccount({ address: from });
      }
    },
    async stop() {
      process.off('exit', onExit);
      await kill();
    },
  };
}
