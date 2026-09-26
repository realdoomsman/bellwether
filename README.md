# Floor

**Memecoins with a trading floor.**

Launch a memecoin on a Robinhood Chain launchpad and set its creator-fee recipient to the Floor protocol
wallet. The engine claims those fees, trades US-stock perps with part of them, and buys back and burns
your token with the rest, plus any trading profit. Every action is logged along with its transaction.

```
creator fees ──┬── 60% ─► trading book ─► stock perps (Hyperliquid xyz) ─► profit ─┬─ 80% ─► token buyback + burn
               ├── 25% ─► token buyback + burn (immediately)                        └─ 20% ─► $FLOOR buyback + burn
               └── 15% ─► $FLOOR buyback + burn
"Burn only" strategy: 0% trading / 85% token burn / 15% $FLOOR burn
```

## What changed vs. the original (Fill)

| | Fill | Floor |
|---|---|---|
| Creator's own token | bought back only from trading **profit** | **25% of every fee** burns it right away, plus 80% of profit |
| Burn | defaulted to `hold` (tokens kept in the wallet) while the site said "burn" | always burned to `0x…dEaD`, and the burn tx is recorded |
| Accounting | Firestore with read-modify-write races, hard-coded PnL/refund offsets | append-only double-entry ledger in SQLite, idempotent, never negative |
| Reconciliation | none | a worker compares the ledger with on-chain and venue balances, published at `/proof` |
| Tx sending | concurrent workers shared one nonce | one serialized sender per chain, simulate-before-send, local nonce tracking |
| Buyback slippage | fixed 5% floor | quote-derived `amountOutMinimum` (1.5% default); fee-on-transfer tokens handled |
| Venue | Ostium (paused after the July 2026 oracle exploit) + Hyperliquid failover | Hyperliquid HIP-3 `xyz` equity perps; `Venue` port for adding more |
| Tokens on the same stock | clashed on one venue position | pooled per market, with pro-rata shares, attributed PnL and the strictest participant's stop |
| Default risk | Degen, up to 50x, no daily loss limit | Balanced 3–10x; hard caps; daily loss auto kill switch; liquidation buffer |
| Registration | silently "pending", so the token vanished from the dashboard | live verification checklist; auto-activate or visible pending review |
| Creator control | none after launch | the deployer signs a message to change strategy/market/leverage |
| Data | 6 polling loops | one SSE stream with a polling fallback |
| Safety default | live | **paper mode**. Live needs `ENGINE_MODE=live` + key + `LIVE_CONFIRM=real-funds` |

## Repo

```
packages/shared   API contract types, strategies, fee split, markets, sessions, brand
apps/engine       Node 22.18+ TypeScript (native type stripping, no build step)
  src/ports.ts         interfaces to the outside world
  src/integrations/    live Robinhood Chain / Pons / LaunchHood / Uniswap V3 / Hyperliquid / Relay / GeckoTerminal
  src/paper/           simulated write-side (real prices, quotes, metadata)
  src/workers/         claimer, treasury, trader, guardian, buyback, discovery, reconciler
  src/api/             Hono REST + SSE + admin
apps/web          Vite + React 19: landing, launch wizard, app, token pages, leaderboard, proof, docs
```

## Run it

```bash
npm install
# paper engine with 8 synthetic demo tokens + web dev server
DEMO_SEED=1 DB_PATH=:memory: npm run dev          # engine :8787, web :5173
# or single service: build the web app, then the engine serves it
npm run build && DEMO_SEED=1 npm start            # http://localhost:8787
```

Every variable is documented in [`apps/engine/.env.example`](apps/engine/.env.example). Until
`PROTOCOL_ADDRESS` is set, no fee wallet is published: the launch wizard blocks at the "paste the wallet"
step, registration answers `wallet_not_configured`, and discovery is off. Demo tokens still run.

```bash
npm run typecheck && npm test                     # shared + engine suites
npm run check:live -w @floor/engine               # read-only smoke test against the real networks
```

## Deploy (Railway)

One service, built from the root `Dockerfile`: the engine serves the web app on the same origin, with
pre-compressed assets (brotli/gzip), immutable caching for hashed files, a CSP and other security
headers, and absolute social-card URLs for whatever domain it's reached on.

The project is declared in [`.railway/railway.ts`](.railway/railway.ts): the service, the healthcheck
(`/api/health`), one replica (SQLite on the volume), the `/data` volume, and every variable.
`railway config apply` removes variables that aren't in that file, so add new ones there, not with
`railway variable set`. Secrets use `preserve()`.

```bash
railway config plan && railway config apply       # sync settings/variables from .railway/railway.ts
railway up --ci --service floor                   # build + deploy the current directory
```

In Git Bash on Windows, run `railway config` from PowerShell/cmd. The SDK checks the CLI version via
`$_`, which bash sets to its own path.

Current preview: https://floor-production-6aeb.up.railway.app (paper mode, demo tokens, no wallet).

- Publish the fee wallet: uncomment `PROTOCOL_ADDRESS` in `.railway/railway.ts`, then apply.
- Custom domain: `railway domain floor.fun --service floor`, then set `PUBLIC_URL`.
- Take the demo tokens down: set `DEMO_SEED: "0"`. Rows that were already seeded stay until the
  volume is wiped.

## Going live (read first)

1. You hold one hot key that signs on Robinhood Chain, Arbitrum and Hyperliquid. Whoever runs the
   engine has custody of every fee. Say so publicly.
2. Fund it: ETH on Robinhood Chain (gas), ETH on Arbitrum (gas). USDC arrives through the treasury bridge.
3. Set `FLOOR_TOKEN_ADDRESS`, `ADMIN_TOKEN` (≥ 24 chars), a private `ROBINHOOD_RPC_URL` (the public one
   rate-limits `eth_getLogs`), then `ENGINE_MODE=live`, `PROTOCOL_PRIVATE_KEY` and `LIVE_CONFIRM=real-funds`.
4. Start with low caps (`MAX_TOTAL_DEPLOYED_USD`, `MAX_POOL_COLLATERAL_USD`). The write paths (claim,
   swap/burn, Hyperliquid orders, bridge) are only covered by simulation and signing test vectors.
   No funded transaction has been sent yet. Do a small supervised first run.
5. Kill switch: `POST /api/admin/kill-switch {"on":true}` with `Authorization: Bearer $ADMIN_TOKEN`.
   It stops new positions and buybacks; exits keep running.

## Risk

Leveraged perps can be liquidated. The engine runs off-chain and holds the protocol key. Perp venues
have been exploited before (Ostium, July 2026). The code is unaudited. Nothing here is financial advice.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): parts of the engine are derived from FillDotFun/fill (MIT).
