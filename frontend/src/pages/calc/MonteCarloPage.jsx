import { useState, useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';

// ── Helpers ────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'calc_montecarlo_v1';

function fmt(n) {
  if (n == null || isNaN(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(2) + 'M';
  if (abs >= 1000)      return sign + '$' + (abs / 1000).toFixed(1) + 'k';
  return sign + '$' + abs.toFixed(0);
}

function fmtFull(n) {
  if (n == null || isNaN(n)) return '-';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function pctStr(n, d = 1) {
  if (n == null || isNaN(n)) return '-';
  return n.toFixed(d) + '%';
}

function newSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

function save(params) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(params)); } catch { /* ignore */ }
}

// ── Simulation ─────────────────────────────────────────────────────────────────
// SIM-START (everything between the markers is plain JS so a node script can run it as-is)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
  return sorted[idx];
}

function runSim(p) {
  const winRate  = Number(p.winRate)  || 0;
  const W        = Math.max(0, Number(p.avgWinR)  || 0);
  const L        = Math.max(0, Number(p.avgLossR) || 0);
  const riskPct  = Math.max(0, Number(p.riskPct)  || 0);
  const startBal = Math.max(0, Number(p.startBal) || 0);
  const N        = Math.max(1, Math.floor(Number(p.trades) || 1));
  const R        = Math.max(1, Math.floor(Number(p.runs)   || 1));
  const mode     = p.mode === 'fixed' ? 'fixed' : 'percent';
  const ruinPct  = Math.min(100, Math.max(0, Number(p.ruinPct) || 0));
  const rand     = mulberry32(Number(p.seed) >>> 0);

  const prob      = Math.min(1, Math.max(0, winRate / 100));
  const r         = riskPct / 100;
  const ruinLevel = startBal * (1 - ruinPct / 100);
  const cols      = N + 1;

  const bal      = new Float64Array(R * cols);
  const endings  = new Float64Array(R);
  const maxDD    = new Float64Array(R);
  const streaks  = new Float64Array(R);
  let ruined = 0, belowStart = 0;

  for (let run = 0; run < R; run++) {
    let b = startBal, peak = startBal, dd = 0, streak = 0, longest = 0, hit = false;
    const base = run * cols;
    bal[base] = b;
    for (let t = 1; t <= N; t++) {
      const risk = mode === 'percent' ? b * r : startBal * r;
      const win  = rand() < prob;
      b += win ? W * risk : -L * risk;
      if (b < 0) b = 0; // the account cannot go below empty
      if (win) streak = 0; else { streak++; if (streak > longest) longest = streak; }
      if (b > peak) peak = b;
      const d = peak > 0 ? (peak - b) / peak : 0;
      if (d > dd) dd = d;
      if (b <= ruinLevel) hit = true;
      bal[base + t] = b;
    }
    endings[run] = b;
    maxDD[run]   = dd * 100;
    streaks[run] = longest;
    if (hit) ruined++;
    if (b < startBal) belowStart++;
  }

  // Percentile paths: at each trade index, sort the balances across runs
  const col = new Float64Array(R);
  const curve = new Array(cols);
  for (let t = 0; t < cols; t++) {
    for (let run = 0; run < R; run++) col[run] = bal[run * cols + t];
    col.sort();
    curve[t] = {
      trade: t,
      p5:  pick(col, 0.05),
      p25: pick(col, 0.25),
      p50: pick(col, 0.50),
      p75: pick(col, 0.75),
      p95: pick(col, 0.95),
    };
  }

  const endSorted = Float64Array.from(endings).sort();
  const ddSorted  = Float64Array.from(maxDD).sort();
  const stSorted  = Float64Array.from(streaks).sort();

  // Histogram of ending balances in 20 buckets
  const BUCKETS = 20;
  const lo = endSorted[0];
  const hi = endSorted[endSorted.length - 1];
  const width = hi > lo ? (hi - lo) / BUCKETS : 1;
  const hist = [];
  for (let i = 0; i < BUCKETS; i++) {
    const from = lo + i * width;
    hist.push({ from, to: from + width, count: 0 });
  }
  for (let i = 0; i < endings.length; i++) {
    const idx = hi > lo ? Math.min(BUCKETS - 1, Math.floor((endings[i] - lo) / width)) : 0;
    hist[idx].count++;
  }

  return {
    runs: R, trades: N, startBal, ruinLevel,
    curve, hist,
    medianEnd: pick(endSorted, 0.5),
    p5End:     pick(endSorted, 0.05),
    p95End:    pick(endSorted, 0.95),
    minEnd: lo, maxEnd: hi,
    belowStartPct: (belowStart / R) * 100,
    ruinPct:       (ruined / R) * 100,
    ddMedian: pick(ddSorted, 0.5),
    dd95:     pick(ddSorted, 0.95),
    streakMedian: pick(stSorted, 0.5),
    streak95:     pick(stSorted, 0.95),
    expectancyR: prob * W - (1 - prob) * L,
  };
}
// SIM-END

// ── Defaults ───────────────────────────────────────────────────────────────────
const DEFAULTS = {
  winRate: 45, avgWinR: 2.0, avgLossR: 1.0, riskPct: 1.0, startBal: 2000,
  trades: 100, runs: 1000, mode: 'percent', ruinPct: 50, seed: 1,
};

const RUN_CHOICES = [200, 1000, 5000];

// ── Small UI pieces ────────────────────────────────────────────────────────────
function SliderRow({ label, value, onChange, min, max, step, unit, width = 'w-20', accent = 'accent-terminal-green' }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <label className="text-xs font-mono text-terminal-muted">{label}</label>
        <div className="flex items-center gap-1">
          <input type="number" min={min} max={max} step={step} value={value}
            onChange={e => { const v = parseFloat(e.target.value); onChange(isNaN(v) ? min : Math.min(max, Math.max(min, v))); }}
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

const TICK = { fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' };
const TOOLTIP_STYLE = { backgroundColor: '#111', border: '1px solid #222', borderRadius: 4, fontFamily: 'JetBrains Mono', fontSize: 11 };

function CurveTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE} className="p-2 space-y-0.5">
      <div className="text-terminal-dim">After trade {label}</div>
      <div className="text-amber-400">Lucky (top 5%): {fmtFull(row.p95)}</div>
      <div className="text-terminal-green">Upper quarter: {fmtFull(row.p75)}</div>
      <div className="text-terminal-text font-bold">Middle run: {fmtFull(row.p50)}</div>
      <div className="text-terminal-green">Lower quarter: {fmtFull(row.p25)}</div>
      <div className="text-red-400">Unlucky (bottom 5%): {fmtFull(row.p5)}</div>
    </div>
  );
}

function HistTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE} className="p-2 space-y-0.5">
      <div className="text-terminal-dim">Ending between {fmtFull(row.from)} and {fmtFull(row.to)}</div>
      <div className="text-terminal-text font-bold">{row.count} runs ({row.pct.toFixed(1)}% of all runs)</div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function MonteCarloPage() {
  const [params, setParams] = useState(() => {
    const saved = loadSaved();
    const merged = { ...DEFAULTS, ...(saved || {}) };
    if (!saved || saved.seed == null) merged.seed = newSeed();
    return merged;
  });
  const [result, setResult]       = useState(null);
  const [computing, setComputing] = useState(true);
  const timer = useRef(null);

  const set = (k, v) => setParams(p => ({ ...p, [k]: v }));

  // Persist on every change
  useEffect(() => { save(params); }, [params]);

  // Recompute with a 200 ms debounce
  useEffect(() => {
    setComputing(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // let the "computing" state paint before the heavy loop
      requestAnimationFrame(() => {
        try { setResult(runSim(params)); } catch { setResult(null); }
        setComputing(false);
      });
    }, 200);
    return () => clearTimeout(timer.current);
  }, [params]);

  const r = result;
  const ruinBal = params.startBal * (1 - params.ruinPct / 100);
  const histData = r ? r.hist.map(h => ({ ...h, label: fmt(h.from), pct: (h.count / r.runs) * 100 })) : [];
  const edgeR = (params.winRate / 100) * params.avgWinR - (1 - params.winRate / 100) * params.avgLossR;
  const riskDollarsFixed = params.startBal * params.riskPct / 100;

  return (
    <div className="p-6 space-y-5">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Monte Carlo</div>
          <div className="text-sm font-mono text-terminal-text mt-1">
            Shuffle your stats over the next {params.trades} trades, many times, to see what luck can do to you.
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Seed</div>
            <div className="text-xs font-mono text-terminal-muted">{params.seed}</div>
          </div>
          <button onClick={() => set('seed', newSeed())}
            className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${computing ? 'animate-spin' : ''}`} /> Re-run with new luck
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[300px_1fr] gap-6 items-start">

        {/* ── LEFT: Inputs ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="card p-4 space-y-4">
            <div className="stat-label">Your Stats</div>

            <SliderRow label="Win rate" value={params.winRate} onChange={v => set('winRate', v)}
              min={1} max={99} step={1} unit="%" width="w-16"
              accent={params.winRate >= 50 ? 'accent-terminal-green' : 'accent-red-500'} />
            <SliderRow label="Average win (R)" value={params.avgWinR} onChange={v => set('avgWinR', v)}
              min={0.1} max={10} step={0.1} unit="R" width="w-16" accent="accent-amber-400" />
            <SliderRow label="Average loss (R)" value={params.avgLossR} onChange={v => set('avgLossR', v)}
              min={0.1} max={5} step={0.1} unit="R" width="w-16" accent="accent-red-400" />
            <div className="text-[10px] font-mono text-terminal-dim leading-relaxed">
              R is one unit of risk. A 2R win makes twice what you risked; a 1R loss loses exactly what you risked.
              At these numbers you make {edgeR.toFixed(2)}R per trade on average
              {edgeR <= 0 && <span className="text-red-400"> (no edge, this loses money over time)</span>}.
            </div>

            <SliderRow label="Risk per trade" value={params.riskPct} onChange={v => set('riskPct', v)}
              min={0.1} max={25} step={0.1} unit="%" width="w-16" />
            <SliderRow label="Starting balance ($)" value={params.startBal} onChange={v => set('startBal', v)}
              min={100} max={500000} step={100} width="w-24" />
            <SliderRow label="Number of trades" value={params.trades} onChange={v => set('trades', Math.round(v))}
              min={20} max={500} step={1} width="w-16" />
          </div>

          <div className="card p-4 space-y-4">
            <div className="stat-label">How To Size</div>

            {/* Sizing mode */}
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-terminal-muted">Risk is taken as</label>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { id: 'percent', label: 'Percent of current balance' },
                  { id: 'fixed',   label: 'Fixed dollars from the start' },
                ].map(m => (
                  <button key={m.id} onClick={() => set('mode', m.id)}
                    className={`text-[10px] font-mono px-2 py-1.5 rounded border transition-colors text-center leading-tight ${
                      params.mode === m.id
                        ? 'bg-terminal-green/10 border-terminal-green/50 text-terminal-green'
                        : 'border-terminal-border text-terminal-dim hover:border-terminal-green/40'
                    }`}>
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="text-[10px] font-mono text-terminal-dim leading-relaxed">
                {params.mode === 'percent'
                  ? `Each trade risks ${params.riskPct}% of whatever the balance is right then, so wins and losses compound.`
                  : `Each trade risks ${fmtFull(riskDollarsFixed)} (${params.riskPct}% of the ${fmtFull(params.startBal)} start) no matter what the balance is.`}
              </div>
            </div>

            {/* Runs */}
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-terminal-muted">Number of runs</label>
              <div className="grid grid-cols-3 gap-1.5">
                {RUN_CHOICES.map(n => (
                  <button key={n} onClick={() => set('runs', n)}
                    className={`text-xs font-mono px-2 py-1.5 rounded border transition-colors ${
                      params.runs === n
                        ? 'bg-terminal-green/10 border-terminal-green/50 text-terminal-green'
                        : 'border-terminal-border text-terminal-dim hover:border-terminal-green/40'
                    }`}>
                    {n.toLocaleString()}
                  </button>
                ))}
              </div>
              <div className="text-[10px] font-mono text-terminal-dim leading-relaxed">
                Each run is one possible future of {params.trades} trades. More runs give steadier percentages.
              </div>
            </div>

            {/* Ruin line */}
            <SliderRow label="Ruin line" value={params.ruinPct} onChange={v => set('ruinPct', v)}
              min={5} max={95} step={5} unit="%" width="w-16" accent="accent-red-400" />
            <div className="text-[10px] font-mono text-terminal-dim leading-relaxed">
              Call it ruin if the account is ever down this much from the start, so at or below {fmtFull(ruinBal)}.
            </div>
          </div>
        </div>

        {/* ── RIGHT: Results ─────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Headline stats */}
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="stat-label">What The Runs Say</div>
              <span className={`text-[10px] font-mono uppercase tracking-widest ${computing ? 'text-amber-400' : 'text-terminal-dim'}`}>
                {computing ? 'computing' : `${(r?.runs ?? params.runs).toLocaleString()} runs of ${r?.trades ?? params.trades} trades`}
              </span>
            </div>

            {!r ? (
              <div className="py-8 text-center text-terminal-muted font-mono text-sm">Running the first batch...</div>
            ) : (
              <div className={`space-y-3 transition-opacity ${computing ? 'opacity-50' : 'opacity-100'}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Median ending balance</div>
                    <div className={`text-3xl font-mono font-bold ${r.medianEnd >= r.startBal ? 'text-terminal-green' : 'text-terminal-red'}`}>{fmtFull(r.medianEnd)}</div>
                    <div className="text-xs font-mono text-terminal-dim mt-0.5">
                      Half the runs ended above this, half below. You started with {fmtFull(r.startBal)}.
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Chance of ruin</div>
                    <div className={`text-3xl font-mono font-bold ${r.ruinPct > 5 ? 'text-terminal-red' : 'text-terminal-text'}`}>{pctStr(r.ruinPct)}</div>
                    <div className="text-xs font-mono text-terminal-dim mt-0.5">of runs touched the {params.ruinPct}% ruin line</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: 'Unlucky ending (bottom 5%)', value: fmtFull(r.p5End),   tone: r.p5End  >= r.startBal ? 'text-terminal-green' : 'text-red-400' },
                    { label: 'Lucky ending (top 5%)',      value: fmtFull(r.p95End),  tone: 'text-terminal-green' },
                    { label: 'Ended below the start',      value: pctStr(r.belowStartPct), tone: r.belowStartPct > 50 ? 'text-red-400' : 'text-terminal-text' },
                    { label: 'Typical worst drawdown',     value: pctStr(r.ddMedian), tone: 'text-amber-400' },
                  ].map(s => (
                    <div key={s.label} className="bg-terminal-surface rounded p-2">
                      <div className="text-[10px] font-mono text-terminal-dim uppercase">{s.label}</div>
                      <div className={`text-sm font-mono font-bold mt-0.5 ${s.tone}`}>{s.value}</div>
                    </div>
                  ))}
                </div>

                <div className="space-y-1.5 text-xs font-mono text-terminal-text leading-relaxed border-t border-terminal-border/40 pt-3">
                  <div>
                    Nine runs in ten ended between <span className="text-red-400 font-semibold">{fmtFull(r.p5End)}</span> and <span className="text-terminal-green font-semibold">{fmtFull(r.p95End)}</span>. One in twenty did worse, one in twenty did better.
                  </div>
                  <div>
                    <span className="font-semibold">{pctStr(r.belowStartPct)}</span> of runs ended below the {fmtFull(r.startBal)} you started with, and <span className={`font-semibold ${r.ruinPct > 5 ? 'text-red-400' : ''}`}>{pctStr(r.ruinPct)}</span> hit the ruin line at {fmtFull(r.ruinLevel)}.
                  </div>
                  <div>
                    The typical run saw a worst drawdown of <span className="text-amber-400 font-semibold">{pctStr(r.ddMedian)}</span>. One run in twenty saw a drawdown of <span className="text-red-400 font-semibold">{pctStr(r.dd95)}</span> or worse.
                    <span className="text-terminal-dim"> Drawdown is how far the balance fell from its highest point so far.</span>
                  </div>
                  <div>
                    The typical run had a losing streak of <span className="font-semibold">{r.streakMedian} trades</span> in a row. One run in twenty had a streak of <span className="text-red-400 font-semibold">{r.streak95} losses</span> or longer. Expect that streak; it is normal luck, not a broken system.
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Percentile paths */}
          <div className="card p-4 space-y-2">
            <div className="stat-label">Balance Over The Trades</div>
            <div className="text-[10px] font-mono text-terminal-dim">
              Five paths, from unlucky to lucky. The bold green line is the middle run; the dashed lines are the bottom 5% and top 5% at each trade.
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={r ? r.curve : []} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
                <XAxis dataKey="trade" tick={TICK} interval={Math.max(0, Math.floor((r?.trades ?? params.trades) / 10) - 1)} />
                <YAxis tickFormatter={v => fmt(v)} tick={TICK} width={55} domain={['auto', 'auto']} />
                <Tooltip content={<CurveTooltip />} />
                <ReferenceLine y={params.startBal} stroke="#444" strokeDasharray="4 4" />
                <ReferenceLine y={ruinBal} stroke="#ff4444" strokeDasharray="2 4" strokeOpacity={0.6} />
                <Line type="monotone" dataKey="p95" stroke="#ffaa00" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="p75" stroke="#00ff88" strokeWidth={1} strokeOpacity={0.5} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="p50" stroke="#00ff88" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="p25" stroke="#00ff88" strokeWidth={1} strokeOpacity={0.5} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="p5"  stroke="#ff4444" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-terminal-dim">
              <span><span className="text-amber-400">- - -</span> top 5% (lucky)</span>
              <span><span className="text-terminal-green/60">───</span> upper and lower quarter</span>
              <span><span className="text-terminal-green font-bold">━━━</span> middle run</span>
              <span><span className="text-red-400">- - -</span> bottom 5% (unlucky)</span>
              <span><span className="text-terminal-muted">- - -</span> start {fmt(params.startBal)}</span>
              <span><span className="text-red-400/60">· · ·</span> ruin line {fmt(ruinBal)}</span>
            </div>
          </div>

          {/* Histogram */}
          <div className="card p-4 space-y-2">
            <div className="stat-label">Where The Runs Ended</div>
            <div className="text-[10px] font-mono text-terminal-dim">
              How many runs finished in each balance range. Red bars ended below your {fmtFull(params.startBal)} start, green bars above it.
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={histData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
                <XAxis dataKey="label" tick={TICK} interval={3} />
                <YAxis tick={TICK} width={40} allowDecimals={false} />
                <Tooltip content={<HistTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="count" isAnimationActive={false}>
                  {histData.map((h, i) => (
                    <Cell key={i} fill={h.to <= params.startBal ? '#ff4444' : h.from >= params.startBal ? '#00ff88' : '#ffaa00'} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {r && (
              <div className="text-[10px] font-mono text-terminal-dim">
                Endings ranged from {fmtFull(r.minEnd)} to {fmtFull(r.maxEnd)} across {r.runs.toLocaleString()} runs. An amber bar straddles the starting balance.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
