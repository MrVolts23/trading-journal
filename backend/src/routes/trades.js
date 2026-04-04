const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/trades
router.get('/', (req, res) => {
  const db = getDb();
  const { account, status, market, strategy, symbol, dateStart, dateEnd, sort = 'entry_datetime', dir = 'DESC', page = 1, limit = 100 } = req.query;

  const conditions = [];
  const params = {};

  if (account && account !== 'All') { conditions.push('account = @account'); params.account = account; }
  if (status && status !== 'All') { conditions.push('status = @status'); params.status = status; }
  if (market && market !== 'All') { conditions.push('market = @market'); params.market = market; }
  if (strategy && strategy !== 'All') { conditions.push('strategy = @strategy'); params.strategy = strategy; }
  if (symbol) { conditions.push('symbol LIKE @symbol'); params.symbol = `%${symbol}%`; }
  if (dateStart) { conditions.push("entry_datetime >= @dateStart"); params.dateStart = dateStart; }
  if (dateEnd) { conditions.push("entry_datetime <= @dateEnd"); params.dateEnd = dateEnd + ' 23:59:59'; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const allowedSorts = ['entry_datetime', 'exit_datetime', 'symbol', 'pnl', 'status', 'strategy', 'market', 'r_multiple', 'account', 'lot_size'];
  const safeSort = allowedSorts.includes(sort) ? sort : 'entry_datetime';
  const safeDir = dir === 'ASC' ? 'ASC' : 'DESC';
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const total = db.prepare(`SELECT COUNT(*) as count FROM trades ${where}`).get(params).count;

  // Cumulative P&L window + time-aware withdrawals so balance reflects actual account state.
  const trades = db.prepare(`
    WITH running AS (
      SELECT id,
        SUM(COALESCE(pnl, 0)) OVER (
          PARTITION BY account
          ORDER BY entry_datetime, id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_pnl
      FROM trades
    )
    SELECT t.*, r.running_pnl,
      COALESCE((
        SELECT SUM(aa.amount)
        FROM account_activity aa
        WHERE aa.account = t.account
          AND aa.date <= date(t.entry_datetime)
          AND aa.activity_type = 'withdrawal'
      ), 0) AS withdrawals_to_date
    FROM trades t
    JOIN running r ON t.id = r.id
    ${where}
    ORDER BY ${safeSort} ${safeDir}
    LIMIT ${parseInt(limit)} OFFSET ${offset}
  `).all(params);

  // Use ONLY deposits as the starting balance (withdrawals are applied per-trade above).
  const accountNames = [...new Set(trades.map(t => t.account))];
  const initialBalances = {};
  accountNames.forEach(name => {
    const dep = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total_deposits
      FROM account_activity WHERE account = ? AND activity_type = 'deposit'
    `).get(name);

    if (dep && dep.total_deposits !== 0) {
      initialBalances[name] = dep.total_deposits;
    } else {
      const acc = db.prepare('SELECT initial_deposit FROM accounts WHERE name = ?').get(name);
      initialBalances[name] = acc?.initial_deposit || 0;
    }
  });

  // Also return account_activity rows (deposits + withdrawals) to display as timeline events.
  const activityRows = db.prepare(`
    SELECT *, 'activity' AS _row_type FROM account_activity
    WHERE account IN (${accountNames.map(() => '?').join(',') || "''"})
    ORDER BY date DESC
  `).all(accountNames);

  res.json({ trades, total, page: parseInt(page), limit: parseInt(limit), initialBalances, activityRows });
});

// GET /api/trades/export/csv — must be before /:id to avoid route conflict
router.get('/export/csv', (req, res) => {
  const db = getDb();
  const { account, status, market, strategy, dateStart, dateEnd } = req.query;

  const conditions = [];
  const params = {};
  if (account && account !== 'All') { conditions.push('account = @account'); params.account = account; }
  if (status && status !== 'All') { conditions.push('status = @status'); params.status = status; }
  if (market && market !== 'All') { conditions.push('market = @market'); params.market = market; }
  if (strategy && strategy !== 'All') { conditions.push('strategy = @strategy'); params.strategy = strategy; }
  if (dateStart) { conditions.push("entry_datetime >= @dateStart"); params.dateStart = dateStart; }
  if (dateEnd) { conditions.push("entry_datetime <= @dateEnd"); params.dateEnd = dateEnd + ' 23:59:59'; }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const trades = db.prepare(`SELECT * FROM trades ${where} ORDER BY entry_datetime DESC`).all(params);

  const headers = ['trade_id','account','symbol','market','position','strategy','entry_datetime','entry_price','lot_size','take_profit','stop_loss','exit_price','exit_datetime','commission','pnl','pnl_pct','r_multiple','risk_reward','duration','weekday','status','lessons'];
  const csv = [
    headers.join(','),
    ...trades.map(t => headers.map(h => {
      const val = t[h] ?? '';
      return String(val).includes(',') ? `"${val}"` : val;
    }).join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="trades.csv"');
  res.send(csv);
});

// GET /api/trades/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  res.json(trade);
});

// POST /api/trades — manual trade entry
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;

  // Auto-generate trade_id if not provided
  if (!b.trade_id) {
    const dateStr = (b.entry_datetime || new Date().toISOString()).replace(/[-: T]/g, '').slice(0, 8);
    const count = db.prepare('SELECT COUNT(*) as c FROM trades').get().c;
    b.trade_id = `T${dateStr}-M${count + 1}`;
  }

  // Derive status from pnl if not set
  if (!b.status) {
    if (b.pnl > 0) b.status = 'WIN';
    else if (b.pnl < 0) b.status = 'LOSS';
    else if (b.pnl === 0) b.status = 'B/E';
    else b.status = 'OPEN';
  }

  // Derive market from symbol if not set
  if (!b.market && b.symbol) {
    const metals = ['XAUUSD','XAGUSD','GOLD','SILVER'];
    b.market = metals.some(m => b.symbol.toUpperCase().includes(m)) ? 'METAL' : 'FOREX';
  }

  // Derive weekday
  if (b.entry_datetime && !b.weekday) {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    b.weekday = days[new Date(b.entry_datetime).getDay()];
  }

  try {
    const result = db.prepare(`
      INSERT INTO trades (
        trade_id, account, symbol, market, position, strategy,
        entry_datetime, entry_price, lot_size, take_profit, stop_loss,
        exit_price, exit_datetime, commission, position_size, pip_size,
        pip_value, pnl, pnl_pct, r_multiple, risk_reward, max_profit,
        max_loss, duration, weekday, status, lessons, grade
      ) VALUES (
        @trade_id, @account, @symbol, @market, @position, @strategy,
        @entry_datetime, @entry_price, @lot_size, @take_profit, @stop_loss,
        @exit_price, @exit_datetime, @commission, @position_size, @pip_size,
        @pip_value, @pnl, @pnl_pct, @r_multiple, @risk_reward, @max_profit,
        @max_loss, @duration, @weekday, @status, @lessons, @grade
      )
    `).run({
      trade_id: b.trade_id, account: b.account || 'EightCap',
      symbol: b.symbol || null, market: b.market || null,
      position: b.position || null, strategy: b.strategy || null,
      entry_datetime: b.entry_datetime || null, entry_price: b.entry_price || null,
      lot_size: b.lot_size || null, take_profit: b.take_profit || null,
      stop_loss: b.stop_loss || null, exit_price: b.exit_price || null,
      exit_datetime: b.exit_datetime || null, commission: b.commission || 0,
      position_size: b.position_size || null, pip_size: b.pip_size || null,
      pip_value: b.pip_value || null, pnl: b.pnl || null,
      pnl_pct: b.pnl_pct || null, r_multiple: b.r_multiple || null,
      risk_reward: b.risk_reward || null, max_profit: b.max_profit || null,
      max_loss: b.max_loss || null, duration: b.duration || null,
      weekday: b.weekday || null, status: b.status || 'OPEN',
      lessons: b.lessons || null, grade: b.grade || null,
    });
    const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(result.lastInsertRowid);
    res.json(trade);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/trades/:id — update lessons, grade, or other editable fields
router.patch('/:id', (req, res) => {
  const db = getDb();
  const allowed = ['lessons', 'grade', 'strategy', 'status'];
  const updates = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  updates.id = req.params.id;

  db.prepare(`UPDATE trades SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run(updates);
  const updated = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/trades/clear-account/:account — remove all trades AND account activity for an account
router.delete('/clear-account/:account', (req, res) => {
  const db = getDb();
  const account = req.params.account;

  const run = db.transaction(() => {
    const tradesDeleted   = db.prepare('DELETE FROM trades WHERE account = ?').run(account).changes;
    const activityDeleted = account === 'All'
      ? db.prepare('DELETE FROM account_activity').run().changes
      : db.prepare('DELETE FROM account_activity WHERE account = ?').run(account).changes;
    return { tradesDeleted, activityDeleted };
  });

  const result = run();
  res.json({ success: true, deleted: result.tradesDeleted, activityDeleted: result.activityDeleted });
});

// DELETE /api/trades/clean-noise/:account — remove SL/TP/noise entries (case-insensitive)
router.delete('/clean-noise/:account', (req, res) => {
  const db = getDb();
  const noisePositions = ['stop loss', 'take profit', 'stop', 'market', 'buy stop', 'sell stop', 'buy limit', 'sell limit', 'balance', 'credit', 'correction', 'cancelled', 'canceled', 'rejected', 'expired'];
  const placeholders = noisePositions.map(() => '?').join(',');
  const account = req.params.account;
  const query = account === 'All'
    ? `DELETE FROM trades WHERE LOWER(position) IN (${placeholders})`
    : `DELETE FROM trades WHERE account = ? AND LOWER(position) IN (${placeholders})`;
  const params = account === 'All' ? noisePositions : [account, ...noisePositions];
  const result = db.prepare(query).run(...params);
  res.json({ success: true, deleted: result.changes });
});

// DELETE /api/trades/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM trades WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});


module.exports = router;
