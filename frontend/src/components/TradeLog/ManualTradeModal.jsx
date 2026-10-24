import { useState } from 'react';
import { X } from 'lucide-react';
import * as api from '../../lib/api';

const STRATEGIES = ['ASIA Scalp', 'ASIA Check Six', 'Asia Flag', 'NY DUMBNESS'];
const MARKETS = ['METAL', 'FOREX'];
const STATUSES = ['WIN', 'LOSS', 'B/E', 'OPEN'];
const GRADES = ['A', 'B', 'C', 'D'];

const empty = {
  account: 'EightCap', symbol: '', market: 'METAL', position: 'Long',
  strategy: 'ASIA Scalp', entry_datetime: '', entry_price: '',
  exit_datetime: '', exit_price: '', lot_size: '', stop_loss: '',
  take_profit: '', commission: '', pnl: '', status: 'OPEN',
  grade: '', lessons: '',
};

export default function ManualTradeModal({ onClose, onSaved }) {
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.symbol) return setError('Symbol is required');
    if (!form.entry_datetime) return setError('Entry date/time is required');
    setSaving(true);
    setError('');
    try {
      const payload = { ...form };
      ['entry_price','exit_price','lot_size','stop_loss','take_profit','commission','pnl'].forEach(k => {
        payload[k] = payload[k] !== '' ? parseFloat(payload[k]) : null;
      });
      await api.default.post('/trades', payload);
      onSaved();
      onClose();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-terminal-card border border-terminal-border rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-terminal-border">
          <h2 className="text-sm font-mono font-semibold text-terminal-text">New Manual Trade</h2>
          <button onClick={onClose} className="p-1 text-terminal-muted hover:text-terminal-red transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {error && <div className="text-xs font-mono text-terminal-red bg-red-950/50 border border-red-900 rounded px-3 py-2">{error}</div>}

          {/* Row 1: Account, Symbol, Market, Position */}
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="stat-label block mb-1">Account</label>
              <input value={form.account} onChange={e => set('account', e.target.value)} className="input-field text-xs py-1.5 w-full" />
            </div>
            <div>
              <label className="stat-label block mb-1">Symbol *</label>
              <input value={form.symbol} onChange={e => set('symbol', e.target.value.toUpperCase())} placeholder="XAUUSD" className="input-field text-xs py-1.5 w-full" />
            </div>
            <div>
              <label className="stat-label block mb-1">Market</label>
              <select value={form.market} onChange={e => set('market', e.target.value)} className="select-field text-xs py-1.5 w-full">
                {MARKETS.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="stat-label block mb-1">Position</label>
              <select value={form.position} onChange={e => set('position', e.target.value)} className="select-field text-xs py-1.5 w-full">
                <option>Long</option>
                <option>Short</option>
              </select>
            </div>
          </div>

          {/* Row 2: Strategy, Status */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="stat-label block mb-1">Strategy</label>
              <select value={form.strategy} onChange={e => set('strategy', e.target.value)} className="select-field text-xs py-1.5 w-full">
                {STRATEGIES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="stat-label block mb-1">Status</label>
              <select value={form.status} onChange={e => set('status', e.target.value)} className="select-field text-xs py-1.5 w-full">
                {STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Row 3: Entry datetime + price */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="stat-label block mb-1">Entry Date & Time *</label>
              <input type="datetime-local" value={form.entry_datetime} onChange={e => set('entry_datetime', e.target.value)} className="input-field text-xs py-1.5 w-full" />
            </div>
            <div>
              <label className="stat-label block mb-1">Entry Price</label>
              <input type="number" step="any" value={form.entry_price} onChange={e => set('entry_price', e.target.value)} placeholder="0.00" className="input-field text-xs py-1.5 w-full" />
            </div>
          </div>

          {/* Row 4: Exit datetime + price */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="stat-label block mb-1">Exit Date & Time</label>
              <input type="datetime-local" value={form.exit_datetime} onChange={e => set('exit_datetime', e.target.value)} className="input-field text-xs py-1.5 w-full" />
            </div>
            <div>
              <label className="stat-label block mb-1">Exit Price</label>
              <input type="number" step="any" value={form.exit_price} onChange={e => set('exit_price', e.target.value)} placeholder="0.00" className="input-field text-xs py-1.5 w-full" />
            </div>
          </div>

          {/* Row 5: Lot size, SL, TP, Commission */}
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="stat-label block mb-1">Lot Size</label>
              <input type="number" step="any" value={form.lot_size} onChange={e => set('lot_size', e.target.value)} placeholder="0.01" className="input-field text-xs py-1.5 w-full" />
            </div>
            <div>
              <label className="stat-label block mb-1">Stop Loss</label>
              <input type="number" step="any" value={form.stop_loss} onChange={e => set('stop_loss', e.target.value)} className="input-field text-xs py-1.5 w-full" />
            </div>
            <div>
              <label className="stat-label block mb-1">Take Profit</label>
              <input type="number" step="any" value={form.take_profit} onChange={e => set('take_profit', e.target.value)} className="input-field text-xs py-1.5 w-full" />
            </div>
            <div>
              <label className="stat-label block mb-1">Commission</label>
              <input type="number" step="any" value={form.commission} onChange={e => set('commission', e.target.value)} placeholder="0.00" className="input-field text-xs py-1.5 w-full" />
            </div>
          </div>

          {/* Row 6: P&L */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="stat-label block mb-1">P&L ($)</label>
              <input type="number" step="any" value={form.pnl} onChange={e => set('pnl', e.target.value)} placeholder="0.00" className="input-field text-xs py-1.5 w-full" />
            </div>
          </div>

          {/* Row 7: Grade + Lessons */}
          <div>
            <label className="stat-label block mb-1">Execution Grade & Notes</label>
            <div className="flex gap-2">
              <select
                value={form.grade}
                onChange={e => set('grade', e.target.value)}
                className="select-field text-sm font-mono font-bold py-2 w-20 flex-shrink-0"
              >
                <option value="">—</option>
                {GRADES.map(g => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
              <textarea
                value={form.lessons}
                onChange={e => set('lessons', e.target.value)}
                placeholder="What happened? What did you learn? Any setup notes..."
                rows={3}
                className="input-field text-xs py-2 flex-1 resize-none"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-terminal-border">
          <button onClick={onClose} className="btn-ghost text-xs">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary text-xs">
            {saving ? 'Saving...' : 'Save Trade'}
          </button>
        </div>
      </div>
    </div>
  );
}
