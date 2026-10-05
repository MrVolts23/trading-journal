import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, ChevronDown, ChevronRight, Loader2, RefreshCw, Pencil, RotateCcw, AlertTriangle, Check } from 'lucide-react';
import { deskGetResults, deskGetResult, deskGetStatus, deskEdgeTest } from '../../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Results (/desk/results) — "Every test you've run, newest first, pass or fail and why."
// One card per test. Click a card to open it in place: $ equity curve, the gate table in
// English, the five stretches, weekly + monthly tables, first 200 trades.
// No raw engine parameter names are ever shown: every change renders through LABELS below.
// ─────────────────────────────────────────────────────────────────────────────

// ── formatting ───────────────────────────────────────────────────────────────
const EMPTY = '·'; // placeholder for a value the test did not produce (no dashes in copy)
const J = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const isNum = (v) => v != null && Number.isFinite(Number(v));
const num = (v, d = 2) => (isNum(v) ? Number(v).toFixed(d) : EMPTY);
const fmtR = (v) => (isNum(v) ? (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(2) + 'R' : EMPTY);
const fmtUsd = (v, d = 0) => (isNum(v) ? (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : EMPTY);
const fmtPct = (v) => (isNum(v) ? (Number(v) <= 1 ? Number(v) * 100 : Number(v)).toFixed(0) + '%' : EMPTY);
const rColor = (v) => (!isNum(v) ? 'text-terminal-dim' : Number(v) > 0 ? 'text-green-400' : Number(v) < 0 ? 'text-red-400' : 'text-terminal-muted');
const listOf = (d, ...keys) => { if (Array.isArray(d)) return d; for (const k of keys) if (Array.isArray(d?.[k])) return d[k]; return []; };

// Timestamps arrive as epoch seconds, epoch ms, or sqlite UTC text ("2026-09-03 21:54:38"). Show them in PT.
const PT = 'America/Los_Angeles';
function toDate(t) {
  if (t == null || t === '') return null;
  if (t instanceof Date) return t;
  if (isNum(t)) return new Date(Number(t) * (Number(t) < 1e11 ? 1000 : 1));
  const s = String(t).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}
const fmtDay = (t) => { const d = toDate(t); return d ? d.toLocaleDateString('en-US', { timeZone: PT, month: 'short', day: 'numeric' }) : EMPTY; };
const fmtWhen = (t) => { const d = toDate(t); return d ? d.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : EMPTY; };
const fmtTs = (t) => { const d = toDate(t); return d ? d.toLocaleString('en-US', { timeZone: PT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : EMPTY; };

// ── verdicts ─────────────────────────────────────────────────────────────────
// The verifier says PASS / REJECT / BLOCKED. Mike reads PASS / FAIL / CAN'T JUDGE.
const verdictWord = (v) => (v === 'PASS' ? 'PASS' : v === 'REJECT' || v === 'FAIL' ? 'FAIL' : v === 'BLOCKED' ? "CAN'T JUDGE" : v ? String(v) : 'NOT TESTED');
const verdictClass = (v) => (v === 'PASS' ? 'text-green-400 border-green-500/50 bg-green-500/5' : v === 'REJECT' || v === 'FAIL' ? 'text-red-400 border-red-500/50 bg-red-500/5' : v === 'BLOCKED' ? 'text-amber-400 border-amber-500/50 bg-amber-500/5' : 'text-terminal-dim border-terminal-border');

function VerdictBadge({ v, big }) {
  return (
    <span className={`inline-flex items-center rounded border font-mono font-semibold tracking-wide whitespace-nowrap ${big ? 'px-3 py-1 text-sm' : 'px-2 py-0.5 text-[11px]'} ${verdictClass(v)}`}>
      {verdictWord(v)}
    </span>
  );
}

// ── plain-English names for the things a test can change ────────────────────
// Lookup only: the key on the left is the engine's binding; the text on the right is what Mike sees.
const CHOICE_WORDS = {
  exitModel: { fixed_rr: 'take profit at a fixed target', trail_ltf: 'trail the stop behind confirmed swings', liquidity_v1: 'aim for the last liquidity point', liquidity_v2: 'exit on an opposite break after a liquidity pool is tapped', opposite_bos: 'exit on any opposite break', combo: 'target first, then trail' },
  armMode: { either: 'both kinds of pullback', sweep: 'only pullbacks that run the prior swing', retrace: 'only pullbacks that stop short of the prior swing' },
  trailMode: { pivot: 'entry-chart swings', htf_pivot: 'structure-chart swings', chandelier: 'ATR distance' },
};
const LABELS = {
  htf: ['Structure chart', 'min'], ltf: ['Entry chart', 'min'],
  pivotStrengthHtf: ['Structure swing strength', 'bars'], pivotStrengthLtf: ['Entry swing strength', 'bars'],
  armMode: ['Pullbacks taken'], armExpiryHtfBars: ['Setup stays live for', 'structure bars'],
  maxEntriesPerArm: ['Entries per setup'], maxConcurrent: ['Positions at once'],
  slPaddingUsd: ['Stop padding', '$'], maxSlUsd: ['Widest stop allowed', '$'],
  exitModel: ['Exit style'], rr: ['Fixed target', 'R'], trailPadUsd: ['Trail padding', '$'],
  liquidityLookbackDays: ['Liquidity lookback', 'days'], tpBufferUsd: ['Take profit before the level', '$'],
  trailActivateR: ['Start trailing after', 'R'], beAtR: ['Breakeven at', 'R'],
  requireSweep: ['Require a liquidity sweep'], addGateR: ['Add to a position only when up by', 'R'],
  useEmaExit: ['Exit at the 15-minute 50-EMA wall'], emaPeriod: ['EMA length'], emaProxUsd: ['How close to the EMA counts', '$'],
  emaMinProfitR: ['EMA exit only if up by', 'R'], emaOnlyWhenNoTerminal: ['EMA exit only when no liquidity target'],
  exitBosStrength: ['Swing strength for the opposite-break exit', 'bars'], trailMode: ['Trail behind'],
  trailPivotStrength: ['Trail swing strength', 'bars'], atrMult: ['ATR distance for chandelier trail', 'ATR'],
  minProfitRForOppExit: ['Opposite-break exit only if up by', 'R'], useOppBos: ['Also exit on an opposite break'],
  useTerminalTp: ['Use the terminal target'], spreadUsd: ['Spread', '$'], slippageUsd: ['Slippage', '$'], windows: ['Sessions'],
};
const humanize = (k) => String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
function changeLabel(key) { return (LABELS[key] || [humanize(key)])[0]; }
function changeValue(key, v) {
  if (v === null || v === undefined || v === '') return key === 'beAtR' ? 'never' : 'off';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  const words = CHOICE_WORDS[key];
  if (words && words[v]) return words[v];
  if (typeof v === 'object') return JSON.stringify(v);
  const unit = (LABELS[key] || [])[1];
  if (unit === '$') return '$' + Number(v).toFixed(2).replace(/\.00$/, '');
  if (unit === 'R') return `${v}R`;
  return unit ? `${v} ${unit}` : String(v);
}
// changes arrive as { key: newValue } or { key: { from, to } }
function changeSentences(changes) {
  const c = J(changes);
  if (!c || typeof c !== 'object') return [];
  return Object.entries(c).map(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && ('to' in v || 'from' in v)) {
      return `${changeLabel(k)}: ${changeValue(k, v.from)} → ${changeValue(k, v.to)}`;
    }
    return `${changeLabel(k)} set to ${changeValue(k, v)}`;
  });
}

// ── plain-English names for the gates ────────────────────────────────────────
const GATE_LABELS = {
  min_trades_total: 'Enough trades overall',
  min_trades_per_fold: 'Enough trades in every stretch',
  folds_positive_min: 'Profitable stretches of the data',
  min_profit_factor: 'Wins outweigh losses (profit factor)',
  max_dd_r: 'Drawdown stays inside the limit',
  bootstrap_p_positive: 'Edge beats luck',
  psr: 'Result is statistically solid',
  deflated_sharpe: 'Better than the best random try',
};
const PCT_GATES = new Set(['bootstrap_p_positive', 'psr']);
const gateLabel = (g) => g.label || GATE_LABELS[g.gate] || humanize(g.gate || '');
function gateValue(g, v) {
  if (v === 'inf' || v === Infinity) return 'no losses';
  if (!isNum(v)) return v == null ? EMPTY : String(v);
  if (PCT_GATES.has(g.gate)) return (Number(v) * 100).toFixed(0) + '%';
  if (g.gate === 'max_dd_r') return num(v, 2) + 'R';
  if (g.gate === 'folds_positive_min') return `${v} of 5`;
  if (g.gate === 'deflated_sharpe') return num(v, 2);
  return Number.isInteger(Number(v)) ? String(v) : num(v, 2);
}

// ── charts + tables ──────────────────────────────────────────────────────────
// $ equity from the API's equity array (balance after each closed trade); falls back to cumulative R from trades.
function EquityCurve({ equity, trades, startBalance, width = 720, height = 150 }) {
  const eq = listOf(equity);
  let pts, base, isUsd;
  if (eq.length && eq.some((e) => isNum(e.balance))) {
    isUsd = true;
    base = isNum(startBalance) ? Number(startBalance) : (isNum(eq[0]?.balance) ? Number(eq[0].balance) - Number(eq[0].pnl_usd || 0) : 0);
    pts = [base, ...eq.map((e) => Number(e.balance))];
  } else if (trades?.length) {
    const hasUsd = trades.some((t) => isNum(t.pnl_usd));
    isUsd = hasUsd && isNum(startBalance);
    base = isUsd ? Number(startBalance) : 0;
    let cum = base;
    pts = [base, ...trades.map((t) => (cum += Number((hasUsd ? t.pnl_usd : t.r) || 0)))];
  } else {
    return <div className="text-xs font-mono text-terminal-dim">No trades to draw.</div>;
  }
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const X = (i) => (i / Math.max(pts.length - 1, 1)) * (width - 8) + 4;
  const Y = (y) => height - 14 - ((y - min) / span) * (height - 28);
  const path = pts.map((y, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const up = last >= base;
  const stroke = up ? '#22c55e' : '#ef4444';
  const label = isUsd ? `${fmtUsd(last)} (${last - base >= 0 ? '+' : ''}${fmtUsd(last - base)})` : `${last.toFixed(1)}R`;
  return (
    <div>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block max-w-full" preserveAspectRatio="none">
        <line x1="4" x2={width - 4} y1={Y(base)} y2={Y(base)} stroke="#30363d" strokeDasharray="3,3" />
        <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" />
        <text x={width - 6} y={Math.max(Y(last) - 5, 10)} fill={stroke} fontSize="11" fontFamily="monospace" textAnchor="end">{label}</text>
      </svg>
      <div className="text-[11px] font-mono text-terminal-dim mt-1">
        {isUsd ? `Account balance after each trade, starting from ${fmtUsd(base)}.` : 'Running total in R. Trades carry no dollar sizing yet.'}
      </div>
    </div>
  );
}

function Th({ children, right }) { return <th className={`px-2 py-1.5 font-normal text-terminal-dim whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>{children}</th>; }
function Td({ children, className = '', right, wrap }) { return <td className={`px-2 py-1 ${wrap ? 'whitespace-normal' : 'whitespace-nowrap'} tabular-nums ${right ? 'text-right' : 'text-left'} ${className}`}>{children}</td>; }

function PeriodTable({ rows, unit }) {
  const list = listOf(J(rows), 'periods', 'rows', 'items');
  if (!list.length) return <div className="text-xs font-mono text-terminal-dim">No {unit}s in this test.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead><tr><Th>{unit === 'week' ? 'Week' : 'Month'}</Th><Th right>Trades</Th><Th right>Won / lost</Th><Th right>Net R</Th><Th right>Win %</Th><Th right>RR</Th><Th right>Net $</Th></tr></thead>
        <tbody>
          {list.map((p, i) => (
            <tr key={p.key ?? i} className="border-t border-terminal-border/60">
              <Td className="text-terminal-text">{p.key ?? p.label ?? i + 1}</Td>
              <Td right className="text-terminal-text">{p.trades ?? EMPTY}</Td>
              <Td right className="text-terminal-muted">{p.wins ?? EMPTY} / {p.losses ?? EMPTY}</Td>
              <Td right className={rColor(p.net_r)}>{fmtR(p.net_r)}</Td>
              <Td right className="text-terminal-text">{fmtPct(p.win_rate ?? p.winrate)}</Td>
              <Td right className="text-terminal-text">{isNum(p.rr) ? num(p.rr) : EMPTY}</Td>
              <Td right className={rColor(p.net_usd)}>{isNum(p.net_usd) ? fmtUsd(p.net_usd) : EMPTY}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StretchTable({ folds }) {
  const list = listOf(folds, 'folds', 'rows').map((f, i) => ({ ...f, ...(f.metrics && typeof f.metrics === 'object' ? f.metrics : {}), index: f.index ?? i + 1 }));
  if (!list.length) return <div className="text-xs font-mono text-terminal-dim">No stretches stored for this test.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead><tr><Th>Stretch</Th><Th>Dates</Th><Th right>Trades</Th><Th right>Net R</Th><Th right>PF</Th><Th right>Max DD</Th><Th>Positive</Th></tr></thead>
        <tbody>
          {list.map((f) => {
            const pos = f.positive != null ? !!f.positive : (Number(f.net_r) > 0 && Number(f.profit_factor ?? 0) > 1);
            return (
              <tr key={f.index} className="border-t border-terminal-border/60">
                <Td className="text-terminal-text">{f.index} of {list.length}</Td>
                <Td wrap className="text-terminal-muted">{fmtDay(f.from_t)} to {fmtDay(f.to_t)}</Td>
                <Td right className="text-terminal-text">{f.trades ?? EMPTY}</Td>
                <Td right className={rColor(f.net_r)}>{fmtR(f.net_r)}</Td>
                <Td right className="text-terminal-text">{isNum(f.profit_factor) ? num(f.profit_factor) : EMPTY}</Td>
                <Td right className="text-terminal-text">{isNum(f.max_dd_r) ? num(f.max_dd_r) + 'R' : EMPTY}</Td>
                <Td className={pos ? 'text-green-400' : 'text-red-400'}>{pos ? 'yes' : 'no'}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GateTable({ gates, empty }) {
  const list = listOf(gates);
  if (!list.length) return <div className="text-xs font-mono text-terminal-dim">{empty || 'No verdict stored for this test.'}</div>;
  return (
    <div className="overflow-x-auto"><table className="w-full text-xs font-mono">
      <thead><tr><Th>Check</Th><Th right>Result</Th><Th right>Needed</Th><Th>Pass</Th></tr></thead>
      <tbody>
        {list.map((g, i) => (
          <tr key={g.gate || i} className="border-t border-terminal-border/60">
            <Td wrap className="text-terminal-text">{gateLabel(g)}</Td>
            <Td right className="text-terminal-muted">{'needed' in g ? String(g.value) : gateValue(g, g.value)}</Td>
            <Td right wrap className="text-terminal-muted">{'needed' in g ? g.needed : gateValue(g, g.threshold)}</Td>
            <Td className={g.report_only ? 'text-terminal-dim' : g.pass === true ? 'text-green-400' : g.pass === false ? 'text-red-400' : 'text-terminal-dim'}>
              {g.report_only ? 'noted only' : g.pass === true ? 'pass' : g.pass === false ? 'fail' : EMPTY}
            </Td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

function TradeTable({ trades }) {
  const list = listOf(trades);
  if (!list.length) return <div className="text-xs font-mono text-terminal-dim">No trade list stored for this test.</div>;
  const shown = list.slice(0, 200);
  return (
    <div className="overflow-x-auto max-h-80 overflow-y-auto border border-terminal-border rounded">
      <table className="w-full text-[11px] font-mono">
        <thead className="sticky top-0 bg-terminal-surface"><tr>
          <Th>#</Th><Th>Entered</Th><Th>Side</Th><Th>Session</Th><Th right>Entry</Th><Th right>Stop</Th><Th right>Exit</Th><Th right>R</Th><Th right>Lots</Th><Th right>P&amp;L $</Th><Th>Closed by</Th>
        </tr></thead>
        <tbody>
          {shown.map((t, i) => (
            <tr key={i} className="border-t border-terminal-border/50">
              <Td className="text-terminal-dim">{i + 1}</Td>
              <Td className="text-terminal-muted">{fmtTs(t.entryT ?? t.entry_t ?? t.t)}</Td>
              <Td className={t.dir === 'bull' || t.dir === 'long' ? 'text-green-400' : 'text-red-400'}>{t.dir === 'bull' ? 'long' : t.dir === 'bear' ? 'short' : t.dir ?? EMPTY}</Td>
              <Td className="text-terminal-muted">{t.session ?? EMPTY}</Td>
              <Td right className="text-terminal-text">{num(t.entry)}</Td>
              <Td right className="text-terminal-text">{num(t.sl)}</Td>
              <Td right className="text-terminal-text">{num(t.exit)}</Td>
              <Td right className={rColor(t.r)}>{fmtR(t.r)}</Td>
              <Td right className="text-terminal-muted">{t.unsizable ? 'too big' : t.lots ?? EMPTY}</Td>
              <Td right className={rColor(t.pnl_usd)}>{isNum(t.pnl_usd) ? fmtUsd(t.pnl_usd) : EMPTY}</Td>
              <Td className="text-terminal-dim">{t.reason ?? EMPTY}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── one expanded test ────────────────────────────────────────────────────────
function ResultDetail({ id, profile }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { setD(null); setErr(null); deskGetResult(id).then(setD).catch((e) => setErr(e?.response?.data?.error || e.message)); }, [id]);
  if (err) return <div className="px-4 py-3 text-xs font-mono text-red-400 border-t border-terminal-border">Couldn't load this test: {err}</div>;
  if (!d) return <div className="px-4 py-3 text-xs font-mono text-terminal-dim border-t border-terminal-border"><Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1.5" />Loading the details</div>;

  const research = d.research || listOf(d.backtests).find((b) => b?.split === 'research') || null;
  const verdict = J(d.verdict) || null;
  // gate_rows come pre-worded from the API (label / value / needed); raw gates are the fallback.
  const gates = listOf(d.gate_rows).length ? listOf(d.gate_rows) : listOf(J(verdict?.gates));
  const trades = listOf(J(d.trades) || J(research?.trades));
  const weekRows = d.periods_week ?? d.periods?.week ?? research?.periods_week;
  const monthRows = d.periods_month ?? d.periods?.month ?? research?.periods_month;
  const startBalance = research?.metrics?.start_balance ?? profile?.account_size;
  const sheet = d.rule_sheet_text || d.rule_sheet || d.strategy?.rule_sheet_text || null;

  return (
    <div className="border-t border-terminal-border px-4 py-4 space-y-5">
      <div>
        <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1.5">Account curve</div>
        <EquityCurve equity={d.equity} trades={trades} startBalance={startBalance} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 gap-y-5">
        <div className="min-w-0">
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1.5">The checks</div>
          <GateTable gates={gates} empty={verdict && d.reason ? `The checks did not run. ${String(d.reason).charAt(0).toUpperCase()}${String(d.reason).slice(1)}.` : undefined} />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1.5">Five stretches of the data</div>
          <StretchTable folds={d.folds} />
          <div className="text-[11px] font-mono text-terminal-dim mt-1.5">The same rules run on five slices of the data, one after another. A real edge should make money in most of them.</div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1.5">Week by week</div>
          <PeriodTable rows={weekRows} unit="week" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1.5">Month by month</div>
          <PeriodTable rows={monthRows} unit="month" />
        </div>
      </div>

      <div>
        <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide mb-1.5">Trades {trades.length > 200 ? `(first 200 of ${trades.length})` : `(${trades.length})`}</div>
        <TradeTable trades={trades} />
      </div>

      {sheet && <RuleSheet text={sheet} />}
    </div>
  );
}

function RuleSheet({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-[11px] font-mono text-terminal-dim uppercase tracking-wide hover:text-terminal-text">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} The rules this test used
      </button>
      {open && <pre className="mt-2 text-xs font-mono text-terminal-muted whitespace-pre-wrap leading-relaxed border border-terminal-border rounded p-3">{text}</pre>}
    </div>
  );
}

// ── one card ─────────────────────────────────────────────────────────────────
function Stat({ label, value, className = '' }) {
  return (
    <div className="min-w-[5.5rem]">
      <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-mono tabular-nums ${className}`}>{value}</div>
    </div>
  );
}

function ResultCard({ row, win, open, onToggle, onRetest, retesting, profile }) {
  const navigate = useNavigate();
  const id = row.experiment_id ?? row.id;
  const strategy = row.strategy || {};
  const name = strategy.name || row.strategy_name || (strategy.version != null ? `Version ${strategy.version}` : `Test #${id}`);
  const s = row.summary || {};
  const unit = win === 'month' ? 'month' : 'week';
  const median = s[`median_${unit}_r`] ?? s.median_period_r ?? row.period?.median_period_r;
  const positive = s[`positive_${unit}s`] ?? s.positive_periods ?? row.period?.positive_periods;
  const total = s[`${unit}s`] ?? s.periods ?? row.period?.periods;
  const reason = row.reason || row.verdict_reason || (row.verdict ? '' : 'Not judged yet.');
  const sentences = Array.isArray(row.changes_text) && row.changes_text.length ? row.changes_text : changeSentences(row.changes ?? row.params_delta);
  const hasChanges = sentences.length > 0;

  return (
    <div className={`border rounded-lg bg-terminal-surface/40 ${open ? 'border-terminal-amber/40' : 'border-terminal-border hover:border-terminal-dim'}`}>
      <div className="px-4 py-3 cursor-pointer" onClick={onToggle}>
        <div className="flex items-start gap-4">
          <div className="pt-0.5 text-terminal-dim">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-mono text-terminal-text">{name}</span>
              <span className="text-xs font-mono text-terminal-dim">{fmtWhen(row.tested_at ?? row.ran_at ?? row.created_at)}</span>
              <VerdictBadge v={row.verdict} big />
            </div>
            {reason && <div className="text-sm font-mono text-terminal-muted mt-1.5 leading-relaxed">{reason.charAt(0).toUpperCase() + reason.slice(1)}{/[.!?]$/.test(reason) ? '' : '.'}</div>}
            {hasChanges && (
              <div className="text-xs font-mono text-terminal-muted mt-1.5 leading-relaxed">
                <span className="text-terminal-dim">Changed: </span>{sentences.join(' · ')}
              </div>
            )}
            {row.note && String(row.note).trim() && <div className="text-xs font-mono text-terminal-dim mt-1 italic">{row.note}</div>}
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3">
              <Stat label="Trades" value={s.trades ?? EMPTY} className="text-terminal-text" />
              <Stat label="Win %" value={fmtPct(s.win_rate ?? s.winrate)} className="text-terminal-text" />
              <Stat label="Net R" value={fmtR(s.net_r)} className={rColor(s.net_r)} />
              <Stat label="RR" value={isNum(s.rr) ? num(s.rr) : EMPTY} className="text-terminal-text" />
              <Stat label={`Median ${unit} R`} value={fmtR(median)} className={rColor(median)} />
              <Stat label={`Positive ${unit}s`} value={positive != null ? `${positive}${total != null ? ` of ${total}` : ''}` : EMPTY} className="text-terminal-text" />
              <Stat label="Max DD" value={isNum(s.max_dd_r) ? num(s.max_dd_r) + 'R' : EMPTY} className="text-terminal-text" />
              {isNum(s.net_usd) && <Stat label="Net $" value={fmtUsd(s.net_usd)} className={rColor(s.net_usd)} />}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => navigate(`/desk/edge?version=${encodeURIComponent(strategy.id ?? row.strategy_id ?? '')}`)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-terminal-border text-[11px] font-mono text-terminal-muted hover:text-amber-400 hover:border-amber-500/60 whitespace-nowrap"
            ><Pencil className="w-3 h-3" /> Try again with a change</button>
            <button
              onClick={() => onRetest(row)} disabled={retesting}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-mono whitespace-nowrap ${retesting ? 'border-terminal-border text-terminal-dim cursor-wait' : 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-dim'}`}
            >{retesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} {retesting ? 'Testing, about 10 seconds' : 'Re-test'}</button>
          </div>
        </div>
      </div>
      {open && <ResultDetail id={id} profile={profile} />}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function ResultsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [win, setWin] = useState(() => { try { return localStorage.getItem('desk_results_window') === 'month' ? 'month' : 'week'; } catch { return 'week'; } });
  const [data, setData] = useState(null);       // { rows, holdout, n_trials }
  const [status, setStatus] = useState(null);   // /desk/status (manifest + profile)
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(() => (params.get('open') ? String(params.get('open')) : null));
  const [retesting, setRetesting] = useState(null); // experiment_id being re-tested
  const [toast, setToast] = useState(null);         // { kind: 'ok'|'err', text }
  const toastTimer = useRef(null);

  const flash = (kind, text, ms = 8000) => { clearTimeout(toastTimer.current); setToast({ kind, text }); toastTimer.current = setTimeout(() => setToast(null), ms); };
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => { try { localStorage.setItem('desk_results_window', win); } catch {} }, [win]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [r, st] = await Promise.allSettled([deskGetResults(win), deskGetStatus()]);
    if (r.status === 'fulfilled') {
      const v = r.value;
      setData({ rows: listOf(v, 'rows', 'results', 'tests', 'items'), holdout: v?.holdout ?? null, n_trials: v?.n_trials ?? null });
      setErr(null);
    } else {
      setErr(r.reason?.response?.status === 503 || r.reason?.response?.status === 404 ? 'The desk is not reachable. Restart the backend, then refresh.' : r.reason?.response?.data?.error || r.reason?.message || 'Could not load results.');
    }
    if (st.status === 'fulfilled') setStatus(st.value);
    setLoading(false);
  }, [win]);
  useEffect(() => { refresh(); }, [refresh]);

  const manifest = status?.data_manifest ? J(status.data_manifest) : null;
  const profile = useMemo(() => (status?.active_profile?.fields ? J(status.active_profile.fields) : status?.active_profile || null), [status]);
  const rows = data?.rows || [];
  const nTrials = data?.n_trials ?? status?.n_trials ?? null;

  const retest = async (row) => {
    const id = row.experiment_id ?? row.id;
    const strategyId = row.strategy?.id ?? row.strategy_id;
    if (strategyId == null) { flash('err', 'This test has no version attached, so it cannot be re-run.'); return; }
    setRetesting(id);
    try {
      const r = await deskEdgeTest({ strategy_id: strategyId, changes: {}, note: '' });
      const vname = r?.strategy?.name || row.strategy?.name || 'Version';
      flash(r?.verdict === 'PASS' ? 'ok' : 'err', `${vname} re-tested: ${verdictWord(r?.verdict)}.${r?.reason ? ' ' + r.reason.charAt(0).toUpperCase() + r.reason.slice(1) + (/[.!?]$/.test(r.reason) ? '' : '.') : ''}`);
      await refresh();
      if (r?.experiment_id != null) setOpen(String(r.experiment_id));
    } catch (e) {
      flash('err', e?.response?.data?.error || e.message || 'The re-test failed.');
    } finally { setRetesting(null); }
  };

  return (
    <div className="p-6 max-w-6xl space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-amber-400" />
            <h1 className="text-lg font-mono text-terminal-text">Results</h1>
          </div>
          <div className="text-sm font-mono text-terminal-muted mt-1">Every test you've run, newest first, pass or fail and why.</div>
          <div className="text-xs font-mono text-terminal-dim mt-1.5">
            {manifest ? (
              <>{Number(manifest.bars || 0).toLocaleString()} one-minute gold bars, {fmtDay(manifest.from_t)} to {fmtDay(manifest.to_t)}. No clean holdout yet.{nTrials != null && <> Trials so far: {nTrials}.</>}</>
            ) : status ? 'No data loaded yet. The desk needs the gold bars before it can test anything.' : ' '}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded border border-terminal-border overflow-hidden text-xs font-mono">
            {['week', 'month'].map((w) => (
              <button key={w} onClick={() => setWin(w)} className={`px-3 py-1.5 ${win === w ? 'bg-terminal-amber text-black font-semibold' : 'text-terminal-muted hover:text-terminal-text'}`}>{w === 'week' ? 'Week' : 'Month'}</button>
            ))}
          </div>
          <button onClick={refresh} title="Refresh" className="p-1.5 rounded border border-terminal-border text-terminal-dim hover:text-terminal-text"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </div>

      {toast && (
        <div className={`px-3 py-2 rounded border text-xs font-mono flex items-start gap-2 ${toast.kind === 'ok' ? 'border-green-500/50 text-green-400' : 'border-red-500/50 text-red-400'}`}>
          {toast.kind === 'ok' ? <Check className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}<span className="break-words">{toast.text}</span>
        </div>
      )}

      {err && <div className="px-3 py-2 rounded border border-red-500/50 text-xs font-mono text-red-400">{err}</div>}

      {/* Cards */}
      {!err && !loading && !rows.length && (
        <div className="border border-dashed border-terminal-border rounded-lg px-6 py-10 text-center">
          <div className="text-sm font-mono text-terminal-muted">Nothing tested yet.</div>
          <div className="text-xs font-mono text-terminal-dim mt-1">Go to Edge, change a number, and press Test this version.</div>
          <button onClick={() => navigate('/desk/edge')} className="mt-4 px-3 py-1.5 rounded bg-terminal-amber text-black text-xs font-mono font-semibold">Go to Edge</button>
        </div>
      )}
      {loading && !rows.length && !err && <div className="text-xs font-mono text-terminal-dim"><Loader2 className="w-3.5 h-3.5 inline animate-spin mr-1.5" />Loading your tests</div>}

      <div className="space-y-3">
        {rows.map((row) => {
          const id = String(row.experiment_id ?? row.id);
          return (
            <ResultCard
              key={id} row={row} win={win} profile={profile}
              open={open === id} onToggle={() => setOpen((o) => (o === id ? null : id))}
              onRetest={retest} retesting={retesting === (row.experiment_id ?? row.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
