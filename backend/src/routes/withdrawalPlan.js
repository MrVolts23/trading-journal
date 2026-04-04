const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// ── GET settings ─────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM withdrawal_plan_settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = JSON.parse(r.value); });
  res.json(settings);
});

// ── PUT settings ─────────────────────────────────────────────────────────────
router.put('/settings', (req, res) => {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO withdrawal_plan_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `);
  const saveAll = db.transaction((data) => {
    Object.entries(data).forEach(([key, value]) => {
      upsert.run(key, JSON.stringify(value));
    });
  });
  saveAll(req.body);
  res.json({ success: true });
});

// ── GET actuals ───────────────────────────────────────────────────────────────
router.get('/actuals', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM withdrawal_plan_actuals ORDER BY week_num').all();
  // Return as { [weekNum]: { withdrawal_taken, notes } }
  const actuals = {};
  rows.forEach(r => { actuals[r.week_num] = r; });
  res.json(actuals);
});

// ── PUT actuals/:weekNum ──────────────────────────────────────────────────────
router.put('/actuals/:weekNum', (req, res) => {
  const db = getDb();
  const weekNum = parseInt(req.params.weekNum);
  const { withdrawal_taken, notes } = req.body;
  db.prepare(`
    INSERT INTO withdrawal_plan_actuals (week_num, withdrawal_taken, notes, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(week_num) DO UPDATE SET
      withdrawal_taken=excluded.withdrawal_taken,
      notes=excluded.notes,
      updated_at=excluded.updated_at
  // withdrawal_taken: null means "clear override, revert to auto-calc"
  `).run(weekNum, withdrawal_taken ?? null, notes || null);
  res.json({ success: true });
});

// ── GET starting-balance (total deposits from account_activity + real current balance) ──
// Accepts optional ?startDate=YYYY-MM-DD. Deposits on/before that date form the plan
// starting balance. Deposits AFTER that date are "mid-plan" and returned separately so
// the frontend can add them to the actual balance for the week they arrived.
router.get('/starting-balance', (req, res) => {
  const db = getDb();
  const { startDate } = req.query; // e.g. '2026-01-27'

  // Deposits on/before plan start → the opening balance
  const startRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN activity_type = 'deposit' THEN amount ELSE 0 END), 0) AS total_deposits,
      COUNT(CASE WHEN activity_type = 'deposit' THEN 1 END) AS deposit_count,
      MIN(CASE WHEN activity_type = 'deposit' THEN date END) AS first_deposit_date
    FROM account_activity
    WHERE ${startDate ? "date <= ?" : "1=1"}
  `).get(...(startDate ? [startDate] : []));

  // Actual withdrawals only (shown as "extracted funds" on dashboard/withdrawal plan)
  // Corrections are kept separate — they adjust the balance silently without appearing as withdrawals
  const wdRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN activity_type = 'withdrawal' THEN amount ELSE 0 END), 0) AS total_withdrawals,
      COALESCE(SUM(CASE WHEN activity_type = 'correction' THEN amount ELSE 0 END), 0) AS total_corrections
    FROM account_activity
  `).get();

  // Mid-plan deposits (after start date) — each row with its date so frontend can slot them into the right week
  const midPlanDeposits = startDate
    ? db.prepare(`SELECT date, SUM(amount) AS amount FROM account_activity WHERE activity_type = 'deposit' AND date > ? GROUP BY date ORDER BY date`).all(startDate)
    : [];

  // Net P&L from all closed trades
  const pnlRow = db.prepare(`SELECT COALESCE(SUM(pnl), 0) AS net_pnl FROM trades WHERE pnl IS NOT NULL`).get();

  let totalDeposits      = startRow.total_deposits    || 0;
  const totalWithdrawals = wdRow.total_withdrawals    || 0;
  const totalCorrections = wdRow.total_corrections    || 0;
  const netPnl           = pnlRow.net_pnl             || 0;

  // If no deposit history in account_activity, fall back to initial_deposit from accounts table
  // (fresh install where user manually entered their starting balance in Settings)
  if (totalDeposits === 0) {
    const initRow = db.prepare(
      `SELECT COALESCE(SUM(initial_deposit), 0) AS total FROM accounts`
    ).get();
    totalDeposits = initRow?.total || 0;
  }

  // Balance includes corrections but they don't show as extracted funds
  const currentBalance = totalDeposits + netPnl + totalWithdrawals + totalCorrections
    + midPlanDeposits.reduce((s, r) => s + r.amount, 0);

  res.json({
    total_deposits:      totalDeposits,
    total_withdrawals:   totalWithdrawals,  // actual withdrawals only — corrections excluded
    deposit_count:       startRow.deposit_count,
    first_deposit_date:  startRow.first_deposit_date,
    has_real_data:       (startRow.deposit_count || 0) > 0 || totalDeposits > 0,
    net_pnl:             netPnl,
    current_balance:     currentBalance,
    mid_plan_deposits:   midPlanDeposits,
  });
});

// ── GET weekly-pnl (from trades) ─────────────────────────────────────────────
router.get('/weekly-pnl', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%W', entry_datetime) as week_key,
      date(MIN(entry_datetime))         as week_start,
      SUM(pnl)                          as total_pnl,
      COUNT(*)                          as trade_count,
      SUM(CASE WHEN status='WIN'  THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses
    FROM trades
    WHERE status IN ('WIN','LOSS','B/E') AND pnl IS NOT NULL
    GROUP BY week_key
    ORDER BY week_key
  `).all();
  res.json(rows);
});

module.exports = router;
