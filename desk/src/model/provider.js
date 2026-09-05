// Quant Desk — the model seam. Everything that talks to a model goes through complete(); it routes
// by role (desk/config/models.yaml), costs every call locally (desk/config/prices.yaml) and returns
// one shape whatever the backend:
//   complete({ role, system, messages, schema?, max_tokens?, effort?, apiKey? })
//     → { text, json, usage, cost_usd, model, provider, stop_reason, latency_ms, refusal? }
// Errors propagate with a `.plain` sentence for Mike (typed SDK classes, never string matching).
// This module never writes to desk.db; the caller (chat.js / budget.js) keeps the ledger.
const fs = require('fs');
const path = require('path');
const paths = require('../paths');
const keychain = require('./keychain');
const anthropic = require('./anthropic');
const local = require('./local');

const MODELS_YAML = path.join(paths.CONFIG_DIR, 'models.yaml');
const PRICES_YAML = path.join(paths.CONFIG_DIR, 'prices.yaml');

const ROLE_DEFAULTS = { provider: 'anthropic', model: 'claude-fable-5-1', effort: 'medium', max_tokens: 3000 };
const ZERO_PRICES = { input: 0, output: 0, cache_read: 0, cache_write_5m: 0 };

// ── Config (cached by mtime so an edit is picked up without a restart) ─────────────────
const _cache = new Map();
function loadYaml(file, fallback) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return fallback; }
  const key = `${file}:${st.mtimeMs}`;
  if (_cache.has(key)) return _cache.get(key);
  let doc = fallback;
  try {
    const yaml = require(path.join(paths.DESK_ROOT, 'node_modules/js-yaml'));
    doc = yaml.load(fs.readFileSync(file, 'utf8')) || fallback;
  } catch (_) { doc = fallback; }
  _cache.clear();
  _cache.set(key, doc);
  return doc;
}
function loadModels() { return loadYaml(MODELS_YAML, { roles: {}, providers: {} }); }
function loadPrices() { return loadYaml(PRICES_YAML, {}); }

function roleConfig(role = 'chat') {
  const m = loadModels();
  const r = (m.roles && m.roles[role]) || {};
  const cfg = { ...ROLE_DEFAULTS, ...r, role };
  const p = (m.providers && m.providers[cfg.provider]) || {};
  cfg.timeout_ms = p.timeout_ms || (cfg.provider === 'anthropic' ? anthropic.DEFAULT_TIMEOUT_MS : local.DEFAULT_TIMEOUT_MS);
  if (cfg.provider === 'local') { cfg.base_url = p.base_url || null; if (!r.model && p.model) cfg.model = p.model; }
  return cfg;
}

// ── Prices ────────────────────────────────────────────────────────────────────────────
function pricesFor(model) {
  const p = loadPrices();
  const row = p && model ? p[model] : null;
  if (!row) return null;
  return { input: +row.input || 0, output: +row.output || 0, cache_read: +row.cache_read || 0, cache_write_5m: +row.cache_write_5m || 0 };
}
// Dollars for a usage block at a model's rates; falls back to the requested model's prices when the
// served model (e.g. a refusal fallback) is not in prices.yaml.
function costFor(model, usage, requestedModel) {
  const pr = pricesFor(model) || pricesFor(requestedModel) || ZERO_PRICES;
  const u = usage || {};
  const usd = ((u.input_tokens || 0) * pr.input
    + (u.output_tokens || 0) * pr.output
    + (u.cache_read_input_tokens || 0) * pr.cache_read
    + (u.cache_creation_input_tokens || 0) * pr.cache_write_5m) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

// ── complete ──────────────────────────────────────────────────────────────────────────
async function complete({ role = 'chat', system, messages, schema, max_tokens, effort, apiKey } = {}) {
  const cfg = roleConfig(role);
  const maxTokens = max_tokens || cfg.max_tokens;
  const eff = effort || cfg.effort;
  let r;
  try {
    if (cfg.provider === 'local') {
      r = await local.complete({ base_url: cfg.base_url, model: cfg.model, system, messages, schema, max_tokens: maxTokens, timeout_ms: cfg.timeout_ms });
    } else {
      const key = apiKey || keychain.getApiKey();
      r = await anthropic.complete({ apiKey: key, model: cfg.model, system, messages, schema, max_tokens: maxTokens, effort: eff, timeout_ms: cfg.timeout_ms });
    }
  } catch (e) {
    if (!(e instanceof keychain.KeyAbsentError)) {
      if (anthropic.isAuthError(e)) keychain.forget();
      const d = anthropic.describeError(e);
      if (!e.plain) e.plain = d.plain;
      e.kind = e.kind || d.kind;
    }
    throw e;
  }
  let json = null;
  if (r.text != null && schema) { try { json = JSON.parse(r.text); } catch (_) { json = null; } }
  return {
    text: r.text,
    json,
    usage: r.usage,
    cost_usd: costFor(r.model, r.usage, cfg.model),
    model: r.model || cfg.model,
    provider: cfg.provider,
    stop_reason: r.stop_reason,
    latency_ms: r.latency_ms,
    refusal: r.refusal || null,
  };
}

module.exports = { complete, roleConfig, loadModels, loadPrices, pricesFor, costFor, ROLE_DEFAULTS, MODELS_YAML, PRICES_YAML };
