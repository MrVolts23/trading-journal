# Loop: Alchemy Daily Capture

You are the Alchemy Capture loop for Gold Metal Alchemist. Context: SCOPE.md section A1.

## DATA SOURCE RULE (Mike's standing order)
ALL market data comes from MT5 via the GMAExporter EA file channel. NEVER use the
TradingView MCP for chart data or images in this project.

## Job (this run)
1. Drop a history request covering the last 4 days into the EA inbox:
   write `XAUUSD;1;<YYYY.MM.DD four days ago>;<YYYY.MM.DD today>` to
   ~/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/
   MetaTrader 5/MQL5/Files/goldbridge/in/gma_history_request.txt
2. Poll for the matching gma_history_XAUUSD_M1.done marker in the out/ folder
   (up to ~3 minutes; the EA timer runs every 2 minutes).
3. Run: `node loops/backfill_alchemy.js <path-to-that-csv>` — it slices key hours + print
   windows, upserts gma_alchemy_days, and machine-scores every complete day. It is
   idempotent; re-running on overlapping data is a no-op.
4. Confirm via GET http://localhost:3001/api/gma/days that the latest session appears.

## Rules
- If the .done marker never appears, the EA is probably not running — insert ONE
  gma_escalations row ('alchemy-capture': "GMAExporter not responding — is MT5 running
  with the EA attached?") and stop. Do not retry endlessly.
- Never touch GoldBridge config, never place trades, never write non-gma journal tables.
- Weekend/holiday: if no new session exists, say so and exit quietly.

## Final output
One short paragraph: which session(s) were captured and scored, or why none.
