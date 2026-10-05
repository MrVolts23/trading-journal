const test = require('node:test');
const assert = require('node:assert/strict');
const { anchoredFolds, runFolds, isPositive } = require('../src/math/folds');

// 1000 one-minute bars starting at t=1_000_000
const m1 = Array.from({ length: 1000 }, (_, i) => ({ t: 1_000_000 + i * 60, o: 1, h: 1, l: 1, c: 1 }));

test('anchoredFolds: 5 contiguous slices covering every bar', () => {
  const f = anchoredFolds(m1, 5);
  assert.equal(f.length, 5);
  assert.equal(f[0].from_t, m1[0].t);
  assert.equal(f[4].to_t, m1[999].t + 1);
  for (let i = 1; i < 5; i++) assert.equal(f[i].from_t, f[i - 1].to_t);
  assert.equal(f.reduce((a, x) => a + x.bars, 0), 1000);
  assert.deepEqual(f.map((x) => x.index), [1, 2, 3, 4, 5]);
  assert.deepEqual(anchoredFolds([], 5), []);
});

test('runFolds: warm-up = all prior bars, countFrom = fold.from_t, folds_positive counts net_r>0 AND PF>1', () => {
  const calls = [];
  // Stub engine: one trade per 20 bars; folds 1,2,4,5 profitable, fold 3 a loser.
  const engineRun = (bars, params) => {
    calls.push({ nBars: bars.length, countFrom: params.countFrom, rr: params.rr });
    const trades = [];
    for (let i = 0; i < bars.length; i += 20) {
      const t = bars[i].t;
      if (t < params.countFrom) continue;
      const foldIdx = Math.floor((t - m1[0].t) / (200 * 60)); // 0..4
      const k = i / 20;
      const r = foldIdx === 2 ? (k % 3 === 0 ? 1 : -1) : (k % 3 === 0 ? -1 : 1.2);
      trades.push({ entryT: t, exitT: t + 60, r });
    }
    return { trades, warmupBars: bars.filter((b) => b.t < params.countFrom).length };
  };
  const res = runFolds(engineRun, m1, { rr: 2 }, 5);
  assert.equal(res.n_folds, 5);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].nBars, 200);
  assert.equal(calls[4].nBars, 1000);
  assert.equal(calls[2].countFrom, res.folds[2].from_t);
  assert.equal(calls[0].rr, 2);
  assert.equal(res.folds[0].warmup_bars, 0);
  assert.equal(res.folds[3].warmup_bars, 600);
  assert.deepEqual(res.folds.map((f) => f.trades), [10, 10, 10, 10, 10]);
  assert.deepEqual(res.folds.map((f) => f.positive), [true, true, false, true, true]);
  assert.equal(res.folds_positive, 4);
  assert.equal(res.min_trades_per_fold, 10);
  assert.ok(res.folds[2].metrics.net_r < 0);
  for (const f of res.folds) assert.ok(f.metrics.trades === f.trades);
});

test('runFolds filters trades defensively when the engine ignores countFrom', () => {
  const engineRun = (bars) => ({ trades: bars.filter((_, i) => i % 50 === 0).map((b) => ({ entryT: b.t, exitT: b.t + 60, r: 1 })) });
  const res = runFolds(engineRun, m1, {}, 4);
  assert.deepEqual(res.folds.map((f) => f.trades), [5, 5, 5, 5]);
  assert.equal(res.folds[1].warmup_bars, 250);
  assert.equal(res.folds_positive, 4);
});

test('isPositive semantics', () => {
  assert.equal(isPositive({ trades: 5, net_r: 2, profit_factor: 1.5 }), true);
  assert.equal(isPositive({ trades: 5, net_r: 2, profit_factor: null }), true);   // no losers
  assert.equal(isPositive({ trades: 5, net_r: 0.5, profit_factor: 1.0 }), false); // PF must exceed 1
  assert.equal(isPositive({ trades: 0 }), false);
});
