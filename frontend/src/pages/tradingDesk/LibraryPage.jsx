import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, PencilRuler, Undo2 } from 'lucide-react';
import { fmtVanYear, TF_LABEL, describeOutcome, fmtP, setPriceDigits } from './trainerUtil';
import { tdInstruments } from '../../lib/api';
import { useEdges, insideWindow } from './useEdges';
import ClefPanel from './ClefPanel';
import {
  tdExamples, tdPatchExample, tdRemoveExample, tdRemoved, tdRestore, tdImageUrl, tdRemovedImageUrl, tdDestroyRemoved, tdExits, tdSkills,
} from '../../lib/api';

// Trading Desk · Library
// Everything saved from the Trainer, exactly as the models will see it: the pictures, the numbers, the
// notes and the result. Notes, take/skip and the grade can be changed here; the drawing itself is changed
// by opening the example in the Trainer.

const GRADES = [
  { id: 'textbook', label: 'Textbook', cls: 'border-terminal-green text-terminal-green bg-terminal-green/10' },
  { id: 'okay',     label: 'Okay',     cls: 'border-amber-400 text-amber-400 bg-amber-400/10' },
  { id: 'doubtful', label: 'Doubtful', cls: 'border-terminal-red text-terminal-red bg-terminal-red/10' },
];
const PICS = [['top', 'Chart 1'], ['bottom', 'Chart 2'], ['third', 'Chart 3']];
// the moments an example can have pictures for, in order
const MOMENTS = [['step1', 'Point 1 done'], ['step2', 'Point 2 done'], ['step3', 'Point 3 done'], ['decision', 'At the entry (what the model decides from)'], ['exit', 'At the exit (opposite 1-2-3)'], ['full', 'What happened after']];
const momentsOf = (ex) => MOMENTS.filter(([m]) => Object.keys(ex.images || {}).some((n) => n.endsWith(`_${m}`)));
const NOTES = [['notes_entry', 'Why this entry'], ['notes_stop', 'Why the stop goes there'], ['notes_target', 'Why that target'], ['notes_exit', 'Best exit']];
const resultOf = (ex) => ex.outcome?.result || 'open';
const resultText = (ex) => (ex.outcome?.r != null ? `${ex.outcome.r > 0 ? '+' : ''}${ex.outcome.r}R` : 'open');
const resultCls = (ex) => (ex.outcome?.r > 0 ? 'text-terminal-green' : ex.outcome?.r < 0 ? 'text-terminal-red' : 'text-terminal-muted');
const tfsOf = (ex) => (ex.charts?.tfs?.length ? ex.charts.tfs : [ex.top_tf, ex.bottom_tf]);
const keyOf = (ex) => (ex.removed_key ? `r${ex.removed_key}` : `s${ex.id}`);

export default function LibraryPage() {
  const navigate = useNavigate();
  const edgesApi = useEdges();
  const edge = edgesApi.current;
  const [saved, setSaved] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [showRemoved, setShowRemoved] = useState(false);
  const [f, setF] = useState({ setup: '', decision: '', result: '', quality: '' });
  const [openKey, setOpenKey] = useState(null);
  const [moment, setMoment] = useState('decision');   // which pictures: at entry | after
  const [draft, setDraft] = useState(null);           // notes being typed for the open example
  const [note, setNote] = useState('');               // "Saved" / error line
  const [zoom, setZoom] = useState(null);
  const [error, setError] = useState('');
  const [arm, setArm] = useState(null);
  const [instruments, setInstruments] = useState([]);
  const [exitPlans, setExitPlans] = useState([]);
  const [skillList, setSkillList] = useState([]);
  const [skillFilter, setSkillFilter] = useState('');
  useEffect(() => { tdExits().then((r) => setExitPlans(r.plans)).catch(() => {}); tdSkills().then((r) => setSkillList(r.skills.filter((k) => k.kind === 'taught'))).catch(() => {}); }, []);
  useEffect(() => { tdInstruments().then(setInstruments).catch(() => {}); }, []);                 // which destructive button is waiting for its second click

  const fail = (e) => setError(e?.response?.data?.error || e.message || 'Something went wrong.');
  const reload = useCallback(async () => {
    try { const [a, b] = await Promise.all([tdExamples(), tdRemoved()]); setSaved(a); setRemoved(b); } catch (e) { fail(e); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const pool = showRemoved ? removed : saved;
  const setups = useMemo(() => [...new Set(saved.concat(removed).map((e) => e.setup || 'Unnamed'))].sort(), [saved, removed]);
  const list = useMemo(() => pool.filter((e) =>
    (!skillFilter || Object.prototype.hasOwnProperty.call(e.skills || {}, skillFilter)) &&
    (!f.setup || (e.setup || 'Unnamed') === f.setup) && (!f.decision || e.decision === f.decision) &&
    (!f.result || (f.result === 'win' ? e.outcome?.r > 0 : f.result === 'loss' ? e.outcome?.r < 0 : e.outcome?.r == null)) && (!f.quality || (f.quality === 'none' ? !e.quality : e.quality === f.quality))), [pool, f]);
  const ex = list.find((e) => keyOf(e) === openKey) || list[0] || null;
  const isRemoved = !!ex?.removed_key;
  // price decimals follow the example's instrument
  setPriceDigits(instruments.find((i) => i.symbol === (ex?.symbol || 'XAUUSD'))?.digits ?? 2);

  useEffect(() => {
    setDraft(ex ? Object.fromEntries(NOTES.map(([k]) => [k, ex[k] || ''])) : null); setNote('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex && keyOf(ex)]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setZoom(null); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  // the balance of the set: a lopsided set teaches badly, so the counts sit at the top
  const stats = useMemo(() => {
    const by = new Map();
    for (const e of saved) {
      const k = e.setup || 'Unnamed';
      const s = by.get(k) || { setup: k, n: 0, take: 0, skip: 0, win: 0, loss: 0, open: 0, textbook: 0, r: 0 };
      s.n++; s[e.decision === 'skip' ? 'skip' : 'take']++;
      const rr = e.outcome?.r; s[rr == null ? 'open' : rr > 0 ? 'win' : 'loss']++; s.r += rr || 0;
      if (e.quality === 'textbook') s.textbook++;
      by.set(k, s);
    }
    return [...by.values()].sort((a, b) => b.n - a.n);
  }, [saved]);

  const patch = async (fields) => {
    if (!ex || isRemoved) return;
    try {
      const next = await tdPatchExample(ex.id, fields);
      setSaved((all) => all.map((e) => (e.id === next.id ? { ...e, ...next, drawings: undefined } : e)));
      setNote('Saved.');
    } catch (e) { setNote(e?.response?.data?.error || e.message); }
  };
  // dangerous buttons ask twice: the first click arms them, the second does it (no pop-up dialogs)
  const armed = (k) => arm === k;
  const twoStep = (k, fn) => () => { if (armed(k)) { setArm(null); fn(); } else setArm(k); };
  useEffect(() => { setArm(null); }, [openKey, showRemoved]);
  const remove = async () => { try { await tdRemoveExample(ex.id); setOpenKey(null); await reload(); } catch (e) { fail(e); } };
  const destroyOne = async () => { try { await tdDestroyRemoved(ex.removed_key); setOpenKey(null); await reload(); } catch (e) { fail(e); } };
  const emptyTrash = async () => { try { await tdDestroyRemoved(null, edge?.id); setOpenKey(null); await reload(); } catch (e) { fail(e); } };
  const restore = async () => {
    try { const back = await tdRestore(ex.removed_key); await reload(); setShowRemoved(false); setOpenKey(`s${back.id}`); } catch (e) { fail(e); }
  };
  const img = (name) => (isRemoved ? tdRemovedImageUrl(ex.removed_key, name) : `${tdImageUrl(ex.id, name)}?v=${encodeURIComponent(ex.updated_at || '')}`);

  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors';
  const idle = 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover';
  const on = 'border-amber-400 text-amber-400 bg-amber-400/10';
  const label = 'text-[10px] font-mono text-terminal-dim uppercase tracking-widest';
  const sel = 'bg-terminal-surface border border-terminal-border rounded px-2 py-1.5 text-xs font-mono text-terminal-text';
  const row = (k, v, cls = 'text-terminal-text') => (
    <div key={k} className="flex justify-between gap-3"><span className="text-terminal-muted">{k}</span><span className={`${cls} text-right`}>{v}</span></div>
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* the balance of the set */}
      <div className="px-3 py-2 border-b border-terminal-border flex-shrink-0 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs font-mono">
        <span className="text-terminal-text">{saved.length} saved {saved.length === 1 ? 'example' : 'examples'}</span>
        {skillList.map((k) => <span key={k.key} className="text-terminal-muted"><span className="text-sky-400">{k.name}</span>: {saved.filter((e) => e.skills && e.skills[k.key]).length}</span>)}
        {stats.map((s) => (
          <span key={s.setup} className="text-terminal-muted">
            <span className="text-terminal-text">{s.setup}</span>: {s.n} · {s.take} take / {s.skip} skip · <span className="text-terminal-green">{s.win} won</span> / <span className="text-terminal-red">{s.loss} lost</span>{s.open ? ` / ${s.open} open` : ''} · {s.r >= 0 ? '+' : ''}{s.r.toFixed(1)}R · {s.textbook} textbook
          </span>
        ))}
        {saved.length === 0 && <span className="text-terminal-muted">Save an example in the Trainer and it shows up here.</span>}
      </div>

      {/* filters */}
      <div className="px-3 py-2 border-b border-terminal-border flex-shrink-0 flex flex-wrap items-center gap-2">
        <select className={sel} value={f.setup} onChange={(e) => setF({ ...f, setup: e.target.value })}>
          <option value="">Every setup</option>{setups.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className={sel} value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}>
          <option value="">Take and skip</option><option value="take">Take only</option><option value="skip">Skip only</option>
        </select>
        <select className={sel} value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
          <option value="">Any result</option><option value="win">Won</option><option value="loss">Lost</option><option value="open">Not finished</option>
        </select>
        <select className={sel} value={f.quality} onChange={(e) => setF({ ...f, quality: e.target.value })}>
          <option value="">Any grade</option>{GRADES.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}<option value="none">Not graded yet</option>
        </select>
        <span className="text-xs font-mono text-terminal-dim">{list.length} showing</span>
        <select className={`${sel} ml-auto`} value={skillFilter} onChange={(e) => { setSkillFilter(e.target.value); setOpenKey(null); }} title="Show only examples that teach this skill">
          <option value="">Every skill</option>{skillList.map((k) => <option key={k.key} value={k.key}>{k.name}</option>)}
        </select>
        <button onClick={() => { setShowRemoved((v) => !v); setOpenKey(null); }} className={`${btn} ${showRemoved ? on : idle}`}>
          <Trash2 size={14} />{showRemoved ? 'Showing removed examples' : `Removed (${removed.length})`}
        </button>
        {showRemoved && removed.length > 0 && (
          <button onClick={twoStep('all', emptyTrash)} className={`${btn} ${armed('all') ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : idle}`}>
            {armed('all') ? `Click again to delete all ${removed.length} for good` : 'Empty the removed list'}
          </button>
        )}
      </div>
      {error && <div className="px-3 py-1.5 text-xs font-mono text-terminal-red border-b border-terminal-border flex-shrink-0">{error}</div>}

      <div className="flex-1 flex min-h-0">
        {/* the list */}
        <div className="w-80 flex-shrink-0 border-r border-terminal-border overflow-y-auto p-2 space-y-1.5">
          {list.length === 0 && <p className="text-xs font-mono text-terminal-dim p-2">{showRemoved ? 'Nothing has been removed.' : 'No examples match.'}</p>}
          {list.map((e) => {
            const thumb = e.removed_key ? tdRemovedImageUrl(e.removed_key, 'top_decision') : `${tdImageUrl(e.id, 'top_decision')}?v=${encodeURIComponent(e.updated_at || '')}`;
            const g = GRADES.find((x) => x.id === e.quality);
            return (
              <button key={keyOf(e)} onClick={() => setOpenKey(keyOf(e))}
                className={`w-full text-left flex gap-2 rounded border p-1.5 ${ex && keyOf(ex) === keyOf(e) ? 'border-amber-400' : 'border-terminal-border hover:bg-terminal-hover'}`}>
                <img src={thumb} alt="" className="w-24 h-12 object-cover rounded border border-terminal-border flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2 text-xs font-mono">
                    <span className="text-terminal-text truncate">{e.setup || 'Unnamed'}</span>
                    <span className={resultCls(e)}>{resultText(e)}</span>
                  </div>
                  <div className="text-[10px] font-mono text-terminal-muted">#{e.id} · {e.side} · {e.decision}{g ? ` · ${g.label.toLowerCase()}` : ''}</div>
                  <div className="text-[10px] font-mono text-terminal-dim">{fmtVanYear(e.entry_time)}{!insideWindow(edge, e.entry_time, instruments.find((i) => i.symbol === e.symbol)?.market) && <span className="text-amber-400"> · outside window</span>}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* the example */}
        {!ex ? <div className="flex-1" /> : (
          <div className="flex-1 min-w-0 flex min-h-0">
            <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {momentsOf(ex).map(([m, cap]) => <button key={m} onClick={() => setMoment(m)} className={`${btn} ${moment === m ? on : idle}`}>{cap}</button>)}
              </div>
              {PICS.filter(([n]) => ex.images?.[`${n}_${moment}`]).map(([n, cap], i) => (
                <button key={n} onClick={() => setZoom({ src: img(`${n}_${moment}`), cap })} className="block w-full text-left">
                  <div className={label}>{cap} · {TF_LABEL[tfsOf(ex)[i]] || ''}</div>
                  <img src={img(`${n}_${moment}`)} alt={cap} className="w-full rounded border border-terminal-border" />
                </button>
              ))}
              {!Object.keys(ex.images || {}).length && <p className="text-xs font-mono text-terminal-dim">This example has no pictures.</p>}
            </div>

            <div className="w-80 flex-shrink-0 border-l border-terminal-border overflow-y-auto p-3 space-y-3">
              <div className="text-sm font-mono text-terminal-text">Example {ex.id}{isRemoved ? ' (removed)' : ''}</div>
              <div className="rounded border border-terminal-border p-2 space-y-1 text-xs font-mono">
                {row('Setup', ex.setup || 'Unnamed')}
                {row('Teaches', Object.keys(ex.skills || {}).map((k) => skillList.find((s) => s.key === k)?.name || k).join(', ') || '—', 'text-sky-400')}
                {row('Edge tag', edgesApi.edges.find((e) => e.id === ex.edge_id)?.name || '—')}
                {row('Instrument', `${instruments.find((i) => i.symbol === ex.symbol)?.name || ''} ${ex.symbol || ''}`.trim())}
                {row('Direction', ex.side === 'long' ? 'Long' : 'Short')}
                {row('Entry time', fmtVanYear(ex.entry_time))}
                {!insideWindow(edge, ex.entry_time, instruments.find((i) => i.symbol === ex.symbol)?.market) && row('Hunting window', `outside ${edge.window_start}–${edge.window_end}`, 'text-amber-400')}
                {row('Entry', fmtP(ex.entry))}
                {row('Stop', `${fmtP(ex.stop)} (${fmtP(Math.abs(ex.entry - ex.stop))} away)`, 'text-terminal-red')}
                {row('Target', `${fmtP(ex.target)} (${fmtP(Math.abs(ex.target - ex.entry))} away)`, 'text-terminal-green')}
                {row('Risk/reward', `1 : ${(Math.abs(ex.target - ex.entry) / Math.abs(ex.entry - ex.stop)).toFixed(2)}`)}
                {ex.best_exit_price != null && row('Best exit', `${fmtP(ex.best_exit_price)} · ${fmtVanYear(ex.best_exit_time)}`, 'text-purple-400')}
                {row('Charts', tfsOf(ex).map((t) => TF_LABEL[t]).join(' / '))}
                {ex.entry_rule?.points && [1, 2, 3, 4].filter((n) => ex.entry_rule.points[n]).map((n) => row(`Point ${n}`, `${fmtP(ex.entry_rule.points[n].p)} · ${fmtVanYear(ex.entry_rule.points[n].t)}`, n === 4 ? 'text-amber-400' : 'text-sky-400'))}
                {ex.entry_rule?.buffer != null && row('Entry rule', `point 2 + ${ex.entry_rule.buffer} buffer + ${ex.entry_rule.spread} spread`)}
                {ex.entry_rule?.exit?.points && [1, 2, 3, 4].filter((n) => ex.entry_rule.exit.points[n]).map((n) => row(`Exit E${n}`, `${fmtP(ex.entry_rule.exit.points[n].p)} · ${fmtVanYear(ex.entry_rule.exit.points[n].t)}`, n === 4 ? 'text-rose-400' : 'text-orange-400'))}
                {row('Saved', `${ex.created_at} UTC`)}
              </div>

              {!isRemoved && (
                <div className="rounded border border-terminal-border p-2 space-y-1">
                  <div className={label}>Clef's read</div>
                  <ClefPanel exampleId={ex.id} skillNames={Object.fromEntries(skillList.map((k) => [k.key, k.name]))} />
                </div>
              )}
              <div className="rounded border border-terminal-border p-2 space-y-1">
                <div className={label}>Exit plan</div>
                <select disabled={isRemoved} value={ex.exit_plan_id ?? ''} onChange={(e) => patch({ exit_plan_id: Number(e.target.value) })} className="bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text w-full">
                  {exitPlans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <div className={label}>What happened</div>
                <p className="text-xs font-mono text-terminal-text leading-relaxed">{describeOutcome(ex.outcome)}</p>
                {ex.outcome?.best_exit_r != null && <p className="text-xs font-mono text-purple-400">Your best exit was worth {ex.outcome.best_exit_r > 0 ? '+' : ''}{ex.outcome.best_exit_r}R.</p>}
              </div>

              <div className="space-y-1">
                <div className={label}>Would you take it?</div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button disabled={isRemoved} onClick={() => patch({ decision: 'take' })} className={`${btn} justify-center ${ex.decision === 'take' ? 'border-terminal-green text-terminal-green bg-terminal-green/10' : idle}`}>Take it</button>
                  <button disabled={isRemoved} onClick={() => patch({ decision: 'skip' })} className={`${btn} justify-center ${ex.decision === 'skip' ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : idle}`}>Skip it</button>
                </div>
              </div>
              <div className="space-y-1">
                <div className={label}>Trend at the entry (15-minute)</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {[['up', 'Up'], ['down', 'Down'], ['none', 'No trend']].map(([v, l]) => (
                    <button key={v} disabled={isRemoved} onClick={() => patch({ trend: { value: v, tf: 15 } })} className={`${btn} justify-center ${ex.skills?.trend?.value === v ? on : idle}`}>{l}</button>
                  ))}
                </div>
                {ex.skills?.trend?.source === 'ema' && <p className="text-[10px] font-mono text-terminal-dim">EMA guess, not yet confirmed by you.</p>}
              </div>
              <div className="space-y-1">
                <div className={label}>How clean is this example?</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {GRADES.map((g) => (
                    <button key={g.id} disabled={isRemoved} onClick={() => patch({ quality: ex.quality === g.id ? '' : g.id })} className={`${btn} justify-center ${ex.quality === g.id ? g.cls : idle}`}>{g.label}</button>
                  ))}
                </div>
              </div>

              {draft && NOTES.map(([k, title]) => (
                <div key={k} className="space-y-1">
                  <div className={label}>{title}</div>
                  <textarea rows={k === 'notes_entry' ? 3 : 2} readOnly={isRemoved} value={draft[k]} placeholder={isRemoved ? '' : 'Nothing written yet'}
                    onChange={(e) => { setDraft({ ...draft, [k]: e.target.value }); setNote(''); }}
                    onBlur={() => { if (!isRemoved && draft[k] !== (ex[k] || '')) patch({ [k]: draft[k] }); }}
                    className="input-field w-full text-xs font-mono resize-y" />
                </div>
              ))}
              {note && <p className={`text-xs font-mono ${note === 'Saved.' ? 'text-terminal-green' : 'text-terminal-red'}`}>{note}</p>}
              {!isRemoved && <p className="text-[10px] font-mono text-terminal-dim">Notes save when you click out of the box.</p>}

              {isRemoved ? (
                <div className="grid grid-cols-2 gap-1.5">
                  <button onClick={restore} className={`${btn} ${on} justify-center`}><Undo2 size={14} />Put it back</button>
                  <button onClick={twoStep('one', destroyOne)} className={`${btn} justify-center ${armed('one') ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : idle}`}>
                    <Trash2 size={14} />{armed('one') ? 'Click again: gone for good' : 'Delete for good'}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  <button onClick={() => navigate(`/trading-desk/trainer?example=${ex.id}`)} className={`${btn} ${idle} justify-center`} title="Put it back on the charts to change the drawing"><PencilRuler size={14} />Open in Trainer</button>
                  <button onClick={twoStep('remove', remove)} className={`${btn} justify-center ${armed('remove') ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : `${idle} hover:text-terminal-red`}`}>
                    <Trash2 size={14} />{armed('remove') ? 'Click again to remove' : 'Remove'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {zoom && (
        <div className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-6" onClick={() => setZoom(null)}>
          <img src={zoom.src} alt={zoom.cap} className="max-w-full max-h-[92%] rounded border border-terminal-border" />
          <span className="mt-2 text-xs font-mono text-white">{zoom.cap} · click anywhere to close</span>
        </div>
      )}
    </div>
  );
}
