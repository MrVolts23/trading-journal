#!/usr/bin/env node
// Gold Metal Alchemist — Cake Venture sweep v1 (local, zero tokens).
// Tests candidate PRINT TIMEFRAMES for Venture 1: for every session, aggregate the print
// window (M1 → candidate TF), score the key hour against it under all four orientations,
// and rank timeframes by how well/how often they produce a callable match.
//
// Usage: node loops/sweep/run_sweep.js [m1CsvPath]
// Results land in gma_experiments (leaderboard: GET /api/gma/ventures/1/experiments).

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { scoreOrientations } = require('../../backend/src/services/gmaScoreService');

const CSV =
  process.argv[2] ||
  path.join(
    os.homedir(),
    'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/goldbridge/out/gma_history_XAUUSD_M1.csv'
  );
const DB_PATH =
  process.env.TRADING_JOURNAL_DB ||
  path.join(os.homedir(), 'Library/Application Support/mikes-trading-journal/journal.db');

const PRINT_TFS = [5, 10, 15, 20, 22, 30, 45, 60];
const ABSTAIN = 0.4;

// ── Load + slice sessions (same server-time windows as backfill_alchemy.js) ────
function parse(line) {
  const [ts, o, h, l, c] = line.split(',');
  if (!ts || !o) return null;
  const m = ts.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, hm: m[4] + m[5], o: +o, h: +h, l: +l, c: +c };
}
function shiftDate(d, n) {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function aggClose(bars, minutes) {
  const out = [];
  for (let i = 0; i < bars.length; i += minutes) {
    const chunk = bars.slice(i, i + minutes);
    out.push(chunk[chunk.length - 1].c);
  }
  return out;
}

const lines = fs.readFileSync(CSV, 'utf8').split('\n');
const byDate = {};
for (let i = 1; i < lines.length; i++) {
  const b = parse(lines[i].trim());
  if (b) (byDate[b.date] ||= []).push(b);
}

const sessions = [];
for (const S of Object.keys(byDate).sort()) {
  const key = byDate[S].filter((b) => b.hm >= '0100' && b.hm <= '0159');
  if (key.length < 40) continue;
  const printM1 = byDate[S].filter((b) => b.hm >= '0200')
    .concat((byDate[shiftDate(S, 1)] || []).filter((b) => b.hm < '0001'));
  if (printM1.length < 200) continue;
  sessions.push({ session: shiftDate(S, -1), keyCloses: key.map((b) => b.c), printM1 });
}
console.log(`Sessions in sweep: ${sessions.length}`);

// ── Sweep ──────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
const insert = db.prepare(`
  INSERT INTO gma_experiments (venture_id, params, rationale, expected, result_metrics, score, days_tested, status, ran_at)
  VALUES (1, @params, @rationale, @expected, @results, @score, @days, 'done', datetime('now'))
`);

const RATIONALES = {
  15: 'Baseline: the 15-min chart is what Mike eyeballed the pattern on originally.',
  22: '22-min gives EXACT 1:1 bar mapping (22h print / 60 key bars) — the geometric hypothesis.',
  20: 'Near the 1:1 mapping point; tests sensitivity around 22m.',
};

const leaderboard = [];
for (const tf of PRINT_TFS) {
  let bests = [], codes = { none: 0, flipH: 0, flipV: 0, both: 0, unclear: 0 };
  for (const s of sessions) {
    const printCloses = aggClose(s.printM1, tf);
    if (printCloses.length < 10) continue;
    const r = scoreOrientations(s.keyCloses, printCloses);
    bests.push(r.bestScore);
    codes[r.code]++;
  }
  const mean = bests.reduce((a, b) => a + b, 0) / bests.length;
  const sorted = bests.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const callable = bests.filter((b) => b >= ABSTAIN).length / bests.length;
  const results = {
    mean_best: +mean.toFixed(4),
    median_best: +median.toFixed(4),
    callable_rate: +callable.toFixed(3),
    code_distribution: codes,
  };
  insert.run({
    params: JSON.stringify({ print_tf: `${tf}m`, metric: 'pearson', resampling: 'time_linear', orientations: 4 }),
    rationale: RATIONALES[tf] || `Sweep coverage of the ${tf}-min print hypothesis.`,
    expected: tf === 22 ? 'If fractal expansion is bar-exact, 22m should beat 15m clearly.' : null,
    results: JSON.stringify(results),
    score: results.mean_best,
    days: bests.length,
  });
  leaderboard.push({ tf, ...results });
}

leaderboard.sort((a, b) => b.mean_best - a.mean_best);
console.log('\n=== CAKE LEADERBOARD — Venture 1, sweep v1 (pearson) ===');
for (const r of leaderboard) {
  console.log(
    `${String(r.tf).padStart(2)}m  mean ${r.mean_best.toFixed(3)}  median ${r.median_best.toFixed(3)}  callable ${(r.callable_rate * 100).toFixed(0)}%`
  );
}
console.log('\n(Full metrics incl. orientation distribution in gma_experiments / Loop Console.)');
