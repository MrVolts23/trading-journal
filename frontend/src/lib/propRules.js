// FTMO rule engine for the Prop Management page. Pure functions, no React, no storage.
// Source of truth: ~/Downloads/ftmo-rules-brief.md (Sept 2026). Items the brief flags as
// "verify against the live dashboard" are kept as editable numbers on the account, not hardcoded here.

export const PRODUCTS = {
  '2step_standard': {
    label: '2-Step Standard',
    phases: [
      { key: 'challenge',    label: 'Challenge (Phase 1)',    target: 0.10 },
      { key: 'verification', label: 'Verification (Phase 2)', target: 0.05 },
      { key: 'funded',       label: 'Funded',                 target: null },
    ],
    dailyLoss: 0.05, maxLoss: 0.10, maxLossMode: 'static', minDays: 4, bestDay: false, goldLeverage: 30,
  },
  '2step_swing': {
    label: '2-Step Swing',
    phases: [
      { key: 'challenge',    label: 'Challenge (Phase 1)',    target: 0.10 },
      { key: 'verification', label: 'Verification (Phase 2)', target: 0.05 },
      { key: 'funded',       label: 'Funded',                 target: null },
    ],
    dailyLoss: 0.05, maxLoss: 0.10, maxLossMode: 'static', minDays: 4, bestDay: false, goldLeverage: 9,
  },
  '1step': {
    label: '1-Step',
    phases: [
      { key: 'challenge', label: 'Challenge', target: 0.10 },
      { key: 'funded',    label: 'Funded',    target: null },
    ],
    dailyLoss: 0.03, maxLoss: 0.10, maxLossMode: 'trailing', minDays: 0, bestDay: true, goldLeverage: 30,
  },
};

export const SIZES = [10000, 25000, 50000, 100000, 200000];
export const CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'CHF'];

// Prague day key (YYYY-MM-DD). FTMO's day boundary is 00:00 CE(S)T.
export function pragueDate(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function pragueTime(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function newAccount({ product = '2step_standard', size = 200000, currency = 'USD', phaseIndex = 0, startDate = pragueDate(), name } = {}) {
  const P = PRODUCTS[product];
  return {
    id: 'acct_' + Math.random().toString(36).slice(2, 10),
    firm: 'FTMO',
    name: name || `FTMO ${P.label} $${size / 1000}K`,
    product, size, currency, phaseIndex, startDate,
    goldLeverage: P.goldLeverage,        // editable per account (the brief flags some as unverified)
    dailyLossPct: P.dailyLoss * 100,     // editable
    maxLossPct: P.maxLoss * 100,         // editable
    days: [],                            // closed Prague days: { date, trades: [$], worstDip: <=0 }
    today: { date: pragueDate(), trades: [], worstDip: 0 },
  };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// Walk one day's trades from its anchor balance. worstDip is the deepest floating loss seen on an
// open trade that day (<= 0). The daily rule is on equity, so the day's worst equity is the lowest
// closed-balance point plus that dip (conservative: assumes the dip happened at the low).
function walkDay(anchor, trades, worstDip) {
  let eq = anchor, low = anchor;
  const path = [];
  for (const t of trades) { eq += t; path.push(eq); if (eq < low) low = eq; }
  const dip = Math.min(0, Number(worstDip) || 0);
  return { close: eq, pathLow: low, worstEquity: low + dip, path };
}

export function computeState(acct) {
  const P = PRODUCTS[acct.product] || PRODUCTS['2step_standard'];
  const initial = Number(acct.size) || 0;
  const dailyAllowance = initial * (Number(acct.dailyLossPct) || P.dailyLoss * 100) / 100;
  const maxLossAmt = initial * (Number(acct.maxLossPct) || P.maxLoss * 100) / 100;
  const phase = P.phases[Math.min(acct.phaseIndex || 0, P.phases.length - 1)];

  let running = initial;        // balance at the start of the day being walked
  let highestEod = initial;     // for the 1-Step trailing floor (prior days only)
  const dayRows = [];
  let anyBreach = null;

  const evalDay = (date, trades, worstDip, isToday) => {
    const anchor = running;
    const dailyLine = anchor - dailyAllowance;
    const floor = P.maxLossMode === 'trailing' ? highestEod - maxLossAmt : initial - maxLossAmt;
    const w = walkDay(anchor, trades, worstDip);
    const dailyBreach = w.worstEquity < dailyLine;
    const mlBreach = w.worstEquity < floor;
    const row = {
      date, isToday, anchor, dailyLine, floor, trades: trades.slice(), pnl: w.close - anchor, close: w.close,
      worstDip: Math.min(0, Number(worstDip) || 0), worstEquity: w.worstEquity,
      dailyRoomUsed: Math.max(0, anchor - w.worstEquity), dailyAllowance,
      counted: trades.length > 0, dailyBreach, mlBreach, path: w.path,
    };
    if (!anyBreach && (dailyBreach || mlBreach)) anyBreach = { date, kind: dailyBreach ? 'daily' : 'max', row };
    return row;
  };

  for (const d of acct.days || []) {
    const row = evalDay(d.date, d.trades || [], d.worstDip, false);
    dayRows.push(row);
    running = row.close;
    highestEod = Math.max(highestEod, row.close);
  }
  const today = acct.today || { date: pragueDate(), trades: [], worstDip: 0 };
  const todayRow = evalDay(today.date, today.trades || [], today.worstDip, true);

  const equityNow = todayRow.close;                 // closed balance right now (open P&L is not logged)
  const dailyRoom = equityNow - todayRow.dailyLine;
  const mlRoom = equityNow - todayRow.floor;
  const binding = dailyRoom <= mlRoom ? 'daily' : 'max';

  const closedProfit = equityNow - initial;
  const targetAmt = phase.target != null ? initial * phase.target : null;
  const targetProgress = targetAmt ? closedProfit / targetAmt : null;
  const targetHit = targetAmt ? closedProfit >= targetAmt : false;
  // A trading day is a distinct Prague calendar date with at least one trade. Pressing End day twice on the
  // same date, or trading again after End day, must not count as extra days.
  const tradingDays = new Set([...dayRows, todayRow].filter((r) => r.counted).map((r) => r.date)).size;
  const minDaysMet = tradingDays >= (P.minDays || 0);

  // 1-Step Best Day rule (not a breach; a condition to pass)
  const dayPnls = [...dayRows.map((r) => r.pnl), todayRow.pnl];
  const positiveDaysProfit = sum(dayPnls.filter((x) => x > 0));
  const bestDay = dayPnls.length ? Math.max(...dayPnls, 0) : 0;
  const bestDayOk = !P.bestDay || bestDay <= 0.5 * positiveDaysProfit + 1e-9;
  const bestDayNeeded = P.bestDay ? Math.max(0, 2 * bestDay - positiveDaysProfit) : 0;

  const breached = !!anyBreach;
  const passed = !breached && targetAmt != null && targetHit && minDaysMet && bestDayOk;
  const status = breached ? 'breached' : passed ? 'passed' : 'active';

  return {
    product: P, phase, initial, dailyAllowance, maxLossAmt,
    days: dayRows, today: todayRow, equityNow, closedProfit,
    dailyLine: todayRow.dailyLine, floor: todayRow.floor, dailyRoom, mlRoom, binding,
    targetAmt, targetProgress, targetHit, tradingDays, minDays: P.minDays || 0, minDaysMet,
    bestDayRule: P.bestDay, positiveDaysProfit, bestDay, bestDayOk, bestDayNeeded,
    breached, breach: anyBreach, passed, status,
    lossesToDailyLine: (riskUsd) => (riskUsd > 0 ? Math.floor(dailyRoom / riskUsd) : null),
    lossesToFloor: (riskUsd) => (riskUsd > 0 ? Math.floor(mlRoom / riskUsd) : null),
  };
}

// Gold ticket check. stopUsd = stop distance in price dollars; riskUsd = dollars at risk.
export function ticketCheck(state, { stopUsd, riskUsd, price, leverage }) {
  const usdPerDollarMovePerLot = 100;                       // 100 oz per lot
  const lots = stopUsd > 0 ? riskUsd / (stopUsd * usdPerDollarMovePerLot) : 0;
  const maxLots = price > 0 && leverage > 0 ? state.equityNow * leverage / (price * 100) : 0;
  const marginUsd = leverage > 0 ? lots * price * 100 / leverage : 0;
  const marginPct = state.equityNow > 0 ? marginUsd / state.equityNow : 0;
  const afterStop = state.equityNow - riskUsd;
  return {
    lots, maxLots, marginUsd, marginPct,
    tooBig: lots > maxLots && maxLots > 0,
    afterStop,
    roomDailyAfter: afterStop - state.dailyLine,
    roomFloorAfter: afterStop - state.floor,
    crossesDaily: afterStop < state.dailyLine,
    crossesFloor: afterStop < state.floor,
    minStopForFullSize: state.equityNow > 0 && leverage > 0 ? (riskUsd / state.equityNow) * price / leverage : 0,
  };
}

// Winning days needed to reach the target at an average net R per day (in dollars per day).
export function daysToTarget(state, avgDayUsd) {
  if (!state.targetAmt || avgDayUsd <= 0) return null;
  const remaining = state.targetAmt - state.closedProfit;
  return remaining <= 0 ? 0 : Math.ceil(remaining / avgDayUsd);
}
