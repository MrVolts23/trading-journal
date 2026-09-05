import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, RefreshCw, Loader2 } from 'lucide-react';
import { deskGetActivity } from '../../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Activity (/desk/activity) — "What the desk did, in plain sentences."
// A vertical timeline from GET /api/desk/activity: [{ ts, text, kind: test|version|risk|note }].
// Nothing here about loops, tokens, budgets or schedules. Just what happened, newest first.
// ─────────────────────────────────────────────────────────────────────────────

const PT = 'America/Los_Angeles';
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));
function toDate(t) {
  if (t == null || t === '') return null;
  if (t instanceof Date) return t;
  if (isNum(t)) return new Date(Number(t) * (Number(t) < 1e11 ? 1000 : 1));
  const s = String(t).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/); // sqlite UTC text, no zone
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}
const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: PT });
const fmtDayHeading = (d) => {
  const today = dayKey(new Date());
  const yest = dayKey(new Date(Date.now() - 86400000));
  const k = dayKey(d);
  const label = d.toLocaleDateString('en-US', { timeZone: PT, weekday: 'long', month: 'long', day: 'numeric' });
  return k === today ? `Today, ${label}` : k === yest ? `Yesterday, ${label}` : label;
};
const fmtTime = (d) => d.toLocaleTimeString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });

const DOT = {
  test:    'bg-amber-400',
  version: 'bg-terminal-text',
  risk:    'bg-blue-400',
  note:    'bg-terminal-dim',
};
// A test sentence carries its verdict; colour the dot by it so a glance down the line reads pass/fail.
function dotClass(item) {
  const t = String(item.text || '');
  if (item.kind === 'test') {
    if (/\bPASS(ED)?\b/.test(t)) return 'bg-green-400';
    if (/\b(FAIL(ED)?|REJECT(ED)?)\b/.test(t)) return 'bg-red-400';
  }
  return DOT[item.kind] || DOT.note;
}

export default function ActivityPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await deskGetActivity(50);
      const list = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.rows) ? d.rows : Array.isArray(d?.activity) ? d.activity : [];
      setItems(list);
      setErr(null);
    } catch (e) {
      const st = e?.response?.status;
      setErr(st === 503 || st === 404 ? 'The desk is not reachable. Restart the backend, then refresh.' : e?.response?.data?.error || e.message || 'Could not load activity.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Group consecutive entries by PT day so the timeline reads like a diary.
  const groups = [];
  for (const it of items || []) {
    const d = toDate(it.ts ?? it.at ?? it.created_at);
    const key = d ? dayKey(d) : 'undated';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push({ ...it, _d: d });
    else groups.push({ key, date: d, items: [{ ...it, _d: d }] });
  }

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-amber-400" />
            <h1 className="text-lg font-mono text-terminal-text">Activity</h1>
          </div>
          <div className="text-sm font-mono text-terminal-muted mt-1">What the desk did, in plain sentences. Newest first.</div>
        </div>
        <button onClick={refresh} title="Refresh" className="p-1.5 rounded border border-terminal-border text-terminal-dim hover:text-terminal-text"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
      </div>

      {err && <div className="px-3 py-2 rounded border border-red-500/50 text-xs font-mono text-red-400">{err}</div>}

      {loading && items == null && !err && <div className="text-xs font-mono text-terminal-dim"><Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1.5" />Loading</div>}

      {!err && items && !items.length && (
        <div className="border border-dashed border-terminal-border rounded-lg px-6 py-10 text-center">
          <div className="text-sm font-mono text-terminal-muted">Nothing has happened yet.</div>
          <div className="text-xs font-mono text-terminal-dim mt-1">Go to Edge, change a number, and press Test this version. Every test, new version and risk change shows up here.</div>
          <button onClick={() => navigate('/desk/edge')} className="mt-4 px-3 py-1.5 rounded bg-terminal-amber text-black text-xs font-mono font-semibold">Go to Edge</button>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.key}>
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-2">{g.date ? fmtDayHeading(g.date) : 'Undated'}</div>
          <ol className="relative border-l border-terminal-border ml-2">
            {g.items.map((it, i) => (
              <li key={it.id ?? `${g.key}-${i}`} className="ml-5 pb-4 last:pb-1">
                <span className={`absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full ring-4 ring-terminal-bg ${dotClass(it)}`} />
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-[11px] font-mono text-terminal-dim tabular-nums w-16 flex-shrink-0">{it._d ? fmtTime(it._d) : ''}</span>
                  <span className="text-sm font-mono text-terminal-text leading-relaxed">{it.text}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
