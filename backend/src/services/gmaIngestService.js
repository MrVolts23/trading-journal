// Gold Metal Alchemist — MT5 exporter ingest.
// Reads GMAExporter.mq5 output (gma_snapshot.json, gma_deals.json) from the GoldBridge EA
// drop folder, stores raw data, and pairs completed positions into journal trades.
// Additive only: INSERT OR IGNORE everywhere; running twice is a no-op.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDb } = require('../db/database');

const OUT_DIR =
  process.env.GMA_EA_OUT ||
  path.join(
    os.homedir(),
    'Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/goldbridge/out'
  );

// MT5 timestamps come dotted ("2026.07.03 07:02:25") — normalize so Date() and the
// journal's existing "YYYY-MM-DD HH:MM:SS" convention both work.
function normTime(ts) {
  return typeof ts === 'string' ? ts.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3') : ts;
}

function readJson(file) {
  try {
    const p = path.join(OUT_DIR, file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[GMA ingest] bad JSON in ${file}: ${e.message}`);
    return null;
  }
}

// Same behavior as importService.resolveAccount: find-or-create by broker_account_id.
function resolveAccount(db, loginId, broker = 'EightCap') {
  const loginStr = String(loginId).trim();
  const existing = db.prepare('SELECT name FROM accounts WHERE broker_account_id = ?').get(loginStr);
  if (existing) return existing.name;
  const name = `${broker} ${loginStr}`;
  try {
    db.prepare('INSERT INTO accounts (name, broker, broker_account_id) VALUES (?, ?, ?)').run(name, broker, loginStr);
    return name;
  } catch {
    const byName = db.prepare('SELECT name FROM accounts WHERE name = ?').get(name);
    return byName ? byName.name : name;
  }
}

function ingestSnapshot(db) {
  const snap = readJson('gma_snapshot.json');
  if (!snap || !snap.ts) return 0;
  const last = db.prepare('SELECT ts FROM gma_mt5_snapshots ORDER BY id DESC LIMIT 1').get();
  if (last && last.ts === snap.ts) return 0; // unchanged since last poll
  db.prepare(
    `INSERT INTO gma_mt5_snapshots (ts, account_login, balance, equity, margin, open_positions)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(snap.ts, String(snap.login || ''), snap.balance, snap.equity, snap.margin,
        JSON.stringify(snap.positions || []));
  return 1;
}

function ingestDeals(db) {
  const dump = readJson('gma_deals.json');
  if (!dump || !Array.isArray(dump.deals)) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gma_mt5_deals
       (ticket, position_id, symbol, deal_type, entry, volume, price, sl, tp,
        profit, swap, commission, comment, deal_time)
     VALUES (@ticket, @position_id, @symbol, @type, @entry, @volume, @price, @sl, @tp,
             @profit, @swap, @commission, @comment, @time)`
  );
  let added = 0;
  const tx = db.transaction((deals) => {
    for (const d of deals) {
      const info = insert.run({ ...d, time: normTime(d.time) });
      added += info.changes;
    }
  });
  tx(dump.deals);
  return added;
}

// Pair completed positions (sum of in-volume ≈ sum of out-volume) into journal trades.
function pairTrades(db) {
  const snap = readJson('gma_snapshot.json');
  const unpaired = db
    .prepare(
      `SELECT * FROM gma_mt5_deals
       WHERE journal_trade_id IS NULL AND entry IN ('in','out','inout')
         AND symbol IS NOT NULL AND symbol != '' ORDER BY deal_time`
    )
    .all();
  if (!unpaired.length) return { created: 0 };

  const groups = {};
  for (const d of unpaired) (groups[d.position_id] ||= []).push(d);

  const account = snap && snap.login ? resolveAccount(db, snap.login) : 'EightCap MT5';
  const insertTrade = db.prepare(
    `INSERT OR IGNORE INTO trades
       (trade_id, account, symbol, market, position, strategy, entry_datetime, entry_price,
        lot_size, take_profit, stop_loss, exit_price, exit_datetime, commission, pnl,
        duration, weekday, status)
     VALUES (@trade_id, @account, @symbol, @market, @position, @strategy, @entry_datetime,
             @entry_price, @lot_size, @take_profit, @stop_loss, @exit_price, @exit_datetime,
             @commission, @pnl, @duration, @weekday, 'CLOSED')`
  );
  const link = db.prepare('UPDATE gma_mt5_deals SET journal_trade_id = ? WHERE ticket = ?');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  let created = 0;
  const tx = db.transaction(() => {
    for (const [posId, deals] of Object.entries(groups)) {
      const ins = deals.filter((d) => d.entry === 'in' || d.entry === 'inout');
      const outs = deals.filter((d) => d.entry === 'out' || d.entry === 'inout');
      if (!ins.length || !outs.length) continue; // still open or partial data
      const volIn = ins.reduce((a, d) => a + d.volume, 0);
      const volOut = outs.reduce((a, d) => a + d.volume, 0);
      if (Math.abs(volIn - volOut) > 0.005) continue; // not fully closed yet

      const vwap = (ds) => ds.reduce((a, d) => a + d.price * d.volume, 0) / ds.reduce((a, d) => a + d.volume, 0);
      const entryTime = normTime(ins[0].deal_time);
      const exitTime = normTime(outs[outs.length - 1].deal_time);
      const pnl = deals.reduce((a, d) => a + (d.profit || 0) + (d.swap || 0) + (d.commission || 0), 0);
      const durationMin = Math.round((new Date(exitTime.replace(' ', 'T')) - new Date(entryTime.replace(' ', 'T'))) / 60000);
      const sl = outs.map((d) => d.sl).find((v) => v) || ins.map((d) => d.sl).find((v) => v) || null;
      const tp = outs.map((d) => d.tp).find((v) => v) || ins.map((d) => d.tp).find((v) => v) || null;

      const row = {
        trade_id: `MT5-${posId}`,
        account,
        symbol: ins[0].symbol,
        market: /^XAU|^XAG/.test(ins[0].symbol) ? 'METAL' : 'FOREX',
        position: ins[0].deal_type === 'buy' ? 'Long' : 'Short',
        strategy: null,
        entry_datetime: entryTime,
        entry_price: Number(vwap(ins).toFixed(5)),
        lot_size: Number(volIn.toFixed(2)),
        take_profit: tp,
        stop_loss: sl,
        exit_price: Number(vwap(outs).toFixed(5)),
        exit_datetime: exitTime,
        commission: Number(deals.reduce((a, d) => a + (d.commission || 0), 0).toFixed(2)),
        pnl: Number(pnl.toFixed(2)),
        duration: `${durationMin}m`,
        weekday: days[new Date(entryTime.replace(' ', 'T')).getDay()] || null,
      };
      const info = insertTrade.run(row);
      if (info.changes > 0) created++;
      deals.forEach((d) => link.run(row.trade_id, d.ticket));
    }
  });
  tx();
  return { created };
}

function ingestOnce() {
  const db = getDb();
  const snaps = ingestSnapshot(db);
  const deals = ingestDeals(db);
  const { created } = pairTrades(db);
  if (snaps || deals || created)
    console.log(`[GMA ingest] snapshots+${snaps} deals+${deals} trades+${created}`);
  return { snapshots: snaps, deals, trades_created: created };
}

let timer = null;
function startPolling(intervalMs = 120000) {
  if (timer) return;
  const tick = () => {
    try { ingestOnce(); } catch (e) { console.error('[GMA ingest] failed:', e.message); }
  };
  setTimeout(tick, 5000); // first pass shortly after boot
  timer = setInterval(tick, intervalMs);
  console.log(`[GMA ingest] polling ${OUT_DIR} every ${intervalMs / 1000}s`);
}

module.exports = { ingestOnce, startPolling, OUT_DIR };
