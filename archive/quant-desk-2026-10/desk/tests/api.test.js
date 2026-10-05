// Quant Desk — API tests (node --test). Supertest-free: the router is mounted in a throwaway express
// app on an ephemeral port and hit with global fetch. desk.db is redirected to a temp dir via
// QUANT_DESK_DIR BEFORE the api module is required, so the real ~/Library desk.db is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-desk-api-'));
process.env.QUANT_DESK_DIR = tmp;

const express = require('express');
const api = require('../src/api');
const desk = require('../src/db');

let server, base;

test.before(async () => {
  const app = express();
  app.use('/api/desk', api);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/desk`;
  // a strategy to hang experiments on (the real desk gets these from scripts/import_gma.js)
  const db = desk.getDb();
  const params = { htf: 15, ltf: 3, pivotStrengthHtf: 2, pivotStrengthLtf: 1, rr: 2, exitModel: 'liquidity_v1', trailPadUsd: 0.3 };
  db.prepare(`INSERT INTO strategies (name, family, symbol, version, params_resolved, params_sha, lifecycle, source)
              VALUES ('test strategy', 'double_bos', 'XAUUSD', 1, ?, ?, 'idea', 'test')`)
    .run(JSON.stringify(params), desk.paramsSha(params));
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

test('GET /status reports db, manifest slot, active profile and trial count', async () => {
  const { status, body } = await call('GET', '/status');
  assert.equal(status, 200);
  assert.equal(body.db, path.join(tmp, 'desk.db'));
  assert.ok('data_manifest' in body);
  assert.equal(typeof body.active_profile_id, 'number');
  assert.equal(typeof body.n_trials, 'number');
  assert.equal(body.holdout, 'none yet (seeded data is burned)');
  assert.equal(body.counts.strategies, 1);
});

test('GET /risk-profile returns the default with max_daily_loss_r 2.0 mike-confirmed', async () => {
  const { status, body } = await call('GET', '/risk-profile');
  assert.equal(status, 200);
  assert.equal(body.status, 'active');
  assert.equal(body.fields.max_daily_loss_r, 2.0);
  assert.equal(body.provenance.max_daily_loss_r, 'mike-confirmed');
  assert.equal(body.risk_pct_hard_max, 3.0);
});

test('PUT /risk-profile rejects 4% risk per trade with 400', async () => {
  const { status, body } = await call('PUT', '/risk-profile', { risk_pct_per_trade: 4 });
  assert.equal(status, 400);
  assert.match(body.error, /risk_pct_per_trade/);
});

test('PUT /risk-profile rejects non-numeric and non-positive daily cap', async () => {
  let r = await call('PUT', '/risk-profile', { max_daily_loss_r: 0 });
  assert.equal(r.status, 400);
  r = await call('PUT', '/risk-profile', { max_trades_per_day: 'six' });
  assert.equal(r.status, 400);
});

test('PUT /risk-profile accepts a valid change and marks it mike-confirmed', async () => {
  const { status, body } = await call('PUT', '/risk-profile', { risk_pct_per_trade: 1.5, max_trades_per_day: 4 });
  assert.equal(status, 200);
  assert.equal(body.fields.risk_pct_per_trade, 1.5);
  assert.equal(body.fields.max_trades_per_day, 4);
  assert.equal(body.provenance.risk_pct_per_trade, 'mike-confirmed');
  assert.equal(body.provenance.max_trades_per_day, 'mike-confirmed');
  assert.equal(body.provenance.account_size, 'claude-assumed');
  assert.deepEqual(body.changed.sort(), ['max_trades_per_day', 'risk_pct_per_trade']);
  assert.equal(body.version, 2);
});

test('POST /experiments without hypothesis → 400', async () => {
  const { status, body } = await call('POST', '/experiments', { strategy_id: 1, params_delta: { trailPadUsd: 0.5 } });
  assert.equal(status, 400);
  assert.match(body.error, /hypothesis/);
  const blank = await call('POST', '/experiments', { strategy_id: 1, hypothesis: '   ' });
  assert.equal(blank.status, 400);
});

test('POST /experiments with unknown strategy → 400', async () => {
  const { status } = await call('POST', '/experiments', { strategy_id: 999, hypothesis: 'x' });
  assert.equal(status, 400);
});

test('POST /experiments validates params_delta against schema.json (when present)', async () => {
  const schema = await call('GET', '/schema');
  if (schema.status !== 200) { console.log('schema.json not present yet — skipping range validation assertions'); return; }
  const bad = await call('POST', '/experiments', { strategy_id: 1, hypothesis: 'bad range', params_delta: { pivotStrengthLtf: 999 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /pivotStrengthLtf/);
  const badChoice = await call('POST', '/experiments', { strategy_id: 1, hypothesis: 'bad choice', params_delta: { exitModel: 'moon' } });
  assert.equal(badChoice.status, 400);
  const unknown = await call('POST', '/experiments', { strategy_id: 1, hypothesis: 'unknown key', params_delta: { notAParam: 1 } });
  assert.equal(unknown.status, 400);
});

test('POST valid experiment → 200 with params_sha, planned, planned_by mike', async () => {
  const { status, body } = await call('POST', '/experiments', {
    strategy_id: 1, hypothesis: 'Wider trail pad keeps winners in noisy Asia', params_delta: { trailPadUsd: 0.5 },
  });
  assert.equal(status, 200);
  assert.match(body.params_sha, /^[0-9a-f]{64}$/);
  assert.equal(body.status, 'planned');
  assert.equal(body.planned_by, 'mike');
  assert.equal(body.params_resolved.trailPadUsd, 0.5);
  assert.equal(body.params_resolved.exitModel, 'liquidity_v1');
  assert.deepEqual(body.params_delta, { trailPadUsd: 0.5 });
  assert.equal(body.duplicate_of, null);

  const list = await call('GET', '/experiments?status=planned');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, body.id);
  assert.equal(list.body[0].strategy_name, 'test strategy');

  // same params again → flagged as a duplicate of the first (still allowed: a re-run is a trial)
  const again = await call('POST', '/experiments', { strategy_id: 1, hypothesis: 'same again', params_delta: { trailPadUsd: 0.5 } });
  assert.equal(again.body.duplicate_of, body.id);
});

test('GET /leaderboard is empty but well-formed before any bake', async () => {
  const { status, body } = await call('GET', '/leaderboard?window=month');
  assert.equal(status, 200);
  assert.equal(body.window, 'month');
  assert.deepEqual(body.rows, []);
  assert.deepEqual(body.rejected, []);
  assert.equal(body.holdout, 'none yet (seeded data is burned)');
});

test('GET /experiments/:id 404 for unknown', async () => {
  const { status } = await call('GET', '/experiments/424242');
  assert.equal(status, 404);
});
