// Quant Desk — filesystem locations. Everything the desk writes lives under DESK_DIR;
// the journal DB is only ever opened read-only.
//
// Overrides (tests / dev):
//   QUANT_DESK_DIR      — relocate desk.db (tests use a temp dir so the real desk.db is untouched)
//   TRADING_JOURNAL_DB  — journal.db path (same env var the backend uses)
//   QUANT_DESK_CSV      — alternate M1 csv (research data)
const path = require('path');
const os = require('os');
const fs = require('fs');

const DESK_ROOT = path.resolve(__dirname, '..'); // …/trading-journal/desk
const DESK_DIR =
  process.env.QUANT_DESK_DIR || path.join(os.homedir(), 'Library/Application Support/quant-desk');
try { fs.mkdirSync(DESK_DIR, { recursive: true }); } catch (_) { /* surfaced on first open */ }

const DESK_DB = path.join(DESK_DIR, 'desk.db');
const JOURNAL_DB =
  process.env.TRADING_JOURNAL_DB ||
  path.join(os.homedir(), 'Library/Application Support/mikes-trading-journal/journal.db');
const DATA_DIR = path.join(DESK_DIR, 'data'); // user data, shared by the dev backend and the installed app
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* surfaced on first use */ }
const LEGACY_DATA_CSV = path.join(DESK_ROOT, 'data', 'XAUUSD_M1.csv'); // pre-2026-09-05 location inside the repo
const DATA_CSV = process.env.QUANT_DESK_CSV || path.join(DATA_DIR, 'XAUUSD_M1.csv');

// Source of the seeded research CSV (read-only, and ONLY read by scripts/import_gma.js).
const GMA_OUT_CSV = path.join(
  os.homedir(),
  'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/goldbridge/out/gma_history_XAUUSD_M1.csv'
);

const CONFIG_DIR = path.join(DESK_ROOT, 'config');
const GATES_YAML = path.join(CONFIG_DIR, 'gates.yaml');
const RISK_PROFILE_DEFAULTS_YAML = path.join(CONFIG_DIR, 'risk-profile.defaults.yaml');
const ENGINE_DIR = path.join(DESK_ROOT, 'engine');
const ENGINE_SCHEMA_JSON = path.join(ENGINE_DIR, 'schema.json');

module.exports = { LEGACY_DATA_CSV,
  DESK_ROOT, DESK_DIR, DESK_DB, JOURNAL_DB, DATA_DIR, DATA_CSV, GMA_OUT_CSV,
  CONFIG_DIR, GATES_YAML, RISK_PROFILE_DEFAULTS_YAML, ENGINE_DIR, ENGINE_SCHEMA_JSON,
};
