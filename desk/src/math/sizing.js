// Quant Desk — position sizing (pure). Demo-only: this computes lots and $; it never places anything.
//
// Gold facts (XAUUSD, 1 lot = 100 oz): a $1.00 move in price on 1.00 lot = $100.
// All facts are overridable through profile.symbol_facts — every number a human sets is editable.

const DEFAULT_FACTS = {
  contract_size: 100,
  lot_step: 0.01,
  min_lot: 0.01,
  tick_size: 0.01,
  tick_value: 1.0,          // USD per tick per lot
  usd_per_point_per_lot: 100,
};

function facts(profile) {
  return { ...DEFAULT_FACTS, ...((profile && profile.symbol_facts) || {}) };
}

function decimalsOf(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

/**
 * sizeTrade(trade, profile, balance) → { lots, risk_usd, pnl_usd, unsizable, reason, ccy }
 *   risk_usd = balance × risk_pct_per_trade/100 (balance is in profile.account_ccy; treated 1:1 with USD
 *              for now — the ccy label is returned so the UI can say so).
 *   lots     = floor(risk_usd / (risk × usd_per_point_per_lot) / lot_step) × lot_step, capped at hard_lot_cap.
 *   lots < min_lot → unsizable (pnl_usd 0; callers count these separately).
 *   pnl_usd  = r × risk × usd_per_point_per_lot × lots.
 * trade.risk is the stop distance in price; falls back to |entry − sl| when absent.
 */
function sizeTrade(trade, profile = {}, balance) {
  const F = facts(profile);
  const riskPct = profile.risk_pct_per_trade != null ? +profile.risk_pct_per_trade : 1.0;
  const hardCap = profile.hard_lot_cap != null ? +profile.hard_lot_cap : 1.0;
  const bal = balance != null ? +balance : +(profile.account_size || 0);
  const ccy = profile.account_ccy || 'USD';
  const risk = trade.risk != null ? +trade.risk : Math.abs((+trade.entry) - (+trade.sl));
  const risk_usd = +(bal * riskPct / 100).toFixed(2);
  const base = { lots: 0, risk_usd, pnl_usd: 0, unsizable: true, reason: null, ccy };
  if (!(risk > 0) || !Number.isFinite(risk)) return { ...base, reason: 'invalid_risk_distance' };
  if (!(bal > 0)) return { ...base, reason: 'no_balance' };
  const raw = risk_usd / (risk * F.usd_per_point_per_lot);
  const steps = Math.floor(raw / F.lot_step + 1e-9);
  let lots = +(steps * F.lot_step).toFixed(decimalsOf(F.lot_step));
  let capped = false;
  if (lots > hardCap) { lots = hardCap; capped = true; }
  if (lots < F.min_lot) return { ...base, reason: `lots ${lots} < min_lot ${F.min_lot} (risk ${risk} too wide for ${risk_usd} ${ccy})` };
  const pnl_usd = +((+trade.r || 0) * risk * F.usd_per_point_per_lot * lots).toFixed(2);
  return { lots, risk_usd, pnl_usd, unsizable: false, reason: capped ? 'capped_at_hard_lot_cap' : null, ccy };
}

/**
 * equityCurve(trades, profile, startBalance) → [{ t, balance, r_cum, pnl_usd, lots, unsizable }]
 * Trades are processed in close order (sorted by exitT). profile.compounding (default false):
 *   false → every trade is sized off startBalance (fixed-fractional on the starting stake);
 *   true  → sized off the running balance.
 */
function equityCurve(trades, profile = {}, startBalance) {
  const start = startBalance != null ? +startBalance : +(profile.account_size || 0);
  const compounding = !!profile.compounding;
  const sorted = (trades || []).slice().sort((a, b) => (a.exitT ?? a.entryT) - (b.exitT ?? b.entryT));
  let balance = start, rCum = 0;
  const out = [];
  for (const tr of sorted) {
    const s = sizeTrade(tr, profile, compounding ? balance : start);
    balance = +(balance + s.pnl_usd).toFixed(2);
    rCum = +(rCum + (+tr.r || 0)).toFixed(3);
    out.push({ t: tr.exitT ?? tr.entryT, balance, r_cum: rCum, pnl_usd: s.pnl_usd, lots: s.lots, unsizable: s.unsizable });
  }
  return out;
}

/**
 * sizeTrades(trades, profile, startBalance) → { trades: [trade + {lots, risk_usd, pnl_usd, unsizable}],
 *   summary: { sized, unsizable, net_usd, max_dd_usd, end_balance, start_balance, ccy, compounding } }
 * Convenience for the bench: attaches sizing fields to each trade (close order) and totals them.
 */
function sizeTrades(trades, profile = {}, startBalance) {
  const start = startBalance != null ? +startBalance : +(profile.account_size || 0);
  const compounding = !!profile.compounding;
  const sorted = (trades || []).slice().sort((a, b) => (a.exitT ?? a.entryT) - (b.exitT ?? b.entryT));
  let balance = start, peak = start, maxDd = 0, unsizable = 0;
  const out = sorted.map((tr) => {
    const s = sizeTrade(tr, profile, compounding ? balance : start);
    if (s.unsizable) unsizable++;
    balance = +(balance + s.pnl_usd).toFixed(2);
    peak = Math.max(peak, balance);
    maxDd = Math.max(maxDd, peak - balance);
    return { ...tr, lots: s.lots, risk_usd: s.risk_usd, pnl_usd: s.pnl_usd, unsizable: s.unsizable };
  });
  return {
    trades: out,
    summary: {
      sized: out.length - unsizable, unsizable,
      net_usd: +(balance - start).toFixed(2), max_dd_usd: +maxDd.toFixed(2),
      start_balance: start, end_balance: balance,
      ccy: profile.account_ccy || 'USD', compounding,
    },
  };
}

module.exports = { DEFAULT_FACTS, sizeTrade, equityCurve, sizeTrades };
