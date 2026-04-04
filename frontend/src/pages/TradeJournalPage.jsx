import { useState, useEffect, useRef, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { X, Save, Star, Camera, Trash2, ChevronLeft, ChevronRight, CheckCircle, XCircle, ChevronUp, ChevronDown, ChevronsUpDown, Layers, BookMarked } from 'lucide-react';
import { getJournalTrades, saveJournalTrade, toggleTradeReviewed, getSettings, createKeySetup, createKeyLesson, getMistakeTypes } from '../lib/api';

// ── Constants ──────────────────────────────────────────────────────────────────
const GRADES    = ['A', 'B', 'C', 'D'];
const EMOTIONS  = ['Disciplined', 'Confident', 'FOMO', 'Fearful', 'Revenge', 'Overconfident', 'Bored', 'Anxious'];
const SESSIONS  = ['Asia', 'London', 'New York', 'London/NY Overlap', 'Asia/London Overlap'];

const GRADE_COLOR = { A: '#00ff88', B: '#f59e0b', C: '#ef4444', D: '#6b7280' };
const EMOTION_COLOR = {
  Disciplined: '#00ff88', Confident: '#00ff88',
  FOMO: '#f59e0b', Bored: '#f59e0b', Anxious: '#f59e0b',
  Fearful: '#ef4444', Revenge: '#ef4444', Overconfident: '#ef4444',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
function fmtPnl(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// ── Sort icon ─────────────────────────────────────────────────────────────────
function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <ChevronsUpDown className="w-3 h-3 opacity-30" />;
  return sortDir === 'ASC' ? <ChevronUp className="w-3 h-3 text-terminal-green" /> : <ChevronDown className="w-3 h-3 text-terminal-green" />;
}

// ── Reviewed checkbox ─────────────────────────────────────────────────────────
function ReviewedBox({ checked, onChange }) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onChange(!checked); }}
      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors flex-shrink-0 ${
        checked
          ? 'bg-terminal-green border-terminal-green'
          : 'border-terminal-border hover:border-terminal-muted bg-transparent'
      }`}
    >
      {checked && (
        <svg className="w-2.5 h-2.5 text-black" fill="none" viewBox="0 0 10 10">
          <path d="M1.5 5l2.5 2.5 4.5-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
    </button>
  );
}

// ── Star rating component ─────────────────────────────────────────────────────
function StarRating({ value, onChange, label }) {
  return (
    <div>
      <div className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide mb-1">{label}</div>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} onClick={() => onChange(value === n ? null : n)}
            className="transition-colors focus:outline-none">
            <Star className={`w-4 h-4 ${n <= (value || 0) ? 'fill-terminal-amber text-terminal-amber' : 'text-terminal-border'}`} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Hoverable note preview ────────────────────────────────────────────────────
function NotePreview({ text }) {
  if (!text) return <span className="text-terminal-dim text-xs">—</span>;
  const short = text.length > 40 ? text.slice(0, 40) + '…' : text;
  return (
    <div className="relative group inline-block max-w-[200px]">
      <span className="text-terminal-muted text-xs cursor-default truncate block">{short}</span>
      <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block w-72 bg-[#111] border border-terminal-border rounded p-3 shadow-xl pointer-events-none">
        <p className="text-xs font-mono text-terminal-text whitespace-pre-wrap leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

// ── Hoverable screenshot thumbnail ───────────────────────────────────────────
function ScreenshotThumb({ src }) {
  if (!src) return null;
  return (
    <div className="relative group inline-block">
      <div className="w-8 h-6 rounded border border-terminal-border overflow-hidden cursor-pointer">
        <img src={src} alt="chart" className="w-full h-full object-cover" />
      </div>
      <div className="absolute right-0 top-full mt-1 z-50 hidden group-hover:block pointer-events-none"
        style={{ width: 480 }}>
        <div className="bg-[#111] border border-terminal-border rounded p-1 shadow-2xl">
          <img src={src} alt="chart" className="w-full h-auto rounded" style={{ maxHeight: 340, objectFit: 'contain' }} />
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function TradeJournalPage() {
  const filters = useOutletContext();

  const [trades,      setTrades]      = useState([]);
  const [total,       setTotal]       = useState(0);
  const [page,        setPage]        = useState(1);
  const [loading,     setLoading]     = useState(true);
  const [selected,    setSelected]    = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [strategies,  setStrategies]  = useState([]);
  const [filterGrade, setFilterGrade] = useState('');
  const [filterReviewed, setFilterReviewed] = useState('');
  const [search,      setSearch]      = useState('');
  const [journalFrom, setJournalFrom] = useState('');
  const [sortCol,     setSortCol]     = useState('entry_datetime');
  const [sortDir,     setSortDir]     = useState('DESC');
  const [limit,       setLimit]       = useState(50);

  const [error,       setError]       = useState('');
  const [draft, setDraft] = useState({});
  const screenshotInputRef = useRef(null);

  // Key Setup modal state
  const [setupModal,  setSetupModal]  = useState(false);
  const [setupDraft,  setSetupDraft]  = useState({});
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupToast,  setSetupToast]  = useState(false);

  // Key Lesson modal state
  const [lessonModal,  setLessonModal]  = useState(false);
  const [lessonDraft,  setLessonDraft]  = useState({});
  const [lessonSaving, setLessonSaving] = useState(false);
  const [lessonToast,  setLessonToast]  = useState(false);
  const [mistakeTypes, setMistakeTypes] = useState([]);

  // Load strategies from settings
  // getSettings() already JSON-parses values, so s.strategies is already an array
  useEffect(() => {
    getSettings().then(s => {
      setStrategies(Array.isArray(s?.strategies) ? s.strategies : []);
    }).catch(() => {});
  }, []);

  // Load trades
  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'ASC' ? 'DESC' : 'ASC');
    else { setSortCol(col); setSortDir('DESC'); }
    setPage(1);
  };

  const loadTrades = useCallback(() => {
    setLoading(true);
    getJournalTrades({
      account:  filters.account !== 'All' ? filters.account : undefined,
      page,
      limit,
      grade:    filterGrade,
      reviewed: filterReviewed,
      search,
      dateFrom: journalFrom || undefined,
      sort:     sortCol,
      dir:      sortDir,
    }).then(data => {
      setTrades(data.trades || []);
      setTotal(data.total || 0);
      setLoading(false);
    }).catch(err => {
      console.error('Journal load error:', err);
      setError(err?.response?.data?.error || err.message || 'Failed to load trades');
      setLoading(false);
    });
  }, [filters.account, page, limit, filterGrade, filterReviewed, search, journalFrom, sortCol, sortDir]);

  useEffect(() => { loadTrades(); }, [loadTrades]);

  // Open a trade in the panel
  const openTrade = (trade) => {
    setSelected(trade);
    setDraft({
      grade:         trade.grade         || '',
      lessons:       trade.lessons       || '',
      strategy:      trade.strategy      || '',
      emotion:       trade.emotion       || '',
      rule_followed: trade.rule_followed,
      entry_quality: trade.entry_quality || null,
      exit_quality:  trade.exit_quality  || null,
      session:       trade.session       || '',
      screenshot:    trade.screenshot    || null,
      reviewed:      trade.reviewed      ? true : false,
    });
  };

  // Quick-toggle reviewed checkbox
  const handleToggleReviewed = async (trade, newVal) => {
    // Optimistic update
    setTrades(ts => ts.map(t => t.id === trade.id ? { ...t, reviewed: newVal ? 1 : 0 } : t));
    if (selected?.id === trade.id) {
      setSelected(s => ({ ...s, reviewed: newVal ? 1 : 0 }));
      setDraft(d => ({ ...d, reviewed: newVal }));
    }
    try {
      await toggleTradeReviewed(trade.id, newVal);
    } catch (e) {
      // Revert on error
      setTrades(ts => ts.map(t => t.id === trade.id ? { ...t, reviewed: trade.reviewed } : t));
    }
  };

  // Save full journal data
  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await saveJournalTrade(selected.id, { ...draft, reviewed: draft.reviewed ? 1 : 0 });
      setTrades(ts => ts.map(t => t.id === selected.id
        ? { ...t, ...draft, reviewed: draft.reviewed ? 1 : 0 }
        : t
      ));
      setSelected(s => ({ ...s, ...draft, reviewed: draft.reviewed ? 1 : 0 }));
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  // Screenshot upload
  const handleScreenshot = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => setDraft(d => ({ ...d, screenshot: e.target.result }));
    reader.readAsDataURL(file);
  };

  // Open "Save as Key Setup" modal pre-filled from the current trade
  const openSetupModal = () => {
    if (!selected) return;
    const dateStr = selected.entry_datetime
      ? new Date(selected.entry_datetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
      : '';
    setSetupDraft({
      name:       `${selected.symbol || ''} ${dateStr}`.trim(),
      symbol:     selected.symbol    || '',
      timeframe:  '',
      pattern:    '',
      tags:       [],
      screenshot: draft.screenshot   || selected.screenshot || null,
    });
    setSetupModal(true);
  };

  const handleSaveSetup = async () => {
    if (!setupDraft.name?.trim()) return;
    setSetupSaving(true);
    try {
      await createKeySetup({
        ...setupDraft,
        source_trade_id: selected.id,
        trade_data: {
          symbol:         selected.symbol,
          position:       selected.position,
          pnl:            selected.pnl,
          grade:          draft.grade || selected.grade,
          entry_datetime: selected.entry_datetime,
          exit_datetime:  selected.exit_datetime,
          lot_size:       selected.lot_size,
          status:         selected.status,
          strategy:       draft.strategy || selected.strategy,
        },
      });
      setSetupModal(false);
      setSetupToast(true);
      setTimeout(() => setSetupToast(false), 2500);
    } catch (e) {
      console.error(e);
    }
    setSetupSaving(false);
  };

  // ── Key Lesson modal ─────────────────────────────────────────────────────
  const openLessonModal = () => {
    if (!mistakeTypes.length) getMistakeTypes().then(setMistakeTypes).catch(() => {});
    const entryDate = selected.entry_datetime
      ? String(selected.entry_datetime).slice(0, 10)
      : '';
    setLessonDraft({
      title:         `${selected.symbol} ${selected.position} — ${entryDate}`,
      symbol:        selected.symbol || '',
      trade_date:    entryDate,
      pnl:           selected.pnl ?? '',
      mistake_types: [],
      what_happened: '',
      what_shouldve: '',
      notes:         draft.lessons || selected.lessons || '',
      screenshot:    draft.screenshot || selected.screenshot || null,
    });
    setLessonModal(true);
  };

  const handleSaveLesson = async () => {
    if (!lessonDraft.title?.trim()) return;
    setLessonSaving(true);
    try {
      await createKeyLesson({
        ...lessonDraft,
        pnl: lessonDraft.pnl !== '' ? parseFloat(lessonDraft.pnl) : null,
        source_trade_id: selected.trade_id || String(selected.id),
        trade_data: {
          symbol:         selected.symbol,
          position:       selected.position,
          pnl:            selected.pnl,
          grade:          draft.grade || selected.grade,
          entry_datetime: selected.entry_datetime,
          exit_datetime:  selected.exit_datetime,
          lot_size:       selected.lot_size,
          status:         selected.status,
          strategy:       draft.strategy || selected.strategy,
        },
      });
      setLessonModal(false);
      setLessonToast(true);
      setTimeout(() => setLessonToast(false), 2500);
    } catch (e) {
      console.error(e);
    }
    setLessonSaving(false);
  };

  const currentIdx = selected ? trades.findIndex(t => t.id === selected.id) : -1;
  const goPrev = () => { if (currentIdx > 0) openTrade(trades[currentIdx - 1]); };
  const goNext = () => { if (currentIdx < trades.length - 1) openTrade(trades[currentIdx + 1]); };

  const totalPages   = Math.ceil(total / limit);
  const reviewedCount = trades.filter(t => t.reviewed).length;

  return (
    <div className="flex h-full overflow-hidden relative">

      {/* ── LEFT: Trade list ────────────────────────────────────────────────── */}
      <div className={`flex flex-col flex-shrink-0 border-r border-terminal-border transition-all ${selected ? 'w-[480px]' : 'flex-1'}`}>

        {/* Header + filters */}
        <div className="p-4 border-b border-terminal-border space-y-3 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-base font-mono font-semibold text-terminal-text">Trade Journal</h1>
              <p className="text-[10px] font-mono text-terminal-muted mt-0.5">
                {reviewedCount} of {total} trades reviewed
              </p>
            </div>
            <div className="w-32 h-1.5 bg-terminal-border rounded-full overflow-hidden">
              <div className="h-full bg-terminal-green rounded-full transition-all"
                style={{ width: total > 0 ? `${(reviewedCount / total) * 100}%` : '0%' }} />
            </div>
          </div>

          {/* Filters row */}
          <div className="flex gap-2 flex-wrap items-center">
            <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search symbol / strategy…"
              className="input-field text-xs flex-1 min-w-[120px]" />

            {/* Journal start date */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-terminal-muted whitespace-nowrap">From</span>
              <input
                type="date"
                value={journalFrom}
                onChange={e => { setJournalFrom(e.target.value); setPage(1); }}
                className="input-field text-xs py-1.5 w-36"
              />
              {journalFrom && (
                <button onClick={() => { setJournalFrom(''); setPage(1); }}
                  className="text-terminal-dim hover:text-terminal-red text-xs font-mono">✕</button>
              )}
            </div>

            <select value={filterGrade} onChange={e => { setFilterGrade(e.target.value); setPage(1); }}
              className="input-field text-xs w-24">
              <option value="">All grades</option>
              {GRADES.map(g => <option key={g} value={g}>Grade {g}</option>)}
            </select>

            <select value={filterReviewed} onChange={e => { setFilterReviewed(e.target.value); setPage(1); }}
              className="input-field text-xs w-32">
              <option value="">All trades</option>
              <option value="no">☐ Not reviewed</option>
              <option value="yes">☑ Reviewed</option>
            </select>

            <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
              className="input-field text-xs w-20">
              <option value={50}>50 / pg</option>
              <option value={100}>100 / pg</option>
              <option value={200}>200 / pg</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {error ? (
            <div className="m-4 p-3 bg-red-950 border border-red-900 rounded text-xs font-mono text-red-400">
              ⚠ {error}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-32 text-terminal-muted font-mono text-sm animate-pulse">Loading…</div>
          ) : trades.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-terminal-dim font-mono text-sm">
              <span>No trades found</span>
              {!journalFrom && total === 0 && (
                <span className="text-xs text-terminal-dim">Import your EightCap file first via the Import tab</span>
              )}
              {journalFrom && (
                <button onClick={() => setJournalFrom('')} className="text-xs text-terminal-green hover:underline">
                  Clear date filter to see all trades
                </button>
              )}
            </div>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead className="bg-terminal-surface border-b border-terminal-border sticky top-0">
                <tr>
                  <th className="table-header text-center w-8">✓</th>
                  {[
                    { label: 'Date',     col: 'entry_datetime' },
                    { label: 'Symbol',   col: 'symbol' },
                    { label: 'Side',     col: null },
                    { label: 'Strategy', col: 'strategy' },
                    { label: 'P&L',      col: 'pnl', right: true },
                    { label: 'Grade',    col: 'grade', center: true },
                    { label: 'Emotion',  col: 'emotion' },
                    { label: 'Notes',    col: null },
                    { label: '📷',       col: null, center: true },
                  ].map(({ label, col, right, center }) => (
                    <th key={label}
                      onClick={col ? () => handleSort(col) : undefined}
                      className={`table-header ${col ? 'cursor-pointer hover:text-terminal-text select-none' : ''} ${right ? 'text-right' : center ? 'text-center' : 'text-left'}`}>
                      <div className={`flex items-center gap-1 ${right ? 'justify-end' : center ? 'justify-center' : ''}`}>
                        {label}
                        {col && <SortIcon col={col} sortCol={sortCol} sortDir={sortDir} />}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map(t => {
                  const isOpen = selected?.id === t.id;
                  return (
                    <tr key={t.id}
                      onClick={() => openTrade(t)}
                      className={`border-b border-terminal-border/40 cursor-pointer transition-colors ${
                        isOpen ? 'bg-terminal-green/10 border-l-2 border-l-terminal-green' : 'hover:bg-terminal-hover/40'
                      }`}
                    >
                      <td className="table-cell text-center">
                        <div className="flex justify-center">
                          <ReviewedBox
                            checked={!!t.reviewed}
                            onChange={(val) => handleToggleReviewed(t, val)}
                          />
                        </div>
                      </td>
                      <td className="table-cell text-terminal-muted">{fmt(t.entry_datetime)}</td>
                      <td className="table-cell font-semibold text-terminal-text">{t.symbol}</td>
                      <td className={`table-cell ${t.position === 'Long' ? 'text-terminal-green' : 'text-terminal-red'}`}>
                        {t.position === 'Long' ? '↑ L' : '↓ S'}
                      </td>
                      <td className="table-cell text-terminal-muted text-[10px]">
                        {t.strategy || <span className="text-terminal-border">—</span>}
                      </td>
                      <td className={`table-cell text-right font-semibold ${t.pnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                        {fmtPnl(t.pnl)}
                      </td>
                      <td className="table-cell text-center">
                        {t.grade ? (
                          <span className="font-bold text-sm" style={{ color: GRADE_COLOR[t.grade] }}>{t.grade}</span>
                        ) : <span className="text-terminal-border">—</span>}
                      </td>
                      <td className="table-cell">
                        {t.emotion ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border"
                            style={{ color: EMOTION_COLOR[t.emotion] || '#6b7280', borderColor: EMOTION_COLOR[t.emotion] || '#6b7280', opacity: 0.85 }}>
                            {t.emotion}
                          </span>
                        ) : <span className="text-terminal-border">—</span>}
                      </td>
                      <td className="table-cell"><NotePreview text={t.lessons} /></td>
                      <td className="table-cell text-center">
                        <ScreenshotThumb src={t.screenshot} />
                        {!t.screenshot && <span className="text-terminal-border">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination — always visible so size selector is accessible */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-terminal-border flex-shrink-0">
          <span className="text-[10px] font-mono text-terminal-muted">
            {total > 0
              ? `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total}`
              : `${total} trades`}
          </span>
          <div className="flex items-center gap-1.5">
            <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
              className="input-field text-[10px] py-0.5 w-18">
              <option value={50}>50 / pg</option>
              <option value={100}>100 / pg</option>
              <option value={200}>200 / pg</option>
            </select>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="btn-ghost p-1 disabled:opacity-30"><ChevronLeft className="w-3.5 h-3.5" /></button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="btn-ghost p-1 disabled:opacity-30"><ChevronRight className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      </div>

      {/* ── Key Setup saved toast ────────────────────────────────────────────── */}
      {setupToast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-terminal-amber text-black text-xs font-mono font-semibold rounded shadow-lg pointer-events-none">
          Saved to Key Setups ✓ — view it in the Key Setups tab
        </div>
      )}

      {/* ── Key Lesson saved toast ───────────────────────────────────────────── */}
      {lessonToast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-terminal-red text-white text-xs font-mono font-semibold rounded shadow-lg pointer-events-none">
          Saved to Key Lessons ✓ — view it in the Key Lessons tab
        </div>
      )}

      {/* ── Log as Key Lesson modal ──────────────────────────────────────────── */}
      {lessonModal && (
        <div className="absolute inset-0 bg-black/60 z-40 flex items-center justify-center">
          <div className="bg-terminal-surface border border-terminal-border rounded-lg w-[520px] max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-terminal-border sticky top-0 bg-terminal-surface z-10">
              <div className="flex items-center gap-2">
                <BookMarked className="w-4 h-4 text-terminal-red" />
                <span className="text-sm font-mono font-semibold text-terminal-text">Log as Key Lesson</span>
              </div>
              <button onClick={() => setLessonModal(false)} className="btn-ghost p-1"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-5 space-y-4">
              {/* Title */}
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Lesson Title *</label>
                <input value={lessonDraft.title} onChange={e => setLessonDraft(d => ({ ...d, title: e.target.value }))}
                  className="input-field text-sm w-full" autoFocus />
              </div>

              {/* Symbol + Date + P&L */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Symbol</label>
                  <input value={lessonDraft.symbol} onChange={e => setLessonDraft(d => ({ ...d, symbol: e.target.value.toUpperCase() }))}
                    className="input-field text-sm w-full" />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Trade Date</label>
                  <input type="date" value={lessonDraft.trade_date} onChange={e => setLessonDraft(d => ({ ...d, trade_date: e.target.value }))}
                    className="input-field text-sm w-full" />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">P&L Impact</label>
                  <input type="number" step="0.01" value={lessonDraft.pnl} onChange={e => setLessonDraft(d => ({ ...d, pnl: e.target.value }))}
                    className="input-field text-sm w-full" />
                </div>
              </div>

              {/* Mistake Types */}
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-2">
                  Mistake Types <span className="text-terminal-dim font-normal">(select all that apply)</span>
                </label>
                {mistakeTypes.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {mistakeTypes.map(mt => {
                      const on = lessonDraft.mistake_types?.includes(mt.id);
                      return (
                        <button key={mt.id} type="button"
                          onClick={() => setLessonDraft(d => ({
                            ...d,
                            mistake_types: on
                              ? d.mistake_types.filter(x => x !== mt.id)
                              : [...(d.mistake_types || []), mt.id],
                          }))}
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
                ) : (
                  <div className="text-xs font-mono text-terminal-dim">No mistake types yet — add them in Settings.</div>
                )}
              </div>

              {/* What happened */}
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">What Happened</label>
                <textarea value={lessonDraft.what_happened}
                  onChange={e => setLessonDraft(d => ({ ...d, what_happened: e.target.value }))}
                  rows={3} placeholder="What did you actually do wrong on this trade?"
                  className="input-field text-sm w-full resize-none leading-relaxed" />
              </div>

              {/* What should've happened */}
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">What Should Have Happened</label>
                <textarea value={lessonDraft.what_shouldve}
                  onChange={e => setLessonDraft(d => ({ ...d, what_shouldve: e.target.value }))}
                  rows={3} placeholder="Describe the correct execution…"
                  className="input-field text-sm w-full resize-none leading-relaxed" />
              </div>

              {/* Notes */}
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Notes</label>
                <textarea value={lessonDraft.notes}
                  onChange={e => setLessonDraft(d => ({ ...d, notes: e.target.value }))}
                  rows={2} placeholder="Any additional context…"
                  className="input-field text-sm w-full resize-none" />
              </div>

              {/* Screenshot preview */}
              {lessonDraft.screenshot && (
                <div className="rounded border border-terminal-border overflow-hidden">
                  <img src={lessonDraft.screenshot} alt="chart" className="w-full max-h-36 object-cover" />
                  <div className="px-3 py-1.5 text-[10px] font-mono text-terminal-dim border-t border-terminal-border">
                    Screenshot from journal attached ✓
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-5 py-3.5 border-t border-terminal-border sticky bottom-0 bg-terminal-surface">
              <button onClick={() => setLessonModal(false)} className="btn-ghost text-xs px-3 py-1.5">Cancel</button>
              <button
                onClick={handleSaveLesson}
                disabled={lessonSaving || !lessonDraft.title?.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-terminal-red border border-red-700 text-white text-xs font-mono font-semibold hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                <BookMarked className="w-3.5 h-3.5" />
                {lessonSaving ? 'Saving…' : 'Save to Key Lessons'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save as Key Setup modal ───────────────────────────────────────────── */}
      {setupModal && (
        <div className="absolute inset-0 bg-black/60 z-40 flex items-center justify-center">
          <div className="bg-terminal-surface border border-terminal-border rounded-lg w-[480px] shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-terminal-border">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-terminal-amber" />
                <span className="text-sm font-mono font-semibold text-terminal-text">Save as Key Setup</span>
              </div>
              <button onClick={() => setSetupModal(false)} className="btn-ghost p-1">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Name */}
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
                  Setup Name <span className="text-terminal-red">*</span>
                </label>
                <input
                  value={setupDraft.name}
                  onChange={e => setSetupDraft(d => ({ ...d, name: e.target.value }))}
                  placeholder="e.g. XAUUSD London Break"
                  className="input-field text-sm w-full"
                  autoFocus
                />
              </div>

              {/* Symbol + Timeframe */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Symbol</label>
                  <input
                    value={setupDraft.symbol}
                    onChange={e => setSetupDraft(d => ({ ...d, symbol: e.target.value.toUpperCase() }))}
                    className="input-field text-sm w-full"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Timeframe</label>
                  <select
                    value={setupDraft.timeframe}
                    onChange={e => setSetupDraft(d => ({ ...d, timeframe: e.target.value }))}
                    className="select-field text-sm w-full"
                  >
                    <option value="">— Any —</option>
                    {['1M','3M','5M','15M','30M','1H','4H','1D','1W'].map(tf => (
                      <option key={tf} value={tf}>{tf}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Pattern description */}
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
                  What Did You See? (Pattern Description)
                </label>
                <textarea
                  value={setupDraft.pattern}
                  onChange={e => setSetupDraft(d => ({ ...d, pattern: e.target.value }))}
                  rows={4}
                  placeholder="Describe the structure, trigger, confluence, and what happened on this trade…"
                  className="input-field text-sm w-full resize-none leading-relaxed"
                />
              </div>

              {/* Tags */}
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Tags (comma-separated)</label>
                <input
                  value={setupDraft.tags?.join(', ')}
                  onChange={e => setSetupDraft(d => ({
                    ...d,
                    tags: e.target.value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
                  }))}
                  placeholder="breakout, london, gold, morning"
                  className="input-field text-sm w-full"
                />
              </div>

              {/* Screenshot preview */}
              {setupDraft.screenshot && (
                <div className="rounded border border-terminal-border overflow-hidden">
                  <img src={setupDraft.screenshot} alt="chart" className="w-full max-h-36 object-cover" />
                  <div className="px-3 py-1.5 text-[10px] font-mono text-terminal-dim border-t border-terminal-border">
                    Screenshot from journal will be attached ✓
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-3.5 border-t border-terminal-border">
              <button onClick={() => setSetupModal(false)} className="btn-ghost text-xs px-3 py-1.5">
                Cancel
              </button>
              <button
                onClick={handleSaveSetup}
                disabled={setupSaving || !setupDraft.name?.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded bg-terminal-amber text-black text-xs font-mono font-semibold hover:bg-terminal-amber/90 transition-colors disabled:opacity-50"
              >
                <Layers className="w-3.5 h-3.5" />
                {setupSaving ? 'Saving…' : 'Save to Key Setups'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RIGHT: Review panel ──────────────────────────────────────────────── */}
      {selected && (
        <div className="flex-1 flex flex-col overflow-hidden border-l border-terminal-border min-w-[360px]">

          {/* Panel header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-terminal-border flex-shrink-0 bg-terminal-surface">
            <div className="flex items-center gap-3">
              <div className="flex gap-1">
                <button onClick={goPrev} disabled={currentIdx <= 0} className="btn-ghost p-1 disabled:opacity-30">
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button onClick={goNext} disabled={currentIdx >= trades.length - 1} className="btn-ghost p-1 disabled:opacity-30">
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
              <div>
                <span className="text-sm font-mono font-semibold text-terminal-text">{selected.symbol}</span>
                <span className={`ml-2 text-xs font-mono ${selected.position === 'Long' ? 'text-terminal-green' : 'text-terminal-red'}`}>
                  {selected.position}
                </span>
                <span className="ml-2 text-xs font-mono text-terminal-muted">{fmt(selected.entry_datetime)}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-sm font-mono font-bold ${selected.pnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                {fmtPnl(selected.pnl)}
              </span>
              <button
                onClick={openLessonModal}
                title="Log this trade as a Key Lesson (mistake to avoid)"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-red/40 text-terminal-red text-xs font-mono hover:bg-red-950/30 transition-colors"
              >
                <BookMarked className="w-3.5 h-3.5" />
                Log Lesson
              </button>
              <button
                onClick={openSetupModal}
                title="Save this trade pattern to Key Setups"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-amber/40 text-terminal-amber text-xs font-mono hover:bg-amber-950/30 transition-colors"
              >
                <Layers className="w-3.5 h-3.5" />
                Key Setup
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-terminal-green text-black text-xs font-mono font-semibold hover:bg-terminal-green/90 transition-colors disabled:opacity-50">
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setSelected(null)} className="btn-ghost p-1.5">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Trade stats bar */}
          <div className="flex items-center gap-4 px-5 py-2 border-b border-terminal-border/50 bg-terminal-surface/50 flex-shrink-0">
            {[
              ['Entry',    selected.entry_datetime ? new Date(selected.entry_datetime).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—'],
              ['Exit',     selected.exit_datetime  ? new Date(selected.exit_datetime).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})  : '—'],
              ['Lots',     selected.lot_size ?? '—'],
              ['Market',   selected.market  ?? '—'],
              ['Duration', selected.duration ?? '—'],
            ].map(([l, v]) => (
              <div key={l} className="text-center">
                <div className="text-[9px] font-mono text-terminal-dim uppercase">{l}</div>
                <div className="text-[11px] font-mono text-terminal-text">{v}</div>
              </div>
            ))}
          </div>

          {/* Review fields — scrollable */}
          <div className="flex-1 overflow-auto p-5 space-y-5">

            {/* Reviewed toggle at top of panel */}
            <div className="flex items-center gap-3 pb-1 border-b border-terminal-border/40">
              <ReviewedBox
                checked={!!draft.reviewed}
                onChange={val => setDraft(d => ({ ...d, reviewed: val }))}
              />
              <span className="text-xs font-mono text-terminal-muted">
                {draft.reviewed ? 'Marked as reviewed' : 'Mark as reviewed'}
              </span>
            </div>

            {/* Grade + Strategy + Session */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Grade</label>
                <div className="flex gap-1.5">
                  {GRADES.map(g => (
                    <button key={g} onClick={() => setDraft(d => ({ ...d, grade: d.grade === g ? '' : g }))}
                      className={`w-9 h-9 rounded font-mono font-bold text-sm transition-colors border ${
                        draft.grade === g
                          ? 'border-transparent text-black'
                          : 'border-terminal-border text-terminal-dim hover:border-terminal-muted'
                      }`}
                      style={draft.grade === g ? { backgroundColor: GRADE_COLOR[g] } : {}}>
                      {g}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Strategy</label>
                <select value={draft.strategy} onChange={e => setDraft(d => ({ ...d, strategy: e.target.value }))}
                  className="input-field text-sm w-full">
                  <option value="">— Select —</option>
                  {strategies.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Session</label>
                <select value={draft.session} onChange={e => setDraft(d => ({ ...d, session: e.target.value }))}
                  className="input-field text-sm w-full">
                  <option value="">— Select —</option>
                  {SESSIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* Emotion + Rule followed */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Emotional State</label>
                <div className="flex flex-wrap gap-1.5">
                  {EMOTIONS.map(e => (
                    <button key={e} onClick={() => setDraft(d => ({ ...d, emotion: d.emotion === e ? '' : e }))}
                      className={`px-2 py-1 rounded-full text-[10px] font-mono transition-colors border ${
                        draft.emotion === e ? 'border-transparent text-black font-semibold' : 'border-terminal-border text-terminal-dim hover:border-terminal-muted'
                      }`}
                      style={draft.emotion === e ? { backgroundColor: EMOTION_COLOR[e] || '#6b7280' } : {}}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Followed Trading Plan?</label>
                <div className="flex gap-2 mt-1">
                  {[{ val: 1, label: 'Yes', icon: CheckCircle, color: 'text-terminal-green border-terminal-green bg-terminal-green/10' },
                    { val: 0, label: 'No',  icon: XCircle,     color: 'text-terminal-red border-terminal-red bg-terminal-red/10'   }].map(({ val, label, icon: Icon, color }) => (
                    <button key={val}
                      onClick={() => setDraft(d => ({ ...d, rule_followed: d.rule_followed === val ? null : val }))}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded border text-xs font-mono transition-colors ${
                        draft.rule_followed === val ? color : 'border-terminal-border text-terminal-dim hover:border-terminal-muted'
                      }`}>
                      <Icon className="w-3.5 h-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Entry / exit quality */}
            <div className="flex gap-8">
              <StarRating value={draft.entry_quality} onChange={v => setDraft(d => ({ ...d, entry_quality: v }))} label="Entry Quality" />
              <StarRating value={draft.exit_quality}  onChange={v => setDraft(d => ({ ...d, exit_quality:  v }))} label="Exit Quality" />
            </div>

            {/* Notes */}
            <div>
              <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Notes / Lessons</label>
              <textarea value={draft.lessons} onChange={e => setDraft(d => ({ ...d, lessons: e.target.value }))}
                rows={5}
                placeholder="What happened on this trade? What would you do differently? Key lesson…"
                className="input-field text-sm w-full resize-none leading-relaxed" />
            </div>

            {/* Screenshot */}
            <div>
              <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Chart Screenshot</label>
              {draft.screenshot ? (
                <div className="relative group">
                  <img src={draft.screenshot} alt="chart" className="w-full rounded border border-terminal-border object-contain"
                    style={{ maxHeight: 280 }} />
                  <button
                    onClick={() => setDraft(d => ({ ...d, screenshot: null }))}
                    className="absolute top-2 right-2 p-1.5 rounded bg-black/70 text-terminal-red opacity-0 group-hover:opacity-100 transition-opacity border border-terminal-red/40">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => screenshotInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-3 w-full rounded border border-dashed border-terminal-border text-terminal-muted hover:border-terminal-green hover:text-terminal-green transition-colors text-xs font-mono">
                  <Camera className="w-4 h-4" />
                  Click to attach a chart screenshot — or drag and drop
                </button>
              )}
              <input ref={screenshotInputRef} type="file" accept="image/*" className="hidden"
                onChange={e => handleScreenshot(e.target.files[0])} />
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
