import { useEffect, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { tdRisk, tdCreateRisk, tdUpdateRisk, tdDeleteRisk } from '../../lib/api';

// Trading Desk · Risk
// Risk belongs to the ACCOUNT, not the edge (Mike, 2026-10-03). A risk profile says how much an account may risk
// and when it stops for the day. Picked per test in Backtest and per account on the live desk. With several edges
// on one account, the profile is the ceiling they share.

const TYPES = [['demo', 'Demo'], ['live', 'Live'], ['prop', 'Prop firm']];
const Sentence = ({ children }) => <p className="text-sm font-mono text-terminal-text leading-9">{children}</p>;

export default function RiskPage() {
  const [profiles, setProfiles] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [note, setNote] = useState('');
  const [arm, setArm] = useState(false);
  const [error, setError] = useState('');
  const fail = (e) => setError(e?.response?.data?.error || e.message || 'Something went wrong.');
  const reload = async () => { try { const l = await tdRisk(); setProfiles(l); return l; } catch (e) { fail(e); return []; } };
  useEffect(() => { reload(); }, []);
  const profile = profiles.find((p) => p.id === openId) || profiles[0] || null;
  useEffect(() => { setDraft(profile ? { ...profile } : null); setNote(''); setArm(false); }, [profile && profile.id, profile && profile.updated_at]);
  const dirty = draft && profile && JSON.stringify(draft) !== JSON.stringify(profile);
  const set = (k, v) => { setDraft((d) => ({ ...d, [k]: v })); setNote(''); };
  const save = async () => { try { await tdUpdateRisk(profile.id, draft); await reload(); setNote('Saved.'); } catch (e) { setNote(e?.response?.data?.error || e.message); } };
  const create = async () => { try { const p = await tdCreateRisk({ name: `Profile ${profiles.length + 1}` }); await reload(); setOpenId(p.id); } catch (e) { fail(e); } };
  const remove = async () => { if (!arm) { setArm(true); return; } setArm(false); try { await tdDeleteRisk(profile.id); const l = await reload(); setOpenId(l[0]?.id || null); } catch (e) { setNote(e?.response?.data?.error || e.message); } };

  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors';
  const idle = 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover';
  const on = 'border-amber-400 text-amber-400 bg-amber-400/10';
  const inp = 'input-field text-xs font-mono py-1';
  const num = (k, extra = {}) => <input type="number" value={draft[k]} onChange={(e) => set(k, e.target.value === '' ? '' : Number(e.target.value))} className={`${inp} w-24 text-right inline-block mx-1`} {...extra} />;
  const risk = Number(draft?.risk_pct), lim = Number(draft?.daily_loss_pct);
  const maxLosses = risk > 0 && lim > 0 ? Math.floor(lim / risk + 1e-9) : null;

  return (
    <div className="h-full flex min-h-0">
      <div className="w-72 flex-shrink-0 border-r border-terminal-border overflow-y-auto p-2 space-y-1.5">
        <button onClick={create} className={`${btn} ${idle} w-full justify-center`}><Plus size={14} />New risk profile</button>
        {profiles.map((p) => (
          <button key={p.id} onClick={() => setOpenId(p.id)} className={`w-full text-left rounded border px-2 py-1.5 ${profile?.id === p.id ? 'border-amber-400' : 'border-terminal-border hover:bg-terminal-hover'}`}>
            <div className="text-xs font-mono text-terminal-text">{p.name}</div>
            <div className="text-[10px] font-mono text-terminal-dim">{TYPES.find(([t]) => t === p.account_type)?.[1]} · {p.risk_pct}% per trade · stop at {p.daily_loss_pct}% / {p.max_losses_row} in a row</div>
          </button>
        ))}
        {error && <p className="text-xs font-mono text-terminal-red p-2">{error}</p>}
      </div>
      {draft && (
        <div className="flex-1 min-w-0 overflow-y-auto p-4">
          <div className="max-w-3xl space-y-3">
            <div className="flex items-end gap-2">
              <label className="space-y-0.5"><span className="text-[10px] font-mono text-terminal-dim">Name</span><input value={draft.name} onChange={(e) => set('name', e.target.value)} className={`${inp} w-64 block`} /></label>
              <div className="flex items-center gap-1.5 pb-0.5">{TYPES.map(([t, l]) => <button key={t} onClick={() => set('account_type', t)} className={`${btn} ${draft.account_type === t ? on : idle}`}>{l}</button>)}</div>
              <button onClick={save} disabled={!dirty} className={`${btn} ${on} ml-auto disabled:opacity-40`}><Save size={14} />Save</button>
              {profiles.length > 1 && <button onClick={remove} className={`${btn} ${arm ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : idle}`}><Trash2 size={14} />{arm ? 'Click again to delete' : 'Delete'}</button>}
            </div>
            <div className="rounded border border-terminal-border p-4 space-y-1">
              <Sentence>The account starts at $ {num('balance', { step: 100, min: 0 })} and risks {num('risk_pct', { step: 0.1, min: 0 })} % of its balance on any one trade.</Sentence>
              <Sentence>It has at most {num('max_open', { step: 1, min: 1 })} trade{draft.max_open === 1 ? '' : 's'} open at once, and takes at most {num('max_per_day', { step: 1, min: 1 })} per day, across every edge running on it.</Sentence>
              <Sentence>It will not start a trade if losing it would push the day past {num('daily_loss_pct', { step: 0.1, min: 0 })} % lost, and it stops for the day after {num('max_losses_row', { step: 1, min: 1 })} losses in a row.</Sentence>
              {maxLosses != null && <p className="text-[11px] font-mono text-terminal-dim">With {risk}% per trade and a {lim}% daily limit, that is at most {maxLosses} {maxLosses === 1 ? 'loss' : 'losses'} in a day.</p>}
            </div>
            <div className="rounded border border-terminal-border p-4 space-y-1">
              <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest mb-1">Notes</div>
              <textarea rows={3} value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} className={`${inp} w-full resize-y`} placeholder="Prop-firm rules, broker quirks, anything the desk should know about this account" />
            </div>
            <p className="text-[11px] font-mono text-terminal-dim">Trade size on the live desk = this profile's rules × the account's live balance at entry. Nothing here is enforced yet; it is picked by Backtest and the live desk when they exist.</p>
            {note && <p className={`text-xs font-mono ${note === 'Saved.' ? 'text-terminal-green' : 'text-terminal-red'}`}>{note}</p>}
            {dirty && !note && <p className="text-xs font-mono text-amber-400">Unsaved changes.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
