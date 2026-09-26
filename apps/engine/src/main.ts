/** Engine entry point: config → db → integrations → scheduler + HTTP server. */
import { serve } from '@hono/node-server';
import { createAlerter } from './alerts.ts';
import { createApp } from './api/app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { VERSION, createEngine } from './engine.ts';
import { createLiveIntegrations, createReadOnlyIntegrations } from './integrations/index.ts';
import { errorMessage, log, registerSecret, registerSecretUrl } from './log.ts';
import { seedDemoTokens } from './paper/demo.ts';
import { createPaperIntegrations } from './paper/index.ts';
import type { Integrations } from './ports.ts';
import { Ledger } from './ledger.ts';
import { Scheduler } from './scheduler.ts';
import { workerDefs } from './workers/index.ts';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  registerSecret(config.live?.privateKey);
  registerSecret(config.adminToken);
  registerSecret(config.alerts.telegramBotToken);
  registerSecret(config.alerts.discordWebhookUrl);
  // Private RPC/API endpoints embed their key in the path or query (Alchemy, QuickNode, Infura).
  for (const url of [config.network.rhcRpcUrl, config.network.arbitrumRpcUrl, config.network.hyperliquidApiUrl, config.network.blockscoutUrl, config.network.geckoterminalUrl, config.live?.relayApiUrl]) {
    registerSecretUrl(url);
  }

  const db = openDb(config.dbPath);
  let io: Integrations;
  if (config.mode === 'live') {
    io = createLiveIntegrations(config.live!);
  } else {
    io = createPaperIntegrations(createReadOnlyIntegrations(config.network), {
      db,
      ledger: new Ledger(db),
      clock: Date.now,
      rhcGasReserveEth: config.risk.rhcGasReserveEth,
    });
  }
  const engine = createEngine({ config, db, io });
  if (config.demoSeed) log.info('demo tokens seeded', { added: seedDemoTokens(engine) });

  const alerter = createAlerter(config.alerts, config.mode);
  alerter?.watch(engine.bus);
  const scheduler = new Scheduler(db, workerDefs(engine), Date.now, alerter ? (h, ok, prev) => alerter.workerFinished(h, ok, prev) : undefined);
  const { app, ticker } = createApp(engine, scheduler);
  // Bounds slow-loris uploads; requestTimeout covers receiving the request only, so SSE streams are unaffected.
  const serverOptions = { headersTimeout: 15_000, requestTimeout: 30_000 };
  const server = serve({ fetch: app.fetch, port: config.port, serverOptions }, (info) => {
    log.info('engine listening', {
      port: info.port,
      mode: config.mode,
      version: VERSION,
      protocolWallet: config.walletConfigured ? config.network.protocolAddress : 'NOT CONFIGURED (registration disabled)',
      db: config.dbPath,
      autoApprove: config.autoApprove,
      admin: config.adminToken !== null,
    });
  });
  alerter?.notify(`Engine started (${config.mode}, v${VERSION}).`);
  scheduler.start();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    ticker.stop();
    const force = setTimeout(() => {
      log.error('shutdown timed out; exiting');
      process.exit(1);
    }, 30_000);
    force.unref();
    server.close();
    alerter?.notify(`Engine stopping (${signal}).`);
    scheduler
      .stop()
      .then(() => alerter?.flush())
      .then(() => {
        db.close();
        log.info('stopped cleanly');
        process.exit(0);
      })
      .catch((err: unknown) => {
        log.error('shutdown failed', { error: errorMessage(err) });
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
