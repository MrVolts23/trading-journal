// Quant Desk — overfitting-aware statistics (pure, stdlib only).
// Faithful port of loop-engineering starters/quant-research-loop/engine/stats.py (Bailey & López de Prado
// PSR; deflated benchmark = expected max Sharpe of n_trials random tries). Applied here to PER-TRADE R
// series, with periods_per_year = trades per year estimated from the data span.

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Sample standard deviation (n − 1). */
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Adjusted Fisher-Pearson skewness (same estimator as the reference). */
function skew(xs) {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs), s = stdev(xs);
  if (s === 0) return 0;
  return (n / ((n - 1) * (n - 2))) * xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0);
}

/** Non-excess kurtosis (normal == 3), reference estimator: mean of z^4 with sample stdev. */
function kurtosis(xs) {
  const n = xs.length;
  if (n < 4) return 3;
  const m = mean(xs), s = stdev(xs);
  if (s === 0) return 3;
  return xs.reduce((a, x) => a + ((x - m) / s) ** 4, 0) / n;
}

// erf via the complementary-error-function Chebyshev fit (Numerical Recipes erfcc), |rel err| < 1.2e-7.
function erf(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}

function norm_cdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

/** Annualized Sharpe from per-period returns (rf = 0). */
function sharpe(returns, periods_per_year) {
  const s = stdev(returns);
  if (s === 0) return 0;
  return (mean(returns) / s) * Math.sqrt(periods_per_year);
}

/**
 * Probabilistic Sharpe Ratio — P(true SR > benchmark) given sample size, skew and fat tails.
 *   z = (sr − sr_bm) · sqrt(n − 1) / sqrt(1 − g3·sr + (g4 − 1)/4 · sr²)
 * sr is per-period (per-trade here); benchmark is ANNUALIZED and converted to per-period.
 * Returns 0 when n < 8 or the series is constant (not distinguishable from noise).
 */
function probabilistic_sharpe(returns, sr_benchmark_annual = 0, periods_per_year = 1) {
  const n = returns.length;
  const s = stdev(returns);
  if (n < 8 || s === 0) return 0;
  const sr = mean(returns) / s;
  const srBm = sr_benchmark_annual / Math.sqrt(periods_per_year);
  const g3 = skew(returns), g4 = kurtosis(returns);
  const denom = Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
  const z = (sr - srBm) * Math.sqrt(n - 1) / denom;
  return norm_cdf(z);
}

/**
 * Expected MAXIMUM annualized Sharpe under the null (true SR = 0) across n_trials independent tries:
 *   (1/sqrt(n_obs)) · sqrt(2·ln(n_trials)) · sqrt(periods_per_year). Beating this is the bar for
 *   "not just the best of many random tries". 0 when n_trials <= 1 or n_obs < 2.
 */
function deflated_benchmark_sharpe(n_obs, n_trials, periods_per_year) {
  if (n_trials <= 1 || n_obs < 2) return 0;
  return (1 / Math.sqrt(n_obs)) * Math.sqrt(2 * Math.log(n_trials)) * Math.sqrt(periods_per_year);
}

/** Trades per year estimated from the data span (first entry → last exit). null if span is 0. */
function tradesPerYear(trades) {
  if (!trades || trades.length < 2) return null;
  let first = Infinity, last = -Infinity;
  for (const t of trades) {
    const a = t.entryT ?? t.exitT, b = t.exitT ?? t.entryT;
    if (a < first) first = a;
    if (b > last) last = b;
  }
  const years = (last - first) / (365.25 * 86400);
  return years > 0 ? trades.length / years : null;
}

/**
 * psrReport(trades, nTrials) → { n, periods_per_year, sharpe_annual, psr, deflated_benchmark_sharpe,
 *   beats_deflated, skew, kurtosis, mean_r, stdev_r } on the per-trade R series. Report-only fields;
 * gates.js decides whether they are enforced.
 */
function psrReport(trades, nTrials = 1) {
  const rs = (trades || []).map((t) => +t.r || 0);
  const ppy = tradesPerYear(trades) || (rs.length || 1);
  const sr = sharpe(rs, ppy);
  const defl = deflated_benchmark_sharpe(rs.length, nTrials, ppy);
  return {
    n: rs.length,
    periods_per_year: +ppy.toFixed(2),
    mean_r: +mean(rs).toFixed(4),
    stdev_r: +stdev(rs).toFixed(4),
    skew: +skew(rs).toFixed(4),
    kurtosis: +kurtosis(rs).toFixed(4),
    sharpe_annual: +sr.toFixed(4),
    psr: +probabilistic_sharpe(rs, 0, ppy).toFixed(4),
    deflated_benchmark_sharpe: +defl.toFixed(4),
    beats_deflated: sr > defl,
  };
}

/** Same numbers as the engine's metrics() for a plain R series (used by folds when no metrics fn is injected). */
function rMetrics(trades) {
  if (!trades || !trades.length) return { trades: 0, net_r: 0, profit_factor: null, max_dd_r: 0, winrate: null, expectancy_r: null };
  const rs = trades.map((t) => +t.r || 0);
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const netR = rs.reduce((a, b) => a + b, 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let peak = 0, dd = 0, cum = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return {
    trades: trades.length,
    winrate: +(wins.length / trades.length).toFixed(3),
    net_r: +netR.toFixed(2),
    expectancy_r: +(netR / trades.length).toFixed(3),
    profit_factor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
    max_dd_r: +dd.toFixed(2),
  };
}

module.exports = {
  mean, median, stdev, skew, kurtosis, erf, norm_cdf, sharpe,
  probabilistic_sharpe, deflated_benchmark_sharpe, tradesPerYear, psrReport, rMetrics,
};
