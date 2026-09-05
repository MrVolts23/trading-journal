const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrapPPositive, trialPenalizedThreshold, mulberry32 } = require('../src/math/bootstrap');

test('bootstrapPPositive is deterministic per seed and bounded', () => {
  const rs = [1, -1, 2, -0.5, 1.5, -1, 0.5, 2, -1, 0.8, -0.7, 1.1];
  const a = bootstrapPPositive(rs, 1000, 42);
  const b = bootstrapPPositive(rs, 1000, 42);
  assert.equal(a, b);
  assert.ok(a > 0.8 && a <= 1, `p=${a}`);
  const c = bootstrapPPositive(rs, 1000, 7);
  assert.ok(Math.abs(a - c) < 0.1);
  assert.equal(bootstrapPPositive([1, 2, 3], 200, 1), 1);
  assert.equal(bootstrapPPositive([-1, -2], 200, 1), 0);
  assert.equal(bootstrapPPositive([], 200, 1), null);
});

test('trialPenalizedThreshold = 1 − 0.05/log2(n+2)', () => {
  assert.equal(trialPenalizedThreshold(0), 0.95);
  assert.ok(Math.abs(trialPenalizedThreshold(100) - (1 - 0.05 / Math.log2(102))) < 1e-12);
  assert.ok(trialPenalizedThreshold(1000) > trialPenalizedThreshold(100));
  assert.ok(trialPenalizedThreshold(100) < 1);
});

test('mulberry32 reproducible', () => {
  const a = mulberry32(123), b = mulberry32(123);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});
