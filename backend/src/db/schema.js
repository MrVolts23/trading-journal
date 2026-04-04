const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  broker TEXT,
  currency TEXT DEFAULT 'USD',
  initial_deposit REAL DEFAULT 0,
  deposit_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT UNIQUE NOT NULL,
  account TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  position TEXT NOT NULL,
  strategy TEXT,
  entry_datetime TEXT,
  entry_price REAL,
  lot_size REAL,
  take_profit REAL,
  stop_loss REAL,
  exit_price REAL,
  exit_datetime TEXT,
  commission REAL DEFAULT 0,
  position_size REAL,
  pip_size REAL,
  pip_value REAL,
  pnl REAL,
  pnl_pct REAL,
  r_multiple REAL,
  risk_reward TEXT,
  max_profit REAL,
  max_loss REAL,
  duration TEXT,
  weekday TEXT,
  status TEXT DEFAULT 'OPEN',
  lessons TEXT,
  grade TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  date TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  amount REAL NOT NULL,
  trade_id TEXT,
  position TEXT,
  symbol TEXT,
  balance_per_account REAL,
  total_balance REAL,
  running_peak REAL,
  drawdown_usd REAL,
  drawdown_pct REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  buy_target REAL,
  sell_target REAL,
  trend_bias TEXT,
  status TEXT,
  volatility_rating TEXT,
  current_price REAL,
  prev_price REAL,
  ytd_return REAL,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  broker TEXT,
  mapping_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_entry_datetime ON trades(entry_datetime);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
CREATE INDEX IF NOT EXISTS idx_account_activity_account ON account_activity(account);
CREATE INDEX IF NOT EXISTS idx_account_activity_date ON account_activity(date);

CREATE TABLE IF NOT EXISTS withdrawal_plan_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawal_plan_actuals (
  week_num INTEGER PRIMARY KEY,
  withdrawal_taken REAL DEFAULT 0,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS key_setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  symbol TEXT,
  timeframe TEXT,
  pattern TEXT,
  tags TEXT,
  notes TEXT,
  screenshot TEXT,
  video_url TEXT,
  source_trade_id INTEGER,
  trade_data TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Mistake type categories (seeded with defaults, user can add more in Settings)
CREATE TABLE IF NOT EXISTS mistake_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT '#ef4444',
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Key Lessons — documented trade mistakes for pattern recognition
CREATE TABLE IF NOT EXISTS key_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  symbol TEXT,
  trade_date TEXT,
  pnl REAL,
  mistake_types TEXT DEFAULT '[]',  -- JSON array of mistake_type IDs
  what_happened TEXT,               -- what you actually did
  what_shouldve TEXT,               -- what you should have done
  notes TEXT,
  screenshot TEXT,                  -- base64 data URL
  video_url TEXT,
  source_trade_id TEXT,             -- original trade_id from trades table
  trade_data TEXT,                  -- JSON snapshot of the linked trade
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_key_lessons_trade_date ON key_lessons(trade_date);
CREATE INDEX IF NOT EXISTS idx_key_lessons_created_at ON key_lessons(created_at);

-- MetaDrift — backtest RR entries per day
CREATE TABLE IF NOT EXISTS metadrift_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT 'all',
  rr_value REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(date, account)
);

CREATE INDEX IF NOT EXISTS idx_metadrift_date ON metadrift_entries(date);
`;

module.exports = SCHEMA;
