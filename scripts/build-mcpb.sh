#!/usr/bin/env bash
# Packed in a clean staging dir (prod deps only); must exist before release
# creation since immutable releases reject post-publish asset uploads.
set -euo pipefail

VERSION="${1:?usage: build-mcpb.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/manifest.json" \
   "$ROOT/.mcpbignore" "$ROOT/README.md" "$ROOT/LICENSE" "$STAGE/"
cp -R "$ROOT/dist" "$STAGE/dist"

cd "$STAGE"
# Stamps versions since npm ci requires the lock's root entry to match
# package.json.
VERSION="$VERSION" node -e '
  const fs = require("node:fs");
  const v = process.env.VERSION;
  for (const f of ["manifest.json", "package.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = v;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
  const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  l.version = v;
  if (l.packages && l.packages[""]) l.packages[""].version = v;
  fs.writeFileSync("package-lock.json", JSON.stringify(l) + "\n");
'
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null

"$ROOT/node_modules/.bin/mcpb" pack "$STAGE" "$ROOT/mcp-google-multi.mcpb"
