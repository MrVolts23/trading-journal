import { useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useEdges } from './useEdges';
import { TF_LABEL } from './trainerUtil';
import { tdInstruments, tdAddInstrument, tdEdgeCounts, tdExits, tdUpdateExit, tdCreateExit, tdSkills } from '../../lib/api';
import ExitRecipeEditor from './ExitRecipeEditor';

// Trading Desk · Edge
// The rulebook for one edge, written as sentences: when it hunts, how much it risks, how many trades at once,
// when it stops for the day, and the entry settings. The Trainer and Library work inside the selected edge.
// Nothing here trades; "live" is a label until the live desk exists.

const DAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5]]; // market days: Monday starts Sunday afternoon
const STATUS = [
  { id: 'training', label: 'Training', blurb: 'Still being taught. Nothing watches the market.' },
  { id: 'ready',    label: 'Ready',    blurb: 'Taught well enough to try on the demo account when the live desk exists.' },
  { id: 'live',     label: 'Live',     blurb: 'Would be hunting on the live desk. Not wired yet; a label only.' },
];
const TIMEFRAMES = [1, 2, 3, 5, 10, 15, 30, 60, 120, 240];

// These live OUTSIDE the page component on purpose: defining them inside would make React rebuild every box on
// each keystroke, and the cursor would jump out of the field you are typing in.
const Sentence = ({ children }) => <p className="text-sm font-mono text-terminal-text leading-9">{children}</p>;
const Section = ({ title, children }) => (
  <div className="rounded border border-terminal-border p-4 space-y-1">
    <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest mb-2">{title}</div>
    {children}
  </div>
);

// Plain-English readings of the numbers, so a rule can't be misread.
function dayStopBlurb(d) {
  const risk = Number(d.risk_pct), lim = Number(d.daily_loss_pct);
  if (!(risk > 0) || !(lim > 0)) return '';
  const n = Math.floor(lim / risk + 1e-9);
  return `With ${risk}% per trade and a ${lim}% daily limit, that means at most ${n} ${n === 1 ? 'loss' : 'losses'} in a day: a ${n + 1}${['st', 'nd', 'rd'][n] || 'th'} loss would take the day to ${((n + 1) * risk).toFixed(1)}%, so that trade is not started.`;
}
function daysBlurb(d, metal) {
  const days = d.days || [];
  if (!days.length) return 'No days ticked: it never hunts.';
  const open = metal ? '3 PM' : '2 PM';
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
  const start = toMin(d.window_start);
  const bits = [`These are market days: Monday starts Sunday ${open} Vancouver and each day runs to ${open} the next afternoon.`];
  if (start >= toMin(metal ? '15:00' : '14:00')) bits.push(`A ${d.window_start} start is the evening that opens the day, so Monday's window is Sunday evening here, and Friday's window is Thursday evening.`);
  else bits.push(`Monday's window is Monday ${d.window_start} on the clock, Friday's is Friday.`);
  return bits.join(' ');
}

export default function EdgePage() {
  const { edges, current, select, create, update, remove, error } = useEdges();
  const [armDelete, setArmDelete] = useState(false);
  const [counts, setCounts] = useState(null);
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState(null);
  const [instruments, setInstruments] = useState([]);
  const [exitPlans, setExitPlans] = useState([]);
  const [skills, setSkills] = useState([]);
  const [exitTriggers, setExitTriggers] = useState(null);   // this edge's exit recipe (its own exit plan's triggers)
  const [exitSaved, setExitSaved] = useState('');
  useEffect(() => { tdExits().then((r) => setExitPlans(r.plans)).catch(() => {}); tdSkills().then((r) => setSkills(r.skills)).catch(() => {}); }, []);
  useEffect(() => { const p = exitPlans.find((x) => x.id === current?.exit_plan_id); setExitTriggers(p ? JSON.parse(JSON.stringify(p.triggers)) : null); setExitSaved(''); }, [current, exitPlans]);
  // every edge owns its exit recipe: if the plan it points at is shared with another edge, it gets its own copy on save
  const saveExit = async () => {
    try {
      const plan = exitPlans.find((x) => x.id === current.exit_plan_id);
      const shared = edges.some((e) => e.id !== current.id && e.exit_plan_id === current.exit_plan_id);
      if (!plan || shared) { const p = await tdCreateExit({ name: `${current.name} exit`, triggers: exitTriggers }); await update(current.id, { exit_plan_id: p.id }); }
      else await tdUpdateExit(plan.id, { name: plan.name === 'As drawn' ? `${current.name} exit` : plan.name, triggers: exitTriggers });
      const r = await tdExits(); setExitPlans(r.plans); setExitSaved('Exit saved. Examples taught under this edge get their result worked out again.');
    } catch (e) { setExitSaved(e?.response?.data?.error || e.message); }
  };
  const exitDirty = exitTriggers && JSON.stringify(exitTriggers) !== JSON.stringify(exitPlans.find((x) => x.id === current?.exit_plan_id)?.triggers || null);
  // recipe helpers
  const recipe = draft?.recipe || { skills: [], prerequisites: [] };
  const setRecipe = (r) => set('recipe', r);
  const usesSkill = (key) => recipe.skills.some((x) => x.key === key);
  const toggleSkill = (key) => setRecipe({ ...recipe, skills: usesSkill(key) ? recipe.skills.filter((x) => x.key !== key) : [...recipe.skills, { key, min_prob: 0.7, must_match: true }] });
  const setReq = (key, patch) => setRecipe({ ...recipe, skills: recipe.skills.map((x) => (x.key === key ? { ...x, ...patch } : x)) });
  const [adding, setAdding] = useState(false);
  const [newInst, setNewInst] = useState({ symbol: '', name: '', broker: 'Eightcap', digits: 5, market: 'forex' });
  const [instNote, setInstNote] = useState('');
  useEffect(() => { tdInstruments().then(setInstruments).catch(() => {}); }, []);
  const addInstrument = async () => {
    try { const list = await tdAddInstrument(newInst); setInstruments(list); set('symbol', newInst.symbol.toUpperCase()); setAdding(false); setInstNote(''); setNewInst({ symbol: '', name: '', broker: 'Eightcap', digits: 5, market: 'forex' }); }
    catch (e) { setInstNote(e?.response?.data?.error || e.message); }
  };

  useEffect(() => { setDraft(current ? { ...current } : null); setNote(''); }, [current]);
  useEffect(() => { setArmDelete(false); setCount(null); if (current) { tdEdgeCounts(current.id).then(setCounts).catch(() => setCounts(null)); } }, [current]);
  const deleteEdge = async () => {
    if (!armDelete) { setArmDelete(true); return; }
    setArmDelete(false);
    try { await remove(current.id); setNote(''); } catch (e) { setNote(e?.response?.data?.error || e.message); }
  };

  const set = (k, v) => { setDraft((d) => ({ ...d, [k]: v })); setNote(''); };
  const dirty = draft && current && JSON.stringify(draft) !== JSON.stringify(current);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try { await update(current.id, draft); setNote('Saved.'); } catch (e) { setNote(e?.response?.data?.error || e.message); }
    finally { setSaving(false); }
  };
  const newEdge = async () => {
    const name = `Edge ${edges.length + 1}`;
    try { await create({ name }); } catch (e) { setNote(e?.response?.data?.error || e.message); }
  };

  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors';
  const idle = 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover';
  const on = 'border-amber-400 text-amber-400 bg-amber-400/10';
  const inp = 'input-field text-xs font-mono py-1';
  const num = (k, extra = {}) => <input type="number" value={draft[k]} onChange={(e) => set(k, e.target.value === '' ? '' : Number(e.target.value))} className={`${inp} w-20 text-right inline-block mx-1`} {...extra} />;
  const time = (k) => <input type="time" value={draft[k]} onChange={(e) => set(k, e.target.value)} className={`${inp} w-28 inline-block mx-1`} />;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-terminal-border flex-shrink-0">
        <span className="text-xs font-mono text-terminal-muted">Edge</span>
        <select value={current?.id || ''} onChange={(e) => select(Number(e.target.value))} className="bg-terminal-surface border border-amber-400/60 text-amber-400 rounded px-2 py-1.5 text-xs font-mono">
          {edges.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button onClick={newEdge} className={`${btn} ${idle}`}><Plus size={14} />New edge</button>
        {current && <span className="text-xs font-mono text-terminal-dim">{(draft?.recipe?.skills || []).length} skill{(draft?.recipe?.skills || []).length === 1 ? '' : 's'} in the recipe · {counts?.examples ?? '…'} example{counts?.examples === 1 ? '' : 's'} tagged with this edge</span>}
        <button onClick={save} disabled={!dirty || saving} className={`${btn} ${on} ml-auto disabled:opacity-40`}><Save size={14} />{saving ? 'Saving…' : 'Save rulebook'}</button>
        {current && edges.length > 1 && (
          <button onClick={deleteEdge} className={`${btn} ${armDelete ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : idle}`}
            title="Deletes this edge and everything taught under it">
            <Trash2 size={14} />{armDelete ? `Click again: delete "${current.name}" and its ${counts?.examples ?? '?'} examples${counts?.removed ? ` + ${counts.removed} removed` : ''} for good` : 'Delete edge'}
          </button>
        )}
      </div>
      {error && <div className="px-3 py-1.5 text-xs font-mono text-terminal-red border-b border-terminal-border">{error}</div>}

      {draft && (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-3xl space-y-3">
            <Section title="What it is">
              <div className="flex items-end gap-2">
                <label className="space-y-0.5"><span className="text-[10px] font-mono text-terminal-dim">Name (shows in the edge dropdown once saved)</span>
                  <input value={draft.name} onChange={(e) => set('name', e.target.value)} className={`${inp} w-64 block`} placeholder="Name" /></label>
                <label className="space-y-0.5 flex-1"><span className="text-[10px] font-mono text-terminal-dim">What it trades, in one line</span>
                  <input value={draft.description || ''} onChange={(e) => set('description', e.target.value)} className={`${inp} w-full block`} placeholder="One line on what this edge trades" /></label>
              </div>
              <div className="flex items-center gap-1.5 pt-2">
                {STATUS.map((s) => <button key={s.id} onClick={() => set('status', s.id)} className={`${btn} ${draft.status === s.id ? on : idle}`} title={s.blurb}>{s.label}</button>)}
                <span className="text-[11px] font-mono text-terminal-dim ml-2">{STATUS.find((s) => s.id === draft.status)?.blurb}</span>
              </div>
            </Section>

            <Section title="When it hunts">
              <Sentence>It looks for new trades from {time('window_start')} to {time('window_end')} Vancouver time,</Sentence>
              <p className="text-[11px] font-mono text-terminal-dim">This is the entry window only. A trade that is open when the window closes stays open and is managed by the exit plan until an exit fires. Use a "Flat by a time of day" trigger in the exit plan if you want it closed by a set time.</p>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-mono text-terminal-text">on</span>
                {DAYS.map(([label, d]) => (
                  <button key={d} onClick={() => set('days', (draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d]).filter((x) => x >= 1 && x <= 5).sort())} className={`${btn} ${draft.days.includes(d) ? on : idle}`}>{label}</button>
                ))}
              </div>
              <p className="text-[11px] font-mono text-terminal-dim">{daysBlurb(draft, instruments.find((i) => i.symbol === draft.symbol)?.market === 'metal')}</p>
            </Section>

            {/* Risk is an ACCOUNT property, not an edge property (Mike, 2026-10-03): it is set per test in Backtest and per
                account on the live desk. The old risk fields stay in the database untouched; they are just not shown here. */}

            <Section title="What it is built from (skills)">
              <p className="text-[11px] font-mono text-terminal-dim mb-2">Tick the skills this edge uses. For a taught skill, say how sure Clef has to be; "must match the trade direction" means its direction answer has to agree with the setup. Skills are made and taught on the Skills tab.</p>
              {['condition', 'entry', 'construction', 'invalidation'].map((cat) => (
                <div key={cat} className="space-y-1 pb-1">
                  <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">{{ condition: 'Conditions', entry: 'Entry', construction: 'Trade construction', invalidation: 'Invalidation' }[cat]}</div>
                  {skills.filter((k) => k.category === cat).map((k) => {
                    const used = recipe.skills.find((x) => x.key === k.key);
                    return (
                      <div key={k.key} className="flex flex-wrap items-center gap-2 text-xs font-mono">
                        <button onClick={() => toggleSkill(k.key)} className={`${btn} ${used ? on : idle}`}>{k.name}</button>
                        <span className="text-[10px] text-terminal-dim">{k.kind === 'taught' ? 'taught' : 'arithmetic'}</span>
                        {used && k.kind === 'taught' && (
                          <>
                            <span className="text-terminal-muted">Clef must be at least</span>
                            <input type="number" step="5" min="0" max="100" value={Math.round((used.min_prob ?? 0.7) * 100)} onChange={(e) => setReq(k.key, { min_prob: Math.min(100, Math.max(0, Number(e.target.value))) / 100 })} className={`${inp} w-16 text-right`} />
                            <span className="text-terminal-muted">% sure</span>
                            {k.questions && Object.values(k.questions).some((q) => q.type === 'choice') && (
                              <button onClick={() => setReq(k.key, { must_match: !used.must_match })} className={`${btn} ${used.must_match ? on : idle}`}>must match the trade direction</button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </Section>

            <Section title="Prerequisites (plain-English rules this edge follows)">
              {(recipe.prerequisites || []).map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input value={line} onChange={(e) => setRecipe({ ...recipe, prerequisites: recipe.prerequisites.map((x, k) => (k === i ? e.target.value : x)) })} className={`${inp} flex-1`} />
                  <button onClick={() => setRecipe({ ...recipe, prerequisites: recipe.prerequisites.filter((_, k) => k !== i) })} className="text-terminal-dim hover:text-terminal-red text-xs">remove</button>
                </div>
              ))}
              <button onClick={() => setRecipe({ ...recipe, prerequisites: [...(recipe.prerequisites || []), ''] })} className={`${btn} ${idle}`}>Add a rule</button>
              <p className="text-[11px] font-mono text-terminal-dim">For example: "Never against the trend." "After 6:10 PM a 15-minute break must come first." These are written for you and for the chat partner; the ones the app can check mechanically become skills.</p>
            </Section>

            <Section title="How it enters">
              <Sentence>A 1-2-3 entry goes in {num('buffer', { step: 0.05, min: 0 })} past point 2, plus the spread (assumed {num('spread', { step: 0.05, min: 0 })} until the live spread is wired).</Sentence>
              <div className="flex items-center gap-2 text-sm font-mono text-terminal-text">
                <span>Charts it is taught on:</span>
                {[0, 1, 2].map((i) => (
                  <select key={i} value={draft.tfs[i] ?? ''} onChange={(e) => { const v = e.target.value === '' ? null : Number(e.target.value); const t = [...draft.tfs]; if (v == null) t.splice(i, 1); else t[i] = v; set('tfs', t.filter(Boolean)); }}
                    className="bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text">
                    <option value="">{i === 0 ? 'none' : 'no chart'}</option>
                    {TIMEFRAMES.map((t) => <option key={t} value={t}>{TF_LABEL[t]}</option>)}
                  </select>
                ))}
              </div>
            </Section>

            <Section title="How it exits">
              {exitTriggers ? (
                <>
                  <ExitRecipeEditor triggers={exitTriggers} onChange={setExitTriggers} />
                  <div className="flex items-center gap-2 pt-1">
                    <button onClick={saveExit} disabled={!exitDirty} className={`${btn} ${on} disabled:opacity-40`}>Save exit</button>
                    {exitSaved && <span className={`text-xs font-mono ${/^Exit saved/.test(exitSaved) ? 'text-terminal-green' : 'text-terminal-red'}`}>{exitSaved}</span>}
                  </div>
                </>
              ) : <p className="text-xs font-mono text-terminal-dim">Loading the exit…</p>}
            </Section>

            <Section title="What it trades">
              <div className="flex items-center gap-2 text-sm font-mono text-terminal-text">
                <span>It trades</span>
                <select value={draft.symbol} onChange={(e) => set('symbol', e.target.value)} className="bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text">
                  {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.name} · {i.symbol} · {i.broker}</option>)}
                  {!instruments.some((i) => i.symbol === draft.symbol) && <option value={draft.symbol}>{draft.symbol}</option>}
                </select>
                <span>on the demo account.</span>
                <button onClick={() => setAdding((a) => !a)} className={`${btn} ${adding ? on : idle}`}><Plus size={14} />Add an instrument</button>
              </div>
              {adding && (
                <div className="flex flex-wrap items-end gap-2 pt-2">
                  <label className="space-y-0.5"><span className="text-[10px] font-mono text-terminal-dim">Symbol (as the broker names it)</span><input value={newInst.symbol} onChange={(e) => setNewInst({ ...newInst, symbol: e.target.value.toUpperCase() })} placeholder="GBPUSD" className={`${inp} w-32 block`} /></label>
                  <label className="space-y-0.5"><span className="text-[10px] font-mono text-terminal-dim">Name</span><input value={newInst.name} onChange={(e) => setNewInst({ ...newInst, name: e.target.value })} placeholder="Pound / US dollar" className={`${inp} w-44 block`} /></label>
                  <label className="space-y-0.5"><span className="text-[10px] font-mono text-terminal-dim">Broker</span><input value={newInst.broker} onChange={(e) => setNewInst({ ...newInst, broker: e.target.value })} className={`${inp} w-28 block`} /></label>
                  <label className="space-y-0.5"><span className="text-[10px] font-mono text-terminal-dim">Price decimals</span><input type="number" min="0" max="8" value={newInst.digits} onChange={(e) => setNewInst({ ...newInst, digits: Number(e.target.value) })} className={`${inp} w-20 block`} /></label>
                  <label className="space-y-0.5"><span className="text-[10px] font-mono text-terminal-dim">Market</span>
                    <select value={newInst.market} onChange={(e) => setNewInst({ ...newInst, market: e.target.value })} className="bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text block">
                      {['forex', 'metal', 'index', 'crypto', 'other'].map((m) => <option key={m} value={m}>{m}</option>)}
                    </select></label>
                  <button onClick={addInstrument} className={`${btn} ${on}`}>Add it</button>
                  {instNote && <span className="text-xs font-mono text-terminal-red">{instNote}</span>}
                </div>
              )}
              <p className="text-[11px] font-mono text-terminal-dim">The Trainer loads this instrument's candles (and offers to pull 12 months of its history the first time). Live trading is not wired; this page only writes the rules down.</p>
            </Section>

            <Section title="Notes">
              <textarea rows={4} value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} className={`${inp} w-full resize-y`} placeholder="Anything else the desk should know about this edge" />
            </Section>

            {note && <p className={`text-xs font-mono ${note === 'Saved.' ? 'text-terminal-green' : 'text-terminal-red'}`}>{note}</p>}
            {dirty && !note && <p className="text-xs font-mono text-amber-400">Unsaved changes. Click "Save rulebook" at the top.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
