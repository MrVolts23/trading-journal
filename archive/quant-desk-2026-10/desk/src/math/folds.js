// Quant Desk — FOLD CONSISTENCY (pure). This is NOT walk-forward: no parameters are re-optimized per
// fold. The research window is cut into N equal-time slices; each fold is scored with the SAME params,
// using every prior bar as warm-up (anchored at the start of the data) and counting only trades whose
// entryT >= fold.from_t. A strategy that only makes its money in one slice fails fold consistency.

const { rMetrics } = require('./stats');

/**
 * anchoredFolds(m1Bars, nFolds = 5) → [{ index (1-based), from_t, to_t, bars }]
 * Bars must be chronological. from_t inclusive, to_t exclusive; the last fold's to_t = last bar t + 1.
 */
function anchoredFolds(m1Bars, nFolds = 5) {
  if (!m1Bars || m1Bars.length < 2) return [];
  const t0 = m1Bars[0].t, tEnd = m1Bars[m1Bars.length - 1].t + 1;
  const span = tEnd - t0;
  const folds = [];
  for (let i = 0; i < nFolds; i++) {
    const from_t = Math.floor(t0 + (span * i) / nFolds);
    const to_t = i === nFolds - 1 ? tEnd : Math.floor(t0 + (span * (i + 1)) / nFolds);
    let bars = 0;
    for (const b of m1Bars) if (b.t >= from_t && b.t < to_t) bars++;
    folds.push({ index: i + 1, from_t, to_t, bars });
  }
  return folds;
}

function isPositive(m) {
  if (!m || !m.trades) return false;
  if (!(m.net_r > 0)) return false;
  // profit_factor null = no losing trades at all; with net_r > 0 that counts as > 1.
  return m.profit_factor == null ? true : m.profit_factor > 1;
}

/**
 * runFolds(engineRun, m1, params, nFolds = 5, opts = {}) →
 *   { n_folds, folds: [{ index, from_t, to_t, bars, warmup_bars, trades, metrics, positive }],
 *     folds_positive, min_trades_per_fold }
 * engineRun(bars, params) is injected (desk/engine runDoubleBOS); it must honour params.countFrom.
 * opts.metrics(trades) may inject the engine's metrics(); defaults to rMetrics (same numbers).
 * Bars handed to each fold = all bars with t < fold.to_t (warm-up = everything before from_t).
 */
function runFolds(engineRun, m1, params, nFolds = 5, opts = {}) {
  const metricsFn = opts.metrics || rMetrics;
  const folds = anchoredFolds(m1, nFolds);
  const results = folds.map((fold) => {
    let end = m1.length;
    while (end > 0 && m1[end - 1].t >= fold.to_t) end--;
    const bars = m1.slice(0, end);
    const res = engineRun(bars, { ...params, countFrom: fold.from_t }) || {};
    // Defensive: filter even if the engine already did (an engine without countFrom returns everything).
    const trades = (res.trades || []).filter((t) => t.entryT >= fold.from_t && t.entryT < fold.to_t);
    let warmup = res.warmupBars;
    if (warmup == null) { warmup = 0; for (const b of bars) { if (b.t < fold.from_t) warmup++; else break; } }
    const metrics = metricsFn(trades);
    return { ...fold, warmup_bars: warmup, trades: trades.length, metrics, positive: isPositive(metrics) };
  });
  return {
    n_folds: results.length,
    folds: results,
    folds_positive: results.filter((f) => f.positive).length,
    min_trades_per_fold: results.length ? Math.min(...results.map((f) => f.trades)) : 0,
  };
}

module.exports = { anchoredFolds, runFolds, isPositive };
