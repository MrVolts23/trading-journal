// Trading Desk · Trainer — shared helpers: Vancouver time, bar lookups, session boxes, drawing math.
// Every drawing is stored as true UTC seconds + price, never as a spot on the screen, so the same
// mark lands correctly on both charts whatever their timeframes.

export const TZ = 'America/Vancouver';

// ── Vancouver time ───────────────────────────────────────────────────────────────────
const _offFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' });
const _offCache = new Map();
// Vancouver's offset from UTC (seconds, negative) at a UTC instant. Cached per UTC hour.
export function vanOffset(utc) {
  const key = Math.floor(utc / 3600);
  let off = _offCache.get(key);
  if (off === undefined) {
    const tz = _offFmt.formatToParts(new Date(utc * 1000)).find((p) => p.type === 'timeZoneName').value;
    const m = /GMT([+-]\d+)(?::(\d+))?/.exec(tz);
    off = m ? (+m[1]) * 3600 : -8 * 3600;
    _offCache.set(key, off);
  }
  return off;
}
// The chart library draws times as UTC, so each bar is handed over as "Vancouver wall-clock, read as UTC".
export const toChartTime = (utc) => utc + vanOffset(utc);

const _dt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const _dtY = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtVan = (utc) => (utc == null ? '' : _dt.format(new Date(utc * 1000)));
export const fmtVanYear = (utc) => (utc == null ? '' : _dtY.format(new Date(utc * 1000)));

// "2026-07-02T15:30" typed as Vancouver wall-clock -> UTC seconds
export function vanInputToUtc(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
  let utc = wall + 8 * 3600;
  utc = wall - vanOffset(utc);
  return wall - vanOffset(utc);
}
export function utcToVanInput(utc) {
  const d = new Date(toChartTime(utc) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export const TF_LABEL = { 1: '1 min', 2: '2 min', 3: '3 min', 5: '5 min', 10: '10 min', 15: '15 min', 30: '30 min', 60: '1 hour', 120: '2 hours', 240: '4 hours' };

// ── bars ─────────────────────────────────────────────────────────────────────────────
// index of the last bar whose open time is <= T (or -1)
export function barIndexAt(t, T) {
  let lo = 0, hi = t.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] <= T) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
// A time as a (fractional) position along the bars: bar i's open sits at i, its close at i+1.
// Times past the last bar keep counting in bar-widths; times inside a market gap sit on the next bar.
export function timeToIndex(bars, T) {
  const { t, n, tf } = bars; const step = tf * 60;
  if (!n) return 0;
  if (T <= t[0]) return (T - t[0]) / step;
  const i = barIndexAt(t, T);
  if (i >= n - 1) return (n - 1) + (T - t[n - 1]) / step;
  const frac = (T - t[i]) / step;
  return frac < 1 ? i + frac : i + 1;
}
export function indexToTime(bars, idx) {
  const { t, n, tf } = bars; const step = tf * 60;
  if (!n) return 0;
  if (idx <= 0) return t[0] + idx * step;
  if (idx >= n - 1) return t[n - 1] + (idx - (n - 1)) * step;
  const i = Math.floor(idx);
  return t[i] + (idx - i) * step;
}

// ── sessions (LuxAlgo Sessions settings Mike uses; hours are UTC all year) ─────────────
export const SESSIONS = [
  { name: 'Tokyo',    start: 0,  end: 9,  color: '#d63864' },
  { name: 'London',   start: 7,  end: 16, color: '#3b5bfd' },
  { name: 'New York', start: 13, end: 22, color: '#f26b1d' },
];
// Session boxes that overlap [fromT, toT], each sized to the high/low of the bars inside it (up to shownN bars).
export function sessionBoxes(bars, shownN, fromT, toT) {
  const out = [];
  if (!bars.n || !(toT > fromT)) return out;
  const { t, h, l, tf } = bars; const step = tf * 60;
  const day0 = Math.floor(fromT / 86400) - 1, day1 = Math.floor(toT / 86400);
  for (let d = day0; d <= day1; d++) {
    for (const s of SESSIONS) {
      const a = d * 86400 + s.start * 3600, b = d * 86400 + s.end * 3600;
      if (b <= fromT || a >= toT) continue;
      let i = barIndexAt(t, a - 1) + 1; // first bar opening at or after the session start
      let hi = -Infinity, lo = Infinity, first = -1, last = -1;
      for (; i < shownN && t[i] < b; i++) { if (first < 0) first = i; last = i; if (h[i] > hi) hi = h[i]; if (l[i] < lo) lo = l[i]; }
      if (first < 0) continue;
      out.push({ key: `${s.name}-${d}`, name: s.name, color: s.color, t1: t[first], t2: t[last] + step, hi, lo });
    }
  }
  return out;
}

// ── drawings ─────────────────────────────────────────────────────────────────────────
let _id = 0;
export const newId = () => `d${Date.now().toString(36)}${(_id++).toString(36)}`;

export const isPosition = (d) => d.type === 'long' || d.type === 'short';
export function positionStats(d) {
  const risk = Math.abs(d.entry - d.stop), reward = Math.abs(d.target - d.entry);
  return {
    risk, reward,
    rr: risk > 0 ? reward / risk : 0,
    stopPct: d.entry ? (risk / d.entry) * 100 : 0,
    targetPct: d.entry ? (reward / d.entry) * 100 : 0,
  };
}
// keep a long's stop below and target above the entry (and the reverse for a short) while dragging
export function clampPosition(d) {
  const eps = 5 * tick();
  const o = { ...d };
  if (o.type === 'long') { if (o.stop > o.entry - eps) o.stop = o.entry - eps; if (o.target < o.entry + eps) o.target = o.entry + eps; }
  else { if (o.stop < o.entry + eps) o.stop = o.entry + eps; if (o.target > o.entry - eps) o.target = o.entry - eps; }
  if (o.t2 <= o.t) o.t2 = o.t + 60;
  return o;
}
// keep the old order inside the file: tick() is defined above clampPosition at runtime (hoisted consts are not), so clampPosition reads it lazily
// Price decimals follow the instrument on the charts (gold 2, most forex 5). The Trainer sets this when candles load.
export let PRICE_DIGITS = 2;
export const setPriceDigits = (d) => { PRICE_DIGITS = Number.isInteger(d) && d >= 0 && d <= 8 ? d : 2; };
export const tick = () => 10 ** -PRICE_DIGITS;                              // the smallest price step
export const fmtP = (x) => (x == null || !Number.isFinite(x) ? '' : x.toFixed(PRICE_DIGITS));
export const roundP = (x) => Math.round(x * 10 ** PRICE_DIGITS) / 10 ** PRICE_DIGITS;
export const round2 = roundP;

export function describeOutcome(o) {
  if (!o) return '';
  const dur = o.minutes == null ? '' : o.minutes >= 90 ? ` after ${(o.minutes / 60).toFixed(1)} hours` : ` after ${o.minutes} minutes`;
  const plan = o.exit_plan ? ` under "${o.exit_plan}"` : '';
  const rs = o.r == null ? '' : ` (${o.r > 0 ? '+' : ''}${o.r}R)`;
  const ran = o.best_r_before_exit != null ? ` It ran ${o.best_r_before_exit}R your way at best.` : '';
  let text = '';
  if (o.result === 'target') text = `Hit the target${dur}${rs}${plan}.`;
  else if (o.result === 'stop') text = `Hit the stop${dur}${rs}${plan}.${ran}`;
  else if (o.result === 'trail') text = `The moved stop took it out${dur}${rs}${plan}.${ran}`;
  else if (o.result === 'partial') text = `Closed in parts${dur}${rs}${plan}.${ran}`;
  else if (o.result === 'time') text = `Closed at the time of day${dur}${rs}${plan}.${ran}`;
  else if (o.result === 'structure') text = `Out on the opposite 1-2-3 you marked${dur}${rs}${plan}.${ran}`;
  else if (o.result === 'open') text = `Not finished yet${plan}: nothing in this exit plan has fired in the data loaded so far.`;
  else text = o.note || '';
  if (o.note && o.result !== 'open' && o.result !== 'invalid') text += ` ${o.note}`;
  return text;
}
