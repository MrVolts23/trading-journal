#!/usr/bin/env node
// Quant Desk — one-shot, idempotent import of the July-2026 GMA research into desk.db.
//
//   1. Copies the goldbridge/out M1 csv to desk/data/XAUUSD_M1.csv if absent (the ONLY place in
//      desk/ allowed to read that file) and writes data_manifest {burned:1}.
//   2. Imports gma_strategies #1-3 → strategies (params_resolved = engine DEFAULTS + params).
//   3. Imports every gma_experiments row with params.engine === 'double_bos' → experiments
//      (status 'done', params_delta = overrides, params_resolved = DEFAULTS + CHAMPION + overrides)
//      with the recorded result_metrics stored as a backtests row, split 'full'.
//   4. Seeds research_ledger (double_bos, XAUUSD) at a floor of 100 trials.
//   5. Inserts the default risk profile as active if none exists (getDb() does this).
//
// journal.db is opened READ-ONLY. All writes go to desk.db under ~/Library/Application Support/quant-desk/.
// Usage: node desk/scripts/import_gma.js   (or npm run import, from desk/)

const fs = require('fs');
const path = require('path');
const paths = require('../src/paths');
const desk = require('../src/db');

// The July champion (loops/sweep/bake.js CHAMPION) — the base every recorded experiment ran on.
const CHAMPION = {
  pivotStrengthLtf: 1, armMode: 'either', maxEntriesPerArm: 3,
  exitModel: 'liquidity_v1', trailPadUsd: 0.30,
};
const SOURCE = 'journal-gma-2026-07';

// research_ledger floor. The journal only records the 39 double_bos experiments the planner
// wrote down, but the July champion was chosen after many more unrecorded variants were run
// by hand and by loops/sweep (exit-model sweeps, trail-pad grids, session splits, pivot
// strengths, pyramiding gates). 100 is a Mike-UNCONFIRMED conservative floor so the
// trial-penalized bootstrap threshold and the deflated-Sharpe benchmark start honest rather
// than at 39. Mike can raise it; it never decreases on re-import.
const LEDGER_FLOOR = 100;

// ── Engine defaults (defensive: owner A writes desk/engine/engine.js in parallel) ─────────
function loadEngine() {
  const candidates = [
    path.join(paths.ENGINE_DIR, 'engine.js'),
    path.join(paths.DESK_ROOT, '../loops/backtest/engine.js'), // verbatim ancestor: same defaults
  ];
  for (const c of candidates) {
    try { return { engine: require(c), from: c }; } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  return { engine: null, from: null };
}
function engineDefaults() {
  const { engine } = loadEngine();
  if (engine && engine.DEFAULTS) return { ...engine.DEFAULTS };
  // Fallback: the engine resolves its defaults inside runDoubleBOS; running it on zero bars is a
  // pure no-op that returns { params: P } with every default filled in.
  if (engine && engine.runDoubleBOS) {
    try { return { ...engine.runDoubleBOS([], {}).params }; } catch (_) { /* fall through */ }
  }
  // TODO(owner A): desk/engine/engine.js missing — hardcoded copy of loops/backtest/engine.js defaults.
  return {
    htf: 15, ltf: 3, pivotStrengthHtf: 2, pivotStrengthLtf: 2, rr: 2.0, exitModel: 'fixed_rr',
    trailPadUsd: 0.30, requireSweep: false, maxEntriesPerArm: 1, slPaddingUsd: 0.30, maxSlUsd: 12,
    spreadUsd: 0.25, slippageUsd: 0.05, armExpiryHtfBars: 8,
    windows: [{ name: 'asia', start: 15, end: 23 }, { name: 'ny', start: 4, end: 13.5 }],
  };
}

// ── Step 1: research data ──────────────────────────────────────────────────────────────
function csvSpan(csvPath) {
  // Cheap scan: first and last data rows + count. Timestamps are 'YYYY.MM.DD HH:MM:SS' server time.
  const txt = fs.readFileSync(csvPath, 'utf8');
  const lines = txt.split('\n');
  let first = null, last = null, bars = 0;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const m = l.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/);
    if (!m) continue;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
    if (first == null) first = t;
    last = t; bars++;
  }
  return { from_t: first, to_t: last, bars };
}

function ensureData(db, log) {
  if (!fs.existsSync(paths.DATA_CSV) && paths.LEGACY_DATA_CSV && fs.existsSync(paths.LEGACY_DATA_CSV)) {
    // Pre-2026-09-05 layout kept the csv inside the repo; move it to the user data folder once.
    fs.mkdirSync(path.dirname(paths.DATA_CSV), { recursive: true });
    fs.copyFileSync(paths.LEGACY_DATA_CSV, paths.DATA_CSV);
    log(`copied bar data from the repo to ${paths.DATA_CSV}`);
  }
  if (!fs.existsSync(paths.DATA_CSV)) {
    if (!fs.existsSync(paths.GMA_OUT_CSV)) {
      log(`data: neither ${paths.DATA_CSV} nor the goldbridge/out csv exists — skipping data step`);
      return null;
    }
    fs.mkdirSync(path.dirname(paths.DATA_CSV), { recursive: true });
    fs.copyFileSync(paths.GMA_OUT_CSV, paths.DATA_CSV);
    log(`data: copied goldbridge/out csv → ${paths.DATA_CSV}`);
  } else {
    log(`data: ${paths.DATA_CSV} present (not re-copied)`);
  }
  const span = csvSpan(paths.DATA_CSV);
  const sha = desk.fileSha256(paths.DATA_CSV);
  db.prepare(
    `INSERT INTO data_manifest (symbol, tf, from_t, to_t, bars, sha256, burned, note)
     VALUES ('XAUUSD', 'M1', ?, ?, ?, ?, 1, ?)
     ON CONFLICT(symbol, tf) DO UPDATE SET from_t = excluded.from_t, to_t = excluded.to_t, bars = excluded.bars,
       sha256 = excluded.sha256, burned = 1, note = excluded.note, updated_at = datetime('now')`
  ).run(span.from_t, span.to_t, span.bars, sha, 'consulted during July champion selection; no lockbox on this data');
  log(`data: manifest XAUUSD M1 bars=${span.bars} burned=1 sha=${sha.slice(0, 12)}…`);
  return span;
}

// ── Step 2/3: strategies + experiments ──────────────────────────────────────────────────
function importStrategies(db, jdb, DEFAULTS, log) {
  const rows = jdb.prepare(`SELECT * FROM gma_strategies WHERE id IN (1,2,3) ORDER BY id`).all();
  const ins = db.prepare(
    `INSERT OR IGNORE INTO strategies (name, family, symbol, parent_id, version, params_resolved, params_sha,
       rule_sheet_text, lifecycle, source, source_ref, created_at)
     VALUES (?, ?, 'XAUUSD', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const idMap = new Map(); // journal id → desk id
  let added = 0, reresolved = 0;
  for (const r of rows) {
    let params = {};
    try { params = JSON.parse(r.params || '{}'); } catch (_) { /* keep empty */ }
    const resolved = { ...DEFAULTS, ...params };
    const ref = `gma_strategies:${r.id}`;
    const parentDeskId = r.parent_id ? idMap.get(r.parent_id) || null : null;
    const info = ins.run(r.name, r.family || 'double_bos', parentDeskId, r.id, JSON.stringify(resolved),
      desk.paramsSha(resolved), r.notes || null, r.lifecycle || 'in_sample', SOURCE, ref, r.created_at || null);
    if (info.changes) added++;
    const existing = db.prepare(`SELECT id, params_sha FROM strategies WHERE source_ref = ?`).get(ref);
    if (!info.changes && existing.params_sha !== desk.paramsSha(resolved)) {
      // Row was imported before desk/engine existed (15-key fallback defaults); re-resolve against the
      // full engine DEFAULTS so params_resolved carries every schema key. Behaviour-neutral for the engine.
      db.prepare(`UPDATE strategies SET params_resolved = ?, params_sha = ? WHERE id = ?`)
        .run(JSON.stringify(resolved), desk.paramsSha(resolved), existing.id);
      reresolved++;
    }
    idMap.set(r.id, existing.id);
  }
  log(`strategies: ${rows.length} found in journal, ${added} inserted (${rows.length - added} already present, ${reresolved} re-resolved)`);
  return idMap;
}

function importExperiments(db, jdb, DEFAULTS, strategyIdMap, log) {
  const rows = jdb.prepare(`SELECT * FROM gma_experiments ORDER BY id`).all()
    .map((r) => { let p = {}; try { p = JSON.parse(r.params || '{}'); } catch (_) {} return { ...r, p }; })
    .filter((r) => r.p && r.p.engine === 'double_bos');
  // Every recorded double_bos experiment ran on the champion base, which descends from the
  // approved v2.1 rule sheet (journal strategy #3). Link them there; fall back to the first strategy.
  const baseStrategyId = strategyIdMap.get(3) || strategyIdMap.get(2) || strategyIdMap.get(1)
    || db.prepare(`SELECT id FROM strategies ORDER BY id LIMIT 1`).get()?.id;
  if (!baseStrategyId) throw new Error('no strategies to attach imported experiments to');

  const insExp = db.prepare(
    `INSERT OR IGNORE INTO experiments (strategy_id, symbol, hypothesis, params_delta, params_resolved, params_sha,
       planned_by, status, source, source_ref, created_at, ran_at)
     VALUES (?, 'XAUUSD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insBt = db.prepare(
    `INSERT INTO backtests (experiment_id, split, from_t, to_t, warmup_bars, metrics, periods_week, periods_month, trades)
     VALUES (?, 'full', NULL, NULL, 0, ?, NULL, NULL, NULL)`
  );
  let added = 0, reresolved = 0;
  const selExp = db.prepare(`SELECT id, params_sha FROM experiments WHERE source_ref = ?`);
  const updExp = db.prepare(`UPDATE experiments SET params_resolved = ?, params_sha = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      const overrides = r.p.overrides || {};
      const resolved = { ...DEFAULTS, ...CHAMPION, ...overrides };
      const ref = `gma_experiments:${r.id}`;
      const hypothesis = [r.rationale, r.expected ? `Expected: ${r.expected}` : null].filter(Boolean).join('\n');
      const labels = [r.p.entry_label, r.p.exit_label].filter(Boolean).join(' × ');
      const info = insExp.run(
        baseStrategyId, hypothesis || `journal experiment ${r.id}`, JSON.stringify(overrides),
        JSON.stringify(resolved), desk.paramsSha(resolved), 'loop-planner',
        r.status === 'done' ? 'done' : (r.status || 'done'), SOURCE, ref, r.planned_at || null, r.ran_at || null
      );
      if (!info.changes) {
        // Already imported (possibly before desk/engine existed → stale 15-key resolution): refresh
        // params_resolved/params_sha to the full DEFAULTS+CHAMPION+overrides. Engine behaviour is identical.
        const ex = selExp.get(ref);
        const sha = desk.paramsSha(resolved);
        if (ex && ex.params_sha !== sha) { updExp.run(JSON.stringify(resolved), sha, ex.id); reresolved++; }
        continue;
      }
      added++;
      const expId = info.lastInsertRowid;
      let recorded = null;
      try { recorded = r.result_metrics ? JSON.parse(r.result_metrics) : null; } catch (_) { recorded = { raw: r.result_metrics }; }
      if (recorded) {
        // Metrics JSON as recorded by loops/sweep/bake.js ({full:{trades,net_r,pf,dd,win,by_session}, oos:{…}}),
        // plus the flat research-shaped keys the leaderboard reads, derived from `full`.
        const f = recorded.full || {};
        const metrics = {
          ...recorded,
          trades: f.trades ?? r.days_tested ?? null,
          net_r: f.net_r ?? r.score ?? null,
          profit_factor: f.pf ?? null,
          max_dd_r: f.dd ?? null,
          winrate: f.win ?? null,
          by_session: f.by_session || null,
          labels: labels || null,
          journal_score: r.score,
          imported_from: ref,
          note: 'as recorded by loops/sweep/bake.js in July 2026 (no rails, no sizing); re-bake for desk metrics',
        };
        insBt.run(expId, JSON.stringify(metrics));
      }
    }
  });
  tx();
  log(`experiments: ${rows.length} double_bos rows in journal, ${added} inserted (${rows.length - added} already present, ${reresolved} re-resolved)`);
  return added;
}

function seedLedger(db, log) {
  const cur = desk.getTrials(db, 'double_bos', 'XAUUSD');
  if (cur >= LEDGER_FLOOR) { log(`ledger: double_bos/XAUUSD n_trials=${cur} (floor ${LEDGER_FLOOR} already met)`); return cur; }
  db.prepare(
    `INSERT INTO research_ledger (family, symbol, n_trials, note) VALUES ('double_bos', 'XAUUSD', ?, ?)
     ON CONFLICT(family, symbol) DO UPDATE SET n_trials = excluded.n_trials, note = excluded.note, updated_at = datetime('now')`
  ).run(LEDGER_FLOOR, `floor ${LEDGER_FLOOR}: Mike-unconfirmed; journal records 39 double_bos experiments but the July champion selection also consulted unrecorded sweep variants`);
  log(`ledger: double_bos/XAUUSD n_trials set to floor ${LEDGER_FLOOR} (was ${cur})`);
  return LEDGER_FLOOR;
}

function importGma({ log = console.log } = {}) {
  const db = desk.getDb(); // also ensures the default risk profile exists (step 5)
  const span = ensureData(db, log);
  const jdb = desk.openJournalReadOnly();
  if (!jdb) {
    log(`journal: ${paths.JOURNAL_DB} not found — skipping strategy/experiment import`);
  }
  const DEFAULTS = engineDefaults();
  let strategies = 0, experiments = 0;
  if (jdb) {
    try {
      const map = importStrategies(db, jdb, DEFAULTS, log);
      strategies = map.size;
      experiments = importExperiments(db, jdb, DEFAULTS, map, log);
    } finally { jdb.close(); }
  }
  const trials = seedLedger(db, log);
  const profile = desk.getActiveProfile(db);
  log(`profile: active #${profile.id} "${profile.name}" (max_daily_loss_r=${profile.fields.max_daily_loss_r})`);
  return { data: span, strategies, experiments_added: experiments, n_trials: trials, profile_id: profile.id };
}

module.exports = { importGma, CHAMPION, SOURCE, LEDGER_FLOOR, engineDefaults };

if (require.main === module) {
  try {
    const r = importGma();
    console.log('import complete:', JSON.stringify(r));
  } catch (e) {
    console.error('import failed:', e.message);
    process.exit(1);
  }
}
