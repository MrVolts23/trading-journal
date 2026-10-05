const test = require('node:test');
const assert = require('node:assert/strict');
const { sizeTrade, equityCurve, sizeTrades } = require('../src/math/sizing');

const profile = { account_ccy: 'CAD', account_size: 3454.22, risk_pct_per_trade: 1.0, hard_lot_cap: 1.0 };

test('sizeTrade: 1% of 3454.22 on a $5.00 stop → 0.06 lots, +2R = $60', () => {
  const s = sizeTrade({ risk: 5.0, r: 2 }, profile, 3454.22);
  assert.equal(s.risk_usd, 34.54);
  assert.equal(s.lots, 0.06);          // 34.5422 / (5 × 100) = 0.0690 → floor to lot_step 0.01
  assert.equal(s.pnl_usd, 60);         // 2 × 5 × 100 × 0.06
  assert.equal(s.unsizable, false);
  assert.equal(s.ccy, 'CAD');
});

test('sizeTrade: loser is negative, risk derived from entry/sl when risk absent', () => {
  const s = sizeTrade({ entry: 3300, sl: 3295, r: -1 }, profile, 3454.22);
  assert.equal(s.lots, 0.06);
  assert.equal(s.pnl_usd, -30);
});

test('sizeTrade: stop too wide for the balance → unsizable, pnl 0', () => {
  const s = sizeTrade({ risk: 40, r: 3 }, profile, 3454.22); // 34.54/4000 = 0.0086 < 0.01
  assert.equal(s.unsizable, true);
  assert.equal(s.lots, 0);
  assert.equal(s.pnl_usd, 0);
  assert.match(s.reason, /min_lot/);
});

test('sizeTrade: hard_lot_cap caps lots', () => {
  const s = sizeTrade({ risk: 5, r: 1 }, profile, 1_000_000);
  assert.equal(s.lots, 1.0);
  assert.equal(s.reason, 'capped_at_hard_lot_cap');
  assert.equal(s.pnl_usd, 500);
});

test('sizeTrade: symbol_facts override is honoured', () => {
  const s = sizeTrade({ risk: 5, r: 1 }, { ...profile, symbol_facts: { usd_per_point_per_lot: 10, lot_step: 0.1, min_lot: 0.1 } }, 3454.22);
  assert.equal(s.lots, 0.6); // 34.54/(5×10)=0.69 → 0.6
  assert.equal(s.pnl_usd, 30);
});

test('equityCurve: fixed vs compounding', () => {
  const trades = [
    { entryT: 100, exitT: 200, risk: 5, r: 2 },
    { entryT: 300, exitT: 400, risk: 5, r: -1 },
  ];
  const fixed = equityCurve(trades, profile, 1000);
  assert.equal(fixed.length, 2);
  assert.equal(fixed[0].balance, 1020);   // 1% of 1000 = 10 → 0.02 lots → 2×5×100×0.02 = 20
  assert.equal(fixed[1].balance, 1010);
  assert.equal(fixed[1].r_cum, 1);
  const comp = equityCurve(trades, { ...profile, compounding: true }, 5000);
  assert.equal(comp[0].balance, 5100);    // 50 → 0.1 lots → +100
  assert.equal(comp[1].balance, 5050);    // 51 → 0.1 lots → −50
});

test('sizeTrades: attaches fields and totals', () => {
  const { trades, summary } = sizeTrades([
    { entryT: 1, exitT: 2, risk: 5, r: 2 },
    { entryT: 3, exitT: 4, risk: 40, r: 1 },
  ], profile, 3454.22);
  assert.equal(trades[0].pnl_usd, 60);
  assert.equal(trades[1].unsizable, true);
  assert.equal(summary.sized, 1);
  assert.equal(summary.unsizable, 1);
  assert.equal(summary.net_usd, 60);
  assert.equal(summary.ccy, 'CAD');
});
