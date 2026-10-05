import { useEffect, useState } from 'react';
import { Plus, Save, Trash2, Copy, ArrowUp, ArrowDown, X } from 'lucide-react';
import { tdExits, tdCreateExit, tdUpdateExit, tdDeleteExit } from '../../lib/api';

// Trading Desk · Exits
// Exit plans: a named list of triggers that run together; the first to fire ends the trade. Plans are kept apart
// from edges so an exit can be swapped or combined without touching the edge. Edges pick a default plan; each
// example records the plan it was taught with, and its result is worked out under that plan.

const TYPES = [
  { id: 'target',    label: 'Fixed target',          blurb: 'Out when price reaches a set number of R (or the target drawn on the box).' },
  { id: 'trail',     label: 'R-step trail',          blurb: 'Once the trade has reached a set profit, the stop follows behind the best level, moving in steps.' },
  { id: 'breakeven', label: 'Move stop to breakeven', blurb: 'Once the trade has reached a set profit, the stop moves to the entry (plus an offset if you like).' },
  { id: 'partial',   label: 'Partial close',         blurb: 'Close part of the position at a set profit; the rest keeps running.' },
  { id: 'time',      label: 'Flat by a time of day', blurb: 'Close whatever is left at a Vancouver time.' },
  { id: 'structure', label: 'Break of structure',    blurb: 'Out when an opposite 1-2-3 completes. The app cannot spot structure by itself yet, so you mark it in the Trainer; only the safety trail is worked out automatically.' },
];
// outside the component on purpose: defined inside, every keystroke would rebuild the row and drop the cursor
const S = ({ children }) => <span className="text-sm font-mono text-terminal-text leading-9">{children}</span>;
const fresh = (type) => ({
  target: { type, r: 2 }, trail: { type, arm_r: 1, distance_r: 1, step_r: 1 }, breakeven: { type, after_r: 1, offset_r: 0 },
  partial: { type, pct: 50, at_r: 2 }, time: { type, at: '14:00' }, structure: { type, safety_r: 2 },
}[type]);

export default function ExitsPage() {
  const [plans, setPlans] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState('');
  const [arm, setArm] = useState(false);
  const [error, setError] = useState('');

  const fail = (e) => setError(e?.response?.data?.error || e.message || 'Something went wrong.');
  const reload = async () => { try { const r = await tdExits(); setPlans(r.plans); return r.plans; } catch (e) { fail(e); return []; } };
  useEffect(() => { reload(); }, []);
  const plan = plans.find((p) => p.id === openId) || plans[0] || null;
  useEffect(() => { setDraft(plan ? JSON.parse(JSON.stringify(plan)) : null); setNote(''); setArm(false); }, [plan && plan.id, plan && plan.updated_at]);

  const dirty = draft && plan && JSON.stringify({ n: draft.name, d: draft.description, t: draft.triggers }) !== JSON.stringify({ n: plan.name, d: plan.description, t: plan.triggers });
  const setT = (i, patch) => setDraft((d) => ({ ...d, triggers: d.triggers.map((t, k) => (k === i ? { ...t, ...patch } : t)) }));
  const move = (i, dir) => setDraft((d) => { const t = [...d.triggers]; const j = i + dir; if (j < 0 || j >= t.length) return d; [t[i], t[j]] = [t[j], t[i]]; return { ...d, triggers: t }; });
  const save = async () => { try { await tdUpdateExit(plan.id, draft); await reload(); setNote('Saved. Examples taught with this plan get their result worked out again.'); } catch (e) { setNote(e?.response?.data?.error || e.message); } };
  const create = async (from) => {
    try { const p = await tdCreateExit(from ? { name: `${from.name} (copy)`, description: from.description, triggers: from.triggers } : { name: `Exit ${plans.length + 1}`, triggers: [{ type: 'target', r: null }] }); await reload(); setOpenId(p.id); }
    catch (e) { fail(e); }
  };
  const remove = async () => {
    if (!arm) { setArm(true); return; }
    setArm(false);
    try { const r = await tdDeleteExit(plan.id); const list = await reload(); setOpenId(list[0]?.id || null); setNote(r.edges || r.examples ? `Deleted. ${r.edges} edge(s) and ${r.examples} example(s) that used it now use "${list.find((p) => p.id === r.moved_to)?.name || 'another plan'}".` : ''); }
    catch (e) { setNote(e?.response?.data?.error || e.message); }
  };

  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors';
  const idle = 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover';
  const on = 'border-amber-400 text-amber-400 bg-amber-400/10';
  const inp = 'input-field text-xs font-mono py-1';
  const num = (i, k, extra = {}) => <input type="number" value={draft.triggers[i][k] ?? ''} onChange={(e) => setT(i, { [k]: e.target.value === '' ? null : Number(e.target.value) })} className={`${inp} w-20 text-right inline-block mx-1`} {...extra} />;

  const sentence = (t, i) => {
    switch (t.type) {
      case 'target': return <S>Out at {num(i, 'r', { step: 0.5, min: 0.1, placeholder: 'drawn' })} R{t.r == null ? ' — blank means the target drawn on the box' : ''}.</S>;
      case 'trail': return <S>Once the trade reaches {num(i, 'arm_r', { step: 0.5, min: 0 })} R, the stop sits {num(i, 'distance_r', { step: 0.5, min: 0.05 })} R behind the best level and moves up every {num(i, 'step_r', { step: 0.5, min: 0.05 })} R.</S>;
      case 'breakeven': return <S>Once the trade reaches {num(i, 'after_r', { step: 0.5, min: 0.05 })} R, the stop moves to the entry {num(i, 'offset_r', { step: 0.1 })} R.</S>;
      case 'partial': return <S>Close {num(i, 'pct', { step: 5, min: 1, max: 99 })} % at {num(i, 'at_r', { step: 0.5, min: 0.05 })} R; the rest keeps running.</S>;
      case 'time': return <S>Flat at <input type="time" value={t.at || ''} onChange={(e) => setT(i, { at: e.target.value })} className={`${inp} w-28 inline-block mx-1`} /> Vancouver time.</S>;
      case 'structure': return <S>Out when an opposite 1-2-3 completes (marked by hand in the Trainer). Safety trail {num(i, 'safety_r', { step: 0.5, min: 0.1, placeholder: 'off' })} R behind the best level{t.safety_r == null ? ' — blank means no safety trail' : ''}.</S>;
      default: return null;
    }
  };

  return (
    <div className="h-full flex min-h-0">
      <div className="w-72 flex-shrink-0 border-r border-terminal-border overflow-y-auto p-2 space-y-1.5">
        <button onClick={() => create(null)} className={`${btn} ${idle} w-full justify-center`}><Plus size={14} />New exit plan</button>
        {plans.map((p) => (
          <button key={p.id} onClick={() => setOpenId(p.id)} className={`w-full text-left rounded border px-2 py-1.5 ${plan?.id === p.id ? 'border-amber-400' : 'border-terminal-border hover:bg-terminal-hover'}`}>
            <div className="text-xs font-mono text-terminal-text">{p.name}</div>
            <div className="text-[10px] font-mono text-terminal-dim">{p.triggers.map((t) => TYPES.find((x) => x.id === t.type)?.label).join(' · ') || 'no triggers'}</div>
          </button>
        ))}
        {error && <p className="text-xs font-mono text-terminal-red p-2">{error}</p>}
      </div>

      {draft && (
        <div className="flex-1 min-w-0 overflow-y-auto p-4">
          <div className="max-w-3xl space-y-3">
            <div className="flex items-end gap-2">
              <label className="space-y-0.5"><span className="text-[10px] font-mono text-terminal-dim">Name</span>
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${inp} w-64 block`} /></label>
              <label className="space-y-0.5 flex-1"><span className="text-[10px] font-mono text-terminal-dim">What it does, in one line</span>
                <input value={draft.description || ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`${inp} w-full block`} /></label>
              <button onClick={save} disabled={!dirty} className={`${btn} ${on} disabled:opacity-40`}><Save size={14} />Save</button>
              <button onClick={() => create(plan)} className={`${btn} ${idle}`} title="Make a copy to try a variation"><Copy size={14} />Duplicate</button>
              {plans.length > 1 && <button onClick={remove} className={`${btn} ${arm ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : idle}`}><Trash2 size={14} />{arm ? 'Click again to delete' : 'Delete'}</button>}
            </div>

            <div className="rounded border border-terminal-border p-4 space-y-2">
              <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Triggers · all run at the same time; the first to fire ends the trade. The stop drawn on the box is always there.</div>
              {draft.triggers.length === 0 && <p className="text-xs font-mono text-terminal-dim">No triggers yet: the trade only ends at the drawn stop. Add one below.</p>}
              {draft.triggers.map((t, i) => (
                <div key={i} className="flex items-start gap-2 rounded border border-terminal-border/60 px-3 py-1">
                  <span className="text-[10px] font-mono text-amber-400 w-32 pt-3 flex-shrink-0">{TYPES.find((x) => x.id === t.type)?.label}</span>
                  <div className="flex-1 min-w-0">{sentence(t, i)}</div>
                  <div className="flex items-center gap-1 pt-2 flex-shrink-0">
                    <button onClick={() => move(i, -1)} className="text-terminal-dim hover:text-terminal-text" title="Move up"><ArrowUp size={13} /></button>
                    <button onClick={() => move(i, 1)} className="text-terminal-dim hover:text-terminal-text" title="Move down"><ArrowDown size={13} /></button>
                    <button onClick={() => setDraft({ ...draft, triggers: draft.triggers.filter((_, k) => k !== i) })} className="text-terminal-dim hover:text-terminal-red" title="Remove this trigger"><X size={13} /></button>
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-xs font-mono text-terminal-muted">Add:</span>
                {TYPES.map((ty) => <button key={ty.id} onClick={() => setDraft({ ...draft, triggers: [...draft.triggers, fresh(ty.id)] })} className={`${btn} ${idle}`} title={ty.blurb}>{ty.label}</button>)}
              </div>
            </div>

            <div className="text-[11px] font-mono text-terminal-dim space-y-1">
              {TYPES.map((ty) => <p key={ty.id}><span className="text-terminal-muted">{ty.label}:</span> {ty.blurb}</p>)}
              <p className="pt-1">If several things touch inside the same minute, the stop counts first (the cautious reading). R means multiples of the entry-to-stop distance.</p>
            </div>
            {note && <p className={`text-xs font-mono ${/^Saved|^Deleted/.test(note) ? 'text-terminal-green' : 'text-terminal-red'}`}>{note}</p>}
            {dirty && !note && <p className="text-xs font-mono text-amber-400">Unsaved changes.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
