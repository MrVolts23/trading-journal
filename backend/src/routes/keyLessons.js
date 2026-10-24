const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function parse(row) {
  return {
    ...row,
    mistake_types: row.mistake_types ? JSON.parse(row.mistake_types) : [],
    trade_data:    row.trade_data    ? JSON.parse(row.trade_data)    : null,
  };
}

// GET all lessons
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM key_lessons ORDER BY created_at DESC').all();
    res.json(rows.map(parse));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET analytics — aggregated mistake data for the mini dashboard
router.get('/analytics', (req, res) => {
  try {
    const db = getDb();

    const total = db.prepare('SELECT COUNT(*) as n FROM key_lessons').get().n;
    const pnlRow = db.prepare('SELECT SUM(pnl) as s FROM key_lessons WHERE pnl IS NOT NULL').get();
    const total_pnl_impact = pnlRow?.s || 0;

    const thisMonth = db.prepare(`
      SELECT COUNT(*) as n FROM key_lessons
      WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `).get().n;

    // Mistake type frequency — use json_each to explode the JSON array
    let by_mistake_type = [];
    try {
      by_mistake_type = db.prepare(`
        SELECT mt.id, mt.name, mt.color, COUNT(*) as count, SUM(kl.pnl) as total_pnl
        FROM key_lessons kl
        JOIN json_each(COALESCE(kl.mistake_types, '[]')) je ON 1=1
        JOIN mistake_types mt ON mt.id = CAST(je.value AS INTEGER)
        GROUP BY mt.id
        ORDER BY count DESC
      `).all();
    } catch (_) {
      // Fallback: manual aggregation if json_each isn't available
      const lessons = db.prepare('SELECT mistake_types, pnl FROM key_lessons').all();
      const allTypes = db.prepare('SELECT * FROM mistake_types').all();
      const counts = {};
      lessons.forEach(l => {
        JSON.parse(l.mistake_types || '[]').forEach(id => {
          if (!counts[id]) counts[id] = { count: 0, total_pnl: 0 };
          counts[id].count++;
          counts[id].total_pnl += l.pnl || 0;
        });
      });
      by_mistake_type = allTypes
        .filter(mt => counts[mt.id])
        .map(mt => ({ ...mt, ...counts[mt.id] }))
        .sort((a, b) => b.count - a.count);
    }

    // Lessons logged per month (last 12 months) for trend line
    const by_month = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month,
             COUNT(*) as count,
             SUM(pnl) as total_pnl
      FROM key_lessons
      WHERE created_at >= date('now', '-12 months')
      GROUP BY month
      ORDER BY month ASC
    `).all();

    const top_mistake = by_mistake_type[0] || null;

    res.json({ total, total_pnl_impact, this_month: thisMonth, by_mistake_type, by_month, top_mistake });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET single lesson
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM key_lessons WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(parse(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const {
      title, symbol, trade_date, pnl,
      mistake_types, what_happened, what_shouldve,
      notes, screenshot, video_url,
      source_trade_id, trade_data,
    } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });

    const result = db.prepare(`
      INSERT INTO key_lessons
        (title, symbol, trade_date, pnl, mistake_types, what_happened, what_shouldve,
         notes, screenshot, video_url, source_trade_id, trade_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title.trim(),
      symbol           || null,
      trade_date       || null,
      pnl              ?? null,
      JSON.stringify(Array.isArray(mistake_types) ? mistake_types : []),
      what_happened    || null,
      what_shouldve    || null,
      notes            || null,
      screenshot       || null,
      video_url        || null,
      source_trade_id  || null,
      trade_data       ? JSON.stringify(trade_data) : null,
    );
    const row = db.prepare('SELECT * FROM key_lessons WHERE id = ?').get(result.lastInsertRowid);
    res.json(parse(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const {
      title, symbol, trade_date, pnl,
      mistake_types, what_happened, what_shouldve,
      notes, screenshot, video_url, trade_data,
    } = req.body;

    db.prepare(`
      UPDATE key_lessons SET
        title=?, symbol=?, trade_date=?, pnl=?,
        mistake_types=?, what_happened=?, what_shouldve=?,
        notes=?, screenshot=?, video_url=?, trade_data=?,
        updated_at=datetime('now')
      WHERE id=?
    `).run(
      title?.trim()    || '',
      symbol           || null,
      trade_date       || null,
      pnl              ?? null,
      JSON.stringify(Array.isArray(mistake_types) ? mistake_types : []),
      what_happened    || null,
      what_shouldve    || null,
      notes            || null,
      screenshot       || null,
      video_url        || null,
      trade_data       ? JSON.stringify(trade_data) : null,
      req.params.id,
    );
    const row = db.prepare('SELECT * FROM key_lessons WHERE id = ?').get(req.params.id);
    res.json(parse(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM key_lessons WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
