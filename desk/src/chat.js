// Quant Desk — CHAT: Mike talks, the model proposes, Mike taps Apply. Propose-only by construction:
// the model never writes to desk.db; it returns JSON that is validated against the rule schema and
// stored as a proposal on the assistant message. Only POST /chat/proposals/:id/apply runs a test,
// through the SAME code path as POST /edge/test (api.runEdgeTest).
//
// Prompt = [ stable system (desk/prompts/chat-system.md, cached) ]
//        + [ volatile system: today's rule sheet as sentences, the BINDING TABLE, risk summary,
//            latest verdict, last 3 tests ]
//        + the thread's last 20 turns + the new user text.
const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const paths = require('./paths');
const desk = require('./db');
const edge = require('./edge');
const reasons = require('./reasons');
const activity = require('./activity');
const budget = require('./budget');
const keychain = require('./model/keychain');
const providerMod = require('./model/provider');

const PROMPTS_DIR = path.join(paths.DESK_ROOT, 'prompts');
const SYSTEM_PROMPT_MD = path.join(PROMPTS_DIR, 'chat-system.md');
const ROLE = 'chat';
const HISTORY_CAP = 20;
const FAMILY = 'double_bos';
const SYMBOL = 'XAUUSD';
const PT = 'America/Los_Angeles';
const J = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch (_) { return d; } };

class ChatError extends Error {
  constructor(status, message) { super(message); this.status = status; this.name = 'ChatError'; }
}

// ── Provider injection (tests pass a fake; production uses provider.complete) ──────────
let _provider = null;
function setProvider(fn) { _provider = typeof fn === 'function' ? fn : null; }
function provider() { return _provider || providerMod.complete; }

// ── The JSON the model must return ────────────────────────────────────────────────────
// `changes` is an array of { key, value } pairs on the wire (a zod record would be emitted with no
// allowed keys by the structured-output converter); it is normalized into a record on receipt.
const ChangeValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const ProposalSchema = z.object({
  reply: z.string(),
  proposal: z.union([
    z.null(),
    z.object({
      changes: z.array(z.object({ key: z.string(), value: ChangeValue })),
      summary: z.string(),
      confidence: z.enum(['sure', 'likely', 'guess']),
    }),
  ]),
  new_rules: z.array(z.object({ text: z.string(), why_engine_work: z.string() })),
  questions: z.array(z.string()),
});

// ── System prompt (stable; byte-identical between calls so the cache hits) ────────────
let _promptKey = null, _prompt = null;
function loadSystemPrompt() {
  const st = fs.statSync(SYSTEM_PROMPT_MD);
  const key = String(st.mtimeMs);
  if (_prompt && _promptKey === key) return _prompt;
  _prompt = fs.readFileSync(SYSTEM_PROMPT_MD, 'utf8');
  _promptKey = key;
  return _prompt;
}

// ── Context block (volatile; second, uncached system block) ───────────────────────────
const strategyRow = (db, id) => (id == null ? null : db.prepare(`SELECT * FROM strategies WHERE id = ?`).get(+id) || null);
function currentStrategy(db, strategyId, family = FAMILY) {
  return strategyRow(db, strategyId) || db.prepare(`SELECT * FROM strategies WHERE family = ? ORDER BY id DESC LIMIT 1`).get(family) || null;
}
function latestVerdictForStrategy(db, strategyId) {
  const v = db.prepare(
    `SELECT v.*, e.strategy_id FROM gate_verdicts v JOIN experiments e ON e.id = v.experiment_id WHERE e.strategy_id = ? ORDER BY v.id DESC LIMIT 1`
  ).get(+strategyId);
  return v ? { ...v, gates: J(v.gates, []) } : null;
}
function lastTests(db, n = 3) {
  const rows = db.prepare(
    `SELECT v.*, e.strategy_id, s.name AS strategy_name, s.version AS version_number FROM gate_verdicts v
       JOIN experiments e ON e.id = v.experiment_id JOIN strategies s ON s.id = e.strategy_id
      ORDER BY v.id DESC LIMIT ?`
  ).all(n);
  return rows.map((r) => ({
    experiment_id: r.experiment_id,
    version: edge.versionLabel({ name: r.strategy_name, version: r.version_number }) || r.strategy_name,
    verdict: reasons.verdictWord(r.verdict),
    reason: reasons.reasonFor({ ...r, gates: J(r.gates, []) }),
  }));
}

function rangeText(pv) {
  if (pv.choices && pv.choices.length) return pv.choices.map((c) => `${c.value} = ${c.label}`).join(', ');
  if (pv.type === 'boolean') return 'true or false';
  const parts = [];
  if (pv.min != null || pv.max != null) parts.push(`${pv.min != null ? pv.min : 'any'} to ${pv.max != null ? pv.max : 'any'}`);
  if (pv.type === 'integer') parts.push('whole number');
  if (pv.nullable) parts.push('or null for blank/off');
  return parts.join(', ') || pv.type;
}

// One line per editable parameter: key | label | current value | unit | range or choices
function bindingTable(sheet) {
  const lines = [];
  const keys = [];
  const seen = new Set();
  const add = (pv, note) => {
    if (seen.has(pv.key)) return;
    seen.add(pv.key); keys.push(pv.key);
    lines.push(`${pv.key} | ${pv.label} | ${edge.valueLabel(pv, pv.value)} | ${pv.unit || '-'} | ${rangeText(pv)}${note ? ` | ${note}` : ''}`);
  };
  for (const g of sheet.groups) for (const rule of g.rules) for (const pv of rule.params) add(pv, rule.visible ? '' : 'not shown on the sheet with the current exit style');
  for (const pv of sheet.advanced) add(pv, 'advanced');
  return { lines, keys };
}

function money(n) { return n == null ? 'unknown' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function riskSummary(profile) {
  const f = (profile && profile.fields) || {};
  const sessions = Array.isArray(f.sessions) && f.sessions.length ? f.sessions.map((w) => `${w.name || 'session'} ${w.start} to ${w.end}`).join(', ') : 'none set';
  return [
    `Account ${money(f.account_size)} ${f.account_ccy || ''}`.trim() + `, risking ${f.risk_pct_per_trade ?? '?'}% per trade.`,
    `Daily loss stop ${f.max_daily_loss_r ?? '?'}R; at most ${f.max_trades_per_day ?? '?'} trades per day and ${f.max_trades_per_session ?? '?'} per session; done for the day after ${f.max_consecutive_losses ?? '?'} losses in a row.`,
    `Sessions (PT hours): ${sessions}. Spread ${money(f.cost_model && f.cost_model.spreadUsd)}, slippage ${money(f.cost_model && f.cost_model.slippageUsd)} per fill.`,
    'These live on the Risk page and are not parameters you can change.',
  ].join(' ');
}

function todayLabel(now = new Date()) {
  return now.toLocaleString('en-US', { timeZone: PT, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// buildContext(db, { strategy_id }) → { text, strategy, params, family, keys }
function buildContext(db, { strategy_id } = {}) {
  const s = currentStrategy(db, strategy_id);
  if (!s) throw new ChatError(409, 'no versions yet; import the July champion first');
  const family = s.family || FAMILY;
  const params = J(s.params_resolved, {});
  const version = edge.versionLabel(s) || s.name;
  const sheet = edge.renderSheet(params, family);
  const table = bindingTable(sheet);
  const lv = latestVerdictForStrategy(db, s.id);
  const verdictLine = lv
    ? `${reasons.verdictWord(lv.verdict)}: ${reasons.reasonFor(lv)} (tested ${activity.toPtLabel(lv.created_at)}).`
    : 'not tested yet.';
  const tests = lastTests(db, 3);
  const lines = [
    `Today is ${todayLabel()} (Pacific).`,
    '',
    `CURRENT VERSION: ${s.name} (${version}). Its rule sheet, as Mike reads it:`,
    edge.renderSheetText(params, family).trim(),
    '',
    'BINDING TABLE (for the JSON only; never show these keys to Mike). key | label | current value | unit | range or choices',
    ...table.lines,
    '',
    `RISK PROFILE: ${riskSummary(desk.getActiveProfile(db))}`,
    '',
    `LATEST VERDICT FOR ${version}: ${verdictLine}`,
    '',
    tests.length ? 'LAST TESTS (newest first):' : 'LAST TESTS: none yet.',
    ...tests.map((t) => `- ${t.version}: ${t.verdict}. ${sentence(t.reason)}`),
  ];
  return { text: lines.join('\n'), strategy: s, params, family, version, keys: table.keys };
}

// "only 2 of 5 ..." → "Only 2 of 5 ...."
function sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

// ── Threads and messages ──────────────────────────────────────────────────────────────
function threadTitle(now = new Date()) {
  return `${now.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric' })} conversation`;
}
function threadView(t) { return t ? { id: t.id, title: t.title, created_at: t.created_at, last_at: t.last_at } : null; }
function getThread(db, id) { return db.prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(+id) || null; }
function createThread(db, title) {
  const ts = budget.nowIso();
  const info = db.prepare(`INSERT INTO chat_threads (title, created_at, last_at) VALUES (?, ?, ?)`).run(title || threadTitle(), ts, ts);
  return getThread(db, info.lastInsertRowid);
}
// One thread per Pacific day by default.
function todayThread(db) {
  const r = budget.ptDayRange();
  const t = db.prepare(`SELECT * FROM chat_threads WHERE created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT 1`).get(r.start, r.end);
  return t || createThread(db);
}
function listThreads(db) {
  return db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id) AS messages FROM chat_threads t ORDER BY t.last_at DESC, t.id DESC`
  ).all().map((t) => ({ ...threadView(t), messages: t.messages }));
}

function messageView(m) {
  if (!m) return null;
  const proposal = J(m.proposal);
  const result = J(m.result);
  return {
    id: m.id, thread_id: m.thread_id, role: m.role, kind: m.kind, text: m.text,
    proposal,
    changes_text: (proposal && proposal.changes_text) || (result && result.changes_text) || [],
    applied_experiment_id: m.applied_experiment_id ?? null,
    result,
    model_call_id: m.model_call_id ?? null,
    created_at: m.created_at,
  };
}
function getMessage(db, id) { return db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(+id) || null; }
function insertMessage(db, { thread_id, role, kind = 'reply', text = '', proposal = null, result = null, applied_experiment_id = null, model_call_id = null }) {
  const ts = budget.nowIso();
  const info = db.prepare(
    `INSERT INTO chat_messages (thread_id, role, kind, text, proposal, result, applied_experiment_id, model_call_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(thread_id, role, kind, text, proposal == null ? null : JSON.stringify(proposal), result == null ? null : JSON.stringify(result), applied_experiment_id, model_call_id, ts);
  db.prepare(`UPDATE chat_threads SET last_at = ? WHERE id = ?`).run(ts, thread_id);
  return getMessage(db, info.lastInsertRowid);
}
function threadMessages(db, threadId) {
  return db.prepare(`SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id`).all(+threadId).map(messageView);
}
function getThreadView(db, id) {
  const t = getThread(db, id);
  if (!t) return null;
  return { thread: threadView(t), messages: threadMessages(db, t.id) };
}
// The model sees user turns and assistant replies/results (not notices), the last HISTORY_CAP of them.
function priorTurns(db, threadId, beforeMessageId) {
  const rows = db.prepare(
    `SELECT role, text FROM chat_messages WHERE thread_id = ? AND id < ? AND role IN ('user', 'assistant') AND kind IN ('reply', 'result') AND text <> ''
      ORDER BY id DESC LIMIT ?`
  ).all(+threadId, +beforeMessageId, HISTORY_CAP).reverse();
  while (rows.length && rows[0].role !== 'user') rows.shift();
  return rows.map((r) => ({ role: r.role, content: r.text }));
}

// ── Status ────────────────────────────────────────────────────────────────────────────
function status(db) {
  const cfg = providerMod.roleConfig(ROLE);
  const key = keychain.hasKey() ? 'present' : 'absent';
  const b = budget.statusToday(db);
  const needsKey = cfg.provider === 'anthropic';
  let reason = null;
  if (needsKey && key === 'absent') reason = 'no API key in the keychain';
  else if (b.over_cap) reason = `today's $${b.cap_usd.toFixed(2)} model budget is used up; it resets at midnight Pacific`;
  else if (cfg.provider === 'local' && !cfg.base_url) reason = 'local provider not configured';
  return {
    key,
    add_key_command: keychain.ADD_KEY_COMMAND,
    provider: cfg.provider,
    model: cfg.model,
    effort: cfg.effort,
    spent_today_usd: b.spent_today_usd,
    cap_usd: b.cap_usd,
    warn_at_usd: b.warn_at_usd,
    calls_today: b.calls_today,
    warn: b.warn,
    can_chat: reason == null,
    reason,
  };
}
function budgetFields(db) {
  const b = budget.statusToday(db);
  return { spent_today_usd: b.spent_today_usd, cap_usd: b.cap_usd, warn_at_usd: b.warn_at_usd, calls_today: b.calls_today, warn: b.warn };
}

// ── Proposal handling ─────────────────────────────────────────────────────────────────
function coerceValue(def, v) {
  if (!def) return v;
  const t = def.type;
  if ((t === 'number' || t === 'integer') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if ((t === 'number' || t === 'integer') && typeof v === 'string' && /^(null|blank|off|none)$/i.test(v.trim())) return null;
  if (t === 'boolean' && typeof v === 'string') { const s = v.trim().toLowerCase(); if (['true', 'yes', 'on'].includes(s)) return true; if (['false', 'no', 'off'].includes(s)) return false; }
  if (t === 'integer' && typeof v === 'number' && !Number.isInteger(v) && def.choices == null) return Math.round(v);
  return v;
}

// parseProposal(textOrJson) → { ok, value } with the wire shape validated and normalized.
function parseProposal(raw) {
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (_) { return { ok: false, error: 'not JSON' }; } }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'not an object' };
  const norm = { ...obj };
  if (norm.proposal === undefined) norm.proposal = null;
  if (!Array.isArray(norm.new_rules)) norm.new_rules = [];
  if (!Array.isArray(norm.questions)) norm.questions = [];
  if (norm.proposal && typeof norm.proposal === 'object') {
    const p = { ...norm.proposal };
    if (p.changes && !Array.isArray(p.changes) && typeof p.changes === 'object') p.changes = Object.entries(p.changes).map(([key, value]) => ({ key, value }));
    if (!Array.isArray(p.changes)) p.changes = [];
    // a non-primitive value (only possible from a lax provider) is kept as text so screening can refuse it by name
    p.changes = p.changes.filter((c) => c && typeof c === 'object').map((c) => ({ key: String(c.key), value: c.value != null && typeof c.value === 'object' ? JSON.stringify(c.value) : c.value }));
    if (!['sure', 'likely', 'guess'].includes(p.confidence)) p.confidence = 'guess';
    if (typeof p.summary !== 'string') p.summary = '';
    norm.proposal = p;
  }
  const r = ProposalSchema.safeParse(norm);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

// Validate the model's changes against the binding table + edge.validateChanges. Returns
// { changes (record), dropped:[{key,label,why}] }.
function screenChanges(pairs, ctx) {
  const schema = edge.loadSchema();
  const allowed = new Set(ctx.keys);
  const kept = {};
  const dropped = [];
  for (const { key, value } of pairs || []) {
    const v = coerceValue(schema[key], value);
    // validateChanges already says it in English: unknown key, Risk-page field, out of range, wrong type
    const errs = edge.validateChanges({ [key]: v }, schema, ctx.family);
    if (errs.length) { dropped.push({ key, label: allowed.has(key) ? edge.labelFor(key, ctx.family).label : null, why: errs.join('; ') }); continue; }
    if (!allowed.has(key)) { dropped.push({ key, label: null, why: `"${key}" is not a rule on this sheet` }); continue; }
    kept[key] = v;
  }
  return { changes: edge.effectiveChanges(kept, ctx.params), dropped };
}

function droppedNote(dropped) {
  if (!dropped.length) return '';
  const parts = dropped.map((d) => (d.label && !d.why.startsWith(d.label) ? `${d.label}: ${d.why}` : d.why));
  return `\n\nI left out ${dropped.length === 1 ? 'one change' : `${dropped.length} changes`} that the sheet cannot take: ${parts.join('; ')}.`;
}

// ── The model call with ledger ────────────────────────────────────────────────────────
async function callModel(db, { thread_id, system, messages, schema, cfg }) {
  const t0 = Date.now();
  try {
    const r = await provider()({ role: ROLE, system, messages, schema, max_tokens: cfg.max_tokens });
    const call_id = budget.recordCall(db, {
      role: ROLE, provider: r.provider || cfg.provider, model: r.model || cfg.model, usage: r.usage, cost_usd: r.cost_usd,
      latency_ms: r.latency_ms ?? (Date.now() - t0), stop_reason: r.stop_reason, thread_id, ok: 1,
    });
    return { ...r, call_id };
  } catch (e) {
    const plain = e.plain || e.message || 'the model call failed';
    const call_id = budget.recordCall(db, {
      role: ROLE, provider: cfg.provider, model: cfg.model, usage: null, cost_usd: 0, latency_ms: Date.now() - t0,
      stop_reason: null, thread_id, ok: 0, error: plain,
    });
    return { error: e, plain, call_id };
  }
}

// ── send ──────────────────────────────────────────────────────────────────────────────
// send(db, { thread_id?, text, context:{ strategy_id?, page? } }) → { thread_id, message, budget, status? }
async function send(db, { thread_id, text, context = {} } = {}) {
  const userText = String(text == null ? '' : text).trim();
  if (!userText) throw new ChatError(400, 'say something first');
  const thread = thread_id != null ? getThread(db, thread_id) : todayThread(db);
  if (!thread) throw new ChatError(404, `conversation ${thread_id} not found`);
  const ctx = buildContext(db, context || {});
  const userMsg = insertMessage(db, { thread_id: thread.id, role: 'user', text: userText });
  const done = (assistantMsg, extra = {}) => ({ thread_id: thread.id, user_message: messageView(userMsg), message: messageView(assistantMsg), budget: budgetFields(db), ...extra });

  const st = status(db);
  const cfg = providerMod.roleConfig(ROLE);
  if (cfg.provider === 'anthropic' && st.key === 'absent') {
    const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'notice', text: `I can't reach the model yet: there is no API key in the keychain. Add it once in Terminal with: ${keychain.ADD_KEY_COMMAND}` });
    return done(m, { status: st });
  }

  const stable = loadSystemPrompt();
  const history = priorTurns(db, thread.id, userMsg.id);
  const messages = [...history, { role: 'user', content: userText }];
  const prices = providerMod.pricesFor(cfg.model);
  const promptTokens = budget.estimateTokens(stable + ctx.text + messages.map((m) => m.content).join(''));
  const pre = budget.precheck(db, { prompt_tokens: promptTokens, max_tokens: cfg.max_tokens, prices });
  if (!pre.ok) {
    const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'notice', text: `I didn't ask the model: ${pre.reason}` });
    return done(m, { status: status(db) });
  }

  const systemBlocks = (nudge) => [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: nudge ? `${ctx.text}\n\n${nudge}` : ctx.text },
  ];

  let r = await callModel(db, { thread_id: thread.id, system: systemBlocks(null), messages, schema: ProposalSchema, cfg });
  if (r.error) {
    const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'notice', text: `I couldn't get an answer: ${r.plain}.`, model_call_id: r.call_id });
    return done(m, { status: status(db) });
  }
  if (r.stop_reason === 'refusal') {
    console.warn('[desk chat] the model declined a request', r.refusal ? JSON.stringify(r.refusal) : '');
    const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'notice', text: 'The model declined that request. Try saying it another way.', model_call_id: r.call_id });
    return done(m);
  }
  let parsed = parseProposal(r.json != null ? r.json : r.text);
  if (!parsed.ok) {
    const nudge = 'Your previous answer was not valid JSON matching the required shape. Answer again with only the JSON object: reply, proposal (null or {changes:[{key,value}], summary, confidence}), new_rules, questions.';
    // the retry is a second paid call: gate it like the first one (the first call's cost is in the ledger now)
    const pre2 = budget.precheck(db, { prompt_tokens: promptTokens + budget.estimateTokens(nudge), max_tokens: cfg.max_tokens, prices });
    if (!pre2.ok) {
      const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'notice', text: `I couldn't put that answer together and didn't ask the model again: ${pre2.reason}`, model_call_id: r.call_id });
      return done(m, { status: status(db) });
    }
    r = await callModel(db, { thread_id: thread.id, system: systemBlocks(nudge), messages, schema: ProposalSchema, cfg });
    if (r.error) {
      const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'notice', text: `I couldn't get an answer: ${r.plain}.`, model_call_id: r.call_id });
      return done(m, { status: status(db) });
    }
    if (r.stop_reason === 'refusal') {
      const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'notice', text: 'The model declined that request. Try saying it another way.', model_call_id: r.call_id });
      return done(m);
    }
    parsed = parseProposal(r.json != null ? r.json : r.text);
    if (!parsed.ok) {
      const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'notice', text: "Sorry, I couldn't put that answer together properly. Try saying it another way.", model_call_id: r.call_id });
      return done(m);
    }
  }

  const v = parsed.value;
  let proposal = null;
  let replyText = String(v.reply || '').trim();
  const newRules = v.new_rules.map((n) => ({ text: String(n.text || '').trim(), why_engine_work: String(n.why_engine_work || '').trim() })).filter((n) => n.text);
  const questions = v.questions.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 2);
  if (v.proposal || newRules.length || questions.length) {
    const screened = v.proposal ? screenChanges(v.proposal.changes, ctx) : { changes: {}, dropped: [] };
    const changes_text = edge.describeChanges(screened.changes, ctx.params, ctx.family);
    proposal = {
      summary: v.proposal ? String(v.proposal.summary || '').trim() : '',
      confidence: v.proposal ? v.proposal.confidence : 'guess',
      changes: screened.changes,
      changes_text,
      dropped: screened.dropped,
      new_rules: newRules,
      questions,
      strategy_id: ctx.strategy.id,
      version: ctx.version,
      can_apply: Object.keys(screened.changes).length > 0 || !!v.proposal,
    };
    replyText += droppedNote(screened.dropped);
  }
  const m = insertMessage(db, { thread_id: thread.id, role: 'assistant', kind: 'reply', text: replyText, proposal, model_call_id: r.call_id });
  return done(m);
}

// ── apply ─────────────────────────────────────────────────────────────────────────────
// apply(db, message_id, { strategy_id?, note? }) → { ...edge test result, thread_id, message, rule_requests, tested }
function apply(db, messageId, { strategy_id, note } = {}) {
  const msg = getMessage(db, messageId);
  if (!msg) throw new ChatError(404, `message ${messageId} not found`);
  const proposal = J(msg.proposal);
  if (!proposal) throw new ChatError(400, 'that message has nothing to apply');
  if (msg.applied_experiment_id != null) throw new ChatError(409, 'that proposal was already applied and tested');
  const sid = strategy_id != null ? +strategy_id : proposal.strategy_id;
  const strategy = strategyRow(db, sid);
  if (!strategy) throw new ChatError(400, `version ${sid} not found`);

  // New rules the engine cannot express are never applied; they become open rule requests.
  const ts = budget.nowIso();
  const ruleRequests = (proposal.new_rules || []).map((n) => {
    const info = db.prepare(`INSERT INTO rule_requests (thread_id, message_id, text, why, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`)
      .run(msg.thread_id, msg.id, n.text, n.why_engine_work || null, ts);
    return { id: Number(info.lastInsertRowid), text: n.text, why: n.why_engine_work || null, status: 'open' };
  });
  const engineNote = ruleRequests.length
    ? ` Not applied, needs engine work: ${ruleRequests.map((r) => r.text).join('; ')}.`
    : '';

  const changes = proposal.changes || {};
  if (!Object.keys(changes).length && ruleRequests.length && !proposal.can_apply) {
    const text = `Nothing to test yet: ${ruleRequests.length === 1 ? 'that rule needs' : 'those rules need'} engine work first.${engineNote}`;
    const m = insertMessage(db, { thread_id: msg.thread_id, role: 'assistant', kind: 'result', text });
    return { tested: false, thread_id: msg.thread_id, message: messageView(m), rule_requests: ruleRequests };
  }

  const { runEdgeTest } = require('./api'); // lazy: api.js requires this module
  const out = runEdgeTest(db, { strategy_id: sid, changes, note: (typeof note === 'string' && note.trim()) || proposal.summary || '' });
  if (!out.ok) throw new ChatError(out.status || 400, out.error);
  const r = out.result;
  const text = `Tested as ${r.strategy.version}: ${r.verdict_word}. ${sentence(r.reason)}${engineNote}`;
  const result = {
    verdict: r.verdict, verdict_word: r.verdict_word, reason: r.reason,
    experiment_id: r.experiment_id, strategy_id: r.strategy.id, version: r.strategy.version,
    created_version: r.created_version, parent_version: r.parent ? r.parent.version : null,
    changes: r.changes, changes_text: r.changes_text, summary: r.summary, n_trials: r.n_trials, holdout: r.holdout,
  };
  const m = insertMessage(db, { thread_id: msg.thread_id, role: 'assistant', kind: 'result', text, result, applied_experiment_id: r.experiment_id });
  proposal.applied_experiment_id = r.experiment_id;
  db.prepare(`UPDATE chat_messages SET applied_experiment_id = ?, proposal = ? WHERE id = ?`).run(r.experiment_id, JSON.stringify(proposal), msg.id);
  return { ...r, tested: true, thread_id: msg.thread_id, message: messageView(m), rule_requests: ruleRequests };
}

module.exports = {
  ChatError, ProposalSchema, ROLE, HISTORY_CAP, SYSTEM_PROMPT_MD,
  setProvider, loadSystemPrompt, buildContext, bindingTable, parseProposal, screenChanges, sentence,
  status, listThreads, createThread, todayThread, getThread, getThreadView, getMessage, messageView, threadMessages, priorTurns,
  send, apply,
};
