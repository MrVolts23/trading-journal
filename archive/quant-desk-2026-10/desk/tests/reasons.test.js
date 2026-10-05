// Quant Desk — reasons.js: one English sentence per verdict, English gate labels, no snake_case leaks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reasonFor, gateLabel, gateRows, verdictWord, GATE_LABELS } = require('../src/reasons');

const gate = (name, value, threshold, pass, extra = {}) => ({ gate: name, value, threshold, pass, ...extra });
const reject = (failing, gates, extra = {}) => ({ verdict: 'REJECT', failing_gate: failing, gates, ...extra });

test('PASS and BLOCKED read as sentences', () => {
  assert.equal(reasonFor({ verdict: 'PASS', gates: [] }), 'passed every gate');
  assert.equal(reasonFor({ verdict: 'BLOCKED', blocked_reason: 'only 4 trades (< 10) — too thin to evaluate' }), "couldn't be judged: only 4 trades, too few to judge");
  assert.match(reasonFor({ verdict: 'BLOCKED' }), /^couldn't be judged: /);
  assert.equal(reasonFor({ verdict: 'BLOCKED', blocked_reason: 'only 0 trades (< 10) — too thin to evaluate' }), "couldn't be judged: the rules never took a trade, so there is nothing to judge");
  // bench.js stores the verifier's blocked_reason in the failing_gate column; it must read the same way
  assert.equal(reasonFor({ verdict: 'BLOCKED', failing_gate: 'only 7 trades (< 10) — too thin to evaluate', gates: [] }), "couldn't be judged: only 7 trades, too few to judge");
  assert.equal(reasonFor(null), 'not tested yet');
});

test('each failing gate has its own sentence with the numbers filled in', () => {
  assert.equal(reasonFor(reject('folds_positive_min', [gate('folds_positive_min', 3, 4, false, { note: '3/5 folds net_r>0 and PF>1' })])),
    'only 3 of 5 stretches of the data were profitable (needs 4)');
  assert.equal(reasonFor(reject('bootstrap_p_positive', [gate('bootstrap_p_positive', 0.774, 0.9925, false)])),
    "the edge can't be told apart from luck yet (77% confidence, needs 99%)");
  assert.equal(reasonFor(reject('min_trades_total', [gate('min_trades_total', 41, 60, false)])), 'not enough trades yet (41, needs 60)');
  assert.equal(reasonFor(reject('min_trades_per_fold', [gate('min_trades_per_fold', 9, 15, false)])), 'one stretch had too few trades (9, needs 15)');
  assert.equal(reasonFor(reject('min_profit_factor', [gate('min_profit_factor', 1.04, 1.1, false)])), "wins didn't outweigh losses enough (profit factor 1.04, needs 1.1)");
  assert.equal(reasonFor(reject('max_dd_r', [gate('max_dd_r', 23.5, 20, false)])), 'drawdown too deep (23.5R, limit 20R)');
  assert.equal(reasonFor(reject('psr', [gate('psr', 0.6, 0.95, false)])), "the result isn't statistically solid yet");
  assert.equal(reasonFor(reject('deflated_sharpe', [gate('deflated_sharpe', 1.2, 5.8, false)], { n_trials_at: 103 })), 'not better than the best of 103 random tries');
});

test('the first failing gate wins when failing_gate is missing', () => {
  const v = { verdict: 'REJECT', gates: [gate('min_trades_total', 239, 60, true), gate('max_dd_r', 25, 20, false), gate('psr', 0.5, 0.95, false)] };
  assert.equal(reasonFor(v), 'drawdown too deep (25R, limit 20R)');
});

test('no sentence contains a raw gate key or an em-dash', () => {
  const keys = Object.keys(GATE_LABELS);
  const samples = keys.map((k) => reasonFor(reject(k, [gate(k, 1, 2, false)], { n_trials_at: 5 })));
  samples.push(reasonFor({ verdict: 'PASS' }), reasonFor({ verdict: 'BLOCKED', blocked_reason: 'fold results missing' }));
  for (const s of samples) {
    for (const k of keys) assert.ok(!s.includes(k), `${s} leaks ${k}`);
    assert.ok(!s.includes('—'), `${s} has an em-dash`);
    assert.ok(!/_/.test(s), `${s} has snake_case`);
  }
});

test('gateLabel and gateRows give English labels and formatted needs', () => {
  for (const k of Object.keys(GATE_LABELS)) assert.ok(!/_/.test(gateLabel(k)), k);
  assert.equal(gateLabel('some_new_gate'), 'Some new gate');
  const rows = gateRows([
    gate('bootstrap_p_positive', 0.774, 0.9925, false),
    gate('folds_positive_min', 3, 4, false, { note: '3/5 folds net_r>0 and PF>1' }),
    gate('max_dd_r', 12.97, 20, true),
    gate('psr', 0.78, 0.95, true, { report_only: true }),
  ], 103);
  assert.deepEqual(rows.map((r) => r.label), ['Confidence the edge is real', 'Profitable stretches', 'Deepest drawdown (R)', 'Statistically solid']);
  assert.equal(rows[0].value, '77%'); assert.equal(rows[0].needed, 'at least 99%');
  assert.equal(rows[1].value, '3 of 5'); assert.equal(rows[1].needed, 'at least 4');
  assert.equal(rows[2].value, '12.97R'); assert.equal(rows[2].needed, 'at most 20R'); assert.equal(rows[2].pass, true);
  assert.equal(rows[3].report_only, true); assert.equal(rows[3].note, 'reported, not enforced yet');
});

test('verdictWord maps REJECT to FAIL', () => {
  assert.equal(verdictWord('REJECT'), 'FAIL');
  assert.equal(verdictWord('PASS'), 'PASS');
  assert.equal(verdictWord('BLOCKED'), 'BLOCKED');
  assert.equal(verdictWord({ verdict: 'REJECT' }), 'FAIL');
  assert.equal(verdictWord(null), null);
});
