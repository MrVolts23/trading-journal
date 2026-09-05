// Gold Metal Alchemist — schema + seeds. See SCOPE.md at repo root.
// All tables namespaced gma_. Idempotent: safe to run on every boot.

const GMA_SCHEMA = `
-- One row per captured trading day (key hour + day print)
CREATE TABLE IF NOT EXISTS gma_alchemy_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                -- session date (PST, date the print session STARTS)
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  key_ohlc TEXT,                     -- JSON array of 1-min bars for the key window
  print_ohlc TEXT,                   -- JSON array of print-timeframe bars for the session
  key_img TEXT,                      -- rendered key-hour chart (file path or data URL)
  print_img TEXT,                    -- rendered day-print chart
  key_range REAL,                    -- high-low of key window (for expansion ratio)
  print_range REAL,                  -- high-low of print session
  news_flags TEXT DEFAULT '[]',      -- JSON: notable scheduled news that day
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(date, symbol)
);

-- Orientation verdicts: Mike's blind call is ground truth, machine call tracked alongside
CREATE TABLE IF NOT EXISTS gma_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_id INTEGER NOT NULL REFERENCES gma_alchemy_days(id),
  venture_id INTEGER,                -- which venture's mapping produced the render
  human_code TEXT,                   -- none | flipH | flipV | both | unclear
  machine_code TEXT,
  machine_scores TEXT,               -- JSON: score per orientation
  machine_confidence REAL,
  agreed INTEGER,                    -- 1/0, null until both calls exist
  source TEXT DEFAULT 'app',         -- app | calendar_import | backfill
  verdict_at TEXT DEFAULT (datetime('now'))
);

-- Cake Ventures: named sweep projects. Venture 1 seeded below.
CREATE TABLE IF NOT EXISTS gma_ventures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  config TEXT NOT NULL,              -- JSON: key window, print window, sweep space
  status TEXT DEFAULT 'active',      -- active | paused | archived
  created_at TEXT DEFAULT (datetime('now'))
);

-- Every overnight experiment: no experiment without a written rationale + metric
CREATE TABLE IF NOT EXISTS gma_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venture_id INTEGER NOT NULL REFERENCES gma_ventures(id),
  params TEXT NOT NULL,              -- JSON: print timeframe, resampling, metric, etc.
  rationale TEXT NOT NULL,           -- why the planner chose this experiment
  expected TEXT,                     -- what the planner predicted
  result_metrics TEXT,               -- JSON: full scoring output
  score REAL,                        -- headline score for leaderboard ranking
  days_tested INTEGER,
  status TEXT DEFAULT 'planned',     -- planned | running | done | failed
  planned_at TEXT DEFAULT (datetime('now')),
  ran_at TEXT
);

-- Loop run ledger: every headless run, its cost, and the $/day budget guard reads this
CREATE TABLE IF NOT EXISTS gma_loop_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loop_name TEXT NOT NULL,
  status TEXT DEFAULT 'running',     -- running | done | failed | skipped_budget | skipped_halt
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  cost_usd REAL DEFAULT 0,
  tokens_in INTEGER,
  tokens_out INTEGER,
  summary TEXT,                      -- one-paragraph digest written by the loop
  detail TEXT                        -- JSON: anything the loop wants to persist about the run
);

-- Items waiting on a human decision (loop-engineering: escalation, not retry-forever)
CREATE TABLE IF NOT EXISTS gma_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loop_name TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT DEFAULT 'open',        -- open | acked | resolved
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

-- Raw MT5 account snapshots from the GMAExporter EA (balance/equity/open positions)
CREATE TABLE IF NOT EXISTS gma_mt5_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  account_login TEXT,
  balance REAL,
  equity REAL,
  margin REAL,
  open_positions TEXT,               -- JSON
  ingested_at TEXT DEFAULT (datetime('now'))
);

-- Raw MT5 deals from the exporter; ingest pairs them into journal trades (Phase 1)
CREATE TABLE IF NOT EXISTS gma_mt5_deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT NOT NULL UNIQUE,
  position_id TEXT,
  symbol TEXT,
  deal_type TEXT,                    -- buy | sell
  entry TEXT,                        -- in | out | inout
  volume REAL,
  price REAL,
  sl REAL,
  tp REAL,
  profit REAL,
  swap REAL,
  commission REAL,
  comment TEXT,
  deal_time TEXT,
  journal_trade_id TEXT,             -- set once paired into trades table
  ingested_at TEXT DEFAULT (datetime('now'))
);

-- Nightly balance reconciliation results
CREATE TABLE IF NOT EXISTS gma_recon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  journal_balance REAL,
  mt5_balance REAL,
  delta REAL,
  breakdown TEXT,                    -- JSON: categorized explanation (swap/commission/missing/rounding)
  status TEXT DEFAULT 'unreviewed',  -- matched | explained | unreviewed | flagged
  created_at TEXT DEFAULT (datetime('now'))
);

-- Daily market regime classification (cross-referenced by both learning channels)
CREATE TABLE IF NOT EXISTS gma_regimes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  regime TEXT,                       -- trend_up | trend_down | range | high_vol_shock
  metrics TEXT,                      -- JSON: realized vol, ATR, trend strength inputs
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(date, symbol)
);

-- Strategy registry: lifecycle idea → in_sample → out_of_sample → demo → promoted/retired
CREATE TABLE IF NOT EXISTS gma_strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  family TEXT,                       -- e.g. 'double_bos'
  hypothesis TEXT,                   -- plain-language why-this-should-work
  params TEXT NOT NULL,              -- JSON: all rule parameters
  lifecycle TEXT DEFAULT 'idea',     -- idea | in_sample | out_of_sample | demo | promoted | retired
  parent_id INTEGER,                 -- lineage: which strategy this mutated from
  created_by TEXT DEFAULT 'loop',    -- mike | loop
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Backtest runs per strategy per split
CREATE TABLE IF NOT EXISTS gma_backtests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES gma_strategies(id),
  split TEXT NOT NULL,               -- in_sample | out_of_sample | full
  period_from TEXT,
  period_to TEXT,
  metrics TEXT NOT NULL,             -- JSON: trades, winrate, pf, expectancy_r, maxdd_r, net_r...
  trade_log TEXT,                    -- JSON array (capped) for drill-down/chart cards
  ran_at TEXT DEFAULT (datetime('now'))
);

-- Mike's marked-up trade screenshots: the visual playbook that calibrates each strategy's rules
CREATE TABLE IF NOT EXISTS gma_playbook_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES gma_strategies(id),
  image TEXT NOT NULL,               -- data URL (marked-up screenshot)
  caption TEXT,                      -- what Mike saw / did / why
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gma_playbook_strategy ON gma_playbook_examples(strategy_id);
CREATE INDEX IF NOT EXISTS idx_gma_backtests_strategy ON gma_backtests(strategy_id);
CREATE INDEX IF NOT EXISTS idx_gma_days_date ON gma_alchemy_days(date);
CREATE INDEX IF NOT EXISTS idx_gma_verdicts_day ON gma_verdicts(day_id);
CREATE INDEX IF NOT EXISTS idx_gma_experiments_venture ON gma_experiments(venture_id, score);
CREATE INDEX IF NOT EXISTS idx_gma_loop_runs_started ON gma_loop_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_gma_deals_time ON gma_mt5_deals(deal_time);
`;

// Venture 1: Mike's proven anchor. Key window is FIXED; sweep explores the print side.
const VENTURE_1 = {
  name: 'Venture 1 — Globex Open Key',
  description:
    "The original Alchemy read: gold's 1-min 3:00-4:00pm PST (first Globex hour) prints a " +
    'miniature of the full session (4:00pm-2:00pm PST next day) in one of four orientations. ' +
    'Sweep finds the true print timeframe/mapping (15m was the eyeball approximation; 22m gives 1:1 bars).',
  config: {
    symbol: 'XAUUSD',
    timezone: 'America/Los_Angeles',
    key: { timeframe: '1m', start: '15:00', end: '16:00' },
    print: { start: '16:00', end_next_day: '14:00', baseline_timeframe: '15m' },
    sweep: {
      print_timeframes: ['1m', '2m', '3m', '5m', '10m', '15m', '20m', '22m', '30m', '45m', '60m'],
      resampling: ['bar_map', 'time_linear'],
      metrics: ['pearson', 'dtw'],
      orientations: ['none', 'flipH', 'flipV', 'both'],
    },
  },
};

function applyGmaSchema(db) {
  db.exec(GMA_SCHEMA);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO gma_ventures (name, description, config) VALUES (?, ?, ?)'
  );
  insert.run(VENTURE_1.name, VENTURE_1.description, JSON.stringify(VENTURE_1.config));
}

module.exports = { applyGmaSchema };
