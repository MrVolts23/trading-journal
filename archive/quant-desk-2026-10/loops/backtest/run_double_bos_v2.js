#!/usr/bin/env node
// Double BOS v2 — encodes Mike's Jul-2 playbook teaching:
//   1. liquidity run between the two 15m BOS is REQUIRED (break → sweep → break)
//   2. arm stays hot for up to 3 sequential 3m entries
//   3. tighter 3m swings (pivot strength 1)
//   4. exit = structure trail behind confirmed 3m swings (lets 5-8R runners run)
// Also prints an ablation grid so we can see what each change contributes.
// Usage: node loops/backtest/run_double_bos_v2.js [m1CsvPath]

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

const V2 = {
  htf: 15, ltf: 3,
  pivotStrengthHtf: 2, pivotStrengthLtf: 1,
  requireSweep: true,
  maxEntriesPerArm: 3,
  exitModel: 'trail_ltf', trailPadUsd: 0.30,
  slPaddingUsd: 0.30, maxSlUsd: 12,
  spreadUsd: 0.25, slippageUsd: 0.05, armExpiryHtfBars: 8,
  windows: [{ name: 'asia', start: 15, end: 23 }, { name: 'ny', start: 4, end: 13.5 }],
};

const HYPOTHESIS =
  'v2 from Mike\'s Jul-2 playbook example: first 15m BOS, then a liquidity run through the ' +
  'prior swing, then the second 15m BOS = armed. Drop to 3m, take up to three BOS entries ' +
  '("here or somewhere after"). Exit by trailing behind confirmed 3m structure — Mike took ' +
  '1:8, 1:5, 1:8 on this pattern. Sessions: Asia 3-11pm PT, NY 4am-1:30pm PT.';

const db = new Database(DB_PATH);
let strat = db.prepare("SELECT id FROM gma_strategies WHERE name = 'Double BOS v2'").get();
if (!strat) {
  const info = db.prepare(
    `INSERT INTO gma_strategies (name, family, hypothesis, params, lifecycle, parent_id, created_by, notes)
     VALUES ('Double BOS v2', 'double_bos', ?, ?, 'in_sample', 1, 'mike', ?)`
  ).run(HYPOTHESIS, JSON.stringify(V2),
    'Encoded from playbook ex#1 + Mike: sweep-required, 3 entries/arm, ltf pivot 1, structure-trail exit. Still open: his real exit logic (trail is a proxy), blue MA filter?, close-vs-wick BOS, skip-filters.');
  strat = { id: info.lastInsertRowid };
  console.log(`Registered strategy #${strat.id}: Double BOS v2 (parent: #1)`);
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
  const { trades } = runDoubleBOS(s.bars, V2);
  const m = metrics(trades);
  db.prepare(`INSERT INTO gma_backtests (strategy_id, split, period_from, period_to, metrics, trade_log)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(strat.id, s.name, fmtT(s.bars[0].t), fmtT(s.bars[s.bars.length - 1].t),
         JSON.stringify(m), JSON.stringify(trades.slice(0, 300)));
  console.log(`\n[v2 ${s.name}]`, JSON.stringify(m));
}

// Ablation grid (full period, not stored): what does each teaching contribute?
console.log('\n=== ABLATION (full period) ===');
const variants = [
  ['v1 baseline (fixed 2R, no sweep, 1 entry)', { }],
  ['+ sweep required',                          { requireSweep: true }],
  ['+ 3 entries/arm',                           { requireSweep: true, maxEntriesPerArm: 3 }],
  ['+ ltf pivots 1',                            { requireSweep: true, maxEntriesPerArm: 3, pivotStrengthLtf: 1 }],
  ['+ trail exit (= v2)',                       { requireSweep: true, maxEntriesPerArm: 3, pivotStrengthLtf: 1, exitModel: 'trail_ltf' }],
];
for (const [label, over] of variants) {
  const { trades } = runDoubleBOS(m1, { ...V2, requireSweep: false, maxEntriesPerArm: 1, pivotStrengthLtf: 2, exitModel: 'fixed_rr', ...over });
  const m = metrics(trades);
  console.log(
    `${label.padEnd(45)} trades ${String(m.trades).padStart(3)}  win ${m.trades ? (m.winrate * 100).toFixed(0) : '--'}%  net ${m.net_r >= 0 ? '+' : ''}${m.net_r}R  pf ${m.profit_factor ?? '--'}  dd ${m.max_dd_r}R  asia ${m.by_session?.asia?.netR ?? 0}R  ny ${m.by_session?.ny?.netR ?? 0}R`
  );
}
