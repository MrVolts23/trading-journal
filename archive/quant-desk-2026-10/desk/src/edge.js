// Quant Desk — the EDGE: Mike's rule sheet as plain sentences, versions, and the sentences that
// describe a change. Reads desk/config/rulesheet.<family>.yaml and desk/engine/schema.json.
// Nothing here runs a backtest; bench.js does that. No raw parameter names are meant for a screen:
// every key travels inside a { key, label, ... } object so the UI can bind a control to it.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)(?::([^}]*))?\}/g;
const DEFAULT_FAMILY = 'double_bos';

// ── Config loading ────────────────────────────────────────────────────────────────────
function parseYaml(text) {
  const yaml = require(path.join(paths.DESK_ROOT, 'node_modules/js-yaml'));
  return yaml.load(text);
}

const _sheets = new Map();
function loadRuleSheet(family = DEFAULT_FAMILY) {
  const file = path.join(paths.CONFIG_DIR, `rulesheet.${family}.yaml`);
  const st = fs.statSync(file); // throws if the family has no sheet
  const key = `${file}:${st.mtimeMs}`;
  if (_sheets.has(key)) return _sheets.get(key);
  const doc = parseYaml(fs.readFileSync(file, 'utf8')) || {};
  const sheet = {
    family: doc.family || family,
    display_name: doc.display_name || family,
    groups: Array.isArray(doc.groups) ? doc.groups : [],
    advanced_label: doc.advanced_label || 'Advanced. Rarely changed.',
    never_editable_here: Array.isArray(doc.never_editable_here) ? doc.never_editable_here : ['windows', 'spreadUsd', 'slippageUsd'],
    rules: (Array.isArray(doc.rules) ? doc.rules : []).map((r) => {
      const t = parseTemplate(r.text || '');
      return { ...r, params: Array.isArray(r.params) ? r.params : [], text: t.text, text_raw: r.text || '', choice_labels: t.choiceLabels };
    }),
    file,
  };
  _sheets.clear();
  _sheets.set(key, sheet);
  return sheet;
}

function loadSchema() {
  return JSON.parse(fs.readFileSync(paths.ENGINE_SCHEMA_JSON, 'utf8'));
}

// ── Templates ─────────────────────────────────────────────────────────────────────────
// "{armMode:either=both kinds|sweep=only sweeps}" → text "{armMode}", choiceLabels {armMode:{either:'both kinds',...}}
function parseTemplate(text) {
  const choiceLabels = {};
  const out = String(text).replace(PLACEHOLDER_RE, (m, key, spec) => {
    if (spec) {
      choiceLabels[key] = choiceLabels[key] || {};
      for (const part of spec.split('|')) {
        const i = part.indexOf('=');
        if (i > 0) choiceLabels[key][part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
    }
    return `{${key}}`;
  });
  return { text: out, choiceLabels };
}

// Schema labels can carry the same {key:choice=Label} template; split it into label + choice labels.
function parseLabel(def, key) {
  const raw = def && def.label ? String(def.label) : humanKey(key);
  const t = parseTemplate(raw);
  let label = t.text.replace(new RegExp(`\\s*:?\\s*\\{${key}\\}\\s*`), '').trim();
  if (!label) label = humanKey(key);
  return { label, choiceLabels: t.choiceLabels[key] || null };
}
function humanKey(key) {
  return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

// ── show_when ─────────────────────────────────────────────────────────────────────────
// key == v | key != v | key in [a, b] | key not in [a, b], joined by `and` / `or`. Values compare as strings.
function evalShowWhen(expr, params) {
  if (expr == null || expr === '' || expr === true) return true;
  if (expr === false) return false;
  const s = String(expr).trim();
  const orParts = s.split(/\s+or\s+/i);
  return orParts.some((orp) => orp.split(/\s+and\s+/i).every((clause) => evalClause(clause.trim(), params)));
}
function evalClause(clause, params) {
  const str = (v) => (v == null ? 'null' : String(v));
  let m;
  if ((m = clause.match(/^([A-Za-z0-9_]+)\s+not\s+in\s+\[([^\]]*)\]$/))) return !listOf(m[2]).includes(str(params[m[1]]));
  if ((m = clause.match(/^([A-Za-z0-9_]+)\s+in\s+\[([^\]]*)\]$/))) return listOf(m[2]).includes(str(params[m[1]]));
  if ((m = clause.match(/^([A-Za-z0-9_]+)\s*!=\s*(.+)$/))) return str(params[m[1]]) !== unquote(m[2]);
  if ((m = clause.match(/^([A-Za-z0-9_]+)\s*==\s*(.+)$/))) return str(params[m[1]]) === unquote(m[2]);
  if ((m = clause.match(/^([A-Za-z0-9_]+)$/))) return !!params[m[1]];
  throw new Error(`rule sheet: cannot read show_when "${clause}"`);
}
function listOf(s) { return s.split(',').map((x) => unquote(x.trim())).filter((x) => x !== ''); }
function unquote(s) { return String(s).trim().replace(/^['"]|['"]$/g, ''); }

// ── Param views ───────────────────────────────────────────────────────────────────────
function choicesFor(def, labels) {
  if (!def || !Array.isArray(def.choices)) return null;
  return def.choices.map((c) => ({ value: c, label: labels && labels[String(c)] != null ? labels[String(c)] : String(c) }));
}

function paramView(key, schema, params, extraChoiceLabels) {
  const def = schema[key] || {};
  const { label, choiceLabels } = parseLabel(def, key);
  const labels = { ...(choiceLabels || {}), ...(extraChoiceLabels || {}) };
  return {
    key, label,
    value: params && key in params ? params[key] : def.default,
    default: def.default,
    unit: def.unit ?? null,
    type: def.type || 'number',
    min: def.min ?? null,
    max: def.max ?? null,
    nullable: def.default === null,
    choices: choicesFor(def, labels),
    tag: def.tag || null,
  };
}

function valueLabel(view, value) {
  if (value === undefined) value = view ? view.value : null;
  if (value == null || value === '') return 'blank';
  if (view && view.choices) { const c = view.choices.find((x) => String(x.value) === String(value)); if (c) return c.label; }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value) && value.every((w) => w && typeof w === 'object' && 'start' in w && 'end' in w)) {
    return value.length ? value.map((w) => `${w.name || 'session'} ${w.start} to ${w.end}`).join(', ') : 'no sessions';
  }
  if (Array.isArray(value) || (typeof value === 'object')) return JSON.stringify(value);
  if (view && view.unit === 'USD' && typeof value === 'number') return value.toFixed(2);
  return String(value);
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────
// renderSheet(params, family?) → { family, display_name, groups:[{name, rules:[...]}], advanced:[...], advanced_label }
function renderSheet(params, family = DEFAULT_FAMILY) {
  const sheet = loadRuleSheet(family);
  const schema = loadSchema();
  const p = { ...params };
  const used = new Set();
  const byGroup = new Map(sheet.groups.map((g) => [g, []]));
  for (const rule of sheet.rules) {
    for (const k of rule.params) used.add(k);
    const view = {
      id: rule.id,
      group: rule.group,
      text: rule.text,
      params: rule.params.map((k) => paramView(k, schema, p, rule.choice_labels[k])),
      tag: rule.tag || 'claude-assumed',
      visible: evalShowWhen(rule.show_when, p),
    };
    if (rule.note) view.note = rule.note;
    if (rule.link) view.link = rule.link;
    if (rule.show_when != null) view.show_when = String(rule.show_when);
    if (!byGroup.has(rule.group)) byGroup.set(rule.group, []);
    byGroup.get(rule.group).push(view);
  }
  const never = new Set(sheet.never_editable_here);
  const advanced = Object.keys(schema)
    .filter((k) => !used.has(k) && !never.has(k))
    .map((k) => paramView(k, schema, p));
  const groups = [];
  for (const [name, rules] of byGroup) if (name !== 'Advanced' && rules.length) groups.push({ name, rules });
  return { family: sheet.family, display_name: sheet.display_name, groups, advanced, advanced_label: sheet.advanced_label, never_editable_here: [...never] };
}

// The whole sheet as plain English with the values filled in (stored as strategies.rule_sheet_text).
function renderSheetText(params, family = DEFAULT_FAMILY, opts = {}) {
  const r = renderSheet(params, family);
  const schema = loadSchema();
  const lines = [];
  if (opts.title) lines.push(opts.title, '');
  for (const g of r.groups) {
    const visible = g.rules.filter((x) => x.visible);
    if (!visible.length) continue;
    lines.push(`${g.name}`);
    for (const rule of visible) {
      const own = new Map(rule.params.map((pv) => [pv.key, pv]));
      const text = rule.text.replace(PLACEHOLDER_RE, (m, key) => {
        const view = own.get(key) || paramView(key, schema, params);
        return valueLabel(view, view.value);
      });
      lines.push(`- ${text}${rule.tag === 'mike-confirmed' ? '' : ' [assumed]'}`);
    }
    lines.push('');
  }
  const changedAdvanced = r.advanced.filter((pv) => JSON.stringify(pv.value ?? null) !== JSON.stringify(pv.default ?? null));
  if (changedAdvanced.length) {
    lines.push('Advanced (differs from the default)');
    for (const pv of changedAdvanced) lines.push(`- ${pv.label}: ${valueLabel(pv)}`);
    lines.push('');
  }
  lines.push('Sessions, spread and slippage come from the Risk page.');
  return lines.join('\n').trim() + '\n';
}

// ── Change sentences ──────────────────────────────────────────────────────────────────
function labelFor(key, family = DEFAULT_FAMILY) {
  const schema = loadSchema();
  let sheet = null;
  try { sheet = loadRuleSheet(family); } catch (_) { sheet = null; }
  const rule = sheet ? sheet.rules.find((rr) => rr.params.includes(key)) : null;
  return paramView(key, schema, {}, rule ? rule.choice_labels[key] : null);
}

// "Entry-chart swing strength (bars each side): 2 → 1"
function changeSentence(key, from, to, family = DEFAULT_FAMILY) {
  const view = labelFor(key, family);
  return `${view.label}: ${valueLabel(view, from)} → ${valueLabel(view, to)}`;
}
function describeChanges(changes, baseParams, family = DEFAULT_FAMILY) {
  return Object.keys(changes || {}).map((k) => changeSentence(k, baseParams ? baseParams[k] : undefined, changes[k], family));
}
const AUTO_RETEST_PREFIX = 'Re-test of ';
const AUTO_CHANGE_PREFIX = 'Changed: ';
function autoHypothesis(changes, baseParams, versionLabel, family = DEFAULT_FAMILY) {
  const list = describeChanges(changes, baseParams, family);
  if (!list.length) return `${AUTO_RETEST_PREFIX}${versionLabel} with no changes`;
  return `${AUTO_CHANGE_PREFIX}${list.join('; ')}`;
}
function isAutoHypothesis(h) {
  const s = String(h || '');
  return s.startsWith(AUTO_RETEST_PREFIX) || s.startsWith(AUTO_CHANGE_PREFIX);
}

// ── Validation ────────────────────────────────────────────────────────────────────────
// validateChanges(changes, schema, sheet?) → [errors]. Mirrors api.validateDelta, plus: null is
// allowed where the schema default is null (blank = off), and Risk-page keys are refused here.
function validateChanges(changes, schema, family = DEFAULT_FAMILY) {
  const errors = [];
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return ['changes must be an object of {param: value}'];
  let never = ['windows', 'spreadUsd', 'slippageUsd'];
  try { never = loadRuleSheet(family).never_editable_here; } catch (_) { /* default list */ }
  for (const [k, v] of Object.entries(changes)) {
    if (k === 'entryGate' || k === 'countFrom') { errors.push(`"${k}" is not something you can change`); continue; }
    if (never.includes(k)) { errors.push(`sessions, spread and slippage are set on the Risk page, not here`); continue; }
    const def = schema[k];
    if (!def) { errors.push(`"${k}" is not a rule on this sheet`); continue; }
    const label = parseLabel(def, k).label;
    const type = def.type;
    if (type === 'json' || type === 'array' || type === 'object') continue;
    if (type === 'boolean') { if (typeof v !== 'boolean') errors.push(`${label} must be yes or no`); continue; }
    if (type === 'string' || type === 'enum' || type === 'choice') {
      if (def.choices && !def.choices.includes(v)) errors.push(`${label} must be one of: ${def.choices.join(', ')}`);
      continue;
    }
    if (v === null && (def.nullable || def.default === null)) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${label} must be a number`); continue; }
    if (type === 'integer' && !Number.isInteger(v)) errors.push(`${label} must be a whole number`);
    if (def.min != null && v < def.min) errors.push(`${label} can't be below ${def.min}`);
    if (def.max != null && v > def.max) errors.push(`${label} can't be above ${def.max}`);
    if (def.choices && !def.choices.includes(v)) errors.push(`${label} must be one of: ${def.choices.join(', ')}`);
  }
  return errors;
}

// Drop keys whose value equals the current one (a no-op change is not a change).
function effectiveChanges(changes, current) {
  const out = {};
  for (const [k, v] of Object.entries(changes || {})) {
    if (JSON.stringify(v ?? null) !== JSON.stringify(current && k in current ? current[k] : null)) out[k] = v;
  }
  return out;
}

// ── Versions ──────────────────────────────────────────────────────────────────────────
// "Double BOS v2.1" → "v2.1"; falls back to "v<version column>".
function versionLabel(strategy) {
  if (!strategy) return null;
  const m = String(strategy.name || '').match(/\bv(\d+(?:\.\d+)*)\b/i);
  if (m) return `v${m[1]}`;
  return strategy.version != null ? `v${strategy.version}` : null;
}
// A child version is a dot-increment of its parent: v2.1 → v2.2, v2.9 → v2.10, and a single-segment
// parent gains a minor segment (v1 → v1.1) so a child of v1 never masquerades as the sibling v2.
function bumpLabel(label) {
  const m = String(label || '').match(/^v?(\d+(?:\.\d+)*)$/i);
  if (!m) return 'v1';
  const parts = m[1].split('.');
  if (parts.length === 1) return `v${parts[0]}.1`;
  parts[parts.length - 1] = String(+parts[parts.length - 1] + 1);
  return `v${parts.join('.')}`;
}
// nextVersion(db, parent) → { label:'v2.2', number: <next integer version>, name:'Double BOS v2.2' }
function nextVersion(db, parent, family = parent.family || DEFAULT_FAMILY) {
  let display = family;
  try { display = loadRuleSheet(family).display_name; } catch (_) { /* keep family */ }
  const names = new Set(db.prepare(`SELECT name FROM strategies WHERE family = ?`).all(family).map((r) => r.name));
  const maxV = db.prepare(`SELECT MAX(version) AS v FROM strategies WHERE family = ?`).get(family).v || 0;
  let label = bumpLabel(versionLabel(parent) || `v${parent.version || 1}`);
  const taken = (l) => [...names].some((nm) => new RegExp(`\\b${l.replace(/\./g, '\\.')}\\b`).test(nm));
  let guard = 0;
  while (taken(label) && guard++ < 1000) label = bumpLabel(label);
  return { label, number: maxV + 1, name: `${display} ${label}` };
}

// ── Summaries ─────────────────────────────────────────────────────────────────────────
// summaryFor(metrics, periodsForWindow, window) → the compact stat row the Results page shows.
function summaryFor(metrics, periods, window = 'week') {
  const m = metrics || {};
  const s = periods && periods.summary ? periods.summary : null;
  const out = {
    window,
    trades: m.trades ?? null,
    win_rate: m.winrate ?? m.win_rate ?? null,
    net_r: m.net_r ?? null,
    rr: m.rr ?? null,
    profit_factor: m.profit_factor ?? null,
    expectancy_r: m.expectancy_r ?? null,
    max_dd_r: m.max_dd_r ?? null,
    max_dd_usd: m.max_dd_usd ?? null,
    net_usd: m.net_usd ?? null,
    end_balance: m.end_balance ?? null,
    ccy: m.ccy ?? null,
    periods: s ? s.periods ?? null : null,
    positive_periods: s ? s.positive_periods ?? null : null,
    median_period_r: s ? s.median_period_r ?? null : null,
    worst_period_r: s ? s.worst_period_r ?? null : null,
    best_period_r: s ? s.best_period_r ?? null : null,
  };
  if (window === 'month') { out.months = out.periods; out.positive_months = out.positive_periods; out.median_month_r = out.median_period_r; }
  else { out.weeks = out.periods; out.positive_weeks = out.positive_periods; out.median_week_r = out.median_period_r; }
  return out;
}

module.exports = {
  DEFAULT_FAMILY, PLACEHOLDER_RE,
  loadRuleSheet, loadSchema, parseTemplate, parseLabel, evalShowWhen,
  paramView, valueLabel, renderSheet, renderSheetText,
  labelFor, changeSentence, describeChanges, autoHypothesis, isAutoHypothesis,
  validateChanges, effectiveChanges,
  versionLabel, bumpLabel, nextVersion,
  summaryFor,
};
