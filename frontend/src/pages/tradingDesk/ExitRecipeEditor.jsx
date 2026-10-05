import { ArrowUp, ArrowDown, X } from 'lucide-react';

// The exit recipe editor: a list of exit triggers (the "Exits" skills) with their numbers. Used by the Edge page.
// All triggers run at the same time; the first to fire ends the trade. The stop drawn on the box is always there.

export const EXIT_TYPES = [
  { id: 'target',    label: 'Fixed target',           blurb: 'Out when price reaches a set number of R (blank = the target drawn on the box).' },
  { id: 'trail',     label: 'R-step trail',           blurb: 'Once the trade has reached a set profit, the stop follows behind the best level, moving in steps.' },
  { id: 'breakeven', label: 'Move stop to breakeven', blurb: 'Once the trade has reached a set profit, the stop moves to the entry (plus an offset if you like).' },
  { id: 'partial',   label: 'Partial close',          blurb: 'Close part of the position at a set profit; the rest keeps running.' },
  { id: 'time',      label: 'Flat by a time of day',  blurb: 'Close whatever is left at a Vancouver time.' },
  { id: 'structure', label: 'Break of structure',     blurb: 'Out when an opposite 1-2-3 completes (marked in the Trainer; the app cannot spot structure by itself yet). Only the safety trail is worked out automatically.' },
];
export const freshTrigger = (type) => ({
  target: { type, r: 2 }, trail: { type, arm_r: 1, distance_r: 1, step_r: 1 }, breakeven: { type, after_r: 1, offset_r: 0 },
  partial: { type, pct: 50, at_r: 2 }, time: { type, at: '14:00' }, structure: { type, safety_r: 2 },
}[type]);

const S = ({ children }) => <span className="text-sm font-mono text-terminal-text leading-9">{children}</span>;

export default function ExitRecipeEditor({ triggers, onChange }) {
  const inp = 'input-field text-xs font-mono py-1';
  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors';
  const idle = 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover';
  const setT = (i, patch) => onChange(triggers.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  const move = (i, dir) => { const t = [...triggers]; const j = i + dir; if (j < 0 || j >= t.length) return; [t[i], t[j]] = [t[j], t[i]]; onChange(t); };
  const num = (i, k, extra = {}) => <input type="number" value={triggers[i][k] ?? ''} onChange={(e) => setT(i, { [k]: e.target.value === '' ? null : Number(e.target.value) })} className={`${inp} w-20 text-right inline-block mx-1`} {...extra} />;
  const sentence = (t, i) => {
    switch (t.type) {
      case 'target': return <S>Out at {num(i, 'r', { step: 0.5, min: 0.1, placeholder: 'drawn' })} R{t.r == null ? ' — blank means the target drawn on the box' : ''}.</S>;
      case 'trail': return <S>Once the trade reaches {num(i, 'arm_r', { step: 0.5, min: 0 })} R, the stop sits {num(i, 'distance_r', { step: 0.5, min: 0.05 })} R behind the best level and moves up every {num(i, 'step_r', { step: 0.5, min: 0.05 })} R.</S>;
      case 'breakeven': return <S>Once the trade reaches {num(i, 'after_r', { step: 0.5, min: 0.05 })} R, the stop moves to the entry {num(i, 'offset_r', { step: 0.1 })} R.</S>;
      case 'partial': return <S>Close {num(i, 'pct', { step: 5, min: 1, max: 99 })} % at {num(i, 'at_r', { step: 0.5, min: 0.05 })} R; the rest keeps running.</S>;
      case 'time': return <S>Flat at <input type="time" value={t.at || ''} onChange={(e) => setT(i, { at: e.target.value })} className={`${inp} w-28 inline-block mx-1`} /> Vancouver time.</S>;
      case 'structure': return <S>Out when an opposite 1-2-3 completes. Safety trail {num(i, 'safety_r', { step: 0.5, min: 0.1, placeholder: 'off' })} R behind the best level{t.safety_r == null ? ' — blank means no safety trail' : ''}.</S>;
      default: return null;
    }
  };
  return (
    <div className="space-y-2">
      {triggers.length === 0 && <p className="text-xs font-mono text-terminal-dim">No exit triggers: the trade only ends at the drawn stop. Add one below.</p>}
      {triggers.map((t, i) => (
        <div key={i} className="flex items-start gap-2 rounded border border-terminal-border/60 px-3 py-1">
          <span className="text-[10px] font-mono text-amber-400 w-32 pt-3 flex-shrink-0">{EXIT_TYPES.find((x) => x.id === t.type)?.label}</span>
          <div className="flex-1 min-w-0">{sentence(t, i)}</div>
          <div className="flex items-center gap-1 pt-2 flex-shrink-0">
            <button onClick={() => move(i, -1)} className="text-terminal-dim hover:text-terminal-text" title="Move up"><ArrowUp size={13} /></button>
            <button onClick={() => move(i, 1)} className="text-terminal-dim hover:text-terminal-text" title="Move down"><ArrowDown size={13} /></button>
            <button onClick={() => onChange(triggers.filter((_, k) => k !== i))} className="text-terminal-dim hover:text-terminal-red" title="Remove"><X size={13} /></button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <span className="text-xs font-mono text-terminal-muted">Add:</span>
        {EXIT_TYPES.map((ty) => <button key={ty.id} onClick={() => onChange([...triggers, freshTrigger(ty.id)])} className={`${btn} ${idle}`} title={ty.blurb}>{ty.label}</button>)}
      </div>
      <p className="text-[11px] font-mono text-terminal-dim">All triggers run at the same time; the first to fire ends the trade. If several things touch inside the same minute, the stop counts first. R means multiples of the entry-to-stop distance.</p>
    </div>
  );
}
