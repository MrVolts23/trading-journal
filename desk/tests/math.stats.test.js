const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/math/stats');

// Reference values produced by running loop-engineering starters/quant-research-loop/engine/stats.py
// (Python stdlib) on the same series — a faithful-port check, not a self-check.
const xs = [1.0, -1.0, 2.0, -0.5, 1.5, -1.0, 0.5, 2.0, -1.0, 0.8];
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('mean / stdev / skew / kurtosis match the Python reference', () => {
  close(S.mean(xs), 0.43);
  close(S.stdev(xs), 1.2266032592307732);
  close(S.skew(xs), -0.02829415976808571);
  close(S.kurtosis(xs), 1.1874203772768197);
});

test('norm_cdf', () => {
  close(S.norm_cdf(1.96), 0.9750021048517796);
  close(S.norm_cdf(-0.5), 0.30853753872598694);
  close(S.norm_cdf(0), 0.5);
});

test('sharpe / probabilistic_sharpe match the Python reference', () => {
  close(S.sharpe(xs, 100), 3.5056159908596802);
  close(S.probabilistic_sharpe(xs, 0, 100), 0.8516501333972971);
  close(S.probabilistic_sharpe(xs, 0.5, 100), 0.8145259823750763);
  assert.equal(S.probabilistic_sharpe([1, 2, 3], 0, 10), 0);           // n < 8
  assert.equal(S.probabilistic_sharpe(new Array(10).fill(1), 0, 10), 0); // constant series
});

test('deflated_benchmark_sharpe: (1/sqrt(n_obs))·sqrt(2 ln n_trials)·sqrt(ppy)', () => {
  close(S.deflated_benchmark_sharpe(100, 100, 252), 4.817681780418876);
  close(S.deflated_benchmark_sharpe(312, 100, 900), 5.154443668772283);
  assert.equal(S.deflated_benchmark_sharpe(100, 1, 252), 0);
  assert.equal(S.deflated_benchmark_sharpe(1, 100, 252), 0);
});

test('tradesPerYear from span; psrReport shape', () => {
  const year = 365.25 * 86400;
  const trades = [];
  for (let i = 0; i < 100; i++) trades.push({ entryT: i * (year / 100), exitT: i * (year / 100) + 60, r: xs[i % xs.length] });
  const ppy = S.tradesPerYear(trades);
  close(ppy, 100 / (99 / 100 + 60 / year), 1e-6);
  const rep = S.psrReport(trades, 100);
  assert.equal(rep.n, 100);
  assert.ok(rep.psr > 0.9 && rep.psr <= 1);
  assert.ok(rep.deflated_benchmark_sharpe > 0);
  assert.equal(typeof rep.beats_deflated, 'boolean');
});

test('rMetrics reproduces the engine metrics() numbers', () => {
  const m = S.rMetrics([{ r: 1 }, { r: -1 }, { r: 2 }, { r: -0.5 }]);
  assert.equal(m.trades, 4); assert.equal(m.net_r, 1.5); assert.equal(m.profit_factor, 2);
  assert.equal(m.max_dd_r, 1); assert.equal(m.winrate, 0.5); assert.equal(m.expectancy_r, 0.375);
  assert.equal(S.rMetrics([]).trades, 0);
});
