const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');

// ── GET /api/journal — paginated trade list with journal fields ───────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { account, page = 1, limit = 50, search = '', grade = '', reviewed, dateFrom, sort = 'entry_datetime', dir = 'DESC' } = req.query;

    const conditions = [];
    const params     = [];

    if (account && account !== 'All') { conditions.push('account = ?'); params.push(account); }
    if (grade)                        { conditions.push('grade = ?');   params.push(grade); }
    if (search)                       { conditions.push("(symbol LIKE ? OR strategy LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    if (reviewed === 'yes')           { conditions.push("reviewed = 1"); }
    if (reviewed === 'no')            { conditions.push("(reviewed IS NULL OR reviewed = 0)"); }
    if (dateFrom)                     { conditions.push("date(entry_datetime) >= date(?)"); params.push(dateFrom); }

    const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const lim    = parseInt(limit);
    const ALLOWED_SORT = ['entry_datetime','exit_datetime','symbol','pnl','status','grade','reviewed','emotion','entry_quality','exit_quality'];
    const sortCol = ALLOWED_SORT.includes(sort) ? sort : 'entry_datetime';
    const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';

    const countRow = db.prepare(`SELECT COUNT(*) as c FROM trades ${where}`).get(...params);
    const total    = countRow ? countRow.c : 0;

    const trades = db.prepare(`
      SELECT id, trade_id, account, symbol, market, position, strategy,
             entry_datetime, exit_datetime, pnl, status, lot_size,
             grade, lessons, emotion, rule_followed, entry_quality, exit_quality,
             session, screenshot,
             COALESCE(reviewed, 0) as reviewed
      FROM trades ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ${lim} OFFSET ${offset}
    `).all(...params);

    res.json({ trades, total, page: parseInt(page), limit: lim });
  } catch (err) {
    console.error('[journal GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/journal/:id — single trade full detail ───────────────────────────
router.get('/:id', (req, res) => {
  const db = getDb();
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(req.params.id);
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  res.json(trade);
});

// ── PATCH /api/journal/:id/reviewed — quick toggle reviewed status ─────────────
router.patch('/:id/reviewed', (req, res) => {
  const db = getDb();
  const { reviewed } = req.body;
  db.prepare(`UPDATE trades SET reviewed = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(reviewed ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// ── PUT /api/journal/:id — save journal review fields ─────────────────────────
router.put('/:id', (req, res) => {
  const db = getDb();
  const { grade, lessons, strategy, emotion, rule_followed, entry_quality, exit_quality, session, screenshot, reviewed } = req.body;

  db.prepare(`
    UPDATE trades SET
      grade          = ?,
      lessons        = ?,
      strategy       = ?,
      emotion        = ?,
      rule_followed  = ?,
      entry_quality  = ?,
      exit_quality   = ?,
      session        = ?,
      screenshot     = ?,
      reviewed       = ?,
      updated_at     = datetime('now')
    WHERE id = ?
  `).run(
    grade         ?? null,
    lessons       ?? null,
    strategy      ?? null,
    emotion       ?? null,
    rule_followed != null ? (rule_followed ? 1 : 0) : null,
    entry_quality ?? null,
    exit_quality  ?? null,
    session       ?? null,
    screenshot    ?? null,
    reviewed      ? 1 : 0,
    req.params.id,
  );

  res.json({ success: true });
});

module.exports = router;
