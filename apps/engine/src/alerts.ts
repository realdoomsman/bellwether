/**
 * Operator alerts: risk events, kill switch, repeated worker failures, engine start/stop, pushed to
 * Telegram and/or a Discord webhook. Delivery is best effort: one message at a time, bounded queue,
 * rate-limited, never blocking or failing the engine.
 */
import { BRAND, type ActivityEvent, type ActivityKind, type EngineMode, type WorkerHealth } from '@stepup/shared';
import type { EventBus } from './bus.ts';
import { errorMessage, log } from './log.ts';

export interface AlertConfig {
  telegramBotToken: string | null;
  telegramChatId: string | null;
  discordWebhookUrl: string | null;
}

export type AlertSink = (text: string) => Promise<void>;

/** Activity kinds an operator must hear about immediately. */
const ALERT_KINDS: readonly ActivityKind[] = ['risk', 'stop', 'liquidated', 'kill-switch'];
/** Worker failure streak that pages, and the streak interval at which it pages again. */
export const FAILURE_ALERT_AT = 3;
const FAILURE_REPEAT_EVERY = 20;
const MAX_QUEUE = 50;
const MAX_PER_MINUTE = 12;
const SEND_TIMEOUT_MS = 10_000;

export class Alerter {
  readonly #sinks: AlertSink[];
  readonly #clock: () => number;
  readonly #prefix: string;
  readonly #queue: string[] = [];
  #sentAt: number[] = [];
  #dropped = 0;
  #draining: Promise<void> | null = null;

  constructor(sinks: AlertSink[], mode: EngineMode, clock: () => number = Date.now) {
    this.#sinks = sinks;
    this.#clock = clock;
    this.#prefix = mode === 'paper' ? `[${BRAND.name} · PAPER] ` : `[${BRAND.name}] `;
  }

  notify(text: string): void {
    if (this.#queue.length >= MAX_QUEUE) {
      this.#dropped++;
      return;
    }
    this.#queue.push(this.#prefix + text);
    this.#kick();
  }

  #kick(): void {
    if (this.#draining) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      // Something may have been queued between the drain loop ending and this callback.
      if (this.#queue.length > 0) this.#kick();
    });
  }

  /** Resolves once everything queued so far has been attempted (used on shutdown and in tests). */
  async flush(): Promise<void> {
    while (this.#draining) await this.#draining;
  }

  async #drain(): Promise<void> {
    for (let text = this.#queue.shift(); text !== undefined; text = this.#queue.shift()) {
      const now = this.#clock();
      this.#sentAt = this.#sentAt.filter((t) => now - t < 60_000);
      if (this.#sentAt.length >= MAX_PER_MINUTE) {
        this.#dropped++;
        continue;
      }
      if (this.#dropped > 0) {
        text += `\n(${this.#dropped} earlier alert${this.#dropped === 1 ? '' : 's'} suppressed by rate limit; see logs)`;
        this.#dropped = 0;
      }
      this.#sentAt.push(now);
      await Promise.all(
        this.#sinks.map((send) => send(text).catch((err: unknown) => log.warn('alert delivery failed', { error: errorMessage(err) }))),
      );
    }
  }

  /** Forwards alert-worthy activity from the event bus. Returns the unsubscribe function. */
  watch(bus: EventBus): () => void {
    return bus.subscribe((ev) => {
      if (ev.type === 'activity' && ALERT_KINDS.includes(ev.data.kind)) this.notify(activityText(ev.data));
    });
  }

  /** Scheduler hook: page on a failure streak (and periodically while it lasts), and on recovery. */
  workerFinished(h: WorkerHealth, ok: boolean, previousErrors: number): void {
    if (ok) {
      if (previousErrors >= FAILURE_ALERT_AT) this.notify(`✅ ${h.label} recovered after ${previousErrors} failed runs.`);
      return;
    }
    const n = h.consecutiveErrors;
    if (n === FAILURE_ALERT_AT || (n > FAILURE_ALERT_AT && (n - FAILURE_ALERT_AT) % FAILURE_REPEAT_EVERY === 0)) {
      this.notify(`🔴 ${h.label} has failed ${n} runs in a row: ${h.lastError ?? 'unknown error'}`);
    }
  }
}

function activityText(e: ActivityEvent): string {
  const icon = e.kind === 'kill-switch' ? '🛑' : e.kind === 'liquidated' ? '💥' : '⚠️';
  const txs = e.txs.filter((t) => t.url).map((t) => t.url);
  return [`${icon} ${e.title}`, ...txs].join('\n');
}

export function createAlerter(cfg: AlertConfig, mode: EngineMode): Alerter | null {
  const sinks: AlertSink[] = [];
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    const url = `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`;
    const chatId = cfg.telegramChatId;
    sinks.push((text) => post(url, { chat_id: chatId, text, disable_web_page_preview: true }));
  }
  if (cfg.discordWebhookUrl) {
    const url = cfg.discordWebhookUrl;
    // Discord rejects content over 2000 characters.
    sinks.push((text) => post(url, { content: text.slice(0, 2000), allowed_mentions: { parse: [] } }));
  }
  return sinks.length > 0 ? new Alerter(sinks, mode) : null;
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  // Never include the URL: both Telegram and Discord embed the credential in it.
  if (!res.ok) throw new Error(`alert endpoint answered HTTP ${res.status}`);
}
