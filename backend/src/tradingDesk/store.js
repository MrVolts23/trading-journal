// Trading Desk — storage for the Trainer tab.
//
// Everything lives in its OWN folder and its OWN database file. journal.db is never opened here.
//   ~/Library/Application Support/trading-desk/trading-desk.db   one-minute gold bars + saved examples
//   ~/Library/Application Support/trading-desk/examples/<id>/    the saved chart pictures (PNG)
//
// Time: the broker's bars are stamped in server wall-clock time (New York + 7h, so the trading day
// starts at 17:00 New York). Each bar keeps both `ts` (server wall-clock, used to group bars into
// 3-minute / 15-minute / 1-hour candles exactly like MetaTrader does) and `t` (true UTC, used for
// everything shown on screen: Vancouver time, session boxes).
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const DIR = process.env.TRADING_DESK_DIR || path.join(os.homedir(), 'Library/Application Support/trading-desk');
const DB_PATH = path.join(DIR, 'trading-desk.db');
// Files are kept per edge:  <DIR>/edges/<edge id>/examples/<example id>/*.png   and   .../removed/<key>/
// (older layouts, examples/ and removed/ at the top, are moved under their edge on first open)
const EDGES_DIR = path.join(DIR, 'edges');
const edgeDir = (edgeId) => path.join(EDGES_DIR, String(edgeId));
const examplesDirOf = (edgeId) => path.join(edgeDir(edgeId), 'examples');
const removedDirOf = (edgeId) => path.join(edgeDir(edgeId), 'removed');
const TRASH_DIR = path.join(DIR, 'trash'); // a deleted edge's files land here, so a wrong click is recoverable in Finder
const EXAMPLES_DIR = path.join(DIR, 'examples'); // legacy
const SYMBOL = 'XAUUSD'; // the default instrument
// Instruments the desk can be taught on. Kept in the kv table so more can be added from the Edge tab.
const DEFAULT_INSTRUMENTS = [
  { symbol: 'XAUUSD', name: 'Gold', broker: 'Eightcap', digits: 2, market: 'metal' },
  { symbol: 'GBPUSD', name: 'Pound / US dollar', broker: 'Eightcap', digits: 5, market: 'forex' },
];
const digitsOf = (symbol) => { const i = listInstruments().find((x) => x.symbol === symbol); return i ? i.digits : 2; };
const TIMEFRAMES = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240];

let _db = null;
function getDb() {
  if (_db) return _db;
  fs.mkdirSync(EXAMPLES_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS bars_m1 (
      symbol TEXT NOT NULL, ts INTEGER NOT NULL, t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v INTEGER,
      PRIMARY KEY (symbol, ts)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      setup TEXT,                      -- name of the entry being taught (free text)
      side TEXT NOT NULL,              -- long | short
      decision TEXT NOT NULL,          -- take | skip
      entry_time INTEGER NOT NULL,     -- UTC seconds: the decision moment (nothing after this is in the decision pictures)
      entry REAL NOT NULL, stop REAL NOT NULL, target REAL NOT NULL,
      top_tf INTEGER NOT NULL, bottom_tf INTEGER NOT NULL,
      notes_entry TEXT, notes_stop TEXT, notes_target TEXT,
      best_exit_time INTEGER, best_exit_price REAL, notes_exit TEXT,
      drawings TEXT NOT NULL DEFAULT '[]',   -- every mark on the charts, as times + prices
      outcome TEXT,                    -- worked out from the bars, never typed
      images TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  `);
  // added 2026-10-02: chart layouts (1 to 3 charts). { layout, tfs: [chart 1, chart 2, chart 3] }
  if (!_db.prepare('PRAGMA table_info(examples)').all().some((c) => c.name === 'charts')) _db.exec('ALTER TABLE examples ADD COLUMN charts TEXT');
  // added 2026-10-02: the 1-2-3-4 marks and the entry rule (buffer, spread) an example was saved with
  if (!_db.prepare('PRAGMA table_info(examples)').all().some((c) => c.name === 'entry_rule')) _db.exec('ALTER TABLE examples ADD COLUMN entry_rule TEXT');
  // added 2026-10-02: Edges. One edge = one rulebook (when it hunts, how much it risks, how many at once...)
  // plus all the examples taught under it. The Trainer and Library work inside the selected edge.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'training',   -- training | ready | live (a label for now)
      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      window_start TEXT NOT NULL DEFAULT '06:00', -- Vancouver wall-clock, HH:MM
      window_end TEXT NOT NULL DEFAULT '11:00',
      days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',   -- 0 = Sunday ... 6 = Saturday
      risk_pct REAL NOT NULL DEFAULT 0.5,         -- % of the account risked per trade
      max_open INTEGER NOT NULL DEFAULT 1,
      max_per_day INTEGER NOT NULL DEFAULT 3,
      daily_loss_pct REAL NOT NULL DEFAULT 1.5,   -- stop for the day after losing this much
      max_losses_row INTEGER NOT NULL DEFAULT 2,  -- or after this many losses in a row
      buffer REAL NOT NULL DEFAULT 0.1,
      spread REAL NOT NULL DEFAULT 0.25,
      tfs TEXT NOT NULL DEFAULT '[15,3]',
      layout TEXT NOT NULL DEFAULT '2v',
      notes TEXT
    );
  `);
  if (!_db.prepare('PRAGMA table_info(examples)').all().some((c) => c.name === 'edge_id')) _db.exec('ALTER TABLE examples ADD COLUMN edge_id INTEGER');
  // every example belongs to an edge: anything saved before edges existed goes under the first one
  if (!_db.prepare('SELECT id FROM edges LIMIT 1').get()) _db.prepare("INSERT INTO edges (name, description) VALUES ('Edge 1', '1-2-3 break of structure')").run();
  _db.prepare('UPDATE examples SET edge_id = (SELECT MIN(id) FROM edges) WHERE edge_id IS NULL').run();
  // move any pictures from the old flat layout under their edge
  try {
    const firstEdge = _db.prepare('SELECT MIN(id) AS id FROM edges').get().id;
    if (fs.existsSync(EXAMPLES_DIR)) {
      for (const name of fs.readdirSync(EXAMPLES_DIR)) {
        if (!/^\d+$/.test(name)) continue;
        const row = _db.prepare('SELECT edge_id FROM examples WHERE id = ?').get(Number(name));
        const dest = examplesDirOf(row ? row.edge_id : firstEdge);
        fs.mkdirSync(dest, { recursive: true });
        if (!fs.existsSync(path.join(dest, name))) fs.renameSync(path.join(EXAMPLES_DIR, name), path.join(dest, name));
      }
    }
    const oldRemoved = path.join(DIR, 'removed');
    if (fs.existsSync(oldRemoved)) {
      for (const key of fs.readdirSync(oldRemoved)) {
        if (!/^\d+-\d+$/.test(key)) continue;
        let edgeId = firstEdge;
        try { edgeId = JSON.parse(fs.readFileSync(path.join(oldRemoved, key, 'example.json'), 'utf8')).edge_id || firstEdge; } catch (_) {}
        const dest = removedDirOf(edgeId);
        fs.mkdirSync(dest, { recursive: true });
        if (!fs.existsSync(path.join(dest, key))) fs.renameSync(path.join(oldRemoved, key), path.join(dest, key));
      }
    }
  } catch (e) { console.error('[trading-desk] could not move pictures under their edge:', e.message); }
  // added 2026-10-02: exit plans — a named list of triggers that run together; the first to fire ends the trade.
  // Edges point at a default plan; each example records the plan it was taught with. Kept apart from edges so
  // an exit can be swapped or combined without touching the edge.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS exit_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      name TEXT NOT NULL,
      description TEXT,
      triggers TEXT NOT NULL DEFAULT '[]'   -- JSON list, see EXIT_TRIGGER_TYPES
    );
  `);
  if (!_db.prepare('SELECT id FROM exit_plans LIMIT 1').get()) {
    _db.prepare("INSERT INTO exit_plans (name, description, triggers) VALUES ('As drawn', 'Out at the target drawn on the box, or at the stop.', ?)").run(JSON.stringify([{ type: 'target', r: null }]));
  }
  for (const [table] of [['edges'], ['examples']]) {
    if (!_db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'exit_plan_id')) _db.exec(`ALTER TABLE ${table} ADD COLUMN exit_plan_id INTEGER`);
  }
  _db.prepare('UPDATE edges SET exit_plan_id = (SELECT MIN(id) FROM exit_plans) WHERE exit_plan_id IS NULL').run();
  _db.prepare('UPDATE examples SET exit_plan_id = (SELECT MIN(id) FROM exit_plans) WHERE exit_plan_id IS NULL').run();
  // added 2026-10-04: SKILLS — the library of judgements (taught by Clef from examples) and rules (arithmetic).
  // The Trainer teaches skills; an edge is a recipe that picks skills and says what each must answer.
  _db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      name TEXT NOT NULL,
      category TEXT NOT NULL,            -- entry | exit | condition | construction | invalidation
      kind TEXT NOT NULL,                -- taught (Clef, from examples) | arithmetic (a formula)
      description TEXT,
      looks_at TEXT NOT NULL DEFAULT '[]',   -- JSON: which charts / facts it reads, e.g. ["3m chart"]
      questions TEXT NOT NULL DEFAULT '{}',  -- JSON: Clef questions (taught skills)
      params TEXT NOT NULL DEFAULT '{}',     -- JSON: numbers for arithmetic skills
      answer_shape TEXT,                  -- plain words: what it answers
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS risk_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      name TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'demo',   -- demo | live | prop
      balance REAL NOT NULL DEFAULT 10000,
      risk_pct REAL NOT NULL DEFAULT 0.5,
      max_open INTEGER NOT NULL DEFAULT 1,
      max_per_day INTEGER NOT NULL DEFAULT 3,
      daily_loss_pct REAL NOT NULL DEFAULT 1.5,
      max_losses_row INTEGER NOT NULL DEFAULT 2,
      notes TEXT
    );
  `);
  if (!_db.prepare('SELECT key FROM skills LIMIT 1').get()) seedSkills(_db);
  if (!_db.prepare('PRAGMA table_info(skills)').all().some((c) => c.name === 'status')) _db.exec('ALTER TABLE skills ADD COLUMN status TEXT'); // not_started | training | ready (null = worked out from the examples)
  if (!_db.prepare('PRAGMA table_info(examples)').all().some((c) => c.name === 'skills')) _db.exec('ALTER TABLE examples ADD COLUMN skills TEXT');
  if (!_db.prepare('PRAGMA table_info(edges)').all().some((c) => c.name === 'recipe')) _db.exec('ALTER TABLE edges ADD COLUMN recipe TEXT');
  if (!_db.prepare('SELECT id FROM risk_profiles LIMIT 1').get()) {
    const e1 = _db.prepare('SELECT * FROM edges ORDER BY id LIMIT 1').get();
    _db.prepare('INSERT INTO risk_profiles (name, account_type, balance, risk_pct, max_open, max_per_day, daily_loss_pct, max_losses_row, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('Eightcap demo', 'demo', 10000, e1?.risk_pct ?? 0.5, e1?.max_open ?? 1, e1?.max_per_day ?? 3, e1?.daily_loss_pct ?? 1.5, e1?.max_losses_row ?? 2, 'Started from the first edge\'s old risk numbers (2026-10-04).');
  }
  // examples saved before skills existed get their skill labels worked out from their marks
  for (const r of _db.prepare('SELECT id, entry_rule, drawings, skills FROM examples WHERE skills IS NULL').all()) {
    _db.prepare('UPDATE examples SET skills = ? WHERE id = ?').run(JSON.stringify(skillLabelsFor({ entry_rule: J(r.entry_rule, null), drawings: J(r.drawings, []) }, null)), r.id);
  }
  // added 2026-10-02: Mike's own grade for an example (textbook | okay | doubtful), set in the Library tab
  if (!_db.prepare('PRAGMA table_info(examples)').all().some((c) => c.name === 'quality')) _db.exec('ALTER TABLE examples ADD COLUMN quality TEXT');
  return _db;
}
const kvGet = (k, d = null) => { const r = getDb().prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : d; };
const kvSet = (k, v) => getDb().prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));

// ── time ─────────────────────────────────────────────────────────────────────────────
// New York's UTC offset (seconds, negative) for a New York wall-clock day. Cached per day.
const _nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });
const _nyOff = new Map();
function nyOffsetForWall(nyWall) {
  const day = Math.floor(nyWall / 86400);
  let off = _nyOff.get(day);
  if (off === undefined) {
    // noon of that New York day, read as UTC, is safely inside the day whichever offset applies
    const tz = _nyFmt.formatToParts(new Date((day * 86400 + 17 * 3600) * 1000)).find((p) => p.type === 'timeZoneName').value;
    const m = /GMT([+-]\d+)/.exec(tz);
    off = (m ? +m[1] : -5) * 3600;
    _nyOff.set(day, off);
  }
  return off;
}
// broker server wall-clock seconds -> true UTC seconds
function serverToUtc(ts) {
  const nyWall = ts - 7 * 3600;
  return nyWall - nyOffsetForWall(nyWall);
}
// "2026.09.18 23:59" (server time) -> server wall-clock seconds
function parseServerTime(s) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000 : null;
}

// ── one-minute bars: load once, keep in memory ───────────────────────────────────────
const _m1 = new Map(); // symbol -> bars
function loadM1(symbol = SYMBOL) {
  if (_m1.has(symbol)) return _m1.get(symbol);
  const rows = getDb().prepare('SELECT ts, t, o, h, l, c FROM bars_m1 WHERE symbol = ? ORDER BY ts').raw().all(symbol);
  const n = rows.length;
  const m = { n, ts: new Float64Array(n), t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n) };
  for (let i = 0; i < n; i++) { const r = rows[i]; m.ts[i] = r[0]; m.t[i] = r[1]; m.o[i] = r[2]; m.h[i] = r[3]; m.l[i] = r[4]; m.c[i] = r[5]; }
  _m1.set(symbol, m); for (const k of [..._agg.keys()]) if (k.startsWith(symbol + ':')) _agg.delete(k);
  return m;
}
function invalidate(symbol = null) { if (symbol) { _m1.delete(symbol); for (const k of [..._agg.keys()]) if (k.startsWith(symbol + ':')) _agg.delete(k); } else { _m1.clear(); _agg.clear(); } }

function insertBars(bars, symbol = SYMBOL) {
  const db = getDb();
  const ins = db.prepare(`INSERT INTO bars_m1 (symbol, ts, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, ts) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v`);
  db.transaction((rows) => { for (const b of rows) ins.run(symbol, b.ts, serverToUtc(b.ts), b.o, b.h, b.l, b.c, b.v ?? null); })(bars);
  invalidate(symbol);
}

function coverage(symbol = SYMBOL) {
  const r = getDb().prepare('SELECT COUNT(*) AS n, MIN(t) AS first, MAX(t) AS last FROM bars_m1 WHERE symbol = ?').get(symbol);
  return { symbol, bars: r.n, first_t: r.first, last_t: r.last };
}

// ── candles for any timeframe + the two EMAs ─────────────────────────────────────────
// 15-minute 50 EMA and 1-hour 200 EMA are each worked out on THEIR OWN timeframe and reported at the
// end of every candle of the chart's timeframe as the value a trader would have seen at that moment
// (finished higher-timeframe candles + the current price). That makes them identical on every chart
// and safe for replay: no value ever uses a price from the future.
const _agg = new Map();
function candles(tf, symbol = SYMBOL) {
  if (!TIMEFRAMES.includes(tf)) throw new Error(`timeframe ${tf} is not offered`);
  const hit = _agg.get(`${symbol}:${tf}`);
  if (hit) return hit;
  const m = loadM1(symbol);
  const step = tf * 60;
  const t = [], o = [], h = [], l = [], c = [], e50 = [], e200 = [];
  const emaState = (minutes, period) => ({ step: minutes * 60, k: 2 / (period + 1), period, bucket: null, ema: null, lastClose: null, done: 0 });
  const A = emaState(15, 50), B = emaState(60, 200);
  const live = (S, close, ts) => {
    const b = Math.floor(ts / S.step);
    if (S.bucket !== null && b !== S.bucket) { // the previous higher-timeframe candle just finished
      S.ema = S.ema === null ? S.lastClose : S.k * S.lastClose + (1 - S.k) * S.ema;
      S.done++;
    }
    S.bucket = b; S.lastClose = close;
    if (S.ema === null || S.done < S.period) return null; // not enough history yet to trust the line
    return S.k * close + (1 - S.k) * S.ema;
  };
  let cur = -1, bucket = null;
  for (let i = 0; i < m.n; i++) {
    const b = Math.floor(m.ts[i] / step);
    const a = live(A, m.c[i], m.ts[i]), b2 = live(B, m.c[i], m.ts[i]);
    if (b !== bucket) {
      bucket = b; cur++;
      t.push(m.t[i] - (m.ts[i] - b * step)); // UTC time of the candle's open
      o.push(m.o[i]); h.push(m.h[i]); l.push(m.l[i]); c.push(m.c[i]); e50.push(a); e200.push(b2);
    } else {
      if (m.h[i] > h[cur]) h[cur] = m.h[i];
      if (m.l[i] < l[cur]) l[cur] = m.l[i];
      c[cur] = m.c[i]; e50[cur] = a; e200[cur] = b2;
    }
  }
  const digits = digitsOf(symbol), pow = 10 ** digits;
  const r2 = (x) => (x == null ? null : Math.round(x * pow) / pow);
  const out = { symbol, digits, tf, n: t.length, t, o, h, l, c, e50: e50.map(r2), e200: e200.map(r2) };
  _agg.set(`${symbol}:${tf}`, out);
  return out;
}

// ── outcome: what happened after the decision moment (worked out, never typed) ────────
// Point 4 of a 1-2-3 entry: the first minute, after point 3's candle has finished, in which price touches the
// entry price. If price trades through point 1 first, the setup is invalid and there is no entry.
function findEntryMoment({ side, after_t, entry, invalid, symbol = SYMBOL }) {
  const m = loadM1(symbol);
  const long = side === 'long';
  let lo = 0, hi = m.n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m.t[mid] < after_t) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < m.n; i++) {
    const broke = invalid != null && (long ? m.l[i] <= invalid : m.h[i] >= invalid);
    const touched = long ? m.h[i] >= entry : m.l[i] <= entry;
    if (touched && !broke) return { t: m.t[i], o: m.o[i], h: m.h[i], l: m.l[i], c: m.c[i], minutes_waited: i - lo };
    if (broke) return { invalidated_at: m.t[i], touched_same_minute: touched };
    if (i - lo > 60 * 24 * 5) return { gave_up: true }; // five trading days without a touch: not this setup
  }
  return { no_data: true };
}

// ── exit plans ───────────────────────────────────────────────────────────────────────
// Trigger types (all distances in R = multiples of the entry-to-stop distance):
//   target     { r }                   out at r R; r = null means the target drawn on the box
//   trail      { arm_r, distance_r, step_r }   once the trade has reached arm_r, the stop sits distance_r behind the
//                                      best level reached and moves up in step_r steps
//   breakeven  { after_r, offset_r }   once the trade has reached after_r, the stop moves to entry + offset_r
//   partial    { pct, at_r }           close pct % of the position at at_r (once)
//   time       { at }                  flat at HH:MM Vancouver (the first minute at or after it)
//   structure  { safety_r }            out when an opposite 1-2-3 completes — marked by hand in the Trainer for now;
//                                      the app cannot spot structure by itself yet, so only the safety trail
//                                      (safety_r behind the best level, null = off) is worked out here
const EXIT_TRIGGER_TYPES = ['target', 'trail', 'breakeven', 'partial', 'time', 'structure'];
const _vanMinutes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function vanMinutesOf(utc) { const p = Object.fromEntries(_vanMinutes.formatToParts(new Date(utc * 1000)).map((x) => [x.type, x.value])); return (Number(p.hour) % 24) * 60 + Number(p.minute); }
const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

function cleanTriggers(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || !EXIT_TRIGGER_TYPES.includes(t.type)) continue;
    const n = (k, d, lo = -100, hi = 1000) => { const v = Number(t[k]); return Number.isFinite(v) && v >= lo && v <= hi ? v : d; };
    if (t.type === 'target') out.push({ type: 'target', r: t.r == null || t.r === '' ? null : n('r', 2, 0.1) });
    else if (t.type === 'trail') out.push({ type: 'trail', arm_r: n('arm_r', 1, 0), distance_r: n('distance_r', 1, 0.05), step_r: n('step_r', 1, 0.05) });
    else if (t.type === 'breakeven') out.push({ type: 'breakeven', after_r: n('after_r', 1, 0.05), offset_r: n('offset_r', 0, -1, 10) });
    else if (t.type === 'partial') out.push({ type: 'partial', pct: Math.min(99, Math.max(1, n('pct', 50, 1, 99))), at_r: n('at_r', 1, 0.05) });
    else if (t.type === 'time') { if (hhmmToMin(t.at) == null) continue; out.push({ type: 'time', at: t.at }); }
    else if (t.type === 'structure') out.push({ type: 'structure', safety_r: t.safety_r == null || t.safety_r === '' ? null : n('safety_r', 2, 0.1) });
  }
  return out;
}
const rowToPlan = (r) => (r ? { ...r, triggers: J(r.triggers, []) } : null);
function listExitPlans() { return getDb().prepare('SELECT * FROM exit_plans ORDER BY id').all().map(rowToPlan); }
function getExitPlan(id) { return rowToPlan(getDb().prepare('SELECT * FROM exit_plans WHERE id = ?').get(id)); }
function createExitPlan(body) {
  const name = String(body.name || '').trim() || 'New exit';
  const id = getDb().prepare('INSERT INTO exit_plans (name, description, triggers) VALUES (?, ?, ?)').run(name, body.description == null ? null : String(body.description), JSON.stringify(cleanTriggers(body.triggers))).lastInsertRowid;
  return getExitPlan(id);
}
function updateExitPlan(id, body) {
  const db = getDb();
  if (!getExitPlan(id)) { const e = new Error('That exit plan no longer exists.'); e.status = 404; throw e; }
  const f = {};
  if ('name' in body) { f.name = String(body.name || '').trim(); if (!f.name) { const e = new Error('Give the exit plan a name.'); e.status = 400; throw e; } }
  if ('description' in body) f.description = body.description == null ? null : String(body.description);
  if ('triggers' in body) f.triggers = JSON.stringify(cleanTriggers(body.triggers));
  if (Object.keys(f).length) db.prepare(`UPDATE exit_plans SET ${Object.keys(f).map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...f, id });
  // examples taught with this plan get their result worked out again
  db.prepare("UPDATE examples SET outcome = NULL WHERE exit_plan_id = ?").run(id);
  return getExitPlan(id);
}
function deleteExitPlan(id) {
  const db = getDb();
  if (!getExitPlan(id)) { const e = new Error('That exit plan no longer exists.'); e.status = 404; throw e; }
  if (listExitPlans().length <= 1) { const e = new Error('This is the only exit plan. Make another one before deleting this one.'); e.status = 400; throw e; }
  const fallback = db.prepare('SELECT MIN(id) AS id FROM exit_plans WHERE id != ?').get(id).id;
  const used = { edges: db.prepare('SELECT COUNT(*) AS n FROM edges WHERE exit_plan_id = ?').get(id).n, examples: db.prepare('SELECT COUNT(*) AS n FROM examples WHERE exit_plan_id = ?').get(id).n };
  db.prepare('UPDATE edges SET exit_plan_id = ? WHERE exit_plan_id = ?').run(fallback, id);
  db.prepare('UPDATE examples SET exit_plan_id = ?, outcome = NULL WHERE exit_plan_id = ?').run(fallback, id);
  db.prepare('DELETE FROM exit_plans WHERE id = ?').run(id);
  return { deleted: id, moved_to: fallback, ...used };
}

// ── outcome: what happened after the entry, under the example's exit plan (worked out, never typed) ──
function computeOutcome(ex) {
  const m = loadM1(ex.symbol || SYMBOL);
  const long = ex.side === 'long';
  const risk = Math.abs(ex.entry - ex.stop);
  if (!(risk > 0)) return { result: 'invalid', note: 'entry and stop are the same price' };
  const plan = (ex.exit_plan_id != null && getExitPlan(ex.exit_plan_id)) || { id: null, name: 'As drawn', triggers: [{ type: 'target', r: null }] };
  const trig = plan.triggers.length ? plan.triggers : [{ type: 'target', r: null }];
  // first one-minute bar at or after the entry moment
  let lo = 0, hi = m.n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m.t[mid] < ex.entry_time) lo = mid + 1; else hi = mid; }
  if (lo >= m.n) return { result: 'open', note: 'no price data after the entry yet', exit_plan: plan.name };
  const R = (price) => (long ? price - ex.entry : ex.entry - price) / risk;
  const priceAtR = (r) => (long ? ex.entry + r * risk : ex.entry - r * risk);
  const drawnTargetR = R(ex.target);
  const targets = trig.filter((t) => t.type === 'target').map((t) => (t.r == null ? drawnTargetR : t.r));
  const targetR = targets.length ? Math.min(...targets) : null;
  const trails = trig.filter((t) => t.type === 'trail' || (t.type === 'structure' && t.safety_r != null))
    .map((t) => (t.type === 'trail' ? t : { arm_r: t.safety_r, distance_r: t.safety_r, step_r: 0.01 }));
  const be = trig.find((t) => t.type === 'breakeven') || null;
  const partials = trig.filter((t) => t.type === 'partial').sort((a, b) => a.at_r - b.at_r);
  const timeAt = trig.filter((t) => t.type === 'time').map((t) => hhmmToMin(t.at)).filter((x) => x != null);
  const hasStructure = trig.some((t) => t.type === 'structure');
  // the hand-marked opposite 1-2-3 (E4 = the minute E2 broke), saved with the example
  const rule = typeof ex.entry_rule === 'string' ? J(ex.entry_rule, null) : ex.entry_rule;
  const marked = hasStructure && rule && rule.exit && Number.isFinite(rule.exit.t) && Number.isFinite(rule.exit.p) ? rule.exit : null;

  let stopR = -1, open = 1, realized = 0, mfe = 0, mae = 0, result = 'open', exitT = null, bars = 0, bestStopR = -1;
  const events = [];
  const closeAt = (frac, r, why, t) => { realized += frac * r; open -= frac; events.push({ what: why, r: +r.toFixed(2), part: +frac.toFixed(2), t }); };
  const entryMin = vanMinutesOf(ex.entry_time);
  for (let i = lo; i < m.n && open > 1e-9; i++) {
    bars++;
    const t = m.t[i];
    // flat at a time of day (the first minute at or after it, after the entry minute)
    if (timeAt.length && i > lo) {
      const nowMin = vanMinutesOf(t);
      const due = timeAt.some((at) => (entryMin < at ? nowMin >= at : nowMin >= at && nowMin < entryMin));
      if (due) { closeAt(open, R(m.o[i]), 'time', t); result = 'time'; exitT = t; break; }
    }
    const fav = long ? m.h[i] : m.l[i], adv = long ? m.l[i] : m.h[i];
    const favR = R(fav), advR = R(adv);
    // the marked structure exit fires in its minute (unless the stop is hit in that same minute)
    if (marked && t >= marked.t && !(advR <= stopR)) { closeAt(open, R(marked.p), 'break of structure', t); result = 'structure'; exitT = t + 60; mfe = Math.max(mfe, favR); break; }
    // the stop first (the cautious reading when several things touch inside one minute)
    if (advR <= stopR) {
      closeAt(open, stopR, stopR > -1 + 1e-9 ? (stopR >= -1e-9 ? 'trailed stop' : 'moved stop') : 'stop', t);
      result = stopR > -1 + 1e-9 ? (stopR >= -1e-9 ? 'trail' : 'stop') : 'stop'; exitT = t + 60; mae = Math.min(mae, stopR); break;
    }
    mae = Math.min(mae, advR);
    // partial closes, lowest first
    for (const p of partials) {
      if (!p.done && favR >= p.at_r) { p.done = true; const frac = Math.min(open, p.pct / 100); closeAt(frac, p.at_r, `partial ${p.pct}%`, t); }
    }
    if (open <= 1e-9) { result = 'partial'; exitT = t + 60; break; }
    // the full target
    if (targetR != null && favR >= targetR) { closeAt(open, targetR, 'target', t); result = 'target'; exitT = t + 60; mfe = Math.max(mfe, favR); break; }
    mfe = Math.max(mfe, favR);
    // stop moves (never backwards): breakeven, then trails
    if (be && mfe >= be.after_r) stopR = Math.max(stopR, be.offset_r);
    for (const tr of trails) {
      if (mfe >= tr.arm_r) {
        const stepped = tr.step_r > 0 ? Math.floor(mfe / tr.step_r) * tr.step_r : mfe;
        stopR = Math.max(stopR, stepped - tr.distance_r);
      }
    }
    bestStopR = Math.max(bestStopR, stopR);
    if (bars > 60 * 24 * 10) break; // ten trading days is long enough to call it unresolved
  }
  for (const p of partials) delete p.done;
  const total = result === 'open' ? null : +realized.toFixed(2);
  const out = {
    result,                                              // target | stop | trail | partial | time | structure | open
    r: total,                                            // the whole trade's result in R (partials included)
    exit_plan: plan.name, exit_plan_id: plan.id,
    planned_rr: +drawnTargetR.toFixed(2),
    best_r_before_exit: +mfe.toFixed(2),                 // how far it ran in your favour before it ended
    worst_r_before_exit: +mae.toFixed(2),
    stop_ended_at_r: result === 'open' ? +stopR.toFixed(2) : undefined,
    events,
    exit_time: exitT,
    minutes: exitT ? Math.round((exitT - ex.entry_time) / 60) : null,
    data_through: m.t[m.n - 1],
  };
  if (hasStructure && !marked) out.note = 'This plan exits on an opposite 1-2-3, but none is marked on this example (mark E1-E3 in the Trainer and find the exit); only the safety trail (if any) is worked out here.';
  if (ex.best_exit_price != null) out.best_exit_r = +R(ex.best_exit_price).toFixed(2);
  return out;
}

// ── saved examples ───────────────────────────────────────────────────────────────────
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (_) { return d; } };
function rowToExample(r, { withDrawings = true } = {}) {
  if (!r) return null;
  const ex = { ...r, drawings: withDrawings ? J(r.drawings, []) : undefined, outcome: J(r.outcome, null), images: J(r.images, {}), charts: J(r.charts, null) || { layout: '2v', tfs: [r.top_tf, r.bottom_tf] }, entry_rule: J(r.entry_rule, null), skills: J(r.skills, {}) || {} };
  return ex;
}
function refreshOutcome(ex) {
  // an unresolved example is re-checked whenever newer prices exist; a changed exit plan clears the outcome (NULL)
  if (ex.outcome && ex.outcome.result !== 'open') return ex;
  const cov = coverage(ex.symbol || SYMBOL);
  if (ex.outcome && ex.outcome.data_through === cov.last_t) return ex;
  const outcome = computeOutcome(ex);
  getDb().prepare('UPDATE examples SET outcome = ? WHERE id = ?').run(JSON.stringify(outcome), ex.id);
  return { ...ex, outcome };
}
function listExamples(edgeId = null, skillKey = null) {
  const db = getDb();
  let rows = edgeId != null ? db.prepare('SELECT * FROM examples WHERE edge_id = ? ORDER BY entry_time DESC').all(edgeId) : db.prepare('SELECT * FROM examples ORDER BY entry_time DESC').all();
  if (skillKey) rows = rows.filter((r) => Object.prototype.hasOwnProperty.call(J(r.skills, {}) || {}, skillKey));
  return rows
    .map((r) => refreshOutcome(rowToExample(r, { withDrawings: false })));
}
function getExample(id) {
  const ex = rowToExample(getDb().prepare('SELECT * FROM examples WHERE id = ?').get(id));
  return ex ? refreshOutcome(ex) : null;
}

// chart 1 = top_*, chart 2 = bottom_*, chart 3 = third_* (the names date from the first two-chart layout)
// moments: step1..step3 (each point's candle just finished), decision (= point 4 / the entry), full (what happened after)
const IMAGE_OK = /^(top|bottom|third)_(step1|step2|step3|decision|exit|full)$/;
const IMAGE_NAMES = { includes: (n) => IMAGE_OK.test(String(n)) };
const imageNamesIn = (images) => Object.keys(images || {}).filter((n) => IMAGE_OK.test(n));
function saveImages(id, images) {
  const edgeId = getDb().prepare('SELECT edge_id FROM examples WHERE id = ?').get(id)?.edge_id;
  const dir = path.join(examplesDirOf(edgeId), String(id));
  fs.mkdirSync(dir, { recursive: true });
  const saved = {};
  for (const name of imageNamesIn(images)) {
    const data = images[name];
    const m = typeof data === 'string' && /^data:image\/png;base64,(.+)$/s.exec(data);
    if (!m) continue;
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(m[1], 'base64'));
    saved[name] = `${name}.png`;
  }
  return saved;
}
function imagePath(id, name) {
  if (!IMAGE_NAMES.includes(name) || !/^\d+$/.test(String(id))) return null;
  const row = getDb().prepare('SELECT edge_id FROM examples WHERE id = ?').get(Number(id));
  if (!row) return null;
  const p = path.join(examplesDirOf(row.edge_id), String(id), `${name}.png`);
  return fs.existsSync(p) ? p : null;
}

function validate(body) {
  const errs = [];
  const num = (k) => typeof body[k] === 'number' && Number.isFinite(body[k]);
  if (!['long', 'short'].includes(body.side)) errs.push('Draw a long or a short first.');
  if (!['take', 'skip'].includes(body.decision)) errs.push('Choose take or skip.');
  for (const k of ['entry_time', 'entry', 'stop', 'target']) if (!num(k)) errs.push(`${k} is missing`);
  if (!errs.length) {
    const long = body.side === 'long';
    if (long ? !(body.stop < body.entry && body.target > body.entry) : !(body.stop > body.entry && body.target < body.entry))
      errs.push(long ? 'For a long, the stop must be below the entry and the target above it.' : 'For a short, the stop must be above the entry and the target below it.');
  }
  if (!TIMEFRAMES.includes(body.top_tf) || !TIMEFRAMES.includes(body.bottom_tf)) errs.push('chart timeframes are missing');
  return errs;
}

function saveExample(body, id = null) {
  const errs = validate(body);
  if (errs.length) { const e = new Error(errs[0]); e.status = 400; throw e; }
  const db = getDb();
  const f = {
    setup: (body.setup || '').trim() || null, side: body.side, decision: body.decision,
    entry_time: Math.round(body.entry_time), entry: body.entry, stop: body.stop, target: body.target,
    top_tf: body.top_tf, bottom_tf: body.bottom_tf,
    charts: JSON.stringify({ layout: typeof body.layout === 'string' ? body.layout : null, tfs: (Array.isArray(body.tfs) ? body.tfs : [body.top_tf, body.bottom_tf]).filter((t) => TIMEFRAMES.includes(t)).slice(0, 3) }),
    notes_entry: body.notes_entry || null, notes_stop: body.notes_stop || null, notes_target: body.notes_target || null,
    best_exit_time: body.best_exit_time != null ? Math.round(body.best_exit_time) : null,
    best_exit_price: body.best_exit_price != null ? body.best_exit_price : null,
    notes_exit: body.notes_exit || null,
    drawings: JSON.stringify(Array.isArray(body.drawings) ? body.drawings : []),
    entry_rule: body.entry_rule ? JSON.stringify(body.entry_rule) : null,
    symbol: listInstruments().some((i) => i.symbol === body.symbol) ? body.symbol : SYMBOL,
    edge_id: Number.isInteger(body.edge_id) && getEdge(body.edge_id) ? body.edge_id : (db.prepare('SELECT MIN(id) AS id FROM edges').get().id),
  };
  f.exit_plan_id = Number.isInteger(body.exit_plan_id) && getExitPlan(body.exit_plan_id) ? body.exit_plan_id : (getEdge(f.edge_id)?.exit_plan_id ?? db.prepare('SELECT MIN(id) AS id FROM exit_plans').get().id);
  const trend = body.trend && TRENDS.includes(body.trend.value) ? { value: body.trend.value, source: body.trend.source === 'ema' ? 'ema' : 'mike', tf: Number(body.trend.tf) || 15 } : null;
  // which skills this example teaches: worked out from the marks, then Mike's ticks decide (a tick without marks
  // still counts — it is his call; an untick drops the label even if marks exist)
  let labels = skillLabelsFor({ entry_rule: f.entry_rule, drawings: f.drawings }, trend);
  if (Array.isArray(body.teaches)) {
    const want = new Set(body.teaches.map(String).filter((k) => getSkill(k)));
    for (const k of Object.keys(labels)) if (!want.has(k)) delete labels[k];
    for (const k of want) if (!labels[k]) labels[k] = { manual: true };
  }
  f.skills = JSON.stringify(labels);
  f.outcome = JSON.stringify(computeOutcome(f));
  // saving "changes" to an example that has since been removed saves a fresh one instead, so nothing is lost
  if (id != null && !db.prepare('SELECT id FROM examples WHERE id = ?').get(id)) id = null;
  if (id == null) {
    const cols = Object.keys(f);
    id = db.prepare(`INSERT INTO examples (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(f).lastInsertRowid;
  } else {
    db.prepare(`UPDATE examples SET ${Object.keys(f).map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...f, id });
  }
  if (body.images) {
    const prev = J(db.prepare('SELECT images FROM examples WHERE id = ?').get(id).images, {});
    db.prepare('UPDATE examples SET images = ? WHERE id = ?').run(JSON.stringify({ ...prev, ...saveImages(id, body.images) }), id);
  }
  return getExample(id);
}

// ── skills ───────────────────────────────────────────────────────────────────────────
const SKILL_CATEGORIES = ['entry', 'exit', 'condition', 'construction', 'invalidation'];
const SKILL_SEED = [
  // entries
  { key: 'bos_3m', category: 'entry', kind: 'taught', name: '3-minute break of structure', looks_at: ['3-minute chart'], answer_shape: 'possible 3 forming (0-1), direction (buy / sell / none), quality (0-2)',
    description: 'Points 1 and 2 are there and a possible 3 is forming; the 4 (price through point 2) confirms it and is the entry.',
    questions: { setup_forming: { type: 'noul', instructions: 'Are points 1 and 2 of a 1-2-3 in place, with a possible point 3 forming (a pullback that has not gone past point 1)?' },
                 direction: { type: 'choice', instructions: 'Which way would this 1-2-3 trade?', criteria: { buy: 'Point 1 is a bottom, point 2 a top, point 3 a higher bottom', sell: 'Point 1 is a top, point 2 a bottom, point 3 a lower top', none: 'No clear 1-2-3' } },
                 quality: { type: 'score', criteria: ['Messy or doubtful', 'Acceptable', 'Clean textbook setup'] } } },
  { key: 'bos_15m', category: 'entry', kind: 'taught', name: '15-minute break of structure', looks_at: ['15-minute chart'], answer_shape: 'broken (0-1), direction (buy / sell / none)',
    description: 'A 1-2-3 on the 15-minute whose point 2 has broken; the context a 3-minute entry sits inside of after 6 PM.',
    questions: { broken: { type: 'noul', instructions: 'On the 15-minute chart, has a 1-2-3 completed with point 2 broken (a break of structure)?' },
                 direction: { type: 'choice', instructions: 'Which way did the 15-minute structure break?', criteria: { buy: 'Up, through a top', sell: 'Down, through a bottom', none: 'No break' } } } },
  { key: 'trigger_point4', category: 'entry', kind: 'arithmetic', name: 'Point-4 trigger', looks_at: ['price ticks', 'point 2'], answer_shape: 'fire / wait',
    description: 'Enter the moment price trades through point 2 plus the buffer and the spread (minus, for a sell).', params: { buffer: 0.1, spread: 0.25 } },
  // exits
  { key: 'exit_structure', category: 'exit', kind: 'taught', name: 'Break of structure the other way', looks_at: ['3-minute chart'], answer_shape: 'opposite 1-2-3 completed (0-1)',
    description: 'An opposite-direction 1-2-3 completes against the trade (E1, E2, E3; E4 = price through E2). Marked in the Trainer with the Exit 1-2-3 tool.',
    questions: { opposite_break: { type: 'noul', instructions: 'Has a 1-2-3 formed against the open trade and has its point 2 been broken?' } } },
  { key: 'exit_target', category: 'exit', kind: 'arithmetic', name: 'Fixed target', looks_at: ['price'], answer_shape: 'out at N R', description: 'Out when price reaches a set number of R, or the target drawn on the box.', params: { r: null } },
  { key: 'exit_trail', category: 'exit', kind: 'arithmetic', name: 'R-step trail', looks_at: ['price'], answer_shape: 'stop level', description: 'Once the trade has reached a set profit, the stop follows behind the best level in steps.', params: { arm_r: 1, distance_r: 1, step_r: 1 } },
  { key: 'exit_breakeven', category: 'exit', kind: 'arithmetic', name: 'Move stop to breakeven', looks_at: ['price'], answer_shape: 'stop level', description: 'Once the trade has reached a set profit, the stop moves to the entry.', params: { after_r: 1, offset_r: 0 } },
  { key: 'exit_partial', category: 'exit', kind: 'arithmetic', name: 'Partial close', looks_at: ['price'], answer_shape: 'close N%', description: 'Close part of the position at a set profit; the rest keeps running.', params: { pct: 50, at_r: 2 } },
  { key: 'exit_time', category: 'exit', kind: 'arithmetic', name: 'Flat by a time of day', looks_at: ['clock'], answer_shape: 'close all', description: 'Close whatever is left at a Vancouver time.', params: { at: '14:00' } },
  // conditions
  { key: 'trend', category: 'condition', kind: 'taught', name: 'Trend direction', looks_at: ['3-minute', '15-minute', '1-hour', '4-hour charts'], answer_shape: 'up / down / none per timeframe',
    description: 'Which way the market is going. Arithmetic first guess from the 15-minute 50 EMA (side and slope); your eye corrects it. We never trade against it (no reversal calls).',
    questions: { trend_15m: { type: 'choice', instructions: 'On the 15-minute chart, which way is the trend?', criteria: { up: 'Higher tops and bottoms, price above a rising blue EMA', down: 'Lower tops and bottoms, price below a falling blue EMA', none: 'Sideways or unclear' } } },
    params: { ema_slope_bars: 8 } },
  { key: 'time_window', category: 'condition', kind: 'arithmetic', name: 'Time of day', looks_at: ['clock'], answer_shape: 'inside / outside', description: 'The edge\'s entry window, Vancouver time, on market days.', params: {} },
  { key: 'market_state', category: 'condition', kind: 'taught', name: 'Market state', looks_at: ['3-minute chart'], answer_shape: 'trending / settling / chop',
    description: 'Are the candles trending, settling down (after 6 PM), or chopping sideways?',
    questions: { state: { type: 'choice', instructions: 'How are the recent candles behaving?', criteria: { trending: 'Clear directional moves', settling: 'Big candles giving way to smaller ones', chop: 'Sideways, overlapping candles' } } } },
  { key: 'news_nearby', category: 'condition', kind: 'arithmetic', name: 'News nearby', looks_at: ['news calendar'], answer_shape: 'clear / news within N minutes', description: 'No high-impact news within N minutes of the entry.', params: { minutes: 10 } },
  { key: 'spread_ok', category: 'condition', kind: 'arithmetic', name: 'Spread acceptable', looks_at: ['live spread'], answer_shape: 'ok / too wide', description: 'The live spread is no wider than this.', params: { max_spread: 0.5 } },
  // construction (examples only for now — how they work is still to be decided)
  { key: 'stop_past_3', category: 'construction', kind: 'arithmetic', name: 'Stop just past point 3', looks_at: ['point 3'], answer_shape: 'stop price', description: 'The stop goes a set distance past point 3 (example; how construction skills run is still to be worked out).', params: { past: 0.1 } },
  { key: 'target_r', category: 'construction', kind: 'arithmetic', name: 'Target at N R', looks_at: ['entry', 'stop'], answer_shape: 'target price', description: 'The target is a multiple of the entry-to-stop distance (example).', params: { r: 2 } },
  // invalidation (examples only for now)
  { key: 'invalid_3_past_1', category: 'invalidation', kind: 'arithmetic', name: '3 goes past 1', looks_at: ['points 1, 3'], answer_shape: 'cancel', description: 'If point 3 trades past point 1 the setup is invalid and the trigger is cancelled (example).', params: {} },
  { key: 'invalid_stale', category: 'invalidation', kind: 'arithmetic', name: 'Setup too old', looks_at: ['clock'], answer_shape: 'cancel', description: 'An armed setup that has not fired within N candles is forgotten (example).', params: { candles: 20 } },
];
function seedSkills(db) {
  const ins = db.prepare('INSERT INTO skills (key, name, category, kind, description, looks_at, questions, params, answer_shape, sort) VALUES (@key, @name, @category, @kind, @description, @looks_at, @questions, @params, @answer_shape, @sort)');
  SKILL_SEED.forEach((s, i) => ins.run({ ...s, description: s.description || null, looks_at: JSON.stringify(s.looks_at || []), questions: JSON.stringify(s.questions || {}), params: JSON.stringify(s.params || {}), answer_shape: s.answer_shape || null, sort: i }));
}
const rowToSkill = (r) => (r ? { ...r, looks_at: J(r.looks_at, []), questions: J(r.questions, {}), params: J(r.params, {}) } : null);
function listSkills() {
  const db = getDb();
  const counts = {};
  for (const r of db.prepare('SELECT skills FROM examples').all()) for (const k of Object.keys(J(r.skills, {}) || {})) counts[k] = (counts[k] || 0) + 1;
  // status: red = not started, yellow = in training, green = confirmed finished. Set by Mike; until then taught skills
  // read 'training' once they have examples and 'not_started' before, arithmetic ones 'not_started'.
  return db.prepare('SELECT * FROM skills ORDER BY sort, key').all().map(rowToSkill).map((s) => ({ ...s, examples: counts[s.key] || 0, status: s.status || (s.kind === 'taught' && (counts[s.key] || 0) > 0 ? 'training' : 'not_started'), status_set: !!s.status }));
}
function getSkill(key) { return rowToSkill(getDb().prepare('SELECT * FROM skills WHERE key = ?').get(key)); }
function updateSkill(key, body) {
  const db = getDb();
  if (!getSkill(key)) { const e = new Error('That skill does not exist.'); e.status = 404; throw e; }
  const f = {};
  if ('name' in body) { f.name = String(body.name || '').trim(); if (!f.name) { const e = new Error('Give the skill a name.'); e.status = 400; throw e; } }
  if ('description' in body) f.description = body.description == null ? null : String(body.description);
  if ('answer_shape' in body) f.answer_shape = body.answer_shape == null ? null : String(body.answer_shape);
  if ('status' in body) f.status = ['not_started', 'training', 'ready'].includes(body.status) ? body.status : null;
  if ('looks_at' in body) f.looks_at = JSON.stringify(Array.isArray(body.looks_at) ? body.looks_at.map(String) : []);
  if ('questions' in body) f.questions = JSON.stringify(body.questions && typeof body.questions === 'object' ? body.questions : {});
  if ('params' in body) f.params = JSON.stringify(body.params && typeof body.params === 'object' ? body.params : {});
  if (Object.keys(f).length) db.prepare(`UPDATE skills SET ${Object.keys(f).map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE key = @key`).run({ ...f, key });
  return getSkill(key);
}
function createSkill(body) {
  const db = getDb();
  const key = String(body.key || body.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) { const e = new Error('Give the skill a name.'); e.status = 400; throw e; }
  if (getSkill(key)) { const e = new Error('A skill with that name already exists.'); e.status = 400; throw e; }
  if (!SKILL_CATEGORIES.includes(body.category)) { const e = new Error('Pick a category.'); e.status = 400; throw e; }
  const kind = body.kind === 'arithmetic' ? 'arithmetic' : 'taught';
  const sort = (db.prepare('SELECT MAX(sort) AS m FROM skills').get().m || 0) + 1;
  db.prepare('INSERT INTO skills (key, name, category, kind, description, looks_at, questions, params, answer_shape, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(key, String(body.name || key), body.category, kind, body.description == null ? null : String(body.description), JSON.stringify(Array.isArray(body.looks_at) ? body.looks_at : []), JSON.stringify(body.questions || {}), JSON.stringify(body.params || {}), body.answer_shape == null ? null : String(body.answer_shape), sort);
  return getSkill(key);
}
function deleteSkill(key) {
  const db = getDb();
  if (SKILL_SEED.some((s) => s.key === key)) { const e = new Error('That is a built-in skill; edit it instead of deleting it.'); e.status = 400; throw e; }
  const r = db.prepare('DELETE FROM skills WHERE key = ?').run(key);
  return { deleted: r.changes };
}
// Which skills an example teaches, read off its marks (plus Mike's trend call).
function skillLabelsFor(ex, trend) {
  const rule = typeof ex.entry_rule === 'string' ? J(ex.entry_rule, null) : ex.entry_rule;
  const drawings = typeof ex.drawings === 'string' ? J(ex.drawings, []) : (ex.drawings || []);
  const out = {};
  const pts = rule && rule.points ? rule.points : null;
  const tfOfPoints = pts ? (pts['1'] && pts['1'].tf) : null;
  const stepTfs = new Set(drawings.filter((d) => d.type === 'step' && d.tf).map((d) => d.tf));
  if (tfOfPoints) stepTfs.add(tfOfPoints);
  for (const tf of stepTfs) { if (tf <= 5) out.bos_3m = { tf, points: pts && tfOfPoints === tf ? pts : undefined, complete: !!(pts && pts['4']) }; else out.bos_15m = { tf, points: pts && tfOfPoints === tf ? pts : undefined, complete: !!(pts && pts['4']) }; }
  if (rule && rule.exit && rule.exit.points) out.exit_structure = { tf: rule.exit.points['1'] && rule.exit.points['1'].tf, points: rule.exit.points, complete: !!rule.exit.points['4'] };
  if (trend && trend.value) out.trend = { value: trend.value, source: trend.source || 'mike', tf: trend.tf || 15 };
  return out;
}
const TRENDS = ['up', 'down', 'none'];

// ── risk profiles ────────────────────────────────────────────────────────────────────
function listRiskProfiles() { return getDb().prepare('SELECT * FROM risk_profiles ORDER BY id').all(); }
function getRiskProfile(id) { return getDb().prepare('SELECT * FROM risk_profiles WHERE id = ?').get(id) || null; }
function riskFields(body) {
  const f = {};
  const num = (k, lo, hi) => { const v = Number(body[k]); if (!Number.isFinite(v) || v < lo || v > hi) { const e = new Error(`${k.replace(/_/g, ' ')} needs a number between ${lo} and ${hi}.`); e.status = 400; throw e; } return v; };
  if ('name' in body) { f.name = String(body.name || '').trim(); if (!f.name) { const e = new Error('Give the profile a name.'); e.status = 400; throw e; } }
  if ('account_type' in body) f.account_type = ['demo', 'live', 'prop'].includes(body.account_type) ? body.account_type : 'demo';
  if ('balance' in body) f.balance = num('balance', 0, 1e9);
  if ('risk_pct' in body) f.risk_pct = num('risk_pct', 0, 100);
  if ('daily_loss_pct' in body) f.daily_loss_pct = num('daily_loss_pct', 0, 100);
  if ('max_open' in body) f.max_open = Math.round(num('max_open', 1, 50));
  if ('max_per_day' in body) f.max_per_day = Math.round(num('max_per_day', 1, 200));
  if ('max_losses_row' in body) f.max_losses_row = Math.round(num('max_losses_row', 1, 50));
  if ('notes' in body) f.notes = body.notes == null ? null : String(body.notes);
  return f;
}
function createRiskProfile(body) {
  const f = { name: 'New profile', ...riskFields(body) };
  const cols = Object.keys(f);
  const id = getDb().prepare(`INSERT INTO risk_profiles (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(f).lastInsertRowid;
  return getRiskProfile(id);
}
function updateRiskProfile(id, body) {
  const db = getDb();
  if (!getRiskProfile(id)) { const e = new Error('That profile no longer exists.'); e.status = 404; throw e; }
  const f = riskFields(body);
  if (Object.keys(f).length) db.prepare(`UPDATE risk_profiles SET ${Object.keys(f).map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...f, id });
  return getRiskProfile(id);
}
function deleteRiskProfile(id) {
  const db = getDb();
  if (listRiskProfiles().length <= 1) { const e = new Error('This is the only risk profile. Make another one before deleting this one.'); e.status = 400; throw e; }
  return { deleted: db.prepare('DELETE FROM risk_profiles WHERE id = ?').run(id).changes };
}

// ── instruments ──────────────────────────────────────────────────────────────────────
function listInstruments() {
  const list = kvGet('instruments');
  if (Array.isArray(list) && list.length) return list;
  kvSet('instruments', DEFAULT_INSTRUMENTS);
  return DEFAULT_INSTRUMENTS;
}
function addInstrument(body) {
  const symbol = String(body.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9._#-]{3,20}$/.test(symbol)) { const e = new Error('The symbol should look like GBPUSD, exactly as the broker names it.'); e.status = 400; throw e; }
  const digits = Math.round(Number(body.digits));
  if (!(digits >= 0 && digits <= 8)) { const e = new Error('Decimals is how many decimal places the price has (gold 2, most forex 5).'); e.status = 400; throw e; }
  const market = ['forex', 'metal', 'index', 'crypto', 'other'].includes(body.market) ? body.market : 'other';
  const list = listInstruments().filter((i) => i.symbol !== symbol);
  list.push({ symbol, name: String(body.name || symbol).trim() || symbol, broker: String(body.broker || 'Eightcap').trim() || 'Eightcap', digits, market });
  kvSet('instruments', list);
  return list;
}

// ── edges ────────────────────────────────────────────────────────────────────────────
const EDGE_FIELDS = ['name', 'description', 'status', 'symbol', 'window_start', 'window_end', 'days', 'risk_pct', 'max_open', 'max_per_day', 'daily_loss_pct', 'max_losses_row', 'buffer', 'spread', 'tfs', 'layout', 'notes'];
const rowToEdge = (r) => (r ? { ...r, days: J(r.days, [1, 2, 3, 4, 5]), tfs: J(r.tfs, [15, 3]), recipe: J(r.recipe, null) || { skills: [], prerequisites: [] } } : null);
function listEdges() { return getDb().prepare('SELECT * FROM edges ORDER BY id').all().map(rowToEdge); }
function getEdge(id) { return rowToEdge(getDb().prepare('SELECT * FROM edges WHERE id = ?').get(id)); }
function edgeFields(body) {
  const f = {};
  const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
  const num = (k, lo, hi) => { const v = Number(body[k]); if (!Number.isFinite(v) || v < lo || v > hi) { const e = new Error(`${k.replace(/_/g, ' ')} needs a number between ${lo} and ${hi}.`); e.status = 400; throw e; } return v; };
  if ('name' in body) { f.name = String(body.name || '').trim(); if (!f.name) { const e = new Error('Give the edge a name.'); e.status = 400; throw e; } }
  for (const k of ['description', 'notes']) if (k in body) f[k] = body[k] == null ? null : String(body[k]);
  if ('symbol' in body) { if (!listInstruments().some((i) => i.symbol === body.symbol)) { const e = new Error('Pick an instrument from the list (or add it first).'); e.status = 400; throw e; } f.symbol = body.symbol; }
  if ('status' in body) { if (!['training', 'ready', 'live'].includes(body.status)) { const e = new Error('Status is training, ready or live.'); e.status = 400; throw e; } f.status = body.status; }
  for (const k of ['window_start', 'window_end']) if (k in body) { if (!hhmm(body[k])) { const e = new Error('Times look like 06:30.'); e.status = 400; throw e; } f[k] = body[k]; }
  if ('days' in body) f.days = JSON.stringify((Array.isArray(body.days) ? body.days : []).map(Number).filter((d) => d >= 0 && d <= 6));
  if ('risk_pct' in body) f.risk_pct = num('risk_pct', 0, 100);
  if ('daily_loss_pct' in body) f.daily_loss_pct = num('daily_loss_pct', 0, 100);
  if ('max_open' in body) f.max_open = Math.round(num('max_open', 1, 50));
  if ('max_per_day' in body) f.max_per_day = Math.round(num('max_per_day', 1, 200));
  if ('max_losses_row' in body) f.max_losses_row = Math.round(num('max_losses_row', 1, 50));
  if ('buffer' in body) f.buffer = num('buffer', 0, 100);
  if ('spread' in body) f.spread = num('spread', 0, 100);
  if ('tfs' in body) f.tfs = JSON.stringify((Array.isArray(body.tfs) ? body.tfs : []).map(Number).filter((t) => TIMEFRAMES.includes(t)).slice(0, 3));
  if ('layout' in body) f.layout = String(body.layout || '2v');
  if ('exit_plan_id' in body) { if (!getExitPlan(Number(body.exit_plan_id))) { const e = new Error('Pick an exit plan from the list.'); e.status = 400; throw e; } f.exit_plan_id = Number(body.exit_plan_id); }
  if ('recipe' in body) f.recipe = JSON.stringify(body.recipe && typeof body.recipe === 'object' ? { skills: Array.isArray(body.recipe.skills) ? body.recipe.skills : [], prerequisites: Array.isArray(body.recipe.prerequisites) ? body.recipe.prerequisites.map(String) : [] } : { skills: [], prerequisites: [] });
  return f;
}
function createEdge(body) {
  const f = { name: 'New edge', ...edgeFields(body) };
  const cols = Object.keys(f);
  const id = getDb().prepare(`INSERT INTO edges (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(f).lastInsertRowid;
  return getEdge(id);
}
function updateEdge(id, body) {
  const db = getDb();
  if (!getEdge(id)) { const e = new Error('That edge no longer exists.'); e.status = 404; throw e; }
  const f = edgeFields(body);
  if (Object.keys(f).length) db.prepare(`UPDATE edges SET ${Object.keys(f).map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...f, id });
  return getEdge(id);
}

// Deleting an edge takes everything taught under it: its examples, its removed examples and its pictures.
// The database rows go; the picture folder is moved to <DIR>/trash so a wrong click can still be undone in Finder.
function edgeCounts(id) {
  return { examples: getDb().prepare('SELECT COUNT(*) AS n FROM examples WHERE edge_id = ?').get(id).n, removed: listRemoved(id).length };
}
function deleteEdge(id) {
  const db = getDb();
  if (!getEdge(id)) { const e = new Error('That edge no longer exists.'); e.status = 404; throw e; }
  if (listEdges().length <= 1) { const e = new Error('This is the only edge. Make another one before deleting this one.'); e.status = 400; throw e; }
  const counts = edgeCounts(id);
  db.prepare('DELETE FROM examples WHERE edge_id = ?').run(id);
  db.prepare('DELETE FROM edges WHERE id = ?').run(id);
  const dir = edgeDir(id);
  if (fs.existsSync(dir)) { fs.mkdirSync(TRASH_DIR, { recursive: true }); fs.renameSync(dir, path.join(TRASH_DIR, `edge-${id}-${Date.now()}`)); }
  return { deleted: id, ...counts };
}

// Small edits from the Library tab: notes, take/skip, setup name, quality. Prices, drawings and pictures are
// only ever changed by saving from the Trainer.
const PATCHABLE = ['setup', 'decision', 'notes_entry', 'notes_stop', 'notes_target', 'notes_exit', 'quality', 'exit_plan_id', 'trend'];
const QUALITIES = ['textbook', 'okay', 'doubtful'];
function patchExample(id, body) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM examples WHERE id = ?').get(id)) { const e = new Error('That example no longer exists.'); e.status = 404; throw e; }
  const f = {};
  for (const k of PATCHABLE) if (k in body) f[k] = typeof body[k] === 'string' && body[k].trim() ? body[k] : null;
  if ('exit_plan_id' in body) { if (!getExitPlan(Number(body.exit_plan_id))) { const e = new Error('That exit plan does not exist.'); e.status = 400; throw e; } f.exit_plan_id = Number(body.exit_plan_id); f.outcome = null; }
  if ('trend' in body) { delete f.trend; const row = db.prepare('SELECT entry_rule, drawings FROM examples WHERE id = ?').get(id); const t = body.trend && TRENDS.includes(body.trend.value) ? { value: body.trend.value, source: 'mike', tf: Number(body.trend.tf) || 15 } : null; f.skills = JSON.stringify(skillLabelsFor(row, t)); }
  if ('decision' in f && !['take', 'skip'].includes(f.decision)) { const e = new Error('Choose take or skip.'); e.status = 400; throw e; }
  if (f.quality != null && !QUALITIES.includes(f.quality)) { const e = new Error('That grade is not one of textbook, okay or doubtful.'); e.status = 400; throw e; }
  if (Object.keys(f).length) db.prepare(`UPDATE examples SET ${Object.keys(f).map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...f, id });
  return getExample(id);
}

// ── removed examples (kept in the "removed" folder; can be put back) ──────────────────
const removedKeyOk = (key) => /^\d+-\d+$/.test(String(key));
// where a removed example's folder is (removed folders live under their edge)
function removedBin(key) {
  if (!removedKeyOk(key)) return null;
  for (const e of listEdges()) { const p = path.join(removedDirOf(e.id), key); if (fs.existsSync(path.join(p, 'example.json'))) return p; }
  return null;
}
function listRemoved(edgeId = null) {
  const out = [];
  for (const e of listEdges()) {
    if (edgeId != null && e.id !== edgeId) continue;
    let names = []; try { names = fs.readdirSync(removedDirOf(e.id)); } catch (_) { continue; }
    for (const key of names) {
      if (!removedKeyOk(key)) continue;
      try {
        const row = JSON.parse(fs.readFileSync(path.join(removedDirOf(e.id), key, 'example.json'), 'utf8'));
        out.push({ ...rowToExample(row, { withDrawings: false }), edge_id: e.id, removed_key: key, removed_ms: Number(key.split('-')[1]) });
      } catch (_) { /* not an example folder */ }
    }
  }
  return out.sort((a, b) => b.removed_ms - a.removed_ms);
}
function removedImagePath(key, name) {
  if (!IMAGE_NAMES.includes(name)) return null;
  const bin = removedBin(key); if (!bin) return null;
  const p = path.join(bin, 'pictures', `${name}.png`);
  return fs.existsSync(p) ? p : null;
}
function restoreExample(key) {
  const bin = removedBin(key); if (!bin) return null;
  let row; try { row = JSON.parse(fs.readFileSync(path.join(bin, 'example.json'), 'utf8')); } catch (_) { return null; }
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(examples)').all().map((c) => c.name).filter((c) => c in row);
  // it comes back under its old number unless that number has since been used
  const use = db.prepare('SELECT id FROM examples WHERE id = ?').get(row.id) ? cols.filter((c) => c !== 'id') : cols;
  const id = db.prepare(`INSERT INTO examples (${use.join(', ')}) VALUES (${use.map((c) => '@' + c).join(', ')})`).run(row).lastInsertRowid;
  // a row from before skills existed comes back with its skill labels worked out
  const back = db.prepare('SELECT skills, entry_rule, drawings FROM examples WHERE id = ?').get(id);
  if (!back.skills) db.prepare('UPDATE examples SET skills = ? WHERE id = ?').run(JSON.stringify(skillLabelsFor({ entry_rule: J(back.entry_rule, null), drawings: J(back.drawings, []) }, null)), id);
  const pics = path.join(bin, 'pictures');
  const edgeId = db.prepare('SELECT edge_id FROM examples WHERE id = ?').get(id).edge_id;
  if (fs.existsSync(pics)) { fs.mkdirSync(examplesDirOf(edgeId), { recursive: true }); fs.renameSync(pics, path.join(examplesDirOf(edgeId), String(id))); }
  fs.rmSync(bin, { recursive: true, force: true }); // only the now-empty holding folder (its contents were just put back)
  return getExample(Number(id));
}

// Emptying the trash: permanent, only ever from the Library's "Delete for good" buttons.
function destroyRemoved(key) {
  const bin = removedBin(key); if (!bin) return false;
  fs.rmSync(bin, { recursive: true, force: true });
  return true;
}
function destroyAllRemoved(edgeId = null) { let n = 0; for (const e of listRemoved(edgeId)) if (destroyRemoved(e.removed_key)) n++; return n; }

// Removing an example moves its row and pictures into a "removed" folder; nothing is destroyed.
function removeExample(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM examples WHERE id = ?').get(id);
  if (!row) return false;
  const bin = path.join(removedDirOf(row.edge_id), `${id}-${Date.now()}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'example.json'), JSON.stringify(row, null, 2));
  const dir = path.join(examplesDirOf(row.edge_id), String(id));
  if (fs.existsSync(dir)) fs.renameSync(dir, path.join(bin, 'pictures'));
  db.prepare('DELETE FROM examples WHERE id = ?').run(id);
  return true;
}

module.exports = {
  DIR, DB_PATH, EXAMPLES_DIR, SYMBOL, TIMEFRAMES,
  getDb, kvGet, kvSet, serverToUtc, parseServerTime, insertBars, coverage, candles, loadM1, invalidate,
  computeOutcome, findEntryMoment, listExamples, getExample, saveExample, patchExample, removeExample, imagePath,
  listRemoved, removedImagePath, restoreExample, destroyRemoved, destroyAllRemoved,
  listEdges, getEdge, createEdge, updateEdge, deleteEdge, edgeCounts, listInstruments, addInstrument, digitsOf,
  listSkills, getSkill, updateSkill, createSkill, deleteSkill, SKILL_CATEGORIES, skillLabelsFor,
  listRiskProfiles, getRiskProfile, createRiskProfile, updateRiskProfile, deleteRiskProfile,
  listExitPlans, getExitPlan, createExitPlan, updateExitPlan, deleteExitPlan, EXIT_TRIGGER_TYPES,
};
