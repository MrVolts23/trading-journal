// Quant Desk — risk rails as an engine entry gate (pure). Demo-only.
//
// makeEntryGate(profile) returns params.entryGate for desk/engine/engine.js:
//   gate(ctx) → boolean, ctx = { t, dir, session, armType, entry, sl, risk, tradesSoFar (CLOSED trades,
//   close order), openCount }. Return false to skip the entry (the arm's entriesLeft is NOT consumed).
//
// Rules (all values come from the risk profile; every one is manual/editable):
//   max_daily_loss_r        stop entries for the PT day once closed R for that day <= −max (default 2.0)
//   max_trades_per_day      closed trades entered today + open positions >= max → stop
//   max_trades_per_session  same, restricted to ctx.session
//   max_consecutive_losses  N consecutive closed losers (r < 0) today → stop for the day
//   max_concurrent          NOT enforced here — pass profile.max_concurrent as params.maxConcurrent (engine owns it)
//   sessions                NOT enforced here — the CALLER sets params.windows = profile.sessions
//                           (engineParamsFromProfile() below builds that for you).
// A day = PT calendar day (PT = server − 10h), same as the engine's ptHour convention.

const { ptDate } = require('./periods');

function engineParamsFromProfile(profile = {}) {
  const p = {};
  if (Array.isArray(profile.sessions) && profile.sessions.length) {
    p.windows = profile.sessions.map((s) => ({ name: s.name, start: +s.start, end: +s.end }));
  }
  if (profile.max_concurrent != null) p.maxConcurrent = +profile.max_concurrent;
  if (profile.cost_model) {
    if (profile.cost_model.spreadUsd != null) p.spreadUsd = +profile.cost_model.spreadUsd;
    if (profile.cost_model.slippageUsd != null) p.slippageUsd = +profile.cost_model.slippageUsd;
  }
  return p;
}

function num(v, dflt) { return v == null || v === '' ? dflt : +v; }

function makeEntryGate(profile = {}) {
  const maxDailyLoss = num(profile.max_daily_loss_r, 2.0);
  const maxPerDay = num(profile.max_trades_per_day, null);
  const maxPerSession = num(profile.max_trades_per_session, null);
  const maxConsec = num(profile.max_consecutive_losses, null);

  return function entryGate(ctx) {
    const today = ptDate(ctx.t);
    const closed = ctx.tradesSoFar || [];
    const openCount = ctx.openCount || 0;

    // Walk back over today's closed trades (close order → contiguous tail).
    let dayR = 0, enteredToday = 0, sessionToday = 0, consecLosses = 0, consecBroken = false;
    for (let i = closed.length - 1; i >= 0; i--) {
      const tr = closed[i];
      // engine stamps pt_date = PT day the R was REALIZED (exit) and entry_pt_date = PT day of entry
      const exitDay = tr.pt_exit_date || tr.pt_date || ptDate(tr.exitT ?? tr.entryT);
      if (exitDay !== today) break;
      const r = +tr.r || 0;
      dayR += r;
      if (!consecBroken) { if (r < 0) consecLosses++; else consecBroken = true; }
      const entryDay = tr.entry_pt_date || ptDate(tr.entryT ?? tr.exitT);
      if (entryDay === today) {
        enteredToday++;
        if (tr.session === ctx.session) sessionToday++;
      }
    }

    if (maxDailyLoss != null && maxDailyLoss > 0 && dayR <= -maxDailyLoss) return false;
    if (maxPerDay != null && maxPerDay > 0 && enteredToday + openCount >= maxPerDay) return false;
    if (maxPerSession != null && maxPerSession > 0 && sessionToday + openCount >= maxPerSession) return false;
    if (maxConsec != null && maxConsec > 0 && consecLosses >= maxConsec) return false;
    return true;
  };
}

/**
 * railsReport(trades, profile) → { daily_cap_hits, days_stopped: [...], worst_day_r, worst_day, days, by_day }
 * Post-hoc view of closed trades per PT day (keyed by exit day).
 */
function railsReport(trades, profile = {}) {
  const maxDailyLoss = num(profile.max_daily_loss_r, 2.0);
  const byDay = {};
  for (const tr of trades || []) {
    const d = tr.pt_exit_date || tr.pt_date || ptDate(tr.exitT ?? tr.entryT);
    (byDay[d] ||= { trades: 0, net_r: 0 });
    byDay[d].trades++;
    byDay[d].net_r = +(byDay[d].net_r + (+tr.r || 0)).toFixed(3);
  }
  const days = Object.keys(byDay).sort();
  const stopped = days.filter((d) => maxDailyLoss > 0 && byDay[d].net_r <= -maxDailyLoss);
  let worst = null, worstDay = null;
  for (const d of days) if (worst == null || byDay[d].net_r < worst) { worst = byDay[d].net_r; worstDay = d; }
  return {
    max_daily_loss_r: maxDailyLoss,
    daily_cap_hits: stopped.length,
    days_stopped: stopped,
    worst_day_r: worst,
    worst_day: worstDay,
    days: days.length,
    by_day: byDay,
  };
}

module.exports = { makeEntryGate, railsReport, engineParamsFromProfile };
