import { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie, Legend,
} from 'recharts';
import {
  getDashboardStats, getPnlOverTime, getStrategyPerformance,
  getWinRateByDay, getDurationDistribution,
  getWeeklyPnl, getWithdrawalPlanSettings, getBalanceOverTime,
  getPlanAdherence, getStartingBalance,
} from '../lib/api';
import { fmtCurrency, fmt, CHART_COLORS } from '../lib/utils';
import { PiggyBank, Trophy } from 'lucide-react';

// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, trend, accent }) {
  return (
    <div className="card p-4 flex flex-col gap-1">
      <span className="stat-label">{label}</span>
      <span className={`text-xl font-mono font-semibold ${accent || 'text-terminal-text'}`}>{value}</span>
      {sub && <span className="text-xs font-mono text-terminal-muted">{sub}</span>}
    </div>
  );
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────
function DarkTooltip({ active, payload, label, prefix = '$' }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-terminal-card border border-terminal-border rounded px-3 py-2 text-xs font-mono">
      <div className="text-terminal-muted mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }} className="flex gap-2">
          <span>{p.name}:</span>
          <span>{prefix}{typeof p.value === 'number' ? p.value.toFixed(2) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function DashboardPage() {
  const filters = useOutletContext();
  const [stats, setStats] = useState(null);
  const [pnlData, setPnlData] = useState([]);
  const [balanceData, setBalanceData] = useState([]);
  const [strategyData, setStrategyData] = useState([]);
  const [dayData, setDayData] = useState([]);
  const [durationData, setDurationData] = useState([]);
  const [planAdherence, setPlanAdherence] = useState(null);
  const [loading, setLoading] = useState(true);
  const [totalExtracted, setTotalExtracted] = useState(0);

  useEffect(() => {
    const p = { account: filters.account, dateStart: filters.dateStart, dateEnd: filters.dateEnd };
    setLoading(true);
    Promise.all([
      getDashboardStats(p),
      getPnlOverTime(p),
      getBalanceOverTime(p),
      getStrategyPerformance(p),
      getWinRateByDay(p),
      getDurationDistribution(p),
      getWeeklyPnl(),
      getWithdrawalPlanSettings(),
      getPlanAdherence(p),
      getStartingBalance(),
    ]).then(([s, pnl, bal, strat, day, dur, weeklyPnl, planSettings, adherence, realBalance]) => {
      setStats(s);
      setPnlData(pnl);
      setBalanceData(bal);
      setStrategyData(strat);
      setDayData(day);
      setDurationData(dur);
      setPlanAdherence(adherence);
      // Use actual broker withdrawals (CWBA entries) from account_activity
      const extracted = Math.abs(realBalance?.total_withdrawals || 0);
      setTotalExtracted(extracted);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [filters.account, filters.dateStart, filters.dateEnd]);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-terminal-green font-mono text-sm animate-pulse">Loading dashboard...</div>
    </div>
  );

  const winRatePct = stats ? (stats.win_rate * 100).toFixed(1) : '—';
  const bestStrategy = strategyData.length > 0
    ? [...strategyData].sort((a, b) => (b.net_pnl || 0) - (a.net_pnl || 0))[0]
    : null;
  const stratPieData = strategyData.map(s => ({ name: s.strategy || 'Untagged', value: s.total || 0 }));

  return (
    <div className="p-6 space-y-6 max-w-[1600px]">

      {/* ── TOP STATS BAR ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="card p-4">
          <div className="stat-label mb-1">Account Balance</div>
          <div className="text-2xl font-mono font-bold text-terminal-text">{fmtCurrency(stats?.current_balance || 0)}</div>
        </div>
        <div className="card p-4">
          <div className="stat-label mb-1">Net P&L</div>
          <div className={`text-2xl font-mono font-bold ${stats?.net_pnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
            {fmtCurrency(stats?.net_pnl || 0, true)}
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label mb-1">Win Rate</div>
          <div className={`text-2xl font-mono font-bold ${stats?.win_rate >= 0.5 ? 'text-terminal-green' : 'text-terminal-amber'}`}>
            {winRatePct}%
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label mb-1">Profit Factor</div>
          <div className={`text-2xl font-mono font-bold ${stats?.profit_factor >= 1 ? 'text-terminal-green' : 'text-terminal-red'}`}>
            {fmt(stats?.profit_factor, 2)}
          </div>
        </div>
        <div className="card p-4">
          <div className="stat-label mb-1">Expectancy</div>
          <div className={`text-2xl font-mono font-bold ${stats?.expectancy >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
            {fmtCurrency(stats?.expectancy || 0)}
          </div>
        </div>
        <div className="card p-4 border border-terminal-green/20">
          <div className="stat-label mb-1 flex items-center gap-1.5">
            <PiggyBank className="w-3 h-3 text-terminal-green" />
            Funds Extracted
          </div>
          <div className="text-2xl font-mono font-bold text-terminal-green">
            {fmtCurrency(totalExtracted, true)}
          </div>
          <div className="text-[10px] font-mono text-terminal-muted mt-0.5">Actual broker withdrawals</div>
        </div>
      </div>

      {/* ── STAT CARDS ROW ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard label="Total Trades" value={stats?.total_trades || 0} />
        <StatCard label="Wins" value={stats?.wins || 0} accent="text-terminal-green" />
        <StatCard label="Losses" value={stats?.losses || 0} accent="text-terminal-red" />
        <StatCard label="Break Even" value={stats?.breakeven || 0} />
        <StatCard label="Avg Win" value={fmtCurrency(stats?.avg_win || 0)} accent="text-terminal-green" />
        <StatCard label="Avg Loss" value={fmtCurrency(stats?.avg_loss || 0)} accent="text-terminal-red" />
        <StatCard label="Largest Win" value={fmtCurrency(stats?.largest_win || 0, true)} accent="text-terminal-green" />
        <StatCard label="Largest Loss" value={fmtCurrency(stats?.largest_loss || 0)} accent="text-terminal-red" />
      </div>

      {/* ── PLAN ADHERENCE + BEST STRATEGY ───────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">

        {/* Followed Plan */}
        <div className="card p-4 border border-terminal-green/20">
          <div className="stat-label mb-1">Followed Plan</div>
          <div className="text-2xl font-mono font-bold text-terminal-green">
            {planAdherence?.yes_pct != null ? `${planAdherence.yes_pct}%` : '—'}
          </div>
          <div className="text-xs font-mono text-terminal-muted mt-1">
            {planAdherence?.yes_count ?? 0} trades
            {planAdherence?.avg_pnl_followed != null && (
              <span className="ml-2 text-terminal-green">avg {fmtCurrency(planAdherence.avg_pnl_followed, true)}</span>
            )}
          </div>
        </div>

        {/* Broke Plan */}
        <div className="card p-4 border border-terminal-red/20">
          <div className="stat-label mb-1">Broke Plan</div>
          <div className="text-2xl font-mono font-bold text-terminal-red">
            {planAdherence?.no_pct != null ? `${planAdherence.no_pct}%` : '—'}
          </div>
          <div className="text-xs font-mono text-terminal-muted mt-1">
            {planAdherence?.no_count ?? 0} trades
            {planAdherence?.avg_pnl_broke != null && (
              <span className={`ml-2 ${planAdherence.avg_pnl_broke >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                avg {fmtCurrency(planAdherence.avg_pnl_broke, true)}
              </span>
            )}
          </div>
        </div>

        {/* Untagged */}
        <div className="card p-4">
          <div className="stat-label mb-1">Untagged Trades</div>
          <div className="text-2xl font-mono font-bold text-terminal-dim">
            {planAdherence?.untagged_count ?? '—'}
          </div>
          <div className="text-xs font-mono text-terminal-muted mt-1">no plan tag set</div>
        </div>

        {/* Best Strategy */}
        <div className="card p-4 border border-terminal-amber/20">
          <div className="stat-label mb-1 flex items-center gap-1.5">
            <Trophy className="w-3 h-3 text-terminal-amber" />
            Best Strategy
          </div>
          <div className="text-lg font-mono font-bold text-terminal-amber truncate">
            {bestStrategy?.strategy || '—'}
          </div>
          <div className="text-xs font-mono text-terminal-muted mt-1">
            {bestStrategy ? (
              <span className={bestStrategy.net_pnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}>
                {fmtCurrency(bestStrategy.net_pnl, true)} · {bestStrategy.total} trades
              </span>
            ) : 'no data'}
          </div>
        </div>
      </div>

      {/* ── CHARTS ROW 1 ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* P&L Over Time */}
        <div className="card p-4">
          <div className="stat-label mb-4">P&L Over Time (Cumulative)</div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={pnlData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#666', fontFamily: 'monospace' }} tickFormatter={d => d?.slice(5)} />
              <YAxis tick={{ fontSize: 10, fill: '#666', fontFamily: 'monospace' }} tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} />
              <Tooltip content={<DarkTooltip />} />
              <Line type="monotone" dataKey="cumulative_pnl" name="Cumulative P&L" stroke="#00ff88" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Account Balance Over Time */}
        <div className="card p-4">
          <div className="stat-label mb-4">Account Balance Over Time</div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={balanceData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#666', fontFamily: 'monospace' }} tickFormatter={d => d?.slice(5)} />
              <YAxis tick={{ fontSize: 10, fill: '#666', fontFamily: 'monospace' }} tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} />
              <Tooltip content={<DarkTooltip />} />
              <Line type="monotone" dataKey="balance" name="Account Balance" stroke="#4488ff" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── CHARTS ROW 2 ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Strategy Performance */}
        <div className="card p-4">
          <div className="stat-label mb-4">Strategy Performance</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={strategyData} layout="vertical" margin={{ top: 0, right: 10, left: 70, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: '#666', fontFamily: 'monospace' }} tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} />
              <YAxis type="category" dataKey="strategy" tick={{ fontSize: 10, fill: '#888', fontFamily: 'monospace' }} width={68} />
              <Tooltip content={<DarkTooltip />} />
              <Bar dataKey="net_pnl" name="Net P&L" radius={[0, 3, 3, 0]}>
                {strategyData.map((d, i) => <Cell key={i} fill={d.net_pnl >= 0 ? '#00ff88' : '#ff4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Win Rate by Day */}
        <div className="card p-4">
          <div className="stat-label mb-4">Win Rate by Day</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dayData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e1e1e" />
              <XAxis dataKey="weekday" tick={{ fontSize: 10, fill: '#666', fontFamily: 'monospace' }} tickFormatter={d => d?.slice(0, 3)} />
              <YAxis tick={{ fontSize: 10, fill: '#666', fontFamily: 'monospace' }} tickFormatter={v => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
              <Tooltip content={<DarkTooltip prefix="" />} formatter={(v) => [(v * 100).toFixed(1) + '%', 'Win Rate']} />
              <Bar dataKey="win_rate" name="Win Rate" radius={[3, 3, 0, 0]}>
                {dayData.map((d, i) => <Cell key={i} fill={d.win_rate >= 0.5 ? '#00ff88' : d.win_rate >= 0.35 ? '#ffaa00' : '#ff4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Strategy Breakdown — trade count pie */}
        <div className="card p-4">
          <div className="stat-label mb-2">Trades by Strategy</div>
          {stratPieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={stratPieData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="45%"
                  outerRadius={65}
                  label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {stratPieData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v, name) => [v + ' trades', name]}
                  contentStyle={{ background: '#0d0d0d', border: '1px solid #333', fontFamily: 'monospace', fontSize: 11 }}
                  labelStyle={{ color: '#888' }}
                  itemStyle={{ color: '#ccc' }}
                />
                <Legend
                  formatter={v => <span style={{ color: '#888', fontSize: 10, fontFamily: 'monospace' }}>{v}</span>}
                  iconSize={8}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[200px] text-xs font-mono text-terminal-dim">No strategy data</div>
          )}
        </div>
      </div>
    </div>
  );
}
