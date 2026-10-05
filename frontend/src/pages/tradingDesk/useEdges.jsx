import { useCallback, useEffect, useState } from 'react';
import { tdEdges, tdCreateEdge, tdUpdateEdge, tdDeleteEdge } from '../../lib/api';
import { marketDay, marketWeekday } from '../../lib/marketDay';

// The edges and which one is selected. The selection is shared by the Edge, Trainer and Library tabs
// (remembered in localStorage) so you always work inside one edge.
const LS = 'td_edge_id';
const read = () => { try { return Number(localStorage.getItem(LS)) || null; } catch { return null; } };
const write = (id) => { try { localStorage.setItem(LS, String(id)); } catch { /* private mode */ } };

export function useEdges() {
  const [edges, setEdges] = useState([]);
  const [currentId, setCurrentId] = useState(read);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try { const list = await tdEdges(); setEdges(list); return list; } catch (e) { setError(e?.response?.data?.error || e.message); return []; }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // the selection always points at a real edge
  useEffect(() => {
    if (!edges.length) return;
    if (!edges.some((e) => e.id === currentId)) { setCurrentId(edges[0].id); write(edges[0].id); }
  }, [edges, currentId]);

  const select = (id) => { setCurrentId(id); write(id); };
  const create = async (body) => { const e = await tdCreateEdge(body); await reload(); select(e.id); return e; };
  const update = async (id, body) => { const e = await tdUpdateEdge(id, body); setEdges((all) => all.map((x) => (x.id === id ? e : x))); return e; };
  const remove = async (id) => { const r = await tdDeleteEdge(id); const list = await reload(); if (list.length) select(list[0].id); return r; };
  const current = edges.find((e) => e.id === currentId) || null;
  return { edges, current, select, create, update, remove, reload, error };
}

// Is a moment (UTC seconds) inside the edge's hunting window? The clock is Vancouver wall-clock (the window may
// cross midnight); the day is the MARKET day (Monday starts Sunday afternoon — see lib/marketDay.js).
const _parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit', hour12: false });
const DAY = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
export function insideWindow(edge, utc, market = 'forex') {
  if (!edge || utc == null) return true;
  const p = Object.fromEntries(_parts.formatToParts(new Date(utc * 1000)).map((x) => [x.type, x.value]));
  const minutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const a = toMin(edge.window_start), b = toMin(edge.window_end);
  const inTime = a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
  const inDay = !edge.days?.length || edge.days.includes(DAY[marketWeekday(marketDay(utc, market))]);
  return inTime && inDay;
}

// Small dropdown for the Trainer and Library toolbars.
export function EdgePicker({ edges, current, onSelect, className = '' }) {
  if (!edges.length) return null;
  return (
    <label className={`flex items-center gap-1.5 text-xs font-mono text-terminal-muted ${className}`} title="Which edge you are working in. Examples you save belong to it.">
      Edge
      <select value={current?.id || ''} onChange={(e) => onSelect(Number(e.target.value))}
        className="bg-terminal-surface border border-amber-400/60 text-amber-400 rounded px-2 py-1.5 text-xs font-mono">
        {edges.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
    </label>
  );
}
