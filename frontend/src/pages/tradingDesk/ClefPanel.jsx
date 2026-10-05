import { useEffect, useState } from 'react';
import { Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { tdClefStatus, tdClefAsk, tdClefRuns } from '../../lib/api';

// "Ask Clef" for one saved example. Shows exactly what came back (every answer with its probabilities) and, if you
// open it, exactly what was sent. Nothing is summarised: the numbers are the model's.

const pct = (x) => `${Math.round((x || 0) * 100)}%`;

function Answer({ id, a }) {
  const name = id.replace(/_/g, ' ');
  if (a.type === 'noul') {
    const p = a.noul ?? a.probability ?? 0;
    return (
      <div className="space-y-0.5">
        <div className="flex justify-between text-xs font-mono"><span className="text-terminal-muted">{name}</span><span className={p >= 0.5 ? 'text-terminal-green' : 'text-terminal-red'}>{p >= 0.5 ? 'yes' : 'no'} · {pct(p)} yes</span></div>
        <div className="h-1.5 rounded bg-terminal-border overflow-hidden"><div className="h-full bg-terminal-green" style={{ width: pct(p) }} /></div>
      </div>
    );
  }
  if (a.type === 'choice') {
    return (
      <div className="space-y-0.5">
        <div className="flex justify-between text-xs font-mono"><span className="text-terminal-muted">{name}</span><span className="text-terminal-text">{a.choice} · {pct(a.confidence)}</span></div>
        {Object.entries(a.probabilities || {}).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-[10px] font-mono"><span className="w-20 text-terminal-dim truncate">{k}</span><div className="flex-1 h-1 rounded bg-terminal-border overflow-hidden"><div className={`h-full ${k === a.choice ? 'bg-amber-400' : 'bg-terminal-muted'}`} style={{ width: pct(v) }} /></div><span className="w-9 text-right text-terminal-dim">{pct(v)}</span></div>
        ))}
      </div>
    );
  }
  if (a.type === 'score') {
    const legend = a.legend || {};
    return (
      <div className="space-y-0.5">
        <div className="flex justify-between text-xs font-mono"><span className="text-terminal-muted">{name}</span><span className="text-terminal-text">{legend[String(Math.round(a.score))] || a.score} · {pct(a.confidence)}</span></div>
        {Object.entries(a.probabilities || {}).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-[10px] font-mono"><span className="w-20 text-terminal-dim truncate">{legend[k] || k}</span><div className="flex-1 h-1 rounded bg-terminal-border overflow-hidden"><div className="h-full bg-sky-400" style={{ width: pct(v) }} /></div><span className="w-9 text-right text-terminal-dim">{pct(v)}</span></div>
        ))}
      </div>
    );
  }
  return <pre className="text-[10px] font-mono text-terminal-muted whitespace-pre-wrap">{id}: {JSON.stringify(a)}</pre>;
}

function Run({ r, skillName }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-sky-400/40 p-2 space-y-1.5">
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-sky-400">{skillName || r.skill_key || r.skill}</span>
        <span className="text-[10px] text-terminal-dim">{r.picture} · {r.ms ? `${(r.ms / 1000).toFixed(1)} s` : ''} · {(r.created_at || '').slice(0, 16)}</span>
      </div>
      {r.error ? <p className="text-xs font-mono text-terminal-red">{r.error}</p> : Object.entries(r.answers || {}).map(([id, a]) => <Answer key={id} id={id} a={a} />)}
      {r.record && (
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[10px] font-mono text-terminal-dim hover:text-terminal-text">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}what was sent (word for word)
        </button>
      )}
      {open && r.record && <pre className="text-[10px] font-mono text-terminal-muted whitespace-pre-wrap max-h-64 overflow-auto bg-terminal-surface rounded p-2">{JSON.stringify(r.record, null, 2)}</pre>}
    </div>
  );
}

export default function ClefPanel({ exampleId, skillNames = {}, compact = false }) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => { tdClefStatus().then(setStatus).catch(() => setStatus({ installed: false })); }, []);
  useEffect(() => { if (exampleId) tdClefRuns(exampleId).then(setRuns).catch(() => setRuns([])); else setRuns([]); }, [exampleId]);

  const ask = async () => {
    setBusy(true); setNote(status?.running ? '' : 'Starting Clef (the model takes a few seconds to load the first time)…');
    try {
      const r = await tdClefAsk(exampleId);
      setRuns(await tdClefRuns(exampleId));
      setStatus(await tdClefStatus());
      setNote(r.runs.some((x) => x.error) ? r.runs.filter((x) => x.error).map((x) => `${skillNames[x.skill] || x.skill}: ${x.error}`).join(' ') : '');
    } catch (e) { setNote(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors';
  const on = 'border-sky-400 text-sky-400 bg-sky-400/10';
  if (!exampleId) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={ask} disabled={busy || status?.installed === false} className={`${btn} ${on} disabled:opacity-40`}><Sparkles size={14} />{busy ? 'Clef is looking…' : runs.length ? 'Ask Clef again' : 'Ask Clef'}</button>
        <span className="text-[10px] font-mono text-terminal-dim">{status == null ? '' : status.installed === false ? 'Clef is not installed on this Mac.' : status.running ? `Clef is up (${status.model?.split('/').pop()})` : 'Clef is installed; it starts when you ask.'}</span>
      </div>
      {note && <p className="text-xs font-mono text-terminal-red">{note}</p>}
      {runs.length === 0 && !busy && <p className="text-[10px] font-mono text-terminal-dim">Clef gets this example's pictures, the facts (prices, times, marked points) and each ticked skill's questions. It does not get your take/skip, grade or trend call.</p>}
      {(compact ? runs.slice(0, 3) : runs).map((r) => <Run key={r.id} r={r} skillName={skillNames[r.skill_key]} />)}
      {compact && runs.length > 3 && <p className="text-[10px] font-mono text-terminal-dim">{runs.length - 3} older run{runs.length - 3 === 1 ? '' : 's'} in the Library.</p>}
    </div>
  );
}
