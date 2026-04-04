const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { resolveAccount } = require('../services/importService');

// GET all accounts
// Also surfaces any account name that exists in the trades table but has no
// matching row in accounts (e.g. "Paper Trading" created by a TV import when
// the auto-create ran before the backend was last restarted).
router.get('/', (req, res) => {
  const db = getDb();
  // Registered accounts
  const registered = db.prepare('SELECT * FROM accounts ORDER BY name').all();
  const registeredNames = new Set(registered.map(a => a.name));

  // Orphan account names — present in trades but not in accounts table
  const orphans = db.prepare(
    `SELECT DISTINCT account AS name FROM trades WHERE account NOT IN (SELECT name FROM accounts) ORDER BY account`
  ).all();

  // Auto-register orphans so they persist going forward
  const insertAcct = db.prepare('INSERT OR IGNORE INTO accounts (name, broker) VALUES (?, ?)');
  orphans.forEach(o => {
    try { insertAcct.run(o.name, o.name); } catch (_) {}
  });

  // Return the full merged list (re-query after inserts so ids are real)
  const all = db.prepare('SELECT * FROM accounts ORDER BY name').all();
  res.json(all);
});

// POST create account
router.post('/', (req, res) => {
  const db = getDb();
  const { name, broker, currency, initial_deposit, deposit_date } = req.body;
  const result = db.prepare(`
    INSERT INTO accounts (name, broker, currency, initial_deposit, deposit_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, broker, currency || 'USD', initial_deposit || 0, deposit_date);
  res.json({ id: result.lastInsertRowid });
});

// PATCH account — update initial_deposit (starting balance)
router.patch('/:id', (req, res) => {
  const db = getDb();
  const { initial_deposit } = req.body;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  db.prepare('UPDATE accounts SET initial_deposit = ? WHERE id = ?')
    .run(parseFloat(initial_deposit) || 0, req.params.id);
  res.json({ success: true });
});

// DELETE account — removes the account and all its trades + activity rows
router.delete('/:id', (req, res) => {
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const deleteTrades   = db.prepare('DELETE FROM trades WHERE account = ?');
  const deleteActivity = db.prepare('DELETE FROM account_activity WHERE account = ?');
  const deleteAccount  = db.prepare('DELETE FROM accounts WHERE id = ?');

  const run = db.transaction(() => {
    const tradesDeleted   = deleteTrades.run(account.name).changes;
    const activityDeleted = deleteActivity.run(account.name).changes;
    deleteAccount.run(account.id);
    return { tradesDeleted, activityDeleted };
  });

  const result = run();
  res.json({ success: true, name: account.name, tradesDeleted: result.tradesDeleted, activityDeleted: result.activityDeleted });
});

// POST /resolve — find or auto-create an account by broker_account_id (broker Login number)
// Used by the import flow to map a Login column value to an account name.
router.post('/resolve', (req, res) => {
  try {
    const { loginId, broker } = req.body;
    if (!loginId) return res.status(400).json({ error: 'loginId is required' });
    const result = resolveAccount(loginId, broker || 'EightCap');
    res.json(result); // { name, isNew }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET account activity
router.get('/activity', (req, res) => {
  const db = getDb();
  const { account } = req.query;
  const where = account && account !== 'All' ? 'WHERE account = ?' : '';
  const params = account && account !== 'All' ? [account] : [];
  const rows = db.prepare(`SELECT * FROM account_activity ${where} ORDER BY date DESC, id DESC`).all(...params);
  res.json(rows);
});

// POST account activity (manual deposit/withdrawal/adjustment)
router.post('/activity', (req, res) => {
  const db = getDb();
  const { account, date, activity_type, amount, notes } = req.body;

  // Get last balance
  const last = db.prepare(`
    SELECT balance_per_account, total_balance FROM account_activity
    WHERE account = ? ORDER BY date DESC, id DESC LIMIT 1
  `).get(account);

  const prevBalance = last?.balance_per_account || 0;
  const prevTotal = last?.total_balance || 0;
  const newBalance = prevBalance + parseFloat(amount);
  const newTotal = prevTotal + parseFloat(amount);

  const result = db.prepare(`
    INSERT INTO account_activity (account, date, activity_type, amount, balance_per_account, total_balance, running_peak, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(account, date, activity_type, parseFloat(amount), newBalance, newTotal, Math.max(newTotal, last?.running_peak || 0), notes);

  res.json({ id: result.lastInsertRowid });
});

// DELETE account activity entry by id
router.delete('/activity/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM account_activity WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Activity entry not found' });
  db.prepare('DELETE FROM account_activity WHERE id = ?').run(req.params.id);
  res.json({ success: true, deleted: row });
});

// POST /api/accounts/:id/correction — inserts a signed correction into account_activity
// amount can be positive (add funds) or negative (remove funds)
router.post('/:id/correction', (req, res) => {
  const db = getDb();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { amount, date, notes } = req.body;
  const correctionAmount = parseFloat(amount);
  if (isNaN(correctionAmount) || correctionAmount === 0) {
    return res.status(400).json({ error: 'amount must be a non-zero number' });
  }
  const correctionDate = date || new Date().toISOString().slice(0, 10);

  // Get last balance for this account to maintain running totals
  const last = db.prepare(`
    SELECT balance_per_account, total_balance, running_peak FROM account_activity
    WHERE account = ? ORDER BY date DESC, id DESC LIMIT 1
  `).get(account.name);

  const prevBalance = last?.balance_per_account || 0;
  const prevTotal   = last?.total_balance       || 0;
  const newBalance  = prevBalance + correctionAmount;
  const newTotal    = prevTotal   + correctionAmount;
  const newPeak     = Math.max(newTotal, last?.running_peak || 0);

  const result = db.prepare(`
    INSERT INTO account_activity (account, date, activity_type, amount, balance_per_account, total_balance, running_peak, notes)
    VALUES (?, ?, 'correction', ?, ?, ?, ?, ?)
  `).run(account.name, correctionDate, correctionAmount, newBalance, newTotal, newPeak, notes || null);

  res.json({ id: result.lastInsertRowid, account: account.name, amount: correctionAmount, date: correctionDate });
});

// GET settings
router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => {
    try { settings[r.key] = JSON.parse(r.value); }
    catch { settings[r.key] = r.value; }
  });
  res.json(settings);
});

// PATCH settings
router.patch('/settings', (req, res) => {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  Object.entries(req.body).forEach(([k, v]) => {
    upsert.run(k, typeof v === 'string' ? v : JSON.stringify(v));
  });
  res.json({ success: true });
});

module.exports = router;
