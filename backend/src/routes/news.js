const express = require('express');
const router  = express.Router();
const https   = require('https');
const { getDb } = require('../db/database');

// ── Table setup ──────────────────────────────────────────────────────────────
function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS news_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_date TEXT NOT NULL,
      event_time TEXT,
      title      TEXT NOT NULL,
      country    TEXT,
      impact     TEXT,
      forecast   TEXT,
      previous   TEXT,
      actual     TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      UNIQUE(event_date, event_time, title, country)
    )
  `);
}

// ── Fetch helper ─────────────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':     'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':    'https://www.forexfactory.com/',
      },
      timeout: 15000,
    }, (res) => {
      console.log(`[News] HTTP ${res.statusCode} from ${url}`);
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed: ${data.slice(0,100)}`)); }
      });
    });
    req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 15s')); });
  });
}

// ── FF calendar endpoints (current week + next week) ─────────────────────────
const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];

// In-memory gate — avoid re-fetching within 30 min
let lastFetchMs = 0;
let lastFetchErrors = [];
const CACHE_TTL_MS = 30 * 60 * 1000;

async function refreshFromFF(db) {
  const now = Date.now();
  if (now - lastFetchMs < CACHE_TTL_MS) return;
  lastFetchMs = now;
  lastFetchErrors = [];

  const insert = db.prepare(`
    INSERT OR REPLACE INTO news_events
      (event_date, event_time, title, country, impact, forecast, previous, actual, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const url of FF_URLS) {
    try {
      const events = await fetchJson(url);
      if (!Array.isArray(events)) {
        const msg = `Response was not an array: ${JSON.stringify(events).slice(0, 100)}`;
        console.warn(`[News] ${msg}`);
        lastFetchErrors.push({ url, error: msg });
        continue;
      }

      const batch = db.transaction((evts) => {
        for (const e of evts) {
          try {
            if (!e.date || !e.title) continue;
            const dt      = new Date(e.date);
            const dateStr = dt.toISOString().slice(0, 10);
            const hh      = String(dt.getUTCHours()).padStart(2, '0');
            const mm      = String(dt.getUTCMinutes()).padStart(2, '0');
            const timeStr = `${hh}:${mm}`;
            insert.run(
              dateStr, timeStr,
              e.title, e.country || null, e.impact || null,
              e.forecast || null, e.previous || null, e.actual || null,
            );
          } catch (_) {}
        }
      });
      batch(events);
      console.log(`[News] Cached ${events.length} events from ${url}`);
    } catch (err) {
      console.warn('[News] FF fetch failed:', url, err.message);
      lastFetchErrors.push({ url, error: err.message });
      // Reset cache timer so next request retries
      lastFetchMs = 0;
    }
  }
}

// ── GET /api/news/test — debug endpoint to check FF connectivity ───────────────
router.get('/test', async (req, res) => {
  const results = [];
  for (const url of FF_URLS) {
    try {
      const data = await fetchJson(url);
      results.push({ url, ok: true, count: Array.isArray(data) ? data.length : 'not array', sample: Array.isArray(data) ? data.slice(0,2) : data });
    } catch (err) {
      results.push({ url, ok: false, error: err.message });
    }
  }
  res.json({ results });
});

// ── GET /api/news ─────────────────────────────────────────────────────────────
// Query params:
//   year, month     — filter to a specific month
//   currencies      — comma-separated e.g. "USD,EUR"
//   impact          — "high" | "medium" (medium = high+medium)
router.get('/', async (req, res) => {
  const db = getDb();
  ensureTable(db);

  const count = db.prepare('SELECT COUNT(*) AS n FROM news_events').get().n;
  if (count === 0) {
    await refreshFromFF(db).catch(err => {
      console.warn('[News] Initial fetch error:', err.message);
      lastFetchErrors.push({ url: 'initial', error: err.message });
    });
  } else {
    refreshFromFF(db).catch(err => console.warn('[News] Background refresh error:', err.message));
  }

  const { year, month, currencies, impact } = req.query;

  const conditions = ["impact != 'Holiday'", "impact IS NOT NULL"];
  const params     = [];

  if (year && month) {
    const y  = parseInt(year);
    const m  = parseInt(month);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const end   = new Date(y, m, 0).toISOString().slice(0, 10);
    conditions.push('event_date >= ? AND event_date <= ?');
    params.push(start, end);
  }

  if (currencies) {
    const list = currencies.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
    if (list.length > 0) {
      conditions.push(`country IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }

  if (impact === 'high') {
    conditions.push("impact = 'High'");
  } else if (impact === 'medium') {
    conditions.push("impact IN ('High', 'Medium')");
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT event_date, event_time, title, country, impact, forecast, previous, actual
    FROM news_events ${where}
    ORDER BY event_date, event_time
  `).all(...params);

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.event_date]) grouped[row.event_date] = [];
    grouped[row.event_date].push(row);
  }

  const totalInDb = db.prepare('SELECT COUNT(*) AS n FROM news_events').get().n;

  res.json({
    events: rows,
    byDate: grouped,
    _debug: { totalInDb, fetchErrors: lastFetchErrors },
  });
});

module.exports = router;
