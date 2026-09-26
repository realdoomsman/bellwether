import { BaseError } from 'viem';

/** Thrown by every write method of read-only integrations (no signer configured). */
export class ReadOnlyError extends Error {
  constructor(action: string) {
    super(`${action} needs a signer; these integrations are read-only`);
    this.name = 'ReadOnlyError';
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
