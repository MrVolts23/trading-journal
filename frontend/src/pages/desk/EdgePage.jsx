import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Sparkles, ChevronDown, ChevronRight, Loader2, AlertTriangle } from 'lucide-react';
import { deskGetRulesheet, deskGetVersions, deskEdgeTest } from '../../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Edge (/desk/edge) — Mike's rule sheet as plain sentences with inline controls.
// Change a number, optionally say why, press "Test this version". The desk makes a
// child version, bakes it, and comes back with PASS/FAIL plus a one-line reason.
// No raw parameter names are ever shown; every control lives inside a sentence.
// ─────────────────────────────────────────────────────────────────────────────

const FAMILY_LABEL = { double_bos: 'Double break of structure' };

// Copy that the rule sheet itself does not carry (kept here so the sentence stays clean).
const RULE_NOTES = {
  x1: "July's champion exit is 'aim for the last liquidity point'. Your v2.1 sheet still says 'trail behind swings', the rule you haven't signed off yet.",
};
const RULE_LINKS = {
  se1: { to: '/desk/risk', label: 'Edit sessions on the Risk page' },
};

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)(?::([^}]*))?\}/g;

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function fmtWhen(t) {
  if (t == null || t === '') return '';
  let d;
  if (typeof t === 'number') d = new Date(t < 1e11 ? t * 1000 : t);
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(String(t))) d = new Date(String(t).replace(' ', 'T') + 'Z');
  else d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtValue(v, p) {
  if (v == null || v === '') return 'blank';
  if (p?.choices?.length) { const c = p.choices.find((x) => String(x.value) === String(v)); if (c) return c.label; }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

// Verdict from the API is PASS / REJECT / BLOCKED. Mike reads PASS / FAIL.
function verdictWord(v) {
  if (!v) return null;
  const s = String(v).toUpperCase();
  if (s === 'PASS') return 'PASS';
  if (s === 'BLOCKED') return 'BLOCKED';
  return 'FAIL';
}
function VerdictBadge({ v, big }) {
  const w = verdictWord(v);
  const cls = w === 'PASS' ? 'text-green-400 border-green-600/50' : w === 'FAIL' ? 'text-red-400 border-red-600/50'
    : w === 'BLOCKED' ? 'text-amber-400 border-amber-600/50' : 'text-terminal-dim border-terminal-border';
  return <span className={`inline-block rounded border font-mono uppercase tracking-wide ${big ? 'px-2.5 py-1 text-sm' : 'px-1.5 py-0.5 text-[10px]'} ${cls}`}>{w || 'not tested'}</span>;
}

// Tiny provenance dot. Green = Mike set it. Dim = assumed by Claude until he signs off.
function ProvDot({ tag }) {
  const mine = tag === 'mike-confirmed';
  return (
    <span title={mine ? 'you set this' : 'assumed'} aria-label={mine ? 'you set this' : 'assumed'}
      className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${mine ? 'bg-green-500/80' : 'bg-terminal-dim/60'}`} />
  );
}

// Does the sentence already say the unit right after the control? Then don't repeat it.
function unitSuffix(p, before, after) {
  const u = p?.unit;
  if (!u) return '';
  const b = String(before || '').trimEnd();
  const a = String(after || '');
  if (u === 'USD') return b.endsWith('$') ? '' : '$';
  if (u === 'minutes' && /^-?\s*min/i.test(a)) return '';
  if (u === 'R' && /^R\b/.test(a)) return '';
  if (/bars/i.test(u) && /^\s*bars?\b/i.test(a)) return '';
  if (u === 'days' && /^\s*days?\b/i.test(a)) return '';
  if (u === 'entries' && /^\s*entr/i.test(a)) return '';
  if (u === 'positions' && /^\s*position/i.test(a)) return '';
  return u;
}

const numCls = 'inline-block bg-terminal-bg border border-terminal-border rounded px-2 py-0.5 text-sm font-mono text-terminal-text text-center tabular-nums focus:outline-none focus:border-terminal-amber [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';
const selCls = 'inline-block bg-terminal-bg border border-terminal-border rounded px-1.5 py-0.5 text-sm font-mono text-terminal-text focus:outline-none focus:border-terminal-amber max-w-full';

// One inline control for a param. `value` is the current (possibly changed) value.
function Control({ p, value, changed, onChange }) {
  const under = changed ? 'border-b-2 border-b-terminal-amber' : '';
  const range = p.min != null || p.max != null ? `${p.min ?? ''} to ${p.max ?? ''}` : '';
  if (p.choices?.length) {
    return (
      <select value={value == null ? '' : String(value)} onChange={(e) => {
        const raw = e.target.value;
        const match = p.choices.find((c) => String(c.value) === raw);
        onChange(match ? match.value : raw);
      }} title={range} className={`${selCls} ${under}`}>
        {value == null && <option value="">blank</option>}
        {p.choices.map((c) => <option key={String(c.value)} value={String(c.value)}>{c.label ?? String(c.value)}</option>)}
      </select>
    );
  }
  if (p.type === 'boolean') {
    return (
      <select value={value ? 'yes' : 'no'} onChange={(e) => onChange(e.target.value === 'yes')} className={`${selCls} ${under}`}>
        <option value="no">no</option><option value="yes">yes</option>
      </select>
    );
  }
  const str = value == null ? '' : String(value);
  const width = Math.max(5, str.length + 3) + 'ch'; // room for the digits plus padding; spinners are hidden
  const isInt = p.type === 'integer';
  return (
    <input type="number" value={str} min={p.min ?? undefined} max={p.max ?? undefined} step={isInt ? 1 : 'any'} title={range}
      placeholder="blank" style={{ width }}
      onChange={(e) => { const raw = e.target.value; onChange(raw === '' ? null : Number(raw)); }}
      className={`${numCls} ${under}`} />
  );
}

// Render a rule's sentence, replacing {param} placeholders with controls (or the read-only
// value when the param belongs to another rule, e.g. the chart timeframe mentioned in passing).
function Sentence({ text, params, allParams, changes, setChange }) {
  const own = useMemo(() => new Map((params || []).map((p) => [p.key, p])), [params]);
  const parts = [];
  let last = 0, i = 0, m;
  const src = String(text || '');
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(src))) {
    const before = src.slice(last, m.index);
    const after = src.slice(m.index + m[0].length);
    if (before) parts.push(<span key={`t${i++}`}>{before}</span>);
    const key = m[1];
    const p = own.get(key) || allParams.get(key);
    if (!p) { parts.push(<span key={`u${i++}`} className="text-terminal-dim">?</span>); }
    else if (own.has(key)) {
      const changed = key in changes;
      const value = changed ? changes[key] : p.value;
      const suffix = unitSuffix(p, before, after);
      parts.push(
        <span key={`c${i++}`} className="inline-flex items-baseline gap-1 mx-0.5 align-baseline">
          <Control p={p} value={value} changed={changed} onChange={(v) => setChange(key, v, p.value)} />
          {suffix && <span className="text-xs text-terminal-dim">{suffix}</span>}
        </span>,
      );
    } else {
      const value = key in changes ? changes[key] : p.value;
      parts.push(<span key={`r${i++}`} className="text-terminal-text border-b border-dotted border-terminal-dim/60" title="set in another rule">{fmtValue(value, p)}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(<span key={`t${i++}`}>{src.slice(last)}</span>);
  return <span className="leading-8">{parts}</span>;
}

function RuleCard({ rule, allParams, changes, setChange }) {
  const changedHere = (rule.params || []).filter((p) => p.key in changes);
  const note = rule.note || RULE_NOTES[rule.id];
  const link = rule.link || RULE_LINKS[rule.id];
  const isStatic = !(rule.params || []).length;
  return (
    <div className={`rounded-lg border px-4 py-3 ${changedHere.length ? 'border-terminal-amber/50' : 'border-terminal-border'}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-2.5"><ProvDot tag={rule.tag} /></span>
        <div className="min-w-0 flex-1 text-[15px] text-terminal-text font-sans">
          {isStatic ? <span className="leading-8">{rule.text}</span>
            : <Sentence text={rule.text} params={rule.params} allParams={allParams} changes={changes} setChange={setChange} />}
        </div>
      </div>
      {(note || link || changedHere.length > 0) && (
        <div className="pl-6 mt-1.5 space-y-1">
          {note && <div className="text-xs font-mono text-terminal-muted">{note}</div>}
          {link && <Link to={link.to} className="inline-block text-xs font-mono text-terminal-amber hover:underline">{link.label}</Link>}
          {changedHere.map((p) => (
            <div key={p.key} className="text-xs font-mono text-terminal-amber/90 tabular-nums">was {fmtValue(p.value, p)}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function EdgePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [versions, setVersions] = useState([]);
  const [selectedId, setSelectedId] = useState(searchParams.get('version') || '');
  const [sheet, setSheet] = useState(null);
  const [changes, setChanges] = useState({});
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const flash = (kind, text, ms = 9000) => { setToast({ kind, text }); setTimeout(() => setToast(null), ms); };

  const family = sheet?.family || 'double_bos';

  const loadVersions = useCallback(async (fam) => {
    const v = await deskGetVersions(fam || 'double_bos');
    const list = Array.isArray(v) ? v : v?.versions || v?.rows || [];
    setVersions(list);
    return list;
  }, []);

  const loadSheet = useCallback(async (id) => {
    const s = await deskGetRulesheet(id || undefined);
    setSheet(s);
    return s;
  }, []);

  // First load: versions, then the sheet for the URL's version or the newest one.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError(null);
      try {
        const list = await loadVersions();
        const want = searchParams.get('version') || (list[0] ? String(list[0].id) : '');
        if (!alive) return;
        setSelectedId(want);
        const s = await loadSheet(want);
        if (alive && !want && s?.strategy?.id != null) setSelectedId(String(s.strategy.id));
      } catch (e) {
        if (alive) setError(e?.response?.data?.error || e.message || 'could not load your rules');
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickVersion = async (id) => {
    if (String(id) === String(selectedId)) return;
    setSelectedId(String(id)); setChanges({}); setNote(''); setError(null);
    setSearchParams(id ? { version: String(id) } : {}, { replace: true });
    try { await loadSheet(id); } catch (e) { setError(e?.response?.data?.error || e.message || 'could not load that version'); }
  };

  // Every param on the sheet (rules + advanced), for cross references inside sentences.
  const allParams = useMemo(() => {
    const m = new Map();
    for (const g of sheet?.groups || []) for (const r of g.rules || []) for (const p of r.params || []) m.set(p.key, p);
    for (const p of sheet?.advanced || []) if (!m.has(p.key)) m.set(p.key, p);
    return m;
  }, [sheet]);

  const setChange = (key, value, baseline) => setChanges((c) => {
    const n = { ...c };
    if (sameValue(value, baseline)) delete n[key]; else n[key] = value;
    return n;
  });

  const nChanges = Object.keys(changes).length;
  const strategy = sheet?.strategy;
  const verdict = sheet?.latest_verdict;
  const selectedVersion = versions.find((v) => String(v.id) === String(selectedId));

  const runTest = async (withChanges) => {
    if (!strategy?.id && !selectedId) { setError('Pick a version first.'); return; }
    setTesting(true); setError(null);
    try {
      const r = await deskEdgeTest({ strategy_id: Number(strategy?.id ?? selectedId), changes: withChanges ? changes : {}, note: note.trim() || undefined });
      const newId = r?.strategy?.id ?? strategy?.id ?? selectedId;
      const vname = r?.strategy?.version || r?.strategy?.name || 'version';
      const w = verdictWord(r?.verdict) || 'tested';
      const why = r?.reason ? String(r.reason).replace(/\.$/, '') : '';
      flash(w === 'PASS' ? 'ok' : 'fail', `${vname} tested: ${w}.${why ? ' ' + why.charAt(0).toUpperCase() + why.slice(1) + '.' : ''}`);
      setChanges({}); setNote('');
      await loadVersions(family);
      setSelectedId(String(newId));
      setSearchParams({ version: String(newId) }, { replace: true });
      await loadSheet(newId);
    } catch (e) {
      const d = e?.response?.data;
      setError(d?.error || (Array.isArray(d?.errors) ? d.errors.join(' ') : null) || e.message || 'the test did not run');
    } finally { setTesting(false); }
  };

  const groups = sheet?.groups || [];
  const advanced = sheet?.advanced || [];

  return (
    <div className="p-6 max-w-4xl space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <h1 className="text-lg font-mono text-terminal-text">Edge</h1>
        </div>
        <p className="mt-1 text-sm text-terminal-muted font-sans">Your rules. Change a number, then test it.</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 rounded border border-terminal-red/50 text-xs font-mono text-red-400"><AlertTriangle className="w-4 h-4 flex-shrink-0" /><span>{error}</span></div>
      )}
      {toast && (
        <div className={`px-3 py-2 rounded border text-xs font-mono ${toast.kind === 'ok' ? 'border-green-600/50 text-green-400' : toast.kind === 'fail' ? 'border-red-600/50 text-red-400' : 'border-terminal-border text-terminal-muted'}`}>{toast.text}</div>
      )}

      {loading && !sheet && <div className="text-xs font-mono text-terminal-dim"><Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1" />Loading your rules</div>}

      {!loading && !sheet && !error && (
        <div className="border border-terminal-border rounded-lg p-4 text-sm font-mono text-terminal-muted">
          No rule sheet yet. Import the July champion first, then come back here.
        </div>
      )}

      {sheet && (
        <>
          {/* Version picker + verdict strip */}
          <div className="border border-terminal-border rounded-lg bg-terminal-surface px-4 py-3 space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-mono text-terminal-dim">Version</span>
              <select value={selectedId} onChange={(e) => pickVersion(e.target.value)} disabled={testing}
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-sm font-mono text-terminal-text focus:outline-none focus:border-terminal-amber">
                {versions.map((v) => (
                  <option key={v.id} value={String(v.id)}>
                    {v.version || v.name}{v.last_verdict ? ` · ${verdictWord(v.last_verdict)}` : ' · not tested'}{v.tests ? ` · ${v.tests} test${v.tests === 1 ? '' : 's'}` : ''}
                  </option>
                ))}
                {strategy && !versions.some((v) => String(v.id) === String(strategy.id)) && (
                  <option value={String(strategy.id)}>{strategy.version || strategy.name}{verdict ? ` · ${verdictWord(verdict.verdict)}` : ' · not tested'}</option>
                )}
              </select>
              {selectedVersion?.last_verdict && <VerdictBadge v={selectedVersion.last_verdict} />}
              <span className="text-xs font-mono text-terminal-dim">
                {FAMILY_LABEL[family] || family}{strategy?.created_at ? ` · made ${fmtWhen(strategy.created_at)}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {verdict ? (
                <>
                  <VerdictBadge v={verdict.verdict} big />
                  <span className="text-sm text-terminal-text font-sans">{verdict.reason || (verdictWord(verdict.verdict) === 'PASS' ? 'passed every gate' : 'failed a gate')}</span>
                  {verdict.tested_at && <span className="text-xs font-mono text-terminal-dim">{fmtWhen(verdict.tested_at)}</span>}
                  <Link to={verdict.experiment_id != null ? `/desk/results?open=${verdict.experiment_id}` : '/desk/results'} className="text-xs font-mono text-terminal-amber hover:underline">See results</Link>
                </>
              ) : (
                <>
                  <VerdictBadge v={null} big />
                  <span className="text-sm text-terminal-muted font-sans">Not tested yet. Press Test this version below.</span>
                </>
              )}
            </div>
          </div>

          {/* Rule groups */}
          {groups.map((g) => {
            const visible = (g.rules || []).filter((r) => r.visible !== false);
            if (!visible.length) return null;
            return (
              <section key={g.name} className="space-y-2">
                <h2 className="text-[11px] font-mono uppercase tracking-wider text-terminal-dim">{g.name}</h2>
                {visible.map((r) => <RuleCard key={r.id} rule={r} allParams={allParams} changes={changes} setChange={setChange} />)}
              </section>
            );
          })}

          {/* Advanced */}
          {advanced.length > 0 && (
            <section className="border border-terminal-border rounded-lg overflow-hidden">
              <button type="button" onClick={() => setAdvancedOpen((v) => !v)} className="w-full px-4 py-2.5 flex items-center gap-2 text-xs font-mono text-terminal-muted hover:text-terminal-text">
                {advancedOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                Advanced. Rarely changed.
                {advanced.some((p) => p.key in changes) && <span className="text-terminal-amber">changed</span>}
              </button>
              {advancedOpen && (
                <div className="px-4 pb-3 divide-y divide-terminal-border/60">
                  {advanced.map((p) => {
                    const changed = p.key in changes;
                    const value = changed ? changes[p.key] : p.value;
                    const unit = p.choices?.length || p.type === 'boolean' ? '' : (p.unit === 'USD' ? '$' : p.unit || '');
                    return (
                      <div key={p.key} className="py-2 flex items-center justify-between gap-4 flex-wrap">
                        <span className="text-sm text-terminal-text font-sans">{p.label || 'Setting'}</span>
                        <span className="inline-flex items-baseline gap-1.5">
                          <Control p={p} value={value} changed={changed} onChange={(v) => setChange(p.key, v, p.value)} />
                          {unit && <span className="text-xs text-terminal-dim">{unit}</span>}
                          {changed && <span className="text-xs font-mono text-terminal-amber/90">was {fmtValue(p.value, p)}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Test bar */}
          <div className="sticky bottom-0 -mx-6 px-6 py-4 bg-terminal-bg/95 backdrop-blur border-t border-terminal-border">
            <div className="max-w-4xl space-y-3">
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change (optional, one line)"
                className="w-full bg-terminal-surface border border-terminal-border rounded px-3 py-2 text-sm font-sans text-terminal-text placeholder:text-terminal-dim focus:outline-none focus:border-terminal-amber" />
              <div className="flex items-center gap-3 flex-wrap">
                <button type="button" onClick={() => runTest(true)} disabled={testing || !nChanges}
                  className={`px-4 py-2 rounded border text-sm font-mono ${!testing && nChanges ? 'bg-terminal-amber text-black border-terminal-amber font-semibold' : 'text-terminal-dim border-terminal-border cursor-not-allowed'}`}>
                  {testing ? <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Testing... about 10 seconds</span> : 'Test this version'}
                </button>
                {!nChanges && !testing && (
                  <button type="button" onClick={() => runTest(false)} className="px-4 py-2 rounded border border-terminal-border text-sm font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim">
                    Re-test as is
                  </button>
                )}
                {nChanges > 0 && !testing && (
                  <button type="button" onClick={() => setChanges({})} className="text-xs font-mono text-terminal-dim hover:text-terminal-text">undo changes</button>
                )}
                <span className="text-xs font-mono text-terminal-dim ml-auto">
                  {testing ? 'Making the new version and running it on every stretch of the data.'
                    : nChanges ? `${nChanges} rule${nChanges === 1 ? '' : 's'} changed. Testing makes a new version; ${strategy?.version || 'this one'} stays as it is.`
                    : 'Change a number above to make a new version.'}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
