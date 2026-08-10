# RegReview — the API container.
#
# This process is the only one that holds an Anthropic credential and the only
# one that talks to the databases. The reviewer UI (apps/web) is a separately
# deployed static site (DigitalOcean App Platform) that calls this API
# cross-origin — see REGREVIEW_SITE_ORIGIN in .env.example — so nothing here
# builds or serves it.
#
# Runs on a Droplet, not App Platform: this process needs a persistent local
# disk for uploaded documents (REGREVIEW_UPLOAD_DIR) and holds in-memory
# review-job state, neither of which survive on App Platform's stateless
# Service containers.

# ---------------------------------------------------------------------------
# Build: compile the server.
# ---------------------------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /app

# Install with the lockfile before copying sources so a source-only change does
# not re-resolve the dependency tree. apps/web's package.json is still copied
# in even though this image never builds it — npm workspaces validates the
# lockfile against every workspace member's package.json, so `npm ci` fails
# without it present.
COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/
COPY packages/corpus/package.json    packages/corpus/
COPY packages/eval/package.json      packages/eval/
COPY apps/server/package.json        apps/server/
COPY apps/web/package.json           apps/web/
RUN npm ci

COPY . .

RUN npm run build:core \
 && npx tsc -b apps/server

# ---------------------------------------------------------------------------
# Runtime: production dependencies and build output only.
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/
COPY packages/corpus/package.json    packages/corpus/
COPY packages/eval/package.json      packages/eval/
COPY apps/server/package.json        apps/server/
COPY apps/web/package.json           apps/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/core/dist  packages/core/dist
COPY --from=build /app/apps/server/dist    apps/server/dist
COPY docker-entrypoint.sh                  ./

# The rule corpus (packages/core/src/db/corpusSchema.sql and friends) lives in
# Neon permanently now, not baked into the image — see NEON_DATABASE_URL,
# NEON_CUSTOMER_DATABASE_URL, and NEON_SOPS_DATABASE_URL, which this container
# must be given at runtime (docker run -e / --env-file), never baked in here.
# The server migrates its own schema (idempotent CREATE TABLE IF NOT EXISTS)
# on every boot — see the top of apps/server/src/index.ts — so there is
# nothing left for this image to seed.
#
# Customer documents live on a mounted host directory or Droplet volume, not
# in the image layer — a redeploy must not wipe a reviewer's uploads.
ENV REGREVIEW_UPLOAD_DIR=/data/uploads \
    HOST=0.0.0.0 \
    PORT=8787

EXPOSE 8787

# Drop privileges: this process parses untrusted uploaded files.
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app
USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
