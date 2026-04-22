import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { getAccounts, getDashboardStats, getSettings, updateSettings } from '../lib/api';

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1000)      return sign + '$' + (abs / 1000).toFixed(1) + 'k';
  return sign + '$' + abs.toFixed(0);
}

function fmtFull(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// ── Trade generation ───────────────────────────────────────────────────────────
function generateTrades(startBal, targetBal, riskPct, rrRatio, winRate, mode) {
  if (!startBal || !targetBal || startBal <= 0 || targetBal <= startBal) return [];
  const MAX = 5000;
  const r  = riskPct / 100;
  const wr = winRate / 100;
  const trades = [];
  let bal = startBal;

  if (mode === 'ev') {
    // Expected value per trade as fraction of balance
    const evFrac = wr * r * rrRatio - (1 - wr) * r;
    if (evFrac <= 0) return [];
    for (let i = 0; i < MAX && bal < targetBal; i++) {
      const before   = bal;
      const riskAmt  = before * r;
      const change   = before * evFrac;
      bal = before + change;
      trades.push({ n: i + 1, before, riskAmt, change, after: Math.min(bal, targetBal), isWin: null });
    }
  } else {
    // Simulated — deterministic Bresenham-style win distribution
    for (let i = 0; i < MAX && bal > 0 && bal < targetBal; i++) {
      const before  = bal;
      const riskAmt = before * r;
      const isWin   = Math.floor((i + 1) * wr) > Math.floor(i * wr);
      const change  = isWin ? riskAmt * rrRatio : -riskAmt;
      bal = before + change;
      trades.push({ n: i + 1, before, riskAmt, change, after: bal, isWin });
    }
  }
  return trades;
}

const DEFAULT_MILESTONES = [1000, 5000, 10000, 25000, 50000, 75000, 100000];
const DEFAULT_PARAMS = {
  startBal: 10000, targetBal: 100000,
  riskPct: 5, rrRatio: 1, winRate: 60,
  mode: 'ev', milestones: DEFAULT_MILESTONES,
};

// ── Component ──────────────────────────────────────────────────────────────────
export default function RewardManagementPage() {
  const [accounts,        setAccounts]        = useState([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [params,          setParams]          = useState(DEFAULT_PARAMS);
  const [scrubIdx,        setScrubIdx]        = useState(0);
  const [leftMode,        setLeftMode]        = useState('remaining'); // 'remaining' | 'total'
  const [newMilestone,    setNewMilestone]    = useState('');
  const [settled,         setSettled]         = useState(false); // settings loaded
  const saveTimer = useRef(null);
  const rowRefs   = useRef({});

  // Load persisted settings
  useEffect(() => {
    getSettings()
      .then(s => { if (s.compounder) setParams(p => ({ ...DEFAULT_PARAMS, ...s.compounder })); })
      .catch(() => {})
      .finally(() => setSettled(true));
    getAccounts().then(a => { setAccounts(a); if (a.length) setSelectedAccount(a[0].name); }).catch(() => {});
  }, []);

  // Auto-fill start balance from account
  useEffect(() => {
    if (!selectedAccount) return;
    getDashboardStats({ account: selectedAccount })
      .then(s => { if (s.current_balance != null) set('startBal', Math.round(s.current_balance)); })
      .catch(() => {});
  }, [selectedAccount]);

  // Persist after changes (debounced)
  useEffect(() => {
    if (!settled) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => updateSettings({ compounder: params }).catch(() => {}), 800);
  }, [params, settled]);

  // Reset scrub when trades list changes length significantly
  const prevLen = useRef(0);
  const trades = generateTrades(params.startBal, params.targetBal, params.riskPct, params.rrRatio, params.winRate, params.mode);
  if (Math.abs(trades.length - prevLen.current) > 5) { prevLen.current = trades.length; }

  const set = (k, v) => setParams(p => ({ ...p, [k]: v }));
  const maxIdx     = Math.max(0, trades.length - 1);
  const safeIdx    = Math.min(scrubIdx, maxIdx);
  const current    = trades[safeIdx] || null;
  const progress   = current ? Math.max(0, Math.min(100, ((current.after - params.startBal) / (params.targetBal - params.startBal)) * 100)) : 0;
  const negEV      = params.mode === 'ev' && ((params.winRate / 100) * (params.riskPct / 100) * params.rrRatio - (1 - params.winRate / 100) * (params.riskPct / 100)) <= 0;
  const tradesLeft = leftMode === 'remaining' ? trades.length - safeIdx - 1 : trades.length;

  // Scroll selected row into view
  useEffect(() => {
    rowRefs.current[safeIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [safeIdx]);

  // Milestones with trade numbers
  const milestoneRows = [...params.milestones]
    .filter(m => m > params.startBal && m <= params.targetBal)
    .sort((a, b) => a - b)
    .map(m => ({ amount: m, tradeNum: trades.findIndex(t => t.after >= m) + 1 || null }));

  const addMilestone = () => {
    const v = parseFloat(newMilestone);
    if (v > 0 && !params.milestones.includes(v)) set('milestones', [...params.milestones, v].sort((a, b) => a - b));
    setNewMilestone('');
  };

  return (
    <div className="p-6 space-y-5">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Trade Compounder</div>
          <div className="text-lg font-mono font-bold text-terminal-green mt-0.5">
            {fmt(params.startBal)} → {fmt(params.targetBal)}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Account picker */}
          <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)}
            className="input-field text-xs py-1.5">
            <option value="">Manual</option>
            {accounts.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
          {/* Mode toggle */}
          <button
            onClick={() => { set('mode', params.mode === 'ev' ? 'sim' : 'ev'); setScrubIdx(0); }}
            className={`text-xs font-mono font-semibold px-3 py-1.5 rounded border transition-colors ${
              params.mode === 'ev'
                ? 'bg-terminal-green/10 border-terminal-green/50 text-terminal-green'
                : 'bg-amber-900/20 border-amber-600/50 text-amber-400'
            }`}
          >
            {params.mode === 'ev' ? '⟨ Expected Value ⟩' : '⟨ Simulated ⟩'}
          </button>
          {/* Trades required */}
          <div className="text-right">
            <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Trades Required</div>
            <div className="text-2xl font-mono font-bold text-terminal-text">{trades.length || '—'}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[300px_1fr] gap-6 items-start">

        {/* ── LEFT: Parameters + Milestones ──────────────────────────────── */}
        <div className="space-y-4">
          <div className="card p-4 space-y-4">
            <div className="stat-label">Parameters</div>

            {/* Starting Balance */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Starting Balance ($)</label>
                <input type="number" value={params.startBal}
                  onChange={e => set('startBal', parseFloat(e.target.value) || 0)}
                  className="input-field text-xs py-1 w-28 text-right font-mono" />
              </div>
              <input type="range" min={100} max={500000} step={100} value={params.startBal}
                onChange={e => set('startBal', parseFloat(e.target.value))}
                className="w-full accent-terminal-green h-1" />
            </div>

            {/* Target Balance */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Target Balance ($)</label>
                <input type="number" value={params.targetBal}
                  onChange={e => set('targetBal', parseFloat(e.target.value) || 0)}
                  className="input-field text-xs py-1 w-28 text-right font-mono" />
              </div>
              <input type="range" min={1000} max={10000000} step={1000} value={params.targetBal}
                onChange={e => set('targetBal', parseFloat(e.target.value))}
                className="w-full accent-terminal-green h-1" />
            </div>

            {/* Risk Per Trade */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Risk Per Trade</label>
                <span className="text-xs font-mono font-bold text-terminal-green">{params.riskPct}%</span>
              </div>
              <input type="range" min={0.5} max={25} step={0.5} value={params.riskPct}
                onChange={e => set('riskPct', parseFloat(e.target.value))}
                className="w-full accent-terminal-green h-1" />
            </div>

            {/* R:R Ratio */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Reward : Risk Ratio</label>
                <span className="text-xs font-mono font-bold text-amber-400">{params.rrRatio}:1</span>
              </div>
              <input type="range" min={0.5} max={10} step={0.5} value={params.rrRatio}
                onChange={e => set('rrRatio', parseFloat(e.target.value))}
                className="w-full accent-amber-400 h-1" />
            </div>

            {/* Win Rate */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Win Rate</label>
                <div className="flex items-center gap-1">
                  <input type="number" min={1} max={100} value={params.winRate}
                    onChange={e => set('winRate', Math.min(100, Math.max(1, parseFloat(e.target.value) || 1)))}
                    className="input-field text-xs py-1 w-14 text-right font-mono" />
                  <span className="text-xs font-mono text-terminal-muted">%</span>
                </div>
              </div>
              <input type="range" min={1} max={100} step={1} value={params.winRate}
                onChange={e => set('winRate', parseFloat(e.target.value))}
                className={`w-full h-1 ${params.winRate >= 50 ? 'accent-terminal-green' : 'accent-red-500'}`} />
              {negEV && (
                <div className="text-[10px] font-mono text-red-400 pt-0.5">
                  ⚠ Negative expectancy — raise win rate or R:R ratio
                </div>
              )}
            </div>
          </div>

          {/* Milestones */}
          <div className="card p-4 space-y-3">
            <div className="stat-label">Milestones</div>
            <div className="space-y-0">
              {milestoneRows.map(m => (
                <div key={m.amount} className="flex items-center justify-between py-1.5 border-b border-terminal-border/30 last:border-0">
                  <div className="flex items-center gap-2">
                    <button onClick={() => set('milestones', params.milestones.filter(x => x !== m.amount))}
                      className="text-terminal-dim hover:text-terminal-red transition-colors">
                      <Trash2 className="w-3 h-3" />
                    </button>
                    <span className="text-sm font-mono text-terminal-text">▸ {fmt(m.amount)}</span>
                  </div>
                  <span className="text-xs font-mono text-terminal-dim">
                    {m.tradeNum ? `trade #${m.tradeNum}` : 'unreachable'}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input type="number" value={newMilestone} onChange={e => setNewMilestone(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addMilestone()}
                placeholder="e.g. 50000" className="input-field text-xs py-1.5 flex-1" />
              <button onClick={addMilestone} className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add
              </button>
            </div>
          </div>
        </div>

        {/* ── RIGHT: Card + Scrub + Table ─────────────────────────────────── */}
        <div className="space-y-4">
          {negEV && params.mode === 'ev' ? (
            <div className="card p-10 flex items-center justify-center text-terminal-red font-mono text-sm">
              Negative expectancy — adjust your win rate or R:R ratio
            </div>
          ) : trades.length === 0 ? (
            <div className="card p-10 flex items-center justify-center text-terminal-muted font-mono text-sm">
              Set a target higher than your starting balance to begin
            </div>
          ) : (<>

            {/* Trade card */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Trade #{safeIdx + 1}</span>
                <span className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Progress to Target</span>
              </div>
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-3xl font-mono font-bold text-terminal-text">{fmtFull(current?.after)}</div>
                  <div className={`text-sm font-mono font-semibold mt-0.5 ${(current?.change ?? 0) >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                    {(current?.change ?? 0) >= 0 ? '+' : ''}{fmtFull(current?.change)}
                    {params.mode === 'sim' && current && (
                      <span className="ml-1.5 text-[10px] text-terminal-dim">{current.isWin ? 'win' : 'loss'}</span>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-mono font-bold text-terminal-text">{progress.toFixed(1)}%</div>
                  <div className="text-xs font-mono text-terminal-dim">{fmtFull(params.targetBal - (current?.after ?? params.startBal))} remaining</div>
                </div>
              </div>
              {/* Progress bar */}
              <div className="h-1.5 bg-terminal-surface rounded-full overflow-hidden">
                <div className="h-full bg-terminal-green rounded-full transition-all duration-150" style={{ width: `${progress}%` }} />
              </div>
              {/* Stats grid */}
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: 'Before',    value: fmtFull(current?.before) },
                  { label: 'Risk Amt',  value: current ? '-' + fmtFull(current.riskAmt) : '—' },
                  { label: 'After',     value: fmtFull(current?.after) },
                  { label: leftMode === 'remaining' ? 'Left' : 'Total', value: tradesLeft },
                ].map(s => (
                  <div key={s.label} className="bg-terminal-surface rounded p-2 text-center">
                    <div className="text-[10px] font-mono text-terminal-dim uppercase">{s.label}</div>
                    <div className="text-sm font-mono font-bold text-terminal-text mt-0.5">{s.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Scrub slider */}
            <div className="card p-4 space-y-2">
              <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Scrub Through Trades</div>
              <input type="range" min={0} max={maxIdx} step={1} value={safeIdx}
                onChange={e => setScrubIdx(parseInt(e.target.value))}
                className="w-full accent-terminal-green" />
              <div className="flex justify-between text-[10px] font-mono text-terminal-dim">
                <span>Trade 1 — {fmt(params.startBal)}</span>
                <span>Trade {trades.length} — {fmt(trades[trades.length - 1]?.after)}</span>
              </div>
              {/* Trades left toggle */}
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[10px] font-mono text-terminal-dim">TRADES LEFT FROM:</span>
                <button
                  onClick={() => setLeftMode(m => m === 'remaining' ? 'total' : 'remaining')}
                  className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                    leftMode === 'remaining'
                      ? 'border-terminal-green text-terminal-green'
                      : 'border-terminal-border text-terminal-dim'
                  }`}
                >
                  {leftMode === 'remaining' ? 'Current Position' : 'Trade #1'}
                </button>
              </div>
            </div>

            {/* Trade table */}
            <div className="card overflow-hidden">
              <div className="grid grid-cols-[2.5rem_1fr_1fr_1fr_2fr] border-b border-terminal-border bg-terminal-surface">
                {['#', 'BEFORE', 'RISK', 'AFTER', 'PROGRESS'].map(h => (
                  <div key={h} className="px-3 py-2 text-[10px] font-mono text-terminal-dim">{h}</div>
                ))}
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: '380px' }}>
                {trades.map((t, i) => {
                  const prog   = Math.max(0, Math.min(100, ((t.after - params.startBal) / (params.targetBal - params.startBal)) * 100));
                  const active = i === safeIdx;
                  return (
                    <div key={i} ref={el => rowRefs.current[i] = el}
                      onClick={() => setScrubIdx(i)}
                      className={`grid grid-cols-[2.5rem_1fr_1fr_1fr_2fr] border-b border-terminal-border/40 last:border-0 cursor-pointer transition-colors ${
                        active
                          ? 'bg-terminal-green/10 border-l-2 border-l-terminal-green'
                          : 'hover:bg-terminal-surface/60'
                      }`}
                    >
                      <div className="px-3 py-2 text-xs font-mono text-terminal-dim">{t.n}</div>
                      <div className="px-3 py-2 text-xs font-mono text-terminal-text">{fmt(t.before)}</div>
                      <div className="px-3 py-2 text-xs font-mono font-semibold text-red-400">-{fmt(t.riskAmt)}</div>
                      <div className={`px-3 py-2 text-xs font-mono font-semibold ${t.change >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                        {fmt(t.after)}
                      </div>
                      <div className="px-3 py-2 flex items-center gap-2">
                        <div className="flex-1 h-1 bg-terminal-surface rounded-full overflow-hidden">
                          <div className="h-full bg-terminal-green/60 rounded-full" style={{ width: `${prog}%` }} />
                        </div>
                        <span className="text-[10px] font-mono text-terminal-dim w-7 text-right">{Math.round(prog)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>)}
        </div>
      </div>
    </div>
  );
}
