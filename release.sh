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

# Sign with the Developer ID cert (distribution-grade, in the login keychain since Mike's
# Apple Developer enrolment). Pinned so electron-builder never picks a different identity —
# a signing-identity change re-triggers the app's one-time keychain prompt.
export CSC_NAME="Developer ID Application: Michael A Volts (TKL27C5YHV)"

echo "==> Bumping version ($LEVEL)…"
NEW_VERSION="$(npm version "$LEVEL" --no-git-tag-version | tr -d 'v')"
echo "    -> v$NEW_VERSION"

echo "==> Committing + pushing…"
git add -A
git commit -m "$MSG (v$NEW_VERSION)"
git push origin main

# CRITICAL: the backend's native better-sqlite3 must be compiled for ELECTRON's ABI,
# not system Node. If it's built for Node (e.g. after a dev `npm rebuild`), the packaged
# app can't open the database ("NODE_MODULE_VERSION 137 … requires 121"). electron-builder's
# npmRebuild only covers ROOT deps, not backend/, so we rebuild it from source here.
echo "==> Rebuilding backend better-sqlite3 for Electron…"
ELECTRON_VER="$(node -p "require('./node_modules/electron/package.json').version")"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
( cd backend/node_modules/better-sqlite3 \
  && npx node-gyp rebuild --target="$ELECTRON_VER" --arch="$ARCH" --dist-url=https://electronjs.org/headers --runtime=electron )
# Verify the binary is the Electron ABI (must FAIL to load in system Node) before shipping.
if node -e "process.dlopen({exports:{}},'./backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node')" 2>/dev/null; then
  echo "ERROR: backend better-sqlite3 is built for system Node, not Electron — aborting to avoid shipping a broken DB engine." >&2
  exit 1
fi
echo "    backend native module is Electron-ABI ✓"

echo "==> Building + publishing release to GitHub…"
npm run electron:publish

# Safety net: electron-builder can still create the GitHub release as a DRAFT,
# which electron-updater cannot see. Force it published so the app detects it.
echo "==> Ensuring v$NEW_VERSION is published (not a draft)…"
gh release edit "v$NEW_VERSION" --draft=false 2>/dev/null && echo "    published" || echo "    (already published)"

echo "==> Done. v$NEW_VERSION is live — the app will auto-update on next launch."
