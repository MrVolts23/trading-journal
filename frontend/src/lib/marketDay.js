// Market days — the ONE place the app decides what day a trade belongs to.
//
// A market day starts in the afternoon, Vancouver time, when the markets open:
//   forex  2:00 PM  (the Sunday 2 PM open is "Monday")
//   metals 3:00 PM  (gold opens Sunday 3 PM; that too is "Monday")
// and runs to the same time the next afternoon. There are five market days, Monday to Friday.
// Anything that lands on the weekend (after Friday's open, or Saturday) is the coming Monday.
//
// Mike's rule (2026-10-02): a trade belongs to the market day of its EXIT (the day the money landed);
// an open trade belongs to the day it was entered.
//
// This is the ESM copy of backend/src/lib/marketDay.js — keep the two identical.

const VAN = 'America/Vancouver';
const DAY_MS = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const _fmt = new Map();
function fmt(tz) {
  if (!_fmt.has(tz)) _fmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset' }));
  return _fmt.get(tz);
}
// wall-clock parts of a UTC instant in a timezone, plus that zone's offset in seconds
function wallParts(tz, utcMs) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(p.timeZoneName || '');
  const off = m ? (Number(m[1]) * 3600 + (m[1][0] === '-' ? -1 : 1) * Number(m[2] || 0) * 60) : 0;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second, offset: off };
}
// Seconds offset of a timezone at a UTC instant
const offsetAt = (tz, utcSec) => wallParts(tz, utcSec * 1000).offset;

// "YYYY-MM-DD HH:MM[:SS]" written in some wall clock -> UTC seconds.
//   'server'    = the MetaTrader broker clock Eightcap uses (New York + 7 hours, all year)
//   'prague'    = FTMO's clock
//   'vancouver' = Mike's clock
//   'utc'
function naiveToUtc(str, source = 'server') {
  const m = /^(\d{4})[-.](\d{2})[-.](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(str || ''));
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (source === 'utc') return wall;
  const tz = source === 'prague' ? 'Europe/Prague' : source === 'vancouver' ? VAN : 'America/New_York';
  const local = source === 'server' ? wall - 7 * 3600 : wall; // server clock = New York wall clock + 7h
  let utc = local - offsetAt(tz, local);
  utc = local - offsetAt(tz, utc);
  return utc;
}

// Which boundary applies: metals open an hour after forex.
function isMetal(market) {
  const s = String(market || '').toUpperCase();
  return s.includes('METAL') || s.startsWith('XAU') || s.startsWith('XAG') || s === 'GOLD' || s === 'SILVER';
}
const boundaryMinutes = (market) => (isMetal(market) ? 15 * 60 : 14 * 60);

const iso = (dayMs) => new Date(dayMs).toISOString().slice(0, 10);
const dayMsOf = (isoDay) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDay || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };

// The market day ("YYYY-MM-DD") that a UTC instant (seconds) falls in.
function marketDay(utcSec, market = 'forex') {
  if (utcSec == null || !Number.isFinite(utcSec)) return null;
  const p = wallParts(VAN, utcSec * 1000);
  let day = Date.UTC(p.y, p.m - 1, p.d);
  if (p.hh * 60 + p.mm >= boundaryMinutes(market)) day += DAY_MS; // after the open: it is already tomorrow's market day
  const wd = new Date(day).getUTCDay();
  if (wd === 6) day += 2 * DAY_MS;      // Saturday  -> Monday
  else if (wd === 0) day += DAY_MS;     // Sunday (before the open) -> Monday
  return iso(day);
}
const marketDayFromNaive = (str, market = 'forex', source = 'server') => { const u = naiveToUtc(str, source); return u == null ? null : marketDay(u, market); };
const marketWeekday = (isoDay) => { const ms = dayMsOf(isoDay); return ms == null ? null : WEEKDAYS[new Date(ms).getUTCDay()]; };
// Monday of the market week a market day sits in
function marketWeekStart(isoDay) {
  const ms = dayMsOf(isoDay); if (ms == null) return null;
  const wd = new Date(ms).getUTCDay();
  return iso(ms - ((wd + 6) % 7) * DAY_MS);
}
const todayMarketDay = (market = 'forex') => marketDay(Date.now() / 1000, market);
// Is the market open right now? (closed from Friday's boundary until Sunday's)
function marketOpenNow(market = 'forex', nowSec = Date.now() / 1000) {
  const p = wallParts(VAN, nowSec * 1000);
  const wd = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(), mins = p.hh * 60 + p.mm, b = boundaryMinutes(market);
  if (wd === 6) return false;
  if (wd === 0) return mins >= b;
  if (wd === 5) return mins < b;
  return true;
}
// weekday column for a trade: the market day of its exit (or of its entry while it is still open)
const tradeWeekday = (exitDt, entryDt, market, source = 'server') => marketWeekday(marketDayFromNaive(exitDt || entryDt, market, source));

export { VAN, WEEKDAYS, naiveToUtc, offsetAt, isMetal, boundaryMinutes, marketDay, marketDayFromNaive, marketWeekday, marketWeekStart, todayMarketDay, marketOpenNow, tradeWeekday };
