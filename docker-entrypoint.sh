#!/bin/sh
set -e

# Nothing to seed: the rule corpus lives in Neon permanently, and the server
# migrates its own schema (idempotent) on every boot. This directory only
# holds uploaded document bytes, which must survive a redeploy — that's the
# host/volume mount's job, not this script's.
mkdir -p "$REGREVIEW_UPLOAD_DIR"

exec node apps/server/dist/index.js
