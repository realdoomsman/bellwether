import type { StreamEvent } from '@floor/shared';
import { errorMessage, log } from './log.ts';

type Listener = (event: StreamEvent) => void;

/** In-process fan-out of stream events (activity inserts, periodic snapshots). */
export class EventBus {
  readonly #listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  emit(event: StreamEvent): void {
    for (const fn of this.#listeners) {
      try {
        fn(event);
      } catch (err) {
        log.warn('stream listener failed', { type: event.type, error: errorMessage(err) });
      }
    }
  }
}
