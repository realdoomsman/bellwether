/** Engine entry point: config → db → integrations → scheduler + HTTP server. */
import { serve } from '@hono/node-server';
import { createApp } from './api/app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { VERSION, createEngine } from './engine.ts';
import { createLiveIntegrations, createReadOnlyIntegrations } from './integrations/index.ts';
import { errorMessage, log, registerSecret } from './log.ts';
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

  const scheduler = new Scheduler(db, workerDefs(engine));
  const { app, ticker } = createApp(engine, scheduler);
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info('floor engine listening', {
      port: info.port,
      mode: config.mode,
      version: VERSION,
      protocolWallet: config.walletConfigured ? config.network.protocolAddress : 'NOT CONFIGURED (registration disabled)',
      db: config.dbPath,
      autoApprove: config.autoApprove,
      admin: config.adminToken !== null,
    });
  });
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
    scheduler
      .stop()
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
