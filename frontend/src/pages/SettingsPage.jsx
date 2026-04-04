import { useState, useEffect } from 'react';
import { Check, Plus, Trash2, AlertTriangle, X, Pencil, Save } from 'lucide-react';
import { getSettings, updateSettings, getAccounts, deleteAccount, getMistakeTypes, createMistakeType, updateMistakeType, deleteMistakeType, postBalanceCorrection, getAccountActivity, deleteAccountActivity } from '../lib/api';
import api from '../lib/api';

const BROKERS = ['EightCap', 'MetaTrader 5', 'IC Markets', 'Pepperstone', 'Other'];

// ── Mistake Types Card ─────────────────────────────────────────────────────
const PRESET_COLORS = [
  '#f59e0b','#f97316','#8b5cf6','#ef4444','#dc2626',
  '#b91c1c','#d97706','#6b7280','#0ea5e9','#10b981','#ec4899',
  '#3b82f6','#14b8a6','#a855f7','#84cc16',
];

function MistakeTypesCard() {
  const [types,   setTypes]   = useState([]);
  const [input,   setInput]   = useState('');
  const [color,   setColor]   = useState('#ef4444');
  const [editing, setEditing] = useState(null); // { id, name, color }
  const [error,   setError]   = useState('');

  useEffect(() => { getMistakeTypes().then(setTypes).catch(() => {}); }, []);

  const handleAdd = async () => {
    const name = input.trim();
    if (!name) return;
    try {
      const created = await createMistakeType({ name, color });
      setTypes(ts => [...ts, created]);
      setInput(''); setColor('#ef4444'); setError('');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const handleUpdate = async () => {
    if (!editing) return;
    try {
      const updated = await updateMistakeType(editing.id, { name: editing.name, color: editing.color });
      setTypes(ts => ts.map(t => t.id === updated.id ? updated : t));
      setEditing(null); setError('');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this mistake type? It will be removed from any lessons that use it.')) return;
    try {
      await deleteMistakeType(id);
      setTypes(ts => ts.filter(t => t.id !== id));
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  return (
    <div className="card p-5 space-y-4">
      <div className="stat-label">Mistake Types</div>
      <p className="text-xs font-mono text-terminal-muted">
        These appear in Key Lessons when logging a bad trade. Add your own to match your specific patterns.
        Analytics on the Key Lessons page are broken down by these categories.
      </p>

      {error && (
        <div className="text-xs font-mono text-terminal-red bg-red-950/30 border border-red-900/50 rounded px-3 py-2">{error}</div>
      )}

      {/* Existing types */}
      <div className="space-y-1.5">
        {types.length === 0 && (
          <div className="text-xs font-mono text-terminal-dim py-1">No mistake types — defaults load on first server start.</div>
        )}
        {types.map(mt => (
          <div key={mt.id}>
            {editing?.id === mt.id ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded border border-terminal-border bg-terminal-surface">
                <div className="w-4 h-4 rounded-full flex-shrink-0 border border-white/20" style={{ backgroundColor: editing.color }} />
                <input
                  value={editing.name}
                  onChange={e => setEditing(ev => ({ ...ev, name: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && handleUpdate()}
                  className="input-field text-sm flex-1 py-1"
                />
                <div className="flex gap-1">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setEditing(ev => ({ ...ev, color: c }))}
                      className="w-4 h-4 rounded-full transition-transform hover:scale-125 flex-shrink-0"
                      style={{ backgroundColor: c, outline: editing.color === c ? `2px solid ${c}` : 'none', outlineOffset: 2 }}
                    />
                  ))}
                </div>
                <button onClick={handleUpdate} className="text-terminal-green text-xs font-mono px-2 py-1 hover:bg-green-950/20 rounded">Save</button>
                <button onClick={() => setEditing(null)} className="text-terminal-dim text-xs font-mono px-2 py-1 hover:bg-terminal-hover/20 rounded">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center justify-between px-3 py-2 rounded border border-terminal-border bg-terminal-surface group">
                <div className="flex items-center gap-2.5">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: mt.color }} />
                  <span className="text-sm font-mono text-terminal-text">{mt.name}</span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => setEditing({ id: mt.id, name: mt.name, color: mt.color })}
                    className="p-1 text-terminal-dim hover:text-terminal-text transition-colors">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => handleDelete(mt.id)}
                    className="p-1 text-terminal-dim hover:text-terminal-red transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add new */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="w-4 h-4 rounded-full self-center flex-shrink-0 border border-white/20" style={{ backgroundColor: color }} />
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="e.g. Sized up too large, Didn't wait for confirmation…"
            className="input-field text-sm flex-1"
          />
          <button onClick={handleAdd} disabled={!input.trim()}
            className="btn-primary flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-40">
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {PRESET_COLORS.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className="w-5 h-5 rounded-full transition-transform hover:scale-125"
              style={{ backgroundColor: c, outline: color === c ? `2px solid ${c}` : 'none', outlineOffset: 2 }}
            />
          ))}
        </div>
        <p className="text-[10px] font-mono text-terminal-dim">Press Enter or click Add · Pick a colour for the badge · Hover a type to edit or delete</p>
      </div>
    </div>
  );
}

// ── Strategies Card ────────────────────────────────────────────────────────
function StrategiesCard({ settings, setSettings }) {
  const [input, setInput] = useState('');

  // getSettings() returns strategies already parsed as an array.
  // After local edits, it may be stored as a JSON string — handle both.
  const strategies = (() => {
    if (Array.isArray(settings.strategies)) return settings.strategies;
    try { return JSON.parse(settings.strategies || '[]'); } catch { return []; }
  })();

  // Always store as a plain array in local state so re-reads work correctly
  const update = (list) => setSettings(s => ({ ...s, strategies: list }));

  const addStrategy = () => {
    const name = input.trim();
    if (!name || strategies.includes(name)) return;
    update([...strategies, name]);
    setInput('');
  };

  const removeStrategy = (name) => update(strategies.filter(s => s !== name));

  return (
    <div className="card p-5 space-y-4">
      <div className="stat-label">Strategies</div>
      <p className="text-xs font-mono text-terminal-muted">
        These appear in the Trade Journal review panel and Trade Log filter. Add your playbook names here.
      </p>

      {/* Current list */}
      <div className="space-y-1.5">
        {strategies.length === 0 && (
          <div className="text-xs font-mono text-terminal-dim py-1">No strategies yet — add one below.</div>
        )}
        {strategies.map(name => (
          <div key={name} className="flex items-center justify-between px-3 py-2 rounded border border-terminal-border bg-terminal-surface">
            <span className="text-sm font-mono text-terminal-text">{name}</span>
            <button
              onClick={() => removeStrategy(name)}
              className="p-1 text-terminal-dim hover:text-terminal-red transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Add input */}
      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addStrategy()}
          placeholder="e.g. ASIA Scalp, NY Breakout…"
          className="input-field text-sm flex-1"
        />
        <button
          onClick={addStrategy}
          disabled={!input.trim()}
          className="btn-primary flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>
      <p className="text-[10px] font-mono text-terminal-dim">Press Enter or click Add · Changes save with the Save Settings button below.</p>
    </div>
  );
}

function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-terminal-card border border-terminal-border rounded-lg p-6 max-w-sm w-full shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-terminal-red flex-shrink-0" />
          <p className="text-sm font-mono text-terminal-text">{message}</p>
        </div>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="btn-ghost text-xs py-1.5">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-1.5 bg-red-900 border border-red-700 text-terminal-red text-xs font-mono rounded hover:bg-red-800 transition-colors">
            Yes, Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ── News Currencies Card ───────────────────────────────────────────────────────
const ALL_CURRENCIES = ['USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','CNY'];

function NewsCurrenciesCard() {
  const [selected, setSelected] = useState(() => {
    const saved = localStorage.getItem('news_currencies');
    return saved ? saved.split(',').map(s => s.trim()).filter(Boolean) : ['USD'];
  });
  const [saved, setSaved] = useState(false);

  const toggle = (c) => {
    setSelected(s => s.includes(c) ? s.filter(x => x !== c) : [...s, c]);
    setSaved(false);
  };

  const handleSave = () => {
    localStorage.setItem('news_currencies', selected.join(','));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="card p-5 space-y-4">
      <div className="stat-label">News Calendar Currencies</div>
      <p className="text-xs font-mono text-terminal-muted">
        Choose which currencies appear as ⚡ news indicators on your Trading Calendar.
        Data is pulled from Forex Factory (High + Medium impact events).
      </p>
      <div className="flex flex-wrap gap-2">
        {ALL_CURRENCIES.map(c => (
          <button
            key={c}
            onClick={() => toggle(c)}
            className={`px-3 py-1.5 rounded border text-xs font-mono font-semibold transition-colors ${
              selected.includes(c)
                ? 'bg-terminal-green/10 border-terminal-green text-terminal-green'
                : 'bg-transparent border-terminal-border text-terminal-muted hover:border-terminal-dim hover:text-terminal-text'
            }`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={selected.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-terminal-green/10 border border-terminal-green/40 text-terminal-green text-xs font-mono hover:bg-terminal-green/20 transition-colors disabled:opacity-40"
        >
          {saved ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save</>}
        </button>
        {selected.length === 0 && (
          <span className="text-[10px] font-mono text-terminal-red">Select at least one currency</span>
        )}
        {selected.length > 0 && !saved && (
          <span className="text-[10px] font-mono text-terminal-dim">Watching: {selected.join(', ')}</span>
        )}
      </div>
      <p className="text-[10px] font-mono text-terminal-dim">
        News data is fetched from Forex Factory via nfs.faireconomy.media and cached locally.
        Current &amp; next week data refreshes every 30 minutes. Historical months build up over time.
      </p>
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState({});
  const [accounts, setAccounts] = useState([]);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(null); // { type, account, accountId? }
  const [actionResult, setActionResult] = useState('');

  // New account form
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [newAccount, setNewAccount] = useState({ name: '', broker: 'EightCap', currency: 'USD', initial_deposit: '', deposit_date: '' });

  // Edit starting balance for existing accounts
  const [editDeposit, setEditDeposit] = useState({}); // { [accountId]: draftValue }
  const [depositSaved, setDepositSaved] = useState(null);

  // Balance correction per account
  const [correctionAmount, setCorrectionAmount] = useState({}); // { [accountId]: string }
  const [correctionDate, setCorrectionDate]     = useState({}); // { [accountId]: string }
  const [correctionNotes, setCorrectionNotes]   = useState({}); // { [accountId]: string }
  const [correctionSaved, setCorrectionSaved]   = useState(null); // accountId of last saved
  const [correctionHistory, setCorrectionHistory] = useState({}); // { [accountName]: [{id,date,amount,notes}] }

  const refreshAccounts = () => getAccounts().then(setAccounts);

  useEffect(() => {
    getSettings().then(setSettings);
    refreshAccounts();
  }, []);

  const save = async () => {
    await updateSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    // Persist journal name to localStorage so sidebar picks it up immediately
    const name = settings.journal_name || '';
    localStorage.setItem('journal_name', name);
    window.dispatchEvent(new CustomEvent('journal-name-changed', { detail: name }));
  };

  const handleAddAccount = async () => {
    if (!newAccount.name) return;
    try {
      await api.post('/accounts', {
        ...newAccount,
        initial_deposit: parseFloat(newAccount.initial_deposit) || 0,
      });
      setNewAccount({ name: '', broker: 'EightCap', currency: 'USD', initial_deposit: '', deposit_date: '' });
      setShowAddAccount(false);
      refreshAccounts();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to add account');
    }
  };

  const handleClearTrades = async (account) => {
    try {
      const res = await api.delete(`/trades/clear-account/${encodeURIComponent(account)}`);
      setActionResult(`✓ Deleted ${res.data.deleted} trades from ${account}`);
      setTimeout(() => setActionResult(''), 4000);
    } catch (e) {
      setActionResult('Error: ' + (e.response?.data?.error || e.message));
    }
    setConfirm(null);
  };

  const handleCleanNoise = async (account) => {
    try {
      const res = await api.delete(`/trades/clean-noise/${encodeURIComponent(account)}`);
      setActionResult(`✓ Removed ${res.data.deleted} SL/TP/noise entries from ${account}`);
      setTimeout(() => setActionResult(''), 4000);
    } catch (e) {
      setActionResult('Error: ' + (e.response?.data?.error || e.message));
    }
    setConfirm(null);
  };

  const handleSaveDeposit = async (accountId) => {
    try {
      await api.patch(`/accounts/${accountId}`, { initial_deposit: parseFloat(editDeposit[accountId]) || 0 });
      setDepositSaved(accountId);
      setTimeout(() => setDepositSaved(null), 2000);
      refreshAccounts();
    } catch (e) {
      setActionResult('Error saving balance: ' + (e.response?.data?.error || e.message));
    }
  };

  const loadCorrectionHistory = async (accountName) => {
    try {
      const all = await getAccountActivity({ account: accountName });
      const corrections = all.filter(r => r.activity_type === 'correction');
      setCorrectionHistory(h => ({ ...h, [accountName]: corrections }));
    } catch (_) {}
  };

  const handleApplyCorrection = async (accountId, accountName) => {
    const amount = parseFloat(correctionAmount[accountId]);
    if (isNaN(amount) || amount === 0) {
      setActionResult('Enter a non-zero correction amount (e.g. +250 or -150).');
      setTimeout(() => setActionResult(''), 4000);
      return;
    }
    try {
      await postBalanceCorrection(accountId, {
        amount,
        date: correctionDate[accountId] || new Date().toISOString().slice(0, 10),
        notes: correctionNotes[accountId] || null,
      });
      setCorrectionSaved(accountId);
      setCorrectionAmount(d => ({ ...d, [accountId]: '' }));
      setCorrectionNotes(d => ({ ...d, [accountId]: '' }));
      setTimeout(() => setCorrectionSaved(null), 3000);
      setActionResult(`✓ Balance correction of ${amount >= 0 ? '+' : ''}${amount.toFixed(2)} applied to ${accountName}`);
      setTimeout(() => setActionResult(''), 4000);
      loadCorrectionHistory(accountName);
    } catch (e) {
      setActionResult('Error applying correction: ' + (e.response?.data?.error || e.message));
      setTimeout(() => setActionResult(''), 4000);
    }
  };

  const handleDeleteCorrection = async (entryId, accountName) => {
    try {
      await deleteAccountActivity(entryId);
      setCorrectionHistory(h => ({
        ...h,
        [accountName]: (h[accountName] || []).filter(r => r.id !== entryId),
      }));
    } catch (e) {
      setActionResult('Error deleting correction: ' + (e.response?.data?.error || e.message));
      setTimeout(() => setActionResult(''), 4000);
    }
  };

  const handleDeleteAccount = async (accountId, accountName) => {
    try {
      const res = await deleteAccount(accountId);
      setActionResult(`✓ Deleted account "${accountName}" and ${res.tradesDeleted} trades`);
      setTimeout(() => setActionResult(''), 5000);
      refreshAccounts();
    } catch (e) {
      setActionResult('Error: ' + (e.response?.data?.error || e.message));
    }
    setConfirm(null);
  };

  return (
    <div className="p-6 max-w-2xl space-y-6">
      {confirm && (
        <ConfirmModal
          message={
            confirm.type === 'clear'
              ? `Delete ALL trades and balance history for ${confirm.account}? This resets the account to $0. Cannot be undone.`
              : confirm.type === 'delete-account'
              ? `Permanently delete the account "${confirm.account}" and ALL its trades and balance history? This cannot be undone.`
              : `Remove all Stop Loss / Take Profit / noise entries for ${confirm.account}?`
          }
          onConfirm={() =>
            confirm.type === 'clear'        ? handleClearTrades(confirm.account) :
            confirm.type === 'delete-account' ? handleDeleteAccount(confirm.accountId, confirm.account) :
            handleCleanNoise(confirm.account)
          }
          onCancel={() => setConfirm(null)}
        />
      )}

      <h1 className="text-lg font-mono font-semibold text-terminal-text">Settings</h1>

      {actionResult && (
        <div className={`text-xs font-mono px-3 py-2 rounded border ${actionResult.startsWith('✓') ? 'bg-green-950 border-green-800 text-terminal-green' : 'bg-red-950 border-red-900 text-terminal-red'}`}>
          {actionResult}
        </div>
      )}

      {/* ── ACCOUNTS ────────────────────────────────────────────────────── */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="stat-label">Accounts</div>
          <button onClick={() => setShowAddAccount(v => !v)} className="btn-ghost flex items-center gap-1.5 py-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" /> Add Account
          </button>
        </div>

        {/* Add Account Form */}
        {showAddAccount && (
          <div className="bg-terminal-surface border border-terminal-border rounded p-4 space-y-3">
            <div className="stat-label">New Account</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-mono text-terminal-muted block mb-1">Account Name *</label>
                <input
                  value={newAccount.name}
                  onChange={e => setNewAccount(a => ({ ...a, name: e.target.value }))}
                  placeholder="e.g. EightCap Sub 2"
                  className="input-field text-xs py-1.5 w-full"
                />
              </div>
              <div>
                <label className="text-xs font-mono text-terminal-muted block mb-1">Broker</label>
                <select value={newAccount.broker} onChange={e => setNewAccount(a => ({ ...a, broker: e.target.value }))} className="select-field text-xs py-1.5 w-full">
                  {BROKERS.map(b => <option key={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-mono text-terminal-muted block mb-1">Currency</label>
                <input value={newAccount.currency} onChange={e => setNewAccount(a => ({ ...a, currency: e.target.value }))} className="input-field text-xs py-1.5 w-full" />
              </div>
              <div>
                <label className="text-xs font-mono text-terminal-muted block mb-1">Initial Deposit ($)</label>
                <input type="number" value={newAccount.initial_deposit} onChange={e => setNewAccount(a => ({ ...a, initial_deposit: e.target.value }))} placeholder="0.00" className="input-field text-xs py-1.5 w-full" />
              </div>
              <div>
                <label className="text-xs font-mono text-terminal-muted block mb-1">Deposit Date</label>
                <input type="date" value={newAccount.deposit_date} onChange={e => setNewAccount(a => ({ ...a, deposit_date: e.target.value }))} className="input-field text-xs py-1.5 w-full" />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddAccount} className="btn-primary text-xs py-1.5">Save Account</button>
              <button onClick={() => setShowAddAccount(false)} className="btn-ghost text-xs py-1.5">Cancel</button>
            </div>
          </div>
        )}

        {/* Account List */}
        {accounts.map(a => (
          <div key={a.id} className="border border-terminal-border rounded p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-mono font-semibold text-terminal-text">{a.name}</div>
                <div className="text-xs font-mono text-terminal-muted">{a.broker} · {a.currency}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="badge-open">Active</span>
                <button
                  onClick={() => setConfirm({ type: 'delete-account', account: a.name, accountId: a.id })}
                  className="p-1 text-terminal-dim hover:text-terminal-red transition-colors"
                  title="Delete account"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            {/* Starting balance editor */}
            <div className="flex items-center gap-2 pt-2">
              <label className="text-xs font-mono text-terminal-muted w-36 flex-shrink-0">Starting Balance ($)</label>
              <input
                type="number"
                value={editDeposit[a.id] !== undefined ? editDeposit[a.id] : (a.initial_deposit || '')}
                onChange={e => setEditDeposit(d => ({ ...d, [a.id]: e.target.value }))}
                placeholder="e.g. 18981"
                className="input-field text-xs py-1 w-36"
              />
              <button
                onClick={() => handleSaveDeposit(a.id)}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-terminal-green/10 border border-terminal-green/30 text-terminal-green text-xs font-mono hover:bg-terminal-green/20 transition-colors"
              >
                {depositSaved === a.id ? <><Check className="w-3 h-3" /> Saved</> : <><Save className="w-3 h-3" /> Save</>}
              </button>
            </div>

            {/* Balance Correction */}
            <div className="pt-2 border-t border-terminal-border/50 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-mono text-terminal-amber uppercase tracking-widest">Balance Correction</div>
                <button
                  onClick={() => loadCorrectionHistory(a.name)}
                  className="text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors"
                >
                  View History
                </button>
              </div>
              <p className="text-[10px] font-mono text-terminal-dim">
                Apply a signed adjustment to correct balance drift. Positive adds funds, negative subtracts.
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  type="number"
                  value={correctionAmount[a.id] || ''}
                  onChange={e => setCorrectionAmount(d => ({ ...d, [a.id]: e.target.value }))}
                  placeholder="+250.00 or -150.00"
                  step="0.01"
                  className="input-field text-xs py-1 w-40"
                />
                <input
                  type="date"
                  value={correctionDate[a.id] || new Date().toISOString().slice(0, 10)}
                  onChange={e => setCorrectionDate(d => ({ ...d, [a.id]: e.target.value }))}
                  className="input-field text-xs py-1 w-36"
                />
                <input
                  type="text"
                  value={correctionNotes[a.id] || ''}
                  onChange={e => setCorrectionNotes(d => ({ ...d, [a.id]: e.target.value }))}
                  placeholder="Optional note…"
                  className="input-field text-xs py-1 flex-1 min-w-[120px]"
                />
                <button
                  onClick={() => handleApplyCorrection(a.id, a.name)}
                  disabled={!correctionAmount[a.id]}
                  className="flex items-center gap-1 px-3 py-1 rounded bg-amber-900/30 border border-amber-700/50 text-amber-400 text-xs font-mono hover:bg-amber-900/50 transition-colors disabled:opacity-40"
                >
                  {correctionSaved === a.id ? <><Check className="w-3 h-3" /> Applied!</> : 'Correct Balance'}
                </button>
              </div>

              {/* Correction history */}
              {correctionHistory[a.name] && (
                <div className="space-y-1 pt-1">
                  {correctionHistory[a.name].length === 0 && (
                    <div className="text-[10px] font-mono text-terminal-dim">No corrections on record.</div>
                  )}
                  {correctionHistory[a.name].map(entry => (
                    <div key={entry.id} className="flex items-center justify-between px-2 py-1 rounded bg-terminal-surface border border-terminal-border/50">
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-mono font-semibold ${entry.amount >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                          {entry.amount >= 0 ? '+' : ''}{Number(entry.amount).toFixed(2)}
                        </span>
                        <span className="text-[10px] font-mono text-terminal-muted">{entry.date}</span>
                        {entry.notes && <span className="text-[10px] font-mono text-terminal-dim italic truncate max-w-[160px]">{entry.notes}</span>}
                      </div>
                      <button
                        onClick={() => handleDeleteCorrection(entry.id, a.name)}
                        className="p-1 text-terminal-dim hover:text-terminal-red transition-colors"
                        title="Delete this correction"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-1 border-t border-terminal-border/50">
              <button
                onClick={() => setConfirm({ type: 'noise', account: a.name })}
                className="text-xs font-mono text-terminal-amber hover:text-amber-400 transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Remove SL/TP Noise
              </button>
              <span className="text-terminal-border">·</span>
              <button
                onClick={() => setConfirm({ type: 'clear', account: a.name })}
                className="text-xs font-mono text-terminal-red hover:text-red-400 transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Clear All Trades
              </button>
            </div>
          </div>
        ))}

        {/* Clean noise across all accounts */}
        <div className="pt-2 border-t border-terminal-border">
          <button
            onClick={() => setConfirm({ type: 'noise', account: 'All' })}
            className="text-xs font-mono text-terminal-amber hover:text-amber-400 transition-colors flex items-center gap-1.5"
          >
            <Trash2 className="w-3 h-3" /> Remove SL/TP Noise — All Accounts
          </button>
        </div>
      </div>

      {/* ── NEWS CURRENCIES ─────────────────────────────────────────────── */}
      <NewsCurrenciesCard />

      {/* ── TRADING CONFIG ───────────────────────────────────────────────── */}
      <div className="card p-5 space-y-4">
        <div className="stat-label">Trading Configuration</div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-mono text-terminal-text">Journal Name</label>
              <div className="text-[10px] font-mono text-terminal-dim mt-0.5">Updates sidebar instantly</div>
            </div>
            <input
              value={settings.journal_name || ''}
              onChange={e => {
                const name = e.target.value;
                setSettings(s => ({ ...s, journal_name: name }));
                localStorage.setItem('journal_name', name);
                window.dispatchEvent(new CustomEvent('journal-name-changed', { detail: name }));
              }}
              placeholder="e.g. Mike's Journal"
              className="input-field text-xs py-1.5 w-48"
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-mono text-terminal-text">Base Currency</label>
            <input value={settings.base_currency || 'USD'} onChange={e => setSettings(s => ({ ...s, base_currency: e.target.value }))} className="input-field text-xs py-1.5 w-24 text-center" />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-mono text-terminal-text">Withdrawal Target %</label>
            <input type="number"
              value={settings.withdrawal_pct ? (parseFloat(settings.withdrawal_pct) * 100).toFixed(0) : 25}
              onChange={e => setSettings(s => ({ ...s, withdrawal_pct: String(parseFloat(e.target.value) / 100) }))}
              className="input-field text-xs py-1.5 w-24 text-center" min="1" max="100" />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-mono text-terminal-text">Synology Sync Path</label>
            <input value={settings.synology_path || ''} onChange={e => setSettings(s => ({ ...s, synology_path: e.target.value }))}
              placeholder="/Volumes/Synology/..." className="input-field text-xs py-1.5 w-64" />
          </div>
        </div>
      </div>

      {/* ── STRATEGIES ───────────────────────────────────────────────────── */}
      <StrategiesCard settings={settings} setSettings={setSettings} />

      {/* ── MISTAKE TYPES ────────────────────────────────────────────────── */}
      <MistakeTypesCard />

      <button onClick={save} className="btn-primary flex items-center gap-2">
        {saved ? <><Check className="w-4 h-4" /> Saved!</> : 'Save Settings'}
      </button>
    </div>
  );
}
