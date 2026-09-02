#!/usr/bin/env bash
# Pull a newer upstream NanoClaw into the subtree, then check the overlay.
#
#   scripts/nanoclaw-sync.sh <commit-or-branch>
#
# Conflicts, if any, are confined to the three barrel lines the overlay adds;
# the overlay's own files are ones upstream never has.
set -euo pipefail
ref="${1:-main}"
cd "$(dirname "$0")/.."
git subtree pull --prefix vendor/nanoclaw https://github.com/nanocoai/nanoclaw.git "$ref" --squash
node scripts/nanoclaw-overlay-check.js
echo "pulled $ref; update vendor/NANOCLAW_UPSTREAM with the new commit and version"
