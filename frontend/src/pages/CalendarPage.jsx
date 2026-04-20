import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useOutletContext } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Zap } from 'lucide-react';
import { getCalendar, getMetaDriftCalendar, getNewsEvents, getTrades } from '../lib/api';
import { fmtCurrency, MONTH_NAMES } from '../lib/utils';

const IMPACT_COLOR = { High: '#ef4444', Medium: '#f59e0b' };
const IMPACT_DOT   = { High: 'bg-red-500', Medium: 'bg-amber-400' };

// Convert "HH:MM" UTC + "YYYY-MM-DD" to local time string
function utcToLocal(dateStr, timeStr) {
  if (!timeStr || !dateStr) return null;
  try {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return timeStr + ' UTC'; }
}

// ── News popup ─────────────────────────────────────────────────────────────────
// Shared popup positioning — always keeps popup fully on screen, gravitates to center
function calcPopupPos(anchorRect, popupW, maxH) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;

  // Horizontal: center on anchor, clamp to viewport
  let left = anchorRect
    ? anchorRect.left + anchorRect.width / 2 - popupW / 2
    : vw / 2 - popupW / 2;
  left = Math.max(pad, Math.min(left, vw - popupW - pad));

  // Vertical: prefer below, fall back to above, last resort center screen
  const spaceBelow = anchorRect ? vh - anchorRect.bottom - pad : 0;
  const spaceAbove = anchorRect ? anchorRect.top - pad : 0;
  let top;
  if (anchorRect && spaceBelow >= Math.min(maxH, 180)) {
    top = anchorRect.bottom + 4;
  } else if (anchorRect && spaceAbove >= Math.min(maxH, 180)) {
    top = anchorRect.top - Math.min(maxH, spaceAbove) - 4;
  } else {
    top = Math.max(pad, vh / 2 - maxH / 2);
  }
  top = Math.max(pad, Math.min(top, vh - maxH - pad));

  return { left, top };
}

function NewsPopup({ events, dateStr, anchorRect, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const popupW = 288;
  const maxH   = 340;
  const { left, top } = calcPopupPos(anchorRect, popupW, maxH);

  return createPortal(
    <div ref={ref}
      className="rounded-lg border border-terminal-border bg-terminal-bg shadow-2xl p-3 space-y-2 overflow-y-auto"
      style={{ position: 'fixed', top, left, width: popupW, maxHeight: maxH, zIndex: 9999 }}
      onClick={e => e.stopPropagation()}
    >
      <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest mb-1">News Events</div>
      {events.map((ev, i) => (
        <div key={i} className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${IMPACT_DOT[ev.impact] || 'bg-terminal-dim'}`} />
            <span className="text-xs font-mono font-semibold text-terminal-text leading-tight">{ev.title}</span>
          </div>
          <div className="flex items-center gap-2 pl-3 text-[10px] font-mono text-terminal-muted">
            <span style={{ color: IMPACT_COLOR[ev.impact] || '#9ca3af' }}>{ev.impact}</span>
            <span>{ev.country}</span>
            {ev.event_time && <span>{utcToLocal(dateStr || ev.event_date, ev.event_time)}</span>}
          </div>
          {(ev.forecast || ev.previous || ev.actual) && (
            <div className="flex gap-3 pl-3 text-[10px] font-mono text-terminal-dim">
              {ev.forecast && <span>F: <span className="text-terminal-text">{ev.forecast}</span></span>}
              {ev.previous && <span>P: <span className="text-terminal-text">{ev.previous}</span></span>}
              {ev.actual   && <span>A: <span className="text-terminal-green font-semibold">{ev.actual}</span></span>}
            </div>
          )}
          {i < events.length - 1 && <div className="border-t border-terminal-border/40 pt-1.5" />}
        </div>
      ))}
    </div>,
    document.body
  );
}

// ── Trades popup ───────────────────────────────────────────────────────────────
function TradesPopup({ dateStr, anchorRect, account, onClose }) {
  const ref = useRef(null);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getTrades({ dateStart: dateStr, dateEnd: dateStr, account, limit: 50, sort: 'entry_datetime', dir: 'ASC' })
      .then(data => { setTrades(data.trades || data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [dateStr, account]);

  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const popupW = 300;
  const maxH   = 360;
  const { left, top } = calcPopupPos(anchorRect, popupW, maxH);

  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);

  return createPortal(
    <div ref={ref}
      className="rounded-lg border border-terminal-border bg-terminal-bg shadow-2xl overflow-hidden"
      style={{ position: 'fixed', top, left, width: popupW, maxHeight: maxH, zIndex: 9999 }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-terminal-border bg-terminal-surface">
        <span className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">
          {new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
        {!loading && trades.length > 0 && (
          <span className={`text-xs font-mono font-bold ${totalPnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
            {fmtCurrency(totalPnl, true)}
          </span>
        )}
      </div>

      {/* Trade list */}
      <div className="overflow-y-auto" style={{ maxHeight: maxH - 40 }}>
        {loading ? (
          <div className="px-3 py-4 text-xs font-mono text-terminal-dim text-center animate-pulse">Loading…</div>
        ) : trades.length === 0 ? (
          <div className="px-3 py-4 text-xs font-mono text-terminal-dim text-center">No trades on this day</div>
        ) : (
          trades.map((t, i) => {
            const isWin  = t.pnl > 0;
            const isLoss = t.pnl < 0;
            return (
              <div key={t.trade_id || i}
                className={`flex items-center justify-between px-3 py-2 border-b border-terminal-border/40 last:border-b-0 hover:bg-terminal-surface/50 transition-colors`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {/* W / L badge */}
                  <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                    isWin  ? 'bg-green-900/40 text-green-400 border border-green-700/50' :
                    isLoss ? 'bg-red-900/40 text-red-400 border border-red-700/50' :
                             'bg-terminal-surface text-terminal-dim border border-terminal-border'
                  }`}>
                    {isWin ? 'W' : isLoss ? 'L' : 'B'}
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-mono font-semibold text-terminal-text truncate">{t.symbol}</div>
                    {t.strategy && <div className="text-[10px] font-mono text-terminal-dim truncate">{t.strategy}</div>}
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-2">
                  <div className={`text-sm font-mono font-bold ${isWin ? 'text-terminal-green' : isLoss ? 'text-terminal-red' : 'text-terminal-dim'}`}>
                    {t.pnl != null ? fmtCurrency(t.pnl, true) : '—'}
                  </div>
                  {t.r_multiple != null && (
                    <div className="text-[10px] font-mono text-terminal-dim">{t.r_multiple > 0 ? '+' : ''}{Number(t.r_multiple).toFixed(2)}R</div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>,
    document.body
  );
}

// Watches for light/dark class changes on <html>
function useIsLight() {
  const [isLight, setIsLight] = useState(() =>
    document.documentElement.classList.contains('light')
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsLight(document.documentElement.classList.contains('light'))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isLight;
}

function getPnlColor(pnl, maxAbs, isLight) {
  if (!pnl || maxAbs === 0) return '';
  const intensity = Math.min(Math.abs(pnl) / maxAbs, 1);
  if (isLight) {
    // Light mode: use clean saturated greens/reds that show well on white
    if (pnl > 0) return `rgba(22, 163, 74, ${0.13 + intensity * 0.42})`;
    else         return `rgba(220, 38, 38,  ${0.13 + intensity * 0.42})`;
  }
  // Dark mode — original colours
  if (pnl > 0) {
    const g = Math.round(50 + intensity * 150);
    return `rgba(0, ${g + 50}, 50, ${0.15 + intensity * 0.5})`;
  } else {
    const r = Math.round(80 + intensity * 120);
    return `rgba(${r + 50}, 20, 20, ${0.15 + intensity * 0.5})`;
  }
}

function getPnlTextColor(pnl) {
  if (!pnl) return 'text-terminal-muted';
  return pnl > 0 ? 'text-terminal-green' : 'text-terminal-red';
}

export default function CalendarPage() {
  const filters  = useOutletContext();
  const isLight  = useIsLight();
  const [year,   setYear]   = useState(new Date().getFullYear());
  const [month,  setMonth]  = useState(new Date().getMonth() + 1);
  const [calData,      setCalData]      = useState({});
  const [activityMap,  setActivityMap]  = useState({});
  const [loading,      setLoading]      = useState(true);
  const [weekTotals,   setWeekTotals]   = useState([]);
  const [newsMap,      setNewsMap]      = useState({});   // dateStr → [events]
  const [openNews,   setOpenNews]   = useState(null); // { dateStr, rect }
  const [openTrades, setOpenTrades] = useState(null); // { dateStr, rect }

  // Text colours for cells — white on dark bg, near-black on light bg
  const cellText     = isLight ? 'text-gray-900'    : 'text-white';
  const cellTextSub  = isLight ? 'text-gray-600'    : 'text-white/70';
  const cellTextWr   = isLight ? 'text-gray-700'    : 'text-white/80';

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
  function fmtIso(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  useEffect(() => {
    setLoading(true);
    const gridStart = getCalGridStart(year, month);
    const gridEnd   = getCalGridEnd(year, month);
    // Use MetaDrift calendar API — it returns the same data plus open/close balances
    getMetaDriftCalendar({
      year, month,
      account:  filters.account,
    }).then(data => {
      const map = {};
      (data.days || []).forEach(d => { map[d.date] = d; });
      setCalData(map);
      setActivityMap(data.activityMap || {});

      // Week totals — only count days that belong to THIS calendar month.
      // Leading days (prev month) and trailing days (next month) that appear
      // in the grid to fill out the first/last rows are excluded so the WEEK
      // column always reflects calendar-month data, not arbitrary 7-day blocks.
      const weeks = [];
      const cur = new Date(gridStart);
      while (cur <= gridEnd) {
        let weekPnl = 0, weekTrades = 0, weekWins = 0, weekLosses = 0;
        for (let d = 0; d < 7; d++) {
          const inThisMonth = cur.getFullYear() === year && cur.getMonth() + 1 === month;
          // Only count Mon–Fri (d 0–4); skip Sat (5) and Sun (6)
          if (inThisMonth && d < 5) {
            const ds  = fmtIso(cur);
            const day = map[ds];
            if (day) {
              weekPnl    += day.daily_pnl    || 0;
              weekTrades += day.trade_count  || 0;
              weekWins   += day.wins         || 0;
              weekLosses += day.losses       || 0;
            }
          }
          cur.setDate(cur.getDate() + 1);
        }
        weeks.push({ pnl: weekPnl, trades: weekTrades, wins: weekWins, losses: weekLosses });
      }
      setWeekTotals(weeks);
      setLoading(false);
    }).catch(() => setLoading(false));

    // Fetch news for this month — currencies come from settings (default USD)
    const newsCurrencies = localStorage.getItem('news_currencies') || 'USD';
    getNewsEvents({ year, month, currencies: newsCurrencies, impact: 'medium' })
      .then(data => setNewsMap(data.byDate || {}))
      .catch(() => {});
  }, [year, month, filters.account]);

  // For a given weekday cell, sum account activity for that date AND any
  // immediately preceding Saturday/Sunday (weekend withdrawals show on Monday).
  function getCellActivity(dateStr, dayOfWeekIdx) {
    // dayOfWeekIdx: 0=Mon … 6=Sun in our grid
    let total = activityMap[dateStr] || 0;
    if (dayOfWeekIdx === 0) {
      // Monday — also pick up Sat and Sun
      const d = new Date(dateStr + 'T00:00:00');
      const sat = new Date(d); sat.setDate(d.getDate() - 2);
      const sun = new Date(d); sun.setDate(d.getDate() - 1);
      total += activityMap[fmtIso(sat)] || 0;
      total += activityMap[fmtIso(sun)] || 0;
    }
    return Math.abs(total) > 0.01 ? total : null;
  }

  const prevMonth = () => { if (month === 1) { setMonth(12); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 12) { setMonth(1); setYear(y => y + 1); } else setMonth(m => m + 1); };

  const today      = new Date().toISOString().slice(0, 10);
  const todayDow   = new Date().getDay(); // 0=Sun, 6=Sat
  const isWeekend  = todayDow === 0 || todayDow === 6;
  const allPnls = Object.values(calData).map(d => Math.abs(d.daily_pnl || 0));
  const maxAbs  = Math.max(...allPnls, 1);

  // Month stats: only count days that actually belong to the current month
  // (trailing overflow days from next month are visible but excluded from totals)
  const thisMonthData = Object.entries(calData)
    .filter(([date]) => {
      const d = new Date(date + 'T00:00:00');
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    })
    .map(([, v]) => v);

  const monthPnl      = thisMonthData.reduce((s, d) => s + (d.daily_pnl    || 0), 0);
  const monthTrades   = thisMonthData.reduce((s, d) => s + (d.trade_count  || 0), 0);
  const monthWins     = thisMonthData.reduce((s, d) => s + (d.wins         || 0), 0);
  const monthLosses   = thisMonthData.reduce((s, d) => s + (d.losses       || 0), 0);
  const monthWinRate  = (monthWins + monthLosses) > 0
    ? ((monthWins / (monthWins + monthLosses)) * 100).toFixed(1) : '—';

  const gridStart = getCalGridStart(year, month);
  const gridEnd   = getCalGridEnd(year, month);
  const weekRows  = [];
  const cur = new Date(gridStart);
  while (cur <= gridEnd) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const inMonth   = cur.getFullYear() === year && cur.getMonth() + 1 === month;
      // trailing = past the last day of the current month (overflow into next month)
      // leading  = before the 1st of the current month (hidden)
      const isTrailing = !inMonth && (cur.getFullYear() > year || (cur.getFullYear() === year && cur.getMonth() + 1 > month));
      week.push({ date: new Date(cur), dateStr: fmtIso(cur), inMonth, isTrailing });
      cur.setDate(cur.getDate() + 1);
    }
    weekRows.push(week);
  }

  return (
    <div className="p-6 space-y-6">
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={prevMonth} className="btn-ghost p-2"><ChevronLeft className="w-4 h-4" /></button>
          <h2 className="text-xl font-mono font-semibold text-terminal-text">
            {MONTH_NAMES[month - 1]} {year}
          </h2>
          <button onClick={nextMonth} className="btn-ghost p-2"><ChevronRight className="w-4 h-4" /></button>
          <button
            onClick={() => { setMonth(new Date().getMonth() + 1); setYear(new Date().getFullYear()); }}
            className="text-xs font-mono text-terminal-muted hover:text-terminal-green transition-colors ml-2"
          >
            Today
          </button>
        </div>
        <div className="flex gap-6 items-center">
          <div className="text-right">
            <div className="stat-label">Month P&L</div>
            <div className={`text-lg font-mono font-bold ${monthPnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
              {fmtCurrency(monthPnl, true)}
            </div>
          </div>
          <div className="text-right">
            <div className="stat-label">Trades</div>
            <div className="text-lg font-mono font-bold text-terminal-text">{monthTrades}</div>
          </div>
          <div className="text-right">
            <div className="stat-label">Win Rate</div>
            <div className={`text-lg font-mono font-bold ${parseFloat(monthWinRate) >= 50 ? 'text-terminal-green' : 'text-terminal-amber'}`}>
              {monthWinRate}%
            </div>
          </div>
        </div>
      </div>

      {/* ── CALENDAR GRID ───────────────────────────────────────────────── */}
      <div className="card overflow-hidden">
        {/* Custom grid: 5 trading days (1fr) + 2 slim weekend placeholders (0.25fr) + week total (1fr) */}
        <div className="grid border-b border-terminal-border" style={{ gridTemplateColumns: 'repeat(5, 1fr) repeat(2, 0.22fr) 1fr' }}>
          {['MON','TUE','WED','THU','FRI','SAT','SUN','WEEK'].map((d, i) => (
            <div key={i} className={`py-2 px-1 text-xs font-mono text-center ${
              d === 'WEEK' ? 'bg-terminal-surface border-l border-terminal-border text-terminal-dim'
              : 'text-terminal-dim'
            }`}>
              {d}
            </div>
          ))}
        </div>

        {loading ? (
          <div className="h-48 flex items-center justify-center text-terminal-muted font-mono text-sm animate-pulse">
            Loading...
          </div>
        ) : (
          weekRows.map((week, wi) => {
            const wt = weekTotals[wi];
            const isCurrentWeek = week.some(cell => cell.dateStr === today);
            const hasWeekData = wt && wt.trades > 0 && !(isWeekend && isCurrentWeek);
            return (
              <div key={wi} className="grid border-b border-terminal-border last:border-b-0" style={{ gridTemplateColumns: 'repeat(5, 1fr) repeat(2, 0.22fr) 1fr' }}>
                {week.map((cell, di) => {
                  const data    = calData[cell.dateStr];
                  const isToday = cell.dateStr === today;
                  const bg      = data ? getPnlColor(data.daily_pnl, maxAbs, isLight) : '';
                  const winRate = data && (data.wins + data.losses) > 0
                    ? ((data.wins / (data.wins + data.losses)) * 100).toFixed(0)
                    : null;

                  // Weekend cells (Sat = di 5, Sun = di 6) — slim downtime placeholder
                  if (di >= 5) {
                    return (
                      <div
                        key={di}
                        className="border-r border-terminal-border/30 bg-terminal-surface/20"
                        style={{ minHeight: '140px' }}
                      />
                    );
                  }

                  // Leading cells (before the 1st) — fully blank, nothing to see
                  if (!cell.inMonth && !cell.isTrailing) {
                    return (
                      <div
                        key={di}
                        className="border-r border-terminal-border/50 bg-terminal-surface/30"
                        style={{ minHeight: '140px' }}
                      />
                    );
                  }

                  // Trailing overflow cells (next month's days completing the last week)
                  // — shown dimmed with "Apr 1" style label so it's clear they're overflow
                  const isTrailingCell = cell.isTrailing;
                  const cellActivity   = getCellActivity(cell.dateStr, di);
                  const cellNews       = newsMap[cell.dateStr] || [];
                  const hasHigh        = cellNews.some(e => e.impact === 'High');
                  const newsOpen       = openNews?.dateStr === cell.dateStr;

                  const tradesOpen = openTrades?.dateStr === cell.dateStr;
                  return (
                    <div
                      key={di}
                      className={`border-r border-terminal-border/50 p-2 flex flex-col relative ${
                        isToday ? 'ring-1 ring-inset ring-terminal-green/40' : ''
                      } ${data ? 'cursor-pointer hover:brightness-110 transition-all' : ''}`}
                      style={{ minHeight: '140px', backgroundColor: bg }}
                      onClick={data ? (e) => {
                        if (e.target.closest('button')) return; // don't steal news button clicks
                        setOpenNews(null);
                        setOpenTrades(tradesOpen ? null : { dateStr: cell.dateStr, rect: e.currentTarget.getBoundingClientRect() });
                      } : undefined}
                    >
                    {tradesOpen && (
                      <TradesPopup
                        dateStr={cell.dateStr}
                        anchorRect={openTrades.rect}
                        account={filters.account}
                        onClose={() => setOpenTrades(null)}
                      />
                    )}
                      <div className={`text-xs font-mono font-semibold mb-1 ${
                        isToday ? 'text-terminal-green' : data ? cellText : 'text-terminal-muted'
                      }`}>
                        {isTrailingCell
                          ? cell.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          : cell.date.getDate()}
                      </div>
                      {data ? (
                        <>
                          {data.open_balance != null && (
                            <div className="text-[11px] font-mono leading-tight" style={{ color: 'rgba(255,255,255,0.65)' }}>
                              ↑ {fmtCurrency(data.open_balance)}
                            </div>
                          )}
                          <div className={`text-base font-mono font-bold leading-tight mt-0.5 ${cellText}`}>
                            {fmtCurrency(data.daily_pnl, true)}
                          </div>
                          {data.close_balance != null && (
                            <div className="text-[11px] font-mono leading-tight" style={{ color: 'rgba(255,255,255,0.65)' }}>
                              ↓ {fmtCurrency(data.close_balance)}
                            </div>
                          )}
                          {cellActivity != null && (
                            <div className="text-[11px] font-mono font-bold leading-tight mt-1" style={{
                              color: cellActivity < 0 ? '#f87171' : '#4ade80',
                            }}>
                              {cellActivity < 0 ? '⬇ Withdrawal ' : '⬆ Deposit '}
                              {fmtCurrency(Math.abs(cellActivity))}
                            </div>
                          )}
                          <div className="text-xs font-mono mt-1" style={{ color: 'rgba(255,255,255,0.55)' }}>
                            {data.trade_count} trade{data.trade_count !== 1 ? 's' : ''}
                          </div>
                          {winRate && (
                            <div className="text-xs font-mono mt-auto font-semibold" style={{ color: 'rgba(255,255,255,0.75)' }}>
                              {winRate}% WR
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="flex-1" />
                      )}

                      {/* Lightning bolt — news events indicator */}
                      {cellNews.length > 0 && (
                        <div className="absolute bottom-1.5 right-1.5">
                          <button
                            onClick={e => { e.stopPropagation(); setOpenNews(newsOpen ? null : { dateStr: cell.dateStr, rect: e.currentTarget.getBoundingClientRect() }); }}
                            className="flex items-center gap-0.5 px-1 py-0.5 rounded transition-colors hover:bg-black/20"
                            title={`${cellNews.length} news event${cellNews.length !== 1 ? 's' : ''}`}
                          >
                            <Zap className="w-3 h-3 flex-shrink-0" style={{ color: hasHigh ? '#ef4444' : '#f59e0b' }} />
                            <span className="text-[9px] font-mono" style={{ color: hasHigh ? '#ef4444' : '#f59e0b' }}>
                              {cellNews.length}
                            </span>
                          </button>
                          {newsOpen && (
                            <NewsPopup events={cellNews} dateStr={cell.dateStr} anchorRect={openNews?.rect} onClose={() => setOpenNews(null)} />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* Week total — only in-month Mon–Fri days */}
                <div className="bg-terminal-surface border-l border-terminal-border p-2 flex flex-col justify-center items-center" style={{ minHeight: '140px' }}>
                  {hasWeekData ? (
                    <>
                      <div className={`text-sm font-mono font-bold ${wt.pnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                        {fmtCurrency(wt.pnl, true)}
                      </div>
                      <div className="text-[10px] font-mono text-terminal-dim mt-1">{wt.trades} trades</div>
                      {(wt.wins + wt.losses) > 0 && (
                        <div className={`text-[10px] font-mono mt-0.5 ${
                          (wt.wins / (wt.wins + wt.losses)) >= 0.5 ? 'text-terminal-green' : 'text-terminal-amber'
                        }`}>
                          {((wt.wins / (wt.wins + wt.losses)) * 100).toFixed(0)}% WR
                        </div>
                      )}
                    </>
                  ) : <span className="text-terminal-dim text-xs">—</span>}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── LEGEND ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 text-xs font-mono text-terminal-muted">
        <span>Color intensity = P&L magnitude</span>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: isLight ? 'rgba(22,163,74,0.55)' : 'rgba(0,150,50,0.6)' }} />
          <span>Profitable day</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded" style={{ backgroundColor: isLight ? 'rgba(220,38,38,0.55)' : 'rgba(150,30,30,0.6)' }} />
          <span>Loss day</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded ring-1 ring-terminal-green/40" />
          <span>Today</span>
        </div>
      </div>
    </div>
  );
}
