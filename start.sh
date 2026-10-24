#!/bin/bash
# Mike's Trading Journal — Start both servers
# Usage: ./start.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Data lives in a sibling folder next to the app folder — survives app updates.
# Layout:  (parent)/
#            trading-journal/        ← app (this folder, gets replaced on updates)
#            trading-journal-data/   ← data (never touched on updates)
#              journal.db
DATA_DIR="$(dirname "$ROOT")/trading-journal-data"
mkdir -p "$DATA_DIR"
export TRADING_JOURNAL_DB="$DATA_DIR/journal.db"

echo "🚀 Starting Trading Journal..."
echo ""
echo "   Database → $TRADING_JOURNAL_DB"
echo ""

# Start backend
echo "▶ Starting backend (port 3001)..."
cd "$ROOT/backend" && node src/index.js &
BACKEND_PID=$!

# Wait for backend to be ready
sleep 2

# Start frontend
echo "▶ Starting frontend (port 5173)..."
cd "$ROOT/frontend" && npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ Trading Journal running:"
echo "   Frontend → http://localhost:5173"
echo "   Backend  → http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop both servers."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo 'Stopped.'" EXIT
wait
