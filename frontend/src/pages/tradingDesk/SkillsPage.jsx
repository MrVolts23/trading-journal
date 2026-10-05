import { useEffect, useState } from 'react';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { tdSkills, tdCreateSkill, tdUpdateSkill, tdDeleteSkill } from '../../lib/api';

// Trading Desk · Skills
// The library of judgements and rules an edge is built from. Two kinds:
//   taught      — Clef answers the skill's questions from pictures; the Trainer's examples teach it
//   arithmetic  — a formula with numbers; nothing to train
// Every skill answers in a fixed shape (yes/no, a choice, a score, or a number) so it can be checked and combined.

const CATEGORIES = [
  { id: 'entry',        label: 'Entries',        blurb: 'What says "get in".' },
  { id: 'exit',         label: 'Exits',          blurb: 'What says "get out". These are the triggers an edge\'s exit is built from.' },
  { id: 'condition',    label: 'Conditions',     blurb: 'What must be true before an entry counts (trend, time of day, market state, news, spread).' },
  { id: 'construction', label: 'Trade construction', blurb: 'Where the stop and target go once in. Examples for now; how they run is still to be worked out.' },
  { id: 'invalidation', label: 'Invalidation',   blurb: 'What cancels an armed setup before entry. Examples for now.' },
];
const QTYPES = [['noul', 'Yes / no'], ['choice', 'A choice'], ['score', 'A score']];
const STATUS = [
  { id: 'not_started', label: 'Not started', dot: 'bg-terminal-red', text: 'text-terminal-red' },
  { id: 'training',    label: 'In training', dot: 'bg-amber-400',   text: 'text-amber-400' },
  { id: 'ready',       label: 'Finished',    dot: 'bg-terminal-green', text: 'text-terminal-green' },
];
const statusOf = (s) => STATUS.find((x) => x.id === s.status) || STATUS[0];

export default function SkillsPage() {
  const [skills, setSkills] = useState([]);
  const [openKey, setOpenKey] = useState(null);
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState('');
  const [arm, setArm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newSkill, setNewSkill] = useState({ name: '', category: 'condition', kind: 'taught', description: '' });
  const [error, setError] = useState('');

  const fail = (e) => setError(e?.response?.data?.error || e.message || 'Something went wrong.');
  const reload = async () => { try { const r = await tdSkills(); setSkills(r.skills); return r.skills; } catch (e) { fail(e); return []; } };
  useEffect(() => { reload(); }, []);
  const skill = skills.find((s) => s.key === openKey) || skills[0] || null;
  useEffect(() => { setDraft(skill ? JSON.parse(JSON.stringify(skill)) : null); setNote(''); setArm(false); }, [skill && skill.key, skill && skill.updated_at]);

  const dirty = draft && skill && JSON.stringify({ a: draft.name, b: draft.description, c: draft.questions, d: draft.params, e: draft.looks_at, f: draft.answer_shape, g: draft.status }) !== JSON.stringify({ a: skill.name, b: skill.description, c: skill.questions, d: skill.params, e: skill.looks_at, f: skill.answer_shape, g: skill.status });
  const save = async () => { try { await tdUpdateSkill(skill.key, draft); await reload(); setNote('Saved.'); } catch (e) { setNote(e?.response?.data?.error || e.message); } };
  const create = async () => { try { const s = await tdCreateSkill(newSkill); await reload(); setOpenKey(s.key); setAdding(false); setNewSkill({ name: '', category: 'condition', kind: 'taught', description: '' }); } catch (e) { setNote(e?.response?.data?.error || e.message); } };
  const remove = async () => {
    if (!arm) { setArm(true); return; }
    setArm(false);
    try { await tdDeleteSkill(skill.key); const list = await reload(); setOpenKey(list[0]?.key || null); } catch (e) { setNote(e?.response?.data?.error || e.message); }
  };

  // questions editor (taught skills)
  const qEntries = draft ? Object.entries(draft.questions || {}) : [];
  const setQ = (id, patch) => setDraft((d) => ({ ...d, questions: { ...d.questions, [id]: { ...d.questions[id], ...patch } } }));
  const renameQ = (id, nid) => setDraft((d) => { const q = {}; for (const [k, v] of Object.entries(d.questions)) q[k === id ? nid : k] = v; return { ...d, questions: q }; });
  const addQ = (type) => setDraft((d) => ({ ...d, questions: { ...d.questions, [`question_${Object.keys(d.questions).length + 1}`]: type === 'choice' ? { type, instructions: '', criteria: { yes: '', no: '' } } : type === 'score' ? { type, criteria: ['Low', 'Medium', 'High'] } : { type, instructions: '' } } }));
  const dropQ = (id) => setDraft((d) => { const q = { ...d.questions }; delete q[id]; return { ...d, questions: q }; });

  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors';
  const idle = 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover';
  const on = 'border-amber-400 text-amber-400 bg-amber-400/10';
  const inp = 'input-field text-xs font-mono py-1';
  const label = 'text-[10px] font-mono text-terminal-dim uppercase tracking-widest';
  const kindBadge = (k) => <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${k === 'taught' ? 'border-sky-400/50 text-sky-400' : 'border-terminal-border text-terminal-muted'}`}>{k === 'taught' ? 'taught' : 'arithmetic'}</span>;

  return (
    <div className="h-full flex min-h-0">
      <div className="w-80 flex-shrink-0 border-r border-terminal-border overflow-y-auto p-2 space-y-3">
        <button onClick={() => setAdding((a) => !a)} className={`${btn} ${adding ? on : idle} w-full justify-center`}><Plus size={14} />New skill</button>
        {adding && (
          <div className="rounded border border-terminal-border p-2 space-y-1.5">
            <input value={newSkill.name} onChange={(e) => setNewSkill({ ...newSkill, name: e.target.value })} placeholder="Name" className={`${inp} w-full`} />
            <select value={newSkill.category} onChange={(e) => setNewSkill({ ...newSkill, category: e.target.value })} className="bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text w-full">
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => setNewSkill({ ...newSkill, kind: 'taught' })} className={`${btn} justify-center ${newSkill.kind === 'taught' ? on : idle}`}>Taught</button>
              <button onClick={() => setNewSkill({ ...newSkill, kind: 'arithmetic' })} className={`${btn} justify-center ${newSkill.kind === 'arithmetic' ? on : idle}`}>Arithmetic</button>
            </div>
            <button onClick={create} className={`${btn} ${on} w-full justify-center`}>Add it</button>
          </div>
        )}
        {CATEGORIES.map((c) => (
          <div key={c.id}>
            <div className={`${label} px-1 mb-1`}>{c.label}</div>
            {skills.filter((s) => s.category === c.id).map((s) => (
              <button key={s.key} onClick={() => setOpenKey(s.key)} className={`w-full text-left rounded border px-2 py-1.5 mb-1 ${skill?.key === s.key ? 'border-amber-400' : 'border-terminal-border hover:bg-terminal-hover'}`}>
                <div className="flex items-center gap-2"><span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusOf(s).dot}`} title={statusOf(s).label} /><span className="text-xs font-mono text-terminal-text truncate flex-1">{s.name}</span>{kindBadge(s.kind)}</div>
                <div className="text-[10px] font-mono text-terminal-dim pl-4">{statusOf(s).label}{s.kind === 'taught' ? ` · ${s.examples} library example${s.examples === 1 ? '' : 's'}` : ' · a formula'}</div>
              </button>
            ))}
          </div>
        ))}
        {error && <p className="text-xs font-mono text-terminal-red p-2">{error}</p>}
      </div>

      {draft && (
        <div className="flex-1 min-w-0 overflow-y-auto p-4">
          <div className="max-w-3xl space-y-3">
            <div className="flex items-end gap-2">
              <label className="space-y-0.5"><span className={label}>Name</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${inp} w-72 block`} /></label>
              <div className="pb-1.5">{kindBadge(draft.kind)} <span className="text-[10px] font-mono text-terminal-dim ml-1">{CATEGORIES.find((c) => c.id === draft.category)?.label}</span></div>
              <button onClick={save} disabled={!dirty} className={`${btn} ${on} ml-auto disabled:opacity-40`}><Save size={14} />Save</button>
              <button onClick={remove} className={`${btn} ${arm ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : idle}`}><Trash2 size={14} />{arm ? 'Click again to delete' : 'Delete'}</button>
            </div>
            <p className="text-[11px] font-mono text-terminal-dim">{CATEGORIES.find((c) => c.id === draft.category)?.blurb}</p>
            <div className="flex items-center gap-1.5">
              <span className={label}>Status</span>
              {STATUS.map((st) => <button key={st.id} onClick={() => setDraft({ ...draft, status: st.id })} className={`${btn} ${draft.status === st.id ? `border-current ${st.text} bg-terminal-surface` : idle}`}><span className={`inline-block w-2 h-2 rounded-full ${st.dot}`} />{st.label}</button>)}
              <span className="text-[10px] font-mono text-terminal-dim ml-2">{draft.status_set ? 'Set by you.' : draft.kind === 'taught' ? 'Worked out from the examples until you set it.' : 'Set it when the formula is done.'}{draft.kind === 'taught' ? ` ${draft.examples} library example${draft.examples === 1 ? '' : 's'} teach this skill.` : ''}</span>
            </div>

            <div className="rounded border border-terminal-border p-3 space-y-2">
              <label className="block space-y-0.5"><span className={label}>What it does, in plain words</span>
                <textarea rows={2} value={draft.description || ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`${inp} w-full resize-y`} /></label>
              <label className="block space-y-0.5"><span className={label}>What it looks at (comma separated)</span>
                <input value={(draft.looks_at || []).join(', ')} onChange={(e) => setDraft({ ...draft, looks_at: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} className={`${inp} w-full`} /></label>
              <label className="block space-y-0.5"><span className={label}>What it answers</span>
                <input value={draft.answer_shape || ''} onChange={(e) => setDraft({ ...draft, answer_shape: e.target.value })} className={`${inp} w-full`} placeholder="e.g. up / down / none" /></label>
            </div>

            {draft.kind === 'taught' ? (
              <div className="rounded border border-sky-400/40 p-3 space-y-2">
                <div className={label}>Questions Clef is asked — word for word</div>
                {qEntries.length === 0 && <p className="text-xs font-mono text-terminal-dim">No questions yet.</p>}
                {qEntries.map(([id, q]) => (
                  <div key={id} className="rounded border border-terminal-border/60 p-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <input value={id} onChange={(e) => renameQ(id, e.target.value.replace(/[^a-z0-9_]/gi, '_'))} className={`${inp} w-40`} title="Short name for the answer" />
                      <span className="text-[10px] font-mono text-terminal-dim">{QTYPES.find(([t]) => t === q.type)?.[1]}</span>
                      <button onClick={() => dropQ(id)} className="ml-auto text-terminal-dim hover:text-terminal-red" title="Remove this question"><X size={13} /></button>
                    </div>
                    {q.type !== 'score' && <input value={q.instructions || ''} onChange={(e) => setQ(id, { instructions: e.target.value })} placeholder="The question, in plain English" className={`${inp} w-full`} />}
                    {q.type === 'choice' && (
                      <div className="space-y-1">
                        {Object.entries(q.criteria || {}).map(([opt, desc]) => (
                          <div key={opt} className="flex items-center gap-1.5">
                            <input value={opt} onChange={(e) => { const c = {}; for (const [k, v] of Object.entries(q.criteria)) c[k === opt ? e.target.value : k] = v; setQ(id, { criteria: c }); }} className={`${inp} w-28`} />
                            <input value={desc} onChange={(e) => setQ(id, { criteria: { ...q.criteria, [opt]: e.target.value } })} placeholder="What this answer means" className={`${inp} flex-1`} />
                            <button onClick={() => { const c = { ...q.criteria }; delete c[opt]; setQ(id, { criteria: c }); }} className="text-terminal-dim hover:text-terminal-red"><X size={12} /></button>
                          </div>
                        ))}
                        <button onClick={() => setQ(id, { criteria: { ...q.criteria, [`option_${Object.keys(q.criteria || {}).length + 1}`]: '' } })} className={`${btn} ${idle}`}>Add an answer</button>
                      </div>
                    )}
                    {q.type === 'score' && (
                      <div className="space-y-1">
                        <div className="text-[10px] font-mono text-terminal-dim">Score steps, lowest first</div>
                        {(q.criteria || []).map((c, i) => (
                          <div key={i} className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-terminal-dim w-4">{i}</span>
                            <input value={c} onChange={(e) => setQ(id, { criteria: q.criteria.map((x, k) => (k === i ? e.target.value : x)) })} className={`${inp} flex-1`} />
                            <button onClick={() => setQ(id, { criteria: q.criteria.filter((_, k) => k !== i) })} className="text-terminal-dim hover:text-terminal-red"><X size={12} /></button>
                          </div>
                        ))}
                        <button onClick={() => setQ(id, { criteria: [...(q.criteria || []), ''] })} className={`${btn} ${idle}`}>Add a step</button>
                      </div>
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-mono text-terminal-muted">Add a question:</span>
                  {QTYPES.map(([t, l]) => <button key={t} onClick={() => addQ(t)} className={`${btn} ${idle}`}>{l}</button>)}
                </div>
                <p className="text-[11px] font-mono text-terminal-dim">Clef answers every question with a probability. Nothing here is a free-form prompt; the answers always come back in these shapes.</p>
              </div>
            ) : (
              <div className="rounded border border-terminal-border p-3 space-y-2">
                <div className={label}>Numbers</div>
                {Object.keys(draft.params || {}).length === 0 && <p className="text-xs font-mono text-terminal-dim">This rule has no numbers to set.</p>}
                {Object.entries(draft.params || {}).map(([k, v]) => (
                  <label key={k} className="flex items-center gap-2 text-xs font-mono text-terminal-text">
                    <span className="w-40 text-terminal-muted">{k.replace(/_/g, ' ')}</span>
                    <input value={v == null ? '' : v} onChange={(e) => { const raw = e.target.value; const num = raw === '' ? null : (isNaN(Number(raw)) ? raw : Number(raw)); setDraft({ ...draft, params: { ...draft.params, [k]: num } }); }} className={`${inp} w-32`} placeholder="blank" />
                  </label>
                ))}
                <p className="text-[11px] font-mono text-terminal-dim">An edge can override these numbers when it uses the skill.</p>
              </div>
            )}
            {note && <p className={`text-xs font-mono ${note === 'Saved.' ? 'text-terminal-green' : 'text-terminal-red'}`}>{note}</p>}
            {dirty && !note && <p className="text-xs font-mono text-amber-400">Unsaved changes.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
