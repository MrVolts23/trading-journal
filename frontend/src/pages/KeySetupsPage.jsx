import { useState, useEffect, useRef } from 'react';
import { Layers, Plus, Download, Upload, X, Save, Trash2, Camera, Tag, Video } from 'lucide-react';
import { getKeySetups, createKeySetup, updateKeySetup, deleteKeySetup, importKeySetups } from '../lib/api';

const TIMEFRAMES = ['1M', '3M', '5M', '15M', '30M', '1H', '4H', '1D', '1W'];

function fmtDate(dt) {
  if (!dt) return '';
  return new Date(dt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
function fmtPnl(n) {
  if (n == null) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// ── Setup Card ────────────────────────────────────────────────────────────────
function SetupCard({ setup, isActive, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`relative rounded-lg border cursor-pointer transition-all overflow-hidden ${
        isActive
          ? 'border-terminal-green bg-terminal-green/5'
          : 'border-terminal-border bg-terminal-surface hover:border-terminal-dim hover:bg-terminal-hover/30'
      }`}
    >
      {/* Screenshot strip */}
      {setup.screenshot && (
        <div className="w-full h-28 overflow-hidden border-b border-terminal-border/60">
          <img src={setup.screenshot} alt="chart" className="w-full h-full object-cover" />
        </div>
      )}

      <div className="p-3 space-y-2">
        {/* Name */}
        <div className="font-mono font-semibold text-sm text-terminal-text leading-tight">{setup.name}</div>

        {/* Symbol + Timeframe chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {setup.symbol && (
            <span className="px-1.5 py-0.5 rounded bg-terminal-green/10 border border-terminal-green/30 text-[10px] font-mono text-terminal-green font-semibold">
              {setup.symbol}
            </span>
          )}
          {setup.timeframe && (
            <span className="px-1.5 py-0.5 rounded bg-terminal-amber/10 border border-terminal-amber/30 text-[10px] font-mono text-terminal-amber">
              {setup.timeframe}
            </span>
          )}
          {setup.source_trade_id && (
            <span className="px-1.5 py-0.5 rounded bg-blue-900/30 border border-blue-700/30 text-[10px] font-mono text-blue-400">
              from journal
            </span>
          )}
        </div>

        {/* Pattern excerpt */}
        {setup.pattern && (
          <p className="text-[11px] font-mono text-terminal-muted leading-relaxed line-clamp-2">
            {setup.pattern}
          </p>
        )}

        {/* Tags */}
        {setup.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {setup.tags.slice(0, 4).map(tag => (
              <span key={tag} className="px-1.5 py-0.5 rounded-full bg-terminal-border/40 text-[9px] font-mono text-terminal-dim">
                #{tag}
              </span>
            ))}
            {setup.tags.length > 4 && (
              <span className="text-[9px] font-mono text-terminal-dim">+{setup.tags.length - 4}</span>
            )}
          </div>
        )}

        {/* Video link */}
        {setup.video_url && (
          <a
            href={setup.video_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-900/30 border border-blue-700/30 text-[10px] font-mono text-blue-400 hover:text-blue-300 transition-colors"
          >
            <Video className="w-2.5 h-2.5" />
            Training Video
          </a>
        )}

        {/* Date */}
        <div className="text-[9px] font-mono text-terminal-dim pt-0.5">{fmtDate(setup.created_at)}</div>
      </div>
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────
function EmptyState({ onNew }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
      <div className="w-16 h-16 rounded-full border-2 border-dashed border-terminal-border flex items-center justify-center">
        <Layers className="w-7 h-7 text-terminal-dim" />
      </div>
      <div>
        <div className="text-sm font-mono font-semibold text-terminal-text mb-2">No Key Setups Yet</div>
        <div className="text-xs font-mono text-terminal-muted leading-relaxed max-w-xs">
          Open a trade in the <span className="text-terminal-green">Trade Journal</span>, review it,
          then click <span className="text-terminal-amber font-semibold">Save as Key Setup</span> to
          document the pattern. Share your setups as a JSON file with your trading group.
        </div>
      </div>
      <button onClick={onNew} className="btn-primary flex items-center gap-2">
        <Plus className="w-4 h-4" />
        Create Manually
      </button>
    </div>
  );
}

// ── Tag Input ─────────────────────────────────────────────────────────────────
function TagInput({ tags, onChange }) {
  const [input, setInput] = useState('');

  const addTag = (raw) => {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div>
      <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
        Tags
      </label>
      <div className="flex flex-wrap gap-1.5 p-2 rounded border border-terminal-border bg-terminal-bg min-h-[38px] cursor-text"
        onClick={e => e.currentTarget.querySelector('input')?.focus()}>
        {tags.map(tag => (
          <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-border/50 text-[10px] font-mono text-terminal-muted">
            #{tag}
            <button onClick={() => onChange(tags.filter(t => t !== tag))}
              className="hover:text-terminal-red transition-colors leading-none">×</button>
          </span>
        ))}
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => input.trim() && addTag(input)}
          placeholder={tags.length === 0 ? 'Type a tag and press Enter…' : ''}
          className="bg-transparent text-[10px] font-mono text-terminal-text outline-none flex-1 min-w-[120px] placeholder:text-terminal-dim"
        />
      </div>
      <div className="text-[9px] font-mono text-terminal-dim mt-1">Press Enter or comma to add · Backspace to remove</div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function KeySetupsPage() {
  const [setups,   setSetups]   = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft,    setDraft]    = useState({});
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [isNew,    setIsNew]    = useState(false);
  const [error,    setError]    = useState('');
  const [toast,    setToast]    = useState('');

  const screenshotRef = useRef(null);
  const importRef     = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const loadSetups = () => {
    setLoading(true);
    getKeySetups()
      .then(data => { setSetups(data); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  useEffect(() => { loadSetups(); }, []);

  const blankDraft = () => ({
    name: '', symbol: '', timeframe: '', pattern: '', tags: [], notes: '', screenshot: null, video_url: '',
  });

  const openSetup = (setup) => {
    setSelected(setup);
    setIsNew(false);
    setDraft({
      name:       setup.name       || '',
      symbol:     setup.symbol     || '',
      timeframe:  setup.timeframe  || '',
      pattern:    setup.pattern    || '',
      tags:       setup.tags       || [],
      notes:      setup.notes      || '',
      screenshot: setup.screenshot || null,
      video_url:  setup.video_url  || '',
    });
  };

  const handleNew = () => {
    setSelected({ id: null });
    setIsNew(true);
    setDraft(blankDraft());
  };

  const handleSave = async () => {
    if (!draft.name.trim()) { setError('Setup name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const payload = { ...draft };
      if (isNew) {
        const created = await createKeySetup(payload);
        setSetups(ss => [created, ...ss]);
        setSelected(created);
        setIsNew(false);
        showToast('Setup created ✓');
      } else {
        const updated = await updateKeySetup(selected.id, payload);
        setSetups(ss => ss.map(s => s.id === updated.id ? updated : s));
        setSelected(updated);
        showToast('Saved ✓');
      }
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!selected?.id) return;
    if (!window.confirm('Delete this key setup?')) return;
    try {
      await deleteKeySetup(selected.id);
      setSetups(ss => ss.filter(s => s.id !== selected.id));
      setSelected(null);
    } catch (e) {
      setError(e.message);
    }
  };

  const exportSetups = (list, filename) => {
    const payload = list.map(s => {
      const { id, created_at, updated_at, ...rest } = s;
      return rest;
    });
    const json = JSON.stringify({ version: 1, setups: payload }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportAll = () => {
    exportSetups(setups, `key-setups-${new Date().toISOString().slice(0, 10)}.json`);
  };

  const handleExportOne = () => {
    if (!selected?.id) return;
    const s = setups.find(s => s.id === selected.id);
    if (!s) return;
    const slug = (s.name || 'setup').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    exportSetups([s], `key-setup-${slug}.json`);
  };

  const handleImportFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const arr  = Array.isArray(data) ? data : (data.setups || []);
      if (!arr.length) throw new Error('No setups found in file');
      const result = await importKeySetups(arr);
      loadSetups();
      showToast(`Imported ${result.inserted} setup${result.inserted === 1 ? '' : 's'} ✓`);
    } catch (e) {
      setError(`Import failed: ${e.message}`);
    }
  };

  const handleScreenshot = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => setDraft(d => ({ ...d, screenshot: e.target.result }));
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex h-full overflow-hidden relative">

      {/* Toast */}
      {toast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-terminal-green text-black text-xs font-mono font-semibold rounded shadow-lg pointer-events-none animate-pulse">
          {toast}
        </div>
      )}

      {/* ── LEFT: List + Grid ─────────────────────────────────────────────── */}
      <div className={`flex flex-col flex-shrink-0 border-r border-terminal-border ${selected ? 'w-[480px]' : 'flex-1'}`}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-terminal-border flex-shrink-0 bg-terminal-surface">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-terminal-green" />
            <h1 className="text-sm font-mono font-semibold text-terminal-text">Key Setups</h1>
            {!loading && (
              <span className="text-[10px] font-mono text-terminal-dim">
                {setups.length} setup{setups.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Export all */}
            <button
              onClick={handleExportAll}
              disabled={setups.length === 0}
              title="Export all setups as JSON"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-terminal-border text-[10px] font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim transition-colors disabled:opacity-30"
            >
              <Download className="w-3 h-3" />
              Export All
            </button>
            {/* Import */}
            <label
              title="Import setups from a friend's JSON file"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-terminal-border text-[10px] font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim transition-colors cursor-pointer"
            >
              <Upload className="w-3 h-3" />
              Import
              <input ref={importRef} type="file" accept=".json" className="hidden"
                onChange={e => { if (e.target.files[0]) handleImportFile(e.target.files[0]); e.target.value = ''; }} />
            </label>
            {/* New */}
            <button onClick={handleNew} className="btn-primary flex items-center gap-1.5 py-1.5 px-3 text-xs">
              <Plus className="w-3.5 h-3.5" />
              New Setup
            </button>
          </div>
        </div>

        {/* Error bar */}
        {error && (
          <div className="mx-4 mt-3 p-2.5 bg-red-950 border border-red-900 rounded text-[11px] font-mono text-red-400 flex items-center justify-between">
            ⚠ {error}
            <button onClick={() => setError('')} className="ml-2 text-red-600 hover:text-red-400">×</button>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center h-32 text-terminal-muted font-mono text-sm animate-pulse">
            Loading…
          </div>
        ) : setups.length === 0 ? (
          <EmptyState onNew={handleNew} />
        ) : (
          <div className={`flex-1 overflow-auto p-4 grid gap-3 ${selected ? 'grid-cols-1' : 'grid-cols-2 xl:grid-cols-3'}`}>
            {setups.map(s => (
              <SetupCard
                key={s.id}
                setup={s}
                isActive={selected?.id === s.id}
                onClick={() => openSetup(s)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── RIGHT: Edit panel ─────────────────────────────────────────────── */}
      {selected && (
        <div className="flex-1 flex flex-col overflow-hidden min-w-[380px]">

          {/* Panel header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-terminal-border flex-shrink-0 bg-terminal-surface">
            <span className="text-sm font-mono font-semibold text-terminal-text truncate max-w-[260px]">
              {isNew ? 'New Key Setup' : (draft.name || 'Untitled')}
            </span>
            <div className="flex items-center gap-2">
              {!isNew && (
                <>
                  <button
                    onClick={handleExportOne}
                    title="Export this setup as JSON"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-terminal-border text-[10px] font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    Export
                  </button>
                  <button
                    onClick={handleDelete}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-terminal-red/40 text-[10px] font-mono text-terminal-red hover:bg-red-950/30 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete
                  </button>
                </>
              )}
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-terminal-green text-black text-xs font-mono font-semibold hover:bg-terminal-green/90 transition-colors disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setSelected(null)} className="btn-ghost p-1.5">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Fields */}
          <div className="flex-1 overflow-auto p-5 space-y-5">

            {/* Setup name */}
            <div>
              <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
                Setup Name <span className="text-terminal-red">*</span>
              </label>
              <input
                value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                placeholder="e.g. XAUUSD London Open Break"
                className="input-field text-sm w-full"
              />
            </div>

            {/* Symbol + Timeframe */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Symbol</label>
                <input
                  value={draft.symbol}
                  onChange={e => setDraft(d => ({ ...d, symbol: e.target.value.toUpperCase() }))}
                  placeholder="XAUUSD"
                  className="input-field text-sm w-full"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">Timeframe</label>
                <select
                  value={draft.timeframe}
                  onChange={e => setDraft(d => ({ ...d, timeframe: e.target.value }))}
                  className="select-field text-sm w-full"
                >
                  <option value="">— Any —</option>
                  {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
                </select>
              </div>
            </div>

            {/* Pattern description */}
            <div>
              <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
                Pattern / Setup Description
              </label>
              <textarea
                value={draft.pattern}
                onChange={e => setDraft(d => ({ ...d, pattern: e.target.value }))}
                rows={6}
                placeholder="Describe the pattern: what structure formed, what triggered the entry, what confluence existed, what happened…"
                className="input-field text-sm w-full resize-none leading-relaxed"
              />
            </div>

            {/* Tags */}
            <TagInput tags={draft.tags} onChange={tags => setDraft(d => ({ ...d, tags }))} />

            {/* Notes */}
            <div>
              <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
                Additional Notes
              </label>
              <textarea
                value={draft.notes}
                onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
                rows={3}
                placeholder="Risk management notes, ideal entry timing, pitfalls to avoid…"
                className="input-field text-sm w-full resize-none leading-relaxed"
              />
            </div>

            {/* Training Video Link */}
            <div>
              <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1.5">
                Training Video Link
              </label>
              <div className="flex gap-2">
                <input
                  value={draft.video_url}
                  onChange={e => setDraft(d => ({ ...d, video_url: e.target.value }))}
                  placeholder="Paste Google Drive or YouTube link…"
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
              <div className="text-[9px] font-mono text-terminal-dim mt-1">
                Included in exported JSON so trading friends can open the video directly.
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
                    onClick={() => setDraft(d => ({ ...d, screenshot: null }))}
                    className="absolute top-2 right-2 p-1.5 rounded bg-black/70 text-terminal-red opacity-0 group-hover:opacity-100 transition-opacity border border-terminal-red/40"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => screenshotRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-3 w-full rounded border border-dashed border-terminal-border text-terminal-muted hover:border-terminal-green hover:text-terminal-green transition-colors text-xs font-mono"
                >
                  <Camera className="w-4 h-4" />
                  Click to attach a chart screenshot
                </button>
              )}
              <input ref={screenshotRef} type="file" accept="image/*" className="hidden"
                onChange={e => handleScreenshot(e.target.files[0])} />
            </div>

            {/* Linked trade reference */}
            {selected?.trade_data && (
              <div className="rounded border border-terminal-border/60 bg-terminal-surface/50 p-4">
                <div className="text-[9px] font-mono text-terminal-dim uppercase tracking-widest mb-3">
                  Linked Trade
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    ['Symbol',  selected.trade_data.symbol],
                    ['Side',    selected.trade_data.position],
                    ['P&L',     fmtPnl(selected.trade_data.pnl)],
                    ['Grade',   selected.trade_data.grade || '—'],
                    ['Entry',   selected.trade_data.entry_datetime
                                  ? new Date(selected.trade_data.entry_datetime).toLocaleDateString()
                                  : '—'],
                    ['Status',  selected.trade_data.status || '—'],
                  ].map(([l, v]) => (
                    <div key={l}>
                      <div className="text-[9px] font-mono text-terminal-dim">{l}</div>
                      <div className={`text-[11px] font-mono font-semibold ${
                        l === 'P&L' ? (selected.trade_data.pnl >= 0 ? 'text-terminal-green' : 'text-terminal-red')
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
      )}
    </div>
  );
}
