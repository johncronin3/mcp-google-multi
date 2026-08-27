#!/bin/sh
# Cloud Run mounts one secret per directory; token-store wants all *.enc in one folder.
set -e
mkdir -p /tmp/google-tokens
for d in /mnt/tok-*; do
  [ -d "$d" ] || continue
  cp -f "$d"/*.enc /tmp/google-tokens/ 2>/dev/null || true
done
export TOKEN_STORE_PATH=/tmp/google-tokens
if [ -z "${GOOGLE_GRANTS_PATH:-}" ] && [ -f /mnt/grants/grants.json ]; then
  export GOOGLE_GRANTS_PATH=/mnt/grants/grants.json
fi
exec node dist/http.js
