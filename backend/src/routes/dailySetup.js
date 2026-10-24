const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// Compute the $ result from R magnitude, outcome sign, balance and risk %.
// 1R = (risk_pct / 100) * balance.  Win → +, Loss → −.
function calcDollar(outcome, rValue, balance, riskPct) {
  if (rValue == null || balance == null || riskPct == null) return null;
  const oneR = balance * (riskPct / 100);
  const sign = outcome === 'loss' ? -1 : 1;
  return sign * Math.abs(rValue) * oneR;
}

// GET /api/daily-setup?symbol=Gold&date=2026-06-03
// Returns the saved entry for that (symbol, day), or an empty template.
router.get('/', (req, res) => {
  const db = getDb();
  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'symbol and date are required' });
  }
  const row = db
    .prepare('SELECT * FROM daily_setup_entries WHERE symbol = ? AND trade_date = ?')
    .get(symbol, date);
  res.json(row || { symbol, trade_date: date, exists: false });
});

// PUT /api/daily-setup — upsert by (symbol, trade_date)
router.put('/', (req, res) => {
  const db = getDb();
  const {
    symbol, trade_date,
    chart1, chart2, chart3,
    check1, check2, check3,
    outcome, r_value,
    balance_used, risk_pct,
    notes,
  } = req.body;

  if (!symbol || !trade_date) {
    return res.status(400).json({ error: 'symbol and trade_date are required' });
  }

  const rVal    = r_value      == null || r_value      === '' ? null : Number(r_value);
  const balance = balance_used == null || balance_used === '' ? null : Number(balance_used);
  const risk    = risk_pct     == null || risk_pct     === '' ? null : Number(risk_pct);
  const dollar  = calcDollar(outcome || null, rVal, balance, risk);

  db.prepare(`
    INSERT INTO daily_setup_entries
      (symbol, trade_date, chart1, chart2, chart3, check1, check2, check3,
       outcome, r_value, balance_used, risk_pct, dollar_value, notes, updated_at)
    VALUES
      (@symbol, @trade_date, @chart1, @chart2, @chart3, @check1, @check2, @check3,
       @outcome, @r_value, @balance_used, @risk_pct, @dollar_value, @notes, datetime('now'))
    ON CONFLICT(symbol, trade_date) DO UPDATE SET
      chart1=@chart1, chart2=@chart2, chart3=@chart3,
      check1=@check1, check2=@check2, check3=@check3,
      outcome=@outcome, r_value=@r_value, balance_used=@balance_used,
      risk_pct=@risk_pct, dollar_value=@dollar_value, notes=@notes,
      updated_at=datetime('now')
  `).run({
    symbol,
    trade_date,
    chart1: chart1 || null,
    chart2: chart2 || null,
    chart3: chart3 || null,
    check1: check1 ? 1 : 0,
    check2: check2 ? 1 : 0,
    check3: check3 ? 1 : 0,
    outcome: outcome || null,
    r_value: rVal,
    balance_used: balance,
    risk_pct: risk,
    dollar_value: dollar,
    notes: notes || null,
  });

  const row = db
    .prepare('SELECT * FROM daily_setup_entries WHERE symbol = ? AND trade_date = ?')
    .get(symbol, trade_date);
  res.json(row);
});

// DELETE /api/daily-setup?symbol=Gold&date=2026-06-03 — clear a day's entry
router.delete('/', (req, res) => {
  const db = getDb();
  const { symbol, date } = req.query;
  if (!symbol || !date) return res.status(400).json({ error: 'symbol and date are required' });
  db.prepare('DELETE FROM daily_setup_entries WHERE symbol = ? AND trade_date = ?').run(symbol, date);
  res.json({ success: true });
});

module.exports = router;
