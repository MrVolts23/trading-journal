#!/usr/bin/env node
// Gold Metal Alchemist — backfill gma_alchemy_days from an MT5 M1 history dump.
// Usage: node loops/backfill_alchemy.js [csvPath]
//
// Server time = UTC+3 (verified against the Jul 3 early close: 19:50 server == 09:50 PT).
// Session date D (the PT date of the 3pm open) maps to server time as:
//   key window:   D+1 01:00–01:59 server  (Mike's 3–4pm PT key hour, 60 M1 bars)
//   print window: D+1 02:00 → D+2 00:00 server (4pm PT → 2pm PT next day)
// Print bars are aggregated M1 → 15m locally (baseline timeframe; sweep re-derives others).

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { scoreDay } = require('../backend/src/services/gmaScoreService');

const CSV =
  process.argv[2] ||
  path.join(
    os.homedir(),
    'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/goldbridge/out/gma_history_XAUUSD_M1.csv'
  );
const DB_PATH =
  process.env.TRADING_JOURNAL_DB ||
  path.join(os.homedir(), 'Library/Application Support/mikes-trading-journal/journal.db');

// Parse "2026.03.24 01:10:00" as a server-time key (keep as components; no TZ conversion needed
// since all windowing is done in server time).
function parseLine(line) {
  const [ts, o, h, l, c, v] = line.split(',');
  if (!ts || !o) return null;
  const m = ts.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    hm: m[4] + m[5], // "0110"
    epochish: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000, // minutes, server-clock
    o: +o, h: +h, l: +l, c: +c, v: +v,
  };
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function aggregate15m(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i += 15) {
    const chunk = bars.slice(i, i + 15);
    out.push({
      t: chunk[0].epochish * 60,
      o: chunk[0].o,
      h: Math.max(...chunk.map((b) => b.h)),
      l: Math.min(...chunk.map((b) => b.l)),
      c: chunk[chunk.length - 1].c,
      v: chunk.reduce((a, b) => a + b.v, 0),
    });
  }
  return out;
}

const lines = fs.readFileSync(CSV, 'utf8').split('\n');
const bars = [];
for (let i = 1; i < lines.length; i++) {
  const b = parseLine(lines[i].trim());
  if (b) bars.push(b);
}
console.log(`Parsed ${bars.length} M1 bars: ${bars[0].date} → ${bars[bars.length - 1].date}`);

// Index bars by server date for fast window slicing
const byDate = {};
for (const b of bars) (byDate[b.date] ||= []).push(b);

const db = new Database(DB_PATH);
const upsert = db.prepare(`
  INSERT INTO gma_alchemy_days (date, symbol, key_ohlc, print_ohlc, key_range, print_range)
  VALUES (@date, 'XAUUSD', @key, @print, @krange, @prange)
  ON CONFLICT(date, symbol) DO UPDATE SET
    key_ohlc    = COALESCE(gma_alchemy_days.key_ohlc,    excluded.key_ohlc),
    print_ohlc  = COALESCE(gma_alchemy_days.print_ohlc,  excluded.print_ohlc),
    key_range   = COALESCE(gma_alchemy_days.key_range,   excluded.key_range),
    print_range = COALESCE(gma_alchemy_days.print_range, excluded.print_range)
`);

let daysDone = 0, daysScored = 0, skipped = 0;
const serverDates = Object.keys(byDate).sort();

for (const S of serverDates) {
  // Key window: server date S, 01:00–01:59
  const keyBars = byDate[S].filter((b) => b.hm >= '0100' && b.hm <= '0159');
  if (keyBars.length < 40) { skipped++; continue; } // holiday/short/no-key day

  // Print window: S 02:00 → S+1 00:00 (exclusive)
  const printM1 = byDate[S].filter((b) => b.hm >= '0200')
    .concat((byDate[shiftDate(S, 1)] || []).filter((b) => b.hm < '0001'));
  if (printM1.length < 200) { skipped++; continue; } // incomplete session at dump edges

  const sessionDate = shiftDate(S, -1); // PT date of the 3pm open
  const key = keyBars.map((b) => ({ t: b.epochish * 60, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  const print = aggregate15m(printM1);
  const krange = Math.max(...key.map((b) => b.h)) - Math.min(...key.map((b) => b.l));
  const prange = Math.max(...print.map((b) => b.h)) - Math.min(...print.map((b) => b.l));

  upsert.run({
    date: sessionDate,
    key: JSON.stringify(key),
    print: JSON.stringify(print),
    krange: Number(krange.toFixed(2)),
    prange: Number(prange.toFixed(2)),
  });
  daysDone++;

  const day = db.prepare("SELECT id, key_ohlc, print_ohlc FROM gma_alchemy_days WHERE date = ? AND symbol = 'XAUUSD'").get(sessionDate);
  if (day.key_ohlc && day.print_ohlc && scoreDay(db, day.id)) daysScored++;
}

const total = db.prepare('SELECT COUNT(*) n FROM gma_alchemy_days').get().n;
const withMachine = db.prepare('SELECT COUNT(*) n FROM gma_verdicts WHERE machine_code IS NOT NULL').get().n;
console.log(`Backfill: ${daysDone} sessions written, ${daysScored} machine-scored, ${skipped} skipped (short/holiday/edge).`);
console.log(`DB now: ${total} alchemy days, ${withMachine} with machine calls (hidden until your blind verdicts).`);
