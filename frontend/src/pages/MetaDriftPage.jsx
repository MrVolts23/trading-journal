import { useState, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { getMetaDriftCalendar, saveMetaDriftEntry, deleteMetaDriftEntry } from '../lib/api';
import { fmtCurrency, MONTH_NAMES } from '../lib/utils';

const RISK_PCT = 3; // 1R = 3% of opening balance

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getCalGridStart(y, m) {
  const first = new Date(y, m - 1, 1);
  const dow   = first.getDay();
  const back  = dow === 0 ? 6 : dow - 1;
  return new Date(y, m - 1, 1 - back);
}

function getCalGridEnd(y, m) {
  const last = new Date(y, m, 0);
  const dow  = last.getDay();
  const fwd  = dow === 0 ? 0 : 7 - dow;
  return new Date(y, m, 0 + fwd);
}

// Calculate backtest P&L from RR value and opening balance
function calcBacktest(rrValue, openBalance) {
  if (rrValue == null || openBalance == null) return null;
  const oneR = openBalance * (RISK_PCT / 100);
  return rrValue * oneR;
}

function getPnlColor(pnl, maxAbs) {
  if (!pnl || maxAbs === 0) return '';
  const intensity = Math.min(Math.abs(pnl) / maxAbs, 1);
  if (pnl > 0) {
    const g = Math.round(50 + intensity * 150);
    return `rgba(0, ${g + 50}, 50, ${0.12 + intensity * 0.4})`;
  } else {
    const r = Math.round(80 + intensity * 120);
    return `rgba(${r + 50}, 20, 20, ${0.12 + intensity * 0.4})`;
  }
}

// ── RR Input Cell ─────────────────────────────────────────────────────────────
function RrInput({ date, account, savedRr, openBalance, actualPnl, onSaved }) {
  const [editing, setEditing]   = useState(false);
  const [val, setVal]           = useState(savedRr != null ? String(savedRr) : '');
  const [saving, setSaving]     = useState(false);
  const inputRef                = useRef(null);

  useEffect(() => {
    setVal(savedRr != null ? String(savedRr) : '');
  }, [savedRr, date]);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const rrNum       = parseFloat(val);
  const backtestPnl = !isNaN(rrNum) && openBalance != null ? calcBacktest(rrNum, openBalance) : null;
  const btClose     = backtestPnl != null && openBalance != null ? openBalance + backtestPnl : null;
  const delta       = backtestPnl != null && actualPnl != null ? backtestPnl - actualPnl : null;

  async function commit() {
    const num = parseFloat(val);
    if (val === '' || isNaN(num)) {
      // Clear entry
      if (savedRr != null) {
        setSaving(true);
        await deleteMetaDriftEntry(date, account).catch(() => {});
        setSaving(false);
        onSaved(date, null);
      }
      setEditing(false);
      return;
    }
    setSaving(true);
    await saveMetaDriftEntry({ date, account, rr_value: num }).catch(() => {});
    setSaving(false);
    onSaved(date, num);
    setEditing(false);
  }

  function handleKey(e) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { setVal(savedRr != null ? String(savedRr) : ''); setEditing(false); }
  }

  const deltaColor = delta == null ? '' : delta >= 0 ? '#00ff88' : '#ef4444';

  return (
    <div className="mt-2 pt-2 border-t border-white/20">
      {/* RR input */}
      <div className="text-[10px] font-mono text-white/60 mb-1 uppercase tracking-wider">Backtest RR</div>
      {editing ? (
        <input
          ref={inputRef}
          type="number"
          step="0.5"
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          className="w-full text-sm font-mono bg-black/40 border-2 border-terminal-green rounded px-2 py-1 text-white focus:outline-none"
          placeholder="e.g. 3 or -1"
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full text-left font-mono rounded px-2 py-1 border transition-colors"
          style={{
            fontSize: '13px',
            fontWeight: savedRr != null ? 700 : 400,
            color: savedRr != null ? '#fff' : 'rgba(255,255,255,0.35)',
            borderColor: savedRr != null ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.15)',
            backgroundColor: 'rgba(0,0,0,0.25)',
          }}
        >
          {savedRr != null ? `${savedRr > 0 ? '+' : ''}${savedRr}R` : 'tap to enter RR…'}
        </button>
      )}
      {saving && <RefreshCw className="w-3 h-3 text-white/40 animate-spin mt-1" />}

      {/* Backtest P&L */}
      {backtestPnl != null && (
        <div className="mt-1.5 text-xs font-mono">
          <span className="text-white/50">= </span>
          <span style={{ color: '#f59e0b', fontWeight: 700 }}>
            {fmtCurrency(backtestPnl, true)}
          </span>
        </div>
      )}

      {/* BT Close — what the account would close at if this day was traded perfectly */}
      {btClose != null && (
        <div className="mt-0.5 text-xs font-mono">
          <span className="text-white/40">BT Close </span>
          <span style={{ color: '#f59e0b', fontWeight: 600 }}>
            {fmtCurrency(btClose)}
          </span>
        </div>
      )}

      {/* Delta vs actual */}
      {delta != null && (
        <div className="mt-0.5 text-xs font-mono">
          <span className="text-white/50">vs actual  </span>
          <span style={{ color: deltaColor, fontWeight: 700, fontSize: '13px' }}>
            {fmtCurrency(delta, true)}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MetaDriftPage() {
  const filters = useOutletContext();
  const [year,    setYear]    = useState(new Date().getFullYear());
  const [month,   setMonth]   = useState(new Date().getMonth() + 1);
  const [dayData, setDayData] = useState({});   // date → day object
  const [rrMap,   setRrMap]   = useState({});   // date → rr_value
  const [loading, setLoading] = useState(true);

  const account = filters?.account || 'All';

  function load() {
    setLoading(true);
    getMetaDriftCalendar({ year, month, account })
      .then(data => {
        const dm = {};
        const rr = {};
        (data.days || []).forEach(d => {
          dm[d.date] = d;
          if (d.rr_value != null) rr[d.date] = d.rr_value;
        });
        setDayData(dm);
        setRrMap(rr);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => { load(); }, [year, month, account]);

  function handleRrSaved(date, rrValue) {
    setRrMap(prev => {
      const next = { ...prev };
      if (rrValue == null) delete next[date];
      else next[date] = rrValue;
      return next;
    });
  }

  const prevMonth = () => { if (month === 1) { setMonth(12); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 12) { setMonth(1); setYear(y => y + 1); } else setMonth(m => m + 1); };

  // Build calendar grid
  const gridStart = getCalGridStart(year, month);
  const gridEnd   = getCalGridEnd(year, month);
  const weekRows  = [];
  const cur       = new Date(gridStart);
  while (cur <= gridEnd) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const inMonth    = cur.getFullYear() === year && cur.getMonth() + 1 === month;
      const isTrailing = !inMonth && cur > new Date(year, month - 1, new Date(year, month, 0).getDate());
      week.push({ date: new Date(cur), dateStr: fmtIso(cur), inMonth, isTrailing });
      cur.setDate(cur.getDate() + 1);
    }
    weekRows.push(week);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Max abs P&L for color intensity
  const allPnls  = Object.values(dayData).map(d => Math.abs(d.daily_pnl || 0));
  const maxAbs   = Math.max(...allPnls, 1);

  // ── Summary stats ───────────────────────────────────────────────────────────
  const summary = (() => {
    let actualTotal    = 0;
    let backtestTotal  = 0;
    let daysActual     = 0;
    let daysBacktest   = 0;
    let beatDays       = 0;
    let missDays       = 0;

    // Compounded backtest — walk days chronologically, each day's 1R is based on
    // the hypothetical balance after all previous backtest days, not the actual open.
    // This shows what the account would have grown to trading the backtest plan perfectly.
    const backtestDays = Object.values(dayData)
      .filter(d => rrMap[d.date] != null && d.open_balance != null)
      .sort((a, b) => a.date.localeCompare(b.date));

    let hypotheticalBalance = backtestDays.length > 0 ? backtestDays[0].open_balance : 0;
    let compoundedPnl       = 0;
    // Map of date → hypothetical balance BEFORE that day's trade
    // (i.e. what the account would open at if all prior backtest days executed perfectly)
    const hypotheticalOpenMap = {};

    backtestDays.forEach(d => {
      hypotheticalOpenMap[d.date] = hypotheticalBalance; // opening balance for this day
      const rr     = rrMap[d.date];
      const oneR   = hypotheticalBalance * (RISK_PCT / 100);
      const btPnl  = rr * oneR;
      compoundedPnl       += btPnl;
      hypotheticalBalance += btPnl;
    });

    const compoundedEndBalance = hypotheticalBalance;
    const seedBalance          = backtestDays.length > 0 ? backtestDays[0].open_balance : 0;

    Object.values(dayData).forEach(d => {
      if (d.daily_pnl != null) daysActual++;
      const rr  = rrMap[d.date];
      const bt  = calcBacktest(rr, d.open_balance);
      if (bt != null) {
        // Only count actual P&L for days that have a backtest entry — apples-to-apples
        backtestTotal += bt;
        daysBacktest++;
        actualTotal += (d.daily_pnl || 0);
        const delta = bt - (d.daily_pnl || 0);
        if (delta >= 0) beatDays++; else missDays++;
      }
    });

    return { actualTotal, backtestTotal, daysActual, daysBacktest, beatDays, missDays,
             delta: backtestTotal - actualTotal,
             compoundedPnl, compoundedEndBalance, seedBalance };
  })();

  const hasSummary = summary.daysBacktest > 0;

  return (
    <div className="p-6 space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-mono font-semibold text-terminal-text tracking-wide">MetaDrift</h1>
          <p className="text-xs font-mono text-terminal-muted mt-0.5">
            Backtest against your real history · 1R = {RISK_PCT}% of opening balance
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="p-1.5 rounded hover:bg-terminal-hover text-terminal-muted hover:text-terminal-text transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-mono text-terminal-text w-36 text-center">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <button onClick={nextMonth} className="p-1.5 rounded hover:bg-terminal-hover text-terminal-muted hover:text-terminal-text transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Summary bar ── */}
      {hasSummary && (
        <div className="card p-4 grid grid-cols-3 gap-x-6 gap-y-4">
          {/* Row 1 */}
          <div className="border-r border-terminal-border pr-6">
            <div className="stat-label">Actual P&L</div>
            <div className={`text-xl font-mono font-bold mt-1 ${summary.actualTotal >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
              {fmtCurrency(summary.actualTotal, true)}
            </div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">{summary.daysActual} trading days</div>
          </div>
          <div className="border-r border-terminal-border pr-6">
            <div className="stat-label">Backtest P&L</div>
            <div className={`text-xl font-mono font-bold mt-1 ${summary.backtestTotal >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
              {fmtCurrency(summary.backtestTotal, true)}
            </div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">{summary.daysBacktest} days entered</div>
          </div>
          <div>
            <div className="stat-label">Net Δ vs Actual</div>
            <div className="text-xl font-mono font-bold mt-1" style={{ color: summary.delta >= 0 ? '#00ff88' : '#ef4444' }}>
              {fmtCurrency(summary.delta, true)}
            </div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">
              {summary.delta >= 0 ? 'Backtest ahead' : 'Actual ahead'}
            </div>
          </div>
          {/* Row 2 */}
          <div className="border-t border-terminal-border/40 pt-3 border-r border-terminal-border pr-6">
            <div className="stat-label">Days Beat</div>
            <div className="text-xl font-mono font-bold mt-1 text-terminal-green">{summary.beatDays}</div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">backtest &gt; actual</div>
          </div>
          <div className="border-t border-terminal-border/40 pt-3 border-r border-terminal-border pr-6">
            <div className="stat-label">Days Missed</div>
            <div className="text-xl font-mono font-bold mt-1 text-terminal-red">{summary.missDays}</div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">backtest &lt; actual</div>
          </div>
          <div className="border-t border-terminal-border/40 pt-3">
            <div className="stat-label">Beat Rate</div>
            <div className="text-xl font-mono font-bold mt-1 text-terminal-amber">
              {summary.daysBacktest > 0
                ? `${((summary.beatDays / summary.daysBacktest) * 100).toFixed(0)}%`
                : '—'}
            </div>
            <div className="text-[10px] font-mono text-terminal-dim mt-0.5">of backtested days</div>
          </div>

          {/* Row 3 — Compounded projection */}
          <div className="col-span-3 border-t border-terminal-border/40 pt-3 mt-1">
            <div className="flex items-start gap-2 mb-2">
              <div className="text-[10px] font-mono text-terminal-amber uppercase tracking-widest">Compounded Projection</div>
              <div className="text-[10px] font-mono text-terminal-dim">— what the account grows to if each day's 1R is sized on the hypothetical running balance, not the actual open</div>
            </div>
            <div className="grid grid-cols-3 gap-x-6">
              <div>
                <div className="stat-label">Starting Balance</div>
                <div className="text-lg font-mono font-bold mt-1 text-terminal-text">
                  {fmtCurrency(summary.seedBalance)}
                </div>
                <div className="text-[10px] font-mono text-terminal-dim mt-0.5">first backtested day open</div>
              </div>
              <div>
                <div className="stat-label">Compounded P&L</div>
                <div className={`text-lg font-mono font-bold mt-1 ${summary.compoundedPnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                  {fmtCurrency(summary.compoundedPnl, true)}
                </div>
                <div className="text-[10px] font-mono text-terminal-dim mt-0.5">vs flat {fmtCurrency(summary.backtestTotal, true)}</div>
              </div>
              <div>
                <div className="stat-label">Projected End Balance</div>
                <div className="text-lg font-mono font-bold mt-1 text-terminal-green">
                  {fmtCurrency(summary.compoundedEndBalance)}
                </div>
                <div className="text-[10px] font-mono text-terminal-dim mt-0.5">trading the plan perfectly</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Calendar ── */}
      <div className="card overflow-hidden">
        {/* Day headers */}
        <div className="grid border-b border-terminal-border" style={{ gridTemplateColumns: 'repeat(5, 1fr) repeat(2, 0.22fr)' }}>
          {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d, i) => (
            <div key={i} className="py-2 px-1 text-xs font-mono text-center text-terminal-dim">
              {d}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="h-48 flex items-center justify-center text-terminal-muted font-mono text-sm animate-pulse">
            Loading...
          </div>
        ) : (
          weekRows.map((week, wi) => (
            <div key={wi} className="grid border-b border-terminal-border last:border-b-0"
              style={{ gridTemplateColumns: 'repeat(5, 1fr) repeat(2, 0.22fr)' }}>
              {week.map((cell, di) => {
                const data        = dayData[cell.dateStr];
                const isToday     = cell.dateStr === today;
                const rrValue     = rrMap[cell.dateStr] ?? null;
                const backtestPnl = data ? calcBacktest(rrValue, data.open_balance) : null;
                const delta       = backtestPnl != null && data ? backtestPnl - (data.daily_pnl || 0) : null;
                const bg          = data ? getPnlColor(data.daily_pnl, maxAbs) : '';

                // Weekend slim columns
                if (di >= 5) {
                  return (
                    <div key={di}
                      className="border-r border-terminal-border/30 bg-terminal-surface/20"
                      style={{ minHeight: '175px' }} />
                  );
                }

                // Off-month leading cells
                if (!cell.inMonth && !cell.isTrailing) {
                  return (
                    <div key={di}
                      className="border-r border-terminal-border/50 bg-terminal-surface/30"
                      style={{ minHeight: '175px' }} />
                  );
                }

                const isTrailingCell = cell.isTrailing;

                return (
                  <div key={di}
                    className={`border-r border-terminal-border/50 p-2.5 flex flex-col ${isToday ? 'ring-2 ring-inset ring-terminal-green/60' : ''}`}
                    style={{ minHeight: '175px', backgroundColor: bg }}>

                    {/* Date number */}
                    <div className={`text-sm font-mono font-bold mb-1 ${
                      isToday ? 'text-terminal-green' : 'text-white/80'
                    }`}>
                      {isTrailingCell
                        ? cell.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                        : cell.date.getDate()}
                    </div>

                    {data ? (
                      <>
                        {/* Actual P&L — first and largest */}
                        <div className="text-base font-mono font-bold leading-tight text-white">
                          {fmtCurrency(data.daily_pnl, true)}
                        </div>
                        <div className="text-[11px] font-mono text-white/60 mt-0.5 mb-1">
                          {data.trade_count} trade{data.trade_count !== 1 ? 's' : ''}
                        </div>

                        {/* Actual open balance */}
                        {data.open_balance != null && (
                          <div className="text-[11px] font-mono text-white/50 leading-tight mb-0.5">
                            Open {fmtCurrency(data.open_balance)}
                          </div>
                        )}

                        {/* Backtest RR input + result */}
                        <RrInput
                          date={cell.dateStr}
                          account={account}
                          savedRr={rrValue}
                          openBalance={data.open_balance}
                          actualPnl={data.daily_pnl}
                          onSaved={handleRrSaved}
                        />
                      </>
                    ) : (
                      /* No trades — still show RR input if day is in month and past */
                      cell.inMonth && cell.dateStr <= today ? (
                        <RrInput
                          date={cell.dateStr}
                          account={account}
                          savedRr={rrValue}
                          openBalance={null}
                          actualPnl={null}
                          onSaved={handleRrSaved}
                        />
                      ) : (
                        <div className="flex-1" />
                      )
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center gap-6 text-xs font-mono text-terminal-muted flex-wrap">
        <span>BT RR = backtest risk:reward entry</span>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: '#00ff88', opacity: 0.8 }} />
          <span>Δ+ = backtest beat actual</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: '#ef4444', opacity: 0.8 }} />
          <span>Δ- = actual beat backtest</span>
        </div>
        <span>1R = {RISK_PCT}% × open balance</span>
      </div>
    </div>
  );
}
