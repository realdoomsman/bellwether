import { defineRailway, preserve, project, service, volume } from "railway/iac";

/**
 * Floor on Railway: one service built from the root Dockerfile (auto-detected), the engine serving the
 * web app. SQLite lives on the volume, so the service must stay at exactly one replica.
 *
 * Every variable the service should have is listed here: `railway config apply` removes variables that
 * are missing from this file. Secrets use preserve() so their values stay in Railway, never in git.
 *   railway config plan    # preview
 *   railway config apply   # apply
 */
export default defineRailway(() => {
  const data = volume("floor-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 50000,
  });

  const floor = service("floor", {
    replicas: { "us-west2": 1 },
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    volumeMounts: { "/data": data },
    env: {
      ENGINE_MODE: "paper",
      DEMO_SEED: "1",
      DB_PATH: "/data/floor.db",
      TRUST_PROXY: "true",
      AUTO_APPROVE: "true",
      ADMIN_TOKEN: preserve(),
      // Publish the fee wallet creators route to (public, not a secret). Until set, registration is disabled.
      // PROTOCOL_ADDRESS: "0x…",
      // Fixed site origin for social cards once a custom domain is attached.
      // PUBLIC_URL: "https://floor.fun",
    },
  });

  return project("floor", {
    resources: [floor, data],
  });
});
