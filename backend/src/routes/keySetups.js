const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function parse(s) {
  return {
    ...s,
    tags:       s.tags       ? JSON.parse(s.tags)       : [],
    trade_data: s.trade_data ? JSON.parse(s.trade_data) : null,
  };
}

// GET all setups
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM key_setups ORDER BY created_at DESC').all();
    res.json(rows.map(parse));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET single setup
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM key_setups WHERE id = ?').get(req.params.id);
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
    const { name, symbol, timeframe, pattern, tags, notes, screenshot, video_url, source_trade_id, trade_data } = req.body;
    const result = db.prepare(`
      INSERT INTO key_setups (name, symbol, timeframe, pattern, tags, notes, screenshot, video_url, source_trade_id, trade_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      symbol          || null,
      timeframe       || null,
      pattern         || null,
      tags            ? JSON.stringify(tags)       : null,
      notes           || null,
      screenshot      || null,
      video_url       || null,
      source_trade_id || null,
      trade_data      ? JSON.stringify(trade_data) : null,
    );
    const row = db.prepare('SELECT * FROM key_setups WHERE id = ?').get(result.lastInsertRowid);
    res.json(parse(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const { name, symbol, timeframe, pattern, tags, notes, screenshot, video_url, trade_data } = req.body;
    db.prepare(`
      UPDATE key_setups
      SET name=?, symbol=?, timeframe=?, pattern=?, tags=?, notes=?, screenshot=?, video_url=?, trade_data=?,
          updated_at=datetime('now')
      WHERE id=?
    `).run(
      name,
      symbol     || null,
      timeframe  || null,
      pattern    || null,
      tags       ? JSON.stringify(tags)       : null,
      notes      || null,
      screenshot || null,
      video_url  || null,
      trade_data ? JSON.stringify(trade_data) : null,
      req.params.id,
    );
    const row = db.prepare('SELECT * FROM key_setups WHERE id = ?').get(req.params.id);
    res.json(parse(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM key_setups WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST bulk import (from JSON share file)
router.post('/import', (req, res) => {
  try {
    const db = getDb();
    const { setups } = req.body;
    if (!Array.isArray(setups)) return res.status(400).json({ error: 'Expected { setups: [...] }' });

    const insert = db.prepare(`
      INSERT INTO key_setups (name, symbol, timeframe, pattern, tags, notes, screenshot, video_url, source_trade_id, trade_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const tx = db.transaction((rows) => {
      rows.forEach(s => {
        insert.run(
          s.name || 'Imported Setup',
          s.symbol     || null,
          s.timeframe  || null,
          s.pattern    || null,
          s.tags       ? JSON.stringify(Array.isArray(s.tags) ? s.tags : []) : null,
          s.notes      || null,
          s.screenshot || null,
          s.video_url  || null,
          null,
          s.trade_data ? JSON.stringify(s.trade_data) : null,
        );
        inserted++;
      });
    });
    tx(setups);
    res.json({ inserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
