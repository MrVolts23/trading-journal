// Quant Desk — desk.db schema (WAL). Idempotent; applied on every open.
// Nothing here touches journal.db (that schema belongs to the backend and is read-only for us).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS risk_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | active
  fields TEXT NOT NULL,                      -- JSON: every editable number Mike sets
  provenance TEXT NOT NULL DEFAULT '{}',     -- JSON: field -> 'mike-confirmed' | 'claude-assumed'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  family TEXT,                               -- e.g. double_bos
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  parent_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  params_resolved TEXT NOT NULL,             -- JSON: engine DEFAULTS merged with the strategy's params
  params_sha TEXT NOT NULL,
  rule_sheet_text TEXT,
  lifecycle TEXT DEFAULT 'idea',
  source TEXT,                               -- e.g. journal-gma-2026-07 | mike
  source_ref TEXT,                           -- idempotency key for imports (e.g. gma_strategies:3)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategies_source_ref ON strategies(source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies(id),
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  hypothesis TEXT NOT NULL,
  params_delta TEXT NOT NULL DEFAULT '{}',   -- JSON: only the keys that differ from the base
  params_resolved TEXT NOT NULL,             -- JSON: full engine params actually run
  params_sha TEXT NOT NULL,
  planned_by TEXT DEFAULT 'mike',
  status TEXT NOT NULL DEFAULT 'planned',    -- planned | running | done | failed
  source TEXT,
  source_ref TEXT,                           -- idempotency key for imports (e.g. gma_experiments:22)
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  ran_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_experiments_source_ref ON experiments(source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_experiments_strategy ON experiments(strategy_id, status);

CREATE TABLE IF NOT EXISTS backtests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  split TEXT NOT NULL,                       -- research | fold_1..fold_5 | full
  from_t INTEGER,
  to_t INTEGER,
  warmup_bars INTEGER,
  metrics TEXT NOT NULL,                     -- JSON
  periods_week TEXT,                         -- JSON: { rows:[...], summary:{...} }
  periods_month TEXT,                        -- JSON
  trades TEXT,                               -- JSON array (capped at 2000)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtests_experiment ON backtests(experiment_id, split);

CREATE TABLE IF NOT EXISTS gate_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  verdict TEXT NOT NULL,                     -- PASS | REJECT | BLOCKED
  gates TEXT NOT NULL,                       -- JSON: [{gate, value, threshold, pass}]
  failing_gate TEXT,
  n_trials_at INTEGER,
  gates_config_sha TEXT,
  holdout TEXT,                              -- always 'none yet (seeded data is burned)' in slice 1
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gate_verdicts_experiment ON gate_verdicts(experiment_id, id);

CREATE TABLE IF NOT EXISTS research_ledger (
  family TEXT NOT NULL,
  symbol TEXT NOT NULL,
  n_trials INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (family, symbol)
);

CREATE TABLE IF NOT EXISTS data_manifest (
  symbol TEXT NOT NULL,
  tf TEXT NOT NULL,
  from_t INTEGER,
  to_t INTEGER,
  bars INTEGER,
  sha256 TEXT,
  burned INTEGER NOT NULL DEFAULT 0,         -- 1 = consulted during prior research; no lockbox allowed
  note TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (symbol, tf)
);

-- ── Chat (desk/src/chat.js). The model never writes here; chat.js does, after validating its JSON. ──
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,                  -- ISO-8601 UTC (one thread per Pacific day by default)
  last_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
  role TEXT NOT NULL,                        -- user | assistant | system
  kind TEXT NOT NULL DEFAULT 'reply',        -- reply | notice (no model call / error) | result (after Apply & test)
  text TEXT NOT NULL DEFAULT '',
  proposal TEXT,                             -- JSON: { summary, confidence, changes:{key:value}, changes_text, dropped, new_rules, questions, strategy_id, version }
  result TEXT,                               -- JSON: the /edge/test outcome a 'result' message reports
  applied_experiment_id INTEGER,
  model_call_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id);

-- Every model call, success or failure, costed locally from desk/config/prices.yaml (desk/src/budget.js).
CREATE TABLE IF NOT EXISTS model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                          -- ISO-8601 UTC; the daily cap is summed per Pacific day
  role TEXT,                                 -- chat | planner | critic | digest | probe
  provider TEXT,
  model TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  stop_reason TEXT,
  thread_id INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_calls_ts ON model_calls(ts);

-- Rules Mike asked for that the engine cannot express yet ("needs engine work").
CREATE TABLE IF NOT EXISTS rule_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER,
  message_id INTEGER,
  text TEXT NOT NULL,
  why TEXT,
  status TEXT NOT NULL DEFAULT 'open',       -- open | done | dropped
  created_at TEXT NOT NULL
);
`;

function applySchema(db) {
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
}

module.exports = { SCHEMA, applySchema };
