// Quant Desk — seeded bootstrap (pure, deterministic).

/** mulberry32 — small, fast, seedable PRNG. Returns () => float in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * bootstrapPPositive(rs, n = 1000, seed = 1) → P(sum of a resample-with-replacement of size rs.length > 0).
 * Deterministic for a given seed. Returns null for an empty series.
 */
function bootstrapPPositive(rs, n = 1000, seed = 1) {
  const xs = (rs || []).map(Number);
  if (!xs.length) return null;
  const rnd = mulberry32(seed);
  const len = xs.length;
  let positive = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < len; k++) sum += xs[Math.floor(rnd() * len)];
    if (sum > 0) positive++;
  }
  return positive / n;
}

/**
 * trialPenalizedThreshold(n_trials) = 1 − 0.05 / log2(n_trials + 2).
 * More trials searched → a stricter bar for P(positive): 0 trials → 0.95, 100 trials → ≈0.9925.
 */
function trialPenalizedThreshold(n_trials) {
  const n = Math.max(0, +n_trials || 0);
  return 1 - 0.05 / Math.log2(n + 2);
}

module.exports = { mulberry32, bootstrapPPositive, trialPenalizedThreshold };
