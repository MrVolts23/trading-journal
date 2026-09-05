const test = require('node:test');
const assert = require('node:assert/strict');
const { ptDate, isoWeekKey, monthKey, ptKeys, periodStats } = require('../src/math/periods');

// server wall clock (UTC-encoded) → unix seconds
const srv = (y, m, d, h = 12, mi = 0) => Date.UTC(y, m - 1, d, h, mi) / 1000;

test('PT = server − 10h: server 2026-07-01 05:00 is PT 2026-06-30', () => {
  assert.equal(ptDate(srv(2026, 7, 1, 5)), '2026-06-30');
  assert.equal(ptDate(srv(2026, 7, 1, 11)), '2026-07-01');
  assert.equal(monthKey(srv(2026, 7, 1, 5)), '2026-06');
});

test('ISO week keys (checked against Python isocalendar)', () => {
  assert.equal(isoWeekKey(srv(2025, 12, 29, 20)), '2026-W01'); // Mon Dec 29 2025 → week 1 of 2026
  assert.equal(isoWeekKey(srv(2026, 1, 4, 20)), '2026-W01');
  assert.equal(isoWeekKey(srv(2026, 6, 29, 20)), '2026-W27');
  assert.equal(isoWeekKey(srv(2026, 7, 1, 20)), '2026-W27');
  assert.equal(isoWeekKey(srv(2026, 7, 5, 20)), '2026-W27');
  assert.equal(isoWeekKey(srv(2026, 7, 6, 20)), '2026-W28');
  assert.deepEqual(ptKeys(srv(2026, 7, 6, 20)), { pt_date: '2026-07-06', week: '2026-W28', month: '2026-07' });
});

test('periodStats week: correct keys across the June/July boundary', () => {
  const trades = [
    { entryT: srv(2026, 6, 29, 20), exitT: srv(2026, 6, 29, 21), r: 2 },     // W27, June
    { entryT: srv(2026, 7, 1, 20), exitT: srv(2026, 7, 1, 21), r: -1 },     // W27, July
    { entryT: srv(2026, 7, 6, 20), exitT: srv(2026, 7, 6, 21), r: 1.5 },    // W28, July
    { entryT: srv(2026, 7, 7, 20), exitT: srv(2026, 7, 7, 21), r: -1 },     // W28
    { entryT: srv(2026, 7, 8, 20), exitT: srv(2026, 7, 8, 21), r: 0 },      // W28 (0 = loss bucket)
  ];
  const w = periodStats(trades, 'week');
  assert.deepEqual(w.periods.map((p) => p.key), ['2026-W27', '2026-W28']);
  const w27 = w.periods[0];
  assert.equal(w27.trades, 2); assert.equal(w27.wins, 1); assert.equal(w27.losses, 1);
  assert.equal(w27.net_r, 1); assert.equal(w27.avg_win_r, 2); assert.equal(w27.avg_loss_r, -1);
  assert.equal(w27.rr, 2); assert.equal(w27.win_rate, 0.5);
  const w28 = w.periods[1];
  assert.equal(w28.trades, 3); assert.equal(w28.losses, 2);
  assert.equal(w28.avg_loss_r, -0.5); assert.equal(w28.rr, 3); // 1.5 / |−0.5|
  assert.equal(w.summary.periods, 2);
  assert.equal(w.summary.positive_periods, 2);
  assert.equal(w.summary.median_period_r, 0.75);
  assert.equal(w.summary.worst_period_r, 0.5);
  assert.equal(w.summary.best_period_r, 1);
  assert.equal(w.summary.median_rr, 2.5);

  const m = periodStats(trades, 'month');
  assert.deepEqual(m.periods.map((p) => p.key), ['2026-06', '2026-07']);
  assert.equal(m.periods[1].net_r, -0.5);
  assert.equal(m.summary.positive_periods, 1);
});

test('periodStats: uses engine-stamped week/month when present; rr null with no losses; net_usd when sized', () => {
  const trades = [
    { entryT: 1, exitT: 2, r: 1, week: '2026-W10', month: '2026-03', pnl_usd: 50 },
    { entryT: 3, exitT: 4, r: 2, week: '2026-W10', month: '2026-03', pnl_usd: 100 },
  ];
  const w = periodStats(trades, 'week');
  assert.equal(w.periods[0].key, '2026-W10');
  assert.equal(w.periods[0].rr, null);
  assert.equal(w.periods[0].net_usd, 150);
  assert.equal(w.summary.median_rr, null);
});

test('periodStats: empty and bad window', () => {
  const e = periodStats([], 'month');
  assert.equal(e.periods.length, 0);
  assert.equal(e.summary.periods, 0);
  assert.throws(() => periodStats([], 'day'));
});
