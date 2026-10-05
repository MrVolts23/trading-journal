// Trading Desk — price history for the Trainer's charts.
//
// Source: the read-only data robot (AlchemyDeskExporter) inside the separate DEMO MetaTrader. The robot
// has no trading code and refuses non-demo accounts. This file only ever:
//   - reads   …/MetaTrader 5 Demo/MQL5/Files/alchemy_feed/out/   (heartbeat, bars, history dumps)
//   - writes  …/MetaTrader 5 Demo/MQL5/Files/alchemy_feed/in/history_request.txt   (a date range to fetch)
// The live MetaTrader next door and GoldBridge are never read or written.
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./store');

const DEMO_DIR = process.env.TRADING_DESK_DEMO_DIR || path.join(
  os.homedir(), 'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5 Demo');
const FEED_OUT = path.join(DEMO_DIR, 'MQL5', 'Files', 'alchemy_feed', 'out');
const FEED_IN = path.join(DEMO_DIR, 'MQL5', 'Files', 'alchemy_feed', 'in');
const FRESH_S = 30;

function robot() {
  const f = path.join(FEED_OUT, 'heartbeat.json');
  let st; try { st = fs.statSync(f); } catch (_) { return { alive: false, why: 'The demo MetaTrader has never run its data robot.' }; }
  const age = (Date.now() - st.mtimeMs) / 1000;
  if (age > FRESH_S) return { alive: false, why: 'The demo MetaTrader is not open. Double-click "Alchemy Trading Desk - Demo MetaTrader" on your Desktop.' };
  let hb; try { hb = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return { alive: false, why: 'The data robot is mid-write; try again in a moment.' }; }
  if (hb.is_demo !== true || hb.trade_mode !== 'demo') return { alive: false, why: 'The data robot is not on a demo account, so it is being ignored.' };
  if (!/MetaTrader 5 Demo/i.test(hb.terminal_data_path || '')) return { alive: false, why: 'The data robot is not inside the demo MetaTrader, so it is being ignored.' };
  return { alive: true, symbol: hb.symbol, server_epoch: hb.server_epoch, bid: hb.bid, market_open: hb.market_open, first_on_server: hb.m1_first_on_server, state: hb.state, note: hb.note };
}

function parseLine(line) {
  const p = line.split(',');
  if (p.length < 5) return null;
  const ts = store.parseServerTime(p[0]);
  const o = +p[1], h = +p[2], l = +p[3], c = +p[4];
  if (ts == null || ![o, h, l, c].every(Number.isFinite) || h < l) return null;
  return { ts, o, h, l, c, v: Number.isFinite(+p[5]) ? Math.round(+p[5]) : null };
}

// Stream a csv into the bar store (a year of one-minute bars never has to fit in memory as text).
function ingestCsv(file, symbol = store.SYMBOL) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  let carry = '', read = 0, seen = 0, batch = [];
  const flush = () => { if (batch.length) { store.insertBars(batch, symbol); batch = []; } };
  try {
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const lines = (carry + buf.toString('utf8', 0, read)).split(/\r?\n/);
      carry = lines.pop();
      for (const line of lines) { const b = parseLine(line); if (b) { batch.push(b); seen++; if (batch.length >= 50000) flush(); } }
    }
    const b = parseLine(carry); if (b) { batch.push(b); seen++; }
    flush();
  } finally { fs.closeSync(fd); }
  return seen;
}

const ymd = (ts) => { const d = new Date(ts * 1000); return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`; };

function pending() { return store.kvGet('history_pending'); }

// Ask the robot for a stretch of one-minute gold history. One request at a time.
function request({ months = 12, from = null, symbol = store.SYMBOL } = {}) {
  const r = robot();
  if (!r.alive) { const e = new Error(r.why); e.status = 409; throw e; }
  if (pending()) { const e = new Error('A history fetch is already running.'); e.status = 409; throw e; }
  const toTs = r.server_epoch + 86400;
  const fromTs = from ? store.parseServerTime(String(from).replace(/-/g, '.') + ' 00:00') : toTs - Math.round(months * 30.5 * 86400);
  if (fromTs == null || !(toTs > fromTs)) { const e = new Error('That start date does not look right.'); e.status = 400; throw e; }
  const id = `trainer_${Date.now()}`;
  fs.mkdirSync(FEED_IN, { recursive: true });
  const tmp = path.join(FEED_IN, 'history_request.txt.tmp');
  fs.writeFileSync(tmp, `${symbol};${ymd(fromTs)};${ymd(toTs)};${id}`);
  fs.renameSync(tmp, path.join(FEED_IN, 'history_request.txt'));
  const p = { id, symbol, from: ymd(fromTs), to: ymd(toTs), requested_ms: Date.now() };
  store.kvSet('history_pending', p);
  watch();
  return p;
}

// Look for a finished dump belonging to our request; store it; tidy the feed folder.
function collect() {
  const p = pending();
  if (!p) return null;
  const done = path.join(FEED_OUT, `history_${p.id}.done`);
  if (!fs.existsSync(done)) {
    if (Date.now() - p.requested_ms > 45 * 60 * 1000) { store.kvSet('history_pending', null); store.kvSet('history_last', { ...p, failed: 'The fetch never finished. Was the demo MetaTrader closed?' }); }
    return null;
  }
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(done, 'utf8')); } catch (_) { return null; }
  const csv = path.join(FEED_OUT, meta.file || `history_${p.id}.csv`);
  if (!fs.existsSync(csv)) return null;
  const seen = ingestCsv(csv, p.symbol || store.SYMBOL);
  for (const f of [csv, done]) { try { fs.unlinkSync(f); } catch (_) {} }
  const last = { ...p, bars: seen, first: meta.first, last: meta.last, finished_ms: Date.now() };
  store.kvSet('history_pending', null);
  store.kvSet('history_last', last);
  // An instrument MetaTrader has never shown comes back nearly empty the first time, because the terminal is still
  // downloading it from the broker. Ask once more after a short wait; the second pass gets the whole stretch.
  const spanDays = (store.parseServerTime(p.to + ' 00:00') - store.parseServerTime(p.from + ' 00:00')) / 86400;
  if (!p.retry && spanDays > 7 && seen < spanDays * 0.5 * 1440 * 0.2) {
    store.kvSet('history_pending', { ...p, id: `${p.id}_r`, retry: true, requested_ms: Date.now(), waiting_ms: 30000 });
    setTimeout(() => {
      try {
        const q = pending(); if (!q || !q.retry || q.id !== `${p.id}_r`) return;
        fs.mkdirSync(FEED_IN, { recursive: true });
        const tmp = path.join(FEED_IN, 'history_request.txt.tmp');
        fs.writeFileSync(tmp, `${p.symbol || store.SYMBOL};${p.from};${p.to};${q.id}`);
        fs.renameSync(tmp, path.join(FEED_IN, 'history_request.txt'));
        watch();
      } catch (e) { console.error('[trading-desk] history retry failed:', e.message); store.kvSet('history_pending', null); }
    }, 30000).unref?.();
    watch();
  }
  return last;
}

// Top up from the robot's rolling file (the latest ~2 trading days of closed one-minute bars).
function topUp() {
  const f = path.join(FEED_OUT, 'bars_m1.csv');
  let st; try { st = fs.statSync(f); } catch (_) { return 0; }
  if (store.kvGet('rolling_mtime') === st.mtimeMs) return 0;
  const r = robot();
  if (!r.alive) return 0;
  const n = ingestCsv(f, r.symbol || store.SYMBOL); // the rolling file is for the symbol the robot's chart is on
  store.kvSet('rolling_mtime', st.mtimeMs);
  return n;
}

let timer = null;
function watch() {
  if (timer) return;
  timer = setInterval(() => {
    try { collect(); if (!pending()) { clearInterval(timer); timer = null; } }
    catch (e) { console.error('[trading-desk] history collect failed:', e.message); }
  }, 2000);
  if (timer.unref) timer.unref();
}

function status(symbol = store.SYMBOL) {
  if (pending()) { try { collect(); } catch (_) {} if (pending()) watch(); }
  const r = robot();
  return { robot: r, pending: pending(), last: store.kvGet('history_last'), coverage: store.coverage(symbol) };
}

module.exports = { robot, request, collect, topUp, status, ingestCsv, DEMO_DIR, FEED_OUT, FEED_IN };
