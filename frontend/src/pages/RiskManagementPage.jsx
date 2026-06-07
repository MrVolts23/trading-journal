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

// ── Live Session Tracker ─────────────────────────────────────────────────────
// Manual cumulative-trade tool for live trading. COMPOUNDING 1R: each trade's 1R =
// risk% × the balance BEFORE that trade. Enter the $ result, it reverse-calcs the R.
// Fully standalone — never touches Trade Log or Journal.
function SessionTracker({ balance, riskPct }) {
  const [trades, setTrades] = useState(() => loadLS(LS_SESSION, []));
  const [input,  setInput]  = useState('');

  useEffect(() => { localStorage.setItem(LS_SESSION, JSON.stringify(trades)); }, [trades]);

  const B0   = Math.max(0, parseFloat(balance) || 0);
  const risk = Math.max(0, parseFloat(riskPct) || 0);

  // Walk trades, compounding the balance so 1R grows/shrinks with it
  let running = B0;
  const rows = trades.map((amt, i) => {
    const oneR = running * (risk / 100);          // 1R off the balance BEFORE this trade
    const r    = oneR > 0 ? amt / oneR : 0;
    running   += amt;                              // balance compounds
    return { i, amt, oneR, r, balanceAfter: running };
  });
  const sessionDollar  = running - B0;
  const sessionR       = rows.reduce((s, x) => s + x.r, 0);
  const currentBalance = running;
  const wins    = rows.filter(r => r.amt > 0).length;
  const losses  = rows.filter(r => r.amt < 0).length;
  const decided = wins + losses; // breakeven trades (amt === 0) excluded from win rate
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;

  const addTrade = () => {
    const v = parseFloat(input);
    if (isNaN(v)) { setInput(''); return; }
    setTrades(t => [...t, v]);
    setInput('');
  };

  const fmtUSD = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  const fmtR   = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
  const posNeg = (n) => n > 0 ? 'text-terminal-green' : n < 0 ? 'text-terminal-red' : 'text-terminal-text';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="stat-label">Live Session Tracker</div>
        {trades.length > 0 && (
          <button onClick={() => setTrades([])}
            className="text-[10px] font-mono text-terminal-dim hover:text-terminal-red transition-colors uppercase tracking-wide">Reset session</button>
        )}
      </div>

      {/* Summary — derived from RR Calculator balance + manual entries */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
          <div className="flex items-center justify-between gap-2">
            <div className="space-y-0.5 font-mono text-sm">
              <div><span className="text-terminal-dim">W=</span> <span className="text-terminal-green font-bold">{wins}</span></div>
              <div><span className="text-terminal-dim">L=</span> <span className="text-terminal-red font-bold">{losses}</span></div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-mono font-bold text-terminal-text">{decided > 0 ? `${winRate.toFixed(0)}%` : '—'}</div>
              <div className="text-[10px] font-mono text-terminal-dim">win rate</div>
            </div>
          </div>
        </div>
        <div className="card p-4 border border-terminal-amber/30">
          <div className="stat-label mb-1">Current Balance</div>
          <div className="text-2xl font-mono font-bold text-terminal-amber">{fmtUSD(currentBalance)}</div>
          <div className="text-[10px] font-mono text-terminal-dim mt-0.5">started {fmtUSD(B0)}</div>
        </div>
      </div>

      {/* Manual trade entry */}
      <div className="card p-4 space-y-3">
        {B0 <= 0 && <div className="text-[10px] font-mono text-terminal-red">Enter an account balance in the RR Calculator to begin.</div>}
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block">Trade result — $ (negative for a loss)</label>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">$</span>
              <input type="number" value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTrade(); }}
                placeholder="e.g. 500 or -250"
                className="input-field text-sm w-full pl-6 font-mono" />
            </div>
          </div>
          <button onClick={addTrade} disabled={B0 <= 0}
            className="btn-primary px-5 py-2 disabled:opacity-40 whitespace-nowrap">Add Trade</button>
        </div>

        {rows.length > 0 && (
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
                {rows.map(row => (
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
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function RiskManagementPage() {
  const [activeTab, setActiveTab] = useState('risk'); // 'risk' | 'reward'
  const [balance,     setBalance]     = useState(() => loadLS(LS_BALANCE, ''));
  const [riskPct,     setRiskPct]     = useState(() => loadLS(LS_RISK, '3'));
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

  const bal  = Math.max(0, parseFloat(balance) || 0);
  const risk = Math.max(0, parseFloat(riskPct) || 0);
  const oneR = bal * (risk / 100);
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

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-0 border-b border-terminal-border">
        {[
          { key: 'risk',    label: 'Risk Management'   },
          { key: 'monitor', label: 'Account Monitor'   },
          { key: 'reward',  label: 'Reward Management'  },
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`px-5 py-2.5 text-sm font-mono font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === tab.key
                ? 'border-blue-400 text-blue-400'
                : 'border-transparent text-terminal-dim hover:text-terminal-text'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Reward tab ───────────────────────────────────────────────────── */}
      {activeTab === 'reward' && <RewardManagementPage />}

      {/* ── Risk tab ─────────────────────────────────────────────────────── */}
      {activeTab === 'risk' && <div className="space-y-6">

        {/* ── Account Size — single manual entry; feeds RR Calculator + Session Tracker ── */}
        <div className="card p-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="stat-label">Account Size</span>
            {balance && balance === liveBalance && <span className="text-[9px] text-terminal-green font-semibold tracking-wide">● LIVE</span>}
          </div>
          <div className="relative w-48">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm font-mono text-terminal-muted">$</span>
            <input type="number" value={balance} onChange={e => setBalance(e.target.value)}
              onFocus={e => e.target.select()}
              placeholder="0" className="input-field text-base w-full pl-6 font-mono font-semibold" />
          </div>
          <span className="text-[10px] font-mono text-terminal-dim">Manual — feeds the RR Calculator and the Session Tracker&apos;s starting balance</span>
        </div>

        <div className="flex gap-6 items-start">

        {/* ── Left: RR Calculator ──────────────────────────────────────── */}
        <div className="w-64 flex-shrink-0 space-y-4">
          <div className="stat-label">RR Calculator</div>

          <div className="card p-4 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-terminal-muted block">Risk %</label>
              <div className="relative">
                <input type="number" value={riskPct} onChange={e => setRiskPct(e.target.value)}
                  onFocus={e => e.target.select()}
                  min="0" max="100" step="0.1"
                  className="input-field text-sm w-full pr-7 text-right font-mono" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">%</span>
              </div>
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
          <SessionTracker balance={balance} riskPct={riskPct} />
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
