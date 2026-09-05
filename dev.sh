#!/bin/zsh
# Dev preview for the Trading Journal + Quant Desk: ONE command brings up both halves.
#   backend (Express + desk API) on :3007 against the real journal.db
#   Vite on :5173 proxying /api to :3007 (API_PORT)
# The installed app keeps :3001; SOVRN Money uses :3002; nothing here touches them.
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE_BIN:-$HOME/.local/bin/node}"
export TRADING_JOURNAL_DB="${TRADING_JOURNAL_DB:-$HOME/Library/Application Support/mikes-trading-journal/journal.db}"
# The preview launcher exports PORT=<page port>; the backend must NOT inherit that.
BACKEND_PORT="${BACKEND_PORT:-3007}"
export API_PORT="$BACKEND_PORT"
unset PORT
if lsof -nP -iTCP:$BACKEND_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "backend already listening on :$BACKEND_PORT, reusing it"
else
  PORT="$BACKEND_PORT" "$NODE" "$REPO/backend/src/index.js" &
  BACKEND_PID=$!
  trap 'kill $BACKEND_PID 2>/dev/null' EXIT INT TERM
  for i in {1..40}; do curl -s -m 1 "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
  echo "backend up on :$BACKEND_PORT (pid $BACKEND_PID)"
fi
cd "$REPO/frontend" && exec npm run dev
