import { useState, useEffect, useCallback, useMemo } from 'react';
import { Beaker, RefreshCw, Loader2, Flame, ChevronDown, ChevronRight, X, AlertTriangle, Database } from 'lucide-react';
import {
  deskGetStatus, deskGetStrategies, deskGetExperiments, deskCreateExperiment, deskBake,
  deskGetExperiment, deskGetLeaderboard, deskGetSchema,
} from '../../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Test Bench (/desk/bench) — the grinder + judge, demo only.
// Queue an experiment (hypothesis + param delta) → Bake (local math, zero tokens)
// → Leaderboard of PASS verdicts by week/month period stats → click for detail.
// No fake data anywhere: every empty state says what to do next.
// ─────────────────────────────────────────────────────────────────────────────

const J = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const num = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const fmtR = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2) + 'R');
const fmtUsd = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(0));
const fmtPct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : (Number(v) <= 1 ? Number(v) * 100 : Number(v)).toFixed(0) + '%');
const rColor = (v) => (v == null ? 'text-terminal-dim' : v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-terminal-muted');
const fmtDate = (t) => (t == null ? '—' : new Date(Number(t) * (Number(t) < 1e11 ? 1000 : 1)).toISOString().slice(0, 10));
const fmtTs = (t) => (t == null ? '—' : new Date(Number(t) * (Number(t) < 1e11 ? 1000 : 1)).toISOString().replace('T', ' ').slice(0, 16));
const short = (s, n = 64) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── tolerant accessors (owner C's exact JSON shapes are settled in parallel) ──
const rowId = (r) => r?.experiment_id ?? r?.id;
const rowMetrics = (r) => J(r?.metrics) || J(r?.research?.metrics) || J(r?.research) || {};
const rowPeriod = (r) => J(r?.period_summary) || J(r?.periods_summary) || J(r?.period) || J(r?.summary) || {};
const rowUsd = (r) => J(r?.usd) || J(r?.sizing) || J(r?.dollars) || {};
const rowVerdict = (r) => (typeof r?.verdict === 'string' ? r.verdict : r?.verdict?.verdict) || r?.gate_verdict?.verdict || null;
const rowFailing = (r) => r?.failing_gate ?? r?.verdict?.failing_gate ?? r?.gate_verdict?.failing_gate ?? null;
const listOf = (d, ...keys) => { if (Array.isArray(d)) return d; for (const k of keys) if (Array.isArray(d?.[k])) return d[k]; return []; };
const periodRows = (p) => { const v = J(p); if (Array.isArray(v)) return v; return listOf(v, 'rows', 'periods', 'items'); };
const periodSummary = (p) => { const v = J(p); return (v && !Array.isArray(v) && (v.summary || v)) || {}; };

function VerdictBadge({ v }) {
  const cls = v === 'PASS' ? 'text-green-400 border-green-600/50' : v === 'REJECT' ? 'text-red-400 border-red-600/50'
    : v === 'BLOCKED' ? 'text-amber-400 border-amber-600/50' : 'text-terminal-dim border-terminal-border';
  return <span className={`px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wide ${cls}`}>{v || 'unbaked'}</span>;
}

// $ equity curve (falls back to cumulative R when trades carry no pnl_usd)
function EquityCurve({ trades, startBalance, width = 640, height = 140 }) {
  if (!trades?.length) return <div className="text-xs font-mono text-terminal-dim">No trades to draw.</div>;
  const hasUsd = trades.some((t) => Number.isFinite(Number(t.pnl_usd)));
  const base = hasUsd && Number.isFinite(Number(startBalance)) ? Number(startBalance) : 0;
  let cum = base;
  const pts = [{ x: 0, y: base }, ...trades.map((t, i) => ({ x: i + 1, y: (cum += Number(hasUsd ? t.pnl_usd || 0 : t.r || 0)) }))];
  const ys = pts.map((p) => p.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  const X = (x) => (x / (pts.length - 1)) * (width - 8) + 4;
  const Y = (y) => height - 14 - ((y - min) / span) * (height - 28);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1].y;
  const up = last >= base;
  const label = hasUsd ? `${fmtUsd(last)} (${fmtUsd(last - base)})` : `${last.toFixed(1)}R`;
  return (
    <div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-full">
        <line x1="4" x2={width - 4} y1={Y(base)} y2={Y(base)} stroke="#30363d" strokeDasharray="3,3" />
        <path d={path} fill="none" stroke={up ? '#22c55e' : '#ef4444'} strokeWidth="1.5" />
        <text x={width - 6} y={Y(last) - 4} fill={up ? '#22c55e' : '#ef4444'} fontSize="10" fontFamily="monospace" textAnchor="end">{label}</text>
      </svg>
      <div className="text-[10px] font-mono text-terminal-dim">{hasUsd ? 'account balance after each sized trade (unsizable trades add $0)' : 'cumulative R — trades carry no $ sizing yet'}</div>
    </div>
  );
}

function PeriodTable({ rows, title }) {
  if (!rows?.length) return <div className="text-xs font-mono text-terminal-dim">No {title} periods.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead className="text-terminal-dim"><tr>
          {['Period', 'Trades', 'W / L', 'Net R', 'Avg win', 'Avg loss', 'RR', 'Win %', 'Net $'].map((h) => <th key={h} className="text-left px-2 py-1.5 whitespace-nowrap">{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.key} className="border-t border-terminal-border">
              <td className="px-2 py-1 text-terminal-text whitespace-nowrap">{p.key}</td>
              <td className="px-2 py-1 text-terminal-text">{p.trades}</td>
              <td className="px-2 py-1 text-terminal-muted">{p.wins} / {p.losses}</td>
              <td className={`px-2 py-1 ${rColor(p.net_r)}`}>{fmtR(p.net_r)}</td>
              <td className="px-2 py-1 text-terminal-text">{num(p.avg_win_r)}</td>
              <td className="px-2 py-1 text-terminal-text">{num(p.avg_loss_r)}</td>
              <td className="px-2 py-1 text-terminal-text">{p.rr == null ? '—' : num(p.rr)}</td>
              <td className="px-2 py-1 text-terminal-text">{fmtPct(p.win_rate ?? p.winrate)}</td>
              <td className={`px-2 py-1 ${rColor(p.net_usd)}`}>{p.net_usd == null ? '—' : fmtUsd(p.net_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Detail drawer for one experiment ─────────────────────────────────────────
function ExperimentDetail({ id, onClose, profile }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { setD(null); setErr(null); deskGetExperiment(id).then(setD).catch((e) => setErr(e?.response?.data?.error || e.message)); }, [id]);
  if (err) return <div className="border border-terminal-red/50 rounded-lg p-4 text-xs font-mono text-red-400">{err}</div>;
  if (!d) return <div className="border border-terminal-border rounded-lg p-4 text-xs font-mono text-terminal-dim"><Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1" />loading experiment #{id}…</div>;

  const exp = d.experiment || d;
  const backtests = listOf(d.backtests || exp.backtests).map((b) => ({ ...b, metrics: J(b.metrics) || {} }));
  const research = backtests.find((b) => b.split === 'research') || backtests.find((b) => b.split === 'full') || null;
  const folds = (d.folds && listOf(d.folds).length ? listOf(d.folds).map((f, i) => ({ split: f.split || `fold_${f.index ?? i + 1}`, ...f, metrics: J(f.metrics) || f })) : backtests.filter((b) => /^fold_/.test(b.split || '')))
    .sort((a, b) => String(a.split).localeCompare(String(b.split)));
  const verdict = J(d.verdict) || J(d.gate_verdict) || J(exp.verdict) || null;
  const gates = listOf(J(verdict?.gates));
  const trades = listOf(J(d.trades) || J(research?.trades));
  const weekRows = periodRows(d.periods_week ?? research?.periods_week);
  const monthRows = periodRows(d.periods_month ?? research?.periods_month);
  const m = research?.metrics || rowMetrics(d) || {};
  const delta = J(exp.params_delta) || {};

  return (
    <div className="border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-terminal-surface flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-mono text-terminal-text">Experiment #{exp.id ?? id}</span>
            <VerdictBadge v={verdict?.verdict} />
            {verdict?.failing_gate && <span className="text-[11px] font-mono text-red-400">failed: {verdict.failing_gate}</span>}
            <span className="text-[10px] font-mono text-terminal-dim">{exp.status} · {exp.source || ''} · sha {String(exp.params_sha || '').slice(0, 10)}</span>
          </div>
          <div className="text-xs font-mono text-terminal-muted mt-1">{exp.hypothesis}</div>
          <div className="text-[10px] font-mono text-terminal-dim mt-1">
            delta: {Object.keys(delta).length ? Object.entries(delta).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' · ') : 'none (champion as-is)'}
            {verdict?.holdout && <span> · holdout: {verdict.holdout}</span>}
            {verdict?.n_trials_at != null && <span> · trials at verdict: {verdict.n_trials_at}</span>}
          </div>
        </div>
        <button onClick={onClose} className="text-terminal-dim hover:text-terminal-text"><X className="w-4 h-4" /></button>
      </div>

      <div className="p-3 grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div>
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1">Gates</div>
          {gates.length ? (
            <table className="w-full text-xs font-mono">
              <thead className="text-terminal-dim"><tr><th className="text-left px-2 py-1">gate</th><th className="text-left px-2 py-1">value</th><th className="text-left px-2 py-1">threshold</th><th className="text-left px-2 py-1">pass</th></tr></thead>
              <tbody>{gates.map((g, i) => (
                <tr key={i} className="border-t border-terminal-border">
                  <td className="px-2 py-1 text-terminal-text">{g.gate}</td>
                  <td className="px-2 py-1 text-terminal-muted">{typeof g.value === 'number' ? num(g.value, 3) : String(g.value ?? '—')}</td>
                  <td className="px-2 py-1 text-terminal-muted">{typeof g.threshold === 'number' ? num(g.threshold, 3) : String(g.threshold ?? '—')}</td>
                  <td className={`px-2 py-1 ${g.pass === true ? 'text-green-400' : g.pass === false ? 'text-red-400' : 'text-terminal-dim'}`}>{g.pass === true ? 'pass' : g.pass === false ? 'FAIL' : g.note || 'report only'}</td>
                </tr>))}</tbody>
            </table>
          ) : <div className="text-xs font-mono text-terminal-dim">No verdict yet — bake this experiment.</div>}

          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mt-4 mb-1">Research window</div>
          {research ? (
            <div className="text-xs font-mono text-terminal-muted">
              {fmtDate(research.from_t)} → {fmtDate(research.to_t)} · warm-up {research.warmup_bars ?? '—'} bars · {m.trades ?? 0} trades ·
              win {fmtPct(m.winrate ?? m.win_rate)} · <span className={rColor(m.net_r)}>{fmtR(m.net_r)}</span> · PF {m.profit_factor ?? '—'} · max DD {num(m.max_dd_r)}R
            </div>
          ) : <div className="text-xs font-mono text-terminal-dim">No research backtest stored.</div>}

          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mt-4 mb-1">Fold consistency (anchored, no re-optimisation)</div>
          {folds.length ? (
            <table className="w-full text-xs font-mono">
              <thead className="text-terminal-dim"><tr><th className="text-left px-2 py-1">fold</th><th className="text-left px-2 py-1">window</th><th className="text-left px-2 py-1">trades</th><th className="text-left px-2 py-1">net R</th><th className="text-left px-2 py-1">PF</th><th className="text-left px-2 py-1">max DD</th></tr></thead>
              <tbody>{folds.map((f) => { const fm = f.metrics || {}; const pos = fm.net_r > 0 && fm.profit_factor > 1; return (
                <tr key={f.split} className="border-t border-terminal-border">
                  <td className={`px-2 py-1 ${pos ? 'text-green-400' : 'text-red-400'}`}>{f.split}</td>
                  <td className="px-2 py-1 text-terminal-dim whitespace-nowrap">{fmtDate(f.from_t)} → {fmtDate(f.to_t)}</td>
                  <td className="px-2 py-1 text-terminal-text">{fm.trades ?? 0}</td>
                  <td className={`px-2 py-1 ${rColor(fm.net_r)}`}>{fmtR(fm.net_r)}</td>
                  <td className="px-2 py-1 text-terminal-text">{fm.profit_factor ?? '—'}</td>
                  <td className="px-2 py-1 text-terminal-text">{num(fm.max_dd_r)}R</td>
                </tr>); })}</tbody>
            </table>
          ) : <div className="text-xs font-mono text-terminal-dim">No folds stored (imported journal results have a single 'full' split; bake to get folds).</div>}
        </div>

        <div>
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1">Equity ({profile?.account_ccy || 'account'} · start {profile?.account_size != null ? fmtUsd(profile.account_size) : '—'})</div>
          <EquityCurve trades={trades} startBalance={profile?.account_size} />
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mt-4 mb-1">Weekly</div>
          <PeriodTable rows={weekRows} title="weekly" />
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mt-4 mb-1">Monthly</div>
          <PeriodTable rows={monthRows} title="monthly" />
        </div>
      </div>

      <div className="px-3 pb-3">
        <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1">Trades (first 200 of {trades.length})</div>
        {trades.length ? (
          <div className="overflow-x-auto max-h-80 overflow-y-auto border border-terminal-border rounded">
            <table className="w-full text-[11px] font-mono">
              <thead className="text-terminal-dim sticky top-0 bg-terminal-surface"><tr>
                {['#', 'entry', 'dir', 'session', 'entry px', 'sl', 'risk', 'exit', 'R', 'lots', 'P&L $', 'reason', 'week'].map((h) => <th key={h} className="text-left px-2 py-1 whitespace-nowrap">{h}</th>)}
              </tr></thead>
              <tbody>{trades.slice(0, 200).map((t, i) => (
                <tr key={i} className="border-t border-terminal-border/60">
                  <td className="px-2 py-0.5 text-terminal-dim">{i + 1}</td>
                  <td className="px-2 py-0.5 text-terminal-muted whitespace-nowrap">{fmtTs(t.entryT ?? t.entry_t ?? t.t)}</td>
                  <td className={`px-2 py-0.5 ${t.dir === 'bull' ? 'text-green-400' : 'text-red-400'}`}>{t.dir}</td>
                  <td className="px-2 py-0.5 text-terminal-muted">{t.session}</td>
                  <td className="px-2 py-0.5 text-terminal-text">{num(t.entry)}</td>
                  <td className="px-2 py-0.5 text-terminal-text">{num(t.sl)}</td>
                  <td className="px-2 py-0.5 text-terminal-text">{num(t.risk)}</td>
                  <td className="px-2 py-0.5 text-terminal-text">{num(t.exit)}</td>
                  <td className={`px-2 py-0.5 ${rColor(t.r)}`}>{fmtR(t.r)}</td>
                  <td className="px-2 py-0.5 text-terminal-muted">{t.unsizable ? 'unsizable' : t.lots ?? '—'}</td>
                  <td className={`px-2 py-0.5 ${rColor(t.pnl_usd)}`}>{t.pnl_usd == null ? '—' : fmtUsd(t.pnl_usd)}</td>
                  <td className="px-2 py-0.5 text-terminal-dim">{t.reason}</td>
                  <td className="px-2 py-0.5 text-terminal-dim">{t.week}</td>
                </tr>))}</tbody>
            </table>
          </div>
        ) : <div className="text-xs font-mono text-terminal-dim">No trade list stored for this experiment.</div>}
      </div>
    </div>
  );
}

// ── Param editor generated from /schema ──────────────────────────────────────
// These three come from the active Risk Profile at bake time (sessions + cost model), so editing
// them here would do nothing. Hidden on purpose; change them on the Risk Profile page.
const PROFILE_OWNED = new Set(['windows', 'spreadUsd', 'slippageUsd']);
function ParamEditor({ schema, base, delta, setDelta }) {
  const entries = Object.entries(schema || {}).filter(([k]) => !PROFILE_OWNED.has(k));
  if (!entries.length) return <div className="text-xs font-mono text-terminal-dim">Schema not loaded — the API's /schema endpoint returned nothing.</div>;
  const inputCls = 'bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text focus:outline-none focus:border-terminal-amber w-full';
  const valueOf = (k, s) => (k in delta ? delta[k] : base?.[k] ?? s.default);
  const setKey = (k, v, s) => setDelta((d) => {
    const nd = { ...d };
    const baseline = base?.[k] ?? s.default;
    if (v === '' || v === undefined || JSON.stringify(v) === JSON.stringify(baseline)) delete nd[k]; else nd[k] = v;
    return nd;
  });
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-2">
      {entries.map(([k, s]) => {
        const v = valueOf(k, s);
        const changed = k in delta;
        const type = s.type || (Array.isArray(s.choices) ? 'enum' : typeof s.default);
        let control;
        if (Array.isArray(s.choices) && s.choices.length) {
          control = <select value={String(v ?? '')} onChange={(e) => setKey(k, e.target.value, s)} className={inputCls}>{s.choices.map((c) => <option key={String(c)} value={String(c)}>{String(c)}</option>)}</select>;
        } else if (type === 'boolean' || type === 'bool') {
          control = <select value={String(!!v)} onChange={(e) => setKey(k, e.target.value === 'true', s)} className={inputCls}><option value="false">false</option><option value="true">true</option></select>;
        } else if (type === 'number' || type === 'integer' || type === 'int' || type === 'float') {
          control = <input type="number" value={v ?? ''} min={s.min} max={s.max} step={s.step ?? (type === 'integer' || type === 'int' ? 1 : 'any')}
            onChange={(e) => { const raw = e.target.value; setKey(k, raw === '' ? '' : Number(raw), s); }} className={inputCls} />;
        } else if (type === 'json' || type === 'object' || type === 'array') {
          control = <textarea rows={2} value={typeof v === 'string' ? v : JSON.stringify(v ?? null)}
            onChange={(e) => { let parsed; try { parsed = JSON.parse(e.target.value); } catch { parsed = e.target.value; } setKey(k, parsed, s); }} className={inputCls + ' resize-y'} />;
        } else {
          control = <input type="text" value={v ?? ''} onChange={(e) => setKey(k, e.target.value, s)} className={inputCls} />;
        }
        return (
          <label key={k} className="block" title={s.description || ''}>
            <div className="flex items-center justify-between gap-2">
              <span className={`text-[11px] font-mono ${changed ? 'text-amber-400' : 'text-terminal-muted'}`}>{k}{changed && ' *'}</span>
              <span className="text-[10px] font-mono text-terminal-dim whitespace-nowrap">{s.unit || ''}{s.min != null || s.max != null ? ` [${s.min ?? ''}…${s.max ?? ''}]` : ''}</span>
            </div>
            {control}
          </label>
        );
      })}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function TestBenchPage() {
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);
  const [strategies, setStrategies] = useState([]);
  const [experiments, setExperiments] = useState([]);
  const [schema, setSchema] = useState(null);
  const [profile, setProfile] = useState(null);
  const [leader, setLeader] = useState({ rows: [], rejected: [] });
  const [win, setWin] = useState('week');
  const [selected, setSelected] = useState(null);
  const [showRejected, setShowRejected] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [baking, setBaking] = useState(false);
  const [toast, setToast] = useState(null);      // { kind: 'ok'|'err', text }
  const [stratId, setStratId] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const [delta, setDelta] = useState({});
  const [queueing, setQueueing] = useState(false);

  const flash = (kind, text, ms = 6000) => { setToast({ kind, text }); setTimeout(() => setToast(null), ms); };

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([deskGetStatus(), deskGetStrategies(), deskGetExperiments(), deskGetSchema(), deskGetLeaderboard(win)]);
    const [st, ss, es, sc, lb] = results;
    if (st.status === 'fulfilled') { setStatus(st.value); setStatusErr(null); setProfile(st.value?.active_profile?.fields ? J(st.value.active_profile.fields) : st.value?.active_profile || null); }
    else setStatusErr(st.reason?.response?.status === 503 ? 'desk module not available — restart the backend with desk/ installed' : st.reason?.response?.data?.error || st.reason?.message || 'status failed');
    if (ss.status === 'fulfilled') setStrategies(listOf(ss.value, 'strategies', 'rows'));
    if (es.status === 'fulfilled') setExperiments(listOf(es.value, 'experiments', 'rows'));
    if (sc.status === 'fulfilled') { const v = sc.value; setSchema(v?.params && typeof v.params === 'object' ? v.params : v?.properties || v); }
    if (lb.status === 'fulfilled') setLeader({ rows: listOf(lb.value, 'rows', 'leaderboard', 'passed', 'pass'), rejected: listOf(lb.value?.rejected) });
  }, [win]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (!stratId && strategies.length) setStratId(String(strategies[0].id)); }, [strategies, stratId]);

  const strat = strategies.find((s) => String(s.id) === String(stratId));
  const baseParams = useMemo(() => J(strat?.params_resolved) || null, [strat]);
  const planned = experiments.filter((e) => e.status === 'planned');
  const manifest = status?.data_manifest ? J(status.data_manifest) : null;
  const nTrials = status?.n_trials ?? status?.research_ledger?.n_trials ?? null;

  const queue = async () => {
    if (!hypothesis.trim()) { flash('err', 'A hypothesis is required — say what you expect this change to do and why.'); return; }
    if (!stratId) { flash('err', 'Pick a strategy first.'); return; }
    setQueueing(true);
    try {
      const r = await deskCreateExperiment({ strategy_id: Number(stratId), hypothesis: hypothesis.trim(), params_delta: delta });
      flash('ok', `Queued experiment #${r?.id ?? ''} (sha ${String(r?.params_sha || '').slice(0, 10)}). Bake it when ready.`);
      setHypothesis(''); setDelta({});
      refresh();
    } catch (e) { flash('err', e?.response?.data?.error || e.message || 'queue failed'); }
    finally { setQueueing(false); }
  };

  const bake = async (ids) => {
    setBaking(true);
    try {
      const r = await deskBake(ids ? { ids } : {});
      const rows = listOf(r, 'results', 'experiments', 'verdicts');
      if (!rows.length) flash('ok', r?.message || 'Bake finished — nothing was planned.');
      else flash('ok', 'Baked: ' + rows.map((x) => `#${rowId(x)} ${rowVerdict(x) || x.status || '?'}${rowFailing(x) ? ' (' + rowFailing(x) + ')' : ''}${x.error ? ' error: ' + x.error : ''}`).join(' · '), 12000);
      refresh();
    } catch (e) { flash('err', e?.response?.data?.error || e.message || 'bake failed'); }
    finally { setBaking(false); }
  };

  const LeaderRow = ({ r, rejected }) => {
    const m = rowMetrics(r), p = rowPeriod(r), u = rowUsd(r);
    const id = rowId(r);
    const rr = r.rr ?? p.median_rr ?? p.rr ?? (p.avg_win_r != null && p.avg_loss_r ? p.avg_win_r / Math.abs(p.avg_loss_r) : null);
    return (
      <tr onClick={() => setSelected(id)} className={`border-t border-terminal-border cursor-pointer hover:bg-terminal-surface ${selected === id ? 'bg-terminal-surface' : ''}`}>
        <td className="px-3 py-2 text-terminal-text max-w-xs"><span className="text-terminal-dim">#{id} </span>{short(r.hypothesis)}</td>
        <td className="px-3 py-2 text-terminal-text">{m.trades ?? '—'}</td>
        <td className="px-3 py-2 text-terminal-text">{fmtPct(m.winrate ?? m.win_rate)}</td>
        <td className={`px-3 py-2 ${rColor(m.net_r)}`}>{fmtR(m.net_r)}</td>
        <td className="px-3 py-2 text-terminal-text">{rr == null ? '—' : num(rr)}</td>
        <td className={`px-3 py-2 ${rColor(p.median_period_r)}`}>{fmtR(p.median_period_r)}</td>
        <td className="px-3 py-2 text-terminal-text">{p.positive_periods ?? '—'}{p.periods != null ? ` / ${p.periods}` : ''}</td>
        <td className="px-3 py-2 text-terminal-text">{m.profit_factor ?? '—'}</td>
        <td className="px-3 py-2 text-terminal-text whitespace-nowrap">{num(m.max_dd_r)}R{(u.max_dd_usd ?? r.max_dd_usd) != null && <span className="text-terminal-dim"> · {fmtUsd(u.max_dd_usd ?? r.max_dd_usd)}</span>}</td>
        <td className="px-3 py-2"><VerdictBadge v={rowVerdict(r) || (rejected ? 'REJECT' : 'PASS')} />{rejected && rowFailing(r) && <div className="text-[10px] font-mono text-red-400 mt-0.5">{rowFailing(r)}</div>}</td>
      </tr>
    );
  };
  const HEAD = ['Experiment', 'Trades', 'Win %', 'Net R', 'RR (avg win / avg loss)', `Median ${win} R`, `Positive ${win}s`, 'PF', 'Max DD', 'Verdict'];

  return (
    <div className="p-6 space-y-4">
      {/* Header + data status */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Beaker className="w-5 h-5 text-cyan-400" />
          <h1 className="text-lg font-mono text-terminal-text">Test Bench</h1>
          <span className="text-xs font-mono text-terminal-dim">grinder + judge · local math, zero tokens · demo only, nothing here executes</span>
        </div>
        <button onClick={refresh} className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
      </div>

      <div className="border border-terminal-border rounded-lg px-3 py-2 flex items-center gap-4 flex-wrap text-xs font-mono">
        <Database className="w-4 h-4 text-terminal-dim" />
        {statusErr ? <span className="text-red-400">{statusErr}</span> : !status ? <span className="text-terminal-dim">loading status…</span> : manifest ? (
          <>
            <span className="text-terminal-text">{manifest.symbol} {manifest.tf}</span>
            <span className="text-terminal-muted">{Number(manifest.bars || 0).toLocaleString()} bars</span>
            <span className="text-terminal-muted">{fmtDate(manifest.from_t)} → {fmtDate(manifest.to_t)}</span>
            <span className="text-amber-400">holdout: none yet — seeded data is burned{manifest.note ? ` (${manifest.note})` : ''}</span>
          </>
        ) : <span className="text-amber-400">no data manifest — run <span className="text-terminal-text">node desk/scripts/import_gma.js</span> to seed the bench</span>}
        {status && (
          <span className="ml-auto text-terminal-muted">trials: <span className="text-terminal-text">{nTrials ?? '—'}</span>
            {status.counts && <span className="text-terminal-dim"> · {Object.entries(status.counts).map(([k, v]) => (v && typeof v === 'object' ? `${k.replace(/_by_status$/, '')}: ${Object.entries(v).map(([kk, vv]) => `${vv} ${kk}`).join(', ') || 'none'}` : `${v} ${k}`)).join(' · ')}</span>}
            {profile?.name && <span className="text-terminal-dim"> · profile: {profile.name}</span>}
          </span>
        )}
      </div>

      {toast && (
        <div className={`px-3 py-2 rounded border text-xs font-mono flex items-start gap-2 ${toast.kind === 'ok' ? 'border-green-600/50 text-green-400' : 'border-terminal-red/50 text-red-400'}`}>
          {toast.kind === 'err' && <AlertTriangle className="w-4 h-4 flex-shrink-0" />}<span className="break-words">{toast.text}</span>
        </div>
      )}

      {/* Queue experiment */}
      <div className="border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-terminal-surface flex items-center justify-between cursor-pointer" onClick={() => setShowForm((v) => !v)}>
          <div className="flex items-center gap-2 text-xs font-mono text-terminal-text">{showForm ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Queue experiment</div>
          <span className="text-[10px] font-mono text-terminal-dim">hypothesis first, then the parameter change — the bench records both</span>
        </div>
        {showForm && (
          <div className="p-3 space-y-3">
            {!strategies.length ? (
              <div className="text-xs font-mono text-terminal-dim">No strategies in the desk yet — run <span className="text-terminal-text">node desk/scripts/import_gma.js</span> to import the July champion and its siblings.</div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-3">
                  <label className="block">
                    <div className="text-[11px] font-mono text-terminal-muted mb-1">Strategy</div>
                    <select value={stratId} onChange={(e) => { setStratId(e.target.value); setDelta({}); }} className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text w-full focus:outline-none focus:border-terminal-amber">
                      {strategies.map((s) => <option key={s.id} value={s.id}>#{s.id} {s.name}{s.family ? ` (${s.family})` : ''}</option>)}
                    </select>
                    {strat?.rule_sheet_text && <div className="mt-1 text-[10px] font-mono text-terminal-dim max-h-16 overflow-y-auto whitespace-pre-wrap">{short(strat.rule_sheet_text, 400)}</div>}
                  </label>
                  <label className="block">
                    <div className="text-[11px] font-mono text-terminal-muted mb-1">Hypothesis <span className="text-red-400">*</span> — what do you expect to change, and why?</div>
                    <textarea rows={3} value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} placeholder="e.g. Wider trail pad (0.50) should cut the liquidity_v1 whipsaw exits in Asia and lift avg win R without adding losses."
                      className="bg-terminal-bg border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text w-full focus:outline-none focus:border-terminal-amber resize-y" />
                  </label>
                </div>
                <div>
                  <div className="text-[11px] font-mono text-terminal-muted mb-1">Parameters <span className="text-terminal-dim">(from the engine schema; only changed values — marked * — go into the delta{baseParams ? ', baseline = strategy params' : ', baseline = schema defaults'}; sessions, spread and slippage come from the Risk Profile)</span></div>
                  <ParamEditor schema={schema} base={baseParams} delta={delta} setDelta={setDelta} />
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <button onClick={queue} disabled={queueing || !hypothesis.trim()}
                    className={`px-3 py-1.5 rounded border text-xs font-mono ${!queueing && hypothesis.trim() ? 'bg-terminal-amber text-black border-terminal-amber font-semibold' : 'text-terminal-dim border-terminal-border cursor-not-allowed'}`}>
                    {queueing ? 'Queueing…' : 'Queue'}
                  </button>
                  <span className="text-[11px] font-mono text-terminal-dim">delta: {Object.keys(delta).length ? Object.entries(delta).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' · ') : 'none — queues the strategy as-is (a re-bake under the current risk profile)'}</span>
                  {Object.keys(delta).length > 0 && <button onClick={() => setDelta({})} className="text-[11px] font-mono text-terminal-muted hover:text-terminal-text">reset params</button>}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Queue + bake */}
      <div className="border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-terminal-surface flex items-center justify-between flex-wrap gap-2">
          <div className="text-xs font-mono text-terminal-text">Planned <span className="text-terminal-dim">({planned.length})</span></div>
          <button onClick={() => bake()} disabled={baking || !planned.length}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-mono ${!baking && planned.length ? 'text-amber-400 border-amber-600/60 hover:bg-terminal-hover' : 'text-terminal-dim border-terminal-border cursor-not-allowed'}`}>
            {baking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flame className="w-3.5 h-3.5" />} {baking ? 'Baking… (up to a minute)' : `Bake now (${planned.length})`}
          </button>
        </div>
        {planned.length ? (
          <table className="w-full text-xs font-mono">
            <tbody>{planned.map((e) => (
              <tr key={e.id} className="border-t border-terminal-border">
                <td className="px-3 py-1.5 text-terminal-dim whitespace-nowrap">#{e.id}</td>
                <td className="px-3 py-1.5 text-terminal-text">{e.hypothesis}</td>
                <td className="px-3 py-1.5 text-terminal-dim whitespace-nowrap">{Object.entries(J(e.params_delta) || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' · ') || 'no delta'}</td>
                <td className="px-3 py-1.5 text-terminal-dim whitespace-nowrap">{e.planned_by} · {String(e.created_at || '').slice(0, 16)}</td>
                <td className="px-3 py-1.5 text-right"><button onClick={() => bake([e.id])} disabled={baking} className="text-[11px] font-mono text-terminal-muted hover:text-amber-400">bake this</button></td>
              </tr>))}</tbody>
          </table>
        ) : <div className="px-3 py-3 text-xs font-mono text-terminal-dim">Nothing queued. Queue an experiment above, then bake — each bake counts one trial against the research ledger.</div>}
      </div>

      {/* Leaderboard */}
      <div className="border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-terminal-surface flex items-center justify-between flex-wrap gap-2">
          <div className="text-xs font-mono text-terminal-text">Leaderboard <span className="text-terminal-dim">— PASS verdicts, ranked by realized R per {win}</span></div>
          <div className="flex items-center gap-1 text-[11px] font-mono">
            {['week', 'month'].map((w) => (
              <button key={w} onClick={() => setWin(w)} className={`px-2.5 py-1 rounded border ${win === w ? 'border-terminal-amber text-terminal-amber' : 'border-terminal-border text-terminal-dim hover:text-terminal-text'}`}>{w === 'week' ? 'Week' : 'Month'}</button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead className="text-terminal-dim"><tr>{HEAD.map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {leader.rows.map((r) => <LeaderRow key={rowId(r)} r={r} />)}
              {!leader.rows.length && (
                <tr><td colSpan={HEAD.length} className="px-3 py-5 text-center text-terminal-dim">
                  {experiments.some((e) => e.status === 'done') ? 'No PASS verdicts yet — every baked experiment failed a gate. Open "Rejected" below to see which.' : 'Nothing baked yet. Queue an experiment and press Bake now; PASS verdicts land here with per-week and per-month R.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-terminal-border">
          <button onClick={() => setShowRejected((v) => !v)} className="w-full px-3 py-2 flex items-center gap-2 text-xs font-mono text-terminal-muted hover:text-terminal-text">
            {showRejected ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Rejected / blocked <span className="text-terminal-dim">({leader.rejected.length})</span>
          </button>
          {showRejected && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-terminal-dim"><tr>{HEAD.map((h) => <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
                <tbody>
                  {leader.rejected.map((r) => <LeaderRow key={rowId(r)} r={r} rejected />)}
                  {!leader.rejected.length && <tr><td colSpan={HEAD.length} className="px-3 py-4 text-center text-terminal-dim">No rejections recorded.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selected != null && <ExperimentDetail id={selected} profile={profile} onClose={() => setSelected(null)} />}

      {/* All experiments (history) */}
      <div className="border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-terminal-surface text-xs font-mono text-terminal-text">All experiments <span className="text-terminal-dim">({experiments.length}) — click to open</span></div>
        {experiments.length ? (
          <table className="w-full text-xs font-mono">
            <tbody>{experiments.map((e) => (
              <tr key={e.id} onClick={() => setSelected(e.id)} className={`border-t border-terminal-border cursor-pointer hover:bg-terminal-surface ${selected === e.id ? 'bg-terminal-surface' : ''}`}>
                <td className="px-3 py-1.5 text-terminal-dim whitespace-nowrap">#{e.id}</td>
                <td className="px-3 py-1.5 text-terminal-text">{short(e.hypothesis, 110)}</td>
                <td className={`px-3 py-1.5 whitespace-nowrap ${e.status === 'done' ? 'text-green-400' : e.status === 'planned' ? 'text-amber-400' : e.status === 'failed' ? 'text-red-400' : 'text-terminal-muted'}`}>{e.status}</td>
                <td className="px-3 py-1.5"><VerdictBadge v={rowVerdict(e) || e.latest_verdict || null} /></td>
                <td className="px-3 py-1.5 text-terminal-dim whitespace-nowrap">{e.source}</td>
              </tr>))}</tbody>
          </table>
        ) : <div className="px-3 py-3 text-xs font-mono text-terminal-dim">No experiments yet.</div>}
      </div>
    </div>
  );
}
