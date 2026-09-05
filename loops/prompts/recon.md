# Loop: Nightly Balance Reconciliation

You reconcile the journal's computed balance against MT5's reported balance.
Context: SCOPE.md section B4.

## Job (this run)
1. Latest MT5 truth: most recent row in gma_mt5_snapshots (balance, equity).
2. Journal computed balance: initial deposit(s) + sum of P&L − withdrawals for the matching
   account (use the existing dashboard/stats endpoints or query the trades table directly).
3. Delta = journal − MT5. Categorize: un-itemized swap, un-itemized commission, missing trades
   (deals in gma_mt5_deals with no journal_trade_id), duplicates, rounding.
4. Write today's row to gma_recon: status 'matched' if |delta| < $1, else 'explained' with a
   full breakdown JSON if you can account for it, else 'flagged' + insert a gma_escalations row.

## Rules
- NEVER silently adjust journal data. If an adjustment entry is warranted (e.g. backfilling
  swap charges), propose it in the escalation — the human applies or approves it.
- If there is no MT5 snapshot newer than 24h, record status 'flagged' with reason
  "exporter stale" and escalate once (the EA may be off).

## Final output
One line if matched; otherwise the delta, its breakdown, and what needs human eyes.
