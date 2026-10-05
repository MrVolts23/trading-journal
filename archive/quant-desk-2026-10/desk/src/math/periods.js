// Quant Desk — period math (pure; no DB, no model calls).
//
// PT convention matches the engine: PT = server wall-clock − 10h (see loops/backtest/engine.js ptHour).
// Bar/trade timestamps are unix seconds of the SERVER wall clock encoded as UTC.
//
// "Highest RR" per Mike = the realized R result over a PERIOD (week or month):
//   net R, win/loss counts, avg win R, avg loss R, RR = avgWinR / |avgLossR|, trades per period.

const PT_OFFSET_S = 10 * 3600;

function ptDateObj(t) {
  return new Date((t - PT_OFFSET_S) * 1000);
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 'YYYY-MM-DD' in PT. */
function ptDate(t) {
  const d = ptDateObj(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 'YYYY-MM' in PT. */
function monthKey(t) {
  const d = ptDateObj(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** ISO-8601 week key 'YYYY-Www' in PT (weeks start Monday; week 1 holds Jan 4). */
function isoWeekKey(t) {
  const d = ptDateObj(t);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // nearest Thursday
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad2(week)}`;
}

/** All three keys for a timestamp. */
function ptKeys(t) {
  return { pt_date: ptDate(t), week: isoWeekKey(t), month: monthKey(t) };
}

// A trade is REALIZED when it closes, so periods are keyed by exitT. The engine (desk/engine)
// stamps week/month on each trade record; when present those are used verbatim so the desk and
// the engine never disagree. Fallback: compute from exitT (then entryT).
function tradePeriodKey(trade, window) {
  if (window === 'week' && trade.week) return trade.week;
  if (window === 'month' && trade.month) return trade.month;
  const t = trade.exitT ?? trade.entryT;
  if (t == null) throw new Error('periodStats: trade has no exitT/entryT');
  return window === 'week' ? isoWeekKey(t) : monthKey(t);
}

function round(x, dp = 3) { return x == null ? null : +(+x).toFixed(dp); }
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * periodStats(trades, 'week'|'month') →
 *   { window, periods: [{ key, trades, wins, losses, net_r, avg_win_r, avg_loss_r, rr, win_rate,
 *                         net_usd?, unsizable? }], summary: {...} }
 * periods sorted ascending by key. Win = r > 0, loss = r <= 0 (same convention as engine metrics()).
 * rr = avg_win_r / |avg_loss_r|, null when the period has no losses (or no wins → 0).
 * net_usd appears only when trades carry pnl_usd (from sizing.js).
 */
function periodStats(trades, window = 'week') {
  if (window !== 'week' && window !== 'month') throw new Error(`periodStats: window must be week|month, got ${window}`);
  const buckets = new Map();
  for (const tr of trades || []) {
    const key = tradePeriodKey(tr, window);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(tr);
  }
  const keys = [...buckets.keys()].sort();
  const anyUsd = (trades || []).some((t) => typeof t.pnl_usd === 'number');
  const periods = keys.map((key) => {
    const list = buckets.get(key);
    const rs = list.map((t) => +t.r || 0);
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r <= 0);
    const net = rs.reduce((a, b) => a + b, 0);
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null;
    let rr = null;
    if (avgLoss != null && avgLoss !== 0) rr = avgWin == null ? 0 : avgWin / Math.abs(avgLoss);
    const row = {
      key,
      trades: list.length,
      wins: wins.length,
      losses: losses.length,
      net_r: round(net, 2),
      avg_win_r: round(avgWin, 3),
      avg_loss_r: round(avgLoss, 3),
      rr: round(rr, 3),
      win_rate: round(wins.length / list.length, 3),
    };
    if (anyUsd) {
      row.net_usd = round(list.reduce((a, t) => a + (typeof t.pnl_usd === 'number' ? t.pnl_usd : 0), 0), 2);
      row.unsizable = list.filter((t) => t.unsizable).length;
    }
    return row;
  });
  return { window, periods, summary: periodSummary(periods) };
}

function periodSummary(periods) {
  const netRs = periods.map((p) => p.net_r);
  const rrs = periods.map((p) => p.rr).filter((x) => x != null);
  return {
    periods: periods.length,
    positive_periods: periods.filter((p) => p.net_r > 0).length,
    median_period_r: round(median(netRs), 2),
    worst_period_r: netRs.length ? round(Math.min(...netRs), 2) : null,
    best_period_r: netRs.length ? round(Math.max(...netRs), 2) : null,
    median_rr: round(median(rrs), 3),
    avg_trades_per_period: periods.length ? round(periods.reduce((a, p) => a + p.trades, 0) / periods.length, 2) : null,
    net_r: round(netRs.reduce((a, b) => a + b, 0), 2),
  };
}

module.exports = { PT_OFFSET_S, ptDate, monthKey, isoWeekKey, ptKeys, periodStats, periodSummary, median };
