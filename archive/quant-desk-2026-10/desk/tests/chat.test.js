// Quant Desk — chat: threads, prompt assembly, proposal screening, Apply & test, and every
// no-model-call path (key absent, over cap, refusal, error, bad JSON). NO real API call is ever
// made: the provider is a fake injected with chat.setProvider and the keychain reader is stubbed.
// desk.db goes to a temp dir and the research csv is a small synthetic file (same pattern as
// tests/edge.test.js), both set BEFORE any desk module loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-desk-chat-'));
process.env.QUANT_DESK_DIR = tmp;
process.env.QUANT_DESK_CSV = path.join(tmp, 'synthetic_M1.csv');

function writeSyntheticCsv(file) {
  let seed = 20260903;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const lines = ['time,open,high,low,close,tick_volume'];
  let px = 4300, t = Date.UTC(2026, 2, 24, 0, 0) / 1000;
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 0; i < 60 * 24 * 10; i++, t += 60) {
    const d = new Date(t * 1000);
    const drift = Math.sin(i / 240) * 0.15;
    const o = px, c = px + drift + (rnd() - 0.5) * 2.4;
    const h = Math.max(o, c) + rnd() * 0.9, l = Math.min(o, c) - rnd() * 0.9;
    px = c;
    lines.push(`${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00,${o.toFixed(2)},${h.toFixed(2)},${l.toFixed(2)},${c.toFixed(2)},100`);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
writeSyntheticCsv(process.env.QUANT_DESK_CSV);

const express = require('express');
const api = require('../src/api');
const desk = require('../src/db');
const chat = require('../src/chat');
const keychain = require('../src/model/keychain');
const budget = require('../src/budget');
const engine = require('../engine/engine');

const SEED_PARAMS = { ...engine.DEFAULTS, pivotStrengthLtf: 1, maxEntriesPerArm: 3, exitModel: 'trail_ltf' };
const RAW_KEYS = ['pivotStrengthLtf', 'slPaddingUsd', 'exitModel', 'maxSlUsd', 'maxEntriesPerArm', 'trailPadUsd', 'armExpiryHtfBars'];

// ── fake provider ─────────────────────────────────────────────────────────────────────
const calls = [];
let queue = [];
function reply(obj) {
  return { text: JSON.stringify(obj), json: obj, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 }, cost_usd: 0.0272, model: 'fake-model', provider: 'fake', stop_reason: 'end_turn', latency_ms: 7 };
}
async function fakeProvider(req) {
  calls.push(req);
  const next = queue.shift();
  if (!next) throw new Error('fake provider: nothing queued');
  if (typeof next === 'function') return next(req);
  return next;
}

let server, base, seedId;
test.before(async () => {
  keychain._setReader(() => 'test-key-never-used');
  chat.setProvider(fakeProvider);
  const app = express();
  app.use('/api/desk', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/desk`;
  const db = desk.getDb();
  const info = db.prepare(`INSERT INTO strategies (name, family, symbol, parent_id, version, params_resolved, params_sha, lifecycle, source)
              VALUES ('Double BOS v2.1', 'double_bos', 'XAUUSD', NULL, 3, ?, ?, 'in_sample', 'test')`)
    .run(JSON.stringify(SEED_PARAMS), desk.paramsSha(SEED_PARAMS));
  seedId = Number(info.lastInsertRowid);
  db.prepare(`INSERT INTO data_manifest (symbol, tf, from_t, to_t, bars, sha256, burned, note) VALUES ('XAUUSD', 'M1', ?, ?, 100000, 'x', 1, 'test')`)
    .run(Date.UTC(2026, 2, 24, 1, 10) / 1000, Date.UTC(2026, 6, 3, 23, 30) / 1000);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  chat.setProvider(null);
  keychain._setReader(null);
  desk.closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, route, body) {
  const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

// ── status ────────────────────────────────────────────────────────────────────────────
test('GET /chat/status: key present, cap from loop-budget.yaml, provider/model from models.yaml', async () => {
  const { status, body } = await call('GET', '/chat/status');
  assert.equal(status, 200);
  assert.equal(body.key, 'present');
  assert.equal(body.add_key_command, 'security add-generic-password -s quant-desk -a anthropic -w');
  assert.equal(body.provider, 'anthropic');
  assert.equal(body.model, 'claude-fable-5-1');
  assert.equal(body.cap_usd, 10);
  assert.equal(body.warn_at_usd, 8);
  assert.equal(body.spent_today_usd, 0);
  assert.equal(body.calls_today, 0);
  assert.equal(body.can_chat, true);
  assert.equal(body.reason, null);
});

// ── send: thread creation, prompt assembly, screening ─────────────────────────────────
let threadId, proposalMsgId;
test('POST /chat/messages creates today\'s thread, assembles the prompt, screens the proposal', async () => {
  queue.push(reply({
    reply: 'Sure, I can widen the swing filter on the entry chart. That drops the noisiest breaks.',
    proposal: {
      changes: [
        { key: 'pivotStrengthLtf', value: 2 },
        { key: 'maxSlUsd', value: 999 },
        { key: 'bogusKey', value: 5 },
        { key: 'slPaddingUsd', value: '0.50' },
        { key: 'windows', value: [] },
      ],
      summary: 'Try a stricter entry swing and a bit more stop padding',
      confidence: 'likely',
    },
    new_rules: [{ text: 'Only take the second entry after a sweep', why_engine_work: 'entries are not ordered by sweep today' }],
    questions: [],
  }));
  const { status, body } = await call('POST', '/chat/messages', { text: 'try a stricter entry swing and a wider stop padding', context: { strategy_id: seedId, page: '/desk/edge' } });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(typeof body.thread_id, 'number');
  threadId = body.thread_id;
  assert.equal(body.budget.cap_usd, 10);
  assert.equal(body.budget.spent_today_usd, 0.0272);

  // the request the model saw
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.role, 'chat');
  assert.equal(req.max_tokens, 3000);
  assert.ok(req.schema, 'zod schema passed through');
  assert.equal(req.system.length, 2);
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
  assert.match(req.system[0].text, /Quant Desk's assistant for Mike/);
  assert.match(req.system[0].text, /\+30\.6R/);
  assert.match(req.system[0].text, /Lead with the outcome/);
  assert.equal('cache_control' in req.system[1], false, 'the volatile block is not cached');
  assert.match(req.system[1].text, /CURRENT VERSION: Double BOS v2\.1/);
  assert.match(req.system[1].text, /Read structure on the 15-minute chart and take entries on the 3-minute chart\./);
  assert.match(req.system[1].text, /BINDING TABLE/);
  assert.match(req.system[1].text, /^pivotStrengthLtf \| Entry-chart swing strength \(bars each side\) \| 1 \| bars \| 1 to 10, whole number/m);
  assert.match(req.system[1].text, /^exitModel \| Exit style \| trail the stop behind confirmed swings \| - \| fixed_rr = take profit at a fixed target/m);
  assert.ok(!/^windows \|/m.test(req.system[1].text), 'Risk page fields are not in the binding table');
  assert.match(req.system[1].text, /RISK PROFILE: Account \$3,454\.22 CAD, risking 1% per trade\./);
  assert.match(req.system[1].text, /LATEST VERDICT FOR v2\.1: not tested yet\./);
  assert.match(req.system[1].text, /LAST TESTS: none yet\./);
  assert.deepEqual(req.messages, [{ role: 'user', content: 'try a stricter entry swing and a wider stop padding' }]);

  // the stored assistant message
  const m = body.message;
  assert.equal(m.role, 'assistant'); assert.equal(m.kind, 'reply');
  assert.match(m.text, /^Sure, I can widen the swing filter/);
  assert.match(m.text, /I left out 3 changes that the sheet cannot take: Widest stop allowed \(\$\) can't be above 50; "bogusKey" is not a rule on this sheet; sessions, spread and slippage are set on the Risk page, not here\./);
  assert.deepEqual(m.proposal.changes, { pivotStrengthLtf: 2, slPaddingUsd: 0.5 }, 'invalid keys dropped, numeric string coerced');
  assert.deepEqual(m.changes_text, ['Entry-chart swing strength (bars each side): 1 → 2', 'Stop padding beyond the swing ($): 0.30 → 0.50']);
  assert.equal(m.proposal.summary, 'Try a stricter entry swing and a bit more stop padding');
  assert.equal(m.proposal.confidence, 'likely');
  assert.equal(m.proposal.strategy_id, seedId);
  assert.equal(m.proposal.version, 'v2.1');
  assert.equal(m.proposal.can_apply, true);
  assert.deepEqual(m.proposal.dropped.map((d) => d.key), ['maxSlUsd', 'bogusKey', 'windows']);
  assert.equal(m.proposal.new_rules.length, 1);
  assert.equal(m.applied_experiment_id, null);
  assert.equal(typeof m.model_call_id, 'number');
  proposalMsgId = m.id;
  for (const k of RAW_KEYS) assert.ok(!m.changes_text.join(' ').includes(k), `changes_text leaks ${k}`);

  // ledger
  const row = desk.getDb().prepare(`SELECT * FROM model_calls WHERE id = ?`).get(m.model_call_id);
  assert.equal(row.role, 'chat'); assert.equal(row.provider, 'fake'); assert.equal(row.model, 'fake-model');
  assert.equal(row.tokens_in, 1200); assert.equal(row.tokens_out, 300); assert.equal(row.cache_read, 800);
  assert.equal(row.cost_usd, 0.0272); assert.equal(row.ok, 1); assert.equal(row.thread_id, threadId);
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('GET /chat/threads and /chat/threads/:id', async () => {
  const list = await call('GET', '/chat/threads');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, threadId);
  assert.match(list.body[0].title, /^[A-Z][a-z]{2} \d{1,2} conversation$/);
  assert.equal(list.body[0].messages, 2);
  const t = await call('GET', `/chat/threads/${threadId}`);
  assert.equal(t.status, 200);
  assert.equal(t.body.thread.id, threadId);
  assert.deepEqual(t.body.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(t.body.messages[1].id, proposalMsgId);
  assert.ok(Array.isArray(t.body.messages[1].changes_text));
  const missing = await call('GET', '/chat/threads/424242');
  assert.equal(missing.status, 404);
});

test('a second message in the same thread carries the prior turns and a null proposal is fine', async () => {
  queue.push(reply({ reply: 'The judge needs 4 of 5 stretches of the data to be profitable.', proposal: null, new_rules: [], questions: [] }));
  const { status, body } = await call('POST', '/chat/messages', { thread_id: threadId, text: 'what does the judge need?', context: { strategy_id: seedId } });
  assert.equal(status, 200);
  assert.equal(body.thread_id, threadId);
  assert.equal(body.message.proposal, null);
  assert.deepEqual(body.message.changes_text, []);
  const req = calls[calls.length - 1];
  assert.equal(req.messages.length, 3);
  assert.deepEqual(req.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(req.messages[1].content, /^Sure, I can widen/);
  // the default thread (no thread_id) is today's thread, not a new one
  queue.push(reply({ reply: 'Ok.', proposal: null, new_rules: [], questions: [] }));
  const again = await call('POST', '/chat/messages', { text: 'thanks', context: {} });
  assert.equal(again.body.thread_id, threadId);
});

// ── apply ─────────────────────────────────────────────────────────────────────────────
let appliedExpId, childId;
test('POST /chat/proposals/:id/apply runs the /edge/test path, stores a result message, files rule requests', async () => {
  const { status, body } = await call('POST', `/chat/proposals/${proposalMsgId}/apply`, { strategy_id: seedId });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.tested, true);
  assert.equal(body.created_version, true);
  assert.equal(body.strategy.version, 'v2.2');
  assert.equal(body.parent.version, 'v2.1');
  assert.deepEqual(body.changes, { pivotStrengthLtf: 2, slPaddingUsd: 0.5 });
  assert.ok(['PASS', 'REJECT', 'BLOCKED', 'ERROR'].includes(body.verdict), body.verdict);
  assert.equal(typeof body.experiment_id, 'number');
  appliedExpId = body.experiment_id; childId = body.strategy.id;

  const m = body.message;
  assert.equal(m.role, 'assistant'); assert.equal(m.kind, 'result');
  assert.match(m.text, /^Tested as v2\.2: (PASS|FAIL|BLOCKED|ERROR)\. [A-Z].*\. Not applied, needs engine work: Only take the second entry after a sweep\.$/);
  assert.equal(m.applied_experiment_id, appliedExpId);
  assert.equal(m.result.experiment_id, appliedExpId);
  assert.equal(m.result.strategy_id, childId);
  assert.equal(m.result.version, 'v2.2');
  assert.equal(typeof m.result.reason, 'string');
  for (const k of RAW_KEYS) assert.ok(!m.text.includes(k), `result text leaks ${k}`);

  const db = desk.getDb();
  const s = db.prepare(`SELECT * FROM strategies WHERE id = ?`).get(childId);
  assert.equal(s.source, 'edge'); assert.equal(s.parent_id, seedId);
  assert.equal(JSON.parse(s.params_resolved).pivotStrengthLtf, 2);
  const e = db.prepare(`SELECT * FROM experiments WHERE id = ?`).get(appliedExpId);
  assert.equal(e.strategy_id, childId); assert.equal(e.source, 'edge'); assert.equal(e.planned_by, 'mike');
  assert.equal(e.hypothesis, 'Try a stricter entry swing and a bit more stop padding');
  const orig = db.prepare(`SELECT * FROM chat_messages WHERE id = ?`).get(proposalMsgId);
  assert.equal(orig.applied_experiment_id, appliedExpId, 'the proposal message is marked applied');
  const rr = db.prepare(`SELECT * FROM rule_requests`).all();
  assert.equal(rr.length, 1);
  assert.equal(rr[0].text, 'Only take the second entry after a sweep');
  assert.equal(rr[0].why, 'entries are not ordered by sweep today');
  assert.equal(rr[0].status, 'open'); assert.equal(rr[0].message_id, proposalMsgId); assert.equal(rr[0].thread_id, threadId);
  assert.deepEqual(body.rule_requests.map((r) => r.status), ['open']);

  // the desk's own routes see it
  const versions = await call('GET', '/versions');
  assert.deepEqual(versions.body.map((v) => v.version), ['v2.2', 'v2.1']);
  const thread = await call('GET', `/chat/threads/${threadId}`);
  assert.equal(thread.body.messages[thread.body.messages.length - 1].kind, 'result');
});

test('apply twice is refused; apply of a message with nothing to apply is refused', async () => {
  const twice = await call('POST', `/chat/proposals/${proposalMsgId}/apply`, { strategy_id: seedId });
  assert.equal(twice.status, 409);
  const userMsg = desk.getDb().prepare(`SELECT id FROM chat_messages WHERE role = 'user' ORDER BY id LIMIT 1`).get();
  const nothing = await call('POST', `/chat/proposals/${userMsg.id}/apply`, {});
  assert.equal(nothing.status, 400);
  const missing = await call('POST', '/chat/proposals/424242/apply', {});
  assert.equal(missing.status, 404);
});

test('the context after a test shows the latest verdict and the last tests', async () => {
  queue.push(reply({ reply: 'Ok.', proposal: null, new_rules: [], questions: [] }));
  await call('POST', '/chat/messages', { thread_id: threadId, text: 'how did that go?', context: { strategy_id: childId } });
  const req = calls[calls.length - 1];
  assert.match(req.system[1].text, /CURRENT VERSION: Double BOS v2\.2/);
  assert.match(req.system[1].text, /LATEST VERDICT FOR v2\.2: (PASS|FAIL|BLOCKED): .+ \(tested [A-Z][a-z]{2} \d{1,2}, .+ PT\)\./);
  assert.match(req.system[1].text, /LAST TESTS \(newest first\):\n- v2\.2: (PASS|FAIL|BLOCKED)\. [A-Z]/);
  assert.match(req.messages[req.messages.length - 2].content, /^Tested as v2\.2:/, 'result messages are part of the history');
});

test('a proposal with only engine-work rules applies without running a test', async () => {
  queue.push(reply({ reply: 'That needs engine work.', proposal: null, new_rules: [{ text: 'Skip Mondays', why_engine_work: 'no weekday filter in the engine' }], questions: ['Every Monday, or only the first of the month?'] }));
  const sent = await call('POST', '/chat/messages', { thread_id: threadId, text: 'skip mondays', context: { strategy_id: childId } });
  assert.equal(sent.body.message.proposal.can_apply, false);
  assert.deepEqual(sent.body.message.proposal.questions, ['Every Monday, or only the first of the month?']);
  const before = desk.getDb().prepare(`SELECT COUNT(*) AS n FROM experiments`).get().n;
  const { status, body } = await call('POST', `/chat/proposals/${sent.body.message.id}/apply`, {});
  assert.equal(status, 200);
  assert.equal(body.tested, false);
  assert.match(body.message.text, /^Nothing to test yet: that rule needs engine work first\. Not applied, needs engine work: Skip Mondays\.$/);
  assert.equal(desk.getDb().prepare(`SELECT COUNT(*) AS n FROM experiments`).get().n, before);
  assert.equal(desk.getDb().prepare(`SELECT COUNT(*) AS n FROM rule_requests WHERE status = 'open'`).get().n, 2);
});

// ── no-model paths ────────────────────────────────────────────────────────────────────
test('key absent: status says so with the add-key command; a message gets a notice and no model call', async () => {
  keychain._setReader(() => { throw new Error('security: could not be found'); });
  try {
    const st = await call('GET', '/chat/status');
    assert.equal(st.body.key, 'absent');
    assert.equal(st.body.can_chat, false);
    assert.match(st.body.reason, /no API key/);
    assert.equal(st.body.add_key_command, 'security add-generic-password -s quant-desk -a anthropic -w');
    const n = calls.length;
    const { status, body } = await call('POST', '/chat/messages', { thread_id: threadId, text: 'hello?', context: {} });
    assert.equal(status, 200);
    assert.equal(body.message.kind, 'notice');
    assert.match(body.message.text, /security add-generic-password -s quant-desk -a anthropic -w/);
    assert.equal(body.status.key, 'absent');
    assert.equal(calls.length, n, 'no model call');
  } finally {
    keychain._setReader(() => 'test-key-never-used');
  }
});

test('over cap: $10 already spent today refuses before calling the model', async () => {
  const db = desk.getDb();
  const id = budget.recordCall(db, { role: 'chat', provider: 'fake', model: 'fake-model', usage: { input_tokens: 1 }, cost_usd: 10, latency_ms: 1, stop_reason: 'end_turn', ok: 1 });
  try {
    const st = await call('GET', '/chat/status');
    assert.equal(st.body.can_chat, false);
    assert.ok(st.body.spent_today_usd >= 10);
    assert.match(st.body.reason, /budget is used up/);
    const n = calls.length;
    const { status, body } = await call('POST', '/chat/messages', { thread_id: threadId, text: 'one more', context: {} });
    assert.equal(status, 200);
    assert.equal(body.message.kind, 'notice');
    assert.match(body.message.text, /budget is used up/);
    assert.match(body.message.text, /midnight Pacific/);
    assert.equal(calls.length, n, 'no model call');
  } finally {
    db.prepare(`DELETE FROM model_calls WHERE id = ?`).run(id);
  }
});

test('refusal: stop_reason refusal becomes a plain notice and is still in the ledger', async () => {
  queue.push({ text: null, json: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, cost_usd: 0, model: 'fake-model', provider: 'fake', stop_reason: 'refusal', latency_ms: 3, refusal: { category: 'other', explanation: 'x' } });
  const { status, body } = await call('POST', '/chat/messages', { thread_id: threadId, text: 'do something odd', context: {} });
  assert.equal(status, 200);
  assert.equal(body.message.kind, 'notice');
  assert.match(body.message.text, /The model declined that request/);
  const row = desk.getDb().prepare(`SELECT * FROM model_calls WHERE id = ?`).get(body.message.model_call_id);
  assert.equal(row.stop_reason, 'refusal'); assert.equal(row.ok, 1);
});

test('provider error: the plain sentence reaches Mike and the ledger records ok = 0', async () => {
  queue.push(() => { const e = new Error('401'); e.plain = 'the key in the keychain was rejected'; throw e; });
  const { status, body } = await call('POST', '/chat/messages', { thread_id: threadId, text: 'hi', context: {} });
  assert.equal(status, 200);
  assert.equal(body.message.kind, 'notice');
  assert.equal(body.message.text, "I couldn't get an answer: the key in the keychain was rejected.");
  const row = desk.getDb().prepare(`SELECT * FROM model_calls WHERE id = ?`).get(body.message.model_call_id);
  assert.equal(row.ok, 0); assert.equal(row.error, 'the key in the keychain was rejected'); assert.equal(row.cost_usd, 0);
});

test('bad JSON: one retry with a nudge, then the good answer is used', async () => {
  queue.push({ ...reply({}), text: 'not json at all', json: null });
  queue.push(reply({ reply: 'Second try.', proposal: { changes: [{ key: 'maxEntriesPerArm', value: 2 }], summary: 'Two entries per setup', confidence: 'sure' }, new_rules: [], questions: [] }));
  const n = calls.length;
  const { body } = await call('POST', '/chat/messages', { thread_id: threadId, text: 'two entries', context: { strategy_id: childId } });
  assert.equal(calls.length, n + 2);
  assert.ok(!calls[n].system[1].text.includes('not valid JSON'));
  assert.match(calls[n + 1].system[1].text, /not valid JSON matching the required shape/);
  assert.equal(calls[n + 1].system[0].text, calls[n].system[0].text, 'the cached block is byte-identical');
  assert.equal(body.message.kind, 'reply');
  assert.equal(body.message.text, 'Second try.');
  assert.deepEqual(body.message.changes_text, ['Entries allowed per setup: 3 → 2']);
});

test('bad JSON twice: a plain apology', async () => {
  queue.push({ ...reply({}), text: '{"reply": 12}', json: { reply: 12 } });
  queue.push({ ...reply({}), text: 'still nope', json: null });
  const { body } = await call('POST', '/chat/messages', { thread_id: threadId, text: 'again', context: {} });
  assert.equal(body.message.kind, 'notice');
  assert.match(body.message.text, /couldn't put that answer together/);
});

test('POST /chat/threads starts a fresh conversation; sending to it does not reuse today\'s thread', async () => {
  const { status, body } = await call('POST', '/chat/threads', {});
  assert.equal(status, 200);
  assert.notEqual(body.id, threadId);
  assert.match(body.title, /conversation$/);
  assert.equal(body.messages, 0);
  queue.push(reply({ reply: 'Fresh.', proposal: null, new_rules: [], questions: [] }));
  const sent = await call('POST', '/chat/messages', { thread_id: body.id, text: 'new topic', context: {} });
  assert.equal(sent.body.thread_id, body.id);
  assert.deepEqual(calls[calls.length - 1].messages, [{ role: 'user', content: 'new topic' }]);
  const list = await call('GET', '/chat/threads');
  assert.equal(list.body[0].id, body.id, 'newest first');
});

test('empty text is a 400; history is capped at 20 turns', async () => {
  const empty = await call('POST', '/chat/messages', { thread_id: threadId, text: '   ' });
  assert.equal(empty.status, 400);
  for (let i = 0; i < 12; i++) {
    queue.push(reply({ reply: `r${i}`, proposal: null, new_rules: [], questions: [] }));
    await call('POST', '/chat/messages', { thread_id: threadId, text: `u${i}`, context: {} });
  }
  const req = calls[calls.length - 1];
  assert.equal(req.messages.length, 21, '20 prior turns + the new one');
  assert.equal(req.messages[0].role, 'user');
});

test('status spend equals the ledger sum for today', async () => {
  const st = await call('GET', '/chat/status');
  const sum = desk.getDb().prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n FROM model_calls`).get();
  assert.equal(st.body.spent_today_usd, Math.round(sum.usd * 1e6) / 1e6);
  assert.equal(st.body.calls_today, sum.n);
  assert.equal(st.body.can_chat, true);
});

// ── the real Anthropic seam, with fetch stubbed (no network, fake keys; a fresh client per key) ──
test('provider.complete builds a Fable-legal request and maps refusals and typed errors', async () => {
  const provider = require('../src/model/provider');
  const realFetch = globalThis.fetch;
  const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const captured = [];
  try {
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(init.body) });
      return jsonResponse(200, {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ reply: 'hi', proposal: null, new_rules: [], questions: [] }) }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
      });
    };
    const r = await provider.complete({
      role: 'chat', apiKey: 'sk-fake-1', schema: chat.ProposalSchema,
      system: [{ type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'VOLATILE' }],
      messages: [{ role: 'user', content: 'hello' }],
    });
    const c = captured[0];
    assert.match(c.url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    assert.equal(c.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(c.headers['x-api-key'], 'sk-fake-1');
    assert.deepEqual(Object.keys(c.body).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
    assert.equal(c.body.model, 'claude-fable-5-1');
    assert.equal(c.body.max_tokens, 3000);
    assert.equal(c.body.fallbacks, 'default');
    assert.equal(c.body.output_config.effort, 'medium');
    assert.equal(c.body.output_config.format.type, 'json_schema');
    assert.deepEqual(c.body.output_config.format.schema.required, ['reply', 'proposal', 'new_rules', 'questions']);
    for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools']) assert.ok(!(k in c.body), `${k} must not be sent to Fable 5.1`);
    assert.deepEqual(c.body.system[0].cache_control, { type: 'ephemeral' });
    assert.ok(!('cache_control' in c.body.system[1]));
    assert.deepEqual(c.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(r.provider, 'anthropic'); assert.equal(r.model, 'claude-fable-5-1'); assert.equal(r.stop_reason, 'end_turn');
    assert.deepEqual(r.json, { reply: 'hi', proposal: null, new_rules: [], questions: [] });
    assert.equal(r.cost_usd, 0.002225, '100 x $10 + 20 x $50 + 900 x $0.25 per MTok');
    assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 });

    // refusal: stop_reason checked BEFORE content
    globalThis.fetch = async () => jsonResponse(200, { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-fable-5-1', stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'other', explanation: 'no' }, content: [{ type: 'text', text: 'should not be read' }], usage: { input_tokens: 5, output_tokens: 0 } });
    const ref = await provider.complete({ role: 'chat', apiKey: 'sk-fake-2', system: 'x', messages: [{ role: 'user', content: 'y' }] });
    assert.equal(ref.stop_reason, 'refusal'); assert.equal(ref.text, null); assert.equal(ref.json, null);
    assert.deepEqual(ref.refusal, { category: 'other', explanation: 'no' });

    // typed errors → plain sentences (no string matching on messages)
    globalThis.fetch = async () => jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    await assert.rejects(provider.complete({ role: 'chat', apiKey: 'sk-fake-3', system: 'x', messages: [{ role: 'user', content: 'y' }] }),
      (e) => e.plain === 'the key in the keychain was rejected' && e.kind === 'auth');
    globalThis.fetch = async () => jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    await assert.rejects(provider.complete({ role: 'chat', apiKey: 'sk-fake-4', system: 'x', messages: [{ role: 'user', content: 'y' }] }),
      (e) => e.plain === 'rate limited, try again in a minute' && e.kind === 'rate_limit');
    globalThis.fetch = async () => jsonResponse(500, { type: 'error', error: { type: 'api_error', message: 'boom' } });
    await assert.rejects(provider.complete({ role: 'chat', apiKey: 'sk-fake-5', system: 'x', messages: [{ role: 'user', content: 'y' }] }),
      (e) => /^the model service answered 500: /.test(e.plain) && e.kind === 'api');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('parseProposal accepts a record-shaped changes object too and coerces confidence', () => {
  const p = chat.parseProposal(JSON.stringify({ reply: 'x', proposal: { changes: { htf: 30 }, summary: 's', confidence: 'certain' }, new_rules: [], questions: [] }));
  assert.equal(p.ok, true);
  assert.deepEqual(p.value.proposal.changes, [{ key: 'htf', value: 30 }]);
  assert.equal(p.value.proposal.confidence, 'guess');
  assert.equal(chat.parseProposal('nope').ok, false);
  assert.equal(chat.parseProposal('{"proposal": null}').ok, false, 'reply is required');
});
