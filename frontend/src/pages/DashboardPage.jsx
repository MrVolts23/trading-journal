import { useState, useEffect, useMemo, Fragment } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  ComposedChart, Area, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie, ReferenceLine, LabelList,
} from 'recharts';
import {
  getDashboardStats, getStrategyPerformance, getWinRateByDay,
  getPlanAdherence, getStartingBalance, getSymbolPerformance, getDailyPnl, getEquityCurve,
  getSessionHeatmap, getStreaks,
} from '../lib/api';
import { fmtCurrency, fmt, CHART_COLORS } from '../lib/utils';
import { PiggyBank, Trophy, Wallet, Crosshair, ShieldCheck } from 'lucide-react';

// Every number on this page is NET OF COMMISSION, the way the broker's balance moves.
// Colour never carries a meaning on its own: gains and losses always also carry a sign,
// a letter (W / L) or a lightness step, so the page reads the same for every eye.

const C = {
  green: '#00ff88', greenDim: '#00cc6a', red: '#ff4444', redDim: '#cc3333', amber: '#ffaa00',
  blue: '#4488ff', text: '#e0e0e0', muted: '#888888', dim: '#555555', grid: '#1e1e1e', bg: '#0a0a0a',
};
const kFmt = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(Math.abs(v) >= 100000 ? 0 : 1) + 'k' : Math.abs(v).toFixed(0)}`;
const signed = (n) => fmtCurrency(n || 0, true);
const tone = (n) => (n > 0 ? 'text-terminal-green' : n < 0 ? 'text-terminal-red' : 'text-terminal-text');
const glyph = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '–');

// ─── Building blocks ─────────────────────────────────────────────────────────
function Band({ title, icon: Icon, children, cols = 'lg:grid-cols-6' }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        {Icon && <Icon className="w-3.5 h-3.5 text-terminal-muted" />}
        <span className="stat-label">{title}</span>
        <span className="flex-1 h-px bg-terminal-border" />
      </div>
      <div className={`grid grid-cols-2 md:grid-cols-3 ${cols} gap-3`}>{children}</div>
    </section>
  );
}

function Tile({ label, value, sub, toneOf, accent, big, children }) {
  const cls = accent || (toneOf != null ? tone(toneOf) : 'text-terminal-text');
  return (
    <div className="card p-4 flex flex-col gap-1 min-w-0">
      <span className="stat-label">{label}</span>
      <span className={`${big ? 'text-2xl' : 'text-xl'} font-mono font-bold tabular-nums truncate ${cls}`}>
        {toneOf != null && <span className="text-sm mr-1 opacity-80">{glyph(toneOf)}</span>}{value}
      </span>
      {sub && <span className="text-[11px] font-mono text-terminal-muted truncate">{sub}</span>}
      {children}
    </div>
  );
}

function PairTile({ label, win, loss, winLabel = 'win', lossLabel = 'loss', sub }) {
  return (
    <div className="card p-4 flex flex-col gap-1 min-w-0">
      <span className="stat-label">{label}</span>
      <div className="font-mono font-bold tabular-nums leading-tight">
        <div className="text-terminal-green text-lg whitespace-nowrap">{signed(win)} <span className="text-[10px] font-normal text-terminal-muted">{winLabel}</span></div>
        <div className="text-terminal-red text-lg whitespace-nowrap">{signed(loss)} <span className="text-[10px] font-normal text-terminal-muted">{lossLabel}</span></div>
      </div>
      {sub && <span className="text-[11px] font-mono text-terminal-muted truncate">{sub}</span>}
    </div>
  );
}

function ChartCard({ title, right, children, className = '' }) {
  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="stat-label">{title}</div>
        {right && <div className="text-[11px] font-mono text-terminal-muted">{right}</div>}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }) {
  return <div className="h-[200px] flex items-center justify-center text-xs font-mono text-terminal-dim text-center px-6">{children}</div>;
}

const axisTick = { fontSize: 10, fill: C.muted, fontFamily: 'monospace' };

function TipBox({ title, rows }) {
  return (
    <div className="bg-terminal-card border border-terminal-border rounded px-3 py-2 text-xs font-mono shadow-xl">
      <div className="text-terminal-muted mb-1">{title}</div>
      {rows.map(([k, v, cls], i) => (
        <div key={i} className="flex justify-between gap-4"><span className="text-terminal-muted">{k}</span><span className={cls || 'text-terminal-text'}>{v}</span></div>
      ))}
    </div>
  );
}

// ─── Equity curve ─────────────────────────────────────────────────────────────
function EquityChart({ eq }) {
  const pts = eq?.points || [];
  if (pts.length < 2) return <Empty>The equity curve draws once there are closed trades on two or more days.</Empty>;
  const best = pts.reduce((a, p) => (p.day_pnl > (a?.day_pnl ?? -Infinity) ? p : a), null);
  const worst = pts.reduce((a, p) => (p.day_pnl < (a?.day_pnl ?? Infinity) ? p : a), null);
  // Scale to the balance itself so the curve has room to breathe. The FTMO floor and target are
  // drawn only when they fall inside that window; otherwise they are named under the chart with
  // their distance, so a $200K account's $5K swing is not flattened by a $40K window.
  const vals = pts.map((p) => p.balance).concat([eq.start_balance]);
  const rawLo = Math.min(...vals), rawHi = Math.max(...vals);
  const pad = Math.max((rawHi - rawLo) * 0.35, eq.start_balance * 0.004, 500);
  const lo = rawLo - pad, hi = rawHi + pad;
  const inWindow = (v) => v != null && v >= lo && v <= hi;
  const offLines = eq.ftmo ? [
    !inWindow(eq.ftmo.floor) && `FTMO max loss ${kFmt(eq.ftmo.floor)} sits ${fmtCurrency(eq.end_balance - eq.ftmo.floor)} below the balance`,
    !inWindow(eq.ftmo.target) && `target ${kFmt(eq.ftmo.target)} is ${fmtCurrency(eq.ftmo.target - eq.end_balance)} away`,
  ].filter(Boolean) : [];
  const up = eq.end_balance >= eq.start_balance;
  const lineColor = up ? C.green : C.red;
  const dot = (props) => {
    const { cx, cy, payload, index } = props;
    const last = index === pts.length - 1;
    if (payload.start || !(payload.date === best?.date || payload.date === worst?.date) || best?.date === worst?.date && payload.date !== best?.date) return null;
    const isBest = payload.date === best?.date && best.day_pnl > 0;
    const isWorst = payload.date === worst?.date && worst.day_pnl < 0;
    if (!isBest && !isWorst) return null;
    const col = isBest ? C.green : C.red;
    return (
      <g key={payload.date}>
        <circle cx={cx} cy={cy} r={5} fill={col} stroke={C.bg} strokeWidth={2} />
        <text x={last ? cx - 8 : cx < 140 ? cx + 8 : cx} y={cy + (isBest ? -12 : 18)} textAnchor={last ? 'end' : cx < 140 ? 'start' : 'middle'} fontSize={10} fontFamily="monospace" fill={col}>
          {isBest ? `▲ best day ${signed(best.day_pnl)}` : `▼ worst day ${signed(worst.day_pnl)}`}
        </text>
      </g>
    );
  };
  return (
    <>
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={pts} margin={{ top: 18, right: 16, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.35} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tick={axisTick} tickFormatter={(d) => d?.slice(5)} axisLine={{ stroke: C.grid }} tickLine={false} />
        <YAxis domain={[lo, hi]} tick={axisTick} tickFormatter={kFmt} axisLine={false} tickLine={false} width={54} />
        <Tooltip content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0].payload;
          return <TipBox title={p.date} rows={[
            ['Balance', fmtCurrency(p.balance)],
            ['Day', `${signed(p.day_pnl)} · ${p.trades} trade${p.trades === 1 ? '' : 's'} · W ${p.wins} L ${p.losses}`, tone(p.day_pnl)],
            ['From peak', p.drawdown < 0 ? signed(p.drawdown) : 'at a new high', p.drawdown < 0 ? 'text-terminal-red' : 'text-terminal-green'],
          ]} />;
        }} />
        <ReferenceLine y={eq.start_balance} stroke={C.dim} strokeDasharray="2 4" label={{ value: `start ${kFmt(eq.start_balance)}`, position: 'insideTopLeft', fill: C.muted, fontSize: 10, fontFamily: 'monospace' }} />
        {eq.ftmo && inWindow(eq.ftmo.floor) && <ReferenceLine y={eq.ftmo.floor} stroke={C.red} strokeDasharray="4 4" label={{ value: `FTMO max loss ${kFmt(eq.ftmo.floor)}`, position: 'insideBottomLeft', fill: C.red, fontSize: 10, fontFamily: 'monospace' }} />}
        {eq.ftmo && inWindow(eq.ftmo.target) && <ReferenceLine y={eq.ftmo.target} stroke={C.green} strokeDasharray="4 4" label={{ value: `target ${kFmt(eq.ftmo.target)}`, position: 'insideTopLeft', fill: C.green, fontSize: 10, fontFamily: 'monospace' }} />}
        <Line type="monotone" dataKey="peak" stroke={C.dim} strokeWidth={1} strokeDasharray="1 3" dot={false} isAnimationActive={false} />
        <Area type="monotone" dataKey="balance" stroke={lineColor} strokeWidth={2.5} fill="url(#eqFill)" dot={dot} activeDot={{ r: 5, stroke: C.bg, strokeWidth: 2 }} />
      </ComposedChart>
    </ResponsiveContainer>
    {offLines.length > 0 && <div className="text-[10px] font-mono text-terminal-dim mt-1 px-1">{offLines.join(' · ')}</div>}
    </>
  );
}

// ─── Daily net P&L ────────────────────────────────────────────────────────────
function DailyPnlChart({ daily, ftmo }) {
  if (!daily.length) return <Empty>No closed trades in this range.</Empty>;
  const vals = daily.map((d) => d.net_pnl);
  const lo = Math.min(0, ...vals, ftmo ? -ftmo.daily_allowance : 0), hi = Math.max(0, ...vals);
  const pad = (hi - lo) * 0.15 || 500;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={daily} margin={{ top: 18, right: 12, left: 4, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid stroke={C.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tick={axisTick} tickFormatter={(d) => d?.slice(5)} axisLine={{ stroke: C.grid }} tickLine={false} />
        <YAxis domain={[lo - pad, hi + pad]} tick={axisTick} tickFormatter={kFmt} axisLine={false} tickLine={false} width={54} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const p = payload[0].payload;
          return <TipBox title={p.date} rows={[['Net', signed(p.net_pnl), tone(p.net_pnl)], ['Trades', `${p.trades} · W ${p.wins} L ${p.losses}`]]} />;
        }} />
        <ReferenceLine y={0} stroke={C.dim} />
        {ftmo && <ReferenceLine y={-ftmo.daily_allowance} stroke={C.red} strokeDasharray="4 4" label={{ value: `FTMO daily limit ${signed(-ftmo.daily_allowance)}`, position: 'insideBottomRight', fill: C.red, fontSize: 10, fontFamily: 'monospace' }} />}
        <Bar dataKey="net_pnl" radius={[4, 4, 4, 4]} isAnimationActive={false}>
          {daily.map((d, i) => <Cell key={i} fill={d.net_pnl >= 0 ? C.green : C.red} fillOpacity={0.85} />)}
          <LabelList dataKey="net_pnl" position="top" formatter={(v) => signed(v)} style={{ fontSize: 10, fontFamily: 'monospace', fill: C.text }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Trades by asset ──────────────────────────────────────────────────────────
function AssetTable({ symbols }) {
  if (!symbols.length) return <Empty>No closed trades yet.</Empty>;
  const maxAbs = Math.max(...symbols.map((s) => Math.abs(s.net_pnl)), 1);
  return (
    <div className="space-y-2.5">
      {symbols.map((s) => {
        const w = Math.max(3, Math.round((Math.abs(s.net_pnl) / maxAbs) * 100));
        const pos = s.net_pnl >= 0;
        return (
          <div key={s.symbol} className="text-xs font-mono">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0 truncate"><span className="text-terminal-text font-semibold">{s.symbol}</span> <span className="text-[10px] text-terminal-dim">{s.market || ''}</span></div>
              <div className={`font-bold tabular-nums ${tone(s.net_pnl)}`}>{signed(s.net_pnl)}</div>
            </div>
            <div className="flex items-center gap-3 mt-1">
              <div className="flex-1 h-2 rounded bg-terminal-border/60 overflow-hidden">
                <div className="h-full rounded" style={{ width: `${w}%`, background: pos ? C.green : C.red, opacity: 0.85 }} />
              </div>
              <div className="whitespace-nowrap text-[11px]">
                <span className="text-terminal-green">W {s.wins}</span> <span className="text-terminal-red">L {s.losses}</span>
                <span className="text-terminal-muted"> · {((s.win_rate || 0) * 100).toFixed(0)}%</span>
                {s.avg_r != null && <span className="text-terminal-muted"> · {s.avg_r >= 0 ? '+' : ''}{s.avg_r}R</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AssetDonut({ symbols }) {
  const total = symbols.reduce((s, x) => s + x.total, 0);
  if (!total) return null;
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={170}>
        <PieChart>
          <Pie data={symbols} dataKey="total" nameKey="symbol" cx="50%" cy="50%" innerRadius={48} outerRadius={70} paddingAngle={3} stroke={C.bg} strokeWidth={2} isAnimationActive={false}
            label={({ symbol, total: t, cx, cy, midAngle, outerRadius }) => {
              const r = outerRadius + 14, a = (-midAngle * Math.PI) / 180;
              return <text x={cx + r * Math.cos(a)} y={cy + r * Math.sin(a)} textAnchor={Math.cos(a) >= 0 ? 'start' : 'end'} dominantBaseline="central" fontSize={10} fontFamily="monospace" fill={C.muted}>{symbol} {t}</text>;
            }} labelLine={false}>
            {symbols.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div className="text-lg font-mono font-bold text-terminal-text">{total}</div>
        <div className="text-[10px] font-mono text-terminal-dim">trades</div>
      </div>
    </div>
  );
}

// ─── Session heatmap ──────────────────────────────────────────────────────────
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const h12 = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;
const hRange = (h) => `${h12(h)}–${h12((h + 1) % 24)}`;
const t12 = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const h12Long = (h) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
function SessionHeatmap({ rows, timeLabel }) {
  if (!rows.length) return <Empty>Needs closed trades with exit times.</Empty>;
  // The day runs 05:00 to 04:59 Pacific, left to right.
  const hourList = []; for (let i = 0; i < 24; i++) hourList.push((5 + i) % 24);
  const dows = [0, 1, 2, 3, 4, 5, 6].filter((d) => d >= 1 && d <= 5 || rows.some((r) => r.dow === d));
  const byKey = {}; rows.forEach((r) => { byKey[`${r.dow}-${r.hour}`] = r; });
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.net_pnl)), 1);
  // Five lightness steps per sign, so the eye reads strength as brightness, never as hue alone.
  const shade = (v) => { const t = Math.min(1, Math.abs(v) / maxAbs); return 0.18 + 0.72 * Math.ceil(t * 5) / 5; };
  const colTotals = hourList.map((h) => rows.filter((r) => r.hour === h).reduce((s, r) => s + r.net_pnl, 0));
  return (
    <div className="overflow-x-auto">
      <div className="grid gap-[3px] text-[10px] font-mono" style={{ gridTemplateColumns: `48px repeat(${hourList.length}, minmax(40px, 1fr))` }}>
        <div />
        {hourList.map((h) => <div key={h} className="text-center text-terminal-dim whitespace-nowrap">{hRange(h)}</div>)}
        {dows.map((d) => (
          <Fragment key={d}>
            <div className="text-terminal-muted flex items-center">{DOW[d]}</div>
            {hourList.map((h) => {
              const c = byKey[`${d}-${h}`];
              if (!c) return <div key={`${d}-${h}`} className="h-11 rounded bg-terminal-border/30" />;
              const pos = c.net_pnl >= 0;
              return (
                <div key={`${d}-${h}`} title={`${DOW[d]} ${hRange(h)} · ${c.trades} trade${c.trades === 1 ? '' : 's'} · W ${c.wins} L ${c.trades - c.wins} · ${signed(c.net_pnl)}\nclosed at: ${(c.exits || []).map((e) => `${t12(e.time)} ${e.symbol} ${signed(e.net)}`).join('\n')}`}
                  className="h-11 rounded flex flex-col items-center justify-center leading-tight"
                  style={{ background: pos ? C.green : C.red, opacity: shade(c.net_pnl) }}>
                  <span className="text-black font-bold">{pos ? '+' : '-'}{kFmt(Math.abs(c.net_pnl)).replace('$', '')}</span>
                  <span className="text-black/80">{c.trades}t</span>
                </div>
              );
            })}
          </Fragment>
        ))}
        <div className="text-terminal-dim flex items-center">hour</div>
        {colTotals.map((v, i) => <div key={i} className={`text-center ${v > 0 ? 'text-terminal-green' : v < 0 ? 'text-terminal-red' : 'text-terminal-dim'}`}>{v ? `${v > 0 ? '+' : '-'}${kFmt(Math.abs(v)).replace('$', '')}` : '·'}</div>)}
      </div>
      <div className="text-[10px] font-mono text-terminal-dim mt-2">Hour the trade closed, {timeLabel}. A column such as 5p–6p holds closes from 5:00:00 to 5:59:59 PM. Hover a cell for the exact close times. Each row is a trading day running 5 AM to 4:59 AM. Brighter cell = bigger net result; the number is the net $ and the trade count. Bottom row sums each hour.</div>
    </div>
  );
}

// ─── Streak tape ──────────────────────────────────────────────────────────────
function StreakTape({ streaks }) {
  if (!streaks || !streaks.tape?.length) return <Empty>No closed trades yet.</Empty>;
  const cur = streaks.current;
  const curWord = cur.type === 'W' ? 'winning' : cur.type === 'L' ? 'losing' : 'break-even';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {streaks.tape.map((t) => (
          <span key={t.id} title={`${t.symbol} · ${signed(t.net)} · ${t.t}`}
            className={`w-6 h-6 rounded flex items-center justify-center text-[11px] font-mono font-bold ${t.k === 'W' ? 'bg-terminal-green text-black' : t.k === 'L' ? 'bg-terminal-red text-black' : 'bg-terminal-border text-terminal-muted'}`}>{t.k}</span>
        ))}
      </div>
      <div className="text-[11px] font-mono text-terminal-muted">
        last {streaks.tape.length} of {streaks.total} closed trades, oldest on the left ·
        <span className={cur.type === 'W' ? ' text-terminal-green' : cur.type === 'L' ? ' text-terminal-red' : ''}> now {cur.length} {curWord} in a row</span> ·
        longest run <span className="text-terminal-green">W {streaks.longest_win}</span> / <span className="text-terminal-red">L {streaks.longest_loss}</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const filters = useOutletContext();
  const [stats, setStats] = useState(null);
  const [eq, setEq] = useState(null);
  const [daily, setDaily] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [strategyData, setStrategyData] = useState([]);
  const [dayData, setDayData] = useState([]);
  const [planAdherence, setPlanAdherence] = useState(null);
  const [heat, setHeat] = useState([]);
  const [streaks, setStreaks] = useState(null);
  const [totalExtracted, setTotalExtracted] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const p = { account: filters.account, dateStart: filters.dateStart, dateEnd: filters.dateEnd };
    setLoading(true);
    Promise.all([
      getDashboardStats(p), getEquityCurve(p), getDailyPnl(p), getSymbolPerformance(p),
      getStrategyPerformance(p), getWinRateByDay(p), getPlanAdherence(p), getStartingBalance(),
      getSessionHeatmap(p), getStreaks(p),
    ]).then(([s, e, d, sym, strat, day, adherence, realBalance, hm, st]) => {
      setStats(s); setEq(e); setDaily(d); setSymbols(sym); setStrategyData(strat); setDayData(day);
      setHeat(hm); setStreaks(st);
      setPlanAdherence(adherence);
      setTotalExtracted(Math.abs(realBalance?.total_withdrawals || 0));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [filters.account, filters.dateStart, filters.dateEnd]);

  const bestStrategy = useMemo(() => (strategyData.length ? [...strategyData].sort((a, b) => (b.net_pnl || 0) - (a.net_pnl || 0))[0] : null), [strategyData]);
  const stratPieData = useMemo(() => strategyData.map((s) => ({ name: s.strategy || 'Untagged', value: s.total || 0 })), [strategyData]);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-terminal-green font-mono text-sm animate-pulse">Loading dashboard...</div>
    </div>
  );

  const start = eq?.start_balance || 0;
  const netPct = start > 0 ? ((stats?.net_pnl || 0) / start) * 100 : null;
  const daysTraded = (eq?.points || []).filter((p) => p.trades > 0).length;
  const tagged = planAdherence?.tagged || 0;
  const closed = (stats?.wins || 0) + (stats?.losses || 0) + (stats?.breakeven || 0);
  const ftmo = eq?.ftmo || null;

  return (
    <div className="p-6 space-y-6 max-w-[1600px]">

      {/* ── ACCOUNT ─────────────────────────────────────────────────────── */}
      <Band title="Account" icon={Wallet}>
        <Tile label="Balance" value={fmtCurrency(stats?.current_balance || 0)} sub={start ? `started at ${fmtCurrency(start)}` : undefined} big />
        <Tile label="Net P&L" value={signed(stats?.net_pnl)} toneOf={stats?.net_pnl} sub={netPct != null ? `${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}% of start · ${daysTraded} day${daysTraded === 1 ? '' : 's'} traded` : undefined} big />
        <Tile label="Peak balance" value={fmtCurrency(eq?.peak_balance || 0)} sub={eq && eq.end_balance < eq.peak_balance ? `now ${signed(eq.end_balance - eq.peak_balance)} from the peak` : 'at the peak now'} />
        <Tile label="Max drawdown" value={eq?.max_drawdown_usd ? signed(eq.max_drawdown_usd) : '$0'} toneOf={eq?.max_drawdown_usd || 0} sub={eq?.max_drawdown_pct ? `${eq.max_drawdown_pct}% from peak` : 'no drawdown yet'} />
        {ftmo ? (
          <Tile label="FTMO max loss room" value={fmtCurrency((stats?.current_balance || 0) - ftmo.floor)} sub={`floor at ${fmtCurrency(ftmo.floor)} · target ${fmtCurrency(ftmo.target)}`} accent="text-terminal-amber" />
        ) : (
          <Tile label="Days traded" value={daysTraded} sub="days with a closed trade" />
        )}
        <div className="card p-4 flex flex-col gap-1 border border-terminal-green/20">
          <span className="stat-label flex items-center gap-1.5"><PiggyBank className="w-3 h-3 text-terminal-green" />Funds extracted</span>
          <span className="text-xl font-mono font-bold text-terminal-green">{fmtCurrency(totalExtracted, true)}</span>
          <span className="text-[11px] font-mono text-terminal-muted">actual broker withdrawals</span>
        </div>
      </Band>

      {/* ── EQUITY HERO ─────────────────────────────────────────────────── */}
      <ChartCard title="Equity curve" right={eq?.points?.length ? `${eq.points[0].date} → ${eq.points[eq.points.length - 1].date} · net of commission` : null}>
        <EquityChart eq={eq} />
      </ChartCard>

      {/* ── EDGE ────────────────────────────────────────────────────────── */}
      <Band title="Edge" icon={Crosshair}>
        <Tile label="Win rate" value={`${((stats?.win_rate || 0) * 100).toFixed(1)}%`} accent={stats?.win_rate >= 0.5 ? 'text-terminal-green' : 'text-terminal-amber'} sub={<><span className="text-terminal-green">W {stats?.wins || 0}</span> · <span className="text-terminal-red">L {stats?.losses || 0}</span> · B/E {stats?.breakeven || 0} · {closed} closed</>} />
        <Tile label="Profit factor" value={fmt(stats?.profit_factor, 2)} toneOf={(stats?.profit_factor || 0) - 1} sub={stats?.profit_factor >= 1 ? 'wins outweigh losses' : 'losses outweigh wins'} />
        <Tile label="Expectancy" value={signed(stats?.expectancy)} toneOf={stats?.expectancy} sub="per closed trade, net" />
        <Tile label="Average R" value={stats?.avg_r_multiple ? `${stats.avg_r_multiple >= 0 ? '+' : ''}${fmt(stats.avg_r_multiple, 2)}R` : '—'} toneOf={stats?.avg_r_multiple} sub={stats?.avg_r_multiple ? '1R = your planned risk per trade' : 'set a standard risk in Settings'} />
        <PairTile label="Avg win / avg loss" win={stats?.avg_win} loss={stats?.avg_loss} sub={stats?.avg_loss ? `${(Math.abs(stats.avg_win || 0) / Math.abs(stats.avg_loss)).toFixed(2)} to 1` : undefined} />
        <PairTile label="Largest win / loss" win={stats?.largest_win} loss={stats?.largest_loss} winLabel="best" lossLabel="worst" />
      </Band>

      <ChartCard title="Streak tape" right={streaks?.total ? `${streaks.total} closed trades` : null}>
        <StreakTape streaks={streaks} />
      </ChartCard>

      {/* ── DAILY + ASSETS ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
        <ChartCard title="Net P&L by day" right={ftmo ? 'Prague days · FTMO daily limit shown' : 'market days'} className="xl:col-span-3">
          <DailyPnlChart daily={daily} ftmo={ftmo} />
        </ChartCard>
        <ChartCard title="Trades by asset" right="net of commission" className="xl:col-span-2">
          <div className="grid grid-cols-1 2xl:grid-cols-[1fr_180px] gap-4 items-center">
            <AssetTable symbols={symbols} />
            <AssetDonut symbols={symbols} />
          </div>
        </ChartCard>
      </div>

      {/* ── WHEN THE DAY PAYS ───────────────────────────────────────────── */}
      <ChartCard title="Where the day pays" right="Pacific time">
        <SessionHeatmap rows={heat} timeLabel="Pacific time (converted from the broker's Prague clock)" />
      </ChartCard>

      {/* ── DISCIPLINE ──────────────────────────────────────────────────── */}
      <Band title="Discipline" icon={ShieldCheck} cols="lg:grid-cols-4">
        <div className="card p-4 border border-terminal-green/20 flex flex-col gap-1">
          <span className="stat-label">Followed plan</span>
          <span className="text-2xl font-mono font-bold text-terminal-green">{planAdherence?.yes_pct != null ? `${planAdherence.yes_pct}%` : '—'}</span>
          <span className="text-[11px] font-mono text-terminal-muted">
            {tagged ? <>{planAdherence.yes_count} trade{planAdherence.yes_count === 1 ? '' : 's'}{planAdherence.avg_pnl_followed != null && <span className={`ml-2 ${tone(planAdherence.avg_pnl_followed)}`}>avg {signed(planAdherence.avg_pnl_followed)}</span>}</> : 'tag trades in the Trade Journal'}
          </span>
        </div>
        <div className="card p-4 border border-terminal-red/20 flex flex-col gap-1">
          <span className="stat-label">Broke plan</span>
          <span className="text-2xl font-mono font-bold text-terminal-red">{planAdherence?.no_pct != null ? `${planAdherence.no_pct}%` : '—'}</span>
          <span className="text-[11px] font-mono text-terminal-muted">
            {tagged ? <>{planAdherence.no_count} trade{planAdherence.no_count === 1 ? '' : 's'}{planAdherence.avg_pnl_broke != null && <span className={`ml-2 ${tone(planAdherence.avg_pnl_broke)}`}>avg {signed(planAdherence.avg_pnl_broke)}</span>}</> : 'tag trades in the Trade Journal'}
          </span>
        </div>
        <Tile label="Tagged" value={`${tagged} of ${planAdherence?.total ?? closed}`} sub={planAdherence?.untagged_count ? `${planAdherence.untagged_count} still untagged` : 'every closed trade is tagged'} accent={tagged ? 'text-terminal-text' : 'text-terminal-dim'} />
        <div className="card p-4 border border-terminal-amber/20 flex flex-col gap-1 min-w-0">
          <span className="stat-label flex items-center gap-1.5"><Trophy className="w-3 h-3 text-terminal-amber" />Best strategy</span>
          <span className="text-lg font-mono font-bold text-terminal-amber truncate">{bestStrategy?.strategy || '—'}</span>
          <span className="text-[11px] font-mono text-terminal-muted">
            {bestStrategy ? <span className={tone(bestStrategy.net_pnl)}>{signed(bestStrategy.net_pnl)} · {bestStrategy.total} trade{bestStrategy.total === 1 ? '' : 's'}</span> : 'set a strategy on trades in the Trade Journal'}
          </span>
        </div>
      </Band>

      {/* ── STRATEGY + WEEKDAY ──────────────────────────────────────────── */}
      <div className={`grid grid-cols-1 ${strategyData.length ? 'lg:grid-cols-3' : 'lg:grid-cols-1'} gap-4`}>
        {strategyData.length > 0 && (
          <ChartCard title="Strategy performance" right="net">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={strategyData} layout="vertical" margin={{ top: 0, right: 48, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} horizontal={false} />
                <XAxis type="number" tick={axisTick} tickFormatter={kFmt} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="strategy" tick={axisTick} width={90} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null; const p = payload[0].payload;
                  return <TipBox title={p.strategy} rows={[['Net', signed(p.net_pnl), tone(p.net_pnl)], ['Trades', `${p.total} · W ${p.wins} L ${p.losses}`], ['Avg', signed(p.avg_pnl), tone(p.avg_pnl)]]} />;
                }} />
                <ReferenceLine x={0} stroke={C.dim} />
                <Bar dataKey="net_pnl" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  {strategyData.map((d, i) => <Cell key={i} fill={d.net_pnl >= 0 ? C.green : C.red} fillOpacity={0.85} />)}
                  <LabelList dataKey="net_pnl" position="right" formatter={(v) => signed(v)} style={{ fontSize: 10, fontFamily: 'monospace', fill: C.text }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        <ChartCard title="Win rate by weekday" right={dayData.length ? `${dayData.reduce((s, d) => s + (d.total || 0), 0)} closed trades` : null}>
          {dayData.length ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dayData} margin={{ top: 18, right: 10, left: 0, bottom: 0 }} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                <XAxis dataKey="weekday" tick={axisTick} tickFormatter={(d) => d?.slice(0, 3)} axisLine={{ stroke: C.grid }} tickLine={false} />
                <YAxis tick={axisTick} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} axisLine={false} tickLine={false} width={40} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null; const p = payload[0].payload;
                  return <TipBox title={p.weekday} rows={[['Win rate', `${((p.win_rate || 0) * 100).toFixed(0)}%`], ['Trades', `${p.total} · W ${p.wins} L ${(p.total || 0) - (p.wins || 0)}`]]} />;
                }} />
                <ReferenceLine y={0.5} stroke={C.dim} strokeDasharray="2 4" />
                <Bar dataKey="win_rate" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {dayData.map((d, i) => <Cell key={i} fill={d.win_rate >= 0.5 ? C.green : d.win_rate >= 0.35 ? C.amber : C.red} fillOpacity={0.85} />)}
                  <LabelList dataKey="win_rate" position="top" formatter={(v) => `${(v * 100).toFixed(0)}%`} style={{ fontSize: 10, fontFamily: 'monospace', fill: C.text }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty>No closed trades in this range.</Empty>}
        </ChartCard>

        {strategyData.length > 0 && (
          <ChartCard title="Trades by strategy">
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={stratPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={44} outerRadius={70} paddingAngle={3} stroke={C.bg} strokeWidth={2} isAnimationActive={false}
                  label={({ name, value, cx, cy, midAngle, outerRadius }) => {
                    const r = outerRadius + 14, a = (-midAngle * Math.PI) / 180;
                    return <text x={cx + r * Math.cos(a)} y={cy + r * Math.sin(a)} textAnchor={Math.cos(a) >= 0 ? 'start' : 'end'} dominantBaseline="central" fontSize={10} fontFamily="monospace" fill={C.muted}>{name} {value}</text>;
                  }} labelLine={false}>
                  {stratPieData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>
    </div>
  );
}
