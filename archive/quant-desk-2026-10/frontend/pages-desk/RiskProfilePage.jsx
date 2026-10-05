import { useState, useEffect, useCallback, useMemo } from 'react';
import { ShieldCheck, ChevronDown, ChevronRight, AlertTriangle, Loader2 } from 'lucide-react';
import { deskGetRiskProfile, deskPutRiskProfile } from '../../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Risk (/desk/risk) — how much Mike is willing to lose. Every test obeys these.
// Six numbers up front. Everything else (sessions, costs, contract facts, caps)
// lives under Advanced. Saving PUTs the whole fields object; the API validates and
// marks changed fields as set by Mike.
// ─────────────────────────────────────────────────────────────────────────────

const RISK_PCT_HARD_MAX = 3.0;

const META_KEYS = new Set(['id', 'name', 'version', 'status', 'fields', 'provenance', 'created_at', 'updated_at', 'risk_pct_hard_max', 'changed']);
const parseMaybe = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

// The API returns { fields, provenance, ...meta }; accept a flat profile too.
function splitProfile(raw) {
  if (!raw) return { meta: {}, fields: null, provenance: {} };
  const fields = parseMaybe(raw.fields);
  const provenance = parseMaybe(raw.provenance) || {};
  if (fields && typeof fields === 'object') {
    const meta = {}; for (const k of Object.keys(raw)) if (META_KEYS.has(k) && k !== 'fields' && k !== 'provenance') meta[k] = raw[k];
    return { meta, fields, provenance };
  }
  const flat = {}, meta = {};
  for (const [k, v] of Object.entries(raw)) (META_KEYS.has(k) ? meta : flat)[k] = v;
  return { meta, fields: flat, provenance };
}

const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, path, v) {
  const keys = path.split('.');
  const out = Array.isArray(o) ? [...o] : { ...(o || {}) };
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const next = cur[k];
    cur[k] = Array.isArray(next) ? [...next] : { ...(next || {}) };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = v;
  return out;
}

// The six numbers that matter. Big inputs, one card.
const PRIMARY = [
  { path: 'account_size',           label: 'Account size',                       unit: (f) => f.account_ccy || '',  min: 0,    step: 0.01, hint: 'What the sizing math starts from.' },
  { path: 'risk_pct_per_trade',     label: 'Risk per trade',                     unit: '%',       min: 0.05, max: RISK_PCT_HARD_MAX, step: 0.25, hint: `Of the account, per trade. Hard cap ${RISK_PCT_HARD_MAX}%.` },
  { path: 'max_daily_loss_r',       label: 'Stop for the day after losing',      unit: 'R',       min: 0.1,  step: 0.25, hint: 'Closed R for the day. Days are Pacific time.' },
  { path: 'max_trades_per_day',     label: 'Max trades per day',                 unit: 'trades',  min: 1,    step: 1 },
  { path: 'max_consecutive_losses', label: 'Stop after losses in a row',         unit: 'losses',  min: 1,    step: 1 },
  { path: 'max_drawdown_halt_pct',  label: 'Halt everything at drawdown',        unit: '%',       min: 0.5,  step: 0.5, hint: 'Of the account, from its high.' },
];

// Everything else. Folded by default.
const ADVANCED = [
  { title: 'Limits', fields: [
    { path: 'max_trades_per_session', label: 'Max trades per session',        kind: 'number', unit: 'trades',    min: 1, step: 1 },
    { path: 'max_concurrent',         label: 'Max open positions at once',    kind: 'number', unit: 'positions', min: 1, step: 1 },
    { path: 'hard_lot_cap',           label: 'Never trade more than',         kind: 'number', unit: 'lots',      min: 0.01, step: 0.01 },
    { path: 'compounding',            label: 'Size off the running balance',  kind: 'bool' },
  ]},
  { title: 'Costs on every simulated trade', fields: [
    { path: 'cost_model.spreadUsd',   label: 'Spread',   kind: 'number', unit: '$', min: 0, step: 0.01 },
    { path: 'cost_model.slippageUsd', label: 'Slippage', kind: 'number', unit: '$', min: 0, step: 0.01 },
  ]},
  { title: 'Contract facts for gold', fields: [
    { path: 'symbol_facts.contract_size',         label: 'Contract size',              kind: 'number', unit: 'oz per lot',        min: 1,      step: 1 },
    { path: 'symbol_facts.lot_step',              label: 'Lot step',                   kind: 'number', unit: 'lots',              min: 0.001,  step: 0.01 },
    { path: 'symbol_facts.min_lot',               label: 'Minimum lot',                kind: 'number', unit: 'lots',              min: 0.001,  step: 0.01 },
    { path: 'symbol_facts.tick_size',             label: 'Tick size',                  kind: 'number', unit: '$',                 min: 0.0001, step: 0.01 },
    { path: 'symbol_facts.tick_value',            label: 'Tick value',                 kind: 'number', unit: '$ per tick per lot', min: 0,     step: 0.01 },
    { path: 'symbol_facts.usd_per_point_per_lot', label: 'Dollars per $1 move, per lot', kind: 'number', unit: '$',               min: 0,      step: 1 },
  ]},
  { title: 'Names', fields: [
    { path: 'name',        label: 'Profile name',     kind: 'text' },
    { path: 'symbol',      label: 'Symbol',           kind: 'text' },
    { path: 'account_ccy', label: 'Account currency', kind: 'text' },
  ]},
];

function fmtWhen(t) {
  if (!t) return '';
  let d;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(String(t))) d = new Date(String(t).replace(' ', 'T') + 'Z');
  else d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ProvDot({ tag }) {
  const mine = tag === 'mike-confirmed';
  return (
    <span title={mine ? 'you set this' : 'assumed'} aria-label={mine ? 'you set this' : 'assumed'}
      className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${mine ? 'bg-green-500/80' : 'bg-terminal-dim/60'}`} />
  );
}

const bigInput = 'w-full bg-terminal-bg border border-terminal-border rounded px-3 py-2 text-2xl font-mono text-terminal-text tabular-nums focus:outline-none focus:border-terminal-amber';
const smallInput = 'bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono text-terminal-text tabular-nums focus:outline-none focus:border-terminal-amber w-full';

export default function RiskProfilePage() {
  const [raw, setRaw] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const { meta, fields, provenance } = useMemo(() => splitProfile(raw), [raw]);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    return deskGetRiskProfile()
      .then((p) => { setRaw(p); setDraft(splitProfile(p).fields); })
      .catch((e) => setError(e?.response?.status === 404 ? null : e?.response?.data?.error || e.message || 'could not load the risk profile'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(fields), [draft, fields]);
  const provFor = (path) => provenance?.[path] ?? provenance?.[path.split('.')[0]] ?? 'claude-assumed';
  const set = (path, v) => setDraft((d) => setPath(d, path, v));

  // Coerce numeric fields from their input strings, then apply the same hard rules the API does.
  const allNumeric = () => [...PRIMARY.map((f) => ({ ...f, kind: 'number' })), ...ADVANCED.flatMap((s) => s.fields)];
  const coerced = () => {
    let out = draft;
    for (const f of allNumeric()) {
      const v = getPath(out, f.path);
      if (f.kind === 'number') out = setPath(out, f.path, v === '' || v == null ? null : Number(v));
      if (f.kind === 'bool') out = setPath(out, f.path, v === true || v === 'true');
    }
    const sessions = (out.sessions || []).map((s) => ({ ...s, start: Number(s.start), end: Number(s.end) }));
    return { ...out, sessions };
  };
  const validate = (f) => {
    const errs = [];
    if (!(f.account_size > 0)) errs.push('Account size must be above 0.');
    if (!(f.risk_pct_per_trade > 0)) errs.push('Risk per trade must be above 0%.');
    if (f.risk_pct_per_trade > RISK_PCT_HARD_MAX) errs.push(`Risk per trade is capped at ${RISK_PCT_HARD_MAX}%.`);
    if (!(f.max_daily_loss_r > 0)) errs.push('The daily loss stop must be above 0 R.');
    for (const fd of allNumeric()) {
      if (fd.kind === 'number' && !Number.isFinite(getPath(f, fd.path))) errs.push(`${fd.label} must be a number.`);
    }
    for (const k of ['max_trades_per_day', 'max_consecutive_losses', 'max_drawdown_halt_pct', 'max_trades_per_session', 'max_concurrent', 'hard_lot_cap']) {
      const fd = allNumeric().find((x) => x.path === k);
      if (fd && Number.isFinite(f[k]) && !(f[k] > 0)) errs.push(`${fd.label} must be above 0.`);
    }
    if (!(f.sessions || []).length) errs.push('Keep at least one session.');
    for (const s of f.sessions || []) {
      if (!s.name || !Number.isFinite(s.start) || !Number.isFinite(s.end)) errs.push('Every session needs a name, a start hour and an end hour.');
      else if (s.start < 0 || s.start >= 24 || s.end < 0 || s.end > 24) errs.push(`Session ${s.name}: hours must be between 0 and 24.`);
    }
    return errs;
  };

  const save = async () => {
    const f = coerced();
    const errs = validate(f);
    if (errs.length) { setError(errs.join(' ')); return; }
    setSaving(true); setError(null);
    try {
      await deskPutRiskProfile(f);
      await load();
      setToast('Saved. Every test from now on obeys these numbers.');
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      const d = e?.response?.data;
      setError(d?.error || (Array.isArray(d?.errors) ? d.errors.join(' ') : null) || e.message || 'save failed');
    } finally { setSaving(false); }
  };

  const sessions = draft?.sessions || [];
  const setSession = (i, k, v) => set('sessions', sessions.map((s, j) => (j === i ? { ...s, [k]: v } : s)));

  const renderAdvanced = (f) => {
    const v = getPath(draft, f.path);
    let control;
    if (f.kind === 'bool') {
      control = (
        <select value={String(v === true || v === 'true')} onChange={(e) => set(f.path, e.target.value === 'true')} className={smallInput}>
          <option value="false">no, fixed balance</option>
          <option value="true">yes, compound</option>
        </select>
      );
    } else if (f.kind === 'number') {
      control = <input type="number" value={v ?? ''} min={f.min} max={f.max} step={f.step} onChange={(e) => set(f.path, e.target.value)} className={smallInput} />;
    } else {
      control = <input type="text" value={v ?? ''} onChange={(e) => set(f.path, e.target.value)} className={smallInput} />;
    }
    return (
      <div key={f.path} className="py-2 flex items-center justify-between gap-4 border-t border-terminal-border/60 first:border-t-0">
        <div className="flex items-center gap-2 min-w-0">
          <ProvDot tag={provFor(f.path)} />
          <span className="text-sm text-terminal-text font-sans truncate">{f.label}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="w-40">{control}</div>
          <span className="text-xs font-mono text-terminal-dim w-24 truncate">{f.unit || ''}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-amber-400" />
            <h1 className="text-lg font-mono text-terminal-text">Risk</h1>
          </div>
          <p className="mt-1 text-sm text-terminal-muted font-sans">How much you're willing to lose. Every test obeys these.</p>
        </div>
        <div className="flex items-center gap-3">
          {meta?.updated_at && <span className="text-xs font-mono text-terminal-dim">saved {fmtWhen(meta.updated_at)}</span>}
          <button onClick={save} disabled={!dirty || saving}
            className={`px-4 py-2 rounded border text-sm font-mono ${dirty && !saving ? 'bg-terminal-amber text-black border-terminal-amber font-semibold' : 'text-terminal-dim border-terminal-border cursor-not-allowed'}`}>
            {saving ? <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Saving</span> : 'Save risk profile'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded border border-terminal-red/50 text-xs font-mono text-red-400"><AlertTriangle className="w-4 h-4 flex-shrink-0" /><span>{error}</span></div>
      )}
      {toast && <div className="px-3 py-2 rounded border border-green-600/50 text-xs font-mono text-green-400">{toast}</div>}

      {loading && !draft && <div className="text-xs font-mono text-terminal-dim"><Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1" />Loading</div>}
      {!loading && !draft && (
        <div className="border border-terminal-border rounded-lg p-4 text-sm font-mono text-terminal-muted">
          No risk profile yet. Import the July champion once and the default gold profile comes with it.
        </div>
      )}

      {draft && (
        <>
          {/* The six numbers */}
          <div className="border border-terminal-border rounded-lg bg-terminal-surface p-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-5">
              {PRIMARY.map((f) => {
                const v = getPath(draft, f.path);
                const unit = typeof f.unit === 'function' ? f.unit(draft) : f.unit;
                return (
                  <label key={f.path} className="block">
                    <div className="flex items-center gap-2 mb-1.5">
                      <ProvDot tag={provFor(f.path)} />
                      <span className="text-sm text-terminal-text font-sans">{f.label}</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <input type="number" value={v ?? ''} min={f.min} max={f.max} step={f.step}
                        onChange={(e) => { const n = e.target.value; set(f.path, f.max != null && n !== '' ? Math.min(f.max, Number(n)) : n); }}
                        className={bigInput} />
                      <span className="text-sm font-mono text-terminal-muted whitespace-nowrap">{unit}</span>
                    </div>
                    {f.hint && <div className="mt-1 text-[11px] font-mono text-terminal-dim">{f.hint}</div>}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Advanced */}
          <section className="border border-terminal-border rounded-lg overflow-hidden">
            <button type="button" onClick={() => setAdvancedOpen((v) => !v)} className="w-full px-4 py-2.5 flex items-center gap-2 text-xs font-mono text-terminal-muted hover:text-terminal-text">
              {advancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              Advanced. Sessions, costs, contract facts, caps.
            </button>
            {advancedOpen && (
              <div className="px-4 pb-4 space-y-5">
                {/* Sessions */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <ProvDot tag={provFor('sessions')} />
                    <span className="text-sm text-terminal-text font-sans">Sessions</span>
                    <span className="text-[11px] font-mono text-terminal-dim">Pacific time hours. Tests trade only inside these and go flat when one ends.</span>
                  </div>
                  <div className="space-y-2">
                    {sessions.map((s, i) => (
                      <div key={i} className="grid grid-cols-[1fr_5rem_5rem_auto] gap-2 items-center">
                        <input type="text" value={s.name ?? ''} onChange={(e) => setSession(i, 'name', e.target.value)} placeholder="name" className={smallInput} />
                        <input type="number" value={s.start ?? ''} step={0.5} min={0} max={24} onChange={(e) => setSession(i, 'start', e.target.value)} title="start hour, Pacific" className={smallInput} />
                        <input type="number" value={s.end ?? ''} step={0.5} min={0} max={24} onChange={(e) => setSession(i, 'end', e.target.value)} title="end hour, Pacific" className={smallInput} />
                        <button type="button" onClick={() => set('sessions', sessions.filter((_, j) => j !== i))} className="text-[11px] font-mono text-terminal-dim hover:text-red-400">remove</button>
                      </div>
                    ))}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-terminal-dim">name, start hour, end hour</span>
                      <button type="button" onClick={() => set('sessions', [...sessions, { name: '', start: 0, end: 0 }])} className="text-[11px] font-mono text-terminal-muted hover:text-terminal-text">add a session</button>
                    </div>
                  </div>
                </div>

                {ADVANCED.map((s) => (
                  <div key={s.title}>
                    <div className="text-[11px] font-mono uppercase tracking-wider text-terminal-dim mb-1">{s.title}</div>
                    <div>{s.fields.map(renderAdvanced)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
