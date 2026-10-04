import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  MethodNotFoundRpcError,
  MethodNotSupportedRpcError,
  RpcRequestError,
} from 'viem';
import type { TxReceiptRef } from '../ports.ts';

/** Thrown by every write method of read-only integrations (no signer configured). */
export class ReadOnlyError extends Error {
  constructor(action: string) {
    super(`${action} needs a signer; these integrations are read-only`);
    this.name = 'ReadOnlyError';
  }
}

export type PriceGuardKind = 'twap-deviation' | 'price-impact' | 'no-twap';

/** A buyback refused before sending anything: the pool price looks manipulated, or the trade would move it too far. */
export class PriceGuardError extends Error {
  readonly kind: PriceGuardKind;
  /** Gas of a preparatory tx mined before the refusal (growing a V3 pool's TWAP history), to be booked by the caller. */
  spent: { gasWei: bigint; tx: TxReceiptRef } | null = null;
  constructor(kind: PriceGuardKind, message: string) {
    super(message);
    this.name = 'PriceGuardError';
    this.kind = kind;
  }
}

/** One-line error text. For viem errors: the short message plus the node's own reason (`details`). */
export function shortError(err: unknown): string {
  if (err instanceof BaseError) {
    const head = err.shortMessage.split('\n')[0] ?? err.shortMessage;
    const details = err.details?.replace(/\s+/g, ' ').trim().slice(0, 200);
    return details && !head.includes(details) ? `${head} (${details})` : head;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0] ?? msg;
}

/** A getter that reverts or returns nothing means "this contract has no such view", not a network failure. */
export function isMissingView(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
}

export function isUnsupportedRpc(err: unknown): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof MethodNotFoundRpcError || e instanceof MethodNotSupportedRpcError) !== null;
}

/** HTTP 429 or a JSON-RPC 429 error: the node is throttling us (retry later, don't shrink the query). */
export function isRateLimited(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk((e) => (e instanceof HttpRequestError && e.status === 429) || (e instanceof RpcRequestError && e.code === 429)) !== null
  );
}
