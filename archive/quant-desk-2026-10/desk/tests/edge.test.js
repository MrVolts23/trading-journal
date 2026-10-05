// Quant Desk — Edge: rule sheet rendering, version bump, and the Edge → Results → Activity routes
// on an ephemeral express app. desk.db goes to a temp dir (QUANT_DESK_DIR) and the research csv is a
// small synthetic file (QUANT_DESK_CSV), both set BEFORE any desk module loads, so the real desk.db and
// the real 100k-bar csv are never touched and a bake takes well under a second.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-desk-edge-'));
process.env.QUANT_DESK_DIR = tmp;
process.env.QUANT_DESK_CSV = path.join(tmp, 'synthetic_M1.csv');

// ── synthetic M1 data: 10 days of a seeded random walk with swings, so the engine finds structure ──
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
const edge = require('../src/edge');
const engine = require('../engine/engine');

let server, base, seedId;
const SEED_PARAMS = { ...engine.DEFAULTS, pivotStrengthLtf: 1, maxEntriesPerArm: 3, exitModel: 'trail_ltf' };

test.before(async () => {
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
  desk.closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method, route, body) {
  const res = await fetch(base + route, {
    method, headers: { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const RAW_KEYS = ['htf', 'ltf', 'pivotStrength', 'slPaddingUsd', 'exitModel', 'trailPadUsd', 'armExpiryHtfBars', 'maxEntriesPerArm', 'liquidityLookbackDays', 'tpBufferUsd'];

// ── edge.js unit behaviour ─────────────────────────────────────────────────────────────
test('bumpLabel / nextVersion bump the last numeric segment and skip taken names', () => {
  assert.equal(edge.bumpLabel('v2.1'), 'v2.2');
  assert.equal(edge.bumpLabel('v2'), 'v2.1', 'a child of a single-segment version gets a minor segment');
  assert.equal(edge.bumpLabel('v1'), 'v1.1');
  assert.equal(edge.bumpLabel('v2.1.4'), 'v2.1.5');
  assert.equal(edge.bumpLabel('v2.9'), 'v2.10');
  const db = desk.getDb();
  const parent = db.prepare(`SELECT * FROM strategies WHERE id = ?`).get(seedId);
  const n = edge.nextVersion(db, parent);
  assert.equal(n.label, 'v2.2');
  assert.equal(n.name, 'Double BOS v2.2');
  assert.equal(n.number, 4);
});

test('show_when expressions', () => {
  assert.equal(edge.evalShowWhen('exitModel == fixed_rr', { exitModel: 'fixed_rr' }), true);
  assert.equal(edge.evalShowWhen('exitModel == fixed_rr', { exitModel: 'combo' }), false);
  assert.equal(edge.evalShowWhen('exitModel in [trail_ltf, liquidity_v1, liquidity_v2, combo]', { exitModel: 'combo' }), true);
  assert.equal(edge.evalShowWhen('exitModel in [trail_ltf, liquidity_v1]', { exitModel: 'fixed_rr' }), false);
  assert.equal(edge.evalShowWhen('exitModel != combo and beAtR == null', { exitModel: 'fixed_rr', beAtR: null }), true);
  assert.equal(edge.evalShowWhen(null, {}), true);
});

test('renderSheet: six groups in order, every placeholder is a bound param, labels never leak keys', () => {
  const r = edge.renderSheet(SEED_PARAMS);
  assert.deepEqual(r.groups.map((g) => g.name), ['Setup', 'Entry', 'Stop', 'Exit', 'Session']);
  assert.equal(r.advanced.length, 14);
  const all = new Set();
  for (const g of r.groups) for (const rule of g.rules) for (const p of rule.params) all.add(p.key);
  for (const p of r.advanced) all.add(p.key);
  for (const k of ['windows', 'spreadUsd', 'slippageUsd']) assert.ok(!all.has(k), `${k} is a Risk page field`);
  for (const g of r.groups) for (const rule of g.rules) {
    for (const m of String(rule.text).matchAll(/\{([A-Za-z0-9_]+)\}/g)) assert.ok(all.has(m[1]), `${rule.id}: {${m[1]}} is bound`);
    assert.ok(!/\{[A-Za-z0-9_]+:/.test(rule.text), `${rule.id}: choice template normalized`);
    assert.ok(['mike-confirmed', 'claude-assumed'].includes(rule.tag));
  }
  const x1 = r.groups.find((g) => g.name === 'Exit').rules.find((x) => x.id === 'x1');
  assert.equal(x1.params[0].choices.find((c) => c.value === 'liquidity_v1').label, 'aim for the last liquidity point, trail behind swings as a backstop');
  const byId = Object.fromEntries(r.groups.flatMap((g) => g.rules).map((x) => [x.id, x]));
  assert.equal(byId.x2.visible, false, 'fixed target hidden while trailing');
  assert.equal(byId.x3.visible, true);
  assert.equal(byId.x4.visible, false);
  assert.equal(byId.x4b.visible, false);
  assert.equal(byId.se1.link.to, '/desk/risk');
  // the engine only trails for trail_ltf / liquidity_v1 / combo; liquidity_v2 has no trail and no target,
  // so its sheet shows the pool rule (x4b) and neither the trail padding (x3) nor the target rule (x4).
  const v2 = Object.fromEntries(edge.renderSheet({ ...SEED_PARAMS, exitModel: 'liquidity_v2' }).groups.flatMap((g) => g.rules).map((x) => [x.id, x]));
  assert.deepEqual([v2.x2.visible, v2.x3.visible, v2.x4.visible, v2.x4b.visible, v2.x5.visible], [false, false, false, true, false]);
  const combo = Object.fromEntries(edge.renderSheet({ ...SEED_PARAMS, exitModel: 'combo' }).groups.flatMap((g) => g.rules).map((x) => [x.id, x]));
  assert.deepEqual([combo.x3.visible, combo.x4.visible, combo.x4b.visible, combo.x5.visible], [true, true, false, true]);
  const fixed = Object.fromEntries(edge.renderSheet({ ...SEED_PARAMS, exitModel: 'fixed_rr' }).groups.flatMap((g) => g.rules).map((x) => [x.id, x]));
  assert.deepEqual([fixed.x2.visible, fixed.x3.visible, fixed.x4.visible, fixed.x4b.visible], [true, false, false, false]);
  for (const p of r.advanced) { assert.ok(p.label && !/[a-z][A-Z]/.test(p.label), `${p.key} label is English: ${p.label}`); }
  const trail = r.advanced.find((p) => p.key === 'trailMode');
  assert.equal(trail.label, 'Trail behind');
  assert.equal(trail.choices.find((c) => c.value === 'chandelier').label, 'an ATR distance');
});

test('renderSheetText is plain English with values filled in and no raw keys', () => {
  const txt = edge.renderSheetText({ ...SEED_PARAMS, exitModel: 'liquidity_v1', beAtR: 0.5 });
  assert.match(txt, /Read structure on the 15-minute chart and take entries on the 3-minute chart\./);
  assert.match(txt, /Exit style: aim for the last liquidity point/);
  assert.match(txt, /Liquidity targets look back 5 days and take profit \$0\.50 before the level\./);
  assert.match(txt, /breakeven at 0\.5R/);
  for (const k of RAW_KEYS) assert.ok(!txt.includes(k), `sheet text leaks ${k}`);
});

test('changeSentence uses labels and choice labels', () => {
  assert.equal(edge.changeSentence('pivotStrengthLtf', 2, 1), 'Entry-chart swing strength (bars each side): 2 → 1');
  assert.equal(edge.changeSentence('exitModel', 'trail_ltf', 'liquidity_v1'),
    'Exit style: trail the stop behind confirmed swings → aim for the last liquidity point, trail behind swings as a backstop');
  assert.equal(edge.changeSentence('beAtR', null, 0.5), 'Move the stop to breakeven at (R): blank → 0.5');
  assert.equal(edge.changeSentence('useEmaExit', false, true), 'Exit winners at the structure-chart EMA wall: no → yes');
});

// ── routes ────────────────────────────────────────────────────────────────────────────
test('GET /rulesheet returns the newest version with groups, advanced and no verdict yet', async () => {
  const { status, body } = await call('GET', '/rulesheet');
  assert.equal(status, 200);
  assert.equal(body.family, 'double_bos');
  assert.equal(body.strategy.id, seedId);
  assert.equal(body.strategy.version, 'v2.1');
  assert.equal(body.latest_verdict, null);
  assert.equal(body.groups.length, 5);
  const p = body.groups[1].rules.find((r) => r.id === 'e2').params[0];
  assert.deepEqual([p.key, p.value, p.unit, p.type, p.min, p.max], ['pivotStrengthLtf', 1, 'bars', 'integer', 1, 10]);
  const missing = await call('GET', '/rulesheet?strategy_id=999');
  assert.equal(missing.status, 404);
});

test('POST /edge/test validates changes against schema.json in English', async () => {
  let r = await call('POST', '/edge/test', { strategy_id: seedId, changes: { exitModel: 'moon' } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Exit style must be one of/);
  r = await call('POST', '/edge/test', { strategy_id: seedId, changes: { pivotStrengthLtf: 999 } });
  assert.equal(r.status, 400); assert.match(r.body.error, /can't be above 10/);
  r = await call('POST', '/edge/test', { strategy_id: seedId, changes: { pivotStrengthLtf: 1.5 } });
  assert.equal(r.status, 400); assert.match(r.body.error, /whole number/);
  r = await call('POST', '/edge/test', { strategy_id: seedId, changes: { windows: [] } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Risk page/);
  r = await call('POST', '/edge/test', { strategy_id: seedId, changes: { notAParam: 1 } });
  assert.equal(r.status, 400); assert.match(r.body.error, /not a rule on this sheet/);
  r = await call('POST', '/edge/test', { strategy_id: 999, changes: {} });
  assert.equal(r.status, 400);
  r = await call('POST', '/edge/test', { strategy_id: seedId, changes: { useEmaExit: 'yes' } });
  assert.equal(r.status, 400); assert.match(r.body.error, /yes or no/);
  // nothing was created by the rejected calls
  assert.equal(desk.getDb().prepare(`SELECT COUNT(*) AS n FROM strategies`).get().n, 1);
  assert.equal(desk.getDb().prepare(`SELECT COUNT(*) AS n FROM experiments`).get().n, 0);
});

let childId, firstExpId;
test('POST /edge/test with changes makes v2.2 from v2.1, bakes it and answers with a verdict + reason', async () => {
  const { status, body } = await call('POST', '/edge/test', {
    strategy_id: seedId, changes: { exitModel: 'liquidity_v1', beAtR: null }, note: 'Try the July champion exit',
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.created_version, true);
  assert.equal(body.strategy.version, 'v2.2');
  assert.equal(body.strategy.name, 'Double BOS v2.2');
  assert.equal(body.strategy.parent_id, seedId);
  assert.equal(body.parent.version, 'v2.1');
  assert.deepEqual(body.changes, { exitModel: 'liquidity_v1' }, 'the no-op beAtR change was dropped');
  assert.equal(body.changes_text[0], 'Exit style: trail the stop behind confirmed swings → aim for the last liquidity point, trail behind swings as a backstop');
  assert.ok(['PASS', 'REJECT', 'BLOCKED'].includes(body.verdict), body.verdict);
  assert.equal(typeof body.reason, 'string'); assert.ok(body.reason.length > 5);
  assert.ok(!body.reason.includes('_'), body.reason);
  assert.equal(typeof body.experiment_id, 'number');
  assert.equal(body.holdout, 'none yet (seeded data is burned)');
  childId = body.strategy.id; firstExpId = body.experiment_id;

  const db = desk.getDb();
  const s = db.prepare(`SELECT * FROM strategies WHERE id = ?`).get(childId);
  assert.equal(s.source, 'edge'); assert.equal(s.lifecycle, 'in_sample'); assert.equal(s.version, 4);
  const resolved = JSON.parse(s.params_resolved);
  assert.equal(resolved.exitModel, 'liquidity_v1'); assert.equal(resolved.pivotStrengthLtf, 1);
  assert.equal(s.params_sha, desk.paramsSha(resolved));
  assert.match(s.rule_sheet_text, /Exit style: aim for the last liquidity point/);
  for (const k of RAW_KEYS) assert.ok(!s.rule_sheet_text.includes(k), `rule_sheet_text leaks ${k}`);
  const e = db.prepare(`SELECT * FROM experiments WHERE id = ?`).get(firstExpId);
  assert.equal(e.strategy_id, childId); assert.equal(e.planned_by, 'mike'); assert.equal(e.source, 'edge');
  assert.equal(e.hypothesis, 'Try the July champion exit');
  assert.deepEqual(JSON.parse(e.params_delta), { exitModel: 'liquidity_v1' });
  assert.ok(['done', 'failed'].includes(e.status));
  if (body.verdict !== 'ERROR') assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM gate_verdicts WHERE experiment_id = ?`).get(firstExpId).n, 1);
});

test('POST /edge/test with no changes re-tests the same version (no new strategy) with an auto hypothesis', async () => {
  const before = desk.getDb().prepare(`SELECT COUNT(*) AS n FROM strategies`).get().n;
  const { status, body } = await call('POST', '/edge/test', { strategy_id: childId, changes: {} });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.created_version, false);
  assert.equal(body.strategy.id, childId);
  assert.notEqual(body.experiment_id, firstExpId);
  assert.equal(desk.getDb().prepare(`SELECT COUNT(*) AS n FROM strategies`).get().n, before);
  const e = desk.getDb().prepare(`SELECT hypothesis FROM experiments WHERE id = ?`).get(body.experiment_id);
  assert.equal(e.hypothesis, 'Re-test of v2.2 with no changes');
  // a change equal to the current value is also "no change"
  const same = await call('POST', '/edge/test', { strategy_id: childId, changes: { exitModel: 'liquidity_v1' } });
  assert.equal(same.body.created_version, false);
});

test('a second change off v2.1 becomes v2.3 (v2.2 is taken)', async () => {
  const { status, body } = await call('POST', '/edge/test', { strategy_id: seedId, changes: { pivotStrengthHtf: 3 } });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.strategy.version, 'v2.3');
  const e = desk.getDb().prepare(`SELECT hypothesis FROM experiments WHERE id = ?`).get(body.experiment_id);
  assert.equal(e.hypothesis, 'Changed: Structure-chart swing strength (bars each side): 2 → 3');
});

test('GET /versions lists the lineage newest first with tests and last_verdict as a string', async () => {
  const { status, body } = await call('GET', '/versions?family=double_bos');
  assert.equal(status, 200);
  assert.deepEqual(body.map((v) => v.version), ['v2.3', 'v2.2', 'v2.1']);
  const v22 = body.find((v) => v.version === 'v2.2');
  assert.equal(v22.parent_id, seedId); assert.equal(v22.parent_version, 'v2.1'); assert.equal(v22.source, 'edge');
  assert.ok(v22.tests >= 2);
  assert.ok(v22.last_verdict === null || typeof v22.last_verdict === 'string');
  assert.equal(body.find((v) => v.version === 'v2.1').tests, 0);
  assert.equal(body.find((v) => v.version === 'v2.1').last_verdict, null);
});

test('GET /rulesheet for v2.2 shows its latest verdict with a reason', async () => {
  const { body } = await call('GET', `/rulesheet?strategy_id=${childId}`);
  assert.equal(body.strategy.version, 'v2.2');
  if (body.latest_verdict) {
    assert.equal(typeof body.latest_verdict.experiment_id, 'number');
    assert.equal(typeof body.latest_verdict.reason, 'string');
    assert.match(body.latest_verdict.tested_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/);
  }
  const x4 = body.groups.find((g) => g.name === 'Exit').rules.find((r) => r.id === 'x4');
  assert.equal(x4.visible, true, 'liquidity rule visible once the exit is liquidity_v1');
});

test('GET /results lists every desk-judged test newest first with summary for the chosen window', async () => {
  const { status, body } = await call('GET', '/results?window=week');
  assert.equal(status, 200);
  assert.equal(body.window, 'week');
  assert.ok(Array.isArray(body.rows) && body.rows.length >= 3);
  assert.deepEqual(body.results, body.rows);
  assert.equal(body.holdout, 'none yet (seeded data is burned)');
  assert.equal(typeof body.n_trials, 'number');
  assert.match(body.data.text, /^100,000 one-minute gold bars, Mar 24 to Jul 3\. No clean holdout yet\. Trials so far: \d+\.$/);
  const ids = body.rows.map((r) => r.experiment_id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
  const first = body.rows.find((r) => r.experiment_id === firstExpId);
  assert.equal(first.strategy.version, 'v2.2');
  assert.equal(first.note, 'Try the July champion exit');
  assert.deepEqual(first.changes, { exitModel: 'liquidity_v1' });
  assert.equal(typeof first.reason, 'string');
  if (first.summary) {
    for (const k of ['trades', 'win_rate', 'net_r', 'rr', 'median_week_r', 'positive_weeks', 'max_dd_r', 'net_usd']) assert.ok(k in first.summary, k);
  }
  const retest = body.rows.find((r) => r.experiment_id !== firstExpId && r.strategy.id === childId);
  assert.equal(retest.note, null, 'auto hypotheses are not shown as notes');
  const month = await call('GET', '/results?window=month');
  assert.equal(month.body.window, 'month');
  const fm = month.body.rows.find((r) => r.experiment_id === firstExpId);
  if (fm.summary) assert.ok('median_month_r' in fm.summary && 'positive_months' in fm.summary);
});

test('GET /results/:id is the experiment detail plus reason, gate rows and the rendered rule sheet', async () => {
  const { status, body } = await call('GET', `/results/${firstExpId}`);
  assert.equal(status, 200);
  assert.equal(body.experiment.id, firstExpId);
  assert.equal(typeof body.reason, 'string');
  assert.ok(Array.isArray(body.gate_rows));
  for (const g of body.gate_rows) { assert.ok(!/_/.test(g.label), g.label); assert.equal(typeof g.needed, 'string'); }
  assert.match(body.rule_sheet_text, /Exit style: aim for the last liquidity point/);
  assert.ok('equity' in body && 'folds' in body && 'trades' in body, 'existing detail payload kept');
  const missing = await call('GET', '/results/424242');
  assert.equal(missing.status, 404);
});

test('GET /activity is plain sentences newest first in PT', async () => {
  const { status, body } = await call('GET', '/activity?limit=50');
  assert.equal(status, 200);
  assert.ok(body.length >= 5);
  for (const e of body) {
    assert.ok(['test', 'version', 'risk', 'note'].includes(e.kind), e.kind);
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/);
    assert.match(e.text, /\.$/);
    for (const k of RAW_KEYS) assert.ok(!e.text.includes(k), `${e.text} leaks ${k}`);
    assert.ok(!e.text.includes('—'));
  }
  const times = body.map((e) => new Date(e.ts).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.ok(body.some((e) => e.text === 'Created v2.2 from v2.1.'), JSON.stringify(body.map((e) => e.text)));
  assert.ok(body.some((e) => /^Changed 1 rule and tested as v2\.2\. (PASS|FAIL|BLOCKED): /.test(e.text)));
  assert.ok(body.some((e) => /^Tested v2\.2\. (PASS|FAIL|BLOCKED): /.test(e.text)));
  assert.ok(body.some((e) => e.text === 'Loaded 100,000 one-minute gold bars, Mar 24 to Jul 3; no clean holdout yet.'));
  // a risk profile save shows up in words
  await call('PUT', '/risk-profile', { max_trades_per_day: 4 });
  const after = await call('GET', '/activity');
  assert.ok(after.body.some((e) => e.kind === 'risk' && /^Risk profile saved: .*max trades per day/.test(e.text)), JSON.stringify(after.body.map((e) => e.text)));
});

test('existing routes still answer (slice-1 API kept)', async () => {
  for (const route of ['/status', '/risk-profile', '/strategies', '/experiments', '/leaderboard', '/schema', `/experiments/${firstExpId}`]) {
    const r = await call('GET', route);
    assert.equal(r.status, 200, route);
  }
  const s = await call('GET', '/schema');
  for (const [k, def] of Object.entries(s.body)) assert.equal(typeof def.label, 'string', `${k} has a label`);
});
