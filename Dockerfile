FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json db.sql ./
COPY src/ ./src/

RUN npm run build
# NOTE: the genesis seed bake was RETIRED in June 2026. The live /data/adai.db
# (continuously replicated to R2 by Litestream) is the ONLY source of truth —
# there is no reseed-from-JSON step and the image ships no seed.db. A fresh host
# recovers the live DB from the Litestream replica (see entrypoint.sh). The old
# seed/*.json canon + offline pipeline were removed June 2026 (in git history).

# --- runtime image ---
FROM node:22-slim

WORKDIR /app

# Production mode: enables the immutable long-cache for `?v=`-busted static
# assets (src/index.ts ASSET_CACHE_CONTROL) and Express's prod defaults. Dev
# (npm run dev) leaves NODE_ENV unset → no-cache, so edits are picked up live.
ENV NODE_ENV=production

# curl + ca-certificates at runtime: curl for entrypoint/health warm-ups,
# ca-certificates for Litestream's HTTPS connection to R2.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Litestream — continuous WAL replication of /data/adai.db to Cloudflare R2.
# Single static binary. ca-certificates (installed above) is required at runtime
# for the HTTPS connection to R2. See litestream.yml + entrypoint.sh for wiring.
ARG LITESTREAM_VERSION=0.3.13
RUN curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" -o /tmp/litestream.tar.gz \
  && tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz litestream \
  && rm /tmp/litestream.tar.gz

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY db.sql entrypoint.sh SKILL.md LICENSE-DATA ./
COPY litestream.yml /etc/litestream.yml
COPY --from=builder /app/dist ./dist
# No seed.db is shipped — the runtime DB is the live /data volume restored from
# the Litestream R2 replica on a fresh host (genesis bake retired June 2026).
COPY public ./public

# Pre-compress static JS/CSS/SVG into .br/.gz siblings so the server ships them
# with zero per-request CPU (src/index.ts negotiates Content-Encoding). Stdlib
# (node:zlib) only — no extra dependency or binary in the runtime image.
COPY scripts/precompress.mjs ./scripts/precompress.mjs
RUN node scripts/precompress.mjs public/field

VOLUME ["/data"]

EXPOSE 8080

RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
