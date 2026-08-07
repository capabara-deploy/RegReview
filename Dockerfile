# RegReview — the API container.
#
# This process is the only one that holds an Anthropic credential and the only
# one that talks to the database. The reviewer UI (apps/web) is a separately
# deployed static site (DigitalOcean App Platform) that calls this API
# cross-origin — see REGREVIEW_SITE_ORIGIN in .env.example — so nothing here
# builds or serves it.

# ---------------------------------------------------------------------------
# Build: compile the server and seed the rule corpus.
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

# Seed the corpus into an image-baked database.
#
# The rules come from ingest CLIs that download public FDA data, and a deployed
# instance that starts with an empty rules table fails every review with "no
# rules apply" — which reads like a broken product rather than a missing setup
# step. Baking it here means the download happens once, at build time, where a
# failure is loud and fixable, instead of on a customer's first request.
ENV REGREVIEW_DB=/app/seed/regreview.db
RUN mkdir -p /app/seed \
 && npm run migrate \
 && npm run ingest:observations \
 && npm run ingest:cfr \
 && npm run ingest:rules \
 && npm run corpus:report

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
COPY --from=build /app/seed/regreview.db   seed/regreview.db
COPY docker-entrypoint.sh                  ./

# Customer documents and the findings database live on a mounted volume, not in
# the image layer — a redeploy must not wipe a reviewer's audit trail.
ENV REGREVIEW_DB=/data/regreview.db \
    REGREVIEW_UPLOAD_DIR=/data/uploads \
    HOST=0.0.0.0 \
    PORT=8787

EXPOSE 8787

# Drop privileges: this process parses untrusted uploaded files.
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /data /app
USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
