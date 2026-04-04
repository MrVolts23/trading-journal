const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const { getDb } = require('../db/database');

// ─── EightCap MT5 Excel / "Trades Report" mapping ─────────────────────────────
// Columns: Ticket, Login, Type, Symbol, Volume, Swaps, Commission,
//          Open Time, Open Price, Close Time, Close Price, Profit, Currency, Comment
const EIGHTCAP_MT5_MAPPING = {
  broker: 'EightCap',
  label: 'EightCap MT5 (Trades Report Excel)',
  fields: {
    trade_id: 'Ticket',
    symbol: 'Symbol',
    position: 'Type',           // buy → Long, sell → Short
    lot_size: 'Volume',
    commission: 'Commission',
    entry_datetime: 'Open Time',
    entry_price: 'Open Price',
    exit_datetime: 'Close Time',
    exit_price: 'Close Price',
    pnl: 'Profit',
    swap: 'Swaps',
  },
  transforms: {
    position: { 'buy': 'Long', 'sell': 'Short', 'Buy': 'Long', 'Sell': 'Short' },
  },
  // Rows with empty Type are balance/deposit entries — skip them
  skipIfEmpty: ['Type', 'Symbol'],
};

// ─── EightCap via TradingView Order History CSV ────────────────────────────────
// Columns: Symbol, Side, Type, Qty, Filled Qty, Limit Price, Stop Price,
//          Avg Fill Price, Status, Update Time, Position ID, Commission,
//          Closed P&L, Net Closed P&L, Order ID
// This format needs PAIRING: entry and exit are separate rows linked by Position ID
const EIGHTCAP_TV_MAPPING = {
  broker: 'EightCap',
  label: 'EightCap via TradingView (Order History CSV)',
  mode: 'pair_by_position',   // triggers special pairing logic
};

// ─── Position values that are noise ──────────────────────────────────────────
const NOISE_POSITIONS = new Set([
  'stop loss', 'take profit', 'stop', 'buy stop', 'sell stop',
  'buy limit', 'sell limit', 'balance', 'credit', 'correction',
  'cancelled', 'canceled', 'rejected', 'expired', 'market',
]);

function isNoiseRow(position) {
  if (!position) return true;   // empty position = balance/non-trade row
  return NOISE_POSITIONS.has(String(position).toLowerCase().trim());
}

// ─── Parse CSV buffer ─────────────────────────────────────────────────────────
function parseCSV(buffer) {
  const content = buffer.toString('utf-8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
}

// ─── Parse XLSX buffer ────────────────────────────────────────────────────────
function parseXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Check if first row is a title row (e.g. "Trades Report") rather than headers.
  // If so, skip it by starting at range offset 1.
  const firstRow = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })[0] || [];
  const hasRealHeaders = firstRow.some(cell =>
    ['Ticket','Login','Type','Symbol','Volume','Open Time','Profit'].includes(String(cell).trim())
  );
  const rangeOffset = hasRealHeaders ? 0 : 1;

  const raw = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, range: rangeOffset });
  return raw;
}

// ─── Parse any file (auto-detect CSV vs XLSX) ────────────────────────────────
function parseFile(buffer, originalname) {
  const ext = (originalname || '').toLowerCase();
  if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
    return parseXLSX(buffer);
  }
  return parseCSV(buffer);
}

// ─── Auto-detect broker Login IDs from raw rows ───────────────────────────────
// Returns unique Login values found in the rows (EightCap MT5 format has a Login column).
function detectLoginsFromRows(rows) {
  if (!rows.length || !('Login' in rows[0])) return [];
  const seen = new Set();
  for (const r of rows) {
    const v = String(r['Login'] || '').trim();
    if (v && v !== '0') seen.add(v);
  }
  return [...seen];
}

// ─── Find-or-create an account by broker_account_id ──────────────────────────
// If an account with this broker_account_id exists, return its name.
// Otherwise create a new account named "{broker} {loginId}" and return it.
function resolveAccount(loginId, broker) {
  const db = getDb();
  const loginStr = String(loginId).trim();
  const brokerName = broker || 'Unknown';

  const existing = db.prepare('SELECT name FROM accounts WHERE broker_account_id = ?').get(loginStr);
  if (existing) return { name: existing.name, isNew: false };

  const name = `${brokerName} ${loginStr}`;
  try {
    db.prepare('INSERT INTO accounts (name, broker, broker_account_id) VALUES (?, ?, ?)').run(name, brokerName, loginStr);
    return { name, isNew: true };
  } catch (e) {
    // Unique name clash (account with same name but different broker_account_id)
    const byName = db.prepare('SELECT name FROM accounts WHERE name = ?').get(name);
    if (byName) return { name: byName.name, isNew: false };
    throw e;
  }
}

// ─── EightCap TradingView pair-by-position-id algorithm ──────────────────────
// Entry and exit are separate rows in this format; we pair them by Position ID.
function pairTradingViewRows(rows, accountOverride) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // Only keep Filled rows with a Position ID
  const filled = rows.filter(r =>
    r['Status'] === 'Filled' &&
    r['Position ID'] && r['Position ID'].trim() !== ''
  );

  // Group by Position ID
  const groups = {};
  filled.forEach(row => {
    const id = row['Position ID'];
    if (!groups[id]) groups[id] = [];
    groups[id].push(row);
  });

  const trades = [];
  Object.entries(groups).forEach(([posId, grpRows]) => {
    // Entry = row with no Closed P&L; Exit = row with Closed P&L
    const entryRow = grpRows.find(r => !r['Closed P&L'] || r['Closed P&L'].trim() === '') || grpRows[0];
    const exitRow  = grpRows.find(r => r['Closed P&L'] && r['Closed P&L'].trim() !== '');

    const symbol    = (entryRow['Symbol'] || '').trim();
    const side      = (entryRow['Side'] || '').trim();
    const position  = side === 'Buy' ? 'Long' : side === 'Sell' ? 'Short' : null;
    const entryDt   = entryRow['Update Time'] || null;
    const entryPx   = parseFloat(entryRow['Avg Fill Price']) || null;
    const lotSize   = parseFloat(entryRow['Filled Qty']) || null;
    const comm      = (parseFloat(entryRow['Commission']) || 0) + (parseFloat(exitRow?.['Commission']) || 0);
    const exitDt    = exitRow ? exitRow['Update Time'] || null : null;
    const exitPx    = exitRow ? parseFloat(exitRow['Avg Fill Price']) || null : null;
    const pnl       = exitRow ? parseFloat(exitRow['Net Closed P&L']) || null : null;

    const metals    = ['XAUUSD','XAGUSD','GOLD','SILVER'];
    const market    = metals.some(m => symbol.toUpperCase().includes(m)) ? 'METAL' : 'FOREX';

    let status = 'OPEN';
    if (pnl !== null) {
      if (pnl > 0) status = 'WIN';
      else if (pnl < 0) status = 'LOSS';
      else status = 'B/E';
    }

    let duration = null;
    if (entryDt && exitDt) {
      const diff = new Date(exitDt) - new Date(entryDt);
      if (!isNaN(diff) && diff >= 0) {
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        duration = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      }
    }

    const weekday = entryDt ? days[new Date(entryDt).getDay()] : null;

    trades.push({
      trade_id: posId,
      account: accountOverride || 'EightCap',
      symbol, market, position,
      entry_datetime: entryDt, entry_price: entryPx,
      exit_datetime: exitDt,   exit_price: exitPx,
      lot_size: lotSize, commission: comm, pnl,
      status, duration, weekday,
      strategy: null, lessons: null, grade: null,
      _isDuplicate: false,
    });
  });

  return trades;
}

// ─── TradingView Paper Trading Order History pairer ──────────────────────────
// Format: Symbol (BROKER:SYMBOL), Side, Type, Qty, Limit Price, Stop Price,
//         Fill Price, Status, Commission, Placing Time, Closing Time, ...
// Strategy: filter Filled rows, sort by fill time (Closing Time), then run a
//           FIFO position-tracker per symbol to pair Buy↔Sell orders into trades.
function parseTradingViewOrderHistory(rows, accountOverride) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const metals = ['XAUUSD','XAGUSD','GOLD','SILVER','MGC','GC'];
  const acct = accountOverride || 'Paper Trading';

  // Count noise (cancelled/rejected) before filtering
  const noise_count = rows.filter(r => r['Status'] !== 'Filled').length;

  // Only filled orders, sorted chronologically by actual fill time
  const filled = rows
    .filter(r => r['Status'] === 'Filled')
    .sort((a, b) => new Date(a['Closing Time']) - new Date(b['Closing Time']));

  // Normalise symbol: strip "BROKER:" prefix and trailing "!"
  const normSym = s => (s || '').replace(/^[A-Z0-9_]+:/, '').replace(/!$/, '').trim();

  // Group by normalised symbol
  const bySymbol = {};
  for (const row of filled) {
    const sym = normSym(row['Symbol']);
    if (!sym) continue;
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push(row);
  }

  const trades = [];
  let tradeSeq = 0;

  for (const [symbol, orders] of Object.entries(bySymbol)) {
    // pending: open position lots waiting for a matching exit
    // { side:'Buy'|'Sell', fillPrice, fillTime, qty }
    const pending = [];

    for (const order of orders) {
      let remQty   = parseFloat(order['Qty'])        || 0;
      const side   = (order['Side'] || '').trim();   // 'Buy' or 'Sell'
      const fill   = parseFloat(order['Fill Price']) || 0;
      const fillTime = order['Closing Time'] || null;
      if (!fill || !remQty || !fillTime) continue;

      // FIFO: match against opposite-side pending lots
      for (let i = 0; i < pending.length && remQty > 0; i++) {
        const p = pending[i];
        if (p.side === side) continue;           // same direction — skip
        const matchQty = Math.min(remQty, p.qty);
        const isLong   = p.side === 'Buy';
        const pnlRaw   = isLong
          ? (fill - p.fillPrice) * matchQty
          : (p.fillPrice - fill) * matchQty;
        const pnl    = parseFloat(pnlRaw.toFixed(4));
        const status = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'B/E';
        const market = metals.some(m => symbol.toUpperCase().includes(m)) ? 'METAL' : 'FOREX';

        // Duration
        let duration = null;
        try {
          const diff = new Date(fillTime) - new Date(p.fillTime);
          if (!isNaN(diff) && diff >= 0) {
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            duration = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
          }
        } catch(e) {}

        // Weekday
        let weekday = null;
        try { weekday = days[new Date(p.fillTime).getDay()]; } catch(e) {}

        const dateStr = (p.fillTime || '').replace(/[-: ]/g, '').slice(0, 12);
        trades.push({
          trade_id:       `TV-${symbol}-${dateStr}-${++tradeSeq}`,
          account:        acct,
          symbol,
          market,
          position:       isLong ? 'Long' : 'Short',
          entry_datetime: p.fillTime,
          exit_datetime:  fillTime,
          entry_price:    p.fillPrice,
          exit_price:     fill,
          lot_size:       matchQty,
          pnl,
          status,
          duration,
          weekday,
          commission:     0,
          strategy:       null,
          lessons:        null,
          grade:          null,
          _isDuplicate:   false,
        });

        remQty  -= matchQty;
        p.qty   -= matchQty;
        if (p.qty <= 0) { pending.splice(i, 1); i--; }
      }

      // Any remaining qty opens a new position
      if (remQty > 0) {
        pending.push({ side, fillPrice: fill, fillTime, qty: remQty });
      }
    }
  }

  return { trades, noise_count };
}

// ─── TradingView Paper Trading Balance History CSV ────────────────────────────
// Format: Time, Balance Before, Balance After, Realized P&L (value),
//         Realized P&L (currency), Action
//
// Each row = one closed trade. P&L is already converted to account currency
// (CAD) using the exchange rate embedded in the Action text.
// Action format:
//   "Close long position for symbol EIGHTCAP:XAUUSD at price 5100.30 for 29 units.
//    Position AVG Price was 5084.890000, currency: USD, rate: 1.361470, point value: 1.000000"
//
// Advantages over order-history CSV:
//   ✓ No FIFO pairing needed — every row is already a complete closed trade
//   ✓ P&L already in account currency (CAD) with exchange rate applied
//   ✓ Entry price (AVG) and exit price both present
//   ✓ Works correctly for all cross-currency pairs (USDJPY, etc.)
function parseBalanceHistoryRows(rows, accountOverride) {
  const days    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const metals  = ['XAUUSD','XAGUSD','GOLD','SILVER','MGC','GC'];
  const acct    = accountOverride || 'Paper Trading';

  // Capture: 1=long|short  2=BROKER:SYMBOL  3=exitPrice  4=qty  5=entryPrice
  const ACTION_RE = /close (long|short) position for symbol ([A-Z0-9_:!.]+) at price ([\d.]+) for ([\d]+) units\.\s*Position AVG Price was ([\d.]+)/i;

  const trades = [];
  let seq = 0;
  let noise = 0;

  for (const row of rows) {
    const pnlRaw  = row['Realized P&L (value)'];
    const exitDt  = (row['Time'] || '').trim();
    const action  = row['Action'] || '';

    if (!exitDt) { noise++; continue; }

    const pnl = parseFloat(pnlRaw);
    if (isNaN(pnl)) { noise++; continue; }

    const m = action.match(ACTION_RE);
    if (!m) { noise++; continue; }

    const [, dir, rawSym, exitPxStr, qtyStr, entryPxStr] = m;

    // Normalise symbol — strip broker prefix (EIGHTCAP:, ICMARKETS:, etc.) and trailing !
    const symbol   = rawSym.replace(/^[A-Z0-9_]+:/, '').replace(/!$/, '').trim();
    const position = dir.toLowerCase() === 'long' ? 'Long' : 'Short';
    const exitPx   = parseFloat(exitPxStr);
    const entryPx  = parseFloat(entryPxStr);
    const lotSize  = parseFloat(qtyStr);
    const market   = metals.some(m => symbol.toUpperCase().includes(m)) ? 'METAL' : 'FOREX';
    const status   = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : 'B/E';

    let weekday = null;
    try { weekday = days[new Date(exitDt).getDay()]; } catch (_) {}

    const dateStr = exitDt.replace(/[-: ]/g, '').slice(0, 12);

    trades.push({
      trade_id:       `TV-BAL-${symbol}-${dateStr}-${++seq}`,
      account:        acct,
      symbol,
      market,
      position,
      entry_datetime: null,   // balance history only has close time
      exit_datetime:  exitDt,
      entry_price:    entryPx,
      exit_price:     exitPx,
      lot_size:       lotSize,
      pnl,
      status,
      duration:       null,
      weekday,
      commission:     0,
      strategy:       null,
      lessons:        null,
      grade:          null,
      _isDuplicate:   false,
    });
  }

  return { trades, noise_count: noise };
}

// ─── Standard column-mapping for CSV/XLSX ────────────────────────────────────
// loginToAccount: optional Map/object of { loginId → accountName } for per-row account resolution
function applyMapping(rows, mapping, loginToAccount) {
  const fieldMap   = mapping.fields || {};
  const transforms = mapping.transforms || {};
  const skipEmpty  = mapping.skipIfEmpty || [];

  return rows.map((row, idx) => {
    // Skip balance/header rows if any required field is empty
    if (skipEmpty.some(f => !row[f] || String(row[f]).trim() === '')) return null;

    const trade = {};

    Object.entries(fieldMap).forEach(([targetField, sourceField]) => {
      if (sourceField && row[sourceField] !== undefined) {
        let val = row[sourceField];

        // Apply transforms
        if (transforms[targetField] && transforms[targetField][val]) {
          val = transforms[targetField][val];
        }

        trade[targetField] = (val === '' || val === null || val === undefined) ? null : val;
      }
    });

    // Auto-derive trade_id if missing
    if (!trade.trade_id && trade.symbol) {
      const dateStr = (String(trade.entry_datetime || '')).replace(/[-: T]/g, '').slice(0, 8);
      trade.trade_id = `T${dateStr}-${idx + 1}`;
    }

    // Parse numeric fields
    ['entry_price','exit_price','lot_size','commission','pnl','stop_loss','take_profit','swap'].forEach(f => {
      if (trade[f] !== null && trade[f] !== undefined) {
        const n = parseFloat(trade[f]);
        trade[f] = isNaN(n) ? null : n;
      }
    });

    // Stringify dates if they came in as Date objects (XLSX)
    ['entry_datetime','exit_datetime'].forEach(f => {
      if (trade[f] instanceof Date) {
        trade[f] = trade[f].toISOString().replace('T', ' ').slice(0, 19);
      } else if (trade[f] && typeof trade[f] === 'string') {
        trade[f] = trade[f].trim() || null;
      }
    });

    // Stringify trade_id (Ticket comes in as a number from Excel)
    if (trade.trade_id !== null && trade.trade_id !== undefined) {
      trade.trade_id = String(trade.trade_id);
    }

    // Derive status
    if (!trade.status) {
      if (trade.pnl > 0) trade.status = 'WIN';
      else if (trade.pnl < 0) trade.status = 'LOSS';
      else if (trade.pnl === 0) trade.status = 'B/E';
      else trade.status = 'OPEN';
    }

    // Derive market
    if (!trade.market && trade.symbol) {
      const metals = ['XAUUSD','XAGUSD','GOLD','SILVER'];
      trade.market = metals.some(s => trade.symbol.toUpperCase().includes(s)) ? 'METAL' : 'FOREX';
    }

    // Default account — prefer per-row login resolution, then mapping.broker
    if (!trade.account) {
      const loginVal = String(row['Login'] || '').trim();
      if (loginToAccount && loginVal && loginToAccount[loginVal]) {
        trade.account = loginToAccount[loginVal];
      } else {
        trade.account = mapping.broker || 'EightCap';
      }
    }

    // Duration
    if (trade.entry_datetime && trade.exit_datetime) {
      try {
        const diff = new Date(trade.exit_datetime) - new Date(trade.entry_datetime);
        if (!isNaN(diff) && diff >= 0) {
          const h = Math.floor(diff / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          const s = Math.floor((diff % 60000) / 1000);
          trade.duration = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        }
      } catch (e) {}
    }

    // Weekday
    if (trade.entry_datetime) {
      try {
        const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        trade.weekday = days[new Date(trade.entry_datetime).getDay()];
      } catch (e) {}
    }

    return trade;
  }).filter(Boolean);  // remove null rows (balance/skipped)
}

// ─── Detect duplicates against DB ────────────────────────────────────────────
function detectDuplicates(trades) {
  const db = getDb();
  const existing = new Set(
    db.prepare('SELECT trade_id FROM trades').all().map(r => r.trade_id)
  );
  return trades.map(t => ({ ...t, _isDuplicate: existing.has(String(t.trade_id)) }));
}

// ─── Deduplicate raw rows (handles EightCap Excel ~58x duplication bug) ───────
function deduplicateRawRows(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = Object.values(row).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Extract EightCap balance/deposit/withdrawal rows ────────────────────────
// These rows have empty Type AND Symbol but a non-zero Profit value
// Comment field contains CDMAN (deposit) or CWBA (withdrawal)
function extractEightCapBalanceRows(rows, loginToAccount) {
  return rows
    .filter(row => {
      const type   = String(row['Type']   || '').trim();
      const symbol = String(row['Symbol'] || '').trim();
      const profit = row['Profit'] !== undefined && row['Profit'] !== ''
        ? parseFloat(row['Profit']) : NaN;
      return !type && !symbol && !isNaN(profit) && profit !== 0;
    })
    .map(row => {
      const profit   = parseFloat(row['Profit']);
      const dateRaw  = row['Open Time'];
      let date = null;
      if (dateRaw instanceof Date) {
        date = dateRaw.toISOString().slice(0, 10);
      } else if (dateRaw) {
        date = String(dateRaw).slice(0, 10);
      }
      const comment      = String(row['Comment'] || '').trim().toUpperCase();
      const activityType = profit > 0 ? 'deposit' : 'withdrawal';
      const loginVal = String(row['Login'] || '').trim();
      const acctName = (loginToAccount && loginVal && loginToAccount[loginVal])
        ? loginToAccount[loginVal]
        : 'EightCap';
      return {
        account:       acctName,
        date,
        activity_type: activityType,
        amount:        profit,
        notes:         comment || null,
        source_ticket: String(row['Ticket'] || ''),
      };
    });
}

// ─── Commit account activity rows (deposits / withdrawals) ────────────────────
function commitAccountActivity(rows) {
  const db = getDb();
  let inserted = 0;
  const tx = db.transaction((actRows) => {
    actRows.forEach(row => {
      // Deduplicate by account + date + amount + activity_type
      const exists = db.prepare(`
        SELECT id FROM account_activity
        WHERE account = ? AND date = ? AND amount = ? AND activity_type = ?
      `).get(row.account, row.date, row.amount, row.activity_type);
      if (!exists) {
        db.prepare(`
          INSERT INTO account_activity (account, date, activity_type, amount, notes)
          VALUES (?, ?, ?, ?, ?)
        `).run(row.account, row.date, row.activity_type, row.amount, row.notes || null);
        inserted++;
      }
    });
  });
  tx(rows);
  return { inserted };
}

// ─── Preview import ───────────────────────────────────────────────────────────
// account: optional explicit account name override (from UI dropdown)
// If not provided, auto-detection via Login column is attempted for standard imports.
function previewImport(rows, mapping, importFromDate, account) {
  let mapped;
  let noise_count = 0;
  let balance_rows = [];

  if (mapping.mode === 'tv_balance_history') {
    // TradingView Paper Trading Balance History — one row = one closed trade
    const result = parseBalanceHistoryRows(rows, account || null);
    noise_count = result.noise_count;
    mapped = result.trades;
  } else if (mapping.mode === 'pair_by_position') {
    // TradingView EightCap format — pair rows by Position ID
    const cancelled = rows.filter(r => r['Status'] === 'Cancelled').length;
    const unfilled  = rows.filter(r => r['Status'] !== 'Cancelled' && (!r['Position ID'] || !r['Position ID'].trim())).length;
    noise_count = cancelled + unfilled;
    mapped = pairTradingViewRows(rows, account || null);
  } else {
    // Deduplicate raw rows first (EightCap Excel can have ~58x duplicate rows)
    const deduped = deduplicateRawRows(rows);
    const originalCount = rows.length;

    // Build login→account map: if explicit account provided, skip auto-detection
    let loginToAccount = null;
    if (!account) {
      const logins = detectLoginsFromRows(deduped);
      if (logins.length > 0) {
        loginToAccount = {};
        for (const login of logins) {
          loginToAccount[login] = resolveAccount(login, mapping.broker || 'EightCap').name;
        }
      }
    }

    // Extract deposit/withdrawal balance rows before filtering
    balance_rows = extractEightCapBalanceRows(deduped, loginToAccount);
    // Standard column mapping (MT5 Excel, custom)
    const all = applyMapping(deduped, mapping, loginToAccount);
    // Apply explicit account override to every trade if provided
    if (account) all.forEach(t => { if (t) t.account = account; });
    const filtered = all.filter(r => !isNoiseRow(r.position));
    noise_count = (originalCount - deduped.length) + (all.length - filtered.length);
    mapped = filtered;
  }

  // Apply "import from date" cutoff if provided
  if (importFromDate) {
    const cutoff = new Date(importFromDate + 'T00:00:00');
    const before = mapped.length;
    mapped = mapped.filter(r => {
      if (!r.entry_datetime) return true;
      const d = r.entry_datetime instanceof Date ? r.entry_datetime : new Date(r.entry_datetime);
      return !isNaN(d) && d >= cutoff;
    });
    noise_count += (before - mapped.length);
  }

  const withDups = detectDuplicates(mapped);
  return {
    total: withDups.length,
    new_count: withDups.filter(r => !r._isDuplicate).length,
    duplicate_count: withDups.filter(r => r._isDuplicate).length,
    noise_count,
    preview: withDups.slice(0, 20),
    all_rows: withDups,
    balance_rows,
  };
}

// ─── Commit import ────────────────────────────────────────────────────────────
function commitImport(rows) {
  const db = getDb();
  const newRows = rows.filter(r => !r._isDuplicate);

  // Ensure every account name used in this import exists in the accounts table.
  // This is essential for TV Paper Trading imports where resolveAccount() is not
  // called, so "Paper Trading" (or a user-supplied name) must be registered here
  // so it shows up in the TopNav account selector immediately after import.
  const uniqueAccounts = [...new Set(newRows.map(r => r.account).filter(Boolean))];
  uniqueAccounts.forEach(acctName => {
    try {
      db.prepare('INSERT OR IGNORE INTO accounts (name, broker) VALUES (?, ?)').run(acctName, acctName);
    } catch (_) {}
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO trades (
      trade_id, account, symbol, market, position, strategy,
      entry_datetime, entry_price, lot_size, take_profit, stop_loss,
      exit_price, exit_datetime, commission, position_size, pip_size,
      pip_value, pnl, pnl_pct, r_multiple, risk_reward, max_profit,
      max_loss, duration, weekday, status, lessons
    ) VALUES (
      @trade_id, @account, @symbol, @market, @position, @strategy,
      @entry_datetime, @entry_price, @lot_size, @take_profit, @stop_loss,
      @exit_price, @exit_datetime, @commission, @position_size, @pip_size,
      @pip_value, @pnl, @pnl_pct, @r_multiple, @risk_reward, @max_profit,
      @max_loss, @duration, @weekday, @status, @lessons
    )
  `);

  const errors = [];
  let imported = 0;

  const importMany = db.transaction((rows) => {
    rows.forEach((row, idx) => {
      try {
        const clean = {
          trade_id:      String(row.trade_id || `T-auto-${idx}`),
          account:       row.account       || 'EightCap',
          symbol:        row.symbol        || null,
          market:        row.market        || null,
          position:      row.position      || null,
          strategy:      row.strategy      || null,
          entry_datetime:row.entry_datetime|| null,
          entry_price:   row.entry_price   || null,
          lot_size:      row.lot_size      || null,
          take_profit:   row.take_profit   || null,
          stop_loss:     row.stop_loss     || null,
          exit_price:    row.exit_price    || null,
          exit_datetime: row.exit_datetime || null,
          commission:    row.commission    || 0,
          position_size: row.position_size || null,
          pip_size:      row.pip_size      || null,
          pip_value:     row.pip_value     || null,
          pnl:           row.pnl           ?? null,
          pnl_pct:       row.pnl_pct       || null,
          r_multiple:    row.r_multiple    || null,
          risk_reward:   row.risk_reward   || null,
          max_profit:    row.max_profit    || null,
          max_loss:      row.max_loss      || null,
          duration:      row.duration      || null,
          weekday:       row.weekday       || null,
          status:        row.status        || 'OPEN',
          lessons:       row.lessons       || null,
        };
        insert.run(clean);
        imported++;
      } catch (e) {
        errors.push({ row: idx + 1, error: e.message });
      }
    });
  });

  importMany(newRows);
  return { imported, errors, skipped: rows.filter(r => r._isDuplicate).length };
}

// ─── Exports ──────────────────────────────────────────────────────────────────
function getDefaultMapping()     { return EIGHTCAP_MT5_MAPPING; }
function getTradingViewMapping() { return EIGHTCAP_TV_MAPPING; }
function getPresetMappings()     { return { eightcap_mt5: EIGHTCAP_MT5_MAPPING, eightcap_tv: EIGHTCAP_TV_MAPPING }; }

function getSavedMappings() {
  const db = getDb();
  return db.prepare('SELECT * FROM import_mappings ORDER BY created_at DESC').all()
    .map(r => ({ ...r, mapping: JSON.parse(r.mapping_json) }));
}

function saveMapping(name, broker, mapping) {
  const db = getDb();
  return db.prepare('INSERT INTO import_mappings (name, broker, mapping_json) VALUES (?, ?, ?)')
    .run(name, broker, JSON.stringify(mapping));
}

module.exports = {
  parseCSV, parseXLSX, parseFile,
  applyMapping, detectDuplicates,
  previewImport, commitImport, commitAccountActivity,
  extractEightCapBalanceRows,
  detectLoginsFromRows, resolveAccount,
  getDefaultMapping, getTradingViewMapping, getPresetMappings,
  getSavedMappings, saveMapping,
  EIGHTCAP_MT5_MAPPING, EIGHTCAP_TV_MAPPING,
};
