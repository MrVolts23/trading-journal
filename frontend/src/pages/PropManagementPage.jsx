import { useState, useEffect, useMemo } from 'react';
import { Trophy, Plus, RotateCcw, Trash2, AlertTriangle, Check, Clock, Flag, XCircle, Download } from 'lucide-react';
import { createAccount, postBalanceCorrection, updateAccount } from '../lib/api';
import { PRODUCTS, computeState, daysToTarget, pragueDate, pragueTime } from '../lib/propRules';
import { PROP_LS_KEY, PROP_RISK_LS_KEY, loadLS, saveLS, loadPropStore, syncPropAccountFromJournal } from '../lib/propStore';
import NewFtmoAccountForm from '../components/prop/NewFtmoAccountForm';

// Prop Management: log each trade as it closes and watch where you stand against FTMO's lines.
// Manual entry now; MT5 auto-fill replaces the entry box later without changing this screen.
// Nothing here touches the Trade Log or Journal.

const LS_KEY = PROP_LS_KEY;
const LS_RISK = PROP_RISK_LS_KEY;

const fmtUSD = (n, ccy = 'USD') => {
  const v = Number(n) || 0;
  const s = '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
  return (v < 0 ? '-' : '') + s + (ccy !== 'USD' ? ' ' + ccy : '');
};
const fmtSigned = (n, ccy) => (Number(n) > 0 ? '+' : '') + fmtUSD(n, ccy);
const posNeg = (n) => (n > 0 ? 'text-terminal-green' : n < 0 ? 'text-terminal-red' : 'text-terminal-text');
const pct = (n) => (Number(n) * 100).toFixed(0) + '%';

function Bar({ used, total, danger }) {
  const p = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  const color = p >= 100 ? 'bg-terminal-red' : p >= 70 ? 'bg-amber-500' : 'bg-terminal-green';
  return (
    <div className="h-2 rounded bg-terminal-border overflow-hidden mt-2">
      <div className={`h-full ${danger ? 'bg-terminal-red' : color}`} style={{ width: `${p}%` }} />
    </div>
  );
}

export default function PropManagementPage() {
  const [store, setStore] = useState(() => loadLS(LS_KEY, { accounts: [], activeId: null }));
  const [creating, setCreating] = useState(false);
  const [input, setInput] = useState('');
  const [dipInput, setDipInput] = useState('');
  const [riskPct, setRiskPct] = useState(() => loadLS(LS_RISK, 1));
  const [now, setNow] = useState(new Date());
  useEffect(() => { saveLS(LS_KEY, store); }, [store]);
  useEffect(() => { saveLS(LS_RISK, riskPct); }, [riskPct]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const acct = store.accounts.find((a) => a.id === store.activeId) || store.accounts[0] || null;
  const state = useMemo(() => (acct ? computeState(acct) : null), [acct]);
  const updateAcct = (fn) => setStore((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === acct.id ? fn(a) : a)) }));

  const todayKey = pragueDate(now);
  const staleDay = acct && acct.today.date !== todayKey;

  const addTrade = () => {
    const v = parseFloat(input);
    if (isNaN(v) || !acct) { setInput(''); return; }
    updateAcct((a) => ({ ...a, today: { ...a.today, trades: [...a.today.trades, v] } }));
    setInput('');
  };
  const undoTrade = () => updateAcct((a) => ({ ...a, today: { ...a.today, trades: a.today.trades.slice(0, -1) } }));
  const setDip = () => {
    const v = parseFloat(dipInput);
    updateAcct((a) => ({ ...a, today: { ...a.today, worstDip: isNaN(v) ? 0 : -Math.abs(v) } }));
    setDipInput('');
  };
  const endDay = () => updateAcct((a) => ({ ...a, days: [...a.days, { ...a.today }], today: { date: todayKey, trades: [], worstDip: 0 } }));
  const [phaseBusy, setPhaseBusy] = useState(false);
  const [phaseMsg, setPhaseMsg] = useState(null);
  // Manual only: press this when the FTMO dashboard shows the pass. The next phase is a fresh account
  // at the original size, so the journal gets an adjusting entry back to that balance.
  const markPassed = async () => {
    const P = PRODUCTS[acct.product];
    const from = P.phases[acct.phaseIndex]; const to = P.phases[Math.min(acct.phaseIndex + 1, P.phases.length - 1)];
    const shortDays = state.minDays > 0 && state.tradingDays < state.minDays;
    const shortTarget = state.targetAmt != null && !state.targetHit;
    const warn = (shortDays ? `FTMO needs ${state.minDays} trading days in this phase. The tracker has ${state.tradingDays}.\n` : '')
      + (shortTarget ? `The tracker shows ${fmtUSD(state.closedProfit)} of the ${fmtUSD(state.targetAmt)} target.\n` : '');
    if (!window.confirm(`${warn ? 'NOT READY BY THE TRACKER\'S COUNT\n' + warn + '\n' : ''}Mark ${from.label} as passed?\n\nOnly do this once the FTMO dashboard says so. The tracker resets to a fresh ${fmtUSD(acct.size)} for ${to.label}, and the journal gets an adjusting entry back to ${fmtUSD(acct.size)}.`)) return;
    setPhaseBusy(true); setPhaseMsg(null);
    let journalNote = 'no journal account linked';
    if (acct.journalAccountId) {
      // The adjustment removes this phase's profit (or loss) from the journal so the next phase
      // starts at the account size. It is sized off the tracker's balance at the moment of the pass,
      // the real FTMO number, so it is right whether the phase's trades are imported before or after.
      const bal = state.equityNow;
      const amount = Math.round((acct.size - bal) * 100) / 100;
      try {
        if (Math.abs(amount) >= 0.01) {
          await postBalanceCorrection(acct.journalAccountId, { amount, date: todayKey, notes: `FTMO ${from.label} passed at ${fmtUSD(bal)}. ${to.label} starts fresh: balance reset to ${fmtUSD(acct.size)}.` });
          journalNote = `journal adjusted ${fmtSigned(amount)} back to ${fmtUSD(acct.size)}`;
        } else journalNote = 'journal already at the starting balance';
      } catch (e) { journalNote = 'journal entry failed: ' + (e?.response?.data?.error || e.message); }
    }
    updateAcct((a) => ({
      ...a, phaseIndex: Math.min(a.phaseIndex + 1, P.phases.length - 1), days: [], today: { date: todayKey, trades: [], worstDip: 0 }, startDate: todayKey, firstTradeDate: null,
      events: [...(a.events || []), { date: todayKey, type: 'passed', phase: from.label, balance: state.equityNow, journal: journalNote }],
    }));
    setPhaseMsg(`${from.label} marked passed. ${journalNote}.`); setPhaseBusy(false);
  };
  const [linkBusy, setLinkBusy] = useState(false);
  const linkJournal = async () => {
    setLinkBusy(true);
    try {
      const r = await createAccount({ name: acct.name, broker: 'FTMO', currency: acct.currency, initial_deposit: acct.size, deposit_date: acct.startDate });
      updateAcct((a) => ({ ...a, journalAccountId: r?.id ?? null, journalAccountName: a.name }));
      setPhaseMsg(`Journal account "${acct.name}" created with a ${fmtUSD(acct.size)} starting balance.`);
    } catch (e) { setPhaseMsg('Could not create the journal account: ' + (e?.response?.data?.error || e.message)); }
    setLinkBusy(false);
  };
  const markFailed = () => {
    const P = PRODUCTS[acct.product]; const cur = P.phases[acct.phaseIndex];
    if (!window.confirm(`Mark ${cur.label} as failed? The account stays here as a record; start a new attempt with New account.`)) return;
    updateAcct((a) => ({ ...a, failed: true, events: [...(a.events || []), { date: todayKey, type: 'failed', phase: cur.label, balance: state.equityNow }] }));
  };
  // FTMO hands out a new MT5 login for every phase. Keep one per phase and push the full list to the
  // journal account so imports from any phase land in the same place.
  const phaseLogin = acct ? (acct.phaseLogins?.[acct.phaseIndex] ?? (acct.phaseIndex === 0 ? (acct.login || '') : '')) : '';
  const setPhaseLogin = (v) => updateAcct((a) => ({ ...a, phaseLogins: { ...(a.phaseLogins || {}), [a.phaseIndex]: v } }));
  const pushLogins = async () => {
    if (!acct?.journalAccountId) return;
    const all = [acct.login, ...Object.values(acct.phaseLogins || {})].map((x) => String(x || '').trim()).filter(Boolean);
    const list = [...new Set(all)].join(',');
    try { await updateAccount(acct.journalAccountId, { broker_account_id: list || null }); } catch (_) { /* shown on next import instead */ }
  };
  const [syncMsg, setSyncMsg] = useState(null);
  const pullFromJournal = async () => {
    if (!acct?.journalAccountName) { setSyncMsg('Link this account to the journal first.'); return; }
    try {
      const r = await syncPropAccountFromJournal(acct.id, todayKey);
      setStore(loadPropStore());
      setSyncMsg(r ? `Filled from the journal: ${r.synced} trades across ${r.days} day${r.days === 1 ? '' : 's'} since ${acct.startDate}.` : 'Nothing to pull.');
    } catch (e) { setSyncMsg('Could not read the journal: ' + (e?.response?.data?.error || e.message)); }
  };
  const resetPhase = () => updateAcct((a) => ({ ...a, days: [], today: { date: todayKey, trades: [], worstDip: 0 } }));
  const deleteAcct = () => setStore((s) => { const accounts = s.accounts.filter((a) => a.id !== acct.id); return { accounts, activeId: accounts[0]?.id || null }; });

  const riskUsd = state ? (Number(riskPct) || 0) / 100 * state.equityNow : 0;
  const session = useMemo(() => {
    if (!state) return null;
    const risk = (Number(riskPct) || 0) / 100;
    let running = state.today.anchor, r = 0, wins = 0, losses = 0;
    for (const amt of acct.today.trades) {
      const oneR = running * risk;
      if (oneR > 0) r += amt / oneR;
      if (amt > 0) wins++; else if (amt < 0) losses++;
      running += amt;
    }
    const decided = wins + losses;
    return { pnl: running - state.today.anchor, r, wins, losses, winRate: decided ? (wins / decided) * 100 : null, balance: running, started: state.today.anchor, n: acct.today.trades.length };
  }, [state, acct, riskPct]);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2"><Trophy className="w-5 h-5 text-terminal-green" /><h1 className="text-lg font-mono text-terminal-text">Prop Management</h1></div>
          <div className="text-sm text-terminal-muted mt-1">Log each trade as it closes. The cards show where you stand against FTMO's lines.</div>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-terminal-dim">
          <Clock className="w-3.5 h-3.5" /> Prague {pragueTime(now)} · day {todayKey}
        </div>
      </div>

      {/* Account strip */}
      <div className="card p-3 flex items-center gap-3 flex-wrap">
        <select value={acct?.id || ''} onChange={(e) => setStore((s) => ({ ...s, activeId: e.target.value }))} className="input-field text-xs font-mono min-w-[260px]">
          {store.accounts.length === 0 && <option value="">No FTMO account yet</option>}
          {store.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.failed ? 'failed' : PRODUCTS[a.product].phases[a.phaseIndex].label}</option>)}
        </select>
        <button onClick={() => setCreating(true)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-terminal-muted text-xs font-mono text-terminal-text hover:border-terminal-green hover:text-terminal-green"><Plus className="w-3.5 h-3.5" />New account</button>
        {acct && state && (
          <>
            <span className="text-xs font-mono text-terminal-muted flex items-center gap-1.5"><span className="text-terminal-text">{fmtUSD(acct.size, acct.currency)}</span> · leverage 1:{acct.goldLeverage} · {state.phase.label.split(' (')[0].toLowerCase()} started
              <input type="date" value={acct.startDate || ''} onChange={(e) => updateAcct((a) => ({ ...a, startDate: e.target.value }))} className="input-field text-xs font-mono py-1 px-1.5 border-terminal-muted text-terminal-text" title="When this phase really started at FTMO. Drives the day count and the payout clock." /></span>
            <label className="flex items-center gap-1.5 text-xs font-mono text-terminal-muted">login
              <input type="text" value={phaseLogin} onChange={(e) => setPhaseLogin(e.target.value)} onBlur={pushLogins} placeholder="this phase's #" className="input-field w-28 text-xs py-1 px-1.5 border-terminal-muted text-terminal-text" title="The MT5 login FTMO gave you for this phase. Imports match on it." />
            </label>
            <label className="flex items-center gap-1.5 text-xs font-mono text-terminal-muted">risk per trade
              <input type="number" step="0.1" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} className="input-field w-16 font-mono text-xs py-1 text-right border-terminal-muted text-terminal-text" />%
              <span>of balance = <span className="text-terminal-text font-semibold">{fmtUSD(riskUsd)}</span></span>
            </label>
            <div className="ml-auto flex items-center gap-2">
              <span className={`px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wide ${acct.failed ? 'bg-terminal-red/15 text-terminal-red' : 'bg-terminal-border text-terminal-text'}`}>{acct.failed ? 'failed' : state.phase.label}</span>
              {!acct.failed && state.phase.target != null && (
                <button onClick={markPassed} disabled={phaseBusy} title={state.passed ? 'Target and trading days are met' : `Needs the target and ${state.minDays} trading days. You have ${state.tradingDays}.`} className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded border text-xs font-mono disabled:opacity-50 ${state.passed ? 'border-terminal-green/60 text-terminal-green hover:bg-terminal-green/10' : 'border-terminal-muted text-terminal-muted hover:text-terminal-text'}`}><Flag className="w-3.5 h-3.5" />{phaseBusy ? 'Saving...' : `Mark ${state.phase.label.split(' (')[0]} passed`}</button>
              )}
              {!acct.journalAccountId && (
                <button onClick={linkJournal} disabled={linkBusy} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-amber-500/60 text-xs font-mono text-amber-400 hover:bg-amber-500/10 disabled:opacity-50">{linkBusy ? 'Linking...' : 'Link to journal'}</button>
              )}
              <button onClick={pullFromJournal} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-terminal-muted text-xs font-mono text-terminal-text hover:border-terminal-green hover:text-terminal-green" title="Rebuild the day log from trades imported into the journal for this account"><Download className="w-3.5 h-3.5" />Pull from journal</button>
              {!acct.failed && (
                <button onClick={markFailed} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-terminal-muted text-xs font-mono text-terminal-text hover:border-terminal-red hover:text-terminal-red"><XCircle className="w-3.5 h-3.5" />Mark failed</button>
              )}
              <button onClick={() => { if (window.confirm('Reset this phase? All logged days are cleared.')) resetPhase(); }} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-terminal-muted text-xs font-mono text-terminal-text hover:border-amber-400 hover:text-amber-400"><RotateCcw className="w-3.5 h-3.5" />Reset phase</button>
              <button onClick={() => { if (window.confirm('Delete this account from the tracker?')) deleteAcct(); }} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-terminal-muted text-xs font-mono text-terminal-muted hover:border-terminal-red hover:text-terminal-red"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </>
        )}
      </div>

      {acct && (phaseMsg || syncMsg || (acct.events || []).length > 0) && (
        <div className="text-[11px] font-mono text-terminal-dim px-1 space-y-0.5">
          {phaseMsg && <div className="text-terminal-green">{phaseMsg}</div>}
          {syncMsg && <div className="text-terminal-green">{syncMsg}</div>}
          {(acct.events || []).slice().reverse().map((e, i) => (
            <div key={i}>{e.date} · {e.phase} {e.type} at {fmtUSD(e.balance)}{e.journal ? ` · ${e.journal}` : ''}</div>
          ))}
        </div>
      )}
      {creating && <NewFtmoAccountForm onCreate={(a, next) => { setStore(next); setCreating(false); }} onCancel={() => setCreating(false)} />}

      {!acct && !creating && (
        <div className="card p-6 text-sm font-mono text-terminal-dim">Create an FTMO account above to start. Default is 2-Step Standard, $200K, USD.</div>
      )}

      {acct && state && (
        <>
          {/* Status banner */}
          {state.breached && (
            <div className="rounded-lg border border-terminal-red bg-terminal-red/10 px-4 py-3 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-terminal-red" />
              <div className="font-mono text-sm text-terminal-red">STOP. The {state.breach.kind === 'daily' ? 'daily loss line' : 'max loss floor'} was crossed on {state.breach.date}. This phase is failed under FTMO rules.</div>
            </div>
          )}
          {!state.breached && state.passed && (
            <div className="rounded-lg border border-terminal-green bg-terminal-green/10 px-4 py-3 flex items-center gap-3">
              <Check className="w-5 h-5 text-terminal-green" />
              <div className="font-mono text-sm text-terminal-green">Target hit with {state.tradingDays} trading days logged. Close everything and let FTMO review. When their dashboard shows the pass, press Mark passed above.</div>
            </div>
          )}
          {staleDay && (
            <div className="rounded-lg border border-amber-500/60 bg-amber-500/10 px-4 py-2 text-xs font-mono text-amber-400">
              A new Prague day has started since your last entry ({acct.today.date}). Press "End day" so today gets a fresh anchor before logging trades.
            </div>
          )}

          {/* Session cards, same as Risk Management's Live Session Tracker */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="card p-4">
              <div className="stat-label mb-1">Session P&amp;L</div>
              <div className={`text-2xl font-mono font-bold ${posNeg(session.pnl)}`}>{fmtUSD(session.pnl)}</div>
              <div className="text-[10px] font-mono text-terminal-dim mt-0.5">{session.n} trade{session.n === 1 ? '' : 's'} today</div>
            </div>
            <div className="card p-4">
              <div className="stat-label mb-1">Session R</div>
              <div className={`text-2xl font-mono font-bold ${posNeg(session.r)}`}>{(session.r >= 0 ? '+' : '') + session.r.toFixed(2)}R</div>
              <div className="text-[10px] font-mono text-terminal-dim mt-0.5">1R = {riskPct}% of the balance before each trade</div>
            </div>
            <div className="card p-4">
              <div className="stat-label mb-1">Win / Loss</div>
              <div className="flex items-center justify-between gap-2">
                <div className="space-y-0.5 font-mono text-sm">
                  <div><span className="text-terminal-dim">W=</span> <span className="text-terminal-green font-bold">{session.wins}</span></div>
                  <div><span className="text-terminal-dim">L=</span> <span className="text-terminal-red font-bold">{session.losses}</span></div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-mono font-bold text-terminal-text">{session.winRate != null ? `${session.winRate.toFixed(0)}%` : '\u00b7'}</div>
                  <div className="text-[10px] font-mono text-terminal-dim">win rate</div>
                </div>
              </div>
            </div>
            <div className="card p-4 border border-terminal-amber/30">
              <div className="stat-label mb-1">Current Balance</div>
              <div className="text-2xl font-mono font-bold text-terminal-amber">{fmtUSD(session.balance)}</div>
              <div className="text-[10px] font-mono text-terminal-dim mt-0.5">started today {fmtUSD(session.started)}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {/* Entry box + today */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="stat-label">Today · {acct.today.date}</div>
                <div className="text-[11px] font-mono text-terminal-dim">day anchor {fmtUSD(state.today.anchor)} · balance now {fmtUSD(state.equityNow)}</div>
              </div>
              <div className="flex items-end gap-2 flex-wrap">
                <div className="flex-1 min-w-[180px] space-y-1">
                  <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block">Trade result in $ (negative for a loss)</label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">$</span>
                    <input type="number" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTrade(); }} placeholder="e.g. 1500 or -800" disabled={state.breached || acct.failed}
                      className="input-field w-full pl-6 font-mono text-sm py-1.5" />
                  </div>
                </div>
                <button onClick={addTrade} disabled={state.breached || acct.failed} className="px-3 py-2 rounded bg-terminal-green text-black text-xs font-mono font-semibold disabled:opacity-40">Log trade</button>
                <button onClick={undoTrade} disabled={!acct.today.trades.length} className="px-3 py-2 rounded border border-terminal-border text-xs font-mono text-terminal-muted disabled:opacity-40">Undo last</button>
                <div className="w-full lg:w-auto flex items-end gap-2">
                  <div className="space-y-1">
                    <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block">Worst dip today ($ floating)</label>
                    <input type="number" value={dipInput} onChange={(e) => setDipInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setDip(); }} placeholder={acct.today.worstDip ? String(Math.abs(acct.today.worstDip)) : '0'} className="input-field w-36 font-mono text-sm py-1.5" />
                  </div>
                  <button onClick={setDip} className="px-3 py-2 rounded border border-terminal-border text-xs font-mono text-terminal-muted">Set dip</button>
                  <button onClick={endDay} className="px-3 py-2 rounded border border-amber-500/60 text-xs font-mono text-amber-400 hover:bg-amber-500/10">End day</button>
                </div>
              </div>
              <div className="text-[11px] font-mono text-terminal-dim">The daily rule watches equity, not closed balance. If an open trade went {fmtUSD(2000)} against you before it closed green, enter 2000 as the worst dip so the day is judged the way FTMO judges it.</div>
              <table className="w-full text-xs font-mono">
                <thead className="text-terminal-dim"><tr><th className="text-left px-2 py-1">#</th><th className="text-right px-2 py-1">Result</th><th className="text-right px-2 py-1">Balance after</th><th className="text-right px-2 py-1">Daily room after</th><th className="text-right px-2 py-1">Floor room after</th></tr></thead>
                <tbody>
                  {state.today.path.map((eq, i) => (
                    <tr key={i} className="border-t border-terminal-border/60">
                      <td className="px-2 py-1 text-terminal-dim">{i + 1}</td>
                      <td className={`px-2 py-1 text-right ${posNeg(acct.today.trades[i])}`}>{fmtSigned(acct.today.trades[i])}</td>
                      <td className="px-2 py-1 text-right text-terminal-text">{fmtUSD(eq)}</td>
                      <td className={`px-2 py-1 text-right ${eq - state.dailyLine <= 0 ? 'text-terminal-red' : 'text-terminal-muted'}`}>{fmtUSD(eq - state.dailyLine)}</td>
                      <td className={`px-2 py-1 text-right ${eq - state.floor <= 0 ? 'text-terminal-red' : 'text-terminal-muted'}`}>{fmtUSD(eq - state.floor)}</td>
                    </tr>
                  ))}
                  {!acct.today.trades.length && <tr><td colSpan="5" className="px-2 py-3 text-center text-terminal-dim">No trades logged today.</td></tr>}
                </tbody>
              </table>
            </div>

          </div>

          {/* The four cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className={`card p-4 ${state.binding === 'daily' ? 'border border-amber-500/50' : ''}`}>
              <div className="stat-label mb-1">Daily room left</div>
              <div className={`text-2xl font-mono font-bold ${state.dailyRoom <= 0 ? 'text-terminal-red' : 'text-terminal-text'}`}>{fmtUSD(state.dailyRoom, acct.currency)}</div>
              <div className="text-[10px] font-mono text-terminal-dim mt-0.5">line at {fmtUSD(state.dailyLine)} · now {pct(Math.max(0, state.today.anchor - state.equityNow) / state.dailyAllowance)} of today's {fmtUSD(state.dailyAllowance)} used{state.today.dailyRoomUsed > Math.max(0, state.today.anchor - state.equityNow) ? ` · lowest point today ${pct(state.today.dailyRoomUsed / state.dailyAllowance)}` : ''}</div>
              <Bar used={Math.max(0, state.today.anchor - state.equityNow)} total={state.dailyAllowance} danger={state.today.dailyBreach} />
            </div>
            <div className={`card p-4 ${state.binding === 'max' ? 'border border-amber-500/50' : ''}`}>
              <div className="stat-label mb-1">Max loss room left</div>
              <div className={`text-2xl font-mono font-bold ${state.mlRoom <= 0 ? 'text-terminal-red' : 'text-terminal-text'}`}>{fmtUSD(state.mlRoom, acct.currency)}</div>
              <div className="text-[10px] font-mono text-terminal-dim mt-0.5">floor at {fmtUSD(state.floor)}{state.product.maxLossMode === 'trailing' ? ' (trails up at day close)' : ' (fixed)'}</div>
              <Bar used={state.maxLossAmt - state.mlRoom} total={state.maxLossAmt} danger={state.today.mlBreach} />
            </div>
            <div className="card p-4">
              <div className="stat-label mb-1">Risk available</div>
              {(() => { const n = state.lossesToDailyLine(riskUsd) != null ? Math.min(state.lossesToDailyLine(riskUsd), state.lossesToFloor(riskUsd)) : null; const away = Math.min(state.dailyRoom, state.mlRoom); return (
                <>
                  <div className="text-2xl font-mono font-bold text-terminal-text">{n == null ? fmtUSD(away) : `${n} more ${n === 1 ? 'trade' : 'trades'}`}</div>
                  <div className="text-sm font-mono text-terminal-muted mt-1">{n != null ? `at ${fmtUSD(riskUsd)} risk · ` : ''}{fmtUSD(away)} to the {state.binding === 'daily' ? 'daily' : 'max loss'} line</div>
                </>
              ); })()}
            </div>
            <div className="card p-4">
              <div className="stat-label mb-1">{state.targetAmt != null ? `Target ${pct(state.phase.target)}` : 'Funded'}</div>
              {state.targetAmt != null ? (
                <>
                  <div className={`text-2xl font-mono font-bold ${posNeg(state.closedProfit)}`}>{fmtSigned(state.closedProfit, acct.currency)}</div>
                  <div className="text-[10px] font-mono text-terminal-dim mt-0.5">of {fmtUSD(state.targetAmt)} · {state.tradingDays} of {state.minDays} trading days</div>
                  <Bar used={Math.max(0, state.closedProfit)} total={state.targetAmt} />
                </>
              ) : (
                (() => {
                  const split = acct.split || 80;
                  const payout = Math.max(0, state.closedProfit) * split / 100;
                  const tradedDays = (acct.days || []).filter((d) => (d.trades || []).length > 0).map((d) => d.date);
                  if ((acct.today?.trades || []).length > 0) tradedDays.push(acct.today.date);
                  const firstTrade = acct.firstTradeDate || (tradedDays.length ? tradedDays.sort()[0] : null);
                  const toUtc = (k) => Date.UTC(...k.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
                  const eligible = firstTrade ? new Date(toUtc(firstTrade) + 14 * 86400000).toISOString().slice(0, 10) : null;
                  const daysToGo = eligible ? Math.ceil((toUtc(eligible) - toUtc(todayKey)) / 86400000) : null;
                  return (
                    <>
                      <div className="flex items-stretch flex-wrap">
                        <div className="pr-6">
                          <div className="text-2xl font-mono font-bold text-terminal-text leading-tight">{fmtSigned(state.closedProfit, acct.currency)}</div>
                          <div className="text-[10px] font-mono text-terminal-dim mt-1">profit above start</div>
                        </div>
                        <div className="pl-6 border-l border-terminal-border">
                          <div className="text-2xl font-mono font-bold text-terminal-green leading-tight">{fmtUSD(payout, acct.currency)}</div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] font-mono text-terminal-dim">you receive at</span>
                            <div className="flex rounded border border-terminal-border overflow-hidden">
                              {[80, 90].map((v) => (
                                <button key={v} onClick={() => updateAcct((a) => ({ ...a, split: v }))} className={`px-2 py-0.5 text-[10px] font-mono leading-none ${split === v ? 'bg-terminal-green/20 text-terminal-green' : 'text-terminal-muted hover:text-terminal-text'}`}>{v}%</button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="text-[11px] font-mono text-terminal-muted mt-3 pt-2 border-t border-terminal-border">
                        {!firstTrade ? 'first payout opens 14 calendar days after your first funded trade'
                          : daysToGo > 0 ? `first payout opens ${eligible} · ${daysToGo} ${daysToGo === 1 ? 'day' : 'days'} to go`
                          : 'payout window open · request it with no open or pending orders'}
                        <span className="inline-flex items-center gap-1 ml-2 text-terminal-dim">· first funded trade
                          <input type="date" value={firstTrade || ''} onChange={(e) => updateAcct((a) => ({ ...a, firstTradeDate: e.target.value || null }))} className="input-field text-[10px] font-mono py-0 px-1" title="The day of your first trade on the funded account at FTMO. The 14-day payout clock counts from here." />
                        </span>
                      </div>
                    </>
                  );
                })()
              )}
            </div>
          </div>

          {state.bestDayRule && (
            <div className="card p-3 text-xs font-mono text-terminal-muted">
              Best Day rule: your best day is {fmtUSD(state.bestDay)} of {fmtUSD(state.positiveDaysProfit)} made on positive days ({state.positiveDaysProfit > 0 ? pct(state.bestDay / state.positiveDaysProfit) : '0%'}). {state.bestDayOk ? <span className="text-terminal-green">Within the 50% limit.</span> : <span className="text-amber-400">Over 50%. You need {fmtUSD(state.bestDayNeeded)} more profit on other days before this phase can pass.</span>}
            </div>
          )}

          {/* Day log */}
          <div className="card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="stat-label">Day log (Prague days)</div>
              <div className="text-[11px] font-mono text-terminal-dim">{state.days.filter((d) => d.counted).length} counted days · {state.targetAmt != null && daysToTarget(state, Math.max(1, riskUsd * 2)) != null ? `${daysToTarget(state, riskUsd * 2)} more days at +2R per day to the target` : ''}</div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-terminal-dim"><tr><th className="text-left px-2 py-1">Day</th><th className="text-right px-2 py-1">Trades</th><th className="text-right px-2 py-1">Closed P&amp;L</th><th className="text-right px-2 py-1">Worst dip</th><th className="text-right px-2 py-1">Daily room used</th><th className="text-right px-2 py-1">Balance at close</th><th className="text-left px-2 py-1">Counted</th><th className="text-left px-2 py-1">Status</th></tr></thead>
                <tbody>
                  {state.days.map((d, i) => (
                    <tr key={`${d.date}-${i}`} className="border-t border-terminal-border/60">
                      <td className="px-2 py-1 text-terminal-text">{d.date}</td>
                      <td className="px-2 py-1 text-right text-terminal-muted">{d.trades.length}</td>
                      <td className={`px-2 py-1 text-right ${posNeg(d.pnl)}`}>{fmtSigned(d.pnl)}</td>
                      <td className="px-2 py-1 text-right text-terminal-muted">{d.worstDip ? fmtUSD(d.worstDip) : '·'}</td>
                      <td className="px-2 py-1 text-right text-terminal-muted">{fmtUSD(d.dailyRoomUsed)} ({pct(d.dailyRoomUsed / d.dailyAllowance)})</td>
                      <td className="px-2 py-1 text-right text-terminal-text">{fmtUSD(d.close)}</td>
                      <td className="px-2 py-1">{d.counted ? <span className="text-terminal-green">yes</span> : <span className="text-terminal-dim">no</span>}</td>
                      <td className="px-2 py-1">{d.dailyBreach ? <span className="text-terminal-red">daily line crossed</span> : d.mlBreach ? <span className="text-terminal-red">floor crossed</span> : <span className="text-terminal-dim">ok</span>}</td>
                    </tr>
                  ))}
                  {!state.days.length && <tr><td colSpan="8" className="px-2 py-3 text-center text-terminal-dim">No days closed yet. Log today's trades, then press End day.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
