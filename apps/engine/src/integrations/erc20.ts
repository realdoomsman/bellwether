import { decodeEventLog, encodeFunctionData, erc20Abi, parseAbi } from 'viem';
import type { Address, Log } from 'viem';
import { BURN_ADDRESS } from '@floor/shared';
import type { SendRequest } from './tx.ts';

export const WETH_ABI = parseAbi(['function withdraw(uint256 wad)']);

/** Sum of ERC-20 `Transfer`s of `token` to `recipient` in a set of logs (e.g. one receipt). */
export function transfersTo(logs: readonly Log[], token: Address, recipient: Address): bigint {
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
      if (ev.args.to.toLowerCase() === recipient.toLowerCase()) total += ev.args.value;
    } catch {
      // Not a Transfer event (Approval, custom events): ignore.
    }
  }
  return total;
}

/** Burning = transferring to the dead address; launchpad tokens expose no burn(). */
export function burnRequest(token: Address, amount: bigint): SendRequest {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BURN_ADDRESS, amount] }),
    what: `burn ${amount} of ${token}`,
  };
}
