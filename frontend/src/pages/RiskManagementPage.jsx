import { useState, useEffect, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';
import { getAccounts, getDashboardStats, getStartingBalance } from '../lib/api';

const NUM_SLOTS = 6;
const LS_ACCOUNTS = 'rr_slot_accounts'; // localStorage key for selected accounts
const LS_BANKS    = 'rr_slot_banks';    // localStorage key for bank reserve amounts
const LS_CEILING  = 'rr_slot_ceiling';  // localStorage key for per-slot ceiling

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

// ── Main Page ──────────────────────────────────────────────────────────────
export default function RiskManagementPage() {
  const [balance,  setBalance]  = useState('');
  const [riskPct,  setRiskPct]  = useState('3');
  const [copied,   setCopied]   = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [ceiling,  setCeiling]  = useState(() => loadLS(LS_CEILING, '250000'));

  useEffect(() => {
    getAccounts().then(setAccounts).catch(() => {});
    // Pre-fill balance with live broker balance (deposits + P&L + withdrawals)
    getStartingBalance().then(bal => {
      if (bal?.current_balance) {
        setBalance(String(Math.round(bal.current_balance)));
      }
    }).catch(() => {});
  }, []);

  // Persist ceiling
  useEffect(() => {
    localStorage.setItem(LS_CEILING, JSON.stringify(ceiling));
  }, [ceiling]);

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

      <h1 className="text-lg font-mono font-semibold text-terminal-text">Risk Management</h1>

      <div className="flex gap-6 items-start">

        {/* ── Left: RR Calculator ──────────────────────────────────────── */}
        <div className="w-64 flex-shrink-0 space-y-4">
          <div className="stat-label">RR Calculator</div>

          <div className="card p-4 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-terminal-muted flex items-center gap-2">
                Account Balance
                {balance && <span className="text-[9px] text-terminal-green font-semibold tracking-wide">● LIVE</span>}
              </label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">$</span>
                <input type="number" value={balance} onChange={e => setBalance(e.target.value)}
                  onFocus={e => e.target.select()}
                  placeholder="0" className="input-field text-sm w-full pl-6 font-mono" />
              </div>
            </div>
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

        {/* ── Right: Account Slots ─────────────────────────────────────── */}
        <div className="flex-1 space-y-4">
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
        </div>

      </div>
    </div>
  );
}
