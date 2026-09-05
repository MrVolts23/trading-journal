// Quant Desk — the VERIFIER (pure, numerical, non-overridable). No model narrates here; nothing here
// can be talked out of a number. Thresholds live in desk/config/gates.yaml (every one claude-assumed
// until Mike edits it). Holdout: none yet — the seeded CSV is burned research data.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { bootstrapPPositive, trialPenalizedThreshold } = require('./bootstrap');
const { psrReport } = require('./stats');

const GATES_YAML = path.join(__dirname, '../../config/gates.yaml');
const HOLDOUT_NOTE = 'none yet (seeded data is burned)';

const DEFAULT_GATES = {
  min_trades_total: 60,
  min_trades_per_fold: 15,
  folds_positive_min: 4,
  min_profit_factor: 1.10,
  max_dd_r_multiple_of_daily_cap: 10,
  bootstrap_n: 1000,
  bootstrap_seed: 20260903,
  psr_report_only: true,
  psr_report_only_below_trades: 150,
  psr_min: 0.95,
  blocked_below_trades: 10,
};

// Minimal flat "key: value  # comment" YAML reader so the verifier works before `npm install` in desk/.
// js-yaml (desk/node_modules) is used when present.
function parseFlatYaml(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9_\-.]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null' || v === '~' || v === '') v = null;
    else if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) v = +v;
    out[m[1]] = v;
  }
  return out;
}

function parseYaml(text) {
  try { return require('js-yaml').load(text); } catch (_) { return parseFlatYaml(text); }
}

/** loadGatesConfig(file?) → { ...DEFAULT_GATES, ...yaml, _sha: sha256 of the file text, _file } */
function loadGatesConfig(file = GATES_YAML) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { text = ''; }
  const parsed = text ? parseYaml(text) || {} : {};
  const cfg = { ...DEFAULT_GATES };
  for (const [k, v] of Object.entries(parsed)) if (v != null && k in DEFAULT_GATES) cfg[k] = v;
  cfg._sha = crypto.createHash('sha256').update(text || JSON.stringify(DEFAULT_GATES)).digest('hex');
  cfg._file = file;
  return cfg;
}

function n(v) { return v == null ? null : +v; }

/**
 * verify({ research: { metrics, trades }, folds, nTrials, profile, config? }) →
 *   { verdict: 'PASS'|'REJECT'|'BLOCKED', gates: [{ gate, value, threshold, pass, note? }],
 *     failing_gate, holdout, n_trials, gates_config_sha, blocked_reason?, psr }
 * research.metrics = engine metrics() of the research run; research.trades = its trade records.
 * folds = runFolds() output. nTrials = research_ledger count (already incremented for this trial).
 * BLOCKED = not enough to evaluate (missing inputs / too thin); REJECT = evaluated and a gate failed.
 */
function verify({ research, folds, nTrials, profile, config } = {}) {
  const cfg = config && config._sha ? config : { ...loadGatesConfig(), ...(config || {}) };
  const base = { holdout: HOLDOUT_NOTE, n_trials: n(nTrials), gates_config_sha: cfg._sha, gates: [], failing_gate: null };

  const blocked = (reason) => ({ ...base, verdict: 'BLOCKED', blocked_reason: reason });
  const trades = research && Array.isArray(research.trades) ? research.trades : null;
  const M = research && research.metrics;
  if (!trades || !M) return blocked('research metrics/trades missing');
  if (trades.length < cfg.blocked_below_trades) return blocked(`only ${trades.length} trades (< ${cfg.blocked_below_trades}) — too thin to evaluate`);
  if (!folds || !Array.isArray(folds.folds) || !folds.folds.length) return blocked('fold results missing');
  if (!profile || !(n(profile.max_daily_loss_r) > 0)) return blocked('risk profile max_daily_loss_r missing');
  if (!(n(nTrials) >= 1)) return blocked('n_trials missing (research ledger not consulted)');

  const gates = [];
  const push = (gate, value, threshold, pass, extra = {}) => gates.push({ gate, value, threshold, pass: !!pass, ...extra });

  // 1. enough trades overall
  push('min_trades_total', trades.length, cfg.min_trades_total, trades.length >= cfg.min_trades_total);

  // 2. every fold has enough trades to mean anything
  const minFold = folds.min_trades_per_fold != null ? folds.min_trades_per_fold : Math.min(...folds.folds.map((f) => f.trades));
  push('min_trades_per_fold', minFold, cfg.min_trades_per_fold, minFold >= cfg.min_trades_per_fold);

  // 3. fold consistency (NOT walk-forward)
  const fp = folds.folds_positive != null ? folds.folds_positive : folds.folds.filter((f) => f.positive).length;
  push('folds_positive_min', fp, cfg.folds_positive_min, fp >= cfg.folds_positive_min, { note: `${fp}/${folds.folds.length} folds net_r>0 and PF>1` });

  // 4. profit factor
  const pf = M.profit_factor == null ? (M.net_r > 0 ? Infinity : 0) : +M.profit_factor;
  push('min_profit_factor', M.profit_factor == null ? (pf === Infinity ? 'inf' : 0) : pf, cfg.min_profit_factor, pf >= cfg.min_profit_factor);

  // 5. drawdown vs the daily cap Mike set
  const ddCap = +(cfg.max_dd_r_multiple_of_daily_cap * n(profile.max_daily_loss_r)).toFixed(2);
  push('max_dd_r', n(M.max_dd_r), ddCap, n(M.max_dd_r) <= ddCap, { note: `${cfg.max_dd_r_multiple_of_daily_cap} × max_daily_loss_r ${profile.max_daily_loss_r}` });

  // 6. bootstrap P(net R > 0) vs a trial-penalized threshold
  const rs = trades.map((t) => +t.r || 0);
  const p = bootstrapPPositive(rs, cfg.bootstrap_n, cfg.bootstrap_seed);
  const thr = +trialPenalizedThreshold(nTrials).toFixed(4);
  push('bootstrap_p_positive', p, thr, p >= thr, { note: `n=${cfg.bootstrap_n} seed=${cfg.bootstrap_seed}; threshold = 1 − 0.05/log2(n_trials+2), n_trials=${nTrials}` });

  // 7. PSR / deflated Sharpe on per-trade R — report-only until enough trades
  const psr = psrReport(trades, nTrials);
  const reportOnly = cfg.psr_report_only && trades.length < cfg.psr_report_only_below_trades;
  push('psr', psr.psr, cfg.psr_min, reportOnly ? true : psr.psr >= cfg.psr_min, {
    report_only: reportOnly,
    note: reportOnly ? `report-only until ${cfg.psr_report_only_below_trades} trades (have ${trades.length})` : 'enforced',
  });
  push('deflated_sharpe', psr.sharpe_annual, psr.deflated_benchmark_sharpe, reportOnly ? true : psr.beats_deflated, {
    report_only: reportOnly,
    note: reportOnly ? 'report-only: annualized per-trade Sharpe vs expected max of n_trials random tries' : 'enforced: sharpe_annual > deflated benchmark',
  });

  const failing = gates.find((g) => !g.pass);
  return {
    ...base,
    verdict: failing ? 'REJECT' : 'PASS',
    gates,
    failing_gate: failing ? failing.gate : null,
    psr,
  };
}

module.exports = { verify, loadGatesConfig, parseFlatYaml, DEFAULT_GATES, HOLDOUT_NOTE, GATES_YAML };
