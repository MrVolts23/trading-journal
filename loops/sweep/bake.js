#!/usr/bin/env node
// Gold Metal Alchemist — the overnight BAKER (mechanical, zero tokens).
// Executes every gma_experiments row with status='planned' whose params carry an
// executable spec ({engine:'double_bos', overrides:{...}}), on full + out-of-sample splits,
// and writes results back. Scheduled nightly via launchd (com.gma.bake) — pure local math.
//
// Usage: node loops/sweep/bake.js [m1CsvPath]

const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { loadM1, runDoubleBOS, metrics } = require('../backtest/engine');

const argCsv = process.argv[2] && process.argv[2].endsWith('.csv') ? process.argv[2] : null;
const CSV =
  argCsv ||
  path.join(
    os.homedir(),
    'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/goldbridge/out/gma_history_XAUUSD_M1.csv'
  );
const DB_PATH =
  process.env.TRADING_JOURNAL_DB ||
  path.join(os.homedir(), 'Library/Application Support/mikes-trading-journal/journal.db');

const CHAMPION = {
  pivotStrengthLtf: 1, armMode: 'either', maxEntriesPerArm: 3,
  exitModel: 'liquidity_v1', trailPadUsd: 0.30,
};

const db = new Database(DB_PATH);
const planned = db
  .prepare(`SELECT id, params FROM gma_experiments WHERE status = 'planned' ORDER BY id`)
  .all()
  .map((r) => ({ id: r.id, params: JSON.parse(r.params) }))
  .filter((r) => r.params.engine === 'double_bos');

if (!planned.length) {
  console.log('Bake: nothing planned. (Planner seeds the queue; see The Lab page.)');
  process.exit(0);
}

console.log(`Bake: ${planned.length} planned experiments. Loading data…`);
const m1 = loadM1(CSV);
const splitIdx = Math.floor(m1.length * 0.7);
const oosBars = m1.slice(splitIdx);

const save = db.prepare(
  `UPDATE gma_experiments SET result_metrics = ?, score = ?, days_tested = ?, status = 'done', ran_at = datetime('now') WHERE id = ?`
);

let done = 0;
for (const exp of planned) {
  try {
    const params = { ...CHAMPION, ...exp.params.overrides };
    const full = metrics(runDoubleBOS(m1, params).trades);
    const oos = metrics(runDoubleBOS(oosBars, params).trades);
    const result = {
      full: { trades: full.trades, net_r: full.net_r, pf: full.profit_factor, dd: full.max_dd_r, win: full.winrate, by_session: full.by_session },
      oos: { trades: oos.trades, net_r: oos.net_r, pf: oos.profit_factor, dd: oos.max_dd_r },
      data_span: '2026-03-23→2026-07-03 (rebakes automatically as history deepens)',
    };
    save.run(JSON.stringify(result), full.net_r ?? 0, full.trades ?? 0, exp.id);
    done++;
  } catch (e) {
    db.prepare(`UPDATE gma_experiments SET status = 'failed', result_metrics = ? WHERE id = ?`)
      .run(JSON.stringify({ error: e.message }), exp.id);
  }
}
console.log(`Bake complete: ${done}/${planned.length} experiments done.`);
