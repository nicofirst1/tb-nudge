#!/usr/bin/env bash
# Build a versioned, distributable .xpi from the extension source.
# Usage: ./package.sh   ->   dist/tb-nudge-<version>.xpi
#
# An .xpi is just a zip with manifest.json at the ROOT. We exclude dev-only
# files and, importantly, model.json - it encodes personal email vocabulary and
# must never ship. The released add-on falls back to nudging on everything until
# the user trains their own model.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/tb-nudge-${VERSION}.xpi"

echo "Running tests..."
node test.js

echo "Packaging v${VERSION}..."
mkdir -p dist
rm -f "$OUT"
zip -r -FS "$OUT" . \
  -x '.git/*' '.github/*' '.gitignore' 'dist/*' \
     'test.js' 'train.js' 'package.sh' \
     'AGENTS.md' 'HANDOFF-*' 'todo.md' \
     'model.json' '*.xpi' >/dev/null

echo "Wrote $OUT"
