/**
 * Hyperliquid action signing, ported from the official Python SDK (hyperliquid/utils/signing.py):
 * - L1 actions (orders, leverage): EIP-712 "phantom agent" whose connectionId is
 *   keccak256(msgpack(action) ‖ nonce as u64 big-endian ‖ vault flag).
 * - User-signed actions (sendAsset, ...): EIP-712 over the action fields themselves.
 */
import { encode } from '@msgpack/msgpack';
import { concat, keccak256, numberToBytes, parseSignature, zeroAddress } from 'viem';
import type { LocalAccount, TypedDataParameter } from 'viem';
import type { Hex } from '../../ports.ts';

export interface HlSignature {
  r: Hex;
  s: Hex;
  v: number;
}

/** keccak256(msgpack(action) ‖ nonce(8 bytes BE) ‖ 0x00) — no vault, no expiresAfter. */
export function actionHash(action: unknown, nonce: number): Hex {
  return keccak256(concat([encode(action), numberToBytes(nonce, { size: 8 }), new Uint8Array([0])]));
}

function splitSignature(sig: Hex): HlSignature {
  const { r, s, yParity } = parseSignature(sig);
  return { r, s, v: yParity + 27 };
}

export async function signL1Action(account: LocalAccount, action: unknown, nonce: number, isMainnet: boolean): Promise<HlSignature> {
  const sig = await account.signTypedData({
    domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: zeroAddress },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    primaryType: 'Agent',
    message: { source: isMainnet ? 'a' : 'b', connectionId: actionHash(action, nonce) },
  });
  return splitSignature(sig);
}

/** `action` must carry `signatureChainId` (hex) and every field named in `fields`. */
export async function signUserSignedAction(
  account: LocalAccount,
  action: Record<string, unknown> & { signatureChainId: Hex },
  primaryType: string,
  fields: readonly TypedDataParameter[],
): Promise<HlSignature> {
  const sig = await account.signTypedData({
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: Number(BigInt(action.signatureChainId)),
      verifyingContract: zeroAddress,
    },
    types: { [primaryType]: fields },
    primaryType,
    message: action,
  });
  return splitSignature(sig);
}

export const SEND_ASSET_FIELDS: readonly TypedDataParameter[] = [
  { name: 'hyperliquidChain', type: 'string' },
  { name: 'destination', type: 'string' },
  { name: 'sourceDex', type: 'string' },
  { name: 'destinationDex', type: 'string' },
  { name: 'token', type: 'string' },
  { name: 'amount', type: 'string' },
  { name: 'fromSubAccount', type: 'string' },
  { name: 'nonce', type: 'uint64' },
];
