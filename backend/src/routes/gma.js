// Gold Metal Alchemist API — desk status, ventures, alchemy days/verdicts, escalations, recon.
// Phase 0 skeleton: everything the loops and the Phase 1 UI will talk to.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { scoreDay } = require('../services/gmaScoreService');
const { ingestOnce } = require('../services/gmaIngestService');

const VALID_CODES = ['none', 'flipH', 'flipV', 'both', 'unclear'];

// ── Desk status ────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const db = getDb();
  const today = db
    .prepare(`SELECT COALESCE(SUM(cost_usd),0) AS spent, COUNT(*) AS runs
              FROM gma_loop_runs WHERE date(started_at) = date('now')`)
    .get();
  const lastRuns = db
    .prepare(`SELECT loop_name, status, started_at, finished_at, cost_usd, summary
              FROM gma_loop_runs GROUP BY loop_name HAVING MAX(started_at) ORDER BY started_at DESC`)
    .all();
  const openEscalations = db
    .prepare(`SELECT COUNT(*) AS n FROM gma_escalations WHERE status = 'open'`)
    .get().n;
  res.json({
    budget: { daily_cap_usd: 10, spent_today_usd: today.spent, runs_today: today.runs },
    loops: lastRuns,
    open_escalations: openEscalations,
  });
});

// ── Ventures ───────────────────────────────────────────────────────────────────
router.get('/ventures', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM gma_ventures ORDER BY id').all();
  res.json(rows.map((r) => ({ ...r, config: JSON.parse(r.config) })));
});

router.post('/ventures', (req, res) => {
  const { name, description, config } = req.body;
  if (!name || !config) return res.status(400).json({ error: 'name and config required' });
  try {
    const info = getDb()
      .prepare('INSERT INTO gma_ventures (name, description, config) VALUES (?, ?, ?)')
      .run(name, description || '', JSON.stringify(config));
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/ventures/:id', (req, res) => {
  const { status, description, config } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM gma_ventures WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'venture not found' });
  db.prepare(
    `UPDATE gma_ventures SET
       status = COALESCE(?, status),
       description = COALESCE(?, description),
       config = COALESCE(?, config)
     WHERE id = ?`
  ).run(status || null, description || null, config ? JSON.stringify(config) : null, req.params.id);
  res.json({ ok: true });
});

// ── Experiments (leaderboard) ──────────────────────────────────────────────────
router.get('/ventures/:id/experiments', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT * FROM gma_experiments WHERE venture_id = ?
       ORDER BY score IS NULL, score DESC LIMIT 200`
    )
    .all(req.params.id);
  res.json(rows);
});

// ── Alchemy days + verdicts ────────────────────────────────────────────────────
router.get('/days', (req, res) => {
  const { from, to } = req.query;
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.date, d.symbol, d.key_img, d.print_img, d.key_range, d.print_range,
              d.news_flags, v.human_code,
              CASE WHEN v.human_code IS NULL THEN NULL ELSE v.machine_code END AS machine_code,
              CASE WHEN v.human_code IS NULL THEN NULL ELSE v.machine_confidence END AS machine_confidence,
              v.agreed
       FROM gma_alchemy_days d
       LEFT JOIN gma_verdicts v ON v.day_id = d.id
       WHERE d.date >= COALESCE(?, '0000') AND d.date <= COALESCE(?, '9999')
       ORDER BY d.date DESC LIMIT 100`
    )
    .all(from || null, to || null);
  res.json(rows);
});

// Full day (incl. OHLC JSON) for rendering the verdict card
router.get('/days/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM gma_alchemy_days WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'day not found' });
  let verdict = getDb()
    .prepare('SELECT * FROM gma_verdicts WHERE day_id = ? ORDER BY id DESC')
    .get(row.id);
  // Blind discipline: machine call never leaves the server before the human commits.
  if (verdict && !verdict.human_code) {
    verdict = { ...verdict, machine_code: null, machine_scores: null, machine_confidence: null };
  }
  res.json({ ...row, verdict: verdict || null });
});

// Capture upsert (called by the alchemy-capture loop). Scores the day once both windows exist.
router.post('/days', (req, res) => {
  const { date, symbol = 'XAUUSD', key_ohlc, print_ohlc, news_flags } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const db = getDb();
  const range = (bars) => {
    if (!Array.isArray(bars) || !bars.length) return null;
    const highs = bars.map((b) => b.high ?? b.h), lows = bars.map((b) => b.low ?? b.l);
    return Number((Math.max(...highs) - Math.min(...lows)).toFixed(5));
  };
  db.prepare(
    `INSERT INTO gma_alchemy_days (date, symbol, key_ohlc, print_ohlc, key_range, print_range, news_flags)
     VALUES (@date, @symbol, @key, @print, @krange, @prange, @news)
     ON CONFLICT(date, symbol) DO UPDATE SET
       key_ohlc    = COALESCE(excluded.key_ohlc, key_ohlc),
       print_ohlc  = COALESCE(excluded.print_ohlc, print_ohlc),
       key_range   = COALESCE(excluded.key_range, key_range),
       print_range = COALESCE(excluded.print_range, print_range),
       news_flags  = COALESCE(excluded.news_flags, news_flags)`
  ).run({
    date, symbol,
    key: key_ohlc ? JSON.stringify(key_ohlc) : null,
    print: print_ohlc ? JSON.stringify(print_ohlc) : null,
    krange: range(key_ohlc), prange: range(print_ohlc),
    news: news_flags ? JSON.stringify(news_flags) : null,
  });
  const day = db.prepare('SELECT * FROM gma_alchemy_days WHERE date = ? AND symbol = ?').get(date, symbol);
  let scored = null;
  if (day.key_ohlc && day.print_ohlc) scored = scoreDay(db, day.id);
  res.json({ id: day.id, scored: scored ? { code: scored.code, confidence: scored.confidence } : null });
});

// One-time copy of the old Alchemy Calendar localStorage history (source stays untouched).
router.post('/calendar-import', (req, res) => {
  const { selections } = req.body; // { 'YYYY-MM-DD': 'none'|'flipH'|'flipV'|'both' }
  if (!selections || typeof selections !== 'object')
    return res.status(400).json({ error: 'selections object required' });
  const db = getDb();
  let imported = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const [date, code] of Object.entries(selections)) {
      if (!VALID_CODES.includes(code)) { skipped++; continue; }
      db.prepare('INSERT OR IGNORE INTO gma_alchemy_days (date, symbol) VALUES (?, ?)').run(date, 'XAUUSD');
      const day = db.prepare("SELECT id FROM gma_alchemy_days WHERE date = ? AND symbol = 'XAUUSD'").get(date);
      const existing = db.prepare('SELECT id, human_code FROM gma_verdicts WHERE day_id = ?').get(day.id);
      if (existing && existing.human_code) { skipped++; continue; } // never overwrite a real verdict
      if (existing) {
        db.prepare("UPDATE gma_verdicts SET human_code = ?, source = 'calendar_import' WHERE id = ?")
          .run(code, existing.id);
      } else {
        db.prepare("INSERT INTO gma_verdicts (day_id, human_code, source) VALUES (?, ?, 'calendar_import')")
          .run(day.id, code);
      }
      imported++;
    }
  });
  tx();
  res.json({ imported, skipped });
});

// Manual ingest trigger (the poller runs automatically; this is the "check now" button)
router.post('/ingest/run', (req, res) => {
  try {
    res.json(ingestOnce());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Blind verdict: records the human code; machine fields are written by the loop separately.
router.post('/days/:dayId/verdict', (req, res) => {
  const { human_code, venture_id } = req.body;
  if (!VALID_CODES.includes(human_code))
    return res.status(400).json({ error: `human_code must be one of ${VALID_CODES.join(', ')}` });
  const db = getDb();
  const day = db.prepare('SELECT id FROM gma_alchemy_days WHERE id = ?').get(req.params.dayId);
  if (!day) return res.status(404).json({ error: 'day not found' });

  const existing = db
    .prepare('SELECT id, machine_code, machine_scores, machine_confidence FROM gma_verdicts WHERE day_id = ? ORDER BY id DESC')
    .get(day.id);
  if (existing) {
    db.prepare(
      `UPDATE gma_verdicts SET human_code = ?,
         agreed = CASE WHEN machine_code IS NULL THEN NULL
                       WHEN machine_code = ? THEN 1 ELSE 0 END,
         verdict_at = datetime('now')
       WHERE id = ?`
    ).run(human_code, human_code, existing.id);
    return res.json({
      id: existing.id,
      machine_code: existing.machine_code,
      machine_scores: existing.machine_scores ? JSON.parse(existing.machine_scores) : null,
      machine_confidence: existing.machine_confidence,
    });
  }
  const info = db
    .prepare('INSERT INTO gma_verdicts (day_id, venture_id, human_code) VALUES (?, ?, ?)')
    .run(day.id, venture_id || null, human_code);
  res.json({ id: info.lastInsertRowid, machine_code: null });
});

// Peek: reveal the machine's call BEFORE making a human verdict. The day is flagged
// 'peeked' (non-blind) and excluded from the agreement/calibration stats.
router.post('/days/:dayId/peek', (req, res) => {
  const db = getDb();
  const v = db
    .prepare('SELECT * FROM gma_verdicts WHERE day_id = ? ORDER BY id DESC')
    .get(req.params.dayId);
  if (!v || !v.machine_code) return res.status(404).json({ error: 'no machine call for this day yet' });
  if (!v.human_code) {
    db.prepare(`UPDATE gma_verdicts SET source = 'peeked' WHERE id = ?`).run(v.id);
  }
  res.json({
    machine_code: v.machine_code,
    machine_scores: v.machine_scores ? JSON.parse(v.machine_scores) : null,
    machine_confidence: v.machine_confidence,
    note: v.human_code ? 'already called — no blind to break' : 'day flagged non-blind (peeked)',
  });
});

// Undo a verdict. The human call is cleared and can be re-made — but the day is flagged
// 'revised' because the machine's answer was already revealed: the redo is not blind.
router.delete('/days/:dayId/verdict', (req, res) => {
  const db = getDb();
  const v = db
    .prepare('SELECT id FROM gma_verdicts WHERE day_id = ? ORDER BY id DESC')
    .get(req.params.dayId);
  if (!v) return res.status(404).json({ error: 'no verdict to undo' });
  db.prepare(
    `UPDATE gma_verdicts SET human_code = NULL, agreed = NULL, source = 'revised' WHERE id = ?`
  ).run(v.id);
  res.json({ ok: true, note: 'Call cleared. Redo is marked non-blind (machine answer was seen).' });
});

// Machine-vs-Mike agreement scoreboard (the gate for historical auto-labeling)
router.get('/agreement', (req, res) => {
  // Gate stats count BLIND verdicts only — peeked/revised days are recorded but don't
  // qualify toward auto-labeling trust.
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS scored, COALESCE(SUM(agreed),0) AS agreed
       FROM gma_verdicts WHERE agreed IS NOT NULL AND source = 'app'`
    )
    .get();
  res.json({
    scored: row.scored,
    agreed: row.agreed,
    rate: row.scored ? row.agreed / row.scored : null,
    auto_label_gate: 0.85,
    gate_met: row.scored >= 30 && row.agreed / row.scored >= 0.85,
  });
});

// ── Strategy Studio ────────────────────────────────────────────────────────────
const LIFECYCLES = ['idea', 'in_sample', 'out_of_sample', 'demo', 'promoted', 'retired'];

router.get('/strategies', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM gma_strategies ORDER BY created_at DESC').all();
  const latest = db.prepare(
    `SELECT strategy_id, split, metrics, MAX(ran_at) AS ran_at FROM gma_backtests
     GROUP BY strategy_id, split`
  ).all();
  const byStrat = {};
  for (const b of latest) (byStrat[b.strategy_id] ||= {})[b.split] = JSON.parse(b.metrics);
  res.json(rows.map((r) => ({
    ...r, params: JSON.parse(r.params), latest_metrics: byStrat[r.id] || {},
    example_count: db.prepare('SELECT COUNT(*) n FROM gma_playbook_examples WHERE strategy_id = ?').get(r.id).n,
  })));
});

router.get('/strategies/:id', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM gma_strategies WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const backtests = db.prepare(
    'SELECT * FROM gma_backtests WHERE strategy_id = ? ORDER BY ran_at DESC LIMIT 12'
  ).all(s.id).map((b) => ({ ...b, metrics: JSON.parse(b.metrics), trade_log: JSON.parse(b.trade_log || '[]') }));
  const examples = db.prepare(
    'SELECT id, caption, created_at, image FROM gma_playbook_examples WHERE strategy_id = ? ORDER BY id DESC'
  ).all(s.id);
  const children = db.prepare('SELECT id, name, lifecycle FROM gma_strategies WHERE parent_id = ?').all(s.id);
  res.json({ ...s, params: JSON.parse(s.params), backtests, examples, children });
});

// Lifecycle transitions are ALWAYS a human action (the promote/demote gates)
router.patch('/strategies/:id', (req, res) => {
  const { lifecycle, notes } = req.body;
  if (lifecycle && !LIFECYCLES.includes(lifecycle))
    return res.status(400).json({ error: `lifecycle must be one of ${LIFECYCLES.join(', ')}` });
  const db = getDb();
  const s = db.prepare('SELECT id FROM gma_strategies WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  db.prepare('UPDATE gma_strategies SET lifecycle = COALESCE(?, lifecycle), notes = COALESCE(?, notes) WHERE id = ?')
    .run(lifecycle || null, notes !== undefined ? notes : null, s.id);
  res.json({ ok: true });
});

router.post('/strategies/:id/examples', (req, res) => {
  const { image, caption } = req.body;
  if (!image || !image.startsWith('data:image/'))
    return res.status(400).json({ error: 'image (data URL) required' });
  const db = getDb();
  const s = db.prepare('SELECT id FROM gma_strategies WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'strategy not found' });
  const info = db.prepare('INSERT INTO gma_playbook_examples (strategy_id, image, caption) VALUES (?, ?, ?)')
    .run(s.id, image, caption || null);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/examples/:id', (req, res) => {
  getDb().prepare('DELETE FROM gma_playbook_examples WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Escalations ────────────────────────────────────────────────────────────────
router.get('/escalations', (req, res) => {
  const rows = getDb()
    .prepare(`SELECT * FROM gma_escalations WHERE status != 'resolved' ORDER BY created_at DESC`)
    .all();
  res.json(rows);
});

router.patch('/escalations/:id', (req, res) => {
  const { status } = req.body;
  if (!['acked', 'resolved'].includes(status))
    return res.status(400).json({ error: 'status must be acked or resolved' });
  getDb()
    .prepare(
      `UPDATE gma_escalations SET status = ?,
         resolved_at = CASE WHEN ? = 'resolved' THEN datetime('now') ELSE resolved_at END
       WHERE id = ?`
    )
    .run(status, status, req.params.id);
  res.json({ ok: true });
});

// ── Reconciliation ─────────────────────────────────────────────────────────────
router.get('/recon', (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM gma_recon ORDER BY date DESC LIMIT 60')
    .all();
  res.json(rows);
});

// ── Loop run ledger (Loop Console feed) ────────────────────────────────────────
router.get('/runs', (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM gma_loop_runs ORDER BY started_at DESC LIMIT 100')
    .all();
  res.json(rows);
});

module.exports = router;
