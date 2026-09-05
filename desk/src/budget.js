// Quant Desk — the model budget and ledger. A daily cap in dollars (desk/config/loop-budget.yaml),
// counted per PACIFIC day from the model_calls table. Every call, success or failure, is recorded
// here; the gate runs BEFORE a call with the worst case that call could cost:
//   worst case = prompt tokens x input price + max_tokens x output price
// At or over the cap the call is refused with a plain message. No model code lives here.
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const LOOP_BUDGET_YAML = path.join(paths.CONFIG_DIR, 'loop-budget.yaml');
const DEFAULTS = { daily_cap_usd: 10, warn_at: 0.8 };
const PT = 'America/Los_Angeles';

// ── Config ────────────────────────────────────────────────────────────────────────────
let _cfgKey = null, _cfg = null;
function loadBudget() {
  let st;
  try { st = fs.statSync(LOOP_BUDGET_YAML); } catch (_) { return { ...DEFAULTS }; }
  const key = `${st.mtimeMs}`;
  if (_cfg && _cfgKey === key) return _cfg;
  let doc = {};
  try {
    const yaml = require(path.join(paths.DESK_ROOT, 'node_modules/js-yaml'));
    doc = yaml.load(fs.readFileSync(LOOP_BUDGET_YAML, 'utf8')) || {};
  } catch (_) { doc = {}; }
  const cap = Number(doc.daily_cap_usd);
  const warn = Number(doc.warn_at);
  _cfg = {
    daily_cap_usd: Number.isFinite(cap) && cap >= 0 ? cap : DEFAULTS.daily_cap_usd,
    warn_at: Number.isFinite(warn) && warn > 0 && warn <= 1 ? warn : DEFAULTS.warn_at,
  };
  _cfgKey = key;
  return _cfg;
}

// ── Pacific day math ──────────────────────────────────────────────────────────────────
function ptParts(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: PT, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour };
}
// 'YYYY-MM-DD' in Pacific time for an instant (default now).
function ptDay(now = new Date()) { return ptParts(now instanceof Date ? now : new Date(now)).date; }

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
// The UTC instant of midnight Pacific on a given PT day (PDT = 07:00Z, PST = 08:00Z; DST changes at
// 02:00 local so midnight itself is never ambiguous).
function ptMidnightUtcMs(day) {
  const [y, m, d] = day.split('-').map(Number);
  for (const h of [7, 8]) {
    const ms = Date.UTC(y, m - 1, d, h);
    const p = ptParts(new Date(ms));
    if (p.date === day && p.hour === 0) return ms;
  }
  return Date.UTC(y, m - 1, d, 8);
}
// { day, start, end } with start/end as ISO-8601 UTC strings; rows with start <= ts < end belong to the day.
function ptDayRange(day = ptDay()) {
  return { day, start: new Date(ptMidnightUtcMs(day)).toISOString(), end: new Date(ptMidnightUtcMs(addDays(day, 1))).toISOString() };
}
function nowIso() { return new Date().toISOString(); }

// ── Ledger ────────────────────────────────────────────────────────────────────────────
function spentOn(db, day) {
  const r = ptDayRange(day);
  const row = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n FROM model_calls WHERE ts >= ? AND ts < ?`).get(r.start, r.end);
  return { spent_usd: Math.round((row.usd || 0) * 1e6) / 1e6, calls: row.n || 0, ...r };
}
function spentToday(db, now = new Date()) { return spentOn(db, ptDay(now)); }

// recordCall(db, { ts?, role, provider, model, usage, cost_usd, latency_ms, stop_reason, thread_id, ok, error }) → id
function recordCall(db, c) {
  const u = c.usage || {};
  const info = db.prepare(
    `INSERT INTO model_calls (ts, role, provider, model, tokens_in, tokens_out, cache_read, cache_write, cost_usd, latency_ms, stop_reason, thread_id, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    c.ts || nowIso(), c.role || null, c.provider || null, c.model || null,
    u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
    Number(c.cost_usd) || 0, c.latency_ms == null ? null : Math.round(c.latency_ms), c.stop_reason || null,
    c.thread_id == null ? null : c.thread_id, c.ok === false || c.ok === 0 ? 0 : 1, c.error || null
  );
  return Number(info.lastInsertRowid);
}

// ── Gate ──────────────────────────────────────────────────────────────────────────────
// Conservative local token estimate (no API round trip): about 3 characters per token.
function estimateTokens(text) { return Math.ceil(String(text == null ? '' : text).length / 3); }

function worstCaseUsd({ prompt_tokens = 0, max_tokens = 0, prices }) {
  const p = prices || { input: 0, output: 0 };
  return Math.round(((prompt_tokens * (p.input || 0)) + (max_tokens * (p.output || 0))) / 1e6 * 1e6) / 1e6;
}

// precheck(db, { prompt_tokens, max_tokens, prices, now? })
//   → { ok, spent_today_usd, cap_usd, warn_at_usd, worst_case_usd, projected_usd, warn, reason }
function precheck(db, { prompt_tokens = 0, max_tokens = 0, prices, now = new Date() } = {}) {
  const cfg = loadBudget();
  const s = spentToday(db, now);
  const worst = worstCaseUsd({ prompt_tokens, max_tokens, prices });
  const projected = Math.round((s.spent_usd + worst) * 1e6) / 1e6;
  const cap = cfg.daily_cap_usd;
  const warnAt = Math.round(cap * cfg.warn_at * 100) / 100;
  const ok = projected < cap;
  return {
    ok,
    spent_today_usd: s.spent_usd,
    cap_usd: cap,
    warn_at_usd: warnAt,
    worst_case_usd: worst,
    projected_usd: projected,
    calls_today: s.calls,
    warn: ok && projected >= warnAt,
    reason: ok ? null : `today's model budget is used up ($${s.spent_usd.toFixed(2)} of $${cap.toFixed(2)}; this call could cost up to $${worst.toFixed(2)}). It resets at midnight Pacific.`,
  };
}

function statusToday(db, now = new Date()) {
  const cfg = loadBudget();
  const s = spentToday(db, now);
  const warnAt = Math.round(cfg.daily_cap_usd * cfg.warn_at * 100) / 100;
  return {
    spent_today_usd: s.spent_usd, cap_usd: cfg.daily_cap_usd, warn_at_usd: warnAt, calls_today: s.calls,
    over_cap: s.spent_usd >= cfg.daily_cap_usd, warn: s.spent_usd >= warnAt, day: s.day,
  };
}

module.exports = {
  loadBudget, DEFAULTS, LOOP_BUDGET_YAML, PT,
  ptDay, ptDayRange, ptMidnightUtcMs, addDays, nowIso,
  spentOn, spentToday, recordCall, estimateTokens, worstCaseUsd, precheck, statusToday,
};
