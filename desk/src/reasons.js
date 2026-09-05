// Quant Desk — plain-English reasons for a verdict. One sentence per verdict, built from the
// failing gate of desk/src/math/gates.js. Nothing here judges; it only narrates a number that
// was already decided. No snake_case gate names ever reach a screen through this module.

const GATE_LABELS = {
  min_trades_total: 'Enough trades overall',
  min_trades_per_fold: 'Enough trades in every stretch',
  folds_positive_min: 'Profitable stretches',
  min_profit_factor: 'Wins outweigh losses (profit factor)',
  max_dd_r: 'Deepest drawdown (R)',
  bootstrap_p_positive: 'Confidence the edge is real',
  psr: 'Statistically solid',
  deflated_sharpe: 'Beats the best random try',
};

function gateLabel(gate) {
  if (!gate) return 'Gate';
  return GATE_LABELS[gate] || String(gate).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function fmt(v, digits = 2) {
  if (v == null) return 'n/a';
  if (v === 'inf' || v === Infinity) return 'infinite';
  if (isNum(v)) return Number.isInteger(v) ? String(v) : String(+v.toFixed(digits));
  return String(v);
}
function pct(v) { return isNum(v) ? `${Math.round(v * 100)}%` : 'n/a'; }

// Total number of stretches (folds) from the gate note "3/5 folds ..." when present.
function foldCount(gate) {
  const m = gate && gate.note ? String(gate.note).match(/\/(\d+)\s*folds/) : null;
  return m ? +m[1] : 5;
}

// verdict: { verdict, gates:[{gate,value,threshold,pass,note}], failing_gate, n_trials_at|n_trials,
//            blocked_reason?, error? }  (a gate_verdicts row, or gates.verify() output)
function reasonFor(verdict) {
  if (!verdict) return 'not tested yet';
  const v = String(verdict.verdict || '').toUpperCase();
  const gates = Array.isArray(verdict.gates) ? verdict.gates : [];
  if (v === 'PASS') return 'passed every gate';
  if (v === 'BLOCKED') {
    const detail = verdict.blocked_reason || verdict.detail
      || (verdict.failing_gate && !GATE_LABELS[verdict.failing_gate] ? verdict.failing_gate : null)
      || 'too little data to judge';
    return `couldn't be judged: ${humanizeDetail(detail)}`;
  }
  if (v === 'ERROR' || v === 'FAILED') return `the test crashed: ${verdict.error || verdict.detail || 'unknown error'}`;
  const failing = (verdict.failing_gate && gates.find((g) => g.gate === verdict.failing_gate)) || gates.find((g) => g && g.pass === false) || null;
  if (!failing) return v === 'REJECT' ? 'failed a gate' : 'not tested yet';
  const { value, threshold } = failing;
  const nTrials = verdict.n_trials_at ?? verdict.n_trials ?? null;
  switch (failing.gate) {
    case 'folds_positive_min':
      return `only ${fmt(value)} of ${foldCount(failing)} stretches of the data were profitable (needs ${fmt(threshold)})`;
    case 'bootstrap_p_positive':
      return `the edge can't be told apart from luck yet (${pct(value)} confidence, needs ${pct(threshold)})`;
    case 'min_trades_total':
      return `not enough trades yet (${fmt(value)}, needs ${fmt(threshold)})`;
    case 'min_trades_per_fold':
      return `one stretch had too few trades (${fmt(value)}, needs ${fmt(threshold)})`;
    case 'min_profit_factor':
      return `wins didn't outweigh losses enough (profit factor ${fmt(value)}, needs ${fmt(threshold)})`;
    case 'max_dd_r':
      return `drawdown too deep (${fmt(value)}R, limit ${fmt(threshold)}R)`;
    case 'psr':
      return "the result isn't statistically solid yet";
    case 'deflated_sharpe':
      return `not better than the best of ${nTrials != null ? fmt(nTrials) : 'the'} random tries`;
    default:
      return `failed the "${gateLabel(failing.gate)}" gate (${fmt(value)}, needs ${fmt(threshold)})`;
  }
}

// gates.js blocked reasons mention internals; soften the ones we know.
function humanizeDetail(detail) {
  const s = String(detail);
  if (/too thin to evaluate/.test(s)) {
    const m = s.match(/only (\d+) trades/);
    if (m && +m[1] === 0) return 'the rules never took a trade, so there is nothing to judge';
    return m ? `only ${m[1]} trade${m[1] === '1' ? '' : 's'}, too few to judge` : 'too few trades to judge';
  }
  if (/research metrics\/trades missing/.test(s)) return 'the run produced no trades';
  if (/fold results missing/.test(s)) return 'the data could not be split into stretches';
  if (/max_daily_loss_r missing/.test(s)) return 'the risk profile has no daily loss cap';
  if (/n_trials missing/.test(s)) return 'the trial counter was not consulted';
  if (/verifier unavailable/.test(s)) return 'the judge was not available';
  return s.replace(/_/g, ' ');
}

// English word for a verdict code. Mike reads PASS / FAIL, never REJECT.
function verdictWord(verdict) {
  if (!verdict) return null;
  const v = String(typeof verdict === 'object' ? verdict.verdict : verdict).toUpperCase();
  if (v === 'PASS') return 'PASS';
  if (v === 'BLOCKED') return 'BLOCKED';
  if (v === 'ERROR' || v === 'FAILED') return 'ERROR';
  return 'FAIL';
}

// Rows for the detail table: English label, value and "needed" already formatted for display.
function gateRows(gates, nTrials) {
  return (Array.isArray(gates) ? gates : []).map((g) => {
    let value = fmt(g.value), needed = fmt(g.threshold);
    if (g.gate === 'bootstrap_p_positive') { value = pct(g.value); needed = `at least ${pct(g.threshold)}`; }
    else if (g.gate === 'folds_positive_min') { value = `${fmt(g.value)} of ${foldCount(g)}`; needed = `at least ${fmt(g.threshold)}`; }
    else if (g.gate === 'max_dd_r') { value = `${fmt(g.value)}R`; needed = `at most ${fmt(g.threshold)}R`; }
    else if (g.gate === 'psr') { value = pct(g.value); needed = `at least ${pct(g.threshold)}`; }
    else if (g.gate === 'deflated_sharpe') { needed = `above ${fmt(g.threshold)}${nTrials != null ? ` (best of ${nTrials} random tries)` : ''}`; }
    else if (g.gate === 'min_trades_total' || g.gate === 'min_trades_per_fold' || g.gate === 'min_profit_factor') { needed = `at least ${fmt(g.threshold)}`; }
    return {
      gate: g.gate, label: gateLabel(g.gate), value, needed, pass: !!g.pass,
      report_only: !!g.report_only,
      note: g.report_only ? 'reported, not enforced yet' : null,
    };
  });
}

module.exports = { reasonFor, gateLabel, gateRows, verdictWord, GATE_LABELS };
