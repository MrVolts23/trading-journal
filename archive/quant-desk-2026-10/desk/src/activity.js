// Quant Desk — ACTIVITY: what the desk did, as plain sentences, newest first, in Pacific time.
// Built on read from desk.db (no event table): experiments Mike planned, versions made on the
// Edge page, risk-profile saves and the data load. Nothing about loops, tokens or budgets.

const reasons = require('./reasons');
const edge = require('./edge');

const PT = 'America/Los_Angeles';
const J = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch (_) { return d; } };

// ── Time helpers (sqlite datetime('now') strings are UTC) ─────────────────────────────
function parseUtc(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return new Date(s < 1e11 ? s * 1000 : s);
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(str)) return new Date(str.replace(' ', 'T') + 'Z');
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}
function ptParts(d) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: PT, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset',
  });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}
// ISO-8601 with the Pacific offset, e.g. 2026-09-03T14:54:24-07:00
function toPtIso(s) {
  const d = parseUtc(s);
  if (!d) return null;
  const p = ptParts(d);
  const m = String(p.timeZoneName || '').match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const off = m ? `${m[1]}${m[2].padStart(2, '0')}:${m[3] || '00'}` : '-08:00';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
// "Sep 3, 2:54 PM PT"
function toPtLabel(s) {
  const d = parseUtc(s);
  if (!d) return null;
  return d.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';
}
function toPtDate(s) {
  const d = parseUtc(s);
  if (!d) return null;
  const p = ptParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
// "Mar 24" for a bar time. Bar times are server wall-clock encoded as UTC (engine.loadM1), so format in UTC.
function shortDate(t) {
  if (t == null) return '?';
  return new Date(+t * 1000).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}
function withCommas(n) { return n == null ? '?' : Number(n).toLocaleString('en-US'); }

// ── Field words for the risk profile ──────────────────────────────────────────────────
const RISK_WORDS = {
  name: 'profile name', symbol: 'symbol', account_ccy: 'account currency', account_size: 'account size',
  risk_pct_per_trade: 'risk per trade', max_daily_loss_r: 'daily loss stop', max_trades_per_day: 'max trades per day',
  max_trades_per_session: 'max trades per session', max_consecutive_losses: 'losses-in-a-row stop', max_concurrent: 'positions at once',
  max_drawdown_halt_pct: 'drawdown halt', sessions: 'sessions', hard_lot_cap: 'lots cap', compounding: 'compounding',
  cost_model: 'costs', symbol_facts: 'symbol facts',
};
function riskWord(k) { return RISK_WORDS[k] || String(k).replace(/_/g, ' '); }

// ── Builder ───────────────────────────────────────────────────────────────────────────
function pluralRules(n) { return `${n} rule${n === 1 ? '' : 's'}`; }

function buildActivity(db, { limit = 50 } = {}) {
  const events = [];
  const push = (ts, text, kind, extra = {}) => { if (ts) events.push({ ts: toPtIso(ts), ts_label: toPtLabel(ts), date_pt: toPtDate(ts), _sort: parseUtc(ts).getTime(), text, kind, ...extra }); };

  const strategies = new Map(db.prepare(`SELECT id, name, family, parent_id, version, source, created_at FROM strategies`).all().map((s) => [s.id, s]));
  const label = (id) => { const s = strategies.get(id); return s ? (edge.versionLabel(s) || s.name) : `version ${id}`; };

  // 1. versions made on the Edge page
  for (const s of strategies.values()) {
    if (s.source !== 'edge') continue;
    const parent = s.parent_id != null ? label(s.parent_id) : null;
    push(s.created_at, parent ? `Created ${label(s.id)} from ${parent}.` : `Created ${label(s.id)}.`, 'version', { strategy_id: s.id });
  }

  // 2. tests Mike ran (planned_by mike, or made on the Edge page)
  const exps = db.prepare(`SELECT * FROM experiments WHERE planned_by = 'mike' OR source = 'edge' ORDER BY id DESC`).all();
  const verdictStmt = db.prepare(`SELECT * FROM gate_verdicts WHERE experiment_id = ? ORDER BY id DESC LIMIT 1`);
  for (const e of exps) {
    const v = verdictStmt.get(e.id);
    const delta = J(e.params_delta, {}) || {};
    const n = Object.keys(delta).length;
    const ver = label(e.strategy_id);
    let text;
    if (e.status === 'failed') text = `Test of ${ver} crashed: ${e.error || 'unknown error'}.`;
    else if (e.status === 'running') text = `Testing ${ver} now.`;
    else if (e.status === 'planned') text = `Queued a test of ${ver}.`;
    else if (!v) text = `Tested ${ver}. No desk verdict yet.`;
    else {
      const verdict = { ...v, gates: J(v.gates, []) };
      const word = reasons.verdictWord(verdict.verdict);
      const why = reasons.reasonFor(verdict);
      if (!n) text = `Tested ${ver}. ${word}: ${why}.`;
      else if (e.source === 'edge') text = `Changed ${pluralRules(n)} and tested as ${ver}. ${word}: ${why}.`;
      else text = `Tested ${ver} with ${pluralRules(n)} changed. ${word}: ${why}.`;
    }
    push(e.ran_at || e.created_at, text, 'test', { experiment_id: e.id, strategy_id: e.strategy_id, verdict: v ? v.verdict : null });
  }

  // 3. risk profile saves (no history table: the current row says what Mike has confirmed)
  for (const p of db.prepare(`SELECT * FROM risk_profiles ORDER BY id`).all()) {
    if (!(p.version > 1) || !p.updated_at) continue;
    const prov = J(p.provenance, {}) || {};
    const confirmed = Object.keys(prov).filter((k) => prov[k] === 'mike-confirmed' && k !== 'max_daily_loss_r');
    const what = confirmed.length ? confirmed.map(riskWord).join(', ') : 'no field changed';
    push(p.updated_at, `Risk profile saved: ${what}.`, 'risk', { profile_id: p.id, version: p.version });
  }

  // 4. data load
  for (const m of db.prepare(`SELECT * FROM data_manifest ORDER BY updated_at DESC`).all()) {
    const sym = m.symbol === 'XAUUSD' ? 'gold' : m.symbol;
    const tf = m.tf === 'M1' ? 'one-minute' : m.tf;
    const holdout = m.burned ? 'no clean holdout yet' : 'holdout available';
    push(m.updated_at, `Loaded ${withCommas(m.bars)} ${tf} ${sym} bars, ${shortDate(m.from_t)} to ${shortDate(m.to_t)}; ${holdout}.`, 'note', { symbol: m.symbol });
  }

  // Same-second ties (a version is created and tested inside one request): the test is the later event.
  const RANK = { test: 3, risk: 2, version: 1, note: 0 };
  events.sort((a, b) => (b._sort - a._sort) || ((RANK[b.kind] ?? 0) - (RANK[a.kind] ?? 0)));
  return events.slice(0, Math.max(1, Math.min(+limit || 50, 500))).map(({ _sort, ...e }) => e);
}

module.exports = { buildActivity, toPtIso, toPtLabel, toPtDate, parseUtc, shortDate };
