import type { StreamEvent } from '@bellwether/shared';
import { errorMessage, log } from './log.ts';

/** `data` is `JSON.stringify(event.data)`, computed once per event and shared by every listener. */
type Listener = (event: StreamEvent, data: string) => void;

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

  /** `data` may be passed when the caller already serialized `event.data`. */
  emit(event: StreamEvent, data?: string): void {
    if (this.#listeners.size === 0) return;
    const json = data ?? JSON.stringify(event.data);
    for (const fn of this.#listeners) {
      try {
        fn(event, json);
      } catch (err) {
        log.warn('stream listener failed', { type: event.type, error: errorMessage(err) });
      }
    }
  }
}
