import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// ── Persistence ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'alchemy_calendar_v1';

function loadSelections() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveSelections(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
}

// ── Options ────────────────────────────────────────────────────────────────────
const OPTIONS = [
  { value: 'none',  label: 'None',  short: '—'   },
  { value: 'flipH', label: 'Flip H', short: 'H'  },
  { value: 'flipV', label: 'Flip V', short: 'V'  },
  { value: 'both',  label: 'Both',   short: 'H+V' },
];

const OPTION_COLORS = {
  none:  { active: 'bg-green-900/30 border-green-600/60 text-green-400 font-semibold', inactive: 'bg-transparent border-terminal-border/40 text-terminal-dim/50 hover:border-terminal-border hover:text-terminal-dim' },
  flipH: { active: 'bg-amber-900/40 border-amber-600/70 text-amber-400 font-semibold', inactive: 'bg-transparent border-terminal-border/40 text-terminal-dim/50 hover:border-amber-700/50 hover:text-amber-600' },
  flipV: { active: 'bg-amber-900/40 border-amber-600/70 text-amber-400 font-semibold', inactive: 'bg-transparent border-terminal-border/40 text-terminal-dim/50 hover:border-amber-700/50 hover:text-amber-600' },
  both:  { active: 'bg-orange-900/40 border-orange-500/70 text-orange-400 font-semibold', inactive: 'bg-transparent border-terminal-border/40 text-terminal-dim/50 hover:border-orange-700/50 hover:text-orange-500' },
};

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmtIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function buildWeeks(year, month) {
  const firstDay = new Date(year, month - 1, 1);
  const lastDay  = new Date(year, month, 0);

  // Start from Monday of the week containing the 1st
  let dow = firstDay.getDay(); // 0=Sun
  dow = dow === 0 ? 6 : dow - 1; // convert to Mon=0
  const start = new Date(firstDay);
  start.setDate(start.getDate() - dow);

  const weeks = [];
  let cur = new Date(start);

  while (cur <= lastDay || weeks.length < 5) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(cur);
      week.push({
        date,
        dateStr: fmtIso(date),
        inMonth: date.getMonth() === month - 1,
        isTrailing: date.getMonth() > month - 1 || (date.getMonth() === 0 && month === 12 && date.getFullYear() > year),
      });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
    if (cur > lastDay && weeks.length >= 5) break;
  }
  return weeks;
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function AlchemyCalendarPage() {
  const today = fmtIso(new Date());
  const [year,  setYear]  = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [selections, setSelections] = useState(loadSelections);

  // Persist on every change
  useEffect(() => { saveSelections(selections); }, [selections]);

  const prevMonth = () => {
    if (month === 1) { setYear(y => y - 1); setMonth(12); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setYear(y => y + 1); setMonth(1); }
    else setMonth(m => m + 1);
  };

  const setOption = (dateStr, value) => {
    setSelections(s => ({ ...s, [dateStr]: value }));
  };

  const weeks = buildWeeks(year, month);

  // Summary counts for the month
  const monthDates = weeks.flat().filter(c => c.inMonth).map(c => c.dateStr);
  const counts = { none: 0, flipH: 0, flipV: 0, both: 0 };
  monthDates.forEach(d => { const v = selections[d]; if (v) counts[v] = (counts[v] || 0) + 1; });
  const tagged = counts.flipH + counts.flipV + counts.both;
  const reviewed = counts.none + tagged; // days that have been actively tagged with any option

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-mono font-semibold text-terminal-text tracking-wide">Alchemy Calendar</h1>
          <p className="text-xs font-mono text-terminal-muted mt-0.5">
            Track which flip transformation was applied to each day's chart
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={prevMonth} className="p-1.5 rounded hover:bg-terminal-hover text-terminal-muted hover:text-terminal-text transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-mono text-terminal-text w-36 text-center">{MONTH_NAMES[month-1]} {year}</span>
          <button onClick={nextMonth} className="p-1.5 rounded hover:bg-terminal-hover text-terminal-muted hover:text-terminal-text transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Month summary */}
      {reviewed > 0 && (
        <div className="flex items-center gap-4 text-xs font-mono text-terminal-muted flex-wrap">
          {counts.none > 0   && <span><span className="text-green-400 font-semibold">{counts.none}</span> None</span>}
          {counts.flipH > 0  && <span><span className="text-amber-400 font-semibold">{counts.flipH}</span> Flip H</span>}
          {counts.flipV > 0  && <span><span className="text-amber-400 font-semibold">{counts.flipV}</span> Flip V</span>}
          {counts.both > 0   && <span><span className="text-orange-400 font-semibold">{counts.both}</span> Both</span>}
          <span className="text-terminal-dim">· {reviewed} of {monthDates.length} days reviewed</span>
        </div>
      )}

      {/* Calendar grid */}
      <div className="card overflow-hidden">
        {/* Day headers */}
        <div className="grid border-b border-terminal-border"
          style={{ gridTemplateColumns: 'repeat(5, 1fr) repeat(2, 0.22fr)' }}>
          {['MON','TUE','WED','THU','FRI','SAT','SUN'].map((d, i) => (
            <div key={i} className="py-2 px-1 text-xs font-mono text-center text-terminal-dim">{d}</div>
          ))}
        </div>

        {weeks.map((week, wi) => (
          <div key={wi} className="grid border-b border-terminal-border last:border-b-0"
            style={{ gridTemplateColumns: 'repeat(5, 1fr) repeat(2, 0.22fr)' }}>
            {week.map((cell, di) => {
              const isToday    = cell.dateStr === today;
              const isFuture   = cell.dateStr > today;
              const selection  = selections[cell.dateStr]; // undefined = untagged

              // Weekend slim columns
              if (di >= 5) {
                return (
                  <div key={di} className="border-r border-terminal-border/30 bg-terminal-surface/20"
                    style={{ minHeight: '110px' }} />
                );
              }

              // Off-month leading cells
              if (!cell.inMonth && !cell.isTrailing) {
                return (
                  <div key={di} className="border-r border-terminal-border/50 bg-terminal-surface/30"
                    style={{ minHeight: '110px' }} />
                );
              }

              return (
                <div key={di}
                  className={`border-r border-terminal-border/50 p-2 flex flex-col gap-1.5 ${
                    isToday ? 'ring-2 ring-inset ring-terminal-green/60' : ''
                  } ${!cell.inMonth ? 'opacity-30' : ''}`}
                  style={{ minHeight: '110px', backgroundColor: (selection === 'flipH' || selection === 'flipV' || selection === 'both') ? 'rgba(251,146,60,0.04)' : selection === 'none' ? 'rgba(74,222,128,0.03)' : '' }}>

                  {/* Date */}
                  <div className={`text-sm font-mono font-bold ${isToday ? 'text-terminal-green' : 'text-terminal-text/70'}`}>
                    {cell.isTrailing
                      ? cell.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : cell.date.getDate()}
                  </div>

                  {/* Option pills — hidden for future dates */}
                  {!isFuture && cell.inMonth && (
                    <div className="flex flex-col gap-1">
                      {OPTIONS.map(opt => {
                        const isActive = selection === opt.value;
                        const colors   = OPTION_COLORS[opt.value];
                        return (
                          <button
                            key={opt.value}
                            onClick={() => setOption(cell.dateStr, opt.value)}
                            className={`w-full text-left px-1.5 py-0.5 rounded border text-[10px] font-mono transition-colors leading-tight ${
                              isActive ? colors.active : colors.inactive
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Future placeholder */}
                  {isFuture && cell.inMonth && (
                    <div className="text-[10px] font-mono text-terminal-dim/30">—</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs font-mono text-terminal-muted flex-wrap">
        <span className="text-terminal-dim">Click an option to tag a day · Tags persist across sessions</span>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded border border-green-600/60 bg-green-900/30" /><span className="text-green-400">None (reviewed)</span></div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded border border-amber-600/70 bg-amber-900/40" /><span className="text-amber-400">Flip H / Flip V</span></div>
        <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded border border-orange-500/70 bg-orange-900/40" /><span className="text-orange-400">Both axes</span></div>
      </div>
    </div>
  );
}
