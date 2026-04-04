const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const SCHEMA = require('./schema');

// Database lives in a SIBLING folder next to the app folder so it survives updates.
//
// Folder layout:
//   (parent)/
//     trading-journal/          ← app code (replace this on updates)
//     trading-journal-data/     ← data lives here (never touched on updates)
//       journal.db
//
// start.sh sets TRADING_JOURNAL_DB automatically.
// You can also set it manually to point anywhere you like.
const DB_PATH = process.env.TRADING_JOURNAL_DB
  || path.join(__dirname, '../../../../trading-journal-data/journal.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// One-time migration: if an old DB exists inside the app folder but the
// persistent location is empty, copy it across automatically.
const LEGACY_PATH = path.join(__dirname, '../../data/journal.db');
if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_PATH)) {
  console.log(`[DB] Migrating database from legacy location…`);
  console.log(`[DB]   From: ${LEGACY_PATH}`);
  console.log(`[DB]   To:   ${DB_PATH}`);
  fs.copyFileSync(LEGACY_PATH, DB_PATH);
  console.log('[DB] Migration complete. Your data is now stored in the sibling data folder.');
}

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec(SCHEMA);
    runMigrations(db);
    seedDefaults(db);
  }
  return db;
}

function runMigrations(db) {
  const cols = db.prepare("PRAGMA table_info(trades)").all().map(c => c.name);
  if (!cols.includes('grade'))          db.exec("ALTER TABLE trades ADD COLUMN grade TEXT");
  // Trade Journal columns
  if (!cols.includes('emotion'))        db.exec("ALTER TABLE trades ADD COLUMN emotion TEXT");
  if (!cols.includes('rule_followed'))  db.exec("ALTER TABLE trades ADD COLUMN rule_followed INTEGER"); // 1=yes,0=no,null=unset
  if (!cols.includes('entry_quality'))  db.exec("ALTER TABLE trades ADD COLUMN entry_quality INTEGER"); // 1-5
  if (!cols.includes('exit_quality'))   db.exec("ALTER TABLE trades ADD COLUMN exit_quality INTEGER");  // 1-5
  if (!cols.includes('session'))        db.exec("ALTER TABLE trades ADD COLUMN session TEXT");
  if (!cols.includes('screenshot'))     db.exec("ALTER TABLE trades ADD COLUMN screenshot TEXT");       // base64 data URL
  if (!cols.includes('reviewed'))       db.exec("ALTER TABLE trades ADD COLUMN reviewed INTEGER DEFAULT 0"); // 1=reviewed

  // key_setups migrations
  const ksCols = db.prepare("PRAGMA table_info(key_setups)").all().map(c => c.name);
  if (!ksCols.includes('video_url'))    db.exec("ALTER TABLE key_setups ADD COLUMN video_url TEXT");

  // accounts migrations
  const acctCols = db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name);
  if (!acctCols.includes('broker_account_id')) db.exec("ALTER TABLE accounts ADD COLUMN broker_account_id TEXT");

  // key_lessons + mistake_types tables — safe to run on existing DBs
  db.exec(`
    CREATE TABLE IF NOT EXISTS mistake_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#ef4444',
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS key_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      symbol TEXT,
      trade_date TEXT,
      pnl REAL,
      mistake_types TEXT DEFAULT '[]',
      what_happened TEXT,
      what_shouldve TEXT,
      notes TEXT,
      screenshot TEXT,
      video_url TEXT,
      source_trade_id TEXT,
      trade_data TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_key_lessons_created_at ON key_lessons(created_at)`);
}

function seedDefaults(db) {
  // NOTE: No default accounts are seeded — accounts are personal data, add them via Settings.

  // Seed default settings
  const defaults = [
    ['base_currency', 'USD'],
    ['withdrawal_pct', '0.25'],
    ['synology_path', ''],
    ['strategies', JSON.stringify(['ASIA Scalp', 'ASIA Check Six', 'Asia Flag', 'NY DUMBNESS'])],
    ['markets', JSON.stringify(['METAL', 'FOREX'])],
  ];
  const upsert = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);
  defaults.forEach(([k, v]) => upsert.run(k, v));

  // Seed default mistake types (only if table is empty)
  const mtCount = db.prepare('SELECT COUNT(*) as n FROM mistake_types').get().n;
  if (mtCount === 0) {
    const insertMT = db.prepare('INSERT OR IGNORE INTO mistake_types (name, color, sort_order) VALUES (?, ?, ?)');
    [
      ['Early Entry',        '#f59e0b',  1],
      ['Late Entry',         '#f97316',  2],
      ['Early Exit (Fear)',  '#8b5cf6',  3],
      ['Moved Stop Loss',    '#ef4444',  4],
      ['Ignored Stop Loss',  '#dc2626',  5],
      ['Revenge Trade',      '#b91c1c',  6],
      ['FOMO / Chased',      '#d97706',  7],
      ['No Trade Plan',      '#6b7280',  8],
      ['Overtraded',         '#0ea5e9',  9],
      ['Poor Position Size', '#10b981', 10],
      ['Emotional Trade',    '#ec4899', 11],
    ].forEach(([name, color, sort_order]) => insertMT.run(name, color, sort_order));
  }

  // Seed default watchlist tickers
  const tickers = [
    { ticker: 'XAUUSD', trend_bias: 'Bullish', volatility_rating: 'High' },
    { ticker: 'USDJPY', trend_bias: 'Neutral', volatility_rating: 'Medium' },
    { ticker: 'GBPUSD', trend_bias: 'Neutral', volatility_rating: 'Medium' },
    { ticker: 'USDCHF', trend_bias: 'Neutral', volatility_rating: 'Low' },
  ];
  const insertTicker = db.prepare(`
    INSERT OR IGNORE INTO watchlist (ticker, trend_bias, volatility_rating)
    VALUES (@ticker, @trend_bias, @volatility_rating)
  `);
  tickers.forEach(t => insertTicker.run(t));
}

module.exports = { getDb };
