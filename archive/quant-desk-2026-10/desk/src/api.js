// Quant Desk — HTTP API (express.Router). Mounted by the backend at /api/desk (backend/src/routes/desk.js).
// Demo-only: nothing here places, sizes-for-live, or talks to a broker. The only model calls are the
// chat routes at the bottom, and those only ever PROPOSE: a test runs when Mike taps Apply.
const express = require('express');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const desk = require('./db');
const bench = require('./bench');
const edge = require('./edge');
const reasons = require('./reasons');
const activity = require('./activity');
const chat = require('./chat');
const keychain = require('./model/keychain');

const router = express.Router();
router.use(express.json({ limit: '5mb' }));

const FAMILY = 'double_bos';
const SYMBOL = 'XAUUSD';
const RISK_PCT_HARD_MAX = 3.0;

// ── Param schema (desk/engine/schema.json, owner A) ───────────────────────────────────
function loadSchema() {
  try {
    const eng = bench.loadEngine();
    if (eng && eng.PARAM_SCHEMA) return eng.PARAM_SCHEMA;
  } catch (_) { /* fall through */ }
  try { return JSON.parse(fs.readFileSync(paths.ENGINE_SCHEMA_JSON, 'utf8')); } catch (_) { return null; }
}
function schemaEntries(schema) {
  // Accept { name: {type,...} } (owner A's shape) or { params: { name: {...} } }
  if (!schema) return null;
  const src = schema.params && typeof schema.params === 'object' && !schema.params.type ? schema.params : schema;
  return src;
}

function validateDelta(delta, schema) {
  const errors = [];
  const entries = schemaEntries(schema);
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return ['params_delta must be an object'];
  for (const [k, v] of Object.entries(delta)) {
    if (k === 'entryGate' || k === 'countFrom') { errors.push(`${k} is not a user parameter`); continue; }
    if (!entries) continue; // TODO(owner A): schema.json missing — accepting keys unvalidated
    const def = entries[k];
    if (!def) { errors.push(`unknown param "${k}"`); continue; }
    const type = def.type;
    if (type === 'json' || type === 'array' || type === 'object') continue; // windows etc. — trusted structure
    if (type === 'boolean') { if (typeof v !== 'boolean') errors.push(`${k} must be boolean`); continue; }
    if (type === 'string' || type === 'enum' || type === 'choice') {
      if (def.choices && !def.choices.includes(v)) errors.push(`${k} must be one of ${def.choices.join('|')}`);
      continue;
    }
    // numeric
    if (v === null && (def.nullable || def.default === null)) continue; // blank = off (beAtR, addGateR, ...)
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${k} must be a number`); continue; }
    if (type === 'integer' && !Number.isInteger(v)) errors.push(`${k} must be an integer`);
    if (def.min != null && v < def.min) errors.push(`${k} ${v} < min ${def.min}`);
    if (def.max != null && v > def.max) errors.push(`${k} ${v} > max ${def.max}`);
    if (def.choices && !def.choices.includes(v)) errors.push(`${k} must be one of ${def.choices.join('|')}`);
  }
  return errors;
}

// ── row helpers ─────────────────────────────────────────────────────────────────────
const J = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch (_) { return d; } };
function expRow(r) {
  return { ...r, params_delta: J(r.params_delta, {}), params_resolved: J(r.params_resolved, {}) };
}
function latestVerdict(db, expId) {
  const v = db.prepare(`SELECT * FROM gate_verdicts WHERE experiment_id = ? ORDER BY id DESC LIMIT 1`).get(expId);
  return v ? { ...v, gates: J(v.gates, []) } : null;
}
function latestBacktest(db, expId, split, withTrades = false) {
  const cols = withTrades ? '*' : 'id, experiment_id, split, from_t, to_t, warmup_bars, metrics, periods_week, periods_month, created_at';
  const b = db.prepare(`SELECT ${cols} FROM backtests WHERE experiment_id = ? AND split = ? ORDER BY id DESC LIMIT 1`).get(expId, split);
  if (!b) return null;
  return { ...b, metrics: J(b.metrics, {}), periods_week: J(b.periods_week), periods_month: J(b.periods_month), trades: withTrades ? J(b.trades, []) : undefined };
}
function latestFolds(db, expId) {
  // folds from the most recent research bake only (rows created in the same bake share created_at ordering)
  const research = db.prepare(`SELECT id FROM backtests WHERE experiment_id = ? AND split = 'research' ORDER BY id DESC LIMIT 1`).get(expId);
  if (!research) return [];
  return db.prepare(`SELECT id, split, from_t, to_t, warmup_bars, metrics FROM backtests WHERE experiment_id = ? AND split LIKE 'fold_%' AND id > ? ORDER BY id`)
    .all(expId, research.id).map((f) => ({ ...f, metrics: J(f.metrics, {}) }));
}
function strategyName(db, id) {
  return db.prepare(`SELECT name FROM strategies WHERE id = ?`).get(id)?.name || null;
}

function wrap(fn) {
  return (req, res) => {
    try { fn(req, res); } catch (e) { console.error('[desk api]', req.method, req.path, e.message); res.status(500).json({ error: e.message }); }
  };
}

// ── GET /status ─────────────────────────────────────────────────────────────────────
router.get('/status', wrap((req, res) => {
  const db = desk.getDb();
  const manifest = desk.getManifest(db, SYMBOL, 'M1');
  const profile = desk.getActiveProfile(db);
  const byStatus = {};
  for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM experiments GROUP BY status`).all()) byStatus[r.status] = r.n;
  const verdicts = {};
  for (const r of db.prepare(`SELECT verdict, COUNT(*) AS n FROM gate_verdicts GROUP BY verdict`).all()) verdicts[r.verdict] = r.n;
  res.json({
    db: paths.DESK_DB,
    data_csv: paths.DATA_CSV,
    data_present: fs.existsSync(paths.DATA_CSV),
    engine_present: fs.existsSync(path.join(paths.ENGINE_DIR, 'engine.js')),
    data_manifest: manifest,
    holdout: bench.HOLDOUT_NOTE,
    active_profile_id: profile ? profile.id : null,
    active_profile_name: profile ? profile.name : null,
    active_profile: profile ? { id: profile.id, name: profile.name, version: profile.version, status: profile.status, fields: profile.fields } : null,
    n_trials: desk.getTrials(db, FAMILY, SYMBOL),
    counts: {
      strategies: db.prepare(`SELECT COUNT(*) AS n FROM strategies`).get().n,
      experiments: db.prepare(`SELECT COUNT(*) AS n FROM experiments`).get().n,
      experiments_by_status: byStatus,
      backtests: db.prepare(`SELECT COUNT(*) AS n FROM backtests`).get().n,
      verdicts,
    },
  });
}));

// ── Risk profile ─────────────────────────────────────────────────────────────────────
router.get('/risk-profile', wrap((req, res) => {
  const p = desk.getActiveProfile();
  if (!p) return res.status(404).json({ error: 'no risk profile' });
  res.json({ ...p, risk_pct_hard_max: RISK_PCT_HARD_MAX });
}));

function validateProfileFields(next, current) {
  const errors = [];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  // every field that is numeric in the current profile must stay numeric
  for (const [k, cur] of Object.entries(current)) {
    if (!(k in next)) continue;
    const v = next[k];
    if (isNum(cur) && !isNum(v)) errors.push(`${k} must be a number`);
    if (typeof cur === 'boolean' && typeof v !== 'boolean') errors.push(`${k} must be true/false`);
  }
  if (!(isNum(next.risk_pct_per_trade) && next.risk_pct_per_trade > 0)) errors.push('risk_pct_per_trade must be > 0');
  else if (next.risk_pct_per_trade > RISK_PCT_HARD_MAX) errors.push(`risk_pct_per_trade ${next.risk_pct_per_trade} exceeds hard max ${RISK_PCT_HARD_MAX}`);
  if (!(isNum(next.max_daily_loss_r) && next.max_daily_loss_r > 0)) errors.push('max_daily_loss_r must be > 0');
  if (!(isNum(next.account_size) && next.account_size > 0)) errors.push('account_size must be > 0');
  for (const k of ['max_trades_per_day', 'max_trades_per_session', 'max_consecutive_losses', 'max_concurrent', 'max_drawdown_halt_pct', 'hard_lot_cap']) {
    if (k in next && !(isNum(next[k]) && next[k] > 0)) errors.push(`${k} must be a positive number`);
  }
  if (next.sessions != null) {
    if (!Array.isArray(next.sessions) || !next.sessions.length) errors.push('sessions must be a non-empty array');
    else for (const s of next.sessions) {
      if (!s || typeof s.name !== 'string' || !s.name) errors.push('each session needs a name');
      if (!isNum(+s.start) || !isNum(+s.end) || s.start === '' || s.end === '') errors.push(`session ${s && s.name}: start/end must be numeric PT hours`);
      else if (s.start < 0 || s.start >= 24 || s.end < 0 || s.end > 24) errors.push(`session ${s.name}: hours must be within 0..24`);
    }
  }
  for (const grp of ['cost_model', 'symbol_facts']) {
    if (next[grp] == null) continue;
    if (typeof next[grp] !== 'object') { errors.push(`${grp} must be an object`); continue; }
    for (const [k, v] of Object.entries(next[grp])) if (!isNum(v) || v < 0) errors.push(`${grp}.${k} must be a non-negative number`);
  }
  return errors;
}

router.put('/risk-profile', wrap((req, res) => {
  const db = desk.getDb();
  const current = desk.getActiveProfile(db);
  if (!current) return res.status(404).json({ error: 'no active risk profile' });
  const body = req.body || {};
  const incoming = body.fields && typeof body.fields === 'object' ? body.fields : body;
  const next = { ...current.fields };
  const changed = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (['id', 'version', 'status', 'provenance', 'created_at', 'updated_at', 'risk_pct_hard_max'].includes(k)) continue;
    if (JSON.stringify(v) !== JSON.stringify(current.fields[k])) { next[k] = v; changed.push(k); }
  }
  const errors = validateProfileFields(next, current.fields);
  if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
  const provenance = { ...current.provenance };
  for (const k of changed) provenance[k] = 'mike-confirmed';
  db.prepare(`UPDATE risk_profiles SET name = ?, fields = ?, provenance = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`)
    .run(next.name || current.name, JSON.stringify(next), JSON.stringify(provenance), current.id);
  res.json({ ...desk.getActiveProfile(db), changed, risk_pct_hard_max: RISK_PCT_HARD_MAX });
}));

// ── Strategies ────────────────────────────────────────────────────────────────────────
router.get('/strategies', wrap((req, res) => {
  const rows = desk.getDb().prepare(`SELECT * FROM strategies ORDER BY id`).all();
  res.json(rows.map((r) => ({ ...r, params_resolved: J(r.params_resolved, {}) })));
}));

// ── Experiments ───────────────────────────────────────────────────────────────────────
router.get('/experiments', wrap((req, res) => {
  const db = desk.getDb();
  const where = [], args = [];
  if (req.query.strategy_id) { where.push('strategy_id = ?'); args.push(+req.query.strategy_id); }
  if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status)); }
  const rows = db.prepare(`SELECT * FROM experiments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...args);
  res.json(rows.map((r) => {
    const v = latestVerdict(db, r.id);
    const bt = latestBacktest(db, r.id, 'research') || latestBacktest(db, r.id, 'full');
    const m = bt ? bt.metrics : null;
    return {
      ...expRow(r), strategy_name: strategyName(db, r.strategy_id),
      verdict: v ? v.verdict : null, failing_gate: v ? v.failing_gate : null, verdict_at: v ? v.created_at : null,
      split: bt ? bt.split : null,
      summary: m ? { trades: m.trades ?? null, net_r: m.net_r ?? null, profit_factor: m.profit_factor ?? null, max_dd_r: m.max_dd_r ?? null, net_usd: m.net_usd ?? null } : null,
    };
  }));
}));

router.post('/experiments', wrap((req, res) => {
  const db = desk.getDb();
  const { strategy_id, hypothesis, params_delta } = req.body || {};
  if (typeof hypothesis !== 'string' || !hypothesis.trim()) return res.status(400).json({ error: 'hypothesis is required (non-empty)' });
  const strategy = db.prepare(`SELECT * FROM strategies WHERE id = ?`).get(+strategy_id);
  if (!strategy) return res.status(400).json({ error: `strategy_id ${strategy_id} not found` });
  const delta = params_delta == null ? {} : params_delta;
  const errors = validateDelta(delta, loadSchema());
  if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });
  const resolved = { ...J(strategy.params_resolved, {}), ...delta };
  const sha = desk.paramsSha(resolved);
  const dup = db.prepare(`SELECT id, status FROM experiments WHERE params_sha = ? ORDER BY id DESC LIMIT 1`).get(sha);
  const info = db.prepare(
    `INSERT INTO experiments (strategy_id, symbol, hypothesis, params_delta, params_resolved, params_sha, planned_by, status, source)
     VALUES (?, ?, ?, ?, ?, ?, 'mike', 'planned', 'mike')`
  ).run(strategy.id, strategy.symbol || SYMBOL, hypothesis.trim(), JSON.stringify(delta), JSON.stringify(resolved), sha);
  const row = expRow(db.prepare(`SELECT * FROM experiments WHERE id = ?`).get(info.lastInsertRowid));
  res.json({ ...row, strategy_name: strategy.name, duplicate_of: dup ? dup.id : null });
}));

// ── Bake (synchronous; may take a while — no route timeout) ────────────────────────────
router.post('/bake', wrap((req, res) => {
  req.setTimeout(0); res.setTimeout(0);
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  const out = bench.bake(ids && ids.length ? { ids } : { all: true });
  res.json(out);
}));

function experimentDetail(db, id) {
  const r = db.prepare(`SELECT * FROM experiments WHERE id = ?`).get(+id);
  if (!r) return null;
  const strategy = db.prepare(`SELECT id, name, family, lifecycle FROM strategies WHERE id = ?`).get(r.strategy_id) || null;
  const research = latestBacktest(db, r.id, 'research', true);
  const full = latestBacktest(db, r.id, 'full', false); // imported July numbers, if any
  const folds = latestFolds(db, r.id);
  const verdict = latestVerdict(db, r.id);
  let equity = null;
  if (research && research.trades && research.trades.length) {
    try {
      const sizing = require('./math/sizing');
      const profile = desk.getActiveProfile(db).fields;
      equity = sizing.equityCurve(research.trades, profile, research.metrics.start_balance ?? profile.account_size);
    } catch (_) { equity = null; } // TODO(owner B): sizing.js missing
  }
  const rails = research && research.metrics ? research.metrics.rails || null : null;
  return {
    experiment: expRow(r), strategy,
    research: research ? { ...research, trades: undefined } : null,
    imported_full: full,
    folds: folds.map((f) => ({ index: +String(f.split).replace('fold_', ''), from_t: f.from_t, to_t: f.to_t, warmup_bars: f.warmup_bars, ...f.metrics })),
    periods: research ? { week: research.periods_week, month: research.periods_month } : null,
    // Flat aliases for the Test Bench detail view (owner D reads d.periods_week / d.backtests[split=research]).
    periods_week: research ? research.periods_week : null,
    periods_month: research ? research.periods_month : null,
    backtests: [research ? { ...research, trades: undefined } : null, full].filter(Boolean),
    verdict,
    rails,
    equity,
    trades: research ? research.trades : [],
    holdout: bench.HOLDOUT_NOTE,
  };
}

router.get('/experiments/:id', wrap((req, res) => {
  const d = experimentDetail(desk.getDb(), req.params.id);
  if (!d) return res.status(404).json({ error: 'experiment not found' });
  res.json(d);
}));

// ── Leaderboard ───────────────────────────────────────────────────────────────────────
router.get('/leaderboard', wrap((req, res) => {
  const db = desk.getDb();
  const window = req.query.window === 'month' ? 'month' : 'week';
  const exps = db.prepare(`SELECT * FROM experiments WHERE status = 'done' ORDER BY id`).all();
  const passed = [], rejected = [], blocked = [], unjudged = [];
  for (const r of exps) {
    const v = latestVerdict(db, r.id);
    const bt = latestBacktest(db, r.id, 'research');
    const m = bt ? bt.metrics : null;
    const per = bt ? (window === 'month' ? bt.periods_month : bt.periods_week) : null;
    const ps = per && per.summary ? per.summary : null;
    const row = {
      id: r.id, hypothesis: r.hypothesis, hypothesis_short: String(r.hypothesis || '').split('\n')[0].slice(0, 90),
      strategy_id: r.strategy_id, strategy_name: strategyName(db, r.strategy_id),
      params_delta: J(r.params_delta, {}), source: r.source, ran_at: r.ran_at,
      verdict: v ? v.verdict : null, failing_gate: v ? v.failing_gate : null, n_trials_at: v ? v.n_trials_at : null,
      window,
      trades: m ? m.trades ?? null : null,
      win_rate: m ? m.winrate ?? null : null,
      net_r: m ? m.net_r ?? null : null,
      avg_win_r: m ? m.avg_win_r ?? null : null,
      avg_loss_r: m ? m.avg_loss_r ?? null : null,
      rr: m ? m.rr ?? null : null,
      expectancy_r: m ? m.expectancy_r ?? null : null,
      profit_factor: m ? m.profit_factor ?? null : null,
      max_dd_r: m ? m.max_dd_r ?? null : null,
      max_dd_usd: m ? m.max_dd_usd ?? null : null,
      net_usd: m ? m.net_usd ?? null : null,
      end_balance: m ? m.end_balance ?? null : null,
      ccy: m ? m.ccy ?? null : null,
      unsizable: m ? m.unsizable ?? null : null,
      period: ps ? {
        periods: ps.periods, positive_periods: ps.positive_periods, median_period_r: ps.median_period_r,
        worst_period_r: ps.worst_period_r, best_period_r: ps.best_period_r, median_rr: ps.median_rr,
        avg_trades_per_period: ps.avg_trades_per_period ?? null,
      } : null,
      folds_positive: v ? (v.gates.find((g) => g.gate === 'folds_positive_min') || {}).value ?? null : null,
    };
    // Nested aliases so the Test Bench leaderboard (row.metrics / row.usd) and the flat keys agree.
    row.metrics = {
      trades: row.trades, winrate: row.win_rate, win_rate: row.win_rate, net_r: row.net_r, avg_win_r: row.avg_win_r,
      avg_loss_r: row.avg_loss_r, rr: row.rr, expectancy_r: row.expectancy_r, profit_factor: row.profit_factor,
      max_dd_r: row.max_dd_r, max_dd_usd: row.max_dd_usd, net_usd: row.net_usd,
    };
    row.usd = { max_dd_usd: row.max_dd_usd, net_usd: row.net_usd, end_balance: row.end_balance, ccy: row.ccy, unsizable: row.unsizable };
    if (!v) { unjudged.push(row); continue; }
    if (v.verdict === 'PASS') passed.push(row);
    else if (v.verdict === 'REJECT') rejected.push(row);
    else blocked.push(row);
  }
  const byNet = (a, b) => (b.net_r ?? -Infinity) - (a.net_r ?? -Infinity);
  passed.sort(byNet); rejected.sort(byNet); blocked.sort(byNet);
  res.json({
    window, holdout: bench.HOLDOUT_NOTE, n_trials: desk.getTrials(db, FAMILY, SYMBOL),
    rows: passed, rejected, blocked,
    unjudged_count: unjudged.length,
    note: unjudged.length ? `${unjudged.length} done experiment(s) have no desk verdict yet (imported July numbers) — bake them to judge.` : null,
  });
}));

// ── Schema ────────────────────────────────────────────────────────────────────────────
router.get('/schema', wrap((req, res) => {
  const s = loadSchema();
  if (!s) return res.status(503).json({ error: 'desk/engine/schema.json not available yet' });
  res.json(s);
}));

// ═════════════════════════════════════════════════════════════════════════════════════
// Mike's loop: Edge → Risk → Results → Activity (desk/src/edge.js, reasons.js, activity.js)
// Plain sentences out; raw parameter keys only travel inside { key, label, ... } control bindings.
// ═════════════════════════════════════════════════════════════════════════════════════
const strategyRow = (db, id) => db.prepare(`SELECT * FROM strategies WHERE id = ?`).get(+id) || null;
function strategyView(s) {
  if (!s) return null;
  return {
    id: s.id, name: s.name, version: edge.versionLabel(s), version_number: s.version, family: s.family,
    parent_id: s.parent_id, lifecycle: s.lifecycle, source: s.source, created_at: s.created_at,
  };
}
function newestStrategy(db, family) {
  return db.prepare(`SELECT * FROM strategies WHERE family = ? ORDER BY id DESC LIMIT 1`).get(family) || null;
}
// Latest desk verdict for a strategy (across its experiments) → { experiment_id, verdict, reason, tested_at } | null
function latestVerdictForStrategy(db, strategyId) {
  const v = db.prepare(
    `SELECT v.*, e.strategy_id FROM gate_verdicts v JOIN experiments e ON e.id = v.experiment_id
     WHERE e.strategy_id = ? ORDER BY v.id DESC LIMIT 1`
  ).get(+strategyId);
  return v ? verdictView({ ...v, gates: J(v.gates, []) }) : null;
}
function verdictView(v) {
  if (!v) return null;
  return {
    experiment_id: v.experiment_id, verdict: v.verdict, verdict_word: reasons.verdictWord(v.verdict),
    reason: reasons.reasonFor(v), tested_at: activity.toPtIso(v.created_at), tested_at_label: activity.toPtLabel(v.created_at),
    n_trials_at: v.n_trials_at ?? null,
  };
}
function testsCount(db, strategyId) {
  return db.prepare(`SELECT COUNT(DISTINCT e.id) AS n FROM experiments e JOIN gate_verdicts v ON v.experiment_id = e.id WHERE e.strategy_id = ?`).get(+strategyId).n;
}

// ── GET /rulesheet?strategy_id ────────────────────────────────────────────────────────
router.get('/rulesheet', wrap((req, res) => {
  const db = desk.getDb();
  const family = String(req.query.family || FAMILY);
  const s = req.query.strategy_id ? strategyRow(db, req.query.strategy_id) : newestStrategy(db, family);
  if (!s) return res.status(404).json({ error: req.query.strategy_id ? `version ${req.query.strategy_id} not found` : 'no versions yet; import the July champion first' });
  const params = J(s.params_resolved, {});
  const sheet = edge.renderSheet(params, s.family || family);
  res.json({ ...sheet, strategy: strategyView(s), latest_verdict: latestVerdictForStrategy(db, s.id) });
}));

// ── GET /versions?family ──────────────────────────────────────────────────────────────
router.get('/versions', wrap((req, res) => {
  const db = desk.getDb();
  const family = String(req.query.family || FAMILY);
  const rows = db.prepare(`SELECT * FROM strategies WHERE family = ? ORDER BY id DESC`).all(family);
  const byId = new Map(rows.map((r) => [r.id, r]));
  res.json(rows.map((s) => {
    const lv = latestVerdictForStrategy(db, s.id);
    const parent = s.parent_id != null ? byId.get(s.parent_id) : null;
    return {
      ...strategyView(s),
      parent_version: parent ? edge.versionLabel(parent) : null,
      tests: testsCount(db, s.id),
      last_verdict: lv ? lv.verdict : null,           // 'PASS' | 'REJECT' | 'BLOCKED' | null (a string; the picker reads it directly)
      last_verdict_word: lv ? lv.verdict_word : null,
      last_reason: lv ? lv.reason : null,
      last_experiment_id: lv ? lv.experiment_id : null,
      last_tested_at: lv ? lv.tested_at : null,
    };
  }));
}));

// ── POST /edge/test { strategy_id, changes, note } ────────────────────────────────────
// Changes → a child version (v2.1 → v2.2) + one experiment, baked synchronously (~10-60 s).
// runEdgeTest is the single code path; the chat's Apply & test (desk/src/chat.js) calls it too.
//   → { ok:true, result } | { ok:false, status, error, errors? }
function runEdgeTest(db, body = {}) {
  const parent = strategyRow(db, body.strategy_id);
  if (!parent) return { ok: false, status: 400, error: `version ${body.strategy_id} not found` };
  const family = parent.family || FAMILY;
  const schema = schemaEntries(loadSchema());
  if (!schema) return { ok: false, status: 503, error: 'the rule schema is not available' };
  const rawChanges = body.changes == null ? {} : body.changes;
  const errors = edge.validateChanges(rawChanges, schema, family);
  if (errors.length) return { ok: false, status: 400, error: errors.join('; '), errors };
  const parentParams = J(parent.params_resolved, {});
  const changes = edge.effectiveChanges(rawChanges, parentParams);
  const note = typeof body.note === 'string' ? body.note.trim() : '';

  let strategy = parent;
  let created = false;
  if (Object.keys(changes).length) {
    const resolved = { ...parentParams, ...changes };
    const next = edge.nextVersion(db, parent, family);
    const sheetText = edge.renderSheetText(resolved, family, { title: `${next.name} (from ${edge.versionLabel(parent) || parent.name})` });
    const info = db.prepare(
      `INSERT INTO strategies (name, family, symbol, parent_id, version, params_resolved, params_sha, rule_sheet_text, lifecycle, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_sample', 'edge')`
    ).run(next.name, family, parent.symbol || SYMBOL, parent.id, next.number, JSON.stringify(resolved), desk.paramsSha(resolved), sheetText);
    strategy = strategyRow(db, info.lastInsertRowid);
    created = true;
  }
  const resolved = J(strategy.params_resolved, {});
  const versionLabel = edge.versionLabel(strategy) || strategy.name;
  const hypothesis = note || edge.autoHypothesis(changes, parentParams, versionLabel, family);
  const expInfo = db.prepare(
    `INSERT INTO experiments (strategy_id, symbol, hypothesis, params_delta, params_resolved, params_sha, planned_by, status, source)
     VALUES (?, ?, ?, ?, ?, ?, 'mike', 'planned', 'edge')`
  ).run(strategy.id, strategy.symbol || SYMBOL, hypothesis, JSON.stringify(changes), JSON.stringify(resolved), desk.paramsSha(resolved));
  const experimentId = Number(expInfo.lastInsertRowid);

  const out = bench.bake({ ids: [experimentId] });
  const r = (out.results || []).find((x) => x.id === experimentId) || null;
  const v = latestVerdict(db, experimentId);
  const bt = latestBacktest(db, experimentId, 'research');
  let verdict, reason;
  if (r && r.status === 'failed') { verdict = 'ERROR'; reason = reasons.reasonFor({ verdict: 'ERROR', error: r.error }); }
  else if (v) { verdict = v.verdict; reason = reasons.reasonFor(v); }
  else { verdict = 'BLOCKED'; reason = reasons.reasonFor({ verdict: 'BLOCKED', blocked_reason: 'no verdict was recorded' }); }
  return {
    ok: true,
    result: {
      strategy: strategyView(strategy),
      created_version: created,
      parent: strategyView(parent),
      experiment_id: experimentId,
      verdict, verdict_word: reasons.verdictWord(verdict), reason,
      changes, changes_text: edge.describeChanges(changes, parentParams, family),
      note: note || null,
      summary: bt ? edge.summaryFor(bt.metrics, bt.periods_week, 'week') : null,
      n_trials: desk.getTrials(db, family, strategy.symbol || SYMBOL),
      holdout: bench.HOLDOUT_NOTE,
      elapsed_ms: r ? r.elapsed_ms ?? null : null,
    },
  };
}

router.post('/edge/test', wrap((req, res) => {
  req.setTimeout(180000); res.setTimeout(180000);
  const out = runEdgeTest(desk.getDb(), req.body || {});
  if (!out.ok) return res.status(out.status).json(out.errors ? { error: out.error, errors: out.errors } : { error: out.error });
  res.json(out.result);
}));

// ═════════════════════════════════════════════════════════════════════════════════════
// CHAT (desk/src/chat.js). Propose-only: the model returns JSON, Mike's tap runs the test.
// ═════════════════════════════════════════════════════════════════════════════════════
function wrapAsync(fn) {
  return (req, res) => {
    Promise.resolve().then(() => fn(req, res)).catch((e) => {
      const status = e && e.status && e.name === 'ChatError' ? e.status : 500;
      if (status === 500) console.error('[desk api]', req.method, req.path, e && e.message);
      res.status(status).json({ error: e && e.message ? e.message : String(e) });
    });
  };
}
function chatError(res, e) {
  if (e && e.name === 'ChatError') return res.status(e.status || 400).json({ error: e.message });
  throw e;
}

router.get('/chat/status', wrap((req, res) => {
  res.json(chat.status(desk.getDb()));
}));

// Save or remove the API key from the app. The value goes browser -> this process -> macOS keychain
// and is never logged, stored in desk.db, or returned by any route.
router.post('/chat/key', wrap((req, res) => {
  const key = (req.body || {}).key;
  if (typeof key !== 'string' || !key.trim()) return res.status(400).json({ error: 'Paste the key first.' });
  try {
    keychain.setApiKey(key);
  } catch (e) {
    return res.status(400).json({ error: e.message === 'empty key' ? 'Paste the key first.' : e.message });
  }
  res.json({ saved: true, status: chat.status(desk.getDb()) });
}));

router.delete('/chat/key', wrap((req, res) => {
  keychain.removeApiKey();
  res.json({ removed: true, status: chat.status(desk.getDb()) });
}));

router.get('/chat/threads', wrap((req, res) => {
  res.json(chat.listThreads(desk.getDb()));
}));

router.post('/chat/threads', wrap((req, res) => {
  const t = chat.createThread(desk.getDb(), typeof (req.body || {}).title === 'string' ? req.body.title.trim() : '');
  res.json({ ...t, messages: 0 });
}));

router.get('/chat/threads/:id', wrap((req, res) => {
  const v = chat.getThreadView(desk.getDb(), req.params.id);
  if (!v) return res.status(404).json({ error: `conversation ${req.params.id} not found` });
  res.json(v);
}));

router.post('/chat/messages', wrapAsync(async (req, res) => {
  req.setTimeout(300000); res.setTimeout(300000);
  const body = req.body || {};
  try {
    const out = await chat.send(desk.getDb(), { thread_id: body.thread_id, text: body.text, context: body.context || {} });
    res.json(out);
  } catch (e) { chatError(res, e); }
}));

router.post('/chat/proposals/:message_id/apply', wrap((req, res) => {
  req.setTimeout(180000); res.setTimeout(180000);
  const body = req.body || {};
  try {
    res.json(chat.apply(desk.getDb(), req.params.message_id, { strategy_id: body.strategy_id, note: body.note }));
  } catch (e) { chatError(res, e); }
}));

// ── GET /results?window=week|month ────────────────────────────────────────────────────
function resultRow(db, e, window, strategies) {
  const v = latestVerdict(db, e.id);
  const bt = latestBacktest(db, e.id, 'research');
  const s = strategies.get(e.strategy_id) || strategyRow(db, e.strategy_id);
  const parent = s && s.parent_id != null ? (strategies.get(s.parent_id) || strategyRow(db, s.parent_id)) : null;
  const changes = J(e.params_delta, {}) || {};
  // Edge tests run on a child version, so the baseline is the parent; slice-1 experiments applied a
  // delta on top of their own strategy, so the baseline is that strategy.
  const baseParams = e.source === 'edge' && parent ? J(parent.params_resolved, {}) : (s ? J(s.params_resolved, {}) : {});
  const realChanges = e.source === 'edge' ? changes : edge.effectiveChanges(changes, baseParams);
  let verdict, reason;
  if (e.status === 'failed') { verdict = 'ERROR'; reason = reasons.reasonFor({ verdict: 'ERROR', error: e.error }); }
  else if (v) { verdict = v.verdict; reason = reasons.reasonFor(v); }
  else { verdict = null; reason = e.status === 'done' ? 'no desk verdict yet' : 'not tested yet'; }
  const testedAt = e.ran_at || (v ? v.created_at : null) || e.created_at;
  return {
    experiment_id: e.id,
    strategy: strategyView(s),
    tested_at: activity.toPtIso(testedAt), tested_at_label: activity.toPtLabel(testedAt),
    status: e.status,
    verdict, verdict_word: reasons.verdictWord(verdict), reason,
    failing_gate_label: v && v.failing_gate ? reasons.gateLabel(v.failing_gate) : null,
    changes: realChanges, changes_text: edge.describeChanges(realChanges, baseParams, s ? s.family || FAMILY : FAMILY),
    note: edge.isAutoHypothesis(e.hypothesis) ? null : e.hypothesis,
    hypothesis: e.hypothesis,
    planned_by: e.planned_by, source: e.source,
    summary: bt ? edge.summaryFor(bt.metrics, window === 'month' ? bt.periods_month : bt.periods_week, window) : null,
    n_trials_at: v ? v.n_trials_at : null,
  };
}

router.get('/results', wrap((req, res) => {
  const db = desk.getDb();
  const window = req.query.window === 'month' ? 'month' : 'week';
  const strategies = new Map(db.prepare(`SELECT * FROM strategies`).all().map((s) => [s.id, s]));
  // every experiment the desk judged (has a verdict) or that crashed; imported July numbers without a desk verdict stay out
  const exps = db.prepare(
    `SELECT e.* FROM experiments e
     WHERE e.status = 'failed' OR EXISTS (SELECT 1 FROM gate_verdicts v WHERE v.experiment_id = e.id)
     ORDER BY COALESCE(e.ran_at, e.created_at) DESC, e.id DESC`
  ).all();
  const rows = exps.map((e) => resultRow(db, e, window, strategies));
  const unjudged = db.prepare(`SELECT COUNT(*) AS n FROM experiments e WHERE e.status = 'done' AND NOT EXISTS (SELECT 1 FROM gate_verdicts v WHERE v.experiment_id = e.id)`).get().n;
  const manifest = desk.getManifest(db, SYMBOL, 'M1');
  res.json({
    window, rows, results: rows,
    holdout: bench.HOLDOUT_NOTE, n_trials: desk.getTrials(db, FAMILY, SYMBOL),
    unjudged_count: unjudged,
    data: manifest ? {
      bars: manifest.bars, from_t: manifest.from_t, to_t: manifest.to_t, burned: !!manifest.burned,
      text: `${Number(manifest.bars || 0).toLocaleString('en-US')} one-minute gold bars, ${activity.shortDate(manifest.from_t)} to ${activity.shortDate(manifest.to_t)}. ${manifest.burned ? 'No clean holdout yet.' : 'Holdout available.'} Trials so far: ${desk.getTrials(db, FAMILY, SYMBOL)}.`,
    } : null,
  });
}));

// ── GET /results/:experiment_id ───────────────────────────────────────────────────────
router.get('/results/:id', wrap((req, res) => {
  const db = desk.getDb();
  const d = experimentDetail(db, req.params.id);
  if (!d) return res.status(404).json({ error: 'test not found' });
  const window = req.query.window === 'month' ? 'month' : 'week';
  const e = db.prepare(`SELECT * FROM experiments WHERE id = ?`).get(+req.params.id);
  const strategies = new Map(db.prepare(`SELECT * FROM strategies`).all().map((s) => [s.id, s]));
  const row = resultRow(db, e, window, strategies);
  const s = strategies.get(e.strategy_id);
  const family = s ? s.family || FAMILY : FAMILY;
  let ruleSheetText = null;
  try { ruleSheetText = edge.renderSheetText(J(e.params_resolved, {}), family, { title: `${row.strategy ? row.strategy.name : 'this version'} as tested` }); } catch (_) { ruleSheetText = s ? s.rule_sheet_text : null; }
  res.json({
    ...d,
    ...row,
    gate_rows: d.verdict ? reasons.gateRows(d.verdict.gates, d.verdict.n_trials_at) : [],
    rule_sheet_text: ruleSheetText,
    stored_rule_sheet_text: s ? s.rule_sheet_text : null,
  });
}));

// ── GET /activity?limit=50 ────────────────────────────────────────────────────────────
router.get('/activity', wrap((req, res) => {
  const db = desk.getDb();
  const limit = Math.max(1, Math.min(+req.query.limit || 50, 500));
  res.json(activity.buildActivity(db, { limit }));
}));

module.exports = router;
module.exports.validateDelta = validateDelta;
module.exports.experimentDetail = experimentDetail;
module.exports.validateProfileFields = validateProfileFields;
module.exports.runEdgeTest = runEdgeTest;
