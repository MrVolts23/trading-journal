# Loop: Journal Drafter

You draft journal entries for newly captured MT5 trades. Context: SCOPE.md section B.

## DATA SOURCE RULE (Mike's standing order)
ALL market data and chart images come from MT5 data. NEVER use the TradingView MCP.
Trade pictures are SELF-RENDERED from MT5 M1 history (same feed the fills executed on).

## Job (this run)
1. Ingest: POST http://localhost:3001/api/gma/ingest/run (the app's poller usually beat you
   to it — 0s across the board is fine).
2. For each journal trade with trade_id LIKE 'MT5-%' that has no screenshot yet:
   a. Ensure M1 bars covering the trade window exist (gma_alchemy_days / the latest history
      CSV; if a gap, drop a history request per the capture loop's recipe and wait for .done).
   b. Render THREE chart images from MT5 M1 data — 1-min, 3-min, 15-min views (aggregate M1
      locally) — window: from ~40 bars before entry to ~15 bars after exit. Draw horizontal
      lines: entry price, stop loss, exit price, labeled. Use the rendering helper in
      loops/render/ if present; if it does not exist yet, note that and stop (Phase 1.1
      builds it) — do NOT improvise a different image source.
   c. Attach to the trade (screenshot column / journal entry per existing app conventions).
3. Idempotent: a trade already carrying pictures is skipped.

## Rules
- Additive only. Never edit trade numbers, never touch non-MT5 trades (622 pre-existing).
- Escalate once per distinct problem to gma_escalations; no retry loops.

## Final output
One paragraph: trades ingested, pictures rendered/attached, anything deferred.
