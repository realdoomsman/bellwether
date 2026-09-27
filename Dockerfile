# Single service: builds the web app, then runs the engine, which serves apps/web/dist on the same origin.
#   docker build -t bellwether .
#   docker run -p 8787:8787 -v bellwether-data:/data bellwether
# On Railway, attach a volume at /data (see railway.json / README). No VOLUME instruction: Railway rejects it,
# and the container runs as root because Railway volumes mount root-owned.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/engine/package.json apps/engine/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @bellwether/web && npm prune --omit=dev --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/bellwether.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/web/dist apps/web/dist
COPY apps/engine/package.json apps/engine/
COPY apps/engine/src apps/engine/src
EXPOSE 8787
WORKDIR /app/apps/engine
CMD ["node", "src/main.ts"]
