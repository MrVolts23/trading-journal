import { useState } from 'react';
import { createAccount } from '../../lib/api';
import { PRODUCTS, SIZES, CURRENCIES, newAccount, pragueDate } from '../../lib/propRules';
import { loadPropStore, addPropAccount } from '../../lib/propStore';

const fmtUSD = (n) => '$' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');

// One form, used from Settings and from Prop Management.
// Creates the journal account (broker FTMO, starting balance = size, login stored so MT5 imports
// from the FTMO terminal match it) and the tracker account, linked to each other.
export default function NewFtmoAccountForm({ onCreate, onCancel, compact = false }) {
  const [product, setProduct] = useState('2step_standard');
  const [size, setSize] = useState(200000);
  const [currency, setCurrency] = useState('USD');
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [startDate, setStartDate] = useState(pragueDate());
  const [login, setLogin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const P = PRODUCTS[product];
  const existing = loadPropStore().accounts;
  const attempt = existing.filter((a) => a.product === product && a.size === size).length + 1;
  const name = `FTMO ${size / 1000}K #${attempt}${login.trim() ? ` (${login.trim()})` : ''}`;

  const create = async () => {
    setBusy(true); setErr(null);
    const acct = newAccount({ product, size, currency, phaseIndex, startDate, name });
    acct.login = login.trim() || null; acct.attempt = attempt; acct.events = []; acct.failed = false;
    try {
      const r = await createAccount({ name, broker: 'FTMO', currency, initial_deposit: size, deposit_date: startDate, broker_account_id: acct.login });
      acct.journalAccountId = r?.id ?? null; acct.journalAccountName = name;
    } catch (e) {
      acct.journalAccountId = null; acct.journalAccountName = null;
      setErr('The tracker account was created, but the journal account could not be: ' + (e?.response?.data?.error || e.message));
    }
    const store = addPropAccount(acct);
    setBusy(false);
    onCreate?.(acct, store);
  };

  const wrap = compact ? 'bg-terminal-surface border border-terminal-border rounded p-4 space-y-3' : 'card p-4 space-y-3';
  return (
    <div className={wrap}>
      <div className="stat-label">New FTMO account</div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <label className="space-y-1"><span className="text-xs font-mono text-terminal-muted block">Product</span>
          <select value={product} onChange={(e) => { setProduct(e.target.value); setPhaseIndex(0); }} className="select-field w-full text-xs py-1.5 font-mono">
            {Object.entries(PRODUCTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select></label>
        <label className="space-y-1"><span className="text-xs font-mono text-terminal-muted block">Account size</span>
          <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="select-field w-full text-xs py-1.5 font-mono">
            {SIZES.map((s) => <option key={s} value={s}>${s / 1000}K</option>)}
          </select></label>
        <label className="space-y-1"><span className="text-xs font-mono text-terminal-muted block">Currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="select-field w-full text-xs py-1.5 font-mono">
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select></label>
        <label className="space-y-1"><span className="text-xs font-mono text-terminal-muted block">Starting phase</span>
          <select value={phaseIndex} onChange={(e) => setPhaseIndex(Number(e.target.value))} className="select-field w-full text-xs py-1.5 font-mono">
            {P.phases.map((p, i) => <option key={p.key} value={i}>{p.label}</option>)}
          </select></label>
        <label className="space-y-1"><span className="text-xs font-mono text-terminal-muted block">Phase start (Prague day)</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="input-field w-full text-xs py-1.5 font-mono" /></label>
        <label className="space-y-1"><span className="text-xs font-mono text-terminal-muted block">FTMO login #</span>
          <input type="text" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="from the FTMO dashboard" className="input-field w-full text-xs py-1.5 font-mono" /></label>
      </div>
      <div className="text-xs font-mono text-terminal-muted">
        Journal account <span className="text-terminal-text">{name}</span> with a {fmtUSD(size)} starting balance. Imported trades from the FTMO terminal match on the login number, and phase resets post to this account.
      </div>
      <div className="text-xs font-mono text-terminal-dim">
        {P.label}: daily loss {P.dailyLoss * 100}% of the starting balance, max loss {P.maxLoss * 100}% {P.maxLossMode === 'trailing' ? '(trails up at each day close)' : '(fixed floor)'}, gold leverage 1:{P.goldLeverage}{P.minDays ? `, ${P.minDays} trading days per phase` : ''}{P.bestDay ? ', Best Day rule' : ''}.
      </div>
      {err && <div className="text-xs font-mono text-red-400">{err}</div>}
      <div className="flex gap-2">
        <button onClick={create} disabled={busy} className="btn-primary text-xs py-1.5 disabled:opacity-50">{busy ? 'Creating...' : 'Create FTMO account'}</button>
        <button onClick={onCancel} className="btn-ghost text-xs py-1.5">Cancel</button>
      </div>
    </div>
  );
}
