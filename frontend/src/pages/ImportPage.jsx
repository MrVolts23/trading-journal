import { useState, useRef, useEffect } from 'react';
import { Upload, Check, AlertTriangle, ChevronRight, Database, TrendingUp, Loader2, Trash2, Info, RefreshCw } from 'lucide-react';
import { uploadImportFile, previewImport, commitImport, getAccounts, clearTradesByAccount } from '../lib/api';
import { fmtCurrency, statusBadgeClass } from '../lib/utils';

const STEPS = ['Upload File', 'Map Fields', 'Preview', 'Done'];

// EightCap MT5 Trades Report (Excel/CSV)
const EIGHTCAP_MT5_PRESET = {
  broker: 'EightCap',
  label: 'EightCap MT5 (Trades Report)',
  fields: {
    trade_id:      'Ticket',
    symbol:        'Symbol',
    position:      'Type',
    lot_size:      'Volume',
    commission:    'Commission',
    entry_datetime:'Open Time',
    entry_price:   'Open Price',
    exit_datetime: 'Close Time',
    exit_price:    'Close Price',
    pnl:           'Profit',
    swap:          'Swaps',
  },
  transforms: {
    position: { 'buy': 'Long', 'sell': 'Short', 'Buy': 'Long', 'Sell': 'Short' },
  },
  skipIfEmpty: ['Type', 'Symbol'],
};

// TradingView Paper Trading Balance History CSV — one row per closed trade, P&L in CAD
const TV_BALANCE_HISTORY_PRESET = {
  broker: 'Paper Trading',
  label:  'TradingView Paper Trading (Balance History)',
  mode:   'tv_balance_history',
};

const PRESETS = {
  eightcap_mt5:         EIGHTCAP_MT5_PRESET,
  tv_balance_history:   TV_BALANCE_HISTORY_PRESET,
  custom:               null,
};

const TARGET_FIELDS = [
  { key: 'trade_id',       label: 'Trade ID',             required: true },
  { key: 'symbol',         label: 'Symbol',               required: true },
  { key: 'position',       label: 'Position (Long/Short)', required: true },
  { key: 'entry_datetime', label: 'Entry Date & Time',    required: true },
  { key: 'pnl',            label: 'P&L',                  required: true },
  { key: 'entry_price',    label: 'Entry Price' },
  { key: 'exit_datetime',  label: 'Exit Date & Time' },
  { key: 'exit_price',     label: 'Exit Price' },
  { key: 'lot_size',       label: 'Lot Size' },
  { key: 'commission',     label: 'Commission' },
  { key: 'swap',           label: 'Swap' },
  { key: 'stop_loss',      label: 'Stop Loss' },
  { key: 'take_profit',    label: 'Take Profit' },
  { key: 'strategy',       label: 'Strategy' },
];

function StepIndicator({ current }) {
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((s, i) => (
        <div key={i} className="flex items-center">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-mono ${
            i === current ? 'bg-terminal-green text-black font-semibold'
            : i < current ? 'text-terminal-green' : 'text-terminal-dim'
          }`}>
            {i < current ? <Check className="w-3 h-3" /> : <span>{i + 1}</span>}
            {s}
          </div>
          {i < STEPS.length - 1 && <ChevronRight className="w-3 h-3 text-terminal-dim mx-1" />}
        </div>
      ))}
    </div>
  );
}

export default function ImportPage() {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [uploadId, setUploadId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [csvColumns, setCsvColumns] = useState([]);
  const [broker, setBroker] = useState('eightcap_mt5');
  const [mapping, setMapping] = useState({ ...EIGHTCAP_MT5_PRESET.fields });
  const [importFromDate, setImportFromDate] = useState('');

  // Account assignment
  const [accounts, setAccounts] = useState([]);
  const [detectedLogins, setDetectedLogins] = useState([]);  // login IDs found in the file
  const [accountOverride, setAccountOverride] = useState(''); // manual override account name
  // autoAccounts: loginId → accountName (resolved automatically from Login column)
  const [autoAccounts, setAutoAccounts] = useState({});

  const [previewData, setPreviewData] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Manage/delete section
  const [deleteAccount, setDeleteAccount] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteResult, setDeleteResult] = useState(null);
  const [deleteError, setDeleteError] = useState('');

  const fileRef = useRef();

  // Fetch accounts on mount
  useEffect(() => {
    getAccounts().then(setAccounts).catch(() => {});
  }, []);

  const handleBrokerChange = (b) => {
    setBroker(b);
    setAccountOverride('');
    setDetectedLogins([]);
    setAutoAccounts({});
    if (PRESETS[b]?.fields) {
      setMapping({ ...PRESETS[b].fields });
    } else {
      setMapping({});
    }
  };

  const handleFileUpload = async (f) => {
    setFile(f);
    setError('');
    setUploadId(null);
    setDetectedLogins([]);
    setAutoAccounts({});
    setUploading(true);
    try {
      const result = await uploadImportFile(f);
      setUploadId(result.uploadId);
      setCsvColumns(result.columns);
      if (PRESETS[broker]?.fields) {
        setMapping({ ...PRESETS[broker].fields });
      }

      // If the file has broker Login IDs (EightCap MT5), show them
      if (result.detectedLogins?.length > 0) {
        setDetectedLogins(result.detectedLogins);
        // Pre-resolve: make a temporary mapping so the UI can show account names
        // The actual resolution happens in previewImport on the backend
        const preview = {};
        for (const login of result.detectedLogins) {
          preview[login] = `EightCap ${login}`;
        }
        setAutoAccounts(preview);
      }

      setStep(1);
    } catch (e) {
      setError(`File upload failed: ${e.message}`);
      setFile(null);
    } finally {
      setUploading(false);
    }
  };

  const getActiveMapping = () => {
    const preset = PRESETS[broker];
    return preset
      ? { ...preset, fields: mapping }
      : { fields: mapping, transforms: { position: { 'buy': 'Long', 'sell': 'Short', 'Buy': 'Long', 'Sell': 'Short' } } };
  };

  // The account to pass to preview: only if user manually overrode (auto-detection handled server-side)
  const getAccountParam = () => {
    if (accountOverride) return accountOverride;
    // TV Paper formats: null → server defaults to 'Paper Trading'
    if (broker === 'tv_balance_history') return null;
    // For standard imports with detected logins, pass null = let server auto-resolve per Login
    if (detectedLogins.length > 0 && !accountOverride) return null;
    return null;
  };

  const handlePreview = async () => {
    setLoading(true);
    setError('');
    try {
      const acct = getAccountParam();
      const data = await previewImport(uploadId, getActiveMapping(), importFromDate || null, acct);
      setPreviewData(data);
      setStep(2);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
    setLoading(false);
  };

  const handleCommit = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await commitImport(uploadId);
      setImportResult(result);
      // Refresh accounts list (new accounts may have been created)
      getAccounts().then(setAccounts).catch(() => {});
      setStep(3);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
    setLoading(false);
  };

  const reset = () => {
    setStep(0); setFile(null); setUploadId(null); setCsvColumns([]);
    setBroker('eightcap_mt5'); setMapping({ ...EIGHTCAP_MT5_PRESET.fields });
    setImportFromDate(''); setAccountOverride('');
    setDetectedLogins([]); setAutoAccounts({});
    setPreviewData(null); setImportResult(null); setError('');
  };

  const handleDelete = async () => {
    if (!deleteAccount) return;
    setDeleteLoading(true);
    setDeleteError('');
    setDeleteResult(null);
    try {
      const result = await clearTradesByAccount(deleteAccount);
      setDeleteResult(result);
      setDeleteAccount('');
    } catch (e) {
      setDeleteError(e.response?.data?.error || e.message);
    }
    setDeleteLoading(false);
  };

  // Determine which accounts will be created by this import (for the info banner)
  const willAutoCreateAccounts = detectedLogins.length > 0 && !accountOverride;

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-lg font-mono font-semibold text-terminal-text">Import Trades</h1>
        <p className="text-xs font-mono text-terminal-muted mt-1">
          Supports EightCap MT5 Trades Report (.xlsx), TradingView Paper Trading (.csv), and custom formats
        </p>
      </div>

      <StepIndicator current={step} />

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-950 border border-red-900 rounded text-xs font-mono text-terminal-red">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* ── STEP 0: Select source + Upload ──────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-4">
          <div className="card p-4 space-y-3">
            <div className="stat-label">Select Data Source</div>
            <div className="grid grid-cols-2 gap-3">
              {[
                {
                  key: 'eightcap_mt5',
                  label: 'EightCap MT5',
                  sub: 'Trades Report (.xlsx)',
                  icon: Database,
                  tip: 'Auto-detects account from Login column',
                },
                {
                  key: 'tv_balance_history',
                  label: 'TradingView Paper',
                  sub: 'Balance History (.csv) — Recommended',
                  icon: TrendingUp,
                  tip: 'One row per trade, P&L already converted to CAD',
                },
                {
                  key: 'custom',
                  label: 'Custom',
                  sub: 'Map columns manually',
                  icon: Upload,
                  tip: 'Any broker CSV/XLSX',
                },
              ].map(({ key, label, sub, icon: Icon, tip }) => (
                <button
                  key={key}
                  onClick={() => handleBrokerChange(key)}
                  className={`flex flex-col items-start gap-1.5 p-3 rounded border text-left transition-colors ${
                    broker === key
                      ? 'border-terminal-green bg-green-950/30'
                      : 'border-terminal-border hover:border-terminal-dim'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Icon className={`w-4 h-4 ${broker === key ? 'text-terminal-green' : 'text-terminal-muted'}`} />
                    <span className={`text-sm font-mono font-semibold ${broker === key ? 'text-terminal-green' : 'text-terminal-text'}`}>{label}</span>
                  </div>
                  <span className="text-[10px] font-mono text-terminal-muted">{sub}</span>
                  {tip && <span className="text-[10px] font-mono text-terminal-amber">{tip}</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Manual account override — shown for TV Paper and custom; EightCap auto-detects */}
          {(broker === 'tv_balance_history' || broker === 'custom') && (
            <div className="card p-4 space-y-2">
              <div className="stat-label">Assign to Account</div>
              {broker === 'tv_balance_history' && (
                <div className="flex items-center gap-2 py-1.5 px-3 rounded bg-terminal-surface border border-terminal-green/30 w-fit">
                  <span className="text-[10px] font-mono text-terminal-muted uppercase tracking-wider">Account</span>
                  <span className="text-xs font-mono text-terminal-green font-semibold">
                    {accountOverride || 'Paper Trading'}
                  </span>
                  <span className="text-[10px] font-mono text-terminal-dim">— isolated from live accounts</span>
                </div>
              )}
              <div className="text-xs font-mono text-terminal-muted">
                {broker === 'tv_balance_history'
                  ? 'Imports to a separate "Paper Trading" account by default. Only visible when "All Accounts" is selected in the top bar.'
                  : 'All imported trades will be attributed to this account.'}
              </div>
              <select
                value={accountOverride}
                onChange={e => setAccountOverride(e.target.value)}
                className="select-field text-xs font-mono w-72"
              >
                <option value="">
                  {broker === 'tv_balance_history' ? '— Default: Paper Trading —' : '— Use broker default —'}
                </option>
                {accounts.map(a => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          {broker === 'eightcap_mt5' && (
            <div className="card p-4 border border-terminal-green/20 bg-green-950/10 space-y-2">
              <div className="flex items-center gap-2">
                <Info className="w-4 h-4 text-terminal-green flex-shrink-0" />
                <div className="text-xs font-mono text-terminal-green font-semibold">Auto Account Detection</div>
              </div>
              <div className="text-xs font-mono text-terminal-muted leading-relaxed">
                The Login column in your EightCap MT5 report contains your broker account number.
                Accounts are automatically created or matched when you upload — perfect for copy-trading
                accounts that share the same export file.
              </div>
              <div className="text-[10px] font-mono text-terminal-dim">
                Override below if you want to assign all trades to a specific account instead.
              </div>
              <select
                value={accountOverride}
                onChange={e => setAccountOverride(e.target.value)}
                className="select-field text-xs font-mono w-72"
              >
                <option value="">— Auto-detect from Login column (recommended) —</option>
                {accounts.map(a => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Import from date filter */}
          <div className="card p-4 space-y-2">
            <div className="stat-label">Import From Date <span className="text-terminal-dim font-normal">(optional)</span></div>
            <div className="text-xs font-mono text-terminal-muted">
              Only import trades on or after this date. Leave blank to import all trades.
            </div>
            <input
              type="date"
              value={importFromDate}
              onChange={e => setImportFromDate(e.target.value)}
              className="input-field text-xs font-mono w-44"
              placeholder="YYYY-MM-DD"
            />
            {importFromDate && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-terminal-green">Filtering to trades from {importFromDate} onwards</span>
                <button onClick={() => setImportFromDate('')} className="text-xs font-mono text-terminal-dim hover:text-terminal-text">✕ clear</button>
              </div>
            )}
          </div>

          <div
            onClick={() => !uploading && fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !uploading) handleFileUpload(f); }}
            className={`card border-dashed border-2 border-terminal-border transition-colors p-12 flex flex-col items-center justify-center gap-4 ${uploading ? 'cursor-wait opacity-70' : 'hover:border-terminal-green cursor-pointer'}`}
          >
            {uploading
              ? <Loader2 className="w-10 h-10 text-terminal-green animate-spin" />
              : <Upload className="w-10 h-10 text-terminal-dim" />
            }
            <div className="text-center">
              <div className="text-sm font-mono text-terminal-text">
                {uploading ? 'Uploading…' : 'Drop your file here'}
              </div>
              <div className="text-xs font-mono text-terminal-muted mt-1">
                {broker === 'eightcap_mt5' ? 'Accepts .xlsx or .csv' : 'Accepts .csv or .xlsx'}
              </div>
              {importFromDate && (
                <div className="text-xs font-mono text-terminal-green mt-1">From {importFromDate}</div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={e => { if (e.target.files[0]) handleFileUpload(e.target.files[0]); }}
            />
          </div>
        </div>
      )}

      {/* ── STEP 1: Confirm / Map Fields ─────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="card p-4">
            <div className="stat-label">File: {file?.name}</div>
            <div className="text-xs font-mono text-terminal-muted mt-1">
              Source: <span className="text-terminal-green">{PRESETS[broker]?.label || 'Custom'}</span>
              {csvColumns.length > 0 && <> · {csvColumns.length} columns detected</>}
            </div>
          </div>

          {/* Account assignment summary */}
          {detectedLogins.length > 0 && !accountOverride && (
            <div className="card p-4 border border-terminal-green/30 bg-green-950/10 space-y-2">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-terminal-green" />
                <span className="text-sm font-mono text-terminal-green font-semibold">
                  {detectedLogins.length} broker login{detectedLogins.length > 1 ? 's' : ''} detected
                </span>
              </div>
              <div className="space-y-1">
                {detectedLogins.map(login => (
                  <div key={login} className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-terminal-muted">Login</span>
                    <span className="text-terminal-amber font-semibold">{login}</span>
                    <span className="text-terminal-dim">→</span>
                    <span className="text-terminal-green">{autoAccounts[login] || `EightCap ${login}`}</span>
                    <span className="text-[10px] text-terminal-dim">(auto-created if new)</span>
                  </div>
                ))}
              </div>
              <div className="text-[10px] font-mono text-terminal-dim">
                Each login maps to its own account. Override in Step 0 to assign all to one account.
              </div>
            </div>
          )}

          {accountOverride && (
            <div className="card p-4 border border-terminal-amber/30 bg-amber-950/10">
              <div className="flex items-center gap-2 text-xs font-mono">
                <Info className="w-4 h-4 text-terminal-amber" />
                <span className="text-terminal-amber">All trades will be assigned to: <strong>{accountOverride}</strong></span>
              </div>
            </div>
          )}

          {broker === 'tv_balance_history' ? (
            /* TradingView Balance History — one row per closed trade, P&L in CAD */
            <div className="card p-4 border border-terminal-green/30 bg-green-950/10 space-y-3">
              <div className="text-sm font-mono text-terminal-green font-semibold">Balance History Format — Recommended</div>
              <div className="text-xs font-mono text-terminal-muted leading-relaxed">
                Each row is one closed trade. P&L is already converted to CAD using the
                exchange rate at close time. No order pairing needed. All fields are
                parsed directly from the Action text.
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="flex items-center gap-2">
                  <span className="text-terminal-green">✓</span>
                  <span className="text-terminal-muted">P&L in CAD — exact, no estimation</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-green">✓</span>
                  <span className="text-terminal-muted">Long / Short direction parsed</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-green">✓</span>
                  <span className="text-terminal-muted">Entry avg price + exit price</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-terminal-green">✓</span>
                  <span className="text-terminal-muted">Works for XAUUSD, USDJPY, MGC1 etc.</span>
                </div>
              </div>
              <div className="text-[10px] font-mono text-terminal-dim">
                Export from TradingView → Paper Trading → Balance History tab → Download CSV
              </div>
            </div>
          ) : (
            <>
              {csvColumns.length > 0 && (
                <div className="card p-4">
                  <div className="stat-label mb-2">Detected Columns</div>
                  <div className="flex flex-wrap gap-1.5">
                    {csvColumns.map(c => (
                      <span key={c} className="px-2 py-0.5 bg-terminal-surface border border-terminal-border rounded text-[10px] font-mono text-terminal-muted">{c}</span>
                    ))}
                  </div>
                </div>
              )}

              <div className="card p-4 space-y-3">
                <div className="stat-label">Field Mapping</div>
                <div className="text-xs font-mono text-terminal-muted mb-2">
                  {broker === 'custom'
                    ? 'Map each of your CSV columns to the journal fields.'
                    : `Pre-filled for ${PRESETS[broker]?.label}. Adjust if columns differ.`}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {TARGET_FIELDS.map(({ key, label, required }) => (
                    <div key={key} className="flex items-center gap-3">
                      <div className="w-44 flex-shrink-0">
                        <span className="text-xs font-mono text-terminal-text">{label}</span>
                        {required && <span className="text-terminal-red ml-1">*</span>}
                      </div>
                      <select
                        value={mapping[key] || ''}
                        onChange={e => setMapping(m => ({ ...m, [key]: e.target.value }))}
                        className="select-field text-xs py-1.5 flex-1"
                      >
                        <option value="">— Skip —</option>
                        {csvColumns.map(c => <option key={c} value={c}>{c}</option>)}
                        {mapping[key] && !csvColumns.includes(mapping[key]) && (
                          <option value={mapping[key]}>{mapping[key]} (preset)</option>
                        )}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="flex gap-3">
            <button onClick={() => setStep(0)} className="btn-ghost">← Back</button>
            <button onClick={handlePreview} disabled={loading} className="btn-primary">
              {loading ? 'Parsing file...' : 'Preview Import →'}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 2: Preview ─────────────────────────────────────────────── */}
      {step === 2 && previewData && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
            <div className="card p-4">
              <div className="stat-label">Raw Rows</div>
              <div className="text-2xl font-mono font-bold text-terminal-text">{previewData.total + (previewData.noise_count || 0)}</div>
            </div>
            <div className="card p-4">
              <div className="stat-label">Filtered Out</div>
              <div className="text-2xl font-mono font-bold text-terminal-dim">{previewData.noise_count || 0}</div>
              <div className="text-[10px] font-mono text-terminal-muted mt-0.5">SL/TP/orders/balance</div>
            </div>
            <div className="card p-4">
              <div className="stat-label">New Trades</div>
              <div className="text-2xl font-mono font-bold text-terminal-green">{previewData.new_count}</div>
            </div>
            <div className="card p-4">
              <div className="stat-label">Duplicates</div>
              <div className="text-2xl font-mono font-bold text-terminal-amber">{previewData.duplicate_count}</div>
            </div>
          </div>

          {previewData.new_count === 0 && (
            <div className="card p-4 border border-terminal-amber/50 bg-amber-950/20">
              <div className="text-xs font-mono text-terminal-amber">
                {previewData.duplicate_count > 0
                  ? `✓ All ${previewData.duplicate_count} trades already imported — no duplicates will be added.${previewData.balance_rows?.length > 0 ? ' Click below to save the detected withdrawal/deposit.' : ''}`
                  : `⚠️ No new trades found. Check that your column mapping is correct — especially P&L, Symbol, and Entry Date.`
                }
                {previewData.noise_count > 0 && ` ${previewData.noise_count} rows were filtered as noise.`}
              </div>
            </div>
          )}

          {previewData.balance_rows?.length > 0 && (
            <div className="card p-4 border border-terminal-green/30 bg-green-950/10">
              <div className="text-xs font-mono text-terminal-green mb-2 font-semibold">
                Deposits &amp; Withdrawals Detected
              </div>
              <div className="space-y-1">
                {previewData.balance_rows.map((r, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs font-mono">
                    <span className={`w-16 text-right font-semibold ${r.activity_type === 'deposit' ? 'text-terminal-green' : 'text-terminal-red'}`}>
                      {r.activity_type === 'deposit' ? '+' : ''}{new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(r.amount)}
                    </span>
                    <span className="text-terminal-muted">{r.date}</span>
                    <span className="text-terminal-dim">{r.activity_type.toUpperCase()}</span>
                    <span className="text-terminal-amber text-[10px]">{r.account}</span>
                    {r.notes && <span className="text-terminal-dim text-[10px]">{r.notes}</span>}
                  </div>
                ))}
              </div>
              <div className="text-[10px] font-mono text-terminal-muted mt-2">
                These will be saved automatically and used to set your real starting balance on the Withdrawal Plan.
              </div>
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="px-4 py-2 border-b border-terminal-border">
              <span className="stat-label">Preview (first 20 trades)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-terminal-surface border-b border-terminal-border">
                  <tr>
                    <th className="table-header">New?</th>
                    <th className="table-header">Account</th>
                    <th className="table-header">Symbol</th>
                    <th className="table-header">Position</th>
                    <th className="table-header">Entry</th>
                    <th className="table-header">Exit</th>
                    <th className="table-header">Lots</th>
                    <th className="table-header">P&L</th>
                    <th className="table-header">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {previewData.preview.map((r, i) => (
                    <tr key={i} className={`border-b border-terminal-border/50 ${r._isDuplicate ? 'opacity-40' : ''}`}>
                      <td className="table-cell">
                        {r._isDuplicate ? <span className="badge-be">SKIP</span> : <span className="badge-win">NEW</span>}
                      </td>
                      <td className="table-cell text-xs text-terminal-amber">{r.account || '—'}</td>
                      <td className="table-cell font-semibold">{r.symbol || '—'}</td>
                      <td className="table-cell">
                        <span className={r.position === 'Long' ? 'text-terminal-green' : 'text-terminal-red'}>{r.position || '—'}</span>
                      </td>
                      <td className="table-cell text-xs text-terminal-muted">{r.entry_datetime ? String(r.entry_datetime).slice(0,16) : '—'}</td>
                      <td className="table-cell text-xs text-terminal-muted">{r.exit_datetime ? String(r.exit_datetime).slice(0,16) : '—'}</td>
                      <td className="table-cell text-xs text-terminal-muted">{r.lot_size || '—'}</td>
                      <td className={`table-cell font-mono font-semibold ${r.pnl >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                        {r.pnl != null ? fmtCurrency(r.pnl, true) : '—'}
                      </td>
                      <td className="table-cell"><span className={statusBadgeClass(r.status)}>{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="btn-ghost">← Back</button>
            <button onClick={handleCommit} disabled={loading || (previewData.new_count === 0 && !previewData.balance_rows?.length)} className="btn-primary">
              {loading ? 'Importing...' : previewData.new_count > 0
                ? `Import ${previewData.new_count} Trades →`
                : previewData.balance_rows?.length > 0
                  ? `Save ${previewData.balance_rows.length} Withdrawal/Deposit →`
                  : 'Nothing to Import'}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3: Result ──────────────────────────────────────────────── */}
      {step === 3 && importResult && (
        <div className="space-y-4">
          <div className="card p-8 flex flex-col items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-green-950 border border-green-800 flex items-center justify-center">
              <Check className="w-6 h-6 text-terminal-green" />
            </div>
            <div className="text-lg font-mono font-semibold text-terminal-text">Import Complete</div>
            <div className="grid grid-cols-3 gap-6 w-full max-w-sm">
              <div className="text-center">
                <div className="text-2xl font-mono font-bold text-terminal-green">{importResult.imported}</div>
                <div className="stat-label mt-1">Imported</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-mono font-bold text-terminal-amber">{importResult.skipped}</div>
                <div className="stat-label mt-1">Skipped</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-mono font-bold text-terminal-red">{importResult.errors?.length || 0}</div>
                <div className="stat-label mt-1">Errors</div>
              </div>
            </div>
            {importResult.account_activity_inserted > 0 && (
              <div className="text-xs font-mono text-terminal-green bg-green-950/30 border border-terminal-green/30 px-4 py-2 rounded w-full max-w-sm text-center">
                {importResult.account_activity_inserted} deposit/withdrawal entr{importResult.account_activity_inserted === 1 ? 'y' : 'ies'} saved — Withdrawal Plan starting balance updated.
              </div>
            )}
          </div>

          {importResult.errors?.length > 0 && (
            <div className="card p-4 space-y-2">
              <div className="stat-label text-terminal-red">Import Errors</div>
              {importResult.errors.slice(0, 20).map((e, i) => (
                <div key={i} className="text-xs font-mono text-terminal-red bg-red-950/50 px-3 py-2 rounded">
                  Row {e.row}: {e.error}
                </div>
              ))}
              {importResult.errors.length > 20 && (
                <div className="text-xs font-mono text-terminal-muted">...and {importResult.errors.length - 20} more errors</div>
              )}
            </div>
          )}

          <button onClick={reset} className="btn-primary">Import Another File</button>
        </div>
      )}

      {/* ── MANAGE: Delete trades by account ─────────────────────────────── */}
      <div className="border-t border-terminal-border/50 pt-6">
        <div className="stat-label mb-3">Manage Imported Data</div>
        <div className="card p-4 space-y-3">
          <div className="text-xs font-mono text-terminal-muted">
            Remove all trades assigned to a specific account. Use this to clean up a bad import
            before re-importing with the correct settings.
          </div>
          <div className="flex items-end gap-3">
            <div className="space-y-1 flex-1 max-w-xs">
              <label className="text-xs font-mono text-terminal-dim">Select account to clear</label>
              <select
                value={deleteAccount}
                onChange={e => { setDeleteAccount(e.target.value); setDeleteResult(null); setDeleteError(''); }}
                className="select-field text-xs font-mono w-full"
              >
                <option value="">— Select account —</option>
                {accounts.map(a => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={handleDelete}
              disabled={!deleteAccount || deleteLoading}
              className="flex items-center gap-2 px-4 py-2 rounded border border-red-900 bg-red-950/30 text-xs font-mono text-terminal-red hover:bg-red-950/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {deleteLoading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Trash2 className="w-4 h-4" />
              }
              Delete All Trades
            </button>
          </div>
          {deleteResult && (
            <div className="flex items-center gap-2 text-xs font-mono text-terminal-green">
              <Check className="w-4 h-4" />
              Deleted {deleteResult.deleted ?? deleteResult.changes ?? '?'} trades.
            </div>
          )}
          {deleteError && (
            <div className="flex items-center gap-2 text-xs font-mono text-terminal-red">
              <AlertTriangle className="w-4 h-4" />
              {deleteError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
