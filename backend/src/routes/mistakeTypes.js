const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET all mistake types
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM mistake_types ORDER BY sort_order ASC, id ASC').all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { name, color, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM mistake_types').get()?.m || 0;
    const result = db.prepare(`
      INSERT INTO mistake_types (name, color, description, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(name.trim(), color || '#6b7280', description || null, maxOrder + 1);
    const row = db.prepare('SELECT * FROM mistake_types WHERE id = ?').get(result.lastInsertRowid);
    res.json(row);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Mistake type name already exists' });
    res.status(500).json({ error: e.message });
  }
});

// PUT update
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const { name, color, description } = req.body;
    db.prepare(`
      UPDATE mistake_types SET name=?, color=?, description=? WHERE id=?
    `).run(name?.trim() || '', color || '#6b7280', description || null, req.params.id);
    const row = db.prepare('SELECT * FROM mistake_types WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE — also clears this ID from all key_lessons mistake_types arrays
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    db.prepare('DELETE FROM mistake_types WHERE id = ?').run(id);
    // Clean up lessons: remove this id from their mistake_types arrays
    const lessons = db.prepare('SELECT id, mistake_types FROM key_lessons').all();
    const update = db.prepare('UPDATE key_lessons SET mistake_types=? WHERE id=?');
    lessons.forEach(l => {
      const arr = JSON.parse(l.mistake_types || '[]').filter(x => x !== id);
      update.run(JSON.stringify(arr), l.id);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
