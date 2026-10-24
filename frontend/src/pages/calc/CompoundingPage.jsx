import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

// ── Helpers ────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'calc_compounding_v1';

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '-';
  const abs = Math.abs(n);
  const digits = abs < 10000 ? 2 : 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

function fmtShort(n) {
  if (n == null || isNaN(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1000)      return sign + '$' + (abs / 1000).toFixed(1) + 'k';
  return sign + '$' + abs.toFixed(0);
}

function fmtPct(rate) {
  if (rate == null || isNaN(rate)) return '-';
  const pct = rate * 100;
  const abs = Math.abs(pct);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return parseFloat(pct.toFixed(digits)).toString() + '%';
}

function fmtR(r) {
  if (r == null || isNaN(r)) return '-';
  return parseFloat(r.toFixed(2)).toString() + 'R';
}

function fmtInt(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

const UNIT_WORDS = {
  trade: { one: 'trade', many: 'trades', per: 'a trade' },
  day:   { one: 'day',   many: 'days',   per: 'a day' },
  week:  { one: 'week',  many: 'weeks',  per: 'a week' },
  month: { one: 'month', many: 'months', per: 'a month' },
};

function unitCount(n, unit) {
  const w = UNIT_WORDS[unit] || UNIT_WORDS.week;
  return `${fmtInt(n)} ${n === 1 ? w.one : w.many}`;
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function save(params) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(params)); } catch { /* storage unavailable, ignore */ }
}

// ── Math ───────────────────────────────────────────────────────────────────────
// balance_{n+1} = balance_n x (1 + rate) + contribution, clamped at 0.
function simulate(start, rate, periods, contribution) {
  const rows = [];
  let bal = Math.max(0, start);
  let emptyAt = null;
  for (let i = 1; i <= periods; i++) {
    const before = bal;
    const gain = before * rate;
    let end = before + gain + contribution;
    if (end <= 0) { end = 0; if (emptyAt == null) emptyAt = i; }
    rows.push({ n: i, before, gain, contribution, end });
    bal = end;
  }
  return { rows, end: bal, emptyAt };
}

// How many periods until the balance first reaches the target. Iterates up to 5000.
function periodsToTarget(start, rate, contribution, target) {
  if (target <= start) return { periods: 0 };
  let bal = start;
  for (let i = 1; i <= 5000; i++) {
    const next = bal * (1 + rate) + contribution;
    if (next >= target) return { periods: i };
    if (next <= bal) return { periods: null, reason: 'stalls' };
    bal = next;
  }
  return { periods: null, reason: 'too-long' };
}

// Rate per period needed to hit the target in exactly `periods` periods. Bisection on [0, 5.0].
function rateForTarget(start, periods, contribution, target) {
  const endAt = r => simulate(start, r, periods, contribution).end;
  if (endAt(0) >= target) return { rate: 0 };
  if (endAt(5) < target) return { rate: null };
  let lo = 0, hi = 5;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (endAt(mid) >= target) hi = mid; else lo = mid;
  }
  return { rate: hi };
}

// ── Defaults ───────────────────────────────────────────────────────────────────
const DEFAULT_PARAMS = {
  startBal: 2000,
  rateMode: 'percent',   // 'percent' or 'r'
  pctPerPeriod: 2,
  rPerPeriod: 1,
  riskPct: 1,
  unit: 'week',
  periods: 52,
  contribution: 0,
  targetBal: 100000,     // null means no target
};

// ── Chart tooltip ──────────────────────────────────────────────────────────────
function BalanceTooltip({ active, payload, label, unit }) {
  if (!active || !payload || !payload.length) return null;
  const v = payload[0].value;
  return (
    <div className="bg-terminal-surface border border-terminal-border rounded px-3 py-2 font-mono text-xs">
      <div className="text-terminal-dim">{label === 0 ? 'start' : unitCount(label, unit)}</div>
      <div className="text-terminal-green font-semibold">{fmtMoney(v)}</div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function CompoundingPage() {
  const [params, setParams] = useState(() => ({ ...DEFAULT_PARAMS, ...(loadSaved() || {}) }));

  // Persist on every change
  useEffect(() => { save(params); }, [params]);

  const set = (k, v) => setParams(p => ({ ...p, [k]: v }));

  const rate = params.rateMode === 'percent'
    ? (params.pctPerPeriod || 0) / 100
    : (params.rPerPeriod || 0) * (params.riskPct || 0) / 100;

  const periods = Math.max(1, Math.min(5000, Math.round(params.periods || 1)));
  const hasTarget = params.targetBal != null && params.targetBal > 0;
  const unitW = UNIT_WORDS[params.unit] || UNIT_WORDS.week;

  const sim = useMemo(
    () => simulate(params.startBal || 0, rate, periods, params.contribution || 0),
    [params.startBal, rate, periods, params.contribution]
  );

  const totalGain = sim.rows.reduce((s, r) => s + r.gain, 0);
  const totalContrib = sim.rows.reduce((s, r) => s + r.contribution, 0);
  const hitTargetAt = hasTarget ? (sim.rows.find(r => r.end >= params.targetBal)?.n ?? null) : null;

  const chartData = useMemo(
    () => [{ n: 0, balance: params.startBal || 0 }, ...sim.rows.map(r => ({ n: r.n, balance: r.end }))],
    [sim, params.startBal]
  );

  // Work it backwards
  const solvePeriods = hasTarget ? periodsToTarget(params.startBal || 0, rate, params.contribution || 0, params.targetBal) : null;
  const solveRate    = hasTarget ? rateForTarget(params.startBal || 0, periods, params.contribution || 0, params.targetBal) : null;

  const rateWords = params.rateMode === 'percent'
    ? `${fmtPct(rate)} ${unitW.per}`
    : `${fmtR(params.rPerPeriod || 0)} ${unitW.per} at ${fmtPct((params.riskPct || 0) / 100)} risk per trade (${fmtPct(rate)} ${unitW.per})`;

  const contribWords = (params.contribution || 0) > 0
    ? `, adding ${fmtMoney(params.contribution)} ${unitW.per}`
    : (params.contribution || 0) < 0
      ? `, withdrawing ${fmtMoney(Math.abs(params.contribution))} ${unitW.per}`
      : '';

  let periodsSentence = '';
  if (!hasTarget) {
    periodsSentence = 'Set a target balance to see how long it takes to get there.';
  } else if (solvePeriods.periods === 0) {
    periodsSentence = `You are already at ${fmtMoney(params.targetBal)}. The target is not above the starting balance.`;
  } else if (solvePeriods.periods == null) {
    periodsSentence = solvePeriods.reason === 'stalls'
      ? `At ${rateWords}${contribWords}, ${fmtMoney(params.startBal)} never reaches ${fmtMoney(params.targetBal)}. The balance stalls or shrinks, so it is not reachable at this rate.`
      : `At ${rateWords}${contribWords}, ${fmtMoney(params.startBal)} does not reach ${fmtMoney(params.targetBal)} within 5,000 ${unitW.many}. Not reachable at this rate.`;
  } else {
    periodsSentence = `At ${rateWords}${contribWords}, ${fmtMoney(params.startBal)} becomes ${fmtMoney(params.targetBal)} in ${unitCount(solvePeriods.periods, params.unit)}.`;
  }

  let rateSentence = '';
  let rateSentenceR = '';
  if (!hasTarget) {
    rateSentence = 'Set a target balance to see the growth rate you would need.';
  } else if (params.targetBal <= (params.startBal || 0)) {
    rateSentence = `No growth needed. ${fmtMoney(params.targetBal)} is not above your starting balance of ${fmtMoney(params.startBal)}.`;
  } else if (solveRate.rate === 0) {
    rateSentence = `Your additions alone turn ${fmtMoney(params.startBal)} into ${fmtMoney(params.targetBal)} in ${unitCount(periods, params.unit)}. You need no growth at all.`;
  } else if (solveRate.rate == null) {
    rateSentence = `${fmtMoney(params.startBal)} cannot reach ${fmtMoney(params.targetBal)} in ${unitCount(periods, params.unit)}${contribWords}, even at 500% ${unitW.per}.`;
  } else {
    rateSentence = `To turn ${fmtMoney(params.startBal)} into ${fmtMoney(params.targetBal)} in ${unitCount(periods, params.unit)}${contribWords}, you need ${fmtPct(solveRate.rate)} ${unitW.per}.`;
    if (params.rateMode === 'r') {
      const risk = (params.riskPct || 0) / 100;
      rateSentenceR = risk > 0
        ? `That is ${fmtR(solveRate.rate / risk)} ${unitW.per} at ${fmtPct(risk)} risk per trade.`
        : 'Set a risk per trade above 0% to see that as R.';
    }
  }

  const contribLabel = (params.contribution || 0) < 0 ? 'Withdraw' : 'Add';

  return (
    <div className="p-6 space-y-5">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Compounding</div>
          <div className="text-sm font-mono text-terminal-text mt-0.5">What a balance grows to when every period compounds.</div>
          <div className="text-xs font-mono text-terminal-dim mt-0.5">
            {fmtShort(params.startBal)} at {fmtPct(rate)} {unitW.per} for {unitCount(periods, params.unit)}
            {(params.contribution || 0) !== 0 ? `, ${contribLabel.toLowerCase()}ing ${fmtShort(Math.abs(params.contribution))} ${unitW.per}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Ending balance</div>
            <div className="text-2xl font-mono font-bold text-terminal-green">{fmtMoney(sim.end)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Total gain</div>
            <div className={`text-2xl font-mono font-bold ${totalGain >= 0 ? 'text-terminal-text' : 'text-terminal-red'}`}>
              {totalGain >= 0 ? '+' : ''}{fmtMoney(totalGain)}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[300px_1fr] gap-6 items-start">

        {/* ── LEFT: Inputs ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="card p-4 space-y-4">
            <div className="stat-label">Inputs</div>

            {/* Starting balance */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Starting balance ($)</label>
                <input type="number" value={params.startBal}
                  onChange={e => set('startBal', Math.max(0, parseFloat(e.target.value) || 0))}
                  className="input-field text-xs py-1 w-28 text-right font-mono" />
              </div>
              <input type="range" min={100} max={500000} step={100} value={Math.min(500000, params.startBal || 0)}
                onChange={e => set('startBal', parseFloat(e.target.value))}
                className="w-full accent-terminal-green h-1" />
            </div>

            {/* Growth mode toggle */}
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-terminal-muted">Growth per period, measured as</label>
              <div className="grid grid-cols-2 gap-1">
                {[
                  { id: 'percent', label: 'Percent' },
                  { id: 'r', label: 'R x risk' },
                ].map(m => (
                  <button key={m.id} onClick={() => set('rateMode', m.id)}
                    className={`text-xs font-mono font-semibold px-2 py-1.5 rounded border transition-colors ${
                      params.rateMode === m.id
                        ? 'bg-terminal-green/10 border-terminal-green/50 text-terminal-green'
                        : 'border-terminal-border text-terminal-dim hover:text-terminal-text'
                    }`}>
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="text-[10px] font-mono text-terminal-dim">
                {params.rateMode === 'percent'
                  ? 'The balance grows by this percent every period.'
                  : 'R is how many times your risk you make per period. Growth = R times risk per trade.'}
              </div>
            </div>

            {params.rateMode === 'percent' ? (
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-mono text-terminal-muted">Growth per {unitW.one} (%)</label>
                  <div className="flex items-center gap-1">
                    <input type="number" step={0.1} value={params.pctPerPeriod}
                      onChange={e => set('pctPerPeriod', parseFloat(e.target.value) || 0)}
                      className="input-field text-xs py-1 w-20 text-right font-mono" />
                    <span className="text-xs font-mono text-terminal-muted">%</span>
                  </div>
                </div>
                <input type="range" min={-10} max={25} step={0.1} value={Math.max(-10, Math.min(25, params.pctPerPeriod || 0))}
                  onChange={e => set('pctPerPeriod', parseFloat(e.target.value))}
                  className={`w-full h-1 ${(params.pctPerPeriod || 0) >= 0 ? 'accent-terminal-green' : 'accent-red-500'}`} />
              </div>
            ) : (<>
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-mono text-terminal-muted">R made per {unitW.one}</label>
                  <div className="flex items-center gap-1">
                    <input type="number" step={0.1} value={params.rPerPeriod}
                      onChange={e => set('rPerPeriod', parseFloat(e.target.value) || 0)}
                      className="input-field text-xs py-1 w-20 text-right font-mono" />
                    <span className="text-xs font-mono text-terminal-muted">R</span>
                  </div>
                </div>
                <input type="range" min={-5} max={10} step={0.1} value={Math.max(-5, Math.min(10, params.rPerPeriod || 0))}
                  onChange={e => set('rPerPeriod', parseFloat(e.target.value))}
                  className={`w-full h-1 ${(params.rPerPeriod || 0) >= 0 ? 'accent-terminal-green' : 'accent-red-500'}`} />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-mono text-terminal-muted">Risk per trade (%)</label>
                  <div className="flex items-center gap-1">
                    <input type="number" step={0.1} min={0} value={params.riskPct}
                      onChange={e => set('riskPct', Math.max(0, parseFloat(e.target.value) || 0))}
                      className="input-field text-xs py-1 w-20 text-right font-mono" />
                    <span className="text-xs font-mono text-terminal-muted">%</span>
                  </div>
                </div>
                <input type="range" min={0.1} max={10} step={0.1} value={Math.max(0.1, Math.min(10, params.riskPct || 0.1))}
                  onChange={e => set('riskPct', parseFloat(e.target.value))}
                  className="w-full accent-amber-400 h-1" />
                <div className="text-[10px] font-mono text-terminal-dim pt-0.5">
                  {fmtR(params.rPerPeriod || 0)} x {fmtPct((params.riskPct || 0) / 100)} risk = <span className="text-terminal-green">{fmtPct(rate)} per {unitW.one}</span>
                </div>
              </div>
            </>)}

            {/* Period unit */}
            <div className="flex justify-between items-center">
              <label className="text-xs font-mono text-terminal-muted">One period is a</label>
              <select value={params.unit} onChange={e => set('unit', e.target.value)}
                className="input-field text-xs py-1 w-28 font-mono">
                <option value="trade">trade</option>
                <option value="day">day</option>
                <option value="week">week</option>
                <option value="month">month</option>
              </select>
            </div>

            {/* Number of periods */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Number of {unitW.many}</label>
                <input type="number" min={1} max={5000} step={1} value={params.periods}
                  onChange={e => set('periods', Math.max(1, Math.min(5000, parseInt(e.target.value) || 1)))}
                  className="input-field text-xs py-1 w-20 text-right font-mono" />
              </div>
              <input type="range" min={1} max={520} step={1} value={Math.min(520, params.periods || 1)}
                onChange={e => set('periods', parseInt(e.target.value))}
                className="w-full accent-terminal-green h-1" />
            </div>

            {/* Contribution */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Add or withdraw each {unitW.one} ($)</label>
                <input type="number" step={10} value={params.contribution}
                  onChange={e => set('contribution', parseFloat(e.target.value) || 0)}
                  className="input-field text-xs py-1 w-24 text-right font-mono" />
              </div>
              <input type="range" min={-5000} max={5000} step={50} value={Math.max(-5000, Math.min(5000, params.contribution || 0))}
                onChange={e => set('contribution', parseFloat(e.target.value))}
                className={`w-full h-1 ${(params.contribution || 0) >= 0 ? 'accent-terminal-green' : 'accent-red-500'}`} />
              <div className="text-[10px] font-mono text-terminal-dim">
                Positive adds money, negative takes it out. Applied after each {unitW.one}'s growth.
              </div>
            </div>

            {/* Target */}
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <label className="text-xs font-mono text-terminal-muted">Target balance ($, optional)</label>
                <input type="number" min={0} step={1000} value={params.targetBal ?? ''}
                  placeholder="none"
                  onChange={e => {
                    const v = e.target.value;
                    set('targetBal', v === '' ? null : Math.max(0, parseFloat(v) || 0));
                  }}
                  className="input-field text-xs py-1 w-28 text-right font-mono" />
              </div>
              <input type="range" min={1000} max={1000000} step={1000} value={Math.max(1000, Math.min(1000000, params.targetBal || 1000))}
                onChange={e => set('targetBal', parseFloat(e.target.value))}
                className="w-full accent-amber-400 h-1" />
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-terminal-dim">Shown as a dashed line on the chart.</span>
                {hasTarget && (
                  <button onClick={() => set('targetBal', null)}
                    className="text-[10px] font-mono px-2 py-0.5 rounded border border-terminal-border text-terminal-dim hover:border-terminal-green hover:text-terminal-green transition-colors">
                    Clear
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── RIGHT: Headline, chart, solvers, table ─────────────────────── */}
        <div className="space-y-4">

          {/* Headline card */}
          <div className="card p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Ending balance after {unitCount(periods, params.unit)}</div>
                <div className="text-3xl font-mono font-bold text-terminal-green">{fmtMoney(sim.end)}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Total gain from growth</div>
                <div className={`text-3xl font-mono font-bold ${totalGain >= 0 ? 'text-terminal-text' : 'text-terminal-red'}`}>
                  {totalGain >= 0 ? '+' : ''}{fmtMoney(totalGain)}
                </div>
              </div>
            </div>
            <div className="text-xs font-mono text-terminal-muted">
              {fmtMoney(params.startBal)} {totalGain >= 0 ? 'grew' : 'shrank'} by {fmtMoney(Math.abs(totalGain))} over {unitCount(periods, params.unit)} at {fmtPct(rate)} {unitW.per}
              {totalContrib > 0 ? `, and you added ${fmtMoney(totalContrib)} along the way` : ''}
              {totalContrib < 0 ? `, and you withdrew ${fmtMoney(Math.abs(totalContrib))} along the way` : ''}
              . You end with {(params.startBal || 0) > 0 ? fmtPct(Math.abs(sim.end - params.startBal) / params.startBal) : '-'} {sim.end >= (params.startBal || 0) ? 'more' : 'less'} than you started with.
            </div>
            {sim.emptyAt != null && (
              <div className="text-xs font-mono text-red-400">
                The account is empty by {unitW.one} {sim.emptyAt}. Withdrawals are bigger than what the balance can carry.
              </div>
            )}
            {hasTarget && hitTargetAt != null && (
              <div className="text-xs font-mono text-terminal-green">
                Target of {fmtMoney(params.targetBal)} reached in {unitW.one} {hitTargetAt}.
              </div>
            )}
            {hasTarget && hitTargetAt == null && params.targetBal > (params.startBal || 0) && (
              <div className="text-xs font-mono text-amber-400">
                Target of {fmtMoney(params.targetBal)} is not reached within {unitCount(periods, params.unit)}. Still {fmtMoney(params.targetBal - sim.end)} short.
              </div>
            )}
          </div>

          {/* Chart */}
          <div className="card p-4">
            <div className="stat-label mb-3">Balance over {unitW.many}</div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
                <XAxis dataKey="n" tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' }} minTickGap={30} />
                <YAxis tickFormatter={v => fmtShort(v)} tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' }} width={55} domain={[0, 'auto']} />
                <Tooltip content={<BalanceTooltip unit={params.unit} />} />
                {hasTarget && (
                  <ReferenceLine y={params.targetBal} stroke="#ffaa00" strokeWidth={1} strokeDasharray="4 2"
                    label={{ value: 'target ' + fmtShort(params.targetBal), fill: '#ffaa00', fontSize: 9, fontFamily: 'JetBrains Mono', position: 'insideTopRight' }} />
                )}
                <Line dataKey="balance" type="monotone" stroke="#00ff88" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <div className="text-[10px] font-mono text-terminal-dim mt-1">Across the bottom: {unitW.one} number. Up the side: balance in dollars.</div>
          </div>

          {/* Work it backwards */}
          <div className="card p-4 space-y-3">
            <div className="stat-label">Work it backwards</div>
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">How long at this rate</div>
              <div className="text-sm font-mono text-terminal-text">{periodsSentence}</div>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">What rate in {unitCount(periods, params.unit)}</div>
              <div className="text-sm font-mono text-terminal-text">{rateSentence}</div>
              {rateSentenceR && <div className="text-sm font-mono text-terminal-muted">{rateSentenceR}</div>}
            </div>
          </div>

          {/* Period table */}
          <div className="card overflow-hidden">
            <div className="grid grid-cols-[4rem_1fr_1fr_1fr_1fr] border-b border-terminal-border bg-terminal-surface">
              {[unitW.one.toUpperCase(), 'START', 'GAIN', 'ADD / WITHDRAW', 'END'].map(h => (
                <div key={h} className="px-3 py-2 text-[10px] font-mono text-terminal-dim">{h}</div>
              ))}
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: '380px' }}>
              {sim.rows.map(r => {
                const isTargetRow = hitTargetAt === r.n;
                return (
                  <div key={r.n}
                    className={`grid grid-cols-[4rem_1fr_1fr_1fr_1fr] border-b border-terminal-border/40 last:border-0 transition-colors ${
                      isTargetRow ? 'bg-terminal-green/10 border-l-2 border-l-terminal-green' : 'hover:bg-terminal-surface/60'
                    }`}>
                    <div className="px-3 py-2 text-xs font-mono text-terminal-dim">{r.n}</div>
                    <div className="px-3 py-2 text-xs font-mono text-terminal-text">{fmtMoney(r.before)}</div>
                    <div className={`px-3 py-2 text-xs font-mono font-semibold ${r.gain > 0 ? 'text-terminal-green' : r.gain < 0 ? 'text-terminal-red' : 'text-terminal-dim'}`}>
                      {r.gain > 0 ? '+' : ''}{fmtMoney(r.gain)}
                    </div>
                    <div className={`px-3 py-2 text-xs font-mono ${r.contribution > 0 ? 'text-terminal-green' : r.contribution < 0 ? 'text-red-400' : 'text-terminal-dim'}`}>
                      {r.contribution === 0 ? '-' : (r.contribution > 0 ? '+' : '') + fmtMoney(r.contribution)}
                    </div>
                    <div className={`px-3 py-2 text-xs font-mono font-semibold ${r.end === 0 ? 'text-terminal-red' : 'text-terminal-text'}`}>
                      {fmtMoney(r.end)}{r.end === 0 ? ' (empty)' : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
