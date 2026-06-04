#!/usr/bin/env bash
# Ship a change end-to-end: bump version → commit → push → build → publish GitHub release.
# The installed Trading Journal app auto-updates from the published release.
#
# Usage:
#   ./release.sh "commit message"            # patch bump (1.0.11 -> 1.0.12)
#   ./release.sh "commit message" minor      # minor bump (1.0.11 -> 1.1.0)
#   ./release.sh "commit message" major      # major bump (1.0.11 -> 2.0.0)
set -euo pipefail
cd "$(dirname "$0")"

MSG="${1:?Usage: ./release.sh \"commit message\" [patch|minor|major]}"
LEVEL="${2:-patch}"

# Auth for electron-builder's GitHub publish (never written to disk).
export GH_TOKEN="$(gh auth token)"

echo "==> Bumping version ($LEVEL)…"
NEW_VERSION="$(npm version "$LEVEL" --no-git-tag-version | tr -d 'v')"
echo "    -> v$NEW_VERSION"

echo "==> Committing + pushing…"
git add -A
git commit -m "$MSG (v$NEW_VERSION)"
git push origin main

echo "==> Building + publishing release to GitHub…"
npm run electron:publish

echo "==> Done. v$NEW_VERSION is live — the app will auto-update on next launch."
