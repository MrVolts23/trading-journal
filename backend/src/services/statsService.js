// All P&L aggregates here are NET OF COMMISSION (pnl + commission, commission stored negative),
// so every screen agrees with the broker/prop-firm balance. Accounts without commission are unchanged.
const { getDb } = require('../db/database');
// A trade's day is the MARKET day of its exit (entry while open). See lib/marketDay.js.
const MARKET_DAY = 'market_day(COALESCE(exit_datetime, entry_datetime), market)';

function buildWhereClause(filters) {
  const conditions = [];
  const params = {};

  if (filters.account && filters.account !== 'All') {
    conditions.push('account = @account');
    params.account = filters.account;
  }
  if (filters.status && filters.status !== 'All') {
    conditions.push('status = @status');
    params.status = filters.status;
  }
  if (filters.market && filters.market !== 'All') {
    conditions.push('market = @market');
    params.market = filters.market;
  }
  if (filters.strategy && filters.strategy !== 'All') {
    conditions.push('strategy = @strategy');
    params.strategy = filters.strategy;
  }
  if (filters.symbol) {
    conditions.push('symbol = @symbol');
    params.symbol = filters.symbol;
  }
  // date filters are MARKET days (see lib/marketDay.js): a trade belongs to the day its exit landed on
  if (filters.dateStart) {
    conditions.push(`${MARKET_DAY} >= @dateStart`);
    params.dateStart = filters.dateStart;
  }
  if (filters.dateEnd) {
    conditions.push(`${MARKET_DAY} <= @dateEnd`);
    params.dateEnd = filters.dateEnd;
  }

  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    params,
  };
}

function getDashboardStats(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);

  const closedWhere = where
    ? where + " AND status IN ('WIN','LOSS','B/E')"
    : "WHERE status IN ('WIN','LOSS','B/E')";

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status = 'LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN status = 'B/E' THEN 1 ELSE 0 END) as breakeven,
      SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_trades,
      SUM(CASE WHEN pnl IS NOT NULL THEN pnl + COALESCE(commission, 0) ELSE 0 END) as net_pnl,
      AVG(CASE WHEN r_multiple IS NOT NULL THEN r_multiple END) as avg_r_multiple,
      AVG(CASE WHEN status = 'WIN' AND pnl IS NOT NULL THEN pnl + COALESCE(commission, 0) END) as avg_win,
      AVG(CASE WHEN status = 'LOSS' AND pnl IS NOT NULL THEN pnl + COALESCE(commission, 0) END) as avg_loss,
      MAX(pnl + COALESCE(commission, 0)) as largest_win,
      MIN(pnl + COALESCE(commission, 0)) as largest_loss
    FROM trades ${where}
  `).get(params);

  // Win rate (exclude open)
  const closedCount = (totals.wins || 0) + (totals.losses || 0) + (totals.breakeven || 0);
  const winRate = closedCount > 0 ? (totals.wins || 0) / closedCount : 0;

  // Profit factor
  const grossWin = db.prepare(`SELECT SUM(pnl + COALESCE(commission, 0)) as v FROM trades ${where ? where + " AND status='WIN'" : "WHERE status='WIN'"}`).get(params)?.v || 0;
  const grossLoss = db.prepare(`SELECT ABS(SUM(pnl + COALESCE(commission, 0))) as v FROM trades ${where ? where + " AND status='LOSS'" : "WHERE status='LOSS'"}`).get(params)?.v || 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  // Trade expectancy
  const expectancy = closedCount > 0 ? (totals.net_pnl || 0) / closedCount : 0;

  // Max drawdown from account_activity
  const ddParams = filters.account && filters.account !== 'All' ? { account: filters.account } : {};
  const ddWhere = filters.account && filters.account !== 'All' ? 'WHERE account = @account' : '';
  const drawdown = db.prepare(`SELECT MIN(drawdown_usd) as max_dd_usd, MIN(drawdown_pct) as max_dd_pct FROM account_activity ${ddWhere}`).get(ddParams);

  // Current balance = total deposits + net P&L from trades + withdrawals (negative amounts)
  // If account_activity has no deposit records (fresh install — user set initial_deposit manually
  // in Settings), fall back to the sum of initial_deposit across all accounts.
  const depositTotals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN activity_type = 'deposit'    THEN amount ELSE 0 END), 0) AS total_deposits,
      COALESCE(SUM(CASE WHEN activity_type = 'withdrawal' THEN amount ELSE 0 END), 0) AS total_withdrawals,
      COALESCE(SUM(CASE WHEN activity_type = 'correction' THEN amount ELSE 0 END), 0) AS total_corrections
    FROM account_activity
  `).get();

  let seedBalance = depositTotals.total_deposits;
  if (seedBalance === 0) {
    // No deposit history in account_activity — use manually-entered starting balance
    const acctWhere = filters.account && filters.account !== 'All'
      ? `WHERE name = '${filters.account.replace(/'/g, "''")}'`
      : '';
    const initRow = db.prepare(
      `SELECT COALESCE(SUM(initial_deposit), 0) AS total FROM accounts ${acctWhere}`
    ).get();
    seedBalance = initRow?.total || 0;
  }

  // Balance = deposits + P&L + withdrawals (negative) + corrections (signed)
  // Corrections adjust the running balance but are NOT shown as extracted funds on the dashboard
  const latestBalance = {
    total_balance: seedBalance + (totals.net_pnl || 0) + (depositTotals.total_withdrawals || 0) + (depositTotals.total_corrections || 0)
  };

  return {
    total_trades: totals.total_trades || 0,
    wins: totals.wins || 0,
    losses: totals.losses || 0,
    breakeven: totals.breakeven || 0,
    open_trades: totals.open_trades || 0,
    net_pnl: totals.net_pnl || 0,
    win_rate: winRate,
    profit_factor: profitFactor,
    expectancy,
    avg_r_multiple: totals.avg_r_multiple || 0,
    avg_win: totals.avg_win || 0,
    avg_loss: totals.avg_loss || 0,
    largest_win: totals.largest_win || 0,
    largest_loss: totals.largest_loss || 0,
    max_drawdown_usd: drawdown?.max_dd_usd || 0,
    max_drawdown_pct: drawdown?.max_dd_pct || 0,
    current_balance: latestBalance?.total_balance || 0,
  };
}

function getPnlOverTime(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);

  return db.prepare(`
    SELECT
      ${MARKET_DAY} as date,
      SUM(pnl + COALESCE(commission, 0)) as daily_pnl,
      COUNT(*) as trade_count
    FROM trades ${where}
    GROUP BY ${MARKET_DAY}
    ORDER BY date ASC
  `).all(params);
}

function getStrategyPerformance(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);
  const stratFilter = where ? `${where} AND strategy IS NOT NULL` : 'WHERE strategy IS NOT NULL';

  return db.prepare(`
    SELECT
      strategy,
      COUNT(*) as total,
      SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(pnl + COALESCE(commission, 0)) as net_pnl,
      ROUND(AVG(pnl + COALESCE(commission, 0)), 2) as avg_pnl
    FROM trades ${stratFilter}
    GROUP BY strategy
    ORDER BY net_pnl DESC
  `).all(params);
}

function getMarketPerformance(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);
  const mktFilter = where ? `${where} AND market IS NOT NULL` : 'WHERE market IS NOT NULL';

  return db.prepare(`
    SELECT
      market,
      COUNT(*) as total,
      SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(pnl + COALESCE(commission, 0)) as net_pnl,
      ROUND(CAST(SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*),0), 4) as win_rate
    FROM trades ${mktFilter}
    GROUP BY market
  `).all(params);
}

function getWinRateByDay(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);
  const dayFilter = where
    ? `${where} AND weekday IS NOT NULL AND status != 'OPEN'`
    : `WHERE weekday IS NOT NULL AND status != 'OPEN'`;

  return db.prepare(`
    SELECT
      weekday,
      COUNT(*) as total,
      SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(pnl + COALESCE(commission, 0)) as net_pnl,
      ROUND(CAST(SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*),0), 4) as win_rate
    FROM trades ${dayFilter}
    GROUP BY weekday
    ORDER BY CASE weekday
      WHEN 'Monday' THEN 1
      WHEN 'Tuesday' THEN 2
      WHEN 'Wednesday' THEN 3
      WHEN 'Thursday' THEN 4
      WHEN 'Friday' THEN 5
      ELSE 6 END
  `).all(params);
}

function getDurationDistribution(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);

  const durFilter = where ? `${where} AND duration IS NOT NULL AND status != 'OPEN'` : `WHERE duration IS NOT NULL AND status != 'OPEN'`;
  const trades = db.prepare(`SELECT duration FROM trades ${durFilter}`).all(params);

  const buckets = {
    '< 1 min': 0,
    '1–5 min': 0,
    '5–15 min': 0,
    '15–60 min': 0,
    '1–4 hr': 0,
    '> 4 hr': 0,
  };

  trades.forEach(({ duration }) => {
    const mins = parseDurationToMinutes(duration);
    if (mins < 1) buckets['< 1 min']++;
    else if (mins < 5) buckets['1–5 min']++;
    else if (mins < 15) buckets['5–15 min']++;
    else if (mins < 60) buckets['15–60 min']++;
    else if (mins < 240) buckets['1–4 hr']++;
    else buckets['> 4 hr']++;
  });

  return Object.entries(buckets).map(([label, count]) => ({ label, count }));
}

function parseDurationToMinutes(duration) {
  if (!duration) return 0;
  // Format: "0 days 0:01:30" or "0:05:00"
  let total = 0;
  const dayMatch = duration.match(/(\d+)\s*days?/i);
  if (dayMatch) total += parseInt(dayMatch[1]) * 1440;
  const timeMatch = duration.match(/(\d+):(\d+):(\d+)/);
  if (timeMatch) {
    total += parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]) + parseInt(timeMatch[3]) / 60;
  }
  return total;
}

function getCalendarData(year, month, filters = {}, overrideStart, overrideEnd) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);

  // Accept a wider date range so the frontend can include overflow days from adjacent months
  const startDate = overrideStart || `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay   = new Date(year, month, 0).getDate();
  const endDateStr = overrideEnd || `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const dateFilter = where
    ? `${where} AND ${MARKET_DAY} >= '${startDate}' AND ${MARKET_DAY} <= '${endDateStr}'`
    : `WHERE ${MARKET_DAY} >= '${startDate}' AND ${MARKET_DAY} <= '${endDateStr}'`;

  return db.prepare(`
    SELECT
      ${MARKET_DAY} as date,
      SUM(pnl + COALESCE(commission, 0)) as daily_pnl,
      COUNT(*) as trade_count,
      SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses
    FROM trades ${dateFilter}
    GROUP BY ${MARKET_DAY}
    ORDER BY date ASC
  `).all(params);
}

function getBalanceOverTime(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);

  // Daily PnL from trades
  const dailyPnl = db.prepare(`
    SELECT
      ${MARKET_DAY} as date,
      SUM(pnl + COALESCE(commission, 0)) as daily_pnl
    FROM trades ${where}
    GROUP BY ${MARKET_DAY}
    ORDER BY date ASC
  `).all(params);

  // Deposits/withdrawals from account_activity
  const actWhere = filters.account && filters.account !== 'All' ? 'WHERE account = @account' : '';
  const actParams = filters.account && filters.account !== 'All' ? { account: filters.account } : {};
  const activity = db.prepare(`
    SELECT date, activity_type, amount
    FROM account_activity ${actWhere}
    ORDER BY date ASC
  `).all(actParams);

  // Merge into date-keyed map
  const events = {};
  for (const row of activity) {
    if (!events[row.date]) events[row.date] = { pnl: 0, activity: 0 };
    events[row.date].activity += row.amount || 0;
  }
  for (const row of dailyPnl) {
    if (!events[row.date]) events[row.date] = { pnl: 0, activity: 0 };
    events[row.date].pnl += row.daily_pnl || 0;
  }

  const sortedDates = Object.keys(events).sort();
  let balance = 0;
  return sortedDates.map(date => {
    balance += (events[date].activity || 0) + (events[date].pnl || 0);
    return { date, balance: parseFloat(balance.toFixed(2)) };
  });
}

function getPlanAdherence(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);

  const closedFilter = where
    ? `${where} AND status IN ('WIN','LOSS','B/E')`
    : `WHERE status IN ('WIN','LOSS','B/E')`;

  const rows = db.prepare(`
    SELECT
      SUM(CASE WHEN rule_followed = 1 THEN 1 ELSE 0 END) as yes_count,
      SUM(CASE WHEN rule_followed = 0 THEN 1 ELSE 0 END) as no_count,
      SUM(CASE WHEN rule_followed IS NULL THEN 1 ELSE 0 END) as untagged_count,
      COUNT(*) as total,
      -- P&L when plan was followed vs not
      SUM(CASE WHEN rule_followed = 1 THEN pnl + COALESCE(commission, 0) ELSE 0 END) as pnl_followed,
      SUM(CASE WHEN rule_followed = 0 THEN pnl + COALESCE(commission, 0) ELSE 0 END) as pnl_broke,
      AVG(CASE WHEN rule_followed = 1 THEN pnl + COALESCE(commission, 0) END) as avg_pnl_followed,
      AVG(CASE WHEN rule_followed = 0 THEN pnl + COALESCE(commission, 0) END) as avg_pnl_broke
    FROM trades ${closedFilter}
  `).get(params);

  const tagged = (rows.yes_count || 0) + (rows.no_count || 0);
  return {
    yes_count: rows.yes_count || 0,
    no_count: rows.no_count || 0,
    untagged_count: rows.untagged_count || 0,
    total: rows.total || 0,
    tagged,
    yes_pct: tagged > 0 ? parseFloat(((rows.yes_count / tagged) * 100).toFixed(1)) : null,
    no_pct:  tagged > 0 ? parseFloat(((rows.no_count  / tagged) * 100).toFixed(1)) : null,
    pnl_followed: parseFloat((rows.pnl_followed || 0).toFixed(2)),
    pnl_broke:    parseFloat((rows.pnl_broke    || 0).toFixed(2)),
    avg_pnl_followed: rows.avg_pnl_followed ? parseFloat(rows.avg_pnl_followed.toFixed(2)) : null,
    avg_pnl_broke:    rows.avg_pnl_broke    ? parseFloat(rows.avg_pnl_broke.toFixed(2))    : null,
  };
}

// ─── Per-symbol performance (net of commission) ──────────────────────────────
function getSymbolPerformance(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);
  const f = where ? `${where} AND symbol IS NOT NULL AND status != 'OPEN'` : `WHERE symbol IS NOT NULL AND status != 'OPEN'`;
  return db.prepare(`
    SELECT symbol, MAX(market) as market,
      COUNT(*) as total,
      SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(pnl + COALESCE(commission, 0)) as net_pnl,
      AVG(CASE WHEN r_multiple IS NOT NULL THEN r_multiple END) as avg_r,
      ROUND(CAST(SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*),0), 4) as win_rate
    FROM trades ${f}
    GROUP BY symbol
    ORDER BY net_pnl DESC
  `).all(params).map(r => ({ ...r, net_pnl: parseFloat((r.net_pnl || 0).toFixed(2)), avg_r: r.avg_r != null ? parseFloat(r.avg_r.toFixed(2)) : null }));
}

// ─── Daily net P&L with counts (market days) ─────────────────────────────────
function getDailyPnl(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);
  const f = where ? `${where} AND status != 'OPEN'` : `WHERE status != 'OPEN'`;
  return db.prepare(`
    SELECT ${MARKET_DAY} as date,
      COUNT(*) as trades,
      SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(pnl + COALESCE(commission, 0)) as net_pnl
    FROM trades ${f}
    GROUP BY ${MARKET_DAY}
    ORDER BY date ASC
  `).all(params).map(r => ({ ...r, net_pnl: parseFloat((r.net_pnl || 0).toFixed(2)) }));
}

// ─── Equity curve: starting balance + daily net P&L + deposits/withdrawals, with peak and drawdown ──
// One account: seeded with that account's starting balance (initial_deposit, or its deposit rows).
// All accounts: seeded with the sum of starting balances.
function getEquityCurve(filters = {}) {
  const db = getDb();
  const oneAccount = filters.account && filters.account !== 'All' ? filters.account : null;
  const acctWhere = oneAccount ? 'WHERE name = @account' : '';
  const acctParams = oneAccount ? { account: oneAccount } : {};
  const accounts = db.prepare(`SELECT name, broker, initial_deposit, deposit_date FROM accounts ${acctWhere}`).all(acctParams);
  const actWhere = oneAccount ? 'WHERE account = @account' : '';
  const activity = db.prepare(`SELECT date, activity_type, amount FROM account_activity ${actWhere} ORDER BY date ASC`).all(acctParams);
  const deposits = activity.filter(a => a.activity_type === 'deposit').reduce((s, a) => s + (a.amount || 0), 0);
  // Starting balance: deposit rows if any, else the manual starting balance on the account(s)
  const startBalance = deposits > 0 ? deposits : accounts.reduce((s, a) => s + (a.initial_deposit || 0), 0);
  const daily = getDailyPnl(filters);
  const events = {};
  for (const a of activity) {
    if (a.activity_type === 'deposit' && deposits > 0) continue; // already in the seed
    (events[a.date] ||= { pnl: 0, activity: 0, trades: 0, wins: 0, losses: 0 }).activity += a.amount || 0;
  }
  for (const d of daily) {
    const e = (events[d.date] ||= { pnl: 0, activity: 0, trades: 0, wins: 0, losses: 0 });
    e.pnl += d.net_pnl; e.trades += d.trades; e.wins += d.wins; e.losses += d.losses;
  }
  const dates = Object.keys(events).sort();
  const firstDate = accounts.map(a => a.deposit_date).filter(Boolean).sort()[0] || dates[0] || null;
  let balance = startBalance, peak = startBalance, maxDd = 0, maxDdPct = 0;
  const points = [];
  if (firstDate && (!dates.length || firstDate < dates[0])) points.push({ date: firstDate, balance: startBalance, day_pnl: 0, trades: 0, wins: 0, losses: 0, peak: startBalance, drawdown: 0, start: true });
  for (const date of dates) {
    const e = events[date];
    balance += e.activity + e.pnl;
    if (balance > peak) peak = balance;
    const dd = balance - peak;
    if (dd < maxDd) { maxDd = dd; maxDdPct = peak > 0 ? dd / peak : 0; }
    points.push({ date, balance: parseFloat(balance.toFixed(2)), day_pnl: parseFloat(e.pnl.toFixed(2)), activity: e.activity || 0, trades: e.trades, wins: e.wins, losses: e.losses, peak: parseFloat(peak.toFixed(2)), drawdown: parseFloat(dd.toFixed(2)) });
  }
  const isFtmo = oneAccount && accounts[0]?.broker === 'FTMO';
  return {
    start_balance: startBalance,
    end_balance: parseFloat(balance.toFixed(2)),
    peak_balance: parseFloat(peak.toFixed(2)),
    max_drawdown_usd: parseFloat(maxDd.toFixed(2)),
    max_drawdown_pct: parseFloat((maxDdPct * 100).toFixed(2)),
    account: oneAccount, broker: accounts[0]?.broker || null,
    // FTMO 2-Step lines, drawn on the charts for a single FTMO account
    ftmo: isFtmo ? { floor: startBalance * 0.9, daily_allowance: startBalance * 0.05, target: startBalance * 1.10 } : null,
    points,
  };
}

// ─── Pass 2: session heatmap, R distribution, streaks ────────────────────────
// Hour-of-day × weekday grid of net P&L and trade counts, keyed on the stored exit time
// (Prague for FTMO imports, broker server time for the rest).
// Times are stored as the broker's server clock (Prague for FTMO, and the MT5 brokers also run on
// Central European time), so each exit is read as Prague wall time and shown in Pacific time.
const TZ_FROM = 'Europe/Prague';
const TZ_TO = 'America/Los_Angeles';
function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(o.weekday) };
}
// Wall-clock time in `tz` → real instant (two-step correction handles DST edges well enough for hour buckets).
function wallToInstant(wall, tz) {
  const m = String(wall).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = tzParts(new Date(guess), tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess += asUtc - shown;
  }
  return new Date(guess);
}
function getSessionHeatmap(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);
  const f = where ? `${where} AND status != 'OPEN' AND exit_datetime IS NOT NULL` : `WHERE status != 'OPEN' AND exit_datetime IS NOT NULL`;
  const rows = db.prepare(`SELECT exit_datetime, status, symbol, pnl + COALESCE(commission, 0) as net FROM trades ${f}`).all(params);
  const cells = {};
  for (const r of rows) {
    const inst = wallToInstant(r.exit_datetime, TZ_FROM);
    if (!inst) continue;
    const p = tzParts(inst, TZ_TO);
    // Mike's trading day starts at 05:00 Pacific, so 00:00-04:59 belongs to the previous day's row.
    const dow = p.h < 5 ? (p.dow + 6) % 7 : p.dow;
    const k = `${dow}-${p.h}`;
    const c = (cells[k] ||= { dow, hour: p.h, trades: 0, wins: 0, net_pnl: 0, exits: [] });
    c.trades++; if (r.status === 'WIN') c.wins++; c.net_pnl += r.net || 0;
    // exact close time (Pacific, to the minute) so an hour bucket can be read precisely
    c.exits.push({ time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`, symbol: r.symbol, net: parseFloat((r.net || 0).toFixed(2)) });
  }
  return Object.values(cells).map(c => ({ ...c, net_pnl: parseFloat(c.net_pnl.toFixed(2)), exits: c.exits.sort((a, b) => a.time.localeCompare(b.time)) })).sort((a, b) => a.dow - b.dow || a.hour - b.hour);
}

// R per closed trade, binned in half-R steps, plus the summary the histogram is drawn against.
function getRDistribution(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);
  const f = where ? `${where} AND status != 'OPEN' AND r_multiple IS NOT NULL` : `WHERE status != 'OPEN' AND r_multiple IS NOT NULL`;
  const rs = db.prepare(`SELECT r_multiple as r, pnl + COALESCE(commission, 0) as net FROM trades ${f}`).all(params);
  const closedTotal = db.prepare(`SELECT COUNT(*) as n FROM trades ${where ? where + " AND status != 'OPEN'" : "WHERE status != 'OPEN'"}`).get(params).n;
  if (!rs.length) return { count: 0, closed_total: closedTotal, bins: [], expectancy_r: null, avg_win_r: null, avg_loss_r: null };
  const step = 1.0; // whole-R bins read cleaner: -2R to -1R, -1R to 0, 0 to +1R…
  const lo = Math.floor(Math.min(...rs.map(x => x.r)) / step) * step;
  const hi = Math.ceil(Math.max(...rs.map(x => x.r)) / step) * step;
  const bins = [];
  for (let b = lo; b < hi + 1e-9; b += step) {
    const inBin = rs.filter(x => x.r >= b - 1e-9 && x.r < b + step - 1e-9);
    const lab = (v) => `${v > 0 ? '+' : ''}${Number.isInteger(v) ? v : v.toFixed(1)}R`;
    bins.push({ from: parseFloat(b.toFixed(2)), to: parseFloat((b + step).toFixed(2)), label: `${lab(b)} to ${lab(b + step)}`, short: lab(b), count: inBin.length, net: parseFloat(inBin.reduce((s, x) => s + x.net, 0).toFixed(2)) });
  }
  const wins = rs.filter(x => x.r > 0), losses = rs.filter(x => x.r < 0);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x.r, 0) / a.length : null);
  return {
    count: rs.length, closed_total: closedTotal,
    bins,
    expectancy_r: parseFloat((rs.reduce((s, x) => s + x.r, 0) / rs.length).toFixed(2)),
    avg_win_r: avg(wins) != null ? parseFloat(avg(wins).toFixed(2)) : null,
    avg_loss_r: avg(losses) != null ? parseFloat(avg(losses).toFixed(2)) : null,
    win_rate: parseFloat((wins.length / rs.length).toFixed(4)),
  };
}

// The last N closed trades as a W/L tape, with the current run and the longest runs.
function getStreaks(filters = {}, limit = 40) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);
  const f = where ? `${where} AND status IN ('WIN','LOSS','B/E')` : `WHERE status IN ('WIN','LOSS','B/E')`;
  const all = db.prepare(`SELECT id, trade_id, symbol, status, pnl + COALESCE(commission, 0) as net, COALESCE(exit_datetime, entry_datetime) as t FROM trades ${f} ORDER BY t ASC, id ASC`).all(params);
  let longestWin = 0, longestLoss = 0, run = 0, runType = null;
  for (const x of all) {
    const k = x.status === 'WIN' ? 'W' : x.status === 'LOSS' ? 'L' : 'B';
    if (k === runType) run++; else { runType = k; run = 1; }
    if (k === 'W') longestWin = Math.max(longestWin, run);
    if (k === 'L') longestLoss = Math.max(longestLoss, run);
  }
  const tape = all.slice(-limit).map(x => ({ id: x.id, k: x.status === 'WIN' ? 'W' : x.status === 'LOSS' ? 'L' : 'B', net: parseFloat((x.net || 0).toFixed(2)), symbol: x.symbol, t: x.t }));
  return { tape, total: all.length, current: { type: runType, length: run }, longest_win: longestWin, longest_loss: longestLoss };
}

module.exports = {
  getSessionHeatmap, getRDistribution, getStreaks,
  getSymbolPerformance, getDailyPnl, getEquityCurve,
  getDashboardStats,
  getPnlOverTime,
  getStrategyPerformance,
  getMarketPerformance,
  getWinRateByDay,
  getDurationDistribution,
  getCalendarData,
  getBalanceOverTime,
  getPlanAdherence,
};
