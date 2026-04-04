import { useState, useEffect } from 'react';
import { LineChart, ComposedChart, Bar, Cell, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Save, PiggyBank, Pencil, Check, X } from 'lucide-react';
import {
  getWithdrawalPlanSettings, saveWithdrawalPlanSettings, getWeeklyPnl, getStartingBalance,
  getWithdrawalPlanActuals, saveWithdrawalActual,
} from '../lib/api';

// ── Helpers ────────────────────────────────────────────────────────────────────
function getMondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function fmtDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function fmtShort(date) {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtMoney(n, compact = false) {
  if (n == null || isNaN(n)) return '—';
  if (compact && Math.abs(n) >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (compact && Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// ── Defaults ───────────────────────────────────────────────────────────────────
const DEFAULT_SCENARIOS = [
  { label: 'Conservative', dailyPct: 6,  color: '#6b7280' },
  { label: 'Base',         dailyPct: 9,  color: '#f59e0b' },
  { label: 'Aggressive',   dailyPct: 12, color: '#ef4444' },
];

const DEFAULT_SETTINGS = {
  withdrawalPct:      25,
  profitCeiling:      null,   // null = no ceiling; number = cap balance at this amount
  startDate:          '2026-01-27',
  withdrawalStartDate:'2026-04-06',
  scenarios:          DEFAULT_SCENARIOS,
};

// ── Generate 52 weeks ─────────────────────────────────────────────────────────
function generateWeeks(settings, weeklyPnlData, midPlanDeposits = [], actualsMap = {}) {
  const {
    startingBalance    = 22000,
    withdrawalPct      = 25,
    profitCeiling      = null,
    startDate,
    withdrawalStartDate = '2026-04-06',
    scenarios          = DEFAULT_SCENARIOS,
  } = settings;

  if (!startDate) return [];

  const monday = getMondayOfWeek(new Date(startDate));
  const withdrawalStartMs = new Date(withdrawalStartDate).getTime();

  // Index actual P&L by week_start date (±3 day fuzzy match handled below)
  const pnlByDate = {};
  (weeklyPnlData || []).forEach(r => { pnlByDate[r.week_start] = r; });

  // Index mid-plan deposits by date string for quick lookup
  const depositsByDate = {};
  (midPlanDeposits || []).forEach(r => { depositsByDate[r.date] = (depositsByDate[r.date] || 0) + r.amount; });

  const forecastBals = scenarios.map(() => startingBalance);
  let actualBal = startingBalance;

  const weeks = [];
  for (let i = 0; i < 52; i++) {
    const weekStart = new Date(monday);
    weekStart.setDate(monday.getDate() + i * 7);
    const weekEnd = addDays(weekStart, 4); // Friday — trading weeks are Mon–Fri
    const weekStartStr = fmtDate(weekStart);
    const weekEndStr   = fmtDate(weekEnd);
    const isPast = weekEnd < new Date();

    // Sum any mid-plan deposits that fall within this week (Mon–Fri)
    const depositThisWeek = Object.entries(depositsByDate)
      .filter(([d]) => d >= weekStartStr && d <= weekEndStr)
      .reduce((s, [, amt]) => s + amt, 0);

    // Fuzzy-match trades to this week (±3 days to handle SQLite week boundaries)
    let actualRow = pnlByDate[weekStartStr];
    if (!actualRow) {
      for (let d = -3; d <= 3; d++) {
        const cand = fmtDate(addDays(weekStart, d));
        if (pnlByDate[cand]) { actualRow = pnlByDate[cand]; break; }
      }
    }

    const weekNum     = i + 1;
    const actualPnl   = actualRow?.total_pnl ?? null;
    const actualOverride = actualsMap[weekNum]; // manual extraction override from DB

    // Auto-calculate withdrawal: % of positive P&L weeks, only after withdrawal start date.
    // If a manual override exists (withdrawal_taken saved), use that instead.
    const isWithdrawalActive = weekStart.getTime() >= withdrawalStartMs;
    let actualWithdrawal = 0;
    if (actualOverride?.withdrawal_taken != null) {
      // Manual override — use exactly what was saved
      actualWithdrawal = actualOverride.withdrawal_taken;
    } else if (isPast && actualPnl !== null && actualPnl > 0 && isWithdrawalActive) {
      const projectedEnd = actualBal + actualPnl + depositThisWeek;
      if (profitCeiling != null && projectedEnd > profitCeiling) {
        actualWithdrawal = projectedEnd - profitCeiling;
      } else {
        actualWithdrawal = actualPnl * (withdrawalPct / 100);
      }
    }

    const actualStartBal  = actualBal;
    const hasActualTrades = actualPnl !== null; // true only when real trade data exists
    // Gross balance = balance BEFORE extraction (starting bal + P&L + deposits)
    const actualGrossBal  = hasActualTrades ? actualBal + actualPnl + depositThisWeek : null;
    let actualEndBal = null; // Net / carry-forward = gross minus extracted
    if (actualPnl !== null) {
      actualEndBal = actualGrossBal - actualWithdrawal;
      actualBal = actualEndBal;
    } else if (isPast) {
      // Past week with no trades — carry the balance forward (plus any deposit)
      // so the actual balance column shows a continuous line instead of blank dashes.
      actualEndBal = actualBal + depositThisWeek;
      if (depositThisWeek > 0) actualBal = actualEndBal;
    }

    // Forecast per scenario — dynamically rebased to actual each week where data exists
    const forecastScenarios = scenarios.map((s, si) => {
      const startBal   = forecastBals[si];
      const multiplier = Math.pow(1 + s.dailyPct / 100, 5);
      const endBal     = startBal * multiplier;
      const growth     = endBal - startBal;

      let withdrawal = 0;
      if (isWithdrawalActive && growth > 0) {
        if (profitCeiling != null && endBal > profitCeiling) {
          // Growth crosses or exceeds the ceiling — extract the exact overage
          // so the account lands precisely at the ceiling, never above it.
          withdrawal = endBal - profitCeiling;
        } else {
          withdrawal = growth * (withdrawalPct / 100);
        }
      }

      const aboveCeiling = profitCeiling != null && startBal >= profitCeiling;
      const nextStart    = endBal - withdrawal;
      forecastBals[si]   = nextStart;
      return { startBal, endBal, growth, withdrawal, nextStart, aboveCeiling };
    });

    // Dynamic rebase: rebase on real trade weeks OR weeks with a new deposit.
    // Deposits shift the actual balance so the forecast must project from the new base.
    if (hasActualTrades || (depositThisWeek > 0 && actualEndBal !== null)) {
      forecastBals.forEach((_, si) => { forecastBals[si] = actualEndBal; });
    }

    weeks.push({
      weekNum,
      weekStart, weekEnd, weekStartStr, isPast,
      month:      weekStart.toLocaleString('default', { month: 'long', year: 'numeric' }),
      monthLabel: weekStart.toLocaleString('default', { month: 'long' }),
      isWithdrawalActive,
      actualStartBal, actualPnl, actualWithdrawal, actualGrossBal, actualEndBal, hasActualTrades,
      hasManualOverride: actualOverride?.withdrawal_taken != null,
      depositThisWeek,
      tradeCount: actualRow?.trade_count ?? null,
      wins:       actualRow?.wins        ?? null,
      losses:     actualRow?.losses      ?? null,
      forecast:   forecastScenarios,
    });
  }
  return weeks;
}

// Custom tooltip for Chart A — shows actual, projected, and delta
function PnlTooltip({ active, payload, label, scColor, scLabel }) {
  if (!active || !payload?.length) return null;
  const actual    = payload.find(p => p.dataKey === 'actual')?.value ?? null;
  const projected = payload.find(p => p.dataKey === 'projected')?.value ?? null;
  const delta     = actual != null && projected != null ? actual - projected : null;
  const deltaColor = delta == null ? '#aaa' : delta >= 0 ? '#00ff88' : '#ef4444';
  const actualColor = actual == null ? '#aaa' : actual >= 0 ? '#00ff88' : '#ef4444';
  return (
    <div style={{ backgroundColor: '#111', border: '1px solid #222', borderRadius: 4, fontFamily: 'JetBrains Mono', fontSize: 11, padding: '8px 12px', lineHeight: '1.7' }}>
      <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {actual != null && (
        <div style={{ color: '#aaa' }}>Actual P&L : <span style={{ color: actualColor, fontWeight: 600 }}>{fmtMoney(actual)}</span></div>
      )}
      {projected != null && (
        <div style={{ color: '#aaa' }}>{scLabel} Projected : <span style={{ color: scColor, fontWeight: 600 }}>{fmtMoney(projected)}</span></div>
      )}
      {delta != null && (
        <div style={{ color: '#aaa', borderTop: '1px solid #222', marginTop: 4, paddingTop: 4 }}>
          vs Forecast : <span style={{ color: deltaColor, fontWeight: 600 }}>{delta >= 0 ? '+' : ''}{fmtMoney(delta)}</span>
        </div>
      )}
    </div>
  );
}

// Chart A — Weekly P&L bars (actual) + projected growth line
function buildWeeklyPnlData(weeks, activeScenario) {
  return weeks.map(w => ({
    name:      `W${w.weekNum}`,
    actual:    (w.isPast && w.hasActualTrades) ? Math.round(w.actualPnl) : null,
    projected: Math.round(w.forecast?.[activeScenario]?.growth ?? 0),
  }));
}

// Chart B — Weekly extractions: actual taken out vs plan per week
function buildExtractionData(weeks, activeScenario) {
  return weeks.map(w => ({
    name:      `W${w.weekNum}`,
    actual:    (w.isPast && w.hasActualTrades) ? Math.round(w.actualWithdrawal || 0) : null,
    projected: Math.round(w.forecast?.[activeScenario]?.withdrawal ?? 0),
  }));
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function WithdrawalPlanPage() {
  const [settings,        setSettings]       = useState(DEFAULT_SETTINGS);
  const [draft,           setDraft]          = useState(DEFAULT_SETTINGS);
  const [weeklyPnl,       setWeeklyPnl]      = useState([]);
  const [realBalance,     setRealBalance]    = useState(null);
  const [actualsMap,      setActualsMap]     = useState({});
  const [activeScenario,  setActiveScenario] = useState(1);
  const [chartStart,      setChartStart]      = useState(1);
  const [chartEnd,        setChartEnd]        = useState(16);
  const [saving,          setSaving]         = useState(false);
  const [loaded,          setLoaded]         = useState(false);
  // Inline edit state: { weekNum, value } or null
  const [editingExtracted, setEditingExtracted] = useState(null);

  useEffect(() => {
    getWithdrawalPlanSettings()
      .then(s => {
        const merged = { ...DEFAULT_SETTINGS, ...s, scenarios: s.scenarios ?? DEFAULT_SCENARIOS };
        setSettings(merged);
        setDraft(merged);
        return merged.startDate;
      })
      .then(startDate => Promise.all([
        getWeeklyPnl(),
        getStartingBalance(startDate),
        getWithdrawalPlanActuals(),
      ]))
      .then(([pnl, bal, actuals]) => {
        setWeeklyPnl(pnl || []);
        setRealBalance(bal || null);
        setActualsMap(actuals || {});
        setLoaded(true);
      })
      .catch(err => {
        console.error('WithdrawalPlan load error:', err);
        setLoaded(true);
      });
  }, []);

  const saveExtractedOverride = (weekNum, value) => {
    const amount = parseFloat(value);
    if (isNaN(amount) || amount < 0) { setEditingExtracted(null); return; }
    saveWithdrawalActual(weekNum, { withdrawal_taken: amount })
      .then(() => {
        setActualsMap(prev => ({ ...prev, [weekNum]: { ...prev[weekNum], withdrawal_taken: amount } }));
        setEditingExtracted(null);
      });
  };

  const clearExtractedOverride = (weekNum) => {
    saveWithdrawalActual(weekNum, { withdrawal_taken: null })
      .then(() => {
        setActualsMap(prev => {
          const next = { ...prev };
          if (next[weekNum]) { next[weekNum] = { ...next[weekNum], withdrawal_taken: null }; }
          return next;
        });
      });
  };

  // Starting balance = deposits on/before plan start date only.
  const resolvedStartingBalance = realBalance?.total_deposits || 0;
  const midPlanDeposits         = realBalance?.mid_plan_deposits || [];

  // Use DRAFT so scenario/% changes are live without needing Apply
  const weeks = loaded ? generateWeeks(
    { ...draft, startingBalance: resolvedStartingBalance },
    weeklyPnl, midPlanDeposits, actualsMap
  ) : [];


  // Total funds extracted — actual broker withdrawals (CWBA entries) from account_activity
  const totalExtracted = Math.abs(realBalance?.total_withdrawals || 0);

  // Current balance = deposits + all trade P&L + broker withdrawals (same formula as dashboard)
  const currentActualBal = realBalance?.current_balance ?? 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveWithdrawalPlanSettings({
        withdrawalPct:       draft.withdrawalPct,
        profitCeiling:       draft.profitCeiling,
        startDate:           draft.startDate,
        withdrawalStartDate: draft.withdrawalStartDate,
        scenarios:           draft.scenarios,
      });
      setSettings({ ...draft });
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  // Group by month
  const weeksByMonth = [];
  let curMonth = null;
  weeks.forEach(w => {
    if (w.month !== curMonth) { weeksByMonth.push({ month: w.monthLabel, weeks: [w] }); curMonth = w.month; }
    else weeksByMonth[weeksByMonth.length - 1].weeks.push(w);
  });

  const sc = draft.scenarios?.[activeScenario] ?? DEFAULT_SCENARIOS[activeScenario];

  return (
    <div className="p-6 space-y-6 max-w-full">
      <div>
        <h1 className="text-lg font-mono font-semibold text-terminal-text">Withdrawal Plan</h1>
        <p className="text-xs font-mono text-terminal-muted mt-1">Forecast vs actual — compound growth tracker</p>
      </div>

      {/* ── Key Stats ──────────────────────────────────────────────────────── */}
      {loaded && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="card p-4">
            <div className="stat-label mb-1">Current Balance</div>
            <div className="text-2xl font-mono font-bold text-terminal-text">{fmtMoney(currentActualBal)}</div>
            <div className="text-[10px] font-mono text-terminal-muted mt-0.5">
              started {fmtMoney(resolvedStartingBalance)}
              {realBalance?.has_real_data && <span className="text-terminal-green ml-1">· live</span>}
            </div>
          </div>
          <div className="card p-4 border border-terminal-green/30">
            <div className="stat-label mb-1 flex items-center gap-1.5">
              <PiggyBank className="w-3 h-3 text-terminal-green" />
              Total Funds Extracted
            </div>
            <div className="text-2xl font-mono font-bold text-terminal-green">{fmtMoney(totalExtracted)}</div>
            <div className="text-[10px] font-mono text-terminal-muted mt-0.5">Actual broker withdrawals (CWBA)</div>
          </div>
          <div className="card p-4">
            <div className="stat-label mb-1">Forecast End Balance</div>
            <div className="text-2xl font-mono font-bold" style={{ color: sc?.color }}>
              {fmtMoney(weeks[51]?.forecast[activeScenario]?.endBal, true)}
            </div>
            <div className="text-[10px] font-mono text-terminal-muted mt-0.5">{sc?.label} scenario @ {sc?.dailyPct}%/day</div>
          </div>
          <div className="card p-4">
            <div className="stat-label mb-1">Forecast Total Withdrawals</div>
            <div className="text-2xl font-mono font-bold" style={{ color: sc?.color }}>
              {fmtMoney(weeks.reduce((s, w) => s + (w.forecast[activeScenario]?.withdrawal || 0), 0), true)}
            </div>
            <div className="text-[10px] font-mono text-terminal-muted mt-0.5">over 52 weeks</div>
          </div>
        </div>
      )}

      {/* ── Settings ──────────────────────────────────────────────────────── */}
      <div className="card p-4 space-y-4">
        <div className="stat-label">Plan Settings</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <div>
            <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1">Withdrawal %</label>
            <div className="flex items-center gap-1">
              <input type="number" value={draft.withdrawalPct}
                onFocus={e => e.target.select()}
                onChange={e => setDraft(d => ({ ...d, withdrawalPct: parseFloat(e.target.value) || 0 }))}
                className="input-field text-sm w-full" />
              <span className="text-terminal-muted text-xs font-mono">%</span>
            </div>
            <div className="text-[9px] font-mono text-terminal-dim mt-0.5">Below ceiling</div>
          </div>
          <div>
            <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1">Profit Ceiling</label>
            <div className="flex items-center gap-1">
              <span className="text-terminal-muted text-sm font-mono">$</span>
              <input
                type="number"
                value={draft.profitCeiling ?? ''}
                placeholder="None"
                onFocus={e => e.target.select()}
                onChange={e => setDraft(d => ({ ...d, profitCeiling: e.target.value ? parseFloat(e.target.value) : null }))}
                className="input-field text-sm w-full"
              />
            </div>
            <div className="text-[9px] font-mono text-terminal-dim mt-0.5">
              {draft.profitCeiling ? '100% extracted above this' : 'No ceiling set'}
            </div>
          </div>
          <div>
            <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1">Plan Start Date</label>
            <input type="date" value={draft.startDate}
              onChange={e => setDraft(d => ({ ...d, startDate: e.target.value }))}
              className="input-field text-sm w-full" />
          </div>
          <div>
            <label className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide block mb-1">Withdrawals Begin</label>
            <input type="date" value={draft.withdrawalStartDate}
              onChange={e => setDraft(d => ({ ...d, withdrawalStartDate: e.target.value }))}
              className="input-field text-sm w-full" />
          </div>
          <div className="flex items-end">
            <button onClick={handleSave} disabled={saving} className="btn-primary w-full flex items-center justify-center gap-2">
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Apply'}
            </button>
          </div>
        </div>

        {/* Scenario inputs */}
        <div className="border-t border-terminal-border pt-4">
          <div className="stat-label mb-3">Growth Scenarios (% per day)</div>
          <div className="grid grid-cols-3 gap-4">
            {(draft.scenarios ?? DEFAULT_SCENARIOS).map((s, i) => (
              <div key={i} className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                  <input type="text" value={s.label} placeholder="Label"
                    onChange={e => setDraft(d => {
                      const sc = [...(d.scenarios ?? DEFAULT_SCENARIOS)];
                      sc[i] = { ...sc[i], label: e.target.value };
                      return { ...d, scenarios: sc };
                    })}
                    className="input-field text-xs flex-1" />
                </div>
                <div className="flex items-center gap-1">
                  <input type="number" step="0.5" value={s.dailyPct}
                    onFocus={e => e.target.select()}
                    onChange={e => setDraft(d => {
                      const sc = [...(d.scenarios ?? DEFAULT_SCENARIOS)];
                      sc[i] = { ...sc[i], dailyPct: parseFloat(e.target.value) || 0 };
                      return { ...d, scenarios: sc };
                    })}
                    className="input-field text-sm w-full" />
                  <span className="text-terminal-muted text-xs font-mono whitespace-nowrap">% / day</span>
                </div>
                <div className="text-[10px] font-mono text-terminal-dim">
                  = {(Math.pow(1 + s.dailyPct / 100, 5) * 100 - 100).toFixed(1)}% / week
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Charts A & B ──────────────────────────────────────────────────── */}
      {weeks.length > 0 && (() => {
        const maxWeek   = weeks.length;
        const s         = Math.max(1, Math.min(chartStart, chartEnd));
        const e         = Math.min(maxWeek, Math.max(chartEnd, chartStart));
        const chartSlice = weeks.slice(s - 1, e);
        const spanWeeks  = chartSlice.length;
        const pnlData   = buildWeeklyPnlData(chartSlice, activeScenario);
        const extData   = buildExtractionData(chartSlice, activeScenario);
        const weekOpts  = Array.from({ length: maxWeek }, (_, i) => i + 1);
        return (
          <div className="space-y-2">
            {/* shared range controls */}
            <div className="flex items-center justify-end gap-3">
              <span className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide">Weeks:</span>
              <div className="flex items-center gap-1.5">
                <select
                  value={s}
                  onChange={ev => setChartStart(Number(ev.target.value))}
                  className="input-field text-xs py-0.5 px-2 h-6 w-auto"
                >
                  {weekOpts.map(n => <option key={n} value={n}>W{n}</option>)}
                </select>
                <span className="text-terminal-muted text-xs font-mono">→</span>
                <select
                  value={e}
                  onChange={ev => setChartEnd(Number(ev.target.value))}
                  className="input-field text-xs py-0.5 px-2 h-6 w-auto"
                >
                  {weekOpts.map(n => <option key={n} value={n}>W{n}</option>)}
                </select>
                <span className="text-[10px] font-mono text-terminal-dim">({spanWeeks}wk)</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">

              {/* ── Chart A: Weekly P&L Bars ── */}
              <div className="card p-4">
                <div className="stat-label mb-3">A — Weekly P&L (Actual vs Projected)</div>
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={pnlData} margin={{ top: 5, right: 10, left: 5, bottom: 5 }} barCategoryGap="30%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' }} interval={Math.max(0, Math.floor(spanWeeks / 8) - 1)} />
                    <YAxis tickFormatter={v => fmtMoney(v, true)} tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' }} width={55} />
                    <Tooltip content={<PnlTooltip scColor={sc?.color ?? '#f59e0b'} scLabel={sc?.label ?? 'Base'} />} />
                    <ReferenceLine y={0} stroke="#333" strokeWidth={1} />
                    <Bar dataKey="actual" name="actual" maxBarSize={18}>
                      {pnlData.map((entry, index) => (
                        <Cell key={index} fill={entry.actual == null ? 'transparent' : entry.actual >= 0 ? '#00ff88' : '#ef4444'} fillOpacity={0.85} />
                      ))}
                    </Bar>
                    <Line
                      dataKey="projected"
                      type="monotone"
                      stroke={sc?.color ?? '#f59e0b'}
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* ── Chart B: Weekly Extractions ── */}
              <div className="card p-4">
                <div className="stat-label mb-3">B — Weekly Extractions (Actual vs Projected)</div>
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={extData} margin={{ top: 5, right: 10, left: 5, bottom: 5 }} barCategoryGap="30%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' }} interval={Math.max(0, Math.floor(spanWeeks / 8) - 1)} />
                    <YAxis tickFormatter={v => fmtMoney(v, true)} tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono' }} width={55} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#111', border: '1px solid #222', borderRadius: 4, fontFamily: 'JetBrains Mono', fontSize: 11 }}
                      itemStyle={{ color: '#aaa' }}
                      labelStyle={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}
                      formatter={(val, key) => {
                        if (key === 'actual') {
                          return [<span style={{ color: '#00ff88', fontWeight: 600 }}>{fmtMoney(val)}</span>, 'Actual Withdrawal'];
                        }
                        return [<span style={{ color: sc?.color ?? '#f59e0b', fontWeight: 600 }}>{fmtMoney(val)}</span>, `${sc?.label} Target`];
                      }}
                    />
                    <ReferenceLine y={0} stroke="#333" strokeWidth={1} />
                    <Bar dataKey="actual" name="actual" maxBarSize={18}>
                      {extData.map((entry, index) => (
                        <Cell key={index} fill={entry.actual == null ? 'transparent' : '#00ff88'} fillOpacity={0.85} />
                      ))}
                    </Bar>
                    <Line
                      dataKey="projected"
                      type="monotone"
                      stroke={sc?.color ?? '#f59e0b'}
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

            </div>
          </div>
        );
      })()}

      {/* ── Scenario tabs ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono text-terminal-muted uppercase tracking-wide">Table:</span>
        {(draft.scenarios ?? DEFAULT_SCENARIOS).map((s, i) => (
          <button key={i} onClick={() => setActiveScenario(i)}
            className={`px-3 py-1.5 rounded text-xs font-mono transition-colors border ${
              activeScenario === i ? 'text-black font-semibold border-transparent' : 'text-terminal-muted border-terminal-border hover:border-terminal-dim'
            }`}
            style={activeScenario === i ? { backgroundColor: s.color } : {}}>
            {s.label} ({s.dailyPct}%/day)
          </button>
        ))}
      </div>

      {/* ── Main Table ────────────────────────────────────────────────────── */}
      {weeks.length > 0 && (
        <div className="card overflow-hidden">
          <div className="overflow-auto max-h-[80vh]">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-terminal-surface border-b border-terminal-border sticky top-0 z-10">
                {/* ── Group header row — all same neutral dark style, gray dividers ── */}
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <th colSpan={3} className="px-3 py-1.5 text-center text-[11px] font-semibold uppercase tracking-widest text-[#aaa]"
                    style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.12)' }}>Timeframe</th>
                  <th colSpan={4} className="px-3 py-1.5 text-center text-[11px] font-semibold uppercase tracking-widest text-[#aaa]"
                    style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.12)' }}>{sc?.label} ({sc?.dailyPct}%/day) Projection</th>
                  <th colSpan={5} className="px-3 py-1.5 text-center text-[11px] font-semibold uppercase tracking-widest text-[#aaa]"
                    style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.12)' }}>Actual Performance</th>
                </tr>
                {/* ── Column header row ── */}
                <tr>
                  <th className="table-header w-20">Month</th>
                  <th className="table-header w-12">Wk</th>
                  <th className="table-header">Dates</th>
                  <th className="table-header text-right border-l-2 border-[#444]" style={{ color: sc?.color }}>Start</th>
                  <th className="table-header text-right" style={{ color: sc?.color }}>Growth</th>
                  <th className="table-header text-right" style={{ color: sc?.color }}>Gross Bal</th>
                  <th className="table-header text-right" style={{ color: sc?.color }}>Extracted</th>
                  <th className="table-header text-right border-l-2 border-[#444] text-terminal-green">Actual P&L</th>
                  <th className="table-header text-right text-terminal-text">Gross Bal</th>
                  <th className="table-header text-right text-terminal-amber">Extracted</th>
                  <th className="table-header text-right text-terminal-green">Carry Fwd</th>
                  <th className="table-header text-right">vs Forecast</th>
                </tr>
              </thead>
              <tbody>
                {weeksByMonth.map(({ month, weeks: mw }) => {
                  const fcstGrowth   = mw.reduce((s, w) => s + (w.forecast[activeScenario]?.growth || 0), 0);
                  const fcstMonthly  = mw.reduce((s, w) => s + (w.forecast[activeScenario]?.withdrawal || 0), 0);
                  const actualPnlSum = mw.reduce((s, w) => s + (w.actualPnl || 0), 0);
                  const extractedSum = mw.reduce((s, w) => s + (w.actualWithdrawal || 0), 0);
                  const hasActual    = mw.some(w => w.actualPnl !== null);

                  return [
                    ...mw.map((w, wi) => {
                      const f = w.forecast[activeScenario];
                      // Compare gross-to-gross (both pre-extraction) so extraction size doesn't distort the number
                      const variance = w.hasActualTrades ? w.actualGrossBal - f.endBal : null;
                      const isEditing = editingExtracted?.weekNum === w.weekNum;

                      return (
                        <tr key={w.weekNum}
                          className={`border-b border-terminal-border/40 hover:bg-terminal-hover/30 transition-colors ${!w.isPast ? 'opacity-40' : ''}`}>
                          <td className="table-cell text-terminal-muted">{wi === 0 ? <span className="text-terminal-text">{month}</span> : ''}</td>
                          <td className="table-cell text-terminal-dim">W{w.weekNum}</td>
                          <td className="table-cell text-terminal-muted text-[10px]">{fmtShort(w.weekStart)} – {fmtShort(w.weekEnd)}</td>
                          {/* Forecast — START | GROWTH | GROSS BAL | EXTRACTED */}
                          <td className="table-cell text-right border-l-2 border-[#444] text-terminal-muted">{fmtMoney(f.startBal, true)}</td>
                          <td className="table-cell text-right text-terminal-text">{fmtMoney(f.growth)}</td>
                          <td className="table-cell text-right font-semibold text-terminal-text">{fmtMoney(f.endBal, true)}</td>
                          <td className="table-cell text-right text-terminal-muted">
                            {w.isWithdrawalActive ? fmtMoney(f.withdrawal) : <span className="text-terminal-dim text-[10px]">reinvesting</span>}
                          </td>
                          {/* Actuals */}
                          <td className={`table-cell text-right border-l-2 border-[#444] font-semibold ${
                            !w.hasActualTrades ? 'text-terminal-muted' : w.actualPnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                            {w.hasActualTrades ? fmtMoney(w.actualPnl) : '—'}
                            {w.tradeCount != null && <span className="text-[9px] text-terminal-muted ml-1">({w.wins}W/{w.losses}L)</span>}
                          </td>
                          {/* Gross balance (pre-extraction) */}
                          <td className="table-cell text-right font-semibold text-terminal-text">
                            {w.actualGrossBal != null ? fmtMoney(w.actualGrossBal, true) : '—'}
                          </td>
                          {/* Extracted — editable */}
                          <td className="table-cell text-right text-terminal-amber">
                            {isEditing ? (
                              <span className="flex items-center justify-end gap-1">
                                <input autoFocus type="number" step="0.01"
                                  value={editingExtracted.value}
                                  onChange={e => setEditingExtracted(prev => ({ ...prev, value: e.target.value }))}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') saveExtractedOverride(w.weekNum, editingExtracted.value);
                                    if (e.key === 'Escape') setEditingExtracted(null);
                                  }}
                                  className="w-20 bg-terminal-surface border border-terminal-amber/60 rounded px-1 py-0.5 text-right text-xs font-mono text-terminal-amber" />
                                <button onClick={() => saveExtractedOverride(w.weekNum, editingExtracted.value)}
                                  className="text-terminal-green hover:text-green-400"><Check className="w-3 h-3" /></button>
                                <button onClick={() => setEditingExtracted(null)}
                                  className="text-terminal-red hover:text-red-400"><X className="w-3 h-3" /></button>
                              </span>
                            ) : (
                              <span className="flex items-center justify-end gap-1 group">
                                <span>{w.hasActualTrades && w.actualWithdrawal > 0 ? fmtMoney(w.actualWithdrawal) : <span className="text-terminal-dim">—</span>}</span>
                                {w.hasActualTrades && (
                                  <span className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button title="Edit extracted amount"
                                      onClick={() => setEditingExtracted({ weekNum: w.weekNum, value: w.actualWithdrawal || 0 })}
                                      className="text-terminal-muted hover:text-terminal-amber"><Pencil className="w-2.5 h-2.5" /></button>
                                    {w.hasManualOverride && (
                                      <button title="Clear override (revert to auto)"
                                        onClick={() => clearExtractedOverride(w.weekNum)}
                                        className="text-terminal-muted hover:text-terminal-red"><X className="w-2.5 h-2.5" /></button>
                                    )}
                                  </span>
                                )}
                              </span>
                            )}
                          </td>
                          {/* Carry-forward (post-extraction) */}
                          <td className={`table-cell text-right font-semibold ${
                            w.actualEndBal == null ? 'text-terminal-muted' :
                            !w.hasActualTrades ? 'text-terminal-dim' :
                            w.actualEndBal >= f.nextStart ? 'text-terminal-green' : 'text-terminal-red'}`}>
                            {w.actualEndBal != null ? fmtMoney(w.actualEndBal, true) : '—'}
                          </td>
                          <td className={`table-cell text-right ${
                            variance == null ? 'text-terminal-muted' : variance >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                            {variance != null ? (variance >= 0 ? '+' : '') + fmtMoney(variance) : '—'}
                          </td>
                        </tr>
                      );
                    }),
                    // Monthly summary — START and ACTUAL P&L get their own cells so divider lines stay unbroken
                    <tr key={`m-${month}`} className="border-b-2 border-terminal-border bg-terminal-surface/50">
                      <td colSpan={3} className="table-cell font-semibold text-terminal-text">{month} — Monthly Income</td>
                      <td className="table-cell border-l-2 border-[#444]" />
                      <td className="table-cell text-right font-semibold" style={{ color: sc?.color }}>{fmtMoney(fcstGrowth)}</td>
                      <td className="table-cell text-right" />{/* Gross Bal — no sum */}
                      <td className="table-cell text-right font-semibold" style={{ color: sc?.color }}>{fmtMoney(fcstMonthly)}</td>
                      <td className={`table-cell text-right font-semibold border-l-2 border-[#444] ${hasActual ? (actualPnlSum >= 0 ? 'text-terminal-green' : 'text-terminal-red') : 'text-terminal-muted'}`}>
                        {hasActual ? fmtMoney(actualPnlSum) : '—'}
                      </td>
                      <td className="table-cell" />
                      <td className={`table-cell text-right font-semibold ${extractedSum > 0 ? 'text-terminal-amber' : 'text-terminal-muted'}`}>
                        {extractedSum > 0 ? fmtMoney(extractedSum) : '—'}
                      </td>
                      <td colSpan={2} />
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loaded && <div className="text-center text-terminal-muted font-mono text-sm py-12">Loading plan...</div>}
    </div>
  );
}
