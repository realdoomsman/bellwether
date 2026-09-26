import { randomUUID } from 'node:crypto';
import { PAPER_PREFIX } from '../activity.ts';

/** Transaction reference for a simulated write; never rendered as a link. */
export function paperRef(): string {
  return `${PAPER_PREFIX}${randomUUID()}`;
}
