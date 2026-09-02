import { useState, useEffect } from 'react';
import { fmtCurrency } from '../lib/utils';

// ── MetaDrift Scenario ────────────────────────────────────────────────────────
// Pure projection: set a starting balance + risk %, then type each trading day's
// trades as R multiples ("+1, -2, +3, +3.5"). No real data, no backend.
//
// COMPOUNDING at two levels (Mike, 2026-09-02, pick 1a):
//   • within a day  — each trade's 1R = risk% × the balance BEFORE that trade
//   • across days   — each day opens at the prior day's close
// Each month is its own scenario and opens at Starting Balance.

const LS_KEY   = 'metadrift_scenario_v1';
const DEFAULTS = { balance: '10000', riskPct: '3', entries: {} }; // entries: 'YYYY-MM-DD' → raw text

function loadLS() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(LS_KEY)) || {}) }; }
  catch { return { ...DEFAULTS }; }
}

function fmtIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getCalGridStart(y, m) {
  const first = new Date(y, m - 1, 1);
  const dow   = first.getDay();
  return new Date(y, m - 1, 1 - (dow === 0 ? 6 : dow - 1));
}
function getCalGridEnd(y, m) {
  const last = new Date(y, m, 0);
  const dow  = last.getDay();
  return new Date(y, m, 0 + (dow === 0 ? 0 : 7 - dow));
}
function getPnlColor(pnl, maxAbs) {
  if (!pnl || maxAbs === 0) return '';
  const i = Math.min(Math.abs(pnl) / maxAbs, 1);
  return pnl > 0
    ? `rgba(0, ${Math.round(50 + i * 150) + 50}, 50, ${0.12 + i * 0.4})`
    : `rgba(${Math.round(80 + i * 120) + 50}, 20, 20, ${0.12 + i * 0.4})`;
}
const fmtR = (n) => `${n >= 0 ? '+' : ''}${Number(n.toFixed(2))}R`;

// "+1, -2, +3, +3.5"  or  "1 -2 3 3.5"  →  [1, -2, 3, 3.5]
export function parseTrades(str) {
  return String(str || '')
    .split(/[,\s]+/)
    .map(s => parseFloat(s))
    .filter(n => Number.isFinite(n));
}

// Walk the month's weekdays chronologically, compounding per trade and per day.
export function runScenario({ year, month, balance, riskPct, entries }) {
  const start = Math.max(0, parseFloat(balance) || 0);
  const risk  = Math.max(0, parseFloat(riskPct) || 0);
  const daysInMonth = new Date(year, month, 0).getDate();

  let running = start;
  const days = {};
  let totalR = 0, wins = 0, losses = 0, tradeCount = 0, daysEntered = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dt  = new Date(year, month - 1, d);
    const dow = dt.getDay();
    if (dow === 0 || dow === 6) continue;               // trading days only
    const date   = fmtIso(dt);
    const trades = parseTrades(entries[date]);
    const open   = running;
    const legs   = trades.map(r => {
      const oneR = running * (risk / 100);               // 1R off the balance BEFORE this trade
      const pnl  = r * oneR;
      running   += pnl;                                  // compounds into the next trade
      return { r, oneR, pnl, balanceAfter: running };
    });
    const dayR = trades.reduce((s, r) => s + r, 0);
    if (trades.length) {
      daysEntered++;
      tradeCount += trades.length;
      totalR     += dayR;
      wins       += trades.filter(r => r > 0).length;
      losses     += trades.filter(r => r < 0).length;
    }
    days[date] = { date, trades, legs, dayR, open, close: running, dayPnl: running - open };
  }

  return {
    start, risk, days, totalR, wins, losses, tradeCount, daysEntered,
    end: running, compoundedPnl: running - start,
  };
}

export default function MetaDriftScenario({ year, month }) {
  const [state, setState] = useState(loadLS);
  useEffect(() => { localStorage.setItem(LS_KEY, JSON.stringify(state)); }, [state]);

  const { balance, riskPct, entries } = state;
  const setField = (k, v)     => setState(s => ({ ...s, [k]: v }));
  const setEntry = (date, v)  => setState(s => ({ ...s, entries: { ...s.entries, [date]: v } }));
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const clearMonth = () => setState(s => {
    const e = { ...s.entries };
    Object.keys(e).forEach(k => { if (k.startsWith(monthPrefix)) delete e[k]; });
    return { ...s, entries: e };
  });

  const res = runScenario({ year, month, balance, riskPct, entries });
  const decided  = res.wins + res.losses;
  const winRate  = decided > 0 ? (res.wins / decided) * 100 : null;
  const maxAbs   = Math.max(...Object.values(res.days).map(d => Math.abs(d.dayPnl)), 1);
  const oneRDay1 = res.start * (res.risk / 100);
  const today    = fmtIso(new Date());

  // Calendar grid (same Mon–Fri layout as Live MetaDrift)
  const gridStart = getCalGridStart(year, month);
  const gridEnd   = getCalGridEnd(year, month);
  const weekRows  = [];
  const cur = new Date(gridStart);
  while (cur <= gridEnd) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const inMonth = cur.getFullYear() === year && cur.getMonth() + 1 === month;
      week.push({ date: new Date(cur), dateStr: fmtIso(cur), inMonth });
      cur.setDate(cur.getDate() + 1);
    }
    weekRows.push(week);
  }

  const pos = (n) => n > 0 ? 'text-terminal-green' : n < 0 ? 'text-terminal-red' : 'text-terminal-text';
  const inputCls = 'input-field text-sm font-mono';

  return (
    <div className="space-y-5">
      {/* ── Inputs + summary ── */}
      <div className="card p-4 space-y-4 border border-terminal-amber/30">
        <div className="flex flex-wrap items-end gap-4">
          <label className="space-y-1">
            <div className="stat-label">Starting Balance</div>
            <div className="relative w-40">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">$</span>
              <input type="number" value={balance} onChange={e => setField('balance', e.target.value)}
                onFocus={e => e.target.select()} placeholder="10000" className={`${inputCls} w-full pl-6`} />
            </div>
          </label>
          <label className="space-y-1">
            <div className="stat-label">Risk / R (%)</div>
            <div className="relative w-24">
              <input type="number" step="0.5" value={riskPct} onChange={e => setField('riskPct', e.target.value)}
                onFocus={e => e.target.select()} placeholder="3" className={`${inputCls} w-full pr-7 text-right`} />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-mono text-terminal-muted">%</span>
            </div>
          </label>
          <div className="text-[10px] font-mono text-terminal-dim pb-2 leading-relaxed">
            Day-1 1R = <span className="text-terminal-amber font-semibold">{fmtCurrency(oneRDay1)}</span> · re-sized after every trade · each day opens at the prior close · month opens at Starting Balance
          </div>
          {res.daysEntered > 0 && (
            <button onClick={clearMonth}
              className="ml-auto text-[10px] font-mono text-terminal-dim hover:text-terminal-red uppercase tracking-wide transition-colors pb-2">
              Clear month
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 border-t border-terminal-border/40 pt-3">
          <div>
            <div className="stat-label">Total R</div>
            <div className={`text-xl font-mono font-bold mt-1 ${pos(res.totalR)}`}>{fmtR(res.totalR)}</div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">sum of entered R</div>
          </div>
          <div>
            <div className="stat-label">Compounded P&amp;L</div>
            <div className={`text-xl font-mono font-bold mt-1 ${pos(res.compoundedPnl)}`}>{fmtCurrency(res.compoundedPnl, true)}</div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">from {fmtCurrency(res.start)}</div>
          </div>
          <div>
            <div className="stat-label">Projected End Balance</div>
            <div className="text-xl font-mono font-bold mt-1 text-terminal-amber">{fmtCurrency(res.end)}</div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">end of month</div>
          </div>
          <div>
            <div className="stat-label">Trades</div>
            <div className="text-xl font-mono font-bold mt-1 text-terminal-text">
              <span className="text-terminal-green">{res.wins}W</span>
              <span className="text-terminal-dim mx-1">/</span>
              <span className="text-terminal-red">{res.losses}L</span>
            </div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">{winRate == null ? '—' : `${winRate.toFixed(0)}% win rate`}</div>
          </div>
          <div>
            <div className="stat-label">Days Entered</div>
            <div className="text-xl font-mono font-bold mt-1 text-terminal-text">{res.daysEntered}</div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">{res.tradeCount} trades total</div>
          </div>
        </div>
      </div>

      {/* ── Calendar ── */}
      <div className="card overflow-hidden">
        <div className="grid border-b border-terminal-border" style={{ gridTemplateColumns: 'repeat(5, 1fr) repeat(2, 0.22fr)' }}>
          {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d, i) => (
            <div key={i} className="py-2 px-1 text-xs font-mono text-center text-terminal-dim">{d}</div>
          ))}
        </div>

        {weekRows.map((week, wi) => (
          <div key={wi} className="grid border-b border-terminal-border last:border-b-0"
            style={{ gridTemplateColumns: 'repeat(5, 1fr) repeat(2, 0.22fr)' }}>
            {week.map((cell, di) => {
              if (di >= 5) {
                return <div key={di} className="border-r border-terminal-border/30 bg-terminal-surface/20" style={{ minHeight: '175px' }} />;
              }
              if (!cell.inMonth) {
                return <div key={di} className="border-r border-terminal-border/50 bg-terminal-surface/30" style={{ minHeight: '175px' }} />;
              }
              const day     = res.days[cell.dateStr];
              const hasTr   = day && day.trades.length > 0;
              const isToday = cell.dateStr === today;
              return (
                <div key={di}
                  className={`border-r border-terminal-border/50 p-2.5 flex flex-col ${isToday ? 'ring-2 ring-inset ring-terminal-amber/60' : ''}`}
                  style={{ minHeight: '175px', backgroundColor: hasTr ? getPnlColor(day.dayPnl, maxAbs) : '' }}>
                  <div className={`text-sm font-mono font-bold mb-1 ${isToday ? 'text-terminal-amber' : 'text-white/80'}`}>
                    {cell.date.getDate()}
                  </div>

                  <div className="text-[10px] font-mono text-white/60 uppercase tracking-wider mb-1">Trades (R)</div>
                  <input
                    type="text"
                    value={entries[cell.dateStr] || ''}
                    onChange={e => setEntry(cell.dateStr, e.target.value)}
                    placeholder="+1, -2, +3"
                    className="w-full text-xs font-mono bg-black/40 border border-white/20 rounded px-2 py-1 text-white placeholder-white/25 focus:outline-none focus:border-terminal-amber"
                  />

                  {hasTr && (
                    <div className="mt-2 pt-2 border-t border-white/20 text-xs font-mono space-y-0.5">
                      <div className="flex justify-between">
                        <span className="text-white/50">Day R</span>
                        <span className={`font-bold ${pos(day.dayR)}`}>{fmtR(day.dayR)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-white/50">P&amp;L</span>
                        <span className="font-bold" style={{ color: '#f59e0b' }}>{fmtCurrency(day.dayPnl, true)}</span>
                      </div>
                      <div className="text-[10px] text-white/50 pt-0.5">
                        {fmtCurrency(day.open)} → {fmtCurrency(day.close)}
                      </div>
                      <div className="text-[10px] text-white/40">{day.trades.length} trade{day.trades.length !== 1 ? 's' : ''}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-6 text-xs font-mono text-terminal-muted flex-wrap">
        <span>Type each day&apos;s trades as R multiples, e.g. <span className="text-terminal-text">+1, -2, +3, +3.5</span></span>
        <span>1R re-sized off the running balance after every trade</span>
        <span className="text-terminal-amber">Scenario only — never touches your real journal</span>
      </div>
    </div>
  );
}
