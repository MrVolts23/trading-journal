#!/usr/bin/env node
// Seed Mike's Double BOS into the strategy registry and run the first in-sample /
// out-of-sample backtest split over the MT5 M1 history.
// Usage: node loops/backtest/run_double_bos.js [m1CsvPath]

const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { loadM1, runDoubleBOS, metrics } = require('./engine');

const CSV =
  process.argv[2] ||
  path.join(
    os.homedir(),
    'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/goldbridge/out/gma_history_XAUUSD_M1.csv'
  );
const DB_PATH =
  process.env.TRADING_JOURNAL_DB ||
  path.join(os.homedir(), 'Library/Application Support/mikes-trading-journal/journal.db');

const PARAMS = {
  htf: 15, ltf: 3,
  pivotStrengthHtf: 2, pivotStrengthLtf: 2,
  rr: 2.0, slPaddingUsd: 0.30, maxSlUsd: 12,
  spreadUsd: 0.25, slippageUsd: 0.05, armExpiryHtfBars: 8,
  windows: [{ name: 'asia', start: 15, end: 23 }, { name: 'ny', start: 4, end: 13.5 }],
};

const HYPOTHESIS =
  "Mike's Double BOS: a second consecutive 15-min break of structure in the same direction " +
  'confirms intent; dropping to the 3-min and entering on its next same-direction BOS times ' +
  'the entry with the structure shift. Asia window 3pm-11pm PT, NY window 4am-1:30pm PT.';

const db = new Database(DB_PATH);

// Upsert the strategy (created_by mike, family double_bos)
let strat = db.prepare("SELECT id FROM gma_strategies WHERE name = 'Double BOS v1'").get();
if (!strat) {
  const info = db
    .prepare(`INSERT INTO gma_strategies (name, family, hypothesis, params, lifecycle, created_by, notes)
              VALUES ('Double BOS v1', 'double_bos', ?, ?, 'in_sample', 'mike', ?)`)
    .run(HYPOTHESIS, JSON.stringify(PARAMS),
      'v1 structural assumptions flagged for Mike: pivot strength 2/2, SL behind last opposite 3m swing +$0.30, RR 2.0 fixed, arm expires after 8×15m bars, flat at window end.');
  strat = { id: info.lastInsertRowid };
  console.log(`Registered strategy #${strat.id}: Double BOS v1 (created_by: mike)`);
} else {
  console.log(`Strategy exists (#${strat.id}) — re-running backtests`);
}

const m1 = loadM1(CSV);
const splitIdx = Math.floor(m1.length * 0.7);
const splits = [
  { name: 'in_sample', bars: m1.slice(0, splitIdx) },
  { name: 'out_of_sample', bars: m1.slice(splitIdx) },
  { name: 'full', bars: m1 },
];

const fmtT = (t) => new Date((t - 10 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' PT';

for (const s of splits) {
  const { trades } = runDoubleBOS(s.bars, PARAMS);
  const m = metrics(trades);
  db.prepare(`INSERT INTO gma_backtests (strategy_id, split, period_from, period_to, metrics, trade_log)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(strat.id, s.name, fmtT(s.bars[0].t), fmtT(s.bars[s.bars.length - 1].t),
         JSON.stringify(m), JSON.stringify(trades.slice(0, 300)));
  console.log(`\n[${s.name}] ${fmtT(s.bars[0].t)} → ${fmtT(s.bars[s.bars.length - 1].t)}`);
  console.log(JSON.stringify(m, null, 1));
}
