// Quant Desk — budget: the worst-case precheck math and the Pacific-day boundary. desk.db in a temp
// dir; no model code is loaded, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-desk-budget-'));
process.env.QUANT_DESK_DIR = tmp;

const desk = require('../src/db');
const budget = require('../src/budget');
const provider = require('../src/model/provider');

const FABLE = { input: 10, output: 50, cache_read: 0.25, cache_write_5m: 12.5 };

test.after(() => { desk.closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('loop-budget.yaml: $10 a day, warn at 80%', () => {
  const b = budget.loadBudget();
  assert.equal(b.daily_cap_usd, 10);
  assert.equal(b.warn_at, 0.8);
});

test('prices.yaml carries Fable 5.1 at $10 / $50 / $0.25 / $12.50 per MTok and costFor uses them', () => {
  assert.deepEqual(provider.pricesFor('claude-fable-5-1'), FABLE);
  const usd = provider.costFor('claude-fable-5-1', { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 4000, cache_creation_input_tokens: 800 });
  // 0.01 + 0.01 + 0.001 + 0.01 = 0.031
  assert.equal(usd, 0.031);
  assert.equal(provider.costFor('unknown-model', { input_tokens: 1e6 }, 'claude-fable-5-1'), 10, 'unknown served model falls back to the requested model');
  assert.equal(provider.costFor('local', { input_tokens: 1e6, output_tokens: 1e6 }), 0);
  const cfg = provider.roleConfig('chat');
  assert.deepEqual([cfg.provider, cfg.model, cfg.effort, cfg.max_tokens], ['anthropic', 'claude-fable-5-1', 'medium', 3000]);
});

test('worst case = prompt tokens x input price + max_tokens x output price', () => {
  assert.equal(budget.worstCaseUsd({ prompt_tokens: 10000, max_tokens: 3000, prices: FABLE }), 0.25);
  assert.equal(budget.worstCaseUsd({ prompt_tokens: 0, max_tokens: 0, prices: FABLE }), 0);
  assert.equal(budget.worstCaseUsd({ prompt_tokens: 1e6, max_tokens: 0, prices: null }), 0);
  assert.equal(budget.estimateTokens('x'.repeat(300)), 100);
  assert.equal(budget.estimateTokens(''), 0);
});

test('Pacific day ranges: PDT starts at 07:00Z, PST at 08:00Z, the fall-back day is 25 hours', () => {
  assert.deepEqual(budget.ptDayRange('2026-09-03'), { day: '2026-09-03', start: '2026-09-03T07:00:00.000Z', end: '2026-09-04T07:00:00.000Z' });
  assert.deepEqual(budget.ptDayRange('2026-01-10'), { day: '2026-01-10', start: '2026-01-10T08:00:00.000Z', end: '2026-01-11T08:00:00.000Z' });
  assert.deepEqual(budget.ptDayRange('2026-11-01'), { day: '2026-11-01', start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z' });
  assert.deepEqual(budget.ptDayRange('2026-03-08'), { day: '2026-03-08', start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T07:00:00.000Z' });
  assert.equal(budget.ptDay(new Date('2026-09-03T06:59:59.000Z')), '2026-09-02');
  assert.equal(budget.ptDay(new Date('2026-09-03T07:00:00.000Z')), '2026-09-03');
  assert.equal(budget.addDays('2026-12-31', 1), '2027-01-01');
});

test('spend is summed per Pacific day: 23:59 PT yesterday is not today', () => {
  const db = desk.getDb();
  const rec = (ts, usd) => budget.recordCall(db, { ts, role: 'chat', provider: 'anthropic', model: 'claude-fable-5-1', usage: { input_tokens: 1 }, cost_usd: usd, ok: 1 });
  rec('2026-09-03T06:59:00.000Z', 4);   // Sep 2, 11:59 PM PT
  rec('2026-09-03T07:00:00.000Z', 1.5); // Sep 3, midnight PT
  rec('2026-09-03T20:00:00.000Z', 2);   // Sep 3, 1 PM PT
  rec('2026-09-04T06:59:59.000Z', 0.5); // Sep 3, 11:59:59 PM PT
  rec('2026-09-04T07:00:00.000Z', 9);   // Sep 4
  const sep3 = budget.spentToday(db, new Date('2026-09-03T18:00:00.000Z'));
  assert.equal(sep3.spent_usd, 4);
  assert.equal(sep3.calls, 3);
  assert.equal(budget.spentToday(db, new Date('2026-09-03T06:00:00.000Z')).spent_usd, 4, 'Sep 2 PT');
  assert.equal(budget.spentToday(db, new Date('2026-09-04T12:00:00.000Z')).spent_usd, 9);
  db.prepare(`DELETE FROM model_calls`).run();
});

test('precheck refuses at or over the cap, counting the worst case of the call about to be made', () => {
  const db = desk.getDb();
  const now = new Date('2026-09-03T18:00:00.000Z');
  const rec = (usd) => budget.recordCall(db, { ts: '2026-09-03T17:00:00.000Z', role: 'chat', provider: 'anthropic', model: 'claude-fable-5-1', usage: {}, cost_usd: usd, ok: 1 });
  // worst case here: 10000 x $10/M + 3000 x $50/M = $0.25
  let p = budget.precheck(db, { prompt_tokens: 10000, max_tokens: 3000, prices: FABLE, now });
  assert.equal(p.ok, true); assert.equal(p.worst_case_usd, 0.25); assert.equal(p.projected_usd, 0.25); assert.equal(p.warn, false);
  assert.equal(p.cap_usd, 10); assert.equal(p.warn_at_usd, 8); assert.equal(p.reason, null);

  rec(9.7); // 9.7 + 0.25 = 9.95 < 10 → allowed, but warned
  p = budget.precheck(db, { prompt_tokens: 10000, max_tokens: 3000, prices: FABLE, now });
  assert.equal(p.ok, true); assert.equal(p.spent_today_usd, 9.7); assert.equal(p.projected_usd, 9.95); assert.equal(p.warn, true);

  rec(0.05); // 9.75 + 0.25 = 10.00 → at the cap → refused
  p = budget.precheck(db, { prompt_tokens: 10000, max_tokens: 3000, prices: FABLE, now });
  assert.equal(p.ok, false); assert.equal(p.projected_usd, 10);
  assert.match(p.reason, /budget is used up \(\$9\.75 of \$10\.00; this call could cost up to \$0\.25\)\. It resets at midnight Pacific\./);

  // a smaller call still fits under the cap
  p = budget.precheck(db, { prompt_tokens: 1000, max_tokens: 500, prices: FABLE, now });
  assert.equal(p.ok, true); assert.equal(p.worst_case_usd, 0.035);

  // yesterday's spend does not count
  p = budget.precheck(db, { prompt_tokens: 10000, max_tokens: 3000, prices: FABLE, now: new Date('2026-09-04T18:00:00.000Z') });
  assert.equal(p.ok, true); assert.equal(p.spent_today_usd, 0);

  const st = budget.statusToday(db, now);
  assert.equal(st.spent_today_usd, 9.75); assert.equal(st.calls_today, 2); assert.equal(st.over_cap, false); assert.equal(st.warn, true);
  db.prepare(`DELETE FROM model_calls`).run();
});

test('recordCall stores failures with ok = 0 and zero usage', () => {
  const db = desk.getDb();
  const id = budget.recordCall(db, { role: 'chat', provider: 'anthropic', model: 'claude-fable-5-1', usage: null, cost_usd: 0, latency_ms: 12.6, ok: 0, error: 'rate limited, try again in a minute' });
  const row = db.prepare(`SELECT * FROM model_calls WHERE id = ?`).get(id);
  assert.equal(row.ok, 0); assert.equal(row.tokens_in, 0); assert.equal(row.cost_usd, 0); assert.equal(row.latency_ms, 13);
  assert.equal(row.error, 'rate limited, try again in a minute');
  assert.match(row.ts, /Z$/);
  db.prepare(`DELETE FROM model_calls`).run();
});
