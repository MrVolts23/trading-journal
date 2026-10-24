const { getDb } = require('../db/database');

// 1R is the dollars the trader planned to risk: the trade's own risk_usd if set, otherwise the
// account's standard risk in force on the trade's day (account_risk, latest effective_from <= day).
// R = net result (pnl + commission) / that risk. Trades with no planned risk get no R.
function standardRiskFor(db, account, day) {
  if (!account || !day) return null;
  const row = db.prepare(`SELECT risk_usd FROM account_risk WHERE account = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1`).get(account, String(day).slice(0, 10));
  return row ? row.risk_usd : null;
}

function recomputePlannedR(account = null) {
  const db = getDb();
  const where = account ? 'WHERE account = ?' : '';
  const rows = db.prepare(`SELECT id, account, risk_usd, pnl, commission, status, COALESCE(exit_datetime, entry_datetime) as day FROM trades ${where}`).all(...(account ? [account] : []));
  const upd = db.prepare('UPDATE trades SET r_multiple = ? WHERE id = ?');
  let withR = 0;
  db.transaction(() => {
    for (const t of rows) {
      const risk = t.risk_usd || standardRiskFor(db, t.account, t.day);
      let r = null;
      if (risk > 0 && t.pnl != null && t.status !== 'OPEN') r = Math.round(((t.pnl || 0) + (t.commission || 0)) / risk * 100) / 100;
      if (r != null) withR++;
      upd.run(r, t.id);
    }
  })();
  return { trades: rows.length, with_r: withR };
}

module.exports = { recomputePlannedR, standardRiskFor };
