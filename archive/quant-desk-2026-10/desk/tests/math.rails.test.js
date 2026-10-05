const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEntryGate, railsReport, engineParamsFromProfile } = require('../src/math/rails');

const srv = (y, m, d, h, mi = 0) => Date.UTC(y, m - 1, d, h, mi) / 1000;
// PT day 2026-07-01 spans server 2026-07-01 10:00 → 2026-07-02 10:00
const D1 = (h, mi = 0) => srv(2026, 7, 1, h, mi);
const tr = (entryT, exitT, r, session = 'ny') => ({ entryT, exitT, r, session });

test('max_daily_loss_r: entries stop after −2R closed in a PT day, resume next PT day', () => {
  const gate = makeEntryGate({ max_daily_loss_r: 2.0 });
  const closed = [tr(D1(14), D1(15), -1), tr(D1(16), D1(17), -1)];
  assert.equal(gate({ t: D1(18), session: 'ny', tradesSoFar: closed, openCount: 0 }), false);
  // only −1.5R so far → still allowed
  assert.equal(gate({ t: D1(18), session: 'ny', tradesSoFar: [closed[0], tr(D1(16), D1(17), -0.5)], openCount: 0 }), true);
  // next PT day (server 2026-07-02 12:00 = PT 07-02 02:00) → allowed again
  assert.equal(gate({ t: srv(2026, 7, 2, 12), session: 'ny', tradesSoFar: closed, openCount: 0 }), true);
  // a win after the two losers lifts the day above the cap
  assert.equal(gate({ t: D1(20), session: 'ny', tradesSoFar: [...closed, tr(D1(18), D1(19), 1.5)], openCount: 0 }), true);
});

test('max_daily_loss_r default is 2.0 when the profile omits it', () => {
  const gate = makeEntryGate({});
  assert.equal(gate({ t: D1(18), tradesSoFar: [tr(D1(14), D1(15), -2)], openCount: 0 }), false);
});

test('max_trades_per_day counts closed-today + open', () => {
  const gate = makeEntryGate({ max_daily_loss_r: 100, max_trades_per_day: 3 });
  const two = [tr(D1(14), D1(15), 1), tr(D1(16), D1(17), 1)];
  assert.equal(gate({ t: D1(18), session: 'ny', tradesSoFar: two, openCount: 0 }), true);
  assert.equal(gate({ t: D1(18), session: 'ny', tradesSoFar: two, openCount: 1 }), false);
  assert.equal(gate({ t: D1(18), session: 'ny', tradesSoFar: [...two, tr(D1(17), D1(17, 30), 1)], openCount: 0 }), false);
});

test('max_trades_per_session is per session', () => {
  const gate = makeEntryGate({ max_daily_loss_r: 100, max_trades_per_session: 2 });
  const asia = [tr(D1(14), D1(15), 1, 'asia'), tr(D1(16), D1(17), 1, 'asia')];
  assert.equal(gate({ t: D1(18), session: 'asia', tradesSoFar: asia, openCount: 0 }), false);
  assert.equal(gate({ t: D1(18), session: 'ny', tradesSoFar: asia, openCount: 0 }), true);
});

test('max_consecutive_losses stops the day; a win resets the streak', () => {
  const gate = makeEntryGate({ max_daily_loss_r: 100, max_consecutive_losses: 3 });
  const three = [tr(D1(12), D1(13), -0.3), tr(D1(14), D1(15), -0.3), tr(D1(16), D1(17), -0.3)];
  assert.equal(gate({ t: D1(18), session: 'ny', tradesSoFar: three, openCount: 0 }), false);
  const reset = [three[0], three[1], tr(D1(15, 30), D1(15, 45), 0.5), three[2]];
  assert.equal(gate({ t: D1(18), session: 'ny', tradesSoFar: reset, openCount: 0 }), true);
});

test('railsReport: daily cap hits and worst day', () => {
  const trades = [tr(D1(14), D1(15), -1), tr(D1(16), D1(17), -1.2), tr(srv(2026, 7, 2, 14), srv(2026, 7, 2, 15), 2)];
  const rep = railsReport(trades, { max_daily_loss_r: 2 });
  assert.equal(rep.daily_cap_hits, 1);
  assert.deepEqual(rep.days_stopped, ['2026-07-01']);
  assert.equal(rep.worst_day_r, -2.2);
  assert.equal(rep.worst_day, '2026-07-01');
  assert.equal(rep.days, 2);
});

test('engineParamsFromProfile maps sessions → windows, cost model, max_concurrent', () => {
  const p = engineParamsFromProfile({
    sessions: [{ name: 'asia', start: 15, end: 23 }, { name: 'ny', start: 4, end: 13.5 }],
    max_concurrent: 1, cost_model: { spreadUsd: 0.25, slippageUsd: 0.05 },
  });
  assert.deepEqual(p, { windows: [{ name: 'asia', start: 15, end: 23 }, { name: 'ny', start: 4, end: 13.5 }], maxConcurrent: 1, spreadUsd: 0.25, slippageUsd: 0.05 });
});
