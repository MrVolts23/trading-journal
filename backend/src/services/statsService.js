const { getDb } = require('../db/database');

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
  if (filters.dateStart) {
    conditions.push("entry_datetime >= @dateStart");
    params.dateStart = filters.dateStart;
  }
  if (filters.dateEnd) {
    conditions.push("entry_datetime <= @dateEnd");
    params.dateEnd = filters.dateEnd + ' 23:59:59';
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
      SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END) as net_pnl,
      AVG(CASE WHEN r_multiple IS NOT NULL THEN r_multiple END) as avg_r_multiple,
      AVG(CASE WHEN status = 'WIN' AND pnl IS NOT NULL THEN pnl END) as avg_win,
      AVG(CASE WHEN status = 'LOSS' AND pnl IS NOT NULL THEN pnl END) as avg_loss,
      MAX(pnl) as largest_win,
      MIN(pnl) as largest_loss
    FROM trades ${where}
  `).get(params);

  // Win rate (exclude open)
  const closedCount = (totals.wins || 0) + (totals.losses || 0) + (totals.breakeven || 0);
  const winRate = closedCount > 0 ? (totals.wins || 0) / closedCount : 0;

  // Profit factor
  const grossWin = db.prepare(`SELECT SUM(pnl) as v FROM trades ${where ? where + " AND status='WIN'" : "WHERE status='WIN'"}`).get(params)?.v || 0;
  const grossLoss = db.prepare(`SELECT ABS(SUM(pnl)) as v FROM trades ${where ? where + " AND status='LOSS'" : "WHERE status='LOSS'"}`).get(params)?.v || 0;
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
      DATE(entry_datetime) as date,
      SUM(pnl) as daily_pnl,
      COUNT(*) as trade_count
    FROM trades ${where}
    GROUP BY DATE(entry_datetime)
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
      SUM(pnl) as net_pnl,
      ROUND(AVG(pnl), 2) as avg_pnl
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
      SUM(pnl) as net_pnl,
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
      SUM(pnl) as net_pnl,
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
    ? `${where} AND DATE(entry_datetime) >= '${startDate}' AND DATE(entry_datetime) <= '${endDateStr}'`
    : `WHERE DATE(entry_datetime) >= '${startDate}' AND DATE(entry_datetime) <= '${endDateStr}'`;

  return db.prepare(`
    SELECT
      DATE(entry_datetime) as date,
      SUM(pnl) as daily_pnl,
      COUNT(*) as trade_count,
      SUM(CASE WHEN status='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status='LOSS' THEN 1 ELSE 0 END) as losses
    FROM trades ${dateFilter}
    GROUP BY DATE(entry_datetime)
    ORDER BY date ASC
  `).all(params);
}

function getBalanceOverTime(filters = {}) {
  const db = getDb();
  const { where, params } = buildWhereClause(filters);

  // Daily PnL from trades
  const dailyPnl = db.prepare(`
    SELECT
      DATE(entry_datetime) as date,
      SUM(pnl) as daily_pnl
    FROM trades ${where}
    GROUP BY DATE(entry_datetime)
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
      SUM(CASE WHEN rule_followed = 1 THEN pnl ELSE 0 END) as pnl_followed,
      SUM(CASE WHEN rule_followed = 0 THEN pnl ELSE 0 END) as pnl_broke,
      AVG(CASE WHEN rule_followed = 1 THEN pnl END) as avg_pnl_followed,
      AVG(CASE WHEN rule_followed = 0 THEN pnl END) as avg_pnl_broke
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

module.exports = {
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
