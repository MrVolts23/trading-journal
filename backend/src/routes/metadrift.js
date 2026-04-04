const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');

// ── Balance builder ───────────────────────────────────────────────────────────
//
// Builds a map of date → { open, close } for every day that has trades.
//
// Formula (matches dashboard / withdrawal plan / statsService):
//   balance(t) = Σ account_activity.amount (up to t) + Σ trade P&L (up to t)
//
// Deposits in account_activity have positive amounts.
// Withdrawals have negative amounts (stored directly from broker profit field).
// We start from 0 and accumulate — NO separate "startingBalance" that could double-count.
//
// account_activity dates that fall on non-trading days (weekends, holidays) are still
// processed so that withdrawals/deposits made on those days correctly shift the next
// trading-day opening balance.
//
function buildDailyBalances(db, account) {
  const acctClause = account && account !== 'All'
    ? `AND account = '${account.replace(/'/g, "''")}'`
    : '';

  // All daily trade P&L, all-time (we need full history for accurate running total)
  const tradeRows = db.prepare(`
    SELECT DATE(exit_datetime) AS date, SUM(pnl) AS daily_pnl
    FROM trades
    WHERE 1=1 ${acctClause}
    GROUP BY DATE(exit_datetime)
    ORDER BY date ASC
  `).all();

  // All account activity (deposits positive, withdrawals negative), all-time
  const activityRows = db.prepare(`
    SELECT date, SUM(amount) AS net_amount
    FROM account_activity
    WHERE 1=1 ${acctClause}
    GROUP BY date
    ORDER BY date ASC
  `).all();

  // Build per-date lookup maps
  const pnlByDate      = {};
  const activityByDate = {};
  for (const r of tradeRows)    pnlByDate[r.date]      = r.daily_pnl  || 0;
  for (const a of activityRows) activityByDate[a.date]  = a.net_amount || 0;

  // Sorted union of all dates (trading days + activity-only days)
  const allDates = new Set([
    ...tradeRows.map(r => r.date),
    ...activityRows.map(a => a.date),
  ]);
  const sorted = [...allDates].sort();

  // Determine the seed balance:
  //   If account_activity has real deposit entries → start at 0 and accumulate everything naturally.
  //   If NO deposit entries (fresh install — user only set initial_deposit in Settings)
  //     → seed from accounts.initial_deposit.
  // We query specifically for activity_type='deposit' so corrections (which can be positive)
  // don't accidentally trigger the "has real data" path when only corrections exist.
  const depositCountRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM account_activity
    WHERE activity_type = 'deposit' ${acctClause}
  `).get();
  const depositTotal = depositCountRow?.cnt || 0;

  let running = 0;
  if (depositTotal === 0) {
    // No deposit history — seed from manually-entered starting balance in accounts table
    const acctFilter = account && account !== 'All'
      ? `WHERE name = '${account.replace(/'/g, "''")}'`
      : '';
    const initRow = db.prepare(
      `SELECT COALESCE(SUM(initial_deposit), 0) AS total FROM accounts ${acctFilter}`
    ).get();
    running = initRow?.total || 0;
  }

  const balanceMap = {}; // date → { open, close }

  for (const date of sorted) {
    const dayActivity = activityByDate[date] || 0;
    const dayPnl      = pnlByDate[date]      || 0;

    // Apply any deposit/withdrawal first (they hit the account at open)
    running += dayActivity;

    // Only record open/close for days that actually had trades
    if (pnlByDate[date] !== undefined) {
      balanceMap[date] = { open: running, close: running + dayPnl };
    }

    running += dayPnl;
  }

  return balanceMap;
}

// ── GET /api/metadrift/calendar ───────────────────────────────────────────────
router.get('/calendar', (req, res) => {
  try {
    const db = getDb();
    const { year, month, account } = req.query;
    const y    = parseInt(year)  || new Date().getFullYear();
    const m    = parseInt(month) || new Date().getMonth() + 1;
    const acct = account || 'All';

    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay    = new Date(y, m, 0).getDate();
    const monthEnd   = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const acctClause = acct !== 'All'
      ? `AND account = '${acct.replace(/'/g, "''")}'`
      : '';

    // Daily P&L, wins, losses for the requested month only
    const days = db.prepare(`
      SELECT
        DATE(exit_datetime)                                   AS date,
        SUM(pnl)                                              AS daily_pnl,
        COUNT(*)                                              AS trade_count,
        SUM(CASE WHEN status='WIN'  THEN 1 ELSE 0 END)       AS wins,
        SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END)       AS losses
      FROM trades
      WHERE DATE(exit_datetime) >= ? AND DATE(exit_datetime) <= ?
      ${acctClause}
      GROUP BY DATE(exit_datetime)
      ORDER BY date ASC
    `).all(monthStart, monthEnd);

    // Running balances — built from full history for accuracy
    const balanceMap = buildDailyBalances(db, acct === 'All' ? null : acct);

    // Account activity for the month (deposits/withdrawals) — so the frontend
    // can display them in calendar cells. Fetch slightly wider window (prev 2 days)
    // so weekend activity shows on the correct Monday cell.
    const prevMonthEnd = new Date(y, m - 1, 0); // last day of previous month
    const windowStart  = new Date(Math.max(
      prevMonthEnd.getTime(),
      new Date(monthStart).getTime() - 2 * 86400000 // 2 days before month start
    )).toISOString().slice(0, 10);

    const activityRows = db.prepare(`
      SELECT date, SUM(amount) AS net_amount
      FROM account_activity
      WHERE date >= ? AND date <= ?
      ${acctClause}
      GROUP BY date
      ORDER BY date ASC
    `).all(windowStart, monthEnd);

    // Build a date→net_amount map (only non-zero entries)
    const activityMap = {};
    for (const a of activityRows) {
      if (a.net_amount && Math.abs(a.net_amount) > 0.01) {
        activityMap[a.date] = a.net_amount;
      }
    }

    // Saved MetaDrift RR entries for this month
    const rrEntries = db.prepare(`
      SELECT date, rr_value, notes FROM metadrift_entries
      WHERE date >= ? AND date <= ? AND account = ?
    `).all(monthStart, monthEnd, acct);

    const rrMap = Object.fromEntries(
      rrEntries.map(r => [r.date, { rr_value: r.rr_value, notes: r.notes }])
    );

    const result = days.map(d => ({
      date:          d.date,
      daily_pnl:     d.daily_pnl,
      trade_count:   d.trade_count,
      wins:          d.wins,
      losses:        d.losses,
      open_balance:  balanceMap[d.date]?.open  ?? null,
      close_balance: balanceMap[d.date]?.close ?? null,
      net_activity:  activityMap[d.date]       ?? null,
      rr_value:      rrMap[d.date]?.rr_value   ?? null,
      notes:         rrMap[d.date]?.notes       ?? null,
    }));

    res.json({ year: y, month: m, days: result, activityMap });
  } catch (err) {
    console.error('[MetaDrift] calendar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/metadrift/entry ─────────────────────────────────────────────────
router.post('/entry', (req, res) => {
  try {
    const db = getDb();
    const { date, account = 'All', rr_value, notes } = req.body;
    if (!date) return res.status(400).json({ error: 'date is required' });

    db.prepare(`
      INSERT INTO metadrift_entries (date, account, rr_value, notes, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(date, account) DO UPDATE SET
        rr_value   = excluded.rr_value,
        notes      = excluded.notes,
        updated_at = datetime('now')
    `).run(date, account, rr_value ?? null, notes ?? null);

    res.json({ ok: true });
  } catch (err) {
    console.error('[MetaDrift] save entry error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/metadrift/entry/:date ─────────────────────────────────────────
router.delete('/entry/:date', (req, res) => {
  try {
    const db = getDb();
    const { date } = req.params;
    const { account = 'All' } = req.query;
    db.prepare(`DELETE FROM metadrift_entries WHERE date = ? AND account = ?`).run(date, account);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
