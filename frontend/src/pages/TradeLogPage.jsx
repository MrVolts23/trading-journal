import { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ChevronUp, ChevronDown, ChevronsUpDown, Download, Search, Plus } from 'lucide-react';
import { getTrades, exportTradesCsv, getSettings } from '../lib/api';
import { fmtPnl, fmt, pnlClass, statusBadgeClass, formatDate } from '../lib/utils';
import ManualTradeModal from '../components/TradeLog/ManualTradeModal';

const STATUSES = ['All', 'WIN', 'LOSS', 'B/E', 'OPEN'];
const MARKETS  = ['All', 'METAL', 'FOREX'];

function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <ChevronsUpDown className="w-3 h-3 opacity-30" />;
  return sortDir === 'ASC' ? <ChevronUp className="w-3 h-3 text-terminal-green" /> : <ChevronDown className="w-3 h-3 text-terminal-green" />;
}

function StatusBadge({ status }) {
  return <span className={statusBadgeClass(status)}>{status}</span>;
}

export default function TradeLogPage() {
  const filters = useOutletContext();
  const [trades,          setTrades]          = useState([]);
  const [total,           setTotal]           = useState(0);
  const [initialBalances, setInitialBalances] = useState({});
  const [activityRows,    setActivityRows]    = useState([]);
  const [loading,         setLoading]         = useState(true);
  const [sortCol,         setSortCol]         = useState('entry_datetime');
  const [sortDir,         setSortDir]         = useState('DESC');
  const [page,            setPage]            = useState(1);
  const [showModal,       setShowModal]       = useState(false);
  const [strategies,      setStrategies]      = useState([]);
  const [localFilters,    setLocalFilters]    = useState({
    status: 'All', market: 'All', strategy: 'All', symbol: ''
  });
  const [limit, setLimit] = useState(50);

  // Load strategies from settings
  // getSettings() already JSON-parses values, so s.strategies is already an array
  useEffect(() => {
    getSettings().then(s => {
      setStrategies(Array.isArray(s?.strategies) ? s.strategies : []);
    }).catch(() => {});
  }, []);

  const fetchTrades = () => {
    setLoading(true);
    getTrades({
      account: filters.account,
      dateStart: filters.dateStart,
      dateEnd: filters.dateEnd,
      status: localFilters.status,
      market: localFilters.market,
      strategy: localFilters.strategy,
      symbol: localFilters.symbol,
      sort: sortCol, dir: sortDir, page, limit,
    }).then(data => {
      setTrades(data.trades);
      setTotal(data.total);
      setInitialBalances(data.initialBalances || {});
      setActivityRows(data.activityRows || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { setPage(1); }, [filters, localFilters, sortCol, sortDir, limit]);
  useEffect(() => { fetchTrades(); }, [filters, localFilters, sortCol, sortDir, page, limit]);

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'ASC' ? 'DESC' : 'ASC');
    else { setSortCol(col); setSortDir('DESC'); }
  };

  const handleExport = () => {
    exportTradesCsv({
      account: filters.account, dateStart: filters.dateStart, dateEnd: filters.dateEnd,
      status: localFilters.status, market: localFilters.market, strategy: localFilters.strategy,
    });
  };

  const totalPages = Math.ceil(total / limit);

  const colHeader = (label, col) => (
    <th className="table-header cursor-pointer select-none hover:text-terminal-text" onClick={() => handleSort(col)}>
      <div className="flex items-center gap-1">
        {label}
        <SortIcon col={col} sortCol={sortCol} sortDir={sortDir} />
      </div>
    </th>
  );

  return (
    <div className="p-6 space-y-4">
      {showModal && (
        <ManualTradeModal onClose={() => setShowModal(false)} onSaved={fetchTrades} />
      )}

      {/* ── FILTERS ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-1.5 py-1.5 text-xs">
          <Plus className="w-3.5 h-3.5" /> New Trade
        </button>

        <div className="w-px h-5 bg-terminal-border" />

        <div className="flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-terminal-muted" />
          <input
            placeholder="Symbol..."
            value={localFilters.symbol}
            onChange={e => setLocalFilters(f => ({ ...f, symbol: e.target.value }))}
            className="input-field text-xs py-1.5 w-28"
          />
        </div>
        {[
          { key: 'status',   options: STATUSES },
          { key: 'market',   options: MARKETS },
          { key: 'strategy', options: ['All', ...strategies] },
        ].map(({ key, options }) => (
          <select
            key={key}
            value={localFilters[key]}
            onChange={e => setLocalFilters(f => ({ ...f, [key]: e.target.value }))}
            className="select-field text-xs py-1.5"
          >
            {options.map(o => <option key={o}>{o}</option>)}
          </select>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs font-mono text-terminal-muted">{total} trades</span>
          <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
            className="select-field text-xs py-1.5 w-20">
            <option value={50}>50 / pg</option>
            <option value={100}>100 / pg</option>
            <option value={200}>200 / pg</option>
          </select>
          <button onClick={handleExport} className="btn-ghost flex items-center gap-1.5 py-1.5 text-xs">
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {/* ── TABLE ───────────────────────────────────────────────────────── */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead className="border-b border-terminal-border bg-terminal-surface">
              <tr>
                {colHeader('#', 'id')}
                {colHeader('Status', 'status')}
                {colHeader('Symbol', 'symbol')}
                <th className="table-header">Pos</th>
                {colHeader('Account', 'account')}
                {colHeader('Market', 'market')}
                {colHeader('Strategy', 'strategy')}
                {colHeader('Entry', 'entry_datetime')}
                {colHeader('Exit', 'exit_datetime')}
                {colHeader('Lots', 'lot_size')}
                {colHeader('P&L', 'pnl')}
                <th className="table-header">Balance</th>
                <th className="table-header">P&L %</th>
                {colHeader('R-Mult', 'r_multiple')}
                <th className="table-header">Duration</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={15} className="text-center py-8 text-terminal-muted font-mono text-sm animate-pulse">Loading...</td></tr>
              ) : trades.length === 0 ? (
                <tr><td colSpan={15} className="text-center py-12 text-terminal-dim font-mono text-sm">No trades found</td></tr>
              ) : (() => {
                // Build combined list: trades + activity rows (deposits/withdrawals), sorted by date DESC
                const fmtMoney = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
                const actInView = sortCol === 'entry_datetime'
                  ? activityRows.filter(a => {
                      if (filters.account && filters.account !== 'All' && a.account !== filters.account) return false;
                      if (filters.dateStart && a.date < filters.dateStart) return false;
                      if (filters.dateEnd && a.date > filters.dateEnd) return false;
                      return true;
                    })
                  : [];

                // Merge trades and activity rows for display
                const combined = [
                  ...trades.map(t => ({ ...t, _type: 'trade' })),
                  ...actInView.map(a => ({ ...a, _type: 'activity' })),
                ].sort((a, b) => {
                  const aDate = a._type === 'trade' ? a.entry_datetime : a.date + 'T00:00:00';
                  const bDate = b._type === 'trade' ? b.entry_datetime : b.date + 'T00:00:00';
                  return sortDir === 'DESC' ? bDate.localeCompare(aDate) : aDate.localeCompare(bDate);
                });

                return combined.map((row, i) => {
                  if (row._type === 'activity') {
                    const isWithdrawal = row.activity_type === 'withdrawal';
                    return (
                      <tr key={`act-${row.id}`} className="bg-blue-950/20 border-l-2 border-l-blue-500">
                        <td className="table-cell text-terminal-dim">—</td>
                        <td className="table-cell">
                          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${isWithdrawal ? 'bg-red-900/40 text-terminal-red' : 'bg-green-900/40 text-terminal-green'}`}>
                            {isWithdrawal ? 'WITHDRAW' : 'DEPOSIT'}
                          </span>
                        </td>
                        <td className="table-cell font-semibold text-blue-400">—</td>
                        <td className="table-cell text-terminal-dim">—</td>
                        <td className="table-cell text-terminal-muted text-xs">{row.account}</td>
                        <td className="table-cell text-terminal-dim">—</td>
                        <td className="table-cell text-xs text-terminal-dim" colSpan={2}>{row.notes || '—'}</td>
                        <td className="table-cell text-xs text-terminal-muted">{row.date}</td>
                        <td className="table-cell text-terminal-dim">—</td>
                        <td className={`table-cell font-semibold font-mono ${isWithdrawal ? 'text-terminal-red' : 'text-terminal-green'}`}>
                          {isWithdrawal ? '' : '+'}{fmtMoney(row.amount)}
                        </td>
                        <td className="table-cell text-terminal-dim" colSpan={4}>—</td>
                      </tr>
                    );
                  }

                  const t = row;
                  const rowBg = i % 2 === 0 ? '' : 'bg-terminal-surface/30';
                  const statusRow = t.status === 'WIN' ? 'border-l-2 border-l-green-800' :
                    t.status === 'LOSS' ? 'border-l-2 border-l-red-900' :
                    t.status === 'OPEN' ? 'border-l-2 border-l-blue-900' : '';
                  const runningBal = t.running_pnl != null
                    ? (initialBalances[t.account] || 0) + t.running_pnl + (t.withdrawals_to_date || 0)
                    : null;
                  return (
                    <tr key={t.id} className={`${rowBg} ${statusRow} hover:bg-terminal-hover transition-colors`}>
                      <td className="table-cell text-terminal-dim">{t.id}</td>
                      <td className="table-cell"><StatusBadge status={t.status} /></td>
                      <td className="table-cell font-semibold text-terminal-text">{t.symbol}</td>
                      <td className="table-cell">
                        <span className={t.position === 'Long' ? 'text-terminal-green' : 'text-terminal-red'}>{t.position}</span>
                      </td>
                      <td className="table-cell text-terminal-muted">{t.account}</td>
                      <td className="table-cell text-terminal-muted">{t.market}</td>
                      <td className="table-cell text-terminal-muted text-xs">{t.strategy}</td>
                      <td className="table-cell text-xs text-terminal-muted">{formatDate(t.entry_datetime)}</td>
                      <td className="table-cell text-xs text-terminal-muted">{formatDate(t.exit_datetime)}</td>
                      <td className="table-cell text-terminal-muted">{t.lot_size}</td>
                      <td className={`table-cell font-semibold font-mono-nums ${pnlClass(t.pnl)}`}>
                        {fmtPnl(t.pnl)}
                      </td>
                      <td className="table-cell font-mono text-xs text-terminal-muted">
                        {runningBal != null ? fmtMoney(runningBal) : '—'}
                      </td>
                      <td className={`table-cell text-xs font-mono-nums ${pnlClass(t.pnl_pct)}`}>
                        {t.pnl_pct != null ? `${(t.pnl_pct * 100).toFixed(2)}%` : '—'}
                      </td>
                      <td className={`table-cell font-mono-nums ${pnlClass(t.r_multiple)}`}>
                        {t.r_multiple != null ? fmt(t.r_multiple, 3) + 'R' : '—'}
                      </td>
                      <td className="table-cell text-terminal-muted text-xs">{t.duration || '—'}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── PAGINATION ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-terminal-muted">
          {total > 0
            ? `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} trades`
            : `${total} trades`}
        </span>
        <div className="flex items-center gap-2">
          <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
            className="select-field text-xs py-1 w-20">
            <option value={50}>50 / pg</option>
            <option value={100}>100 / pg</option>
            <option value={200}>200 / pg</option>
          </select>
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="btn-ghost py-1 px-3 text-xs disabled:opacity-30">← Prev</button>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="btn-ghost py-1 px-3 text-xs disabled:opacity-30">Next →</button>
        </div>
      </div>
    </div>
  );
}
