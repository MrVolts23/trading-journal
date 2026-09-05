import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

// ── Storage ────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'calc_expectancy_v1';

const DEFAULTS = {
  winRate: 45,       // percent
  avgWinR: 2.0,      // R
  avgLossR: 1.0,     // R
  riskPct: 1.0,      // percent of account per trade
  startBal: 2000,    // dollars
  tradesPerWeek: 10,
};

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      const v = parseFloat(parsed?.[k]);
      if (Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveInputs(inputs) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs)); } catch { /* storage unavailable, ignore */ }
}

// ── Formatting ─────────────────────────────────────────────────────────────────
function fmtMoney(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtSignedMoney(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return '-';
  return (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toFixed(digits) + '%';
}
function fmtR(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '-';
  return (n >= 0 ? '+' : '') + n.toFixed(digits) + 'R';
}

// ── Math ───────────────────────────────────────────────────────────────────────
// MATH-START (pure functions, no React; the node spot-check script extracts this block)
// Expected log growth per trade when risking fraction f of the account.
// Returns null when a single loss at that size would wipe the account.
function growthPerTrade(p, W, L, f) {
  if (f <= 0) return 0;
  if (1 - f * L <= 0) return null;
  const q = 1 - p;
  return p * Math.log(1 + f * W) + q * Math.log(1 - f * L);
}

function computeStats({ winRate, avgWinR, avgLossR, riskPct, startBal, tradesPerWeek }) {
  const p = Math.min(0.99, Math.max(0.01, winRate / 100));
  const q = 1 - p;
  const W = Math.max(0.01, avgWinR);
  const L = Math.max(0.01, avgLossR);
  const b = W / L;
  const expectancyR = p * W - q * L;
  const breakevenWinRate = L / (W + L);          // fraction
  const kelly = p - q / b;                       // fraction of account
  const hasEdge = kelly > 0;
  const kellyPct = hasEdge ? kelly * 100 : 0;
  const halfKellyPct = kellyPct / 2;
  const quarterKellyPct = kellyPct / 4;
  const f = riskPct / 100;

  let verdict;
  if (!hasEdge) verdict = 'no edge';
  else if (riskPct < quarterKellyPct) verdict = 'conservative';
  else if (riskPct < halfKellyPct) verdict = 'measured';
  else if (riskPct <= kellyPct) verdict = 'aggressive';
  else verdict = 'over the edge';

  const growthCurrent = growthPerTrade(p, W, L, f);
  const growthHalf = hasEdge ? growthPerTrade(p, W, L, halfKellyPct / 100) : 0;

  const dollarsPerTrade = expectancyR * f * startBal;
  const dollarsPerWeek = dollarsPerTrade * tradesPerWeek;
  const dollarsPerMonth = dollarsPerWeek * 4.33;

  return {
    p, q, W, L, b,
    expectancyR, breakevenWinRate,
    kelly, hasEdge, kellyPct, halfKellyPct, quarterKellyPct,
    verdict, growthCurrent, growthHalf,
    dollarsPerTrade, dollarsPerWeek, dollarsPerMonth,
  };
}

// Win-rate sensitivity: -15 to +15 points around the input in 5-point steps.
function sensitivityRows(winRate, avgWinR, avgLossR) {
  const rows = [];
  for (let d = -15; d <= 15; d += 5) {
    const wr = winRate + d;
    if (wr < 1 || wr > 99) continue;
    const p = wr / 100, q = 1 - p;
    const W = Math.max(0.01, avgWinR), L = Math.max(0.01, avgLossR);
    const expectancyR = p * W - q * L;
    const kelly = p - q / (W / L);
    rows.push({ delta: d, winRate: wr, expectancyR, kellyPct: kelly > 0 ? kelly * 100 : null });
  }
  return rows;
}
// MATH-END

// ── Small UI pieces ────────────────────────────────────────────────────────────
function SliderInput({ label, value, onChange, min, max, step, unit, width = 'w-20', accent = 'accent-terminal-green', digits }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <label className="text-xs font-mono text-terminal-muted">{label}</label>
        <div className="flex items-center gap-1">
          <input type="number" min={min} max={max} step={step} value={value}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
            }}
            className={`input-field text-xs py-1 ${width} text-right font-mono`} />
          {unit && <span className="text-xs font-mono text-terminal-muted">{unit}</span>}
        </div>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className={`w-full ${accent} h-1`} />
    </div>
  );
}

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-terminal-card border border-terminal-border rounded px-3 py-2 text-[11px] font-mono">
      <div className="text-terminal-muted">Risk {d.riskPct.toFixed(2)}% per trade</div>
      <div className={d.growth >= 0 ? 'text-terminal-green' : 'text-terminal-red'}>
        Growth {d.growth == null ? 'wipes out' : fmtPct(d.growth, 3)} per trade
      </div>
    </div>
  );
}

const VERDICT_STYLE = {
  'no edge':       { text: 'text-terminal-red',   line: 'No edge at these numbers, Kelly says risk nothing.' },
  'conservative':  { text: 'text-terminal-blue',  line: 'Conservative. You are risking less than a quarter of Kelly.' },
  'measured':      { text: 'text-terminal-green', line: 'Measured. You are between a quarter and half of Kelly.' },
  'aggressive':    { text: 'text-amber-400',      line: 'Aggressive. You are between half and full Kelly.' },
  'over the edge': { text: 'text-terminal-red',   line: 'Over the edge, drawdowns will be brutal. You are risking more than full Kelly.' },
};

// ── Page ───────────────────────────────────────────────────────────────────────
export default function ExpectancyPage() {
  const [inputs, setInputs] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setInputs(loadSaved());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) saveInputs(inputs);
  }, [inputs, loaded]);

  const set = (k, v) => setInputs(prev => ({ ...prev, [k]: v }));

  const s = useMemo(() => computeStats(inputs), [inputs]);
  const rows = useMemo(() => sensitivityRows(inputs.winRate, inputs.avgWinR, inputs.avgLossR), [inputs.winRate, inputs.avgWinR, inputs.avgLossR]);

  // Growth curve: risk 0% up to a bit past full Kelly (or 10% when there is no edge)
  const curve = useMemo(() => {
    const maxRisk = Math.max(2, s.hasEdge ? s.kellyPct * 1.6 : 10, inputs.riskPct * 1.2);
    const steps = 80;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const riskPct = (maxRisk * i) / steps;
      const g = growthPerTrade(s.p, s.W, s.L, riskPct / 100);
      pts.push({ riskPct, growth: g == null ? null : g * 100 });
    }
    return pts;
  }, [s, inputs.riskPct]);

  const verdict = VERDICT_STYLE[s.verdict];
  const breakevenPct = s.breakevenWinRate * 100;
  const winsPerWeek = inputs.tradesPerWeek * s.p;

  return (
    <div className="p-6 space-y-5">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Expectancy &amp; Kelly</div>
          <div className="text-sm font-mono text-terminal-text mt-0.5">
            Whether your numbers make money, and how much to risk on each trade.
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Expectancy per trade</div>
          <div className={`text-2xl font-mono font-bold ${s.expectancyR >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
            {fmtR(s.expectancyR)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[300px_1fr] gap-6 items-start">

        {/* ── LEFT: Inputs ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="card p-4 space-y-4">
            <div className="stat-label">Your numbers</div>

            <SliderInput label="Win rate" value={inputs.winRate} onChange={v => set('winRate', v)}
              min={1} max={99} step={1} unit="%" width="w-14"
              accent={inputs.winRate >= breakevenPct ? 'accent-terminal-green' : 'accent-red-500'} />

            <SliderInput label="Average win (R)" value={inputs.avgWinR} onChange={v => set('avgWinR', v)}
              min={0.1} max={10} step={0.1} unit="R" width="w-16" />

            <SliderInput label="Average loss (R)" value={inputs.avgLossR} onChange={v => set('avgLossR', v)}
              min={0.1} max={5} step={0.1} unit="R" width="w-16" accent="accent-red-400" />

            <SliderInput label="Current risk per trade" value={inputs.riskPct} onChange={v => set('riskPct', v)}
              min={0.1} max={25} step={0.1} unit="%" width="w-16" accent="accent-amber-400" />

            <SliderInput label="Starting balance ($)" value={inputs.startBal} onChange={v => set('startBal', v)}
              min={100} max={500000} step={100} width="w-28" />

            <SliderInput label="Trades per week" value={inputs.tradesPerWeek} onChange={v => set('tradesPerWeek', v)}
              min={1} max={100} step={1} width="w-16" />

            <div className="text-[10px] font-mono text-terminal-dim leading-relaxed pt-1 border-t border-terminal-border/40">
              R means one unit of risk. If you risk $20 on a trade, a 2R win is $40 and a 1R loss is $20.
            </div>
          </div>
        </div>

        {/* ── RIGHT: Results ─────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Headline: expectancy + breakeven */}
          <div className="card p-4 space-y-3">
            <div className="stat-label">Does this make money</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-terminal-surface rounded p-3">
                <div className="text-[10px] font-mono text-terminal-dim uppercase">Expectancy per trade</div>
                <div className={`text-2xl font-mono font-bold mt-0.5 ${s.expectancyR >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                  {fmtR(s.expectancyR)}
                </div>
                <div className="text-[11px] font-mono text-terminal-muted mt-1 leading-relaxed">
                  On average each trade {s.expectancyR >= 0 ? 'makes' : 'loses'} {Math.abs(s.expectancyR).toFixed(2)}R.
                  That is {fmtPct(s.p * 100, 0)} of the time winning {s.W.toFixed(2)}R, minus {fmtPct(s.q * 100, 0)} of the time losing {s.L.toFixed(2)}R.
                </div>
              </div>
              <div className="bg-terminal-surface rounded p-3">
                <div className="text-[10px] font-mono text-terminal-dim uppercase">Breakeven win rate</div>
                <div className="text-2xl font-mono font-bold mt-0.5 text-terminal-text">{fmtPct(breakevenPct, 1)}</div>
                <div className="text-[11px] font-mono text-terminal-muted mt-1 leading-relaxed">
                  With {s.W.toFixed(2)}R wins and {s.L.toFixed(2)}R losses you need to win at least {fmtPct(breakevenPct, 1)} of trades just to break even.
                  You are at {fmtPct(inputs.winRate, 0)}, which is {Math.abs(inputs.winRate - breakevenPct).toFixed(1)} points {inputs.winRate >= breakevenPct ? 'above' : 'below'} that line.
                </div>
              </div>
            </div>
          </div>

          {/* Kelly */}
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="stat-label">How much to risk (Kelly)</div>
              <span className="text-[10px] font-mono text-terminal-dim">Kelly = the risk size that grows the account fastest over many trades</span>
            </div>

            {s.hasEdge ? (
              <>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'Full Kelly',    value: s.kellyPct,        color: 'text-terminal-red' },
                    { label: 'Half Kelly',    value: s.halfKellyPct,    color: 'text-amber-400' },
                    { label: 'Quarter Kelly', value: s.quarterKellyPct, color: 'text-terminal-green' },
                    { label: 'Your risk',     value: inputs.riskPct,    color: verdict.text, highlight: true },
                  ].map(k => (
                    <div key={k.label} className={`rounded p-2 text-center ${k.highlight ? 'bg-terminal-surface border border-terminal-border' : 'bg-terminal-surface'}`}>
                      <div className="text-[10px] font-mono text-terminal-dim uppercase">{k.label}</div>
                      <div className={`text-lg font-mono font-bold mt-0.5 ${k.color}`}>{fmtPct(k.value, 2)}</div>
                      <div className="text-[10px] font-mono text-terminal-dim">of account per trade</div>
                    </div>
                  ))}
                </div>
                <div className={`text-sm font-mono font-semibold ${verdict.text}`}>{verdict.line}</div>
                <div className="text-[11px] font-mono text-terminal-muted leading-relaxed">
                  Full Kelly is {fmtPct(s.p * 100, 0)} minus {fmtPct(s.q * 100, 0)} divided by {s.b.toFixed(2)} (your average win divided by your average loss), which comes to {fmtPct(s.kellyPct, 2)} of the account.
                  Most traders sit at half or a quarter of that, because full Kelly assumes your stats are exact and it swings hard when they are not.
                </div>
              </>
            ) : (
              <div className="text-sm font-mono font-semibold text-terminal-red">
                No edge at these numbers, Kelly says risk nothing. Win rate {fmtPct(inputs.winRate, 0)} is below the {fmtPct(breakevenPct, 1)} breakeven.
              </div>
            )}
          </div>

          {/* Growth per trade */}
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="stat-label">Expected growth per trade</div>
              <span className="text-[10px] font-mono text-terminal-dim">how fast the account compounds at a given risk size, averaged over many trades</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-terminal-surface rounded p-3">
                <div className="text-[10px] font-mono text-terminal-dim uppercase">At your risk of {fmtPct(inputs.riskPct, 2)}</div>
                <div className={`text-xl font-mono font-bold mt-0.5 ${s.growthCurrent == null || s.growthCurrent < 0 ? 'text-terminal-red' : 'text-terminal-green'}`}>
                  {s.growthCurrent == null ? 'wipes out' : fmtPct(s.growthCurrent * 100, 3)}
                </div>
                <div className="text-[11px] font-mono text-terminal-muted mt-1">
                  {s.growthCurrent == null
                    ? 'A single loss at this size takes the whole account.'
                    : `The account grows about ${fmtPct(s.growthCurrent * 100, 3)} per trade on average.`}
                </div>
              </div>
              <div className="bg-terminal-surface rounded p-3">
                <div className="text-[10px] font-mono text-terminal-dim uppercase">At half Kelly of {fmtPct(s.halfKellyPct, 2)}</div>
                <div className={`text-xl font-mono font-bold mt-0.5 ${s.growthHalf > 0 ? 'text-terminal-green' : 'text-terminal-muted'}`}>
                  {s.hasEdge ? fmtPct(s.growthHalf * 100, 3) : 'none'}
                </div>
                <div className="text-[11px] font-mono text-terminal-muted mt-1">
                  {s.hasEdge ? `Half Kelly gets about three quarters of full Kelly growth with much smaller swings.` : 'No positive risk size exists without an edge.'}
                </div>
              </div>
            </div>

            <div className="pt-1">
              <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest mb-1">Growth per trade vs risk per trade</div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={curve} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
                  <XAxis dataKey="riskPct" type="number" domain={['dataMin', 'dataMax']}
                    tickFormatter={v => v.toFixed(1) + '%'}
                    tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                  <YAxis tickFormatter={v => v.toFixed(2) + '%'} width={55}
                    tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                  <Tooltip content={<ChartTooltip />} />
                  <ReferenceLine y={0} stroke="#333" strokeWidth={1} />
                  {s.hasEdge && <ReferenceLine x={s.kellyPct} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'full Kelly', fill: '#ef4444', fontSize: 9, fontFamily: 'JetBrains Mono', position: 'top' }} />}
                  {s.hasEdge && <ReferenceLine x={s.halfKellyPct} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: 'half', fill: '#f59e0b', fontSize: 9, fontFamily: 'JetBrains Mono', position: 'top' }} />}
                  <ReferenceLine x={inputs.riskPct} stroke="#22c55e" strokeWidth={1.5} label={{ value: 'you', fill: '#22c55e', fontSize: 9, fontFamily: 'JetBrains Mono', position: 'insideTopLeft' }} />
                  <Line type="monotone" dataKey="growth" stroke="#22c55e" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
              <div className="text-[10px] font-mono text-terminal-dim mt-1">
                The curve peaks at full Kelly. Past it, bigger risk grows the account slower, not faster, and below zero it shrinks.
              </div>
            </div>
          </div>

          {/* Dollars */}
          <div className="card p-4 space-y-3">
            <div className="stat-label">In dollars, at your current risk</div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Per trade', value: s.dollarsPerTrade, digits: 2 },
                { label: `Per week (${inputs.tradesPerWeek} trades)`, value: s.dollarsPerWeek, digits: 0 },
                { label: 'Per month (4.33 weeks)', value: s.dollarsPerMonth, digits: 0 },
              ].map(d => (
                <div key={d.label} className="bg-terminal-surface rounded p-2 text-center">
                  <div className="text-[10px] font-mono text-terminal-dim uppercase">{d.label}</div>
                  <div className={`text-lg font-mono font-bold mt-0.5 ${d.value >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>{fmtSignedMoney(d.value, d.digits)}</div>
                </div>
              ))}
            </div>
            <div className="text-[11px] font-mono text-terminal-muted leading-relaxed">
              Risking {fmtPct(inputs.riskPct, 2)} of {fmtMoney(inputs.startBal)} is {fmtMoney(inputs.startBal * inputs.riskPct / 100, 2)} per trade, so 1R is {fmtMoney(inputs.startBal * inputs.riskPct / 100, 2)}.
              Times {fmtR(s.expectancyR)} expectancy gives {fmtSignedMoney(s.dollarsPerTrade, 2)} per trade on average.
              At {inputs.tradesPerWeek} trades a week that is about {winsPerWeek.toFixed(1)} wins and {(inputs.tradesPerWeek - winsPerWeek).toFixed(1)} losses.
              These are flat numbers on the starting balance, not compounded.
            </div>
          </div>

          {/* Sensitivity table */}
          <div className="card overflow-hidden">
            <div className="p-4 pb-2">
              <div className="stat-label">What changes if your win rate moves</div>
              <div className="text-[11px] font-mono text-terminal-muted mt-1">
                Same {s.W.toFixed(2)}R wins and {s.L.toFixed(2)}R losses, win rate moved up and down in 5-point steps.
              </div>
            </div>
            <div className="grid grid-cols-[1fr_1fr_1fr_1fr] border-b border-t border-terminal-border bg-terminal-surface">
              {['WIN RATE', 'CHANGE', 'EXPECTANCY', 'FULL KELLY'].map(h => (
                <div key={h} className="px-3 py-2 text-[10px] font-mono text-terminal-dim">{h}</div>
              ))}
            </div>
            {rows.map(r => {
              const active = r.delta === 0;
              return (
                <div key={r.delta}
                  className={`grid grid-cols-[1fr_1fr_1fr_1fr] border-b border-terminal-border/40 last:border-0 ${
                    active ? 'bg-terminal-green/10 border-l-2 border-l-terminal-green' : ''
                  }`}>
                  <div className="px-3 py-2 text-xs font-mono text-terminal-text">{r.winRate}%</div>
                  <div className="px-3 py-2 text-xs font-mono text-terminal-dim">{r.delta === 0 ? 'now' : (r.delta > 0 ? '+' : '') + r.delta + ' points'}</div>
                  <div className={`px-3 py-2 text-xs font-mono font-semibold ${r.expectancyR >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                    {fmtR(r.expectancyR)} per trade
                  </div>
                  <div className={`px-3 py-2 text-xs font-mono font-semibold ${r.kellyPct == null ? 'text-terminal-red' : 'text-terminal-text'}`}>
                    {r.kellyPct == null ? 'no edge' : fmtPct(r.kellyPct, 2) + ' of account'}
                  </div>
                </div>
              );
            })}
          </div>

        </div>
      </div>
    </div>
  );
}
