import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard, TableProperties, Calendar, FileUp, Settings, TrendingUp, PiggyBank, FlaskConical,
  BookOpen, Layers, BookMarked, ShieldCheck, GitCompare, Wallet, Calculator, Folder,
  ChevronDown, ChevronRight, GripVertical, Pencil, Plus, RotateCcw, Copy, Check, X,
  Sparkles, Activity, GitBranch, Beaker,
  // page icon + icon palette for user-created groups
  Wrench, Hammer, Landmark, Banknote, Coins, Vault, BarChart3, LineChart, Target, Crosshair, Compass, Gauge, Briefcase, Zap, Brain, Rocket, LayoutGrid,
} from 'lucide-react';
import { getSettings } from '../../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// EDITABLE SIDEBAR (Mike, 2026-09-02)
// The sidebar is DATA: a saved layout of top-level items and one-level groups.
// In "Edit layout" mode Mike can drag to reorder, drop onto a group to nest, drop
// onto the bottom zone to un-nest, add/rename/delete groups, reset, and copy the
// layout JSON. When the arrangement is final we bake the JSON into DEFAULT_LAYOUT
// and strip the drag-and-drop. Quant Desk (GMA) is ON the menu; its pages ship with GMA.
// ─────────────────────────────────────────────────────────────────────────────

// Quant Desk (GMA) is DEV-ONLY until it ships: import.meta.env.DEV is statically true under the
// Vite dev server and false in the production build, so the GMA entries are tree-shaken out of
// the installed app. Remove this gate when GMA ships.
const GMA_ENABLED = import.meta.env.DEV;

// Registry of every page the sidebar can show. Layout refers to pages by route.
const PAGES = {
  '/':                  { label: 'Dashboard',         icon: LayoutDashboard },
  '/trades':            { label: 'Trade Log',         icon: TableProperties },
  '/journal':           { label: 'Trade Journal',     icon: BookOpen },
  '/calendar':          { label: 'Calendar',          icon: Calendar },
  '/key-setups':        { label: 'Key Setups',        icon: Layers },
  '/key-lessons':       { label: 'Key Lessons',       icon: BookMarked,  activeColor: 'text-terminal-red border-terminal-red' },
  '/alchemy':           { label: 'Alchemy',           icon: FlaskConical },
  '/alchemy-calendar':  { label: 'Alchemy Calendar',  icon: Calendar },
  '/withdrawal-plan':   { label: 'Withdrawal Plan',   icon: PiggyBank },
  '/reward-management': { label: 'Trade Compounder',  icon: TrendingUp },
  '/risk':              { label: 'Risk Management',   icon: ShieldCheck, activeColor: 'text-blue-400 border-blue-400' },
  '/account-monitor':   { label: 'Account Monitor',   icon: Wallet },
  // Quant Desk (Gold Metal Alchemist) — dev builds only, see GMA_ENABLED
  ...(GMA_ENABLED ? {
    '/alchemy-lab':     { label: 'Alchemy Lab',       icon: Sparkles,  activeColor: 'text-amber-400 border-amber-400' },
    '/loop-console':    { label: 'Loop Console',      icon: Activity,  activeColor: 'text-terminal-green border-terminal-green' },
    '/strategy-studio': { label: 'Strategy Studio',   icon: GitBranch, activeColor: 'text-purple-400 border-purple-400' },
    '/lab':             { label: 'The Lab',           icon: Beaker,    activeColor: 'text-cyan-400 border-cyan-400' },
  } : {}),
  '/daily-setup':       { label: 'Daily Setup',       icon: LayoutGrid },
  '/metadrift':         { label: 'MetaDrift',         icon: GitCompare,  activeColor: 'text-purple-400 border-purple-400' },
  '/import':            { label: 'Import',            icon: FileUp },
  '/settings':          { label: 'Settings',          icon: Settings },
};

// Icons for the built-in groups; user-created groups fall back to Folder.
const GROUP_ICONS = { g_journal: BookOpen, g_alchemy: FlaskConical, g_quant: Sparkles, g_calculators: Calculator };

// Palette Mike can pick from for ANY group (edit mode → click the group's icon). Stored on the
// group as icon: '<name>' so it survives reloads and bakes into the final layout.
const ICON_MAP = { Folder, PiggyBank, Calculator, BookOpen, FlaskConical, Sparkles, Layers, ShieldCheck, Wrench, Hammer, Landmark, Banknote, Coins, Vault, BarChart3, LineChart, Target, Crosshair, Compass, Gauge, Briefcase, Zap, Brain, Rocket };
// Sensible default icon by group NAME — keyword match, case-insensitive and typo-tolerant
// ("Capital Managemnet" still hits "capital"). First matching rule wins; an explicitly picked
// icon (g.icon) always overrides.
const LABEL_ICON_RULES = [
  ['capital', 'Landmark'], ['money', 'Landmark'], ['bank', 'Landmark'], ['fund', 'Landmark'],
  ['tool', 'Wrench'], ['calc', 'Calculator'], ['journal', 'BookOpen'], ['alchem', 'FlaskConical'],
  ['quant', 'Sparkles'], ['desk', 'Sparkles'], ['risk', 'ShieldCheck'], ['chart', 'BarChart3'],
  ['analy', 'BarChart3'], ['strateg', 'Target'], ['plan', 'Compass'],
];
const iconByName = (label) => {
  const l = (label || '').toLowerCase();
  const hit = LABEL_ICON_RULES.find(([k]) => l.includes(k));
  return hit ? ICON_MAP[hit[1]] : null;
};
const groupIcon = (g) => ICON_MAP[g.icon] || iconByName(g.label) || GROUP_ICONS[g.id] || Folder;

// Old route → its replacements, substituted IN PLACE so a saved arrangement keeps its spot.
const LEGACY = { '/trade-backtest': ['/daily-setup', '/metadrift'] };

// Mike's arrangement, baked 2026-09-03 from his "Copy layout" (the DnD editor stays until the
// final ship; Reset returns to this).
const DEFAULT_LAYOUT = [
  { type: 'item', to: '/' },
  { type: 'group', id: 'g_trading_tools', label: 'Trading Tools', icon: 'Wrench', children: [
    { type: 'item', to: '/daily-setup' }, { type: 'item', to: '/metadrift' },
  ]},
  { type: 'group', id: 'g_journal', label: 'Journal', children: [
    { type: 'item', to: '/trades' }, { type: 'item', to: '/journal' }, { type: 'item', to: '/calendar' },
    { type: 'item', to: '/key-setups' }, { type: 'item', to: '/key-lessons' },
  ]},
  { type: 'group', id: 'g_capital', label: 'Capital Management', icon: 'Landmark', children: [
    { type: 'item', to: '/account-monitor' }, { type: 'item', to: '/withdrawal-plan' },
  ]},
  { type: 'group', id: 'g_alchemy', label: 'Alchemy', children: [
    { type: 'item', to: '/alchemy' }, { type: 'item', to: '/alchemy-calendar' },
  ]},
  ...(GMA_ENABLED ? [{ type: 'group', id: 'g_quant', label: 'Quant Desk', children: [
    { type: 'item', to: '/alchemy-lab' }, { type: 'item', to: '/loop-console' },
    { type: 'item', to: '/strategy-studio' }, { type: 'item', to: '/lab' },
  ]}] : []),
  { type: 'group', id: 'g_calculators', label: 'Calculators', children: [
    { type: 'item', to: '/reward-management' },
  ]},
  { type: 'item', to: '/risk' },
  { type: 'item', to: '/import' },
  { type: 'item', to: '/settings' },
];

const LS_LAYOUT = 'sidebar_layout_v1';
const LS_GROUPS = 'sidebar_groups_v1';
const loadJSON = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };

// Drop unknown pages, keep known ones, and append any page missing from the saved
// layout at top level — so nothing is ever lost when pages are added or removed.
function normalizeLayout(raw) {
  const seen = new Set();
  const out = [];
  const pushItem = (to, list) => {
    for (const t of (LEGACY[to] || [to])) if (PAGES[t] && !seen.has(t)) { seen.add(t); list.push({ type: 'item', to: t }); }
  };
  for (const n of Array.isArray(raw) ? raw : []) {
    if (n?.type === 'item' && n.to) pushItem(n.to, out);
    else if (n?.type === 'group' && n.id) {
      const children = [];
      for (const c of Array.isArray(n.children) ? n.children : []) if (c?.to) pushItem(c.to, children);
      const g = { type: 'group', id: n.id, label: String(n.label || 'Group'), children };
      if (n.icon && ICON_MAP[n.icon]) g.icon = n.icon;
      out.push(g);
    }
  }
  for (const to of Object.keys(PAGES)) if (!seen.has(to)) out.push({ type: 'item', to });
  return out;
}

const nodeId = (n) => n.type === 'item' ? n.to : n.id;

// Pull a node out of the tree (top level or inside a group).
function removeNode(layout, id) {
  let node = null;
  const rest = [];
  for (const n of layout) {
    if (nodeId(n) === id) { node = n; continue; }
    if (n.type === 'group') {
      const kept = n.children.filter(c => { if (c.to === id) { node = c; return false; } return true; });
      rest.push({ ...n, children: kept });
    } else rest.push(n);
  }
  return { node, rest };
}
function moveBefore(layout, id, targetId) {
  const { node, rest } = removeNode(layout, id);
  if (!node) return layout;
  const ti = rest.findIndex(n => nodeId(n) === targetId);
  if (ti >= 0) { const out = [...rest]; out.splice(ti, 0, node); return out; }
  if (node.type === 'group') return [...rest, node];            // groups never nest
  let placed = false;
  const out = rest.map(n => {
    if (n.type !== 'group' || placed) return n;
    const ci = n.children.findIndex(c => c.to === targetId);
    if (ci < 0) return n;
    placed = true;
    const ch = [...n.children]; ch.splice(ci, 0, node);
    return { ...n, children: ch };
  });
  return placed ? out : [...rest, node];
}
function moveInto(layout, id, groupId) {
  if (id === groupId) return layout;
  const { node, rest } = removeNode(layout, id);
  if (!node) return layout;
  if (node.type === 'group') return moveBefore(layout, id, groupId);   // groups never nest
  let placed = false;
  const out = rest.map(n => (n.type === 'group' && n.id === groupId) ? (placed = true, { ...n, children: [...n.children, node] }) : n);
  return placed ? out : [...rest, node];
}
function moveTop(layout, id) {
  const { node, rest } = removeNode(layout, id);
  return node ? [...rest, node] : layout;
}

function useIsLight() {
  const [isLight, setIsLight] = useState(() => document.documentElement.classList.contains('light'));
  useEffect(() => {
    const obs = new MutationObserver(() => setIsLight(document.documentElement.classList.contains('light')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isLight;
}

function itemClass(isActive, activeColor) {
  const active = activeColor
    ? `bg-terminal-hover ${activeColor} border-l-2 pl-[10px]`
    : 'bg-terminal-hover text-terminal-green border-l-2 border-terminal-green pl-[10px]';
  return `flex items-center gap-3 px-3 py-2.5 rounded text-sm font-mono transition-colors ${
    isActive ? active : 'text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover border-l-2 border-transparent pl-[10px]'
  }`;
}

export default function Sidebar() {
  const isLight  = useIsLight();
  const location = useLocation();
  const [journalName, setJournalName] = useState(() => localStorage.getItem('journal_name') || '');
  const [logoError, setLogoError]     = useState(false);
  const [layout, setLayout]           = useState(() => normalizeLayout(loadJSON(LS_LAYOUT, DEFAULT_LAYOUT)));
  const [groups, setGroups]           = useState(() => loadJSON(LS_GROUPS, {}));
  const [editMode, setEditMode]       = useState(false);
  const [renaming, setRenaming]       = useState(null);   // { id, value }
  const [overId, setOverId]           = useState(null);   // drop-target highlight
  const [copied, setCopied]           = useState(false);
  const [iconPickFor, setIconPickFor] = useState(null);   // group id whose icon picker is open
  const dragRef = useRef(null);
  const logoSrc = isLight ? '/logo-light.png' : '/logo-dark.png';

  useEffect(() => {
    getSettings().then(s => {
      const name = s?.journal_name || '';
      setJournalName(name);
      if (name) localStorage.setItem('journal_name', name);
    }).catch(() => {});
    const handler = (e) => setJournalName(e.detail || '');
    window.addEventListener('journal-name-changed', handler);
    return () => window.removeEventListener('journal-name-changed', handler);
  }, []);

  useEffect(() => { localStorage.setItem(LS_LAYOUT, JSON.stringify(layout)); }, [layout]);
  useEffect(() => { localStorage.setItem(LS_GROUPS, JSON.stringify(groups)); }, [groups]);

  // A group auto-opens when it holds the current page; a manual click overrides. Edit mode opens all.
  const isPathIn = (items) => items.some(i => location.pathname === i.to || location.pathname.startsWith(i.to + '/'));
  const isOpen   = (g) => editMode ? true : (groups[g.id] === undefined ? isPathIn(g.children) : groups[g.id]);
  const toggle   = (g) => setGroups(s => ({ ...s, [g.id]: !isOpen(g) }));

  // ── Drag & drop (edit mode only) ──────────────────────────────────────────
  const onDragStart = (id) => (e) => {
    // Stop here: a nested item's dragstart would otherwise bubble to its parent group's
    // handler and overwrite the drag id with the GROUP — so dragging an item out of a
    // group moved the whole group instead. Innermost draggable wins.
    e.stopPropagation();
    dragRef.current = id;
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch {}
  };
  const onDragOver = (id) => (e) => { e.preventDefault(); e.stopPropagation(); if (overId !== id) setOverId(id); };
  const finish = () => { dragRef.current = null; setOverId(null); };
  const onDropBefore = (targetId) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const id = dragRef.current; if (id && id !== targetId) setLayout(l => moveBefore(l, id, targetId));
    finish();
  };
  const onDropInto = (groupId) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const id = dragRef.current; if (id) setLayout(l => moveInto(l, id, groupId));
    finish();
  };
  const onDropTop = (e) => {
    e.preventDefault(); e.stopPropagation();
    const id = dragRef.current; if (id) setLayout(l => moveTop(l, id));
    finish();
  };

  // ── Group management (edit mode) ──────────────────────────────────────────
  const addGroup = () => {
    const id = 'g_' + Date.now();
    setLayout(l => [...l, { type: 'group', id, label: 'New Group', children: [] }]);
    setRenaming({ id, value: 'New Group' });
  };
  const commitRename = () => {
    if (!renaming) return;
    const v = renaming.value.trim();
    if (v) setLayout(l => l.map(n => n.type === 'group' && n.id === renaming.id ? { ...n, label: v } : n));
    setRenaming(null);
  };
  const deleteGroup = (id) => setLayout(l => l.filter(n => !(n.type === 'group' && n.id === id && n.children.length === 0)));
  const resetLayout = () => { setLayout(DEFAULT_LAYOUT); setGroups({}); };
  const copyLayout  = () => {
    navigator.clipboard?.writeText(JSON.stringify(layout, null, 2)).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const hl = (id) => editMode && overId === id ? 'ring-1 ring-terminal-amber/70 bg-terminal-hover/40' : '';

  const renderItem = (n, nested) => {
    const page = PAGES[n.to];
    const Icon = page.icon;
    return (
      <div
        key={n.to}
        className={`rounded ${hl(n.to)}`}
        draggable={editMode}
        onDragStart={editMode ? onDragStart(n.to) : undefined}
        onDragOver={editMode ? onDragOver(n.to) : undefined}
        onDrop={editMode ? onDropBefore(n.to) : undefined}
        onDragEnd={finish}
      >
        <NavLink
          to={n.to}
          end={n.to === '/'}
          onClick={e => { if (editMode) e.preventDefault(); }}
          className={({ isActive }) => `${itemClass(isActive, page.activeColor)} ${nested ? 'ml-4 py-2 text-[13px]' : ''} ${editMode ? 'cursor-grab' : ''}`}
        >
          {editMode && <GripVertical className="w-3.5 h-3.5 text-terminal-dim -ml-1 flex-shrink-0" />}
          <Icon className="w-4 h-4 flex-shrink-0" />
          {page.label}
        </NavLink>
      </div>
    );
  };

  const renderGroup = (g) => {
    const open   = isOpen(g);
    const active = isPathIn(g.children);
    const Icon   = groupIcon(g);
    const Chev   = open ? ChevronDown : ChevronRight;
    const isRenaming = renaming?.id === g.id;
    return (
      <div
        key={g.id}
        className={`rounded ${hl(g.id)}`}
        draggable={editMode && !isRenaming}
        onDragStart={editMode ? onDragStart(g.id) : undefined}
        onDragEnd={finish}
      >
        {/* Header: normal mode = click toggles; edit mode = drop-INTO target, label click renames */}
        <div
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded text-sm font-mono transition-colors border-l-2 border-transparent pl-[10px] ${
            active ? 'text-terminal-text' : 'text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover'
          } ${editMode ? 'cursor-grab' : 'cursor-pointer'}`}
          onClick={() => { if (!editMode) toggle(g); }}
          onDragOver={editMode ? onDragOver(g.id) : undefined}
          onDrop={editMode ? onDropInto(g.id) : undefined}
        >
          {editMode && <GripVertical className="w-3.5 h-3.5 text-terminal-dim -ml-1 flex-shrink-0" />}
          <span
            className={`relative flex-shrink-0 ${editMode ? 'cursor-pointer rounded hover:bg-terminal-hover/60 p-0.5 -m-0.5' : ''}`}
            title={editMode ? 'Click to change icon' : undefined}
            onClick={e => { if (editMode) { e.stopPropagation(); setIconPickFor(v => v === g.id ? null : g.id); } }}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
          </span>
          {isRenaming ? (
            <input
              autoFocus value={renaming.value}
              onChange={e => setRenaming(r => ({ ...r, value: e.target.value }))}
              onBlur={commitRename}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }}
              onClick={e => e.stopPropagation()}
              className="flex-1 min-w-0 bg-terminal-bg border border-terminal-amber rounded px-1.5 py-0.5 text-sm font-mono text-terminal-text focus:outline-none"
            />
          ) : (
            <span
              className="flex-1 text-left truncate"
              onClick={e => { if (editMode) { e.stopPropagation(); setRenaming({ id: g.id, value: g.label }); } }}
              title={editMode ? 'Click to rename' : undefined}
            >{g.label}</span>
          )}
          {editMode && g.children.length === 0 && !isRenaming && (
            <button onClick={e => { e.stopPropagation(); deleteGroup(g.id); }} title="Delete empty group"
              className="text-terminal-dim hover:text-terminal-red"><X className="w-3.5 h-3.5" /></button>
          )}
          {editMode ? (
            <button onClick={e => { e.stopPropagation(); setGroups(s => ({ ...s, [g.id]: !(groups[g.id] ?? isPathIn(g.children)) })); }}
              className="text-terminal-dim"><Chev className="w-3.5 h-3.5 flex-shrink-0" /></button>
          ) : (
            <Chev className="w-3.5 h-3.5 text-terminal-dim flex-shrink-0" />
          )}
        </div>
        {editMode && iconPickFor === g.id && (
          <div className="mx-2 my-1 p-2 grid grid-cols-6 gap-1 rounded border border-terminal-amber/50 bg-terminal-bg" onClick={e => e.stopPropagation()}>
            {Object.entries(ICON_MAP).map(([name, I]) => (
              <button key={name} title={name}
                onClick={e => { e.stopPropagation(); setLayout(l => l.map(n => n.type === 'group' && n.id === g.id ? { ...n, icon: name } : n)); setIconPickFor(null); }}
                className={`p-1.5 rounded flex items-center justify-center hover:bg-terminal-hover ${(g.icon || '') === name ? 'ring-1 ring-terminal-amber text-terminal-amber' : 'text-terminal-muted hover:text-terminal-text'}`}>
                <I className="w-4 h-4" />
              </button>
            ))}
          </div>
        )}
        {open && (
          <div className="space-y-0.5 mt-0.5">
            {g.children.map(c => renderItem(c, true))}
            {editMode && g.children.length === 0 && (
              <div className="ml-4 px-3 py-2 text-[11px] font-mono text-terminal-dim border border-dashed border-terminal-border/60 rounded"
                onDragOver={onDragOver(g.id)} onDrop={onDropInto(g.id)}>drop items here</div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="w-56 flex-shrink-0 bg-terminal-surface border-r border-terminal-border flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="px-3 py-4 border-b border-terminal-border">
        {!logoError ? (
          <img src={logoSrc} alt="Alchemy8" onError={() => setLogoError(true)} className="w-full object-contain" style={{ maxHeight: '48px' }} />
        ) : (
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-terminal-green" />
            <div>
              <div className="text-sm font-mono font-semibold text-terminal-text">TRADE LOG</div>
              <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">{journalName || 'My Journal'}</div>
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto">
        {editMode && (
          <div className="mb-2 px-2 py-1.5 text-[10px] font-mono text-terminal-amber border border-terminal-amber/40 rounded leading-relaxed">
            Edit layout: drag to reorder · drop on a group to nest · click a group name to rename
          </div>
        )}
        {layout.map(n => n.type === 'item' ? renderItem(n, false) : renderGroup(n))}
        {editMode && (
          <div
            className={`mt-2 px-3 py-3 text-[11px] font-mono text-center text-terminal-dim border border-dashed rounded ${overId === '__top__' ? 'border-terminal-amber text-terminal-amber' : 'border-terminal-border/60'}`}
            onDragOver={onDragOver('__top__')} onDrop={onDropTop}
          >drop here → top level (un-nest)</div>
        )}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-terminal-border space-y-2">
        {editMode && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={addGroup} className="flex items-center gap-1 px-2 py-1 rounded border border-terminal-border text-[10px] font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim"><Plus className="w-3 h-3" /> Group</button>
            <button onClick={resetLayout} className="flex items-center gap-1 px-2 py-1 rounded border border-terminal-border text-[10px] font-mono text-terminal-muted hover:text-terminal-red hover:border-terminal-red"><RotateCcw className="w-3 h-3" /> Reset</button>
            <button onClick={copyLayout} className="flex items-center gap-1 px-2 py-1 rounded border border-terminal-border text-[10px] font-mono text-terminal-muted hover:text-terminal-green hover:border-terminal-green">{copied ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy layout</>}</button>
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
            <span className="text-[10px] font-mono text-terminal-dim">LIVE</span>
          </div>
          <button
            onClick={() => { setEditMode(m => !m); setRenaming(null); setIconPickFor(null); finish(); }}
            title={editMode ? 'Done editing layout' : 'Edit sidebar layout'}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono border transition-colors ${
              editMode ? 'bg-terminal-amber text-black border-terminal-amber font-semibold' : 'text-terminal-dim border-terminal-border hover:text-terminal-text hover:border-terminal-dim'
            }`}
          >
            {editMode ? <><Check className="w-3 h-3" /> Done</> : <><Pencil className="w-3 h-3" /> Edit layout</>}
          </button>
        </div>
      </div>
    </aside>
  );
}
