import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

/**
 * Bellwether on Railway: one service built from the root Dockerfile (auto-detected), the engine serving the
 * web app. SQLite lives on the volume, so the service must stay at exactly one replica.
 *
 * Every variable the service should have is listed here: `railway config apply` removes variables that
 * are missing from this file. Secrets use preserve() so their values stay in Railway, never in git.
 *   railway config plan    # preview
 *   railway config apply   # apply
 */
export default defineRailway(() => {
  const data = volume("bellwether-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 50000,
  });

  const app = service("bellwether", {
    // Every push to main builds the root Dockerfile and deploys.
    source: github("realdoomsman/bellwether", { branch: "main" }),
    replicas: { "us-west2": 1 },
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    volumeMounts: { "/data": data },
    env: {
      ENGINE_MODE: "paper",
      // No synthetic demo tokens: the site shows only real registered tokens. Demo rows live in the old
      // database file, so the live data starts from a fresh one.
      DEMO_SEED: "0",
      DB_PATH: "/data/bellwether-main.db",
      TRUST_PROXY: "true",
      // Registrations wait for operator approval (POST /api/admin/tokens/:address/approve) before the engine
      // spends anything on them.
      AUTO_APPROVE: "false",
      ADMIN_TOKEN: preserve(),
      // The protocol fee wallet: creators set this as Creator wallet / Reward recipient. Public by design.
      PROTOCOL_ADDRESS: "0x9838d8AA9bEc9209558a65A9950094927EA358cc",
      // Its key (generated on Railway, never committed). Unused until ENGINE_MODE=live + LIVE_CONFIRM=real-funds.
      PROTOCOL_PRIVATE_KEY: preserve(),
      // Official $BELL on Robinhood Chain: Pons V2, launched 2026-10-05 with the protocol wallet as Creator wallet.
      PROTOCOL_TOKEN_ADDRESS: "0xb38c9c775014c809328e3e6b467068e3c1fc49eb",
      // Fixed site origin: social cards, canonical links and the "Site:" line of the settings message creators sign.
      PUBLIC_URL: "https://bellwether.fun",
      // Operator alerts (risk events, kill switch, worker failure streaks). Set with preserve() once added in Railway.
      // ALERT_TELEGRAM_BOT_TOKEN: preserve(),
      // ALERT_TELEGRAM_CHAT_ID: preserve(),
      // ALERT_DISCORD_WEBHOOK_URL: preserve(),
    },
  });

  return project("bellwether", {
    resources: [app, data],
  });
});
