import { useState, useEffect, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { getAccounts, getDashboardStats, getStartingBalance } from '../lib/api';
import RewardManagementPage from './RewardManagementPage';

const NUM_SLOTS = 6;
const LS_ACCOUNTS = 'rr_slot_accounts'; // localStorage key for selected accounts
const LS_BANKS    = 'rr_slot_banks';    // localStorage key for bank reserve amounts
const LS_CEILING  = 'rr_slot_ceiling';  // localStorage key for per-slot ceiling
const LS_RISK     = 'rr_risk_pct';      // persisted risk % — survives tab switches
const LS_BALANCE  = 'rr_balance';       // persisted account size — survives tab switches

function loadLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

// ── Single Account Slot ────────────────────────────────────────────────────
function AccountSlot({ index, accounts, riskPct, ceiling }) {
  const [selectedName, setSelectedName] = useState(() => loadLS(LS_ACCOUNTS, {})[index] ?? '');
  const [bankReserve,  setBankReserve]  = useState(() => loadLS(LS_BANKS, {})[index] ?? '');
  const [brokerBal,    setBrokerBal]    = useState(null);
  const [loading,      setLoading]      = useState(false);

  // Persist selected account
  useEffect(() => {
    const map = loadLS(LS_ACCOUNTS, {});
    map[index] = selectedName;
    localStorage.setItem(LS_ACCOUNTS, JSON.stringify(map));
  }, [selectedName, index]);

  // Persist bank reserve
  useEffect(() => {
    const map = loadLS(LS_BANKS, {});
    map[index] = bankReserve;
    localStorage.setItem(LS_BANKS, JSON.stringify(map));
  }, [bankReserve, index]);

  // Fetch live broker balance when account changes
  useEffect(() => {
    if (!selectedName) { setBrokerBal(null); return; }
    setLoading(true);
    getDashboardStats({ account: selectedName })
      .then(s => setBrokerBal(s.current_balance ?? 0))
      .catch(() => setBrokerBal(0))
      .finally(() => setLoading(false));
  }, [selectedName]);

  const broker   = brokerBal ?? 0;
  const bank     = parseFloat(bankReserve) || 0;
  const total    = broker + bank;
  const risk     = Math.max(0, parseFloat(riskPct) || 0);
  const riskDollar = total * (risk / 100);
  // What % of broker balance equals the target risk of total capital
  const brokerPct  = broker > 0 ? (riskDollar / broker) * 100 : 0;

  const cap = parseFloat(ceiling) || 0;
  const toTarget = cap > 0 && broker < cap ? cap - broker : null;

  const fmtUSD = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const fmtPct = (n) => n.toFixed(2) + '%';

  const isEmpty = !selectedName;

  return (
    <div className={`card p-4 space-y-3 ${isEmpty ? 'opacity-40' : ''}`}>
      {/* Account selector */}
      <select
        value={selectedName}
        onChange={e => setSelectedName(e.target.value)}
        className="select-field text-xs w-full"
      >
        <option value="">— Select account —</option>
        {accounts.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
      </select>

      {!isEmpty && (
        <>
          {/* Broker balance */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide">With Broker</span>
            <span className={`text-sm font-mono font-semibold ${loading ? 'text-terminal-dim' : 'text-terminal-green'}`}>
              {loading ? '…' : fmtUSD(broker)}
            </span>
          </div>

          {/* Bank reserve — manual */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide whitespace-nowrap">Bank Reserve</span>
            <div className="relative w-32">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-terminal-muted">$</span>
              <input
                type="number"
                value={bankReserve}
                onChange={e => setBankReserve(e.target.value)}
                placeholder="0"
                className="input-field text-xs w-full pl-4 text-right font-mono py-1"
              />
            </div>
          </div>

          {/* Total capital */}
          <div className="flex items-center justify-between border-t border-terminal-border/50 pt-2">
            <span className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide">Total Capital</span>
            <span className="text-sm font-mono font-semibold text-terminal-amber">{fmtUSD(total)}</span>
          </div>

          {/* Risk calculation */}
          {risk > 0 && total > 0 && (
            <div className="bg-terminal-surface rounded p-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-terminal-dim">{fmtPct(risk)} of total</span>
                <span className="text-xs font-mono font-semibold text-terminal-text">{fmtUSD(riskDollar)}</span>
              </div>
              {broker > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-terminal-dim">Set broker risk to</span>
                  <span className="text-sm font-mono font-bold text-blue-400">{fmtPct(brokerPct)}</span>
                </div>
              )}
            </div>
          )}

          {/* Progress to ceiling */}
          {cap > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-terminal-dim">
                  {broker >= cap ? '✓ At ceiling' : `${fmtUSD(toTarget)} to ceiling`}
                </span>
                <span className="text-[10px] font-mono text-terminal-dim">{fmtUSD(cap)}</span>
              </div>
              <div className="w-full bg-terminal-border rounded-full h-1">
                <div
                  className="h-1 rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, cap > 0 ? (broker / cap) * 100 : 0)}%`,
                    backgroundColor: broker >= cap ? '#10b981' : '#f59e0b',
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const LS_SESSION = 'rr_session_trades'; // localStorage key for the live session trades

// ── Session Tracker (Live or Scenario) ───────────────────────────────────────
// Manual cumulative-trade tool. COMPOUNDING 1R: each trade's 1R = risk% × the balance BEFORE that
// trade (or a fixed $). Enter the $ or R result. "Close trading day" files the session as a day below;
// a day can be reopened to fix its trades, or deleted. Live and Scenario keep separate sessions and days.
// Fully standalone — never touches Trade Log or Journal.
function SessionTracker({ mode, baseBalance, riskPct, fixedR = null }) {
  const KEY_TRADES = mode === 'live' ? LS_SESSION : 'rr_session_trades_sim';
  const KEY_DAYS   = mode === 'live' ? 'rr_days_live' : 'rr_days_sim';
  const [trades, setTrades] = useState(() => loadLS(KEY_TRADES, []));
  const [days,   setDays]   = useState(() => loadLS(KEY_DAYS, []));
  const [editingDay, setEditingDay] = useState(null);   // index of the day whose trades are in the box, or null
  const [input,  setInput]  = useState('');
  const [inMode, setInMode] = useState(() => loadLS('rm_session_input_mode', 'usd'));   // 'usd' | 'r'
  const [armDel, setArmDel] = useState(null);

  // switching Live <-> Scenario swaps the stored session and days
  useEffect(() => { setTrades(loadLS(KEY_TRADES, [])); setDays(loadLS(KEY_DAYS, [])); setEditingDay(null); setInput(''); }, [KEY_TRADES, KEY_DAYS]);
  useEffect(() => { localStorage.setItem(KEY_TRADES, JSON.stringify(trades)); }, [trades, KEY_TRADES]);
  useEffect(() => { localStorage.setItem(KEY_DAYS, JSON.stringify(days)); }, [days, KEY_DAYS]);
  useEffect(() => { localStorage.setItem('rm_session_input_mode', JSON.stringify(inMode)); }, [inMode]);

  const risk = Math.max(0, parseFloat(riskPct) || 0);
  const oneRFor = (bal) => (fixedR != null ? fixedR : bal * (risk / 100));
  // walk a list of trades from a starting balance, compounding
  const walk = (start, list) => {
    let running = start;
    const rows = list.map((amt, i) => { const oneR = oneRFor(running); const r = oneR > 0 ? amt / oneR : 0; running += amt; return { i, amt, oneR, r, balanceAfter: running }; });
    const wins = rows.filter(r => r.amt > 0).length, losses = rows.filter(r => r.amt < 0).length;
    return { rows, end: running, pnl: running - start, r: rows.reduce((s, x) => s + x.r, 0), wins, losses };
  };
  // Scenario days chain: each day starts where the last one ended. Live days start from the balance recorded when the day was opened.
  const base = Math.max(0, parseFloat(baseBalance) || 0);
  const dayStarts = [];
  { let run = base; for (const d of days) { const st = mode === 'live' ? (d.start ?? run) : run; dayStarts.push(st); run = walk(st, d.trades).end; } }
  const sessionStart = editingDay != null ? dayStarts[editingDay] : (mode === 'live' ? base : (days.length ? walk(dayStarts[days.length - 1], days[days.length - 1].trades).end : base));
  const B0 = sessionStart;
  const cur = walk(B0, trades);
  const sessionDollar = cur.pnl, sessionR = cur.r, currentBalance = cur.end, wins = cur.wins, losses = cur.losses;
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const nextOneR = oneRFor(currentBalance);

  const addTrade = () => {
    const v = parseFloat(input);
    if (isNaN(v)) { setInput(''); return; }
    setTrades(t => [...t, inMode === 'r' ? Math.round(v * nextOneR * 100) / 100 : v]);
    setInput('');
  };
  const closeDay = () => {
    if (!trades.length) return;
    setDays(d => [...d, { n: d.length + 1, closed: new Date().toISOString(), start: B0, trades }]);
    setTrades([]);
  };
  const openDay = (i) => { setEditingDay(i); setTrades(days[i].trades); setInput(''); };
  const saveDay = () => { setDays(d => d.map((x, i) => (i === editingDay ? { ...x, trades } : x))); setEditingDay(null); setTrades(loadLS(KEY_TRADES + '_parked', [])); localStorage.removeItem(KEY_TRADES + '_parked'); };
  const cancelEdit = () => { setEditingDay(null); setTrades(loadLS(KEY_TRADES + '_parked', [])); localStorage.removeItem(KEY_TRADES + '_parked'); };
  const startEdit = (i) => { localStorage.setItem(KEY_TRADES + '_parked', JSON.stringify(trades)); openDay(i); };
  const deleteDay = (i) => { if (armDel !== i) { setArmDel(i); return; } setArmDel(null); setDays(d => d.filter((_, k) => k !== i).map((x, k) => ({ ...x, n: k + 1 }))); if (editingDay === i) cancelEdit(); };

  const fmtUSD = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  const fmtR   = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
  const posNeg = (n) => n > 0 ? 'text-terminal-green' : n < 0 ? 'text-terminal-red' : 'text-terminal-text';
  const dayLabel = (d, i) => (mode === 'live' ? `${d.closed ? new Date(d.closed).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : `Day ${i + 1}`}` : `Trading Day ${i + 1}`);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="stat-label">{mode === 'live' ? 'Live' : 'Scenario'} Session Tracker{editingDay != null ? ` — editing ${dayLabel(days[editingDay], editingDay)}` : ''}</div>
        {editingDay == null && trades.length > 0 && (
          <button onClick={() => setTrades([])}
            className="text-[10px] font-mono text-terminal-dim hover:text-terminal-red transition-colors uppercase tracking-wide">Reset session</button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="card p-4">
          <div className="stat-label mb-1">Session P&amp;L</div>
          <div className={`text-2xl font-mono font-bold ${posNeg(sessionDollar)}`}>{fmtUSD(sessionDollar)}</div>
          <div className="text-[10px] font-mono text-terminal-dim mt-0.5">{trades.length} trade{trades.length === 1 ? '' : 's'}</div>
        </div>
        <div className="card p-4">
          <div className="stat-label mb-1">Session R</div>
          <div className={`text-2xl font-mono font-bold ${posNeg(sessionR)}`}>{fmtR(sessionR)}</div>
          <div className="text-[10px] font-mono text-terminal-dim mt-0.5">net R booked</div>
        </div>
        <div className="card p-4">
          <div className="stat-label mb-1">Win / Loss</div>
          <div className="text-sm font-mono space-y-0.5">
            <div>W= <span className="text-terminal-green font-semibold">{wins}</span></div>
            <div>L= <span className="text-terminal-red font-semibold">{losses}</span></div>
          </div>
          <div className="text-[10px] font-mono text-terminal-dim mt-0.5">{decided > 0 ? `${winRate.toFixed(0)}%` : '—'} win rate</div>
        </div>
        <div className="card p-4 border-terminal-amber/40">
          <div className="stat-label mb-1">Current Balance</div>
          <div className="text-2xl font-mono font-bold text-terminal-amber">{fmtUSD(currentBalance)}</div>
          <div className="text-[10px] font-mono text-terminal-dim mt-0.5">started {fmtUSD(B0)}</div>
        </div>
      </div>

      {/* Manual trade entry */}
      <div className="card p-4 space-y-3">
        {base <= 0 && <div className="text-[10px] font-mono text-terminal-red">{mode === 'live' ? 'No live balance yet — pick an account above or wait for the balance to load.' : 'Enter an account balance above to begin.'}</div>}
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block">Trade result — {inMode === 'r' ? 'R' : '$'} (negative for a loss)</label>
              <div className="flex items-center rounded border border-terminal-border overflow-hidden">
                <button onClick={() => { setInMode('usd'); setInput(''); }} className={`px-2 py-0.5 text-[10px] font-mono ${inMode === 'usd' ? 'bg-terminal-amber/15 text-terminal-amber' : 'text-terminal-muted hover:text-terminal-text'}`}>$</button>
                <button onClick={() => { setInMode('r'); setInput(''); }} className={`px-2 py-0.5 text-[10px] font-mono border-l border-terminal-border ${inMode === 'r' ? 'bg-terminal-amber/15 text-terminal-amber' : 'text-terminal-muted hover:text-terminal-text'}`}>R</button>
              </div>
              {inMode === 'r' && <span className="text-[10px] font-mono text-terminal-dim">1R for the next trade = {fmtUSD(nextOneR)}{input && !isNaN(parseFloat(input)) ? ` → ${fmtUSD(parseFloat(input) * nextOneR)}` : ''}</span>}
            </div>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">{inMode === 'r' ? 'R' : '$'}</span>
              <input type="number" step="any" value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTrade(); }}
                placeholder={inMode === 'r' ? 'e.g. 2.5 or -1' : 'e.g. 500 or -250'}
                className="input-field text-sm w-full pl-6 font-mono" />
            </div>
          </div>
          <button onClick={addTrade} disabled={base <= 0}
            className="btn-primary px-5 py-2 disabled:opacity-40 whitespace-nowrap">Add Trade</button>
          {editingDay == null ? (
            <button onClick={closeDay} disabled={!trades.length}
              className="px-4 py-2 rounded border border-terminal-border text-xs font-mono text-terminal-text hover:border-terminal-amber hover:text-terminal-amber disabled:opacity-40 whitespace-nowrap">Close trading day</button>
          ) : (
            <>
              <button onClick={saveDay} className="px-4 py-2 rounded border border-terminal-amber text-xs font-mono text-terminal-amber whitespace-nowrap">Save day</button>
              <button onClick={cancelEdit} className="px-3 py-2 rounded border border-terminal-border text-xs font-mono text-terminal-muted whitespace-nowrap">Cancel</button>
            </>
          )}
        </div>

        {cur.rows.length > 0 && (
          <div className="overflow-hidden rounded border border-terminal-border">
            <table className="w-full text-xs font-mono">
              <thead className="bg-terminal-surface text-terminal-dim">
                <tr>
                  <th className="text-left px-3 py-1.5 font-normal">#</th>
                  <th className="text-right px-3 py-1.5 font-normal">Result</th>
                  <th className="text-right px-3 py-1.5 font-normal">1R</th>
                  <th className="text-right px-3 py-1.5 font-normal">R</th>
                  <th className="text-right px-3 py-1.5 font-normal">Balance</th>
                  <th className="px-2" />
                </tr>
              </thead>
              <tbody>
                {cur.rows.map(row => (
                  <tr key={row.i} className="border-t border-terminal-border/40 group">
                    <td className="px-3 py-1.5 text-terminal-dim">{row.i + 1}</td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${posNeg(row.amt)}`}>{fmtUSD(row.amt)}</td>
                    <td className="px-3 py-1.5 text-right text-terminal-muted">{fmtUSD(row.oneR)}</td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${posNeg(row.r)}`}>{fmtR(row.r)}</td>
                    <td className="px-3 py-1.5 text-right text-terminal-text">{fmtUSD(row.balanceAfter)}</td>
                    <td className="px-2 text-right">
                      <button onClick={() => setTrades(t => t.filter((_, i) => i !== row.i))}
                        title="Remove"
                        className="text-terminal-dim hover:text-terminal-red opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Closed trading days */}
      {days.length > 0 && (
        <div className="card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="stat-label">Trading days ({mode === 'live' ? 'live' : 'scenario'})</div>
            <div className="text-[10px] font-mono text-terminal-dim">
              {(() => { const tot = days.reduce((a, d, i) => { const w = walk(dayStarts[i], d.trades); return { pnl: a.pnl + w.pnl, r: a.r + w.r }; }, { pnl: 0, r: 0 }); return <>all days: <span className={posNeg(tot.pnl)}>{fmtUSD(tot.pnl)}</span> · <span className={posNeg(tot.r)}>{fmtR(tot.r)}</span></>; })()}
            </div>
          </div>
          <div className="overflow-hidden rounded border border-terminal-border">
            <table className="w-full text-xs font-mono">
              <thead className="bg-terminal-surface text-terminal-dim">
                <tr>
                  <th className="text-left px-3 py-1.5 font-normal">Day</th>
                  <th className="text-right px-3 py-1.5 font-normal">Trades</th>
                  <th className="text-right px-3 py-1.5 font-normal">W / L</th>
                  <th className="text-right px-3 py-1.5 font-normal">P&amp;L</th>
                  <th className="text-right px-3 py-1.5 font-normal">R</th>
                  <th className="text-right px-3 py-1.5 font-normal">Start</th>
                  <th className="text-right px-3 py-1.5 font-normal">End</th>
                  <th className="px-2" />
                </tr>
              </thead>
              <tbody>
                {days.map((d, i) => { const w = walk(dayStarts[i], d.trades); return (
                  <tr key={i} onClick={() => (editingDay === i ? null : startEdit(i))} title="Click to open this day's trades"
                    className={`border-t border-terminal-border/40 cursor-pointer hover:bg-terminal-hover ${editingDay === i ? 'bg-terminal-amber/10' : ''}`}>
                    <td className="px-3 py-1.5 text-terminal-text">{dayLabel(d, i)}</td>
                    <td className="px-3 py-1.5 text-right text-terminal-muted">{d.trades.length}</td>
                    <td className="px-3 py-1.5 text-right"><span className="text-terminal-green">{w.wins}</span> / <span className="text-terminal-red">{w.losses}</span></td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${posNeg(w.pnl)}`}>{fmtUSD(w.pnl)}</td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${posNeg(w.r)}`}>{fmtR(w.r)}</td>
                    <td className="px-3 py-1.5 text-right text-terminal-muted">{fmtUSD(dayStarts[i])}</td>
                    <td className="px-3 py-1.5 text-right text-terminal-text">{fmtUSD(w.end)}</td>
                    <td className="px-2 text-right whitespace-nowrap">
                      <button onClick={(e) => { e.stopPropagation(); deleteDay(i); }} className={`text-[10px] ${armDel === i ? 'text-terminal-red' : 'text-terminal-dim hover:text-terminal-red'}`}>{armDel === i ? 'click again to delete' : '✕'}</button>
                    </td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] font-mono text-terminal-dim">{mode === 'live' ? 'Each live day starts from the balance recorded when it was opened.' : 'Scenario days chain: each day starts where the last one ended, so fixing an earlier day re-flows the later ones.'} Click a day to open its trades, fix them, then Save day.</div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
// `tab` prop = route-driven mode: /risk, /account-monitor and /reward-management each render
// ONE tab with no internal tab bar (they're separate sidebar entries now). Without the prop the
// page keeps its original 3-tab bar.
export default function RiskManagementPage({ tab }) {
  const [activeTab, setActiveTab] = useState(tab || 'risk'); // 'risk' | 'monitor' | 'reward'
  useEffect(() => { if (tab) setActiveTab(tab); }, [tab]);
  const [balance,     setBalance]     = useState(() => loadLS(LS_BALANCE, ''));
  // Live = the real balance of the chosen account; Scenario = a balance you type (Mike, 2026-10-05)
  const [rmMode,      setRmMode]      = useState(() => loadLS('rm_mode', 'live'));
  const [liveAccount, setLiveAccount] = useState(() => loadLS('rm_live_account', 'All'));
  useEffect(() => { localStorage.setItem('rm_mode', JSON.stringify(rmMode)); }, [rmMode]);
  useEffect(() => { localStorage.setItem('rm_live_account', JSON.stringify(liveAccount)); }, [liveAccount]);
  const [riskPct,     setRiskPct]     = useState(() => loadLS(LS_RISK, '3'));
  // Risk as a % of the account, or a fixed dollar amount per trade (Mike, 2026-10-05)
  const [riskMode,    setRiskMode]    = useState(() => loadLS('rr_risk_mode', 'pct'));
  const [riskUsd,     setRiskUsd]     = useState(() => loadLS('rr_risk_usd', '1000'));
  useEffect(() => { localStorage.setItem('rr_risk_mode', JSON.stringify(riskMode)); }, [riskMode]);
  useEffect(() => { localStorage.setItem('rr_risk_usd', JSON.stringify(riskUsd)); }, [riskUsd]);
  const [liveBalance, setLiveBalance] = useState(null);
  const [copied,   setCopied]   = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [ceiling,  setCeiling]  = useState(() => loadLS(LS_CEILING, '250000'));

  useEffect(() => {
    getAccounts().then(setAccounts).catch(() => {});
    // Fetch the live broker balance. Only pre-fill the account size with it if the
    // user hasn't already set/saved one — otherwise their manual value persists.
    getStartingBalance().then(bal => {
      if (bal?.current_balance) {
        const live = String(Math.round(bal.current_balance));
        setLiveBalance(live);
        if (!loadLS(LS_BALANCE, '')) setBalance(live);
      }
    }).catch(() => {});
  }, []);

  // Persist ceiling, risk %, and account size so they survive leaving the tab
  useEffect(() => { localStorage.setItem(LS_CEILING, JSON.stringify(ceiling)); }, [ceiling]);
  useEffect(() => { localStorage.setItem(LS_RISK,    JSON.stringify(riskPct)); }, [riskPct]);
  useEffect(() => { localStorage.setItem(LS_BALANCE, JSON.stringify(balance)); }, [balance]);

  const bal  = Math.max(0, parseFloat(rmMode === 'live' ? (liveBalance ?? balance) : balance) || 0);
  const risk = Math.max(0, parseFloat(riskPct) || 0);
  const fixedR = Math.max(0, parseFloat(riskUsd) || 0);
  const oneR = riskMode === 'usd' ? fixedR : bal * (risk / 100);
  const fmt  = (n) => '$' + Math.round(n).toLocaleString('en-US');

  const plainText = [
    'RR Numbers:)',
    ...Array.from({ length: 10 }, (_, i) => `${i + 1} - ${fmt(oneR * (i + 1))}`),
  ].join('\n');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(plainText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [plainText]);

  return (
    <div className="p-6 space-y-6">

      {/* ── Tab bar (hidden when route-driven via the tab prop) ───────────── */}
      {!tab && <div className="flex items-center gap-0 border-b border-terminal-border">
        {[
          { key: 'risk',    label: 'Risk Management'   },
          { key: 'monitor', label: 'Account Monitor'   },
          { key: 'reward',  label: 'Trade Compounder'   },
        ].map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`px-5 py-2.5 text-sm font-mono font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === t.key
                ? 'border-blue-400 text-blue-400'
                : 'border-transparent text-terminal-dim hover:text-terminal-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>}

      {/* ── Reward tab ───────────────────────────────────────────────────── */}
      {activeTab === 'reward' && <RewardManagementPage />}

      {/* ── Risk tab ─────────────────────────────────────────────────────── */}
      {activeTab === 'risk' && <div className="space-y-6">

        {/* ── Account Size — single manual entry; feeds RR Calculator + Session Tracker ── */}
        <div className="card p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center rounded border border-terminal-border overflow-hidden">
            <button onClick={() => setRmMode('live')} className={`px-3 py-1.5 text-xs font-mono ${rmMode === 'live' ? 'bg-terminal-green/15 text-terminal-green' : 'text-terminal-muted hover:text-terminal-text'}`}>Live</button>
            <button onClick={() => setRmMode('sim')} className={`px-3 py-1.5 text-xs font-mono border-l border-terminal-border ${rmMode === 'sim' ? 'bg-terminal-amber/15 text-terminal-amber' : 'text-terminal-muted hover:text-terminal-text'}`}>Scenario</button>
          </div>
          {rmMode === 'live' ? (
            <>
              <span className="stat-label">Account</span>
              <select value={liveAccount} onChange={e => setLiveAccount(e.target.value)} className="input-field text-sm font-mono py-1.5 w-56">
                <option value="All">All accounts</option>
                {accounts.map(a => <option key={a.id ?? a.name} value={a.name}>{a.name}</option>)}
              </select>
              <span className="text-base font-mono font-semibold text-terminal-text">{liveBalance ? `$${Number(liveBalance).toLocaleString()}` : '—'}</span>
              <span className="text-[9px] text-terminal-green font-semibold tracking-wide">● LIVE</span>
              <span className="text-[10px] font-mono text-terminal-dim">The real balance from the journal. (The balance is for all accounts together for now; the account name labels your days.)</span>
            </>
          ) : (
            <>
              <span className="stat-label">Account Size</span>
              <div className="relative w-48">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm font-mono text-terminal-muted">$</span>
                <input type="number" value={balance} onChange={e => setBalance(e.target.value)}
                  onFocus={e => e.target.select()}
                  placeholder="0" className="input-field text-base w-full pl-6 font-mono font-semibold" />
              </div>
              <span className="text-[10px] font-mono text-terminal-dim">Scenario — a balance you type; feeds the RR Calculator and the Scenario Session Tracker</span>
            </>
          )}
        </div>

        <div className="flex gap-6 items-start">

        {/* ── Left: RR Calculator ──────────────────────────────────────── */}
        <div className="w-64 flex-shrink-0 space-y-4">
          <div className="stat-label">RR Calculator</div>

          <div className="card p-4 space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-mono text-terminal-muted block">{riskMode === 'usd' ? 'Risk per trade ($)' : 'Risk %'}</label>
                <div className="flex items-center rounded border border-terminal-border overflow-hidden">
                  <button onClick={() => setRiskMode('pct')} className={`px-2 py-0.5 text-[10px] font-mono ${riskMode === 'pct' ? 'bg-terminal-amber/15 text-terminal-amber' : 'text-terminal-muted hover:text-terminal-text'}`}>%</button>
                  <button onClick={() => setRiskMode('usd')} className={`px-2 py-0.5 text-[10px] font-mono border-l border-terminal-border ${riskMode === 'usd' ? 'bg-terminal-amber/15 text-terminal-amber' : 'text-terminal-muted hover:text-terminal-text'}`}>$</button>
                </div>
              </div>
              {riskMode === 'usd' ? (
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">$</span>
                  <input type="number" value={riskUsd} onChange={e => setRiskUsd(e.target.value)} onFocus={e => e.target.select()} placeholder="1000"
                    className="input-field text-base w-full pl-6 font-mono font-semibold" />
                </div>
              ) : (
              <div className="relative">
                <input type="number" value={riskPct} onChange={e => setRiskPct(e.target.value)}
                  onFocus={e => e.target.select()}
                  min="0" max="100" step="0.1"
                  className="input-field text-sm w-full pr-7 text-right font-mono" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">%</span>
              </div>
              )}
            </div>
            <div className="text-xs font-mono text-terminal-muted">
              1R = <span className="text-terminal-amber font-semibold text-sm">{fmt(oneR)}</span>
            </div>
          </div>

          {/* RR Table */}
          <div className="card overflow-hidden">
            <div className="grid grid-cols-2 px-3 py-2 border-b border-terminal-border bg-terminal-surface">
              <span className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">R</span>
              <span className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest text-right">$</span>
            </div>
            {Array.from({ length: 10 }, (_, i) => i + 1).map(r => (
              <div key={r} className={`grid grid-cols-2 px-3 py-2 border-b border-terminal-border/40 last:border-0 ${r % 2 === 0 ? 'bg-terminal-surface/50' : ''}`}>
                <span className="text-xs font-mono text-terminal-muted">{r}R</span>
                <span className="text-xs font-mono font-semibold text-terminal-text text-right">{fmt(oneR * r)}</span>
              </div>
            ))}
          </div>

          {/* Copy */}
          <button onClick={handleCopy}
            className={`w-full flex items-center justify-center gap-2 py-2.5 rounded font-mono text-xs font-semibold transition-all border
              ${copied ? 'bg-green-950 border-green-700 text-terminal-green' : 'bg-terminal-surface border-terminal-border text-terminal-text hover:border-terminal-green hover:text-terminal-green'}`}>
            {copied ? <><Check className="w-3.5 h-3.5" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy for TradingView</>}
          </button>

          {/* Preview */}
          <div className="card p-3">
            <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest mb-1.5">Preview</div>
            <pre className="text-[10px] font-mono text-terminal-muted whitespace-pre leading-4">{plainText}</pre>
          </div>
        </div>

        {/* ── Right: live Session Tracker ──────────────────────────────── */}
        <div className="flex-1">
          <SessionTracker mode={rmMode} baseBalance={bal} riskPct={riskPct} fixedR={riskMode === 'usd' ? fixedR : null} />
        </div>

        </div>
      </div>}

      {/* ── Account Monitor tab (moved out of Risk Management) ──────────── */}
      {activeTab === 'monitor' && <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="stat-label">Account Monitor</div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-terminal-muted">Ceiling $</span>
            <input
              type="number"
              value={ceiling}
              onChange={e => setCeiling(e.target.value)}
              placeholder="250000"
              className="input-field text-xs py-1 w-28 font-mono text-right"
            />
          </div>
        </div>

        <div className="text-[10px] font-mono text-terminal-dim">
          Set broker risk % = {risk}% of (broker + bank reserve). Bank reserve is manual — update before trading.
        </div>

        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: NUM_SLOTS }, (_, i) => (
            <AccountSlot
              key={i}
              index={i}
              accounts={accounts}
              riskPct={riskPct}
              ceiling={ceiling}
            />
          ))}
        </div>
      </div>}

    </div>
  );
}
