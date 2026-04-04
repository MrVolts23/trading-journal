import { useState, useEffect, useRef } from 'react';
import {
  BookMarked, Plus, X, Save, Trash2, Camera, ChevronDown, ChevronUp,
  AlertTriangle, TrendingDown, BarChart2, Video, Calendar
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import {
  getKeyLessons, getKeyLessonsAnalytics, createKeyLesson, updateKeyLesson,
  deleteKeyLesson, getMistakeTypes,
} from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(dt) {
  if (!dt) return '';
  return new Date(dt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
function fmtCur(n) {
  if (n == null) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function fmtMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return new Date(y, m - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

// ── Mistake type badge ────────────────────────────────────────────────────────
function MistakeBadge({ name, color }) {
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold"
      style={{ backgroundColor: `${color}22`, border: `1px solid ${color}55`, color }}
    >
      {name}
    </span>
  );
}

// ── Mini Analytics Dashboard ─────────────────────────────────────────────────
function AnalyticsDashboard({ analytics, mistakeTypes }) {
  const [open, setOpen] = useState(true);
  if (!analytics || analytics.total === 0) return null;

  const mtMap = {};
  mistakeTypes.forEach(mt => { mtMap[mt.id] = mt; });

  const freqData = analytics.by_mistake_type.slice(0, 8).map(m => ({
    name: m.name,
    count: m.count,
    color: m.color,
  }));

  const pnlData = analytics.by_mistake_type
    .filter(m => m.total_pnl != null)
    .sort((a, b) => a.total_pnl - b.total_pnl)
    .slice(0, 8)
    .map(m => ({
      name: m.name,
      pnl: parseFloat((m.total_pnl || 0).toFixed(2)),
      color: m.color,
    }));

  return (
    <div className="card border-terminal-border/70 overflow-hidden">
      {/* Header toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-3 bg-terminal-surface/60 border-b border-terminal-border hover:bg-terminal-hover/20 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-terminal-green" />
          <span className="text-xs font-mono font-semibold text-terminal-text">Mistake Analytics</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-terminal-dim" /> : <ChevronDown className="w-4 h-4 text-terminal-dim" />}
      </button>

      {open && (
        <div className="p-5 space-y-5">
          {/* Stat cards row */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-terminal-surface rounded border border-terminal-border p-3">
              <div className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide">Lessons Logged</div>
              <div className="text-2xl font-mono font-bold text-terminal-text mt-1">{analytics.total}</div>
            </div>
            <div className="bg-terminal-surface rounded border border-terminal-border p-3">
              <div className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide">Biggest Culprit</div>
              {analytics.top_mistake ? (
                <div className="mt-1">
                  <div
                    className="text-sm font-mono font-bold truncate"
                    style={{ color: analytics.top_mistake.color }}
                  >
                    {analytics.top_mistake.name}
                  </div>
                  <div className="text-[10px] font-mono text-terminal-dim">{analytics.top_mistake.count}× recorded</div>
                </div>
              ) : (
                <div className="text-sm font-mono text-terminal-dim mt-1">—</div>
              )}
            </div>
            <div className="bg-terminal-surface rounded border border-terminal-border p-3">
              <div className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide">Total P&L Impact</div>
              <div className={`text-2xl font-mono font-bold mt-1 ${analytics.total_pnl_impact < 0 ? 'text-terminal-red' : 'text-terminal-green'}`}>
                {fmtCur(analytics.total_pnl_impact) || '—'}
              </div>
            </div>
            <div className="bg-terminal-surface rounded border border-terminal-border p-3">
              <div className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide">This Month</div>
              <div className="text-2xl font-mono font-bold text-terminal-amber mt-1">{analytics.this_month}</div>
              <div className="text-[10px] font-mono text-terminal-dim">lesson{analytics.this_month !== 1 ? 's' : ''}</div>
            </div>
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-2 gap-4">
            {/* Mistake Frequency */}
            {freqData.length > 0 && (
              <div>
                <div className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide mb-3">
                  Mistake Frequency
                </div>
                <ResponsiveContainer width="100%" height={freqData.length * 30 + 10}>
                  <BarChart data={freqData} layout="vertical" margin={{ left: 4, right: 20, top: 0, bottom: 0 }}>
                    <XAxis type="number" tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'monospace' }} allowDecimals={false} />
                    <YAxis
                      dataKey="name" type="category" width={130}
                      tick={{ fill: '#9ca3af', fontSize: 10, fontFamily: 'monospace' }}
                    />
                    <Tooltip
                      contentStyle={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 4 }}
                      labelStyle={{ color: '#c9d1d9', fontSize: 11, fontFamily: 'monospace' }}
                      formatter={(v) => [v, 'times']}
                    />
                    <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                      {freqData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* P&L Cost by Mistake */}
            {pnlData.length > 0 && (
              <div>
                <div className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide mb-3">
                  P&L Cost by Mistake
                </div>
                <ResponsiveContainer width="100%" height={pnlData.length * 30 + 10}>
                  <BarChart data={pnlData} layout="vertical" margin={{ left: 4, right: 20, top: 0, bottom: 0 }}>
                    <XAxis
                      type="number"
                      tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'monospace' }}
                      tickFormatter={v => `$${v}`}
                    />
                    <YAxis
                      dataKey="name" type="category" width={130}
                      tick={{ fill: '#9ca3af', fontSize: 10, fontFamily: 'monospace' }}
                    />
                    <Tooltip
                      contentStyle={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 4 }}
                      labelStyle={{ color: '#c9d1d9', fontSize: 11, fontFamily: 'monospace' }}
                      formatter={(v) => [fmtCur(v), 'P&L']}
                    />
                    <Bar dataKey="pnl" radius={[0, 3, 3, 0]}>
                      {pnlData.map((entry, i) => (
                        <Cell key={i} fill={entry.pnl < 0 ? '#ef4444' : '#22c55e'} fillOpacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Monthly trend */}
          {analytics.by_month?.length > 1 && (
            <div>
              <div className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide mb-3">
                Lessons Logged per Month
              </div>
              <ResponsiveContainer width="100%" height={70}>
                <BarChart data={analytics.by_month} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="month" tick={{ fill: '#6b7280', fontSize: 10, fontFamily: 'monospace' }}
                    tickFormatter={fmtMonth}
                  />
                  <YAxis hide allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 4 }}
                    labelFormatter={fmtMonth}
                    formatter={(v) => [v, 'lessons']}
                  />
                  <Bar dataKey="count" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Lesson Card ───────────────────────────────────────────────────────────────
function LessonCard({ lesson, mistakeTypes, isActive, onClick }) {
  const mtMap = {};
  mistakeTypes.forEach(mt => { mtMap[mt.id] = mt; });
  const badges = (lesson.mistake_types || []).map(id => mtMap[id]).filter(Boolean);

  return (
    <div
      onClick={onClick}
      className={`relative rounded-lg border cursor-pointer transition-all overflow-hidden ${
        isActive
          ? 'border-terminal-red bg-red-950/10'
          : 'border-terminal-border bg-terminal-surface hover:border-terminal-dim hover:bg-terminal-hover/30'
      }`}
    >
      {/* Screenshot strip */}
      {lesson.screenshot && (
        <div className="w-full h-28 overflow-hidden border-b border-terminal-border/60">
          <img src={lesson.screenshot} alt="chart" className="w-full h-full object-cover" />
        </div>
      )}

      <div className="p-3 space-y-2">
        {/* Title */}
        <div className="font-mono font-semibold text-sm text-terminal-text leading-tight">{lesson.title}</div>

        {/* Symbol + Date + P&L row */}
        <div className="flex items-center gap-2 flex-wrap">
          {lesson.symbol && (
            <span className="px-1.5 py-0.5 rounded bg-terminal-amber/10 border border-terminal-amber/30 text-[10px] font-mono text-terminal-amber font-semibold">
              {lesson.symbol}
            </span>
          )}
          {lesson.trade_date && (
            <span className="text-[10px] font-mono text-terminal-dim">{fmtDate(lesson.trade_date)}</span>
          )}
          {lesson.pnl != null && (
            <span className={`text-[11px] font-mono font-bold ml-auto ${lesson.pnl < 0 ? 'text-terminal-red' : 'text-terminal-green'}`}>
              {fmtCur(lesson.pnl)}
            </span>
          )}
        </div>

        {/* Mistake badges */}
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {badges.slice(0, 3).map(mt => (
              <MistakeBadge key={mt.id} name={mt.name} color={mt.color} />
            ))}
            {badges.length > 3 && (
              <span className="text-[9px] font-mono text-terminal-dim self-center">+{badges.length - 3} more</span>
            )}
          </div>
        )}

        {/* What happened excerpt */}
        {lesson.what_happened && (
          <p className="text-[11px] font-mono text-terminal-muted leading-relaxed line-clamp-2">
            {lesson.what_happened}
          </p>
        )}

        <div className="text-[9px] font-mono text-terminal-dim pt-0.5">{fmtDate(lesson.created_at)}</div>
      </div>
    </div>
  );
}

// ── Mistake Type Picker ───────────────────────────────────────────────────────
function MistakePicker({ selected, mistakeTypes, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {mistakeTypes.map(mt => {
        const on = selected.includes(mt.id);
        return (
          <button
            key={mt.id}
            type="button"
            onClick={() => onChange(on ? selected.filter(x => x !== mt.id) : [...selected, mt.id])}
            className="px-2.5 py-1 rounded-full text-[11px] font-mono transition-all"
            style={on
              ? { backgroundColor: `${mt.color}30`, border: `1px solid ${mt.color}`, color: mt.color }
              : { backgroundColor: 'transparent', border: '1px solid #30363d', color: '#6b7280' }
            }
          >
            {on ? '✓ ' : ''}{mt.name}
          </button>
        );
      })}
    </div>
  );
}

// ── Editor Panel ──────────────────────────────────────────────────────────────
function LessonEditor({ lesson, isNew, mistakeTypes, onSave, onDelete, onClose }) {
  const blankDraft = () => ({
    title: '',
    symbol: '',
    trade_date: '',
    pnl: '',
    mistake_types: [],
    what_happened: '',
    what_shouldve: '',
    notes: '',
    screenshot: null,
    video_url: '',
  });

  const [draft, setDraft] = useState(blankDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const screenshotRef = useRef(null);

  useEffect(() => {
    if (lesson) {
      setDraft({
        title:         lesson.title         || '',
        symbol:        lesson.symbol        || '',
        trade_date:    lesson.trade_date    || '',
        pnl:           lesson.pnl           ?? '',
        mistake_types: lesson.mistake_types || [],
        what_happened: lesson.what_happened || '',
        what_shouldve: lesson.what_shouldve || '',
        notes:         lesson.notes         || '',
        screenshot:    lesson.screenshot    || null,
        video_url:     lesson.video_url     || '',
      });
    } else {
      setDraft(blankDraft());
    }
    setError('');
  }, [lesson?.id, isNew]);

  const set = (field, val) => setDraft(d => ({ ...d, [field]: val }));

  const handleScreenshot = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => set('screenshot', e.target.result);
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!draft.title.trim()) { setError('Title is required'); return; }
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...draft,
        pnl: draft.pnl !== '' ? parseFloat(draft.pnl) : null,
      };
      await onSave(payload);
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden min-w-[380px]">
      {/* Panel header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-terminal-border flex-shrink-0 bg-terminal-surface">
        <span className="text-sm font-mono font-semibold text-terminal-text truncate max-w-[220px]">
          {isNew ? 'New Lesson' : (draft.title || 'Untitled Lesson')}
        </span>
        <div className="flex items-center gap-2">
          {!isNew && (
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-terminal-red/40 text-[10px] font-mono text-terminal-red hover:bg-red-950/30 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Delete
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-terminal-red border border-red-700 text-white text-xs font-mono font-semibold hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onClose} className="p-1.5 text-terminal-dim hover:text-terminal-text">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-5 mt-3 p-2.5 bg-red-950 border border-red-900 rounded text-[11px] font-mono text-red-400 flex items-center justify-between">
          ⚠ {error}
          <button onClick={() => setError('')} className="ml-2 text-red-600 hover:text-red-400">×</button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5 space-y-5">
        {/* Title */}
        <div>
          <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
            Lesson Title <span className="text-terminal-red">*</span>
          </label>
          <input
            value={draft.title}
            onChange={e => set('title', e.target.value)}
            placeholder="e.g. XAUUSD — Chased price after London spike"
            className="input-field text-sm w-full"
          />
        </div>

        {/* Symbol + Date + P&L */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Symbol</label>
            <input
              value={draft.symbol}
              onChange={e => set('symbol', e.target.value.toUpperCase())}
              placeholder="XAUUSD"
              className="input-field text-sm w-full"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Trade Date</label>
            <input
              type="date"
              value={draft.trade_date}
              onChange={e => set('trade_date', e.target.value)}
              className="input-field text-sm w-full"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">P&L Impact</label>
            <input
              type="number"
              step="0.01"
              value={draft.pnl}
              onChange={e => set('pnl', e.target.value)}
              placeholder="-250.00"
              className="input-field text-sm w-full"
            />
          </div>
        </div>

        {/* Mistake Types */}
        <div>
          <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-2">
            Mistake Types <span className="text-terminal-dim font-normal">(select all that apply)</span>
          </label>
          {mistakeTypes.length > 0 ? (
            <MistakePicker
              selected={draft.mistake_types}
              mistakeTypes={mistakeTypes}
              onChange={ids => set('mistake_types', ids)}
            />
          ) : (
            <div className="text-xs font-mono text-terminal-dim">
              No mistake types defined — add them in <span className="text-terminal-amber">Settings → Mistake Types</span>.
            </div>
          )}
        </div>

        {/* What happened */}
        <div>
          <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
            What Happened <span className="text-terminal-dim font-normal">(what you actually did)</span>
          </label>
          <textarea
            value={draft.what_happened}
            onChange={e => set('what_happened', e.target.value)}
            rows={4}
            placeholder="Describe what you did wrong: entry too early, moved the stop, chased price after a spike…"
            className="input-field text-sm w-full resize-none leading-relaxed"
          />
        </div>

        {/* What should've happened */}
        <div>
          <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
            What Should Have Happened <span className="text-terminal-dim font-normal">(the correct execution)</span>
          </label>
          <textarea
            value={draft.what_shouldve}
            onChange={e => set('what_shouldve', e.target.value)}
            rows={4}
            placeholder="Describe the correct execution: wait for the candle close, keep the stop at structure, reduce size…"
            className="input-field text-sm w-full resize-none leading-relaxed"
          />
        </div>

        {/* Notes */}
        <div>
          <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
            Additional Notes
          </label>
          <textarea
            value={draft.notes}
            onChange={e => set('notes', e.target.value)}
            rows={3}
            placeholder="Market context, emotional state, what to watch for next time…"
            className="input-field text-sm w-full resize-none leading-relaxed"
          />
        </div>

        {/* Video URL */}
        <div>
          <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
            Video / Recording Link
          </label>
          <div className="flex gap-2">
            <input
              value={draft.video_url}
              onChange={e => set('video_url', e.target.value)}
              placeholder="Paste a screen recording or review video link…"
              className="input-field text-sm flex-1"
            />
            {draft.video_url && (
              <a
                href={draft.video_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-2 rounded border border-blue-700/40 text-[11px] font-mono text-blue-400 hover:text-blue-300 hover:border-blue-600/60 transition-colors whitespace-nowrap"
              >
                <Video className="w-3.5 h-3.5" />
                Open
              </a>
            )}
          </div>
        </div>

        {/* Screenshot */}
        <div>
          <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
            Chart Screenshot
          </label>
          {draft.screenshot ? (
            <div className="relative group">
              <img
                src={draft.screenshot}
                alt="chart"
                className="w-full rounded border border-terminal-border object-contain"
                style={{ maxHeight: 300 }}
              />
              <button
                onClick={() => set('screenshot', null)}
                className="absolute top-2 right-2 p-1.5 rounded bg-black/70 text-terminal-red opacity-0 group-hover:opacity-100 transition-opacity border border-terminal-red/40"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => screenshotRef.current?.click()}
              className="flex items-center gap-2 px-4 py-3 w-full rounded border border-dashed border-terminal-border text-terminal-muted hover:border-terminal-red hover:text-terminal-red transition-colors text-xs font-mono"
            >
              <Camera className="w-4 h-4" />
              Click to attach a chart screenshot
            </button>
          )}
          <input ref={screenshotRef} type="file" accept="image/*" className="hidden"
            onChange={e => handleScreenshot(e.target.files[0])} />
        </div>

        {/* Linked trade reference */}
        {lesson?.trade_data && (
          <div className="rounded border border-terminal-border/60 bg-terminal-surface/50 p-4">
            <div className="text-[9px] font-mono text-terminal-dim uppercase tracking-widest mb-3">Linked Trade</div>
            <div className="grid grid-cols-3 gap-3">
              {[
                ['Symbol',  lesson.trade_data.symbol],
                ['Side',    lesson.trade_data.position],
                ['P&L',     fmtCur(lesson.trade_data.pnl)],
                ['Grade',   lesson.trade_data.grade || '—'],
                ['Entry',   lesson.trade_data.entry_datetime
                              ? new Date(lesson.trade_data.entry_datetime).toLocaleDateString()
                              : '—'],
                ['Status',  lesson.trade_data.status || '—'],
              ].map(([l, v]) => (
                <div key={l}>
                  <div className="text-[9px] font-mono text-terminal-dim">{l}</div>
                  <div className={`text-[11px] font-mono font-semibold ${
                    l === 'P&L' ? (lesson.trade_data.pnl >= 0 ? 'text-terminal-green' : 'text-terminal-red')
                    : l === 'Side' ? (v === 'Long' ? 'text-terminal-green' : 'text-terminal-red')
                    : 'text-terminal-text'
                  }`}>{v || '—'}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────
function EmptyState({ onNew }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
      <div className="w-16 h-16 rounded-full border-2 border-dashed border-terminal-border flex items-center justify-center">
        <BookMarked className="w-7 h-7 text-terminal-dim" />
      </div>
      <div>
        <div className="text-sm font-mono font-semibold text-terminal-text mb-2">No Key Lessons Yet</div>
        <div className="text-xs font-mono text-terminal-muted leading-relaxed max-w-xs">
          Open a poorly-executed trade in the <span className="text-terminal-green">Trade Journal</span> and click{' '}
          <span className="text-terminal-red font-semibold">Log as Lesson</span> to document what went wrong
          and build a catalogue of patterns to avoid.
        </div>
      </div>
      <button onClick={onNew} className="flex items-center gap-2 px-4 py-2 rounded border border-terminal-red/50 bg-red-950/20 text-terminal-red text-xs font-mono font-semibold hover:bg-red-950/40 transition-colors">
        <Plus className="w-4 h-4" />
        Log a Lesson Manually
      </button>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function KeyLessonsPage() {
  const [lessons,      setLessons]      = useState([]);
  const [analytics,    setAnalytics]    = useState(null);
  const [mistakeTypes, setMistakeTypes] = useState([]);
  const [selected,     setSelected]     = useState(null);
  const [isNew,        setIsNew]        = useState(false);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [toast,        setToast]        = useState('');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500); };

  const load = async () => {
    setLoading(true);
    try {
      const [l, a, mt] = await Promise.all([
        getKeyLessons(),
        getKeyLessonsAnalytics(),
        getMistakeTypes(),
      ]);
      setLessons(l);
      setAnalytics(a);
      setMistakeTypes(mt);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleNew = () => {
    setSelected(null);
    setIsNew(true);
  };

  const handleSelect = (lesson) => {
    setSelected(lesson);
    setIsNew(false);
  };

  const handleSave = async (payload) => {
    if (isNew) {
      const created = await createKeyLesson(payload);
      setLessons(ls => [created, ...ls]);
      setSelected(created);
      setIsNew(false);
      showToast('Lesson saved ✓');
    } else {
      const updated = await updateKeyLesson(selected.id, payload);
      setLessons(ls => ls.map(l => l.id === updated.id ? updated : l));
      setSelected(updated);
      showToast('Saved ✓');
    }
    // Refresh analytics
    getKeyLessonsAnalytics().then(setAnalytics).catch(() => {});
  };

  const handleDelete = async () => {
    if (!selected?.id) return;
    if (!window.confirm('Delete this lesson?')) return;
    await deleteKeyLesson(selected.id);
    setLessons(ls => ls.filter(l => l.id !== selected.id));
    setSelected(null);
    getKeyLessonsAnalytics().then(setAnalytics).catch(() => {});
    showToast('Deleted ✓');
  };

  const showEditor = selected || isNew;

  return (
    <div className="flex flex-col h-full overflow-hidden relative">

      {/* Toast */}
      {toast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-terminal-red text-white text-xs font-mono font-semibold rounded shadow-lg pointer-events-none">
          {toast}
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-terminal-border flex-shrink-0 bg-terminal-surface">
        <div className="flex items-center gap-2">
          <BookMarked className="w-4 h-4 text-terminal-red" />
          <h1 className="text-sm font-mono font-semibold text-terminal-text">Key Lessons</h1>
          {!loading && (
            <span className="text-[10px] font-mono text-terminal-dim">
              {lessons.length} lesson{lessons.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button
          onClick={handleNew}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-red/50 bg-red-950/20 text-terminal-red text-xs font-mono font-semibold hover:bg-red-950/40 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Log Lesson
        </button>
      </div>

      {/* Global error */}
      {error && (
        <div className="mx-5 mt-3 p-2.5 bg-red-950 border border-red-900 rounded text-[11px] font-mono text-red-400 flex items-center justify-between">
          ⚠ {error}
          <button onClick={() => setError('')} className="ml-2">×</button>
        </div>
      )}

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: analytics + cards */}
        <div className={`flex flex-col overflow-hidden ${showEditor ? 'w-[460px] flex-shrink-0' : 'flex-1'} border-r border-terminal-border`}>
          <div className="flex-1 overflow-auto p-4 space-y-4">

            {/* Analytics dashboard */}
            {!loading && analytics && (
              <AnalyticsDashboard analytics={analytics} mistakeTypes={mistakeTypes} />
            )}

            {/* Cards */}
            {loading ? (
              <div className="flex items-center justify-center h-32 text-terminal-muted font-mono text-sm animate-pulse">Loading…</div>
            ) : lessons.length === 0 && !isNew ? (
              <EmptyState onNew={handleNew} />
            ) : (
              <div className={`grid gap-3 ${showEditor ? 'grid-cols-1' : 'grid-cols-2 xl:grid-cols-3'}`}>
                {lessons.map(l => (
                  <LessonCard
                    key={l.id}
                    lesson={l}
                    mistakeTypes={mistakeTypes}
                    isActive={selected?.id === l.id}
                    onClick={() => handleSelect(l)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: editor */}
        {showEditor && (
          <div className="flex-1 overflow-hidden">
            <LessonEditor
              lesson={isNew ? null : selected}
              isNew={isNew}
              mistakeTypes={mistakeTypes}
              onSave={handleSave}
              onDelete={handleDelete}
              onClose={() => { setSelected(null); setIsNew(false); }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
