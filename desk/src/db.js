// Quant Desk — desk.db access + shared helpers (profile, ledger, hashing).
// IMPORTANT: requires desk/'s OWN better-sqlite3 (built for the system node, ABI 127), never the
// backend's copy — the backend's may be built for Electron's ABI and would fail to load here.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Pick the better-sqlite3 build that loads in THIS process: the backend's copy (rebuilt for Electron
// at ship time, so it is the right one inside the installed app) or desk/'s own copy (system node,
// used by tests, scripts and the dev backend). A build for the wrong ABI only fails when a Database
// is constructed, so each candidate is proven with an in-memory open before it is chosen.
function loadDatabaseCtor() {
  const candidates = [
    path.join(__dirname, '../../backend/node_modules/better-sqlite3'),
    path.join(__dirname, '../node_modules/better-sqlite3'),
  ];
  const errors = [];
  for (const c of candidates) {
    try {
      const D = require(c);
      new D(':memory:').close();
      return D;
    } catch (e) { errors.push(`${c}: ${e.message.split('\n')[0]}`); }
  }
  throw new Error('no usable better-sqlite3 build for this process:\n' + errors.join('\n'));
}
const Database = loadDatabaseCtor();
const { applySchema } = require('./db/schema');
const paths = require('./paths');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(paths.DESK_DB);
  applySchema(_db);
  ensureDefaultProfile(_db);
  return _db;
}

// Read-only handle on the journal DB (never written by the desk). Returns null if absent.
function openJournalReadOnly(journalPath = paths.JOURNAL_DB) {
  if (!fs.existsSync(journalPath)) return null;
  return new Database(journalPath, { readonly: true, fileMustExist: true });
}

// ── Hashing ─────────────────────────────────────────────────────────────────────
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (typeof v === 'function') return '"[fn]"';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => typeof v[k] !== 'function' && v[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function paramsSha(params) { return sha256(canonicalJson(params)); }
function fileSha256(p) { return sha256(fs.readFileSync(p)); }

// ── Risk profile ─────────────────────────────────────────────────────────────────
// Canonical default (mirrors desk/config/risk-profile.defaults.yaml, owned by the MATH owner).
// Used only as a fallback if that yaml is missing/unparseable so the desk still boots.
const INLINE_DEFAULT_PROFILE = {
  name: 'Gold 1% demo',
  symbol: 'XAUUSD',
  account_ccy: 'CAD',
  account_size: 3454.22,
  risk_pct_per_trade: 1.0,
  risk_pct_hard_max: 3.0,
  max_daily_loss_r: 2.0,
  max_trades_per_day: 6,
  max_trades_per_session: 3,
  max_consecutive_losses: 3,
  max_concurrent: 1,
  max_drawdown_halt_pct: 10,
  sessions: [{ name: 'asia', start: 15, end: 23 }, { name: 'ny', start: 4, end: 13.5 }],
  hard_lot_cap: 1.0,
  compounding: false,
  cost_model: { spreadUsd: 0.25, slippageUsd: 0.05 },
  symbol_facts: {
    contract_size: 100, lot_step: 0.01, min_lot: 0.01, tick_size: 0.01, tick_value: 1.0,
    usd_per_point_per_lot: 100,
  },
};

function loadDefaultProfile() {
  try {
    const yaml = require('js-yaml');
    const raw = fs.readFileSync(paths.RISK_PROFILE_DEFAULTS_YAML, 'utf8');
    const doc = yaml.load(raw) || {};
    // Accept either a flat document or { fields, provenance } — the MATH owner picks the layout.
    const fields = doc.fields ? { ...doc.fields } : { ...doc };
    const provenance = doc.provenance || fields.provenance || {};
    delete fields.provenance;
    if (!fields.name) fields.name = INLINE_DEFAULT_PROFILE.name;
    return { fields: { ...INLINE_DEFAULT_PROFILE, ...fields }, provenance: fillProvenance(fields, provenance) };
  } catch (e) {
    // TODO(owner B): desk/config/risk-profile.defaults.yaml missing or unreadable — using inline copy.
    return { fields: { ...INLINE_DEFAULT_PROFILE }, provenance: fillProvenance(INLINE_DEFAULT_PROFILE, {}) };
  }
}

function fillProvenance(fields, given) {
  const prov = {};
  for (const k of Object.keys(fields)) prov[k] = given[k] || (k === 'max_daily_loss_r' ? 'mike-confirmed' : 'claude-assumed');
  return prov;
}

function ensureDefaultProfile(db) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM risk_profiles`).get().n;
  if (n > 0) return;
  const { fields, provenance } = loadDefaultProfile();
  db.prepare(
    `INSERT INTO risk_profiles (name, version, status, fields, provenance) VALUES (?, 1, 'active', ?, ?)`
  ).run(fields.name, JSON.stringify(fields), JSON.stringify(provenance));
}

function rowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, version: row.version, status: row.status,
    fields: JSON.parse(row.fields), provenance: JSON.parse(row.provenance || '{}'),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function getActiveProfile(db = getDb()) {
  const row = db.prepare(`SELECT * FROM risk_profiles WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get()
    || db.prepare(`SELECT * FROM risk_profiles ORDER BY id DESC LIMIT 1`).get();
  return rowToProfile(row);
}

// ── Research ledger (trial counter per family/symbol) ───────────────────────────
function getTrials(db, family, symbol) {
  const r = db.prepare(`SELECT n_trials FROM research_ledger WHERE family = ? AND symbol = ?`).get(family, symbol);
  return r ? r.n_trials : 0;
}
function bumpTrials(db, family, symbol, by = 1) {
  db.prepare(
    `INSERT INTO research_ledger (family, symbol, n_trials) VALUES (?, ?, ?)
     ON CONFLICT(family, symbol) DO UPDATE SET n_trials = n_trials + excluded.n_trials, updated_at = datetime('now')`
  ).run(family, symbol, by);
  return getTrials(db, family, symbol);
}

// ── Data manifest ───────────────────────────────────────────────────────────────
function getManifest(db, symbol = 'XAUUSD', tf = 'M1') {
  return db.prepare(`SELECT * FROM data_manifest WHERE symbol = ? AND tf = ?`).get(symbol, tf) || null;
}

function closeDb() { if (_db) { _db.close(); _db = null; } }

module.exports = {
  getDb, closeDb, openJournalReadOnly, Database,
  canonicalJson, sha256, paramsSha, fileSha256,
  INLINE_DEFAULT_PROFILE, loadDefaultProfile, ensureDefaultProfile, getActiveProfile, rowToProfile,
  getTrials, bumpTrials, getManifest,
};
