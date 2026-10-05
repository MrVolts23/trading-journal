// Quant Desk — the BENCH: orchestrates a bake (grinder + judge) for planned experiments.
// Demo-only research. No execution code, no model calls. All math lives in ../src/math (owner B)
// and the simulator in ../engine/engine.js (owner A); this file only wires them to desk.db.
//
//   bake({ ids } | { all: true })  → per-experiment verdict summaries (writes backtests + gate_verdicts)
//   runOne(paramsResolved, opts)   → the same result object for ad-hoc params, no DB writes
//
// Holdout: NONE YET. The seeded csv is burned research data (consulted when the July champion
// was chosen), so the "research" split is the whole file and every verdict says so.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const desk = require('./db');

const HOLDOUT_NOTE = 'none yet (seeded data is burned)';
const TRADES_CAP = 2000;
const N_FOLDS = 5;

// ── Defensive module loading (owners A/B write these in parallel) ─────────────────────
function tryRequire(p) {
  try { return require(p); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(path.basename(p))) return null; throw e; }
}
function loadEngine() {
  const eng = tryRequire(path.join(paths.ENGINE_DIR, 'engine.js'));
  if (eng) return eng;
  // TODO(owner A): desk/engine/engine.js absent — falling back to the ancestor engine (no entryGate/countFrom support).
  return tryRequire(path.join(paths.DESK_ROOT, '../loops/backtest/engine.js'));
}
const math = {
  get sizing() { return tryRequire('./math/sizing'); },
  get rails() { return tryRequire('./math/rails'); },
  get periods() { return tryRequire('./math/periods'); },
  get folds() { return tryRequire('./math/folds'); },
  get stats() { return tryRequire('./math/stats'); },
  get bootstrap() { return tryRequire('./math/bootstrap'); },
  get gates() { return tryRequire('./math/gates'); },
};

// ── Data cache ───────────────────────────────────────────────────────────────────────
let _bars = null, _barsKey = null;
function loadBars(engine) {
  if (!fs.existsSync(paths.DATA_CSV)) throw new Error(`research csv missing: ${paths.DATA_CSV} (run desk/scripts/import_gma.js)`);
  const st = fs.statSync(paths.DATA_CSV);
  const key = `${paths.DATA_CSV}:${st.size}:${st.mtimeMs}`;
  if (_bars && _barsKey === key) return _bars;
  _bars = engine.loadM1(paths.DATA_CSV);
  _barsKey = key;
  return _bars;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────
function stripFns(params) {
  const out = {};
  for (const k of Object.keys(params || {})) if (typeof params[k] !== 'function') out[k] = params[k];
  return out;
}

// Keys the engine needs from the profile: sessions → windows, cost model, max_concurrent as a CAP
// (an experiment may pyramid with maxConcurrent 2 only if the profile allows it — Mike's rails win).
function applyProfileToParams(params, profileFields) {
  const p = { ...params };
  const rails = math.rails;
  const fromProfile = rails && rails.engineParamsFromProfile ? rails.engineParamsFromProfile(profileFields) : {};
  if (fromProfile.windows) p.windows = fromProfile.windows;
  if (fromProfile.spreadUsd != null) p.spreadUsd = fromProfile.spreadUsd;
  if (fromProfile.slippageUsd != null) p.slippageUsd = fromProfile.slippageUsd;
  const profCap = profileFields.max_concurrent != null ? +profileFields.max_concurrent : null;
  if (profCap != null && profCap > 0) p.maxConcurrent = Math.min(+(p.maxConcurrent || 1), profCap);
  return p;
}

function makeGate(profileFields) {
  const rails = math.rails;
  if (!rails || !rails.makeEntryGate) return null; // TODO(owner B): rails.js missing → ungated run
  return rails.makeEntryGate(profileFields);
}

function rTotals(trades) {
  const rs = trades.map((t) => +t.r || 0);
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null;
  return {
    wins: wins.length, losses: losses.length,
    avg_win_r: avgWin == null ? null : +avgWin.toFixed(3),
    avg_loss_r: avgLoss == null ? null : +avgLoss.toFixed(3),
    rr: avgWin != null && avgLoss ? +(avgWin / Math.abs(avgLoss)).toFixed(3) : null,
  };
}

function normalizePeriods(res) {
  if (!res) return { rows: [], summary: null };
  if (Array.isArray(res)) return { rows: res, summary: res.summary || (math.periods && math.periods.periodSummary ? math.periods.periodSummary(res) : null) };
  return { rows: res.periods || res.rows || [], summary: res.summary || null };
}

function normalizeFolds(res) {
  if (!res) return { raw: null, folds: [], folds_positive: 0, min_trades_per_fold: 0 };
  const list = Array.isArray(res) ? res : (res.folds || res.results || []);
  const folds = list.map((f, i) => {
    const m = f.metrics || {};
    const tradesArr = Array.isArray(f.trades) ? f.trades : null;
    return {
      index: f.index ?? i + 1,
      from_t: f.from_t ?? null,
      to_t: f.to_t ?? null,
      bars: f.bars ?? null,
      warmup_bars: f.warmup_bars ?? f.warmupBars ?? null,
      trade_count: typeof f.trades === 'number' ? f.trades : (tradesArr ? tradesArr.length : (m.trades ?? 0)),
      metrics: m,
      trades: tradesArr,
      positive: f.positive ?? (m.net_r > 0 && (m.profit_factor == null ? true : m.profit_factor > 1)),
    };
  });
  const folds_positive = !Array.isArray(res) && res.folds_positive != null ? res.folds_positive : folds.filter((f) => f.positive).length;
  const min_trades_per_fold = !Array.isArray(res) && res.min_trades_per_fold != null ? res.min_trades_per_fold
    : (folds.length ? Math.min(...folds.map((f) => f.trade_count)) : 0);
  // raw = the shape gates.verify() consumes ({ folds:[{trades:count, metrics, positive}], folds_positive, min_trades_per_fold })
  const raw = Array.isArray(res)
    ? { n_folds: folds.length, folds: folds.map((f) => ({ ...f, trades: f.trade_count })), folds_positive, min_trades_per_fold }
    : res;
  return { raw, folds, folds_positive, min_trades_per_fold };
}

// Inline fallback if folds.js is absent (same definition: anchored, warm-up = all prior bars).
function fallbackRunFolds(engineRun, m1, params, nFolds) {
  const n = m1.length, out = [];
  for (let i = 0; i < nFolds; i++) {
    const a = Math.floor((n * i) / nFolds), b = i === nFolds - 1 ? n : Math.floor((n * (i + 1)) / nFolds);
    const from_t = m1[a].t, to_t = m1[b - 1].t;
    const r = engineRun(m1.slice(0, b), { ...params, countFrom: from_t });
    const trades = r.trades.filter((t) => t.entryT >= from_t);
    const engine = loadEngine();
    out.push({ index: i + 1, from_t, to_t, warmup_bars: r.warmupBars ?? a, metrics: engine.metrics(trades), trades });
  }
  return out;
}

function statsBlock(trades, spanSeconds) {
  const stats = math.stats;
  if (!stats || !trades.length) return null;
  try {
    const rs = trades.map((t) => +t.r || 0);
    const years = Math.max(spanSeconds / (365.25 * 86400), 1 / 365.25);
    const perYear = rs.length / years;
    const sr = stats.stdev ? (stats.mean(rs) / (stats.stdev(rs) || 1)) : null;
    return {
      trades_per_year: +perYear.toFixed(1),
      sharpe_per_trade: sr == null ? null : +sr.toFixed(4),
      psr: stats.probabilistic_sharpe ? +(+stats.probabilistic_sharpe(rs, 0, perYear)).toFixed(4) : null,
      skew: stats.skew ? +(+stats.skew(rs)).toFixed(4) : null,
      kurtosis: stats.kurtosis ? +(+stats.kurtosis(rs)).toFixed(4) : null,
    };
  } catch (e) { return { error: e.message }; }
}

// ── runOne: everything for one params set, nothing written ────────────────────────────
// opts: { profile (fields), nTrials, bars (optional cache), nFolds }
function runOne(paramsResolved, opts = {}) {
  const engine = loadEngine();
  if (!engine) throw new Error('no engine available (desk/engine/engine.js and loops/backtest/engine.js both missing)');
  const profile = opts.profile || desk.getActiveProfile().fields;
  const bars = opts.bars || loadBars(engine);
  const nTrials = opts.nTrials != null ? opts.nTrials : desk.getTrials(desk.getDb(), 'double_bos', 'XAUUSD');
  const base = applyProfileToParams(stripFns(paramsResolved), profile);

  const engineRun = (m1, p) => engine.runDoubleBOS(m1, { ...p, entryGate: makeGate(profile) });

  // research window = whole file (holdout: none yet)
  const from_t = bars[0].t, to_t = bars[bars.length - 1].t;
  const t0 = Date.now();
  const research = engineRun(bars, base);
  let trades = research.trades;

  // sizing ($) — attaches lots / risk_usd / pnl_usd / unsizable to each trade
  let sizing = null;
  if (math.sizing && math.sizing.sizeTrades) {
    const s = math.sizing.sizeTrades(trades, profile, profile.account_size);
    trades = s.trades; sizing = s.summary;
  }

  const metrics = { ...engine.metrics(trades), ...rTotals(trades) };
  metrics.warmup_bars = research.warmupBars ?? 0;
  metrics.span = { from_t, to_t, bars: bars.length, days: +((to_t - from_t) / 86400).toFixed(1) };
  if (sizing) Object.assign(metrics, {
    net_usd: sizing.net_usd, max_dd_usd: sizing.max_dd_usd, end_balance: sizing.end_balance,
    start_balance: sizing.start_balance, ccy: sizing.ccy, compounding: sizing.compounding, unsizable: sizing.unsizable,
  });
  if (math.rails && math.rails.railsReport) metrics.rails = math.rails.railsReport(trades, profile);
  metrics.stats = statsBlock(trades, to_t - from_t);
  if (math.bootstrap && trades.length) {
    try {
      const rs = trades.map((t) => +t.r || 0);
      // same n/seed as the verifier (desk/config/gates.yaml) so this number equals the gate's value
      let bn = 1000, bseed = 42;
      try { const gc = math.gates && math.gates.loadGatesConfig ? math.gates.loadGatesConfig() : null; if (gc) { bn = gc.bootstrap_n; bseed = gc.bootstrap_seed; } } catch (_) {}
      metrics.bootstrap_p_positive = +(+math.bootstrap.bootstrapPPositive(rs, bn, bseed)).toFixed(4);
      metrics.bootstrap_threshold = +(+math.bootstrap.trialPenalizedThreshold(nTrials)).toFixed(4);
    } catch (e) { metrics.bootstrap_error = e.message; }
  }

  // fold consistency (NOT walk-forward: no re-optimization)
  let foldsRes;
  const nFolds = opts.nFolds || N_FOLDS;
  if (math.folds && math.folds.runFolds) foldsRes = math.folds.runFolds(engineRun, bars, base, nFolds, { metrics: engine.metrics });
  else foldsRes = fallbackRunFolds(engineRun, bars, base, nFolds); // TODO(owner B): folds.js missing
  const folds = normalizeFolds(foldsRes);
  if (math.sizing && math.sizing.sizeTrades) {
    for (const f of folds.folds) if (f.trades) { // only the inline fallback carries fold trade arrays
      const s = math.sizing.sizeTrades(f.trades, profile, profile.account_size);
      f.trades = s.trades; f.metrics = { ...f.metrics, net_usd: s.summary.net_usd, max_dd_usd: s.summary.max_dd_usd };
    }
  }

  // periods (Mike's "highest RR" = realized R per week / month)
  let periods_week = { rows: [], summary: null }, periods_month = { rows: [], summary: null };
  if (math.periods && math.periods.periodStats) {
    periods_week = normalizePeriods(math.periods.periodStats(trades, 'week'));
    periods_month = normalizePeriods(math.periods.periodStats(trades, 'month'));
  }

  // verifier (gates.js loads desk/config/gates.yaml itself and reports its sha)
  let verdict;
  if (math.gates && math.gates.verify) {
    verdict = math.gates.verify({ research: { metrics, trades }, folds: folds.raw, nTrials, profile });
  } else {
    // TODO(owner B): gates.js missing — cannot judge; BLOCKED is not a REJECT.
    verdict = { verdict: 'BLOCKED', gates: [], failing_gate: 'verifier unavailable (desk/src/math/gates.js missing)', holdout: HOLDOUT_NOTE };
  }
  verdict.holdout = verdict.holdout || HOLDOUT_NOTE;

  return {
    params: base, profile_snapshot: profile, n_trials: nTrials,
    research: { from_t, to_t, warmup_bars: research.warmupBars ?? 0, metrics, trades },
    folds: folds.folds, folds_positive: folds.folds_positive, min_trades_per_fold: folds.min_trades_per_fold,
    periods_week, periods_month, verdict, gates_config_sha: verdict.gates_config_sha || null,
    elapsed_ms: Date.now() - t0,
  };
}

// ── bake: run planned (or chosen) experiments and persist ─────────────────────────────
function bake({ ids, all } = {}) {
  const db = desk.getDb();
  let rows;
  if (Array.isArray(ids) && ids.length) {
    const qs = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT * FROM experiments WHERE id IN (${qs}) ORDER BY id`).all(...ids.map(Number));
  } else {
    rows = db.prepare(`SELECT * FROM experiments WHERE status = 'planned' ORDER BY id`).all();
  }
  if (!rows.length) return { baked: 0, results: [], note: all || !ids ? 'nothing planned' : 'no matching experiments' };

  const engine = loadEngine();
  if (!engine) throw new Error('no engine available');
  const bars = loadBars(engine);
  const profileRow = desk.getActiveProfile(db);
  const profile = profileRow.fields;

  const insBt = db.prepare(
    `INSERT INTO backtests (experiment_id, split, from_t, to_t, warmup_bars, metrics, periods_week, periods_month, trades)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insVerdict = db.prepare(
    `INSERT INTO gate_verdicts (experiment_id, verdict, gates, failing_gate, n_trials_at, gates_config_sha, holdout)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const setStatus = db.prepare(`UPDATE experiments SET status = ?, error = ?, ran_at = datetime('now') WHERE id = ?`);

  const results = [];
  for (const row of rows) {
    setStatus.run('running', null, row.id);
    let family = 'double_bos';
    try { family = db.prepare(`SELECT family FROM strategies WHERE id = ?`).get(row.strategy_id)?.family || family; } catch (_) {}
    try {
      const params = JSON.parse(row.params_resolved);
      // one trial per bake, counted BEFORE the verdict so the penalty includes this attempt
      const nTrials = desk.bumpTrials(db, family, row.symbol || 'XAUUSD', 1);
      const r = runOne(params, { profile, nTrials, bars });
      const persist = db.transaction(() => {
        // previous bakes of the same experiment are kept; the API reads the latest rows
        insBt.run(row.id, 'research', r.research.from_t, r.research.to_t, r.research.warmup_bars,
          JSON.stringify(r.research.metrics), JSON.stringify(r.periods_week), JSON.stringify(r.periods_month),
          JSON.stringify(r.research.trades.slice(0, TRADES_CAP)));
        for (const f of r.folds) {
          insBt.run(row.id, `fold_${f.index}`, f.from_t, f.to_t, f.warmup_bars,
            JSON.stringify({ ...(f.metrics || {}), trades: f.trade_count, bars: f.bars, positive: f.positive }),
            null, null, f.trades ? JSON.stringify(f.trades.slice(0, TRADES_CAP)) : null);
        }
        // BLOCKED has no failing gate; keep the verifier's blocked_reason in that column so reasons.js
        // can say why ("only 7 trades, too few to judge") instead of a generic sentence.
        insVerdict.run(row.id, r.verdict.verdict, JSON.stringify(r.verdict.gates || []), r.verdict.failing_gate || r.verdict.blocked_reason || null,
          nTrials, r.gates_config_sha, r.verdict.holdout || HOLDOUT_NOTE);
        setStatus.run('done', null, row.id);
      });
      persist();
      results.push({
        id: row.id, status: 'done', verdict: r.verdict.verdict, failing_gate: r.verdict.failing_gate || null,
        gates: r.verdict.gates || [], holdout: r.verdict.holdout,
        trades: r.research.metrics.trades, net_r: r.research.metrics.net_r, profit_factor: r.research.metrics.profit_factor,
        max_dd_r: r.research.metrics.max_dd_r, net_usd: r.research.metrics.net_usd ?? null,
        folds_positive: r.folds_positive, n_trials: nTrials, elapsed_ms: r.elapsed_ms,
      });
    } catch (e) {
      setStatus.run('failed', e.message, row.id);
      results.push({ id: row.id, status: 'failed', error: e.message });
    }
  }
  return { baked: results.filter((x) => x.status === 'done').length, results, holdout: HOLDOUT_NOTE };
}

module.exports = { bake, runOne, loadBars, loadEngine, applyProfileToParams, HOLDOUT_NOTE, TRADES_CAP, N_FOLDS, normalizePeriods, normalizeFolds };
