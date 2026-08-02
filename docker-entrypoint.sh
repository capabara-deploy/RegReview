#!/bin/sh
set -e

# Seed the corpus onto the volume the first time this instance boots.
#
# The image ships a database containing the rule corpus and the FDA citation
# data behind severity. The volume holds everything the customer creates —
# documents, runs, findings, the reviewer audit trail — so it must never be
# overwritten by a redeploy. Copy only when there is nothing there.
if [ ! -f "$REGREVIEW_DB" ]; then
  echo "First boot: seeding rule corpus to $REGREVIEW_DB"
  mkdir -p "$(dirname "$REGREVIEW_DB")"
  cp /app/seed/regreview.db "$REGREVIEW_DB"
else
  echo "Existing database at $REGREVIEW_DB — leaving it alone."
fi

mkdir -p "$REGREVIEW_UPLOAD_DIR"

exec node apps/server/dist/index.js
