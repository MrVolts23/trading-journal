const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { verify, loadGatesConfig, parseFlatYaml, DEFAULT_GATES, HOLDOUT_NOTE } = require('../src/math/gates');
const { rMetrics } = require('../src/math/stats');
const { trialPenalizedThreshold } = require('../src/math/bootstrap');

const profile = { max_daily_loss_r: 2.0 };
const cfg = loadGatesConfig();

// n trades spread over ~90 days; pattern gives a solid edge
function goodTrades(n) {
  const out = [];
  const pattern = [1.8, -1, 2.2, -1, 1.5, -0.6, 2.0, -1];
  for (let i = 0; i < n; i++) {
    const t = 1_700_000_000 + i * (90 * 86400 / n);
    out.push({ entryT: t, exitT: t + 1800, r: pattern[i % pattern.length], session: i % 2 ? 'ny' : 'asia' });
  }
  return out;
}
function badTrades(n) {
  const out = [];
  const pattern = [0.8, -1, -1, 0.9, -1, -1, 1.0, -1];
  for (let i = 0; i < n; i++) {
    const t = 1_700_000_000 + i * (90 * 86400 / n);
    out.push({ entryT: t, exitT: t + 1800, r: pattern[i % pattern.length], session: 'ny' });
  }
  return out;
}
function foldsFor(trades, nFolds = 5) {
  const per = Math.floor(trades.length / nFolds);
  const folds = [];
  for (let i = 0; i < nFolds; i++) {
    const slice = trades.slice(i * per, (i + 1) * per);
    const m = rMetrics(slice);
    folds.push({ index: i + 1, from_t: slice[0]?.entryT ?? 0, to_t: (slice[slice.length - 1]?.entryT ?? 0) + 1, trades: slice.length, metrics: m, positive: m.net_r > 0 && (m.profit_factor == null || m.profit_factor > 1) });
  }
  return { n_folds: nFolds, folds, folds_positive: folds.filter((f) => f.positive).length, min_trades_per_fold: Math.min(...folds.map((f) => f.trades)) };
}

test('gates.yaml loads (flat parser fallback works) and every default is present', () => {
  const text = fs.readFileSync(path.join(__dirname, '../config/gates.yaml'), 'utf8');
  const flat = parseFlatYaml(text);
  for (const k of Object.keys(DEFAULT_GATES)) assert.ok(k in flat, `gates.yaml missing ${k}`);
  assert.equal(flat.min_trades_total, 60);
  assert.equal(flat.psr_report_only, true);
  assert.equal(cfg.min_trades_per_fold, 15);
  assert.match(cfg._sha, /^[0-9a-f]{64}$/);
  assert.ok((text.match(/claude-assumed/g) || []).length >= 10, 'every threshold must be tagged claude-assumed');
});

test('risk-profile.defaults.yaml exists with the mike-confirmed daily cap', () => {
  const text = fs.readFileSync(path.join(__dirname, '../config/risk-profile.defaults.yaml'), 'utf8');
  assert.match(text, /max_daily_loss_r:\s*2\.0/);
  assert.match(text, /max_daily_loss_r:\s*mike-confirmed/);
  assert.match(text, /risk_pct_per_trade:\s*1\.0/);
  assert.match(text, /account_size:\s*3454\.22/);
  let yaml = null;
  try { yaml = require('js-yaml'); } catch (_) { /* not installed yet — owner C's npm install */ }
  if (yaml) {
    const p = yaml.load(text);
    assert.equal(p.name, 'Gold 1% demo');
    assert.equal(p.sessions.length, 2);
    assert.equal(p.provenance.max_daily_loss_r, 'mike-confirmed');
    assert.equal(p.symbol_facts.usd_per_point_per_lot, 100);
  }
});

test('PASS: healthy research + 5 positive folds, all gates listed with value+threshold', () => {
  const trades = goodTrades(120);
  const v = verify({ research: { metrics: rMetrics(trades), trades }, folds: foldsFor(trades), nTrials: 100, profile });
  assert.equal(v.verdict, 'PASS', JSON.stringify(v.gates));
  assert.equal(v.failing_gate, null);
  assert.equal(v.holdout, HOLDOUT_NOTE);
  assert.equal(v.n_trials, 100);
  assert.equal(v.gates_config_sha, cfg._sha);
  const names = v.gates.map((g) => g.gate);
  assert.deepEqual(names, ['min_trades_total', 'min_trades_per_fold', 'folds_positive_min', 'min_profit_factor', 'max_dd_r', 'bootstrap_p_positive', 'psr', 'deflated_sharpe']);
  for (const g of v.gates) {
    assert.ok('value' in g && 'threshold' in g && typeof g.pass === 'boolean', JSON.stringify(g));
  }
  const bp = v.gates.find((g) => g.gate === 'bootstrap_p_positive');
  assert.equal(bp.threshold, +trialPenalizedThreshold(100).toFixed(4));
  const psr = v.gates.find((g) => g.gate === 'psr');
  assert.equal(psr.report_only, true); // 120 < 150
  assert.equal(v.psr.n, 120);
});

test('PSR is enforced once trades >= 150', () => {
  const trades = goodTrades(200);
  const v = verify({ research: { metrics: rMetrics(trades), trades }, folds: foldsFor(trades), nTrials: 100, profile });
  const psr = v.gates.find((g) => g.gate === 'psr');
  assert.equal(psr.report_only, false);
  assert.equal(v.verdict, 'PASS', JSON.stringify(v.gates));
});

test('REJECT: losing strategy fails profit factor / bootstrap; failing_gate is the first failure', () => {
  const trades = badTrades(120);
  const v = verify({ research: { metrics: rMetrics(trades), trades }, folds: foldsFor(trades), nTrials: 100, profile });
  assert.equal(v.verdict, 'REJECT');
  assert.equal(v.failing_gate, 'folds_positive_min');
  assert.ok(v.gates.find((g) => g.gate === 'min_profit_factor').pass === false);
  assert.ok(v.gates.find((g) => g.gate === 'bootstrap_p_positive').pass === false);
});

test('REJECT: too few trades in total / per fold / one bad fold', () => {
  const trades = goodTrades(50);
  const v = verify({ research: { metrics: rMetrics(trades), trades }, folds: foldsFor(trades), nTrials: 5, profile });
  assert.equal(v.verdict, 'REJECT');
  assert.equal(v.failing_gate, 'min_trades_total');
  assert.equal(v.gates.find((g) => g.gate === 'min_trades_per_fold').pass, false); // 10 per fold

  const good = goodTrades(120);
  const folds = foldsFor(good);
  folds.folds[2].positive = false; folds.folds[3].positive = false; folds.folds_positive = 3;
  const v2 = verify({ research: { metrics: rMetrics(good), trades: good }, folds, nTrials: 100, profile });
  assert.equal(v2.verdict, 'REJECT');
  assert.equal(v2.failing_gate, 'folds_positive_min');
});

test('REJECT: drawdown above 10 × max_daily_loss_r', () => {
  const trades = goodTrades(120);
  const m = { ...rMetrics(trades), max_dd_r: 25 };
  const v = verify({ research: { metrics: m, trades }, folds: foldsFor(trades), nTrials: 100, profile });
  assert.equal(v.verdict, 'REJECT');
  assert.equal(v.failing_gate, 'max_dd_r');
  assert.equal(v.gates.find((g) => g.gate === 'max_dd_r').threshold, 20);
});

test('BLOCKED: missing research, thin data, missing folds, missing profile cap, missing n_trials', () => {
  assert.equal(verify({}).verdict, 'BLOCKED');
  const few = goodTrades(5);
  const b1 = verify({ research: { metrics: rMetrics(few), trades: few }, folds: foldsFor(few), nTrials: 1, profile });
  assert.equal(b1.verdict, 'BLOCKED');
  assert.match(b1.blocked_reason, /too thin/);
  const trades = goodTrades(120);
  assert.equal(verify({ research: { metrics: rMetrics(trades), trades }, folds: null, nTrials: 1, profile }).verdict, 'BLOCKED');
  assert.equal(verify({ research: { metrics: rMetrics(trades), trades }, folds: foldsFor(trades), nTrials: 1, profile: {} }).verdict, 'BLOCKED');
  assert.equal(verify({ research: { metrics: rMetrics(trades), trades }, folds: foldsFor(trades), profile }).verdict, 'BLOCKED');
  for (const b of [b1]) { assert.equal(b.holdout, HOLDOUT_NOTE); assert.deepEqual(b.gates, []); assert.equal(b.failing_gate, null); }
});

test('config override via the config argument', () => {
  const trades = goodTrades(120);
  const v = verify({ research: { metrics: rMetrics(trades), trades }, folds: foldsFor(trades), nTrials: 100, profile, config: { min_trades_total: 500 } });
  assert.equal(v.verdict, 'REJECT');
  assert.equal(v.failing_gate, 'min_trades_total');
  assert.equal(v.gates[0].threshold, 500);
});
