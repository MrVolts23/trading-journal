import { useState, useRef, useCallback, useEffect } from 'react';
import { FlipHorizontal2, FlipVertical, Download, Upload, X, RotateCcw, Plus, Pencil, Check } from 'lucide-react';

// ── Persistence helpers ────────────────────────────────────────────────────────
const STORAGE_KEY = 'alchemy_tabs_v2';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.tabs && parsed.tabs.length > 0) return parsed;
    }
  } catch (_) {}
  return { tabs: [newTab('Tab 1')], activeId: null };
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {} // silently ignore if storage full
}

let _nextId = Date.now();
function genId() { return String(++_nextId); }

function newTab(title = 'New Tab') {
  return { id: genId(), title, imageSrc: null, flipH: false, flipV: false, fileName: '' };
}

// ── Single tab image panel ─────────────────────────────────────────────────────
function ImagePanel({ tab, onUpdate }) {
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  const canvasRef    = useRef(null);

  const loadFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const name = file.name.replace(/\.[^.]+$/, '');
    const reader = new FileReader();
    reader.onload = (e) => {
      onUpdate({ imageSrc: e.target.result, fileName: name, flipH: false, flipV: false });
    };
    reader.readAsDataURL(file);
  }, [onUpdate]);

  const onDragOver  = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);
  const onDrop      = (e) => { e.preventDefault(); setDragging(false); loadFile(e.dataTransfer.files[0]); };

  const exportJpg = useCallback(() => {
    if (!tab.imageSrc) return;
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.translate(tab.flipH ? img.naturalWidth : 0, tab.flipV ? img.naturalHeight : 0);
      ctx.scale(tab.flipH ? -1 : 1, tab.flipV ? -1 : 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
      const suffix = tab.flipH && tab.flipV ? '_flipped_both'
                   : tab.flipH              ? '_flipped_h'
                   : tab.flipV              ? '_flipped_v'
                   :                          '_original';
      const link = document.createElement('a');
      link.download = `${tab.fileName || 'alchemy'}${suffix}.jpg`;
      link.href = canvas.toDataURL('image/jpeg', 0.95);
      link.click();
    };
    img.src = tab.imageSrc;
  }, [tab]);

  const transform = [
    tab.flipH ? 'scaleX(-1)' : '',
    tab.flipV ? 'scaleY(-1)' : '',
  ].filter(Boolean).join(' ') || 'none';

  const hasFlip = tab.flipH || tab.flipV;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-terminal-border bg-terminal-surface flex-shrink-0">
        {/* Upload */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          Upload
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden"
          onChange={e => loadFile(e.target.files[0])} />

        <div className="w-px h-5 bg-terminal-border mx-1" />

        {/* Flip buttons */}
        <button onClick={() => onUpdate({ flipH: !tab.flipH })} disabled={!tab.imageSrc}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-mono transition-colors ${
            tab.flipH ? 'border-terminal-green text-terminal-green bg-terminal-green/10'
                      : 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-dim'
          } disabled:opacity-30 disabled:cursor-not-allowed`}>
          <FlipHorizontal2 className="w-3.5 h-3.5" /> Flip H
        </button>
        <button onClick={() => onUpdate({ flipV: !tab.flipV })} disabled={!tab.imageSrc}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-mono transition-colors ${
            tab.flipV ? 'border-terminal-green text-terminal-green bg-terminal-green/10'
                      : 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-dim'
          } disabled:opacity-30 disabled:cursor-not-allowed`}>
          <FlipVertical className="w-3.5 h-3.5" /> Flip V
        </button>
        <button onClick={() => onUpdate({ flipH: true, flipV: true })} disabled={!tab.imageSrc}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-mono transition-colors ${
            tab.flipH && tab.flipV ? 'border-terminal-green text-terminal-green bg-terminal-green/10'
                                   : 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-dim'
          } disabled:opacity-30 disabled:cursor-not-allowed`}>
          <FlipHorizontal2 className="w-3.5 h-3.5 rotate-45" /> Both
        </button>
        {hasFlip && (
          <button onClick={() => onUpdate({ flipH: false, flipV: false })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim transition-colors">
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>
        )}

        <div className="flex-1" />

        {tab.imageSrc && (
          <span className="text-[10px] font-mono text-terminal-dim mr-2">
            {!hasFlip && 'original'}
            {tab.flipH && !tab.flipV && 'flipped horizontal'}
            {tab.flipV && !tab.flipH && 'flipped vertical'}
            {tab.flipH && tab.flipV && 'flipped both axes'}
          </span>
        )}

        <button onClick={exportJpg} disabled={!tab.imageSrc}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-terminal-green text-black text-xs font-mono font-semibold hover:bg-terminal-green/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
          <Download className="w-3.5 h-3.5" /> Export JPG
        </button>

        {tab.imageSrc && (
          <button onClick={() => onUpdate({ imageSrc: null, flipH: false, flipV: false, fileName: '' })}
            className="p-1.5 rounded border border-terminal-border text-terminal-muted hover:text-terminal-red hover:border-terminal-red transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Image area */}
      <div
        className={`flex-1 flex items-center justify-center overflow-hidden relative transition-colors ${
          dragging ? 'bg-terminal-green/5 border-2 border-dashed border-terminal-green/50' : 'bg-terminal-bg'
        }`}
        onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      >
        {tab.imageSrc ? (
          <img src={tab.imageSrc} alt="chart"
            style={{ transform, transition: 'transform 0.15s ease', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <div className="flex flex-col items-center gap-4 cursor-pointer select-none"
            onClick={() => fileInputRef.current?.click()}>
            <div className={`w-20 h-20 rounded-full border-2 border-dashed flex items-center justify-center transition-colors ${
              dragging ? 'border-terminal-green text-terminal-green' : 'border-terminal-border text-terminal-dim'
            }`}>
              <Upload className="w-8 h-8" />
            </div>
            <div className="text-center">
              <div className="text-sm font-mono text-terminal-muted">Drop a chart screenshot here</div>
              <div className="text-xs font-mono text-terminal-dim mt-1">or click to browse — PNG, JPG, WebP</div>
            </div>
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}

// ── Tab bar item ───────────────────────────────────────────────────────────────
function TabItem({ tab, isActive, onSelect, onClose, onRename, canClose }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(tab.title);
  const inputRef = useRef(null);

  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);
  useEffect(() => { setDraft(tab.title); }, [tab.title]);

  const commit = () => {
    const t = draft.trim();
    onRename(t || tab.title);
    setEditing(false);
  };

  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-1.5 px-3 py-1.5 border-r border-terminal-border cursor-pointer flex-shrink-0 group transition-colors ${
        isActive
          ? 'bg-terminal-bg text-terminal-text border-b border-b-terminal-bg -mb-px'
          : 'bg-terminal-surface text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover'
      }`}
      style={{ minWidth: '100px', maxWidth: '180px' }}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(tab.title); setEditing(false); } }}
          onClick={e => e.stopPropagation()}
          className="flex-1 text-xs font-mono bg-transparent border-b border-terminal-green outline-none text-terminal-text min-w-0"
        />
      ) : (
        <span
          className="flex-1 text-xs font-mono truncate"
          onDoubleClick={e => { e.stopPropagation(); setEditing(true); }}
          title="Double-click to rename"
        >
          {tab.title}
          {tab.imageSrc && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-terminal-green inline-block align-middle" />}
        </span>
      )}
      {!editing && (
        <button
          onClick={e => { e.stopPropagation(); setEditing(true); }}
          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 text-terminal-dim hover:text-terminal-text"
          title="Rename tab"
        >
          <Pencil className="w-2.5 h-2.5" />
        </button>
      )}
      {canClose && !editing && (
        <button
          onClick={e => { e.stopPropagation(); onClose(); }}
          className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 text-terminal-dim hover:text-terminal-red"
          title="Close tab"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function AlchemyPage() {
  const initial = loadState();
  const [tabs,     setTabs]     = useState(initial.tabs);
  const [activeId, setActiveId] = useState(initial.activeId || initial.tabs[0]?.id || null);

  // Persist whenever tabs or activeId change
  useEffect(() => {
    saveState({ tabs, activeId });
  }, [tabs, activeId]);

  const activeTab = tabs.find(t => t.id === activeId) || tabs[0];

  const addTab = () => {
    const t = newTab(`Tab ${tabs.length + 1}`);
    setTabs(ts => [...ts, t]);
    setActiveId(t.id);
  };

  const closeTab = (id) => {
    setTabs(ts => {
      const remaining = ts.filter(t => t.id !== id);
      if (remaining.length === 0) {
        const t = newTab('Tab 1');
        setActiveId(t.id);
        return [t];
      }
      if (activeId === id) {
        const idx = ts.findIndex(t => t.id === id);
        setActiveId(remaining[Math.max(0, idx - 1)].id);
      }
      return remaining;
    });
  };

  const updateTab = (id, changes) => {
    setTabs(ts => ts.map(t => t.id === id ? { ...t, ...changes } : t));
  };

  const renameTab = (id, title) => {
    setTabs(ts => ts.map(t => t.id === id ? { ...t, title } : t));
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-terminal-bg">
      {/* ── Tab bar ── */}
      <div className="flex items-end border-b border-terminal-border bg-terminal-surface flex-shrink-0 overflow-x-auto">
        <div className="flex items-end flex-shrink-0">
          <div className="flex items-center gap-0 px-2 pt-1.5">
            <span className="text-[10px] font-mono font-semibold text-terminal-green tracking-widest uppercase mr-3 pb-1.5">Alchemy</span>
          </div>
          {tabs.map(tab => (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTab?.id}
              onSelect={() => setActiveId(tab.id)}
              onClose={() => closeTab(tab.id)}
              onRename={(title) => renameTab(tab.id, title)}
              canClose={tabs.length > 1}
            />
          ))}
          <button
            onClick={addTab}
            className="flex items-center gap-1 px-2.5 py-1.5 text-terminal-dim hover:text-terminal-text transition-colors flex-shrink-0 mb-px"
            title="New tab"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Active tab panel ── */}
      {activeTab && (
        <ImagePanel
          key={activeTab.id}
          tab={activeTab}
          onUpdate={(changes) => updateTab(activeTab.id, changes)}
        />
      )}
    </div>
  );
}
