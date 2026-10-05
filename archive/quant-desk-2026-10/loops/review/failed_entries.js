#!/usr/bin/env node
// Failed-entry review packet: every champion-system trade that died a full -1R.
// For each: PT date/time + 15m arm-context and 3m trigger panels with entry/SL lines.
// Output: review/failed-entries/ (SVGs + index.html + failed_entries.csv)
// Mike reviews one by one and tells us WHY each didn't work — the part-3 corpus.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadM1, runDoubleBOS, aggregate } = require('../backtest/engine');

const CSV_IN = path.join(
  os.homedir(),
  'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/goldbridge/out/gma_history_XAUUSD_M1.csv'
);
const OUT_DIR = path.join(__dirname, '../../review/failed-entries');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHAMP = { pivotStrengthLtf: 1, armMode: 'either', maxEntriesPerArm: 3, exitModel: 'liquidity_v1', trailPadUsd: 0.30 };

const m1 = loadM1(CSV_IN);
const all = runDoubleBOS(m1, CHAMP).trades;
const losers = all.filter((t) => t.r <= -0.95).sort((a, b) => a.entryT - b.entryT);
console.log(`Full -1R losers: ${losers.length} of ${all.length} trades`);

const PT = (t) => {
  const d = new Date((t - 36000) * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} PT`;
};

function panel(bars, tfMin, trade, y0, W, H) {
  const PAD_R = 70, plotW = W - PAD_R;
  const levels = [
    { p: trade.entry, color: '#e6edf3', name: 'entry' },
    { p: trade.sl, color: '#ef4444', name: 'SL' },
  ];
  let min = Math.min(...bars.map((b) => b.l), ...levels.map((x) => x.p));
  let max = Math.max(...bars.map((b) => b.h), ...levels.map((x) => x.p));
  const pad = (max - min) * 0.06 || 1;
  min -= pad; max += pad;
  const y = (p) => y0 + 18 + (H - 26) * (1 - (p - min) / (max - min));
  const step = plotW / bars.length, cw = Math.max(1.5, Math.min(step * 0.7, 8));
  let s = `<text x="6" y="${y0 + 12}" fill="#8b949e" font-size="11" font-family="monospace">${tfMin}-min · entry marked</text>`;
  bars.forEach((b, i) => {
    const x = i * step + step / 2, up = b.c >= b.o, col = up ? '#22c55e' : '#ef4444';
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    s += `<rect x="${(x - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" fill="${col}"/>`;
    // entry marker arrow on the bar closest to entry time
    if (Math.abs(b.t - trade.entryT) < tfMin * 60) {
      s += `<text x="${x.toFixed(1)}" y="${y0 + H - 2}" fill="#eab308" font-size="12" text-anchor="middle">▲</text>`;
    }
  });
  const placed = [];
  for (const lv of levels.sort((a, b) => y(a.p) - y(b.p))) {
    const ly = y(lv.p);
    let labelY = ly + 3;
    while (placed.some((py) => Math.abs(py - labelY) < 12)) labelY += 12;
    placed.push(labelY);
    s += `<line x1="0" x2="${plotW}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="${lv.color}" stroke-width="1" stroke-dasharray="5,4" opacity="0.85"/>`;
    s += `<text x="${plotW + 4}" y="${labelY.toFixed(1)}" fill="${lv.color}" font-size="10" font-family="monospace">${lv.name} ${lv.p}</text>`;
  }
  return s;
}

const rows = [];
losers.forEach((t, n) => {
  const num = String(n + 1).padStart(2, '0');
  const W = 760, PH = 230, GAP = 12, HEAD = 30;
  const p15 = aggregate(m1.filter((b) => b.t >= t.entryT - 30 * 900 && b.t <= t.exitT + 8 * 900), 15);
  const p3 = aggregate(m1.filter((b) => b.t >= t.entryT - 30 * 180 && b.t <= t.exitT + 10 * 180), 3);
  if (p15.length < 5 || p3.length < 5) return;
  const title = `#${num} · ${PT(t.entryT)} · ${t.session.toUpperCase()} · ${t.armType} arm · ${t.dir === 'bull' ? 'LONG' : 'SHORT'} @${t.entry} SL ${t.sl} → ${t.r}R`;
  const totalH = HEAD + 2 * (PH + GAP);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">` +
    `<rect width="${W}" height="${totalH}" fill="#0d1117"/>` +
    `<text x="6" y="18" fill="#e6edf3" font-size="12" font-family="monospace">${title}</text>` +
    `<g>${panel(p15, 15, t, HEAD, W, PH)}</g>` +
    `<g>${panel(p3, 3, t, HEAD + PH + GAP, W, PH)}</g></svg>`;
  fs.writeFileSync(path.join(OUT_DIR, `trade_${num}.svg`), svg);
  rows.push({ num, when: PT(t.entryT), session: t.session, armType: t.armType, dir: t.dir, entry: t.entry, sl: t.sl, r: t.r, title });
});

// CSV for punching into charts
fs.writeFileSync(
  path.join(OUT_DIR, 'failed_entries.csv'),
  'num,datetime_pt,session,arm_type,direction,entry,sl,result_r\n' +
  rows.map((r) => `${r.num},"${r.when}",${r.session},${r.armType},${r.dir},${r.entry},${r.sl},${r.r}`).join('\n')
);

// One-page review index
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Failed Entries — Part 3 Review</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:ui-monospace,monospace;max-width:820px;margin:0 auto;padding:20px}
h1{font-size:18px} .card{margin:28px 0;border:1px solid #30363d;border-radius:8px;padding:10px}
img{width:100%;border-radius:4px} textarea{width:100%;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:inherit;font-size:12px;min-height:52px}
.hint{color:#8b949e;font-size:12px}</style></head><body>
<h1>Failed Entries — why didn't these take off? (${rows.length} trades)</h1>
<p class="hint">The system took every one of these by your v2.1 rules and lost a full R without the trade ever paying.
Go to your charts at each date/time and note what YOU see that the rules don't. Type in the boxes (notes save in this browser) or just dictate to Claude by number.</p>
${rows.map((r) => `<div class="card"><img src="trade_${r.num}.svg" alt="${r.title}"/>
<textarea placeholder="#${r.num} — why didn't this work? what would your eye have seen?" oninput="localStorage.setItem('fe_${r.num}',this.value)"></textarea></div>`).join('\n')}
<script>document.querySelectorAll('textarea').forEach((t,i)=>{const k='fe_'+String(i+1).padStart(2,'0');t.value=localStorage.getItem(k)||''});</script>
</body></html>`;
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
console.log(`Packet ready: ${rows.length} cards → ${OUT_DIR}/index.html (+ failed_entries.csv)`);
