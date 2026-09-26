import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

/**
 * Stepup on Railway: one service built from the root Dockerfile (auto-detected), the engine serving the
 * web app. SQLite lives on the volume, so the service must stay at exactly one replica.
 *
 * Every variable the service should have is listed here: `railway config apply` removes variables that
 * are missing from this file. Secrets use preserve() so their values stay in Railway, never in git.
 *   railway config plan    # preview
 *   railway config apply   # apply
 */
export default defineRailway(() => {
  const data = volume("stepup-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 50000,
  });

  const app = service("stepup", {
    // Every push to main builds the root Dockerfile and deploys.
    source: github("realdoomsman/stepup", { branch: "main" }),
    replicas: { "us-west2": 1 },
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    volumeMounts: { "/data": data },
    env: {
      ENGINE_MODE: "paper",
      DEMO_SEED: "1",
      DB_PATH: "/data/stepup.db",
      TRUST_PROXY: "true",
      AUTO_APPROVE: "true",
      ADMIN_TOKEN: preserve(),
      // The protocol fee wallet: creators set this as Creator wallet / Reward recipient. Public by design.
      PROTOCOL_ADDRESS: "0x07430cbe35B0Fa683426B3cE8074f8A330312728",
      // Its key (generated on Railway, never committed). Unused until ENGINE_MODE=live + LIVE_CONFIRM=real-funds.
      PROTOCOL_PRIVATE_KEY: preserve(),
      // Official $STEP token on Robinhood Chain, once launched from the protocol wallet.
      // PROTOCOL_TOKEN_ADDRESS: "0x…",
      // Fixed site origin for social cards once a custom domain is attached.
      // PUBLIC_URL: "https://stepup.fun",
      // Operator alerts (risk events, kill switch, worker failure streaks). Set with preserve() once added in Railway.
      // ALERT_TELEGRAM_BOT_TOKEN: preserve(),
      // ALERT_TELEGRAM_CHAT_ID: preserve(),
      // ALERT_DISCORD_WEBHOOK_URL: preserve(),
    },
  });

  return project("stepup", {
    resources: [app, data],
  });
});
