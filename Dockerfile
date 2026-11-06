# Node 26 (64-bit, Debian bookworm). SQLite comes built into Node (node:sqlite),
# so no native module is compiled and no build toolchain is needed.
FROM node:26-bookworm-slim AS build
WORKDIR /app

# Reproducible install from the lockfile. Install scripts follow the policy in
# package.json ("allowScripts"); no production dependency runs one.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests

# Never ship an image that doesn't type-check or pass its tests.
RUN npm run typecheck \
    && npm test \
    && npm run build \
    && npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# sqlite3 CLI only for inspecting the database from `docker compose exec`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends sqlite3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src/db/migrations ./dist/db/migrations

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
