#!/usr/bin/env node
// Gold Metal Alchemist — trade card renderer.
// For every MT5-ingested trade without a picture: renders a 3-panel SVG (1-min / 3-min /
// 15-min views) from MT5 M1 history with entry / SL / exit lines, stores it as a data URL
// in trades.screenshot. MT5 data only (SCOPE.md decision #11) — no TradingView.
//
// Usage: node loops/render/trade_cards.js [m1CsvPath]

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const CSV =
  process.argv[2] ||
  path.join(
    os.homedir(),
    'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/goldbridge/out/gma_history_XAUUSD_M1.csv'
  );
const DB_PATH =
  process.env.TRADING_JOURNAL_DB ||
  path.join(os.homedir(), 'Library/Application Support/mikes-trading-journal/journal.db');

const SERVER_TO_PT = 10 * 3600; // server wall clock (UTC+3-style) → Pacific

// ── M1 data ────────────────────────────────────────────────────────────────────
function loadM1(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const [ts, o, h, l, c, v] = lines[i].trim().split(',');
    if (!ts || !o) continue;
    const m = ts.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/);
    if (!m) continue;
    bars.push({
      t: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, // server-wall seconds
      o: +o, h: +h, l: +l, c: +c,
    });
  }
  return bars;
}

function aggregate(bars, minutes) {
  if (minutes === 1) return bars;
  const out = [];
  let bucket = null, bucketKey = null;
  for (const b of bars) {
    const key = Math.floor(b.t / (minutes * 60));
    if (key !== bucketKey) {
      if (bucket) out.push(bucket);
      bucket = { t: key * minutes * 60, o: b.o, h: b.h, l: b.l, c: b.c };
      bucketKey = key;
    } else {
      bucket.h = Math.max(bucket.h, b.h);
      bucket.l = Math.min(bucket.l, b.l);
      bucket.c = b.c;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

function ptLabel(t) {
  const d = new Date((t - SERVER_TO_PT) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ── SVG panel ──────────────────────────────────────────────────────────────────
function panel(bars, tfMin, trade, y0, W, H) {
  const PAD_R = 64;
  const plotW = W - PAD_R;
  const levels = [
    { p: trade.entry_price, color: '#e6edf3', name: 'entry' },
    { p: trade.stop_loss, color: '#ef4444', name: 'SL' },
    { p: trade.exit_price, color: '#58a6ff', name: 'exit' },
  ].filter((x) => x.p);

  let min = Math.min(...bars.map((b) => b.l), ...levels.map((x) => x.p));
  let max = Math.max(...bars.map((b) => b.h), ...levels.map((x) => x.p));
  const pad = (max - min) * 0.06 || 1;
  min -= pad; max += pad;
  const y = (p) => y0 + 18 + (H - 26) * (1 - (p - min) / (max - min));
  const step = plotW / bars.length;
  const cw = Math.max(1, Math.min(step * 0.7, 8));

  let s = `<text x="6" y="${y0 + 12}" fill="#8b949e" font-size="11" font-family="monospace">` +
    `${tfMin}-min · ${ptLabel(bars[0].t)} → ${ptLabel(bars[bars.length - 1].t + tfMin * 60)} PT</text>`;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const x = i * step + step / 2;
    const up = b.c >= b.o;
    const col = up ? '#22c55e' : '#ef4444';
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    s += `<rect x="${(x - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" fill="${col}"/>`;
  }
  // Level lines — labels de-collided: if two levels land within 12px, stagger them.
  const placed = [];
  const byPrice = levels.slice().sort((a, b) => y(a.p) - y(b.p));
  for (const lv of byPrice) {
    const ly = y(lv.p);
    let labelY = ly + 3;
    while (placed.some((py) => Math.abs(py - labelY) < 12)) labelY += 12;
    placed.push(labelY);
    s += `<line x1="0" x2="${plotW}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${lv.color}" stroke-width="1" stroke-dasharray="5,4" opacity="0.85"/>`;
    s += `<text x="${plotW + 4}" y="${labelY.toFixed(1)}" fill="${lv.color}" font-size="10" font-family="monospace">${lv.name} ${lv.p}</text>`;
  }
  return s;
}

function renderCard(trade, m1) {
  const toSec = (dt) => {
    const m = dt.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):?(\d{2})?/);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  };
  const entryT = toSec(trade.entry_datetime);
  const exitT = toSec(trade.exit_datetime || trade.entry_datetime);

  // ONE shared window for all panels — Mike's zoom-sequence spec: the 15-min panel frames
  // the entry rationale (8 candles of context before entry, 2 after exit), and the 3-min
  // and 1-min panels expand that SAME window at finer resolution.
  const from = entryT - 8 * 15 * 60;
  const to = exitT + 2 * 15 * 60;

  const W = 760, PH = 260, GAP = 14, HEAD = 34;
  const tfs = [15, 3, 1]; // top → bottom: context first, then zoom in
  let panels = '', missing = false;

  tfs.forEach((tf, i) => {
    const slice = m1.filter((b) => b.t >= from && b.t <= to);
    if (slice.length < 10) { missing = true; return; }
    const bars = aggregate(slice, tf);
    panels += `<g>${panel(bars, tf, trade, HEAD + i * (PH + GAP), W, PH)}</g>`;
  });
  if (missing) return null;

  const pnlCol = trade.pnl >= 0 ? '#22c55e' : '#ef4444';
  const title =
    `${trade.symbol} ${trade.position} ${trade.lot_size} · ${trade.entry_price} → ${trade.exit_price}` +
    ` · P&amp;L <tspan fill="${pnlCol}">${trade.pnl >= 0 ? '+' : ''}${trade.pnl}</tspan>` +
    ` · ${ptLabel(entryT)} PT`;

  const totalH = HEAD + tfs.length * (PH + GAP);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">` +
    `<rect width="${W}" height="${totalH}" fill="#0d1117"/>` +
    `<text x="6" y="20" fill="#e6edf3" font-size="13" font-family="monospace">${title}</text>` +
    panels + `</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

// ── Main ───────────────────────────────────────────────────────────────────────
const m1 = loadM1(CSV);
console.log(`M1 bars loaded: ${m1.length} (${ptLabel(m1[0].t)} → ${ptLabel(m1[m1.length - 1].t)} PT)`);

const db = new Database(DB_PATH);
const trades = db
  .prepare(`SELECT * FROM trades WHERE trade_id LIKE 'MT5-%' AND (screenshot IS NULL OR screenshot = '')`)
  .all();
console.log(`Trades needing cards: ${trades.length}`);

let done = 0, skipped = 0;
const save = db.prepare('UPDATE trades SET screenshot = ? WHERE id = ?');
for (const t of trades) {
  const card = renderCard(t, m1);
  if (!card) { skipped++; continue; }
  save.run(card, t.id);
  done++;
}
console.log(`Cards rendered: ${done}, skipped (no M1 coverage): ${skipped}`);
