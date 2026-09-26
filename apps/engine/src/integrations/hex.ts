import type { Address } from 'viem';
import type { Hex } from '../ports.ts';

/** The address as a left-padded 32-byte ABI word / indexed topic. */
export function addressTopic(address: Address): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

/** `eth_getLogs` topic filter matching `topic` at indexed position `pos` (1..3), anything elsewhere. */
export function topicsAt(pos: 1 | 2 | 3, topic: Hex): (Hex | null)[] {
  return Array.from({ length: pos + 1 }, (_, i) => (i === pos ? topic : null));
}

/**
 * True if an ABI-encoded blob (calldata, log data or a topic) contains `address` as a
 * left-padded 32-byte word, i.e. it was passed as a real parameter, not a byte coincidence.
 */
export function hexMentionsAddress(blob: string | null | undefined, address: Address): boolean {
  if (!blob) return false;
  return blob.toLowerCase().includes(addressTopic(address).slice(2));
}

/** Address encoded in an indexed topic, or null if the topic is not address-shaped (or is zero). */
export function topicAddress(topic: string): Address | null {
  const t = topic.toLowerCase();
  if (!/^0x0{24}[0-9a-f]{40}$/.test(t) || /^0x0{64}$/.test(t)) return null;
  return `0x${t.slice(26)}`;
}
