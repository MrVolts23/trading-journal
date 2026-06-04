import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, X, Upload, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { getSettings, updateSettings, getDailySetup, saveDailySetup } from '../lib/api';
import { fmtCurrency } from '../lib/utils';

// Local-time ISO date (yyyy-mm-dd) — avoids UTC off-by-one from toISOString()
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isoOf(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const BLANK = {
  chart1: '', chart2: '', chart3: '',
  check1: false, check2: false, check3: false,
  outcome: '', rValue: '', notes: '',
};

const labelCls = 'text-[11px] font-mono uppercase tracking-widest text-terminal-dim';
const inputCls = 'bg-terminal-card border border-terminal-border rounded px-2.5 py-1.5 text-sm font-mono text-terminal-text focus:outline-none focus:border-terminal-green';

// ── Inline-editable label (click to rename) ────────────────────────────────────
function EditableLabel({ value, onChange, className = '' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== value) onChange(v); else setDraft(value);
  };
  if (editing) {
    return (
      <input
        autoFocus value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className="bg-terminal-bg border border-terminal-green rounded px-1.5 py-0.5 text-sm font-mono text-terminal-text focus:outline-none w-full"
        onClick={e => e.stopPropagation()}
      />
    );
  }
  return (
    <button onClick={() => setEditing(true)} title="Click to rename" className={`${className} hover:text-terminal-text transition-colors text-left truncate`}>
      {value}
    </button>
  );
}

// ── Chart upload slot ──────────────────────────────────────────────────────────
function ChartBox({ label, onLabelChange, value, onChange }) {
  const inputRef = useRef(null);
  const pick = () => inputRef.current?.click();
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(reader.result);
    reader.readAsDataURL(file);
    e.target.value = '';
  };
  return (
    <div className="relative group rounded border border-terminal-border bg-terminal-card overflow-hidden flex flex-col min-h-[150px] xl:min-h-0 h-full">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-terminal-border flex-shrink-0">
        <EditableLabel value={label} onChange={onLabelChange} className={labelCls} />
        {value && (
          <button onClick={() => onChange('')} className="text-terminal-dim hover:text-terminal-red transition-colors" title="Remove chart">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {value ? (
        <button onClick={pick} className="flex-1 min-h-0 bg-black/30" title="Click to replace">
          <img src={value} alt={label} className="w-full h-full object-contain" />
        </button>
      ) : (
        <button onClick={pick} className="flex-1 flex flex-col items-center justify-center gap-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-hover transition-colors">
          <Upload className="w-6 h-6" />
          <span className="text-xs font-mono">Click to upload</span>
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/*" onChange={onFile} className="hidden" />
    </div>
  );
}

// ── Yes/No toggle ──────────────────────────────────────────────────────────────
function Toggle({ on, onClick }) {
  return (
    <button onClick={onClick} className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-terminal-green' : 'bg-terminal-border'}`} title={on ? 'Yes' : 'No'}>
      <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

// ── Month calendar (pick the trading day) ──────────────────────────────────────
function MiniCalendar({ value, onChange }) {
  const init = value ? value.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1, 1];
  const [view, setView] = useState({ y: init[0], m: init[1] - 1 }); // m 0-indexed

  useEffect(() => {
    if (!value) return;
    const [y, m] = value.split('-').map(Number);
    setView(v => (v.y === y && v.m === m - 1) ? v : { y, m: m - 1 });
  }, [value]);

  const firstDow   = (new Date(view.y, view.m, 1).getDay() + 6) % 7; // Mon = 0
  const daysInMon  = new Date(view.y, view.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMon; d++) cells.push(d);

  const step = (dir) => setView(v => {
    const nm = v.m + dir;
    if (nm < 0)  return { y: v.y - 1, m: 11 };
    if (nm > 11) return { y: v.y + 1, m: 0 };
    return { y: v.y, m: nm };
  });

  return (
    <div className="rounded border border-terminal-border bg-terminal-card p-3">
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => step(-1)} className="text-terminal-dim hover:text-terminal-text"><ChevronLeft className="w-4 h-4" /></button>
        <span className="text-xs font-mono text-terminal-text">{MONTHS[view.m]} {view.y}</span>
        <button onClick={() => step(1)} className="text-terminal-dim hover:text-terminal-text"><ChevronRight className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-7 gap-1 mb-1">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div key={i} className="text-center text-[10px] font-mono text-terminal-dim">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const iso = isoOf(view.y, view.m, d);
          const selected = iso === value;
          return (
            <button
              key={i}
              onClick={() => onChange(iso)}
              className={`aspect-square rounded text-xs font-mono transition-colors ${
                selected
                  ? 'bg-terminal-green text-black font-semibold'
                  : 'text-terminal-muted hover:bg-terminal-hover hover:text-terminal-text'
              }`}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DailySetupPage() {
  const [symbols, setSymbols]       = useState([]);
  const [activeSymbol, setActive]   = useState('');
  const [date, setDate]             = useState(todayIso());
  const [balance, setBalance]       = useState('');
  const [riskPct, setRiskPct]       = useState('1');
  const [checklist, setChecklist]   = useState(['Checklist 1', 'Checklist 2', 'Checklist 3']);
  const [chartLabels, setChartLabels] = useState(['Chart 1', 'Chart 2', 'Chart 3']);
  const [entry, setEntry]           = useState(BLANK);
  const [addingSymbol, setAdding]   = useState(false);
  const [newSymbol, setNewSymbol]   = useState('');
  const [status, setStatus]         = useState('');

  const hydrating = useRef(true);
  const saveTimer = useRef(null);

  // Initial config load
  useEffect(() => {
    getSettings().then(s => {
      const syms = Array.isArray(s?.daily_setup_symbols) && s.daily_setup_symbols.length ? s.daily_setup_symbols : ['Gold', 'NQ'];
      setSymbols(syms);
      setActive(syms[0] || '');
      if (Array.isArray(s?.daily_setup_checklist) && s.daily_setup_checklist.length === 3) setChecklist(s.daily_setup_checklist);
      if (Array.isArray(s?.daily_setup_chart_labels) && s.daily_setup_chart_labels.length === 3) setChartLabels(s.daily_setup_chart_labels);
      if (s?.daily_setup_balance != null && s.daily_setup_balance !== '') setBalance(String(s.daily_setup_balance));
      if (s?.daily_setup_risk_pct != null && s.daily_setup_risk_pct !== '') setRiskPct(String(s.daily_setup_risk_pct));
    }).catch(() => { setSymbols(['Gold', 'NQ']); setActive('Gold'); });
  }, []);

  // Load entry on (symbol, date) change
  useEffect(() => {
    if (!activeSymbol || !date) return;
    hydrating.current = true;
    getDailySetup(activeSymbol, date).then(row => {
      setEntry({
        chart1: row?.chart1 || '', chart2: row?.chart2 || '', chart3: row?.chart3 || '',
        check1: !!row?.check1, check2: !!row?.check2, check3: !!row?.check3,
        outcome: row?.outcome || '',
        rValue: row?.r_value != null ? String(row.r_value) : '',
        notes: row?.notes || '',
      });
      setStatus('');
      setTimeout(() => { hydrating.current = false; }, 0);
    }).catch(() => { hydrating.current = false; });
  }, [activeSymbol, date]);

  const persist = useCallback(() => {
    if (!activeSymbol || !date) return;
    setStatus('saving');
    saveDailySetup({
      symbol: activeSymbol, trade_date: date,
      chart1: entry.chart1, chart2: entry.chart2, chart3: entry.chart3,
      check1: entry.check1, check2: entry.check2, check3: entry.check3,
      outcome: entry.outcome || null, r_value: entry.rValue,
      balance_used: balance, risk_pct: riskPct, notes: entry.notes,
    }).then(() => setStatus('saved')).catch(() => setStatus(''));
  }, [activeSymbol, date, entry, balance, riskPct]);

  useEffect(() => {
    if (hydrating.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(persist, 700);
    return () => clearTimeout(saveTimer.current);
  }, [persist]);

  useEffect(() => {
    if (hydrating.current) return;
    const t = setTimeout(() => {
      updateSettings({ daily_setup_balance: balance, daily_setup_risk_pct: riskPct }).catch(() => {});
    }, 700);
    return () => clearTimeout(t);
  }, [balance, riskPct]);

  const set = (patch) => setEntry(e => ({ ...e, ...patch }));
  const saveSymbols = (next) => { setSymbols(next); updateSettings({ daily_setup_symbols: next }).catch(() => {}); };
  const renameChecklist = (i, val) => {
    const next = checklist.map((c, idx) => idx === i ? val : c);
    setChecklist(next); updateSettings({ daily_setup_checklist: next }).catch(() => {});
  };
  const renameChart = (i, val) => {
    const next = chartLabels.map((c, idx) => idx === i ? val : c);
    setChartLabels(next); updateSettings({ daily_setup_chart_labels: next }).catch(() => {});
  };
  const addSymbol = () => {
    const name = newSymbol.trim();
    if (!name || symbols.includes(name)) { setAdding(false); setNewSymbol(''); return; }
    saveSymbols([...symbols, name]); setActive(name); setNewSymbol(''); setAdding(false);
  };
  const removeSymbol = (name) => {
    const next = symbols.filter(s => s !== name);
    saveSymbols(next);
    if (activeSymbol === name) setActive(next[0] || '');
  };

  // $ math: 1R = (risk% × balance); win → +, loss → −
  const bal = parseFloat(balance), risk = parseFloat(riskPct);
  const oneR = (!isNaN(bal) && !isNaN(risk)) ? bal * (risk / 100) : null;
  const rNum = parseFloat(entry.rValue);
  const dollar = (oneR != null && !isNaN(rNum) && entry.outcome)
    ? (entry.outcome === 'loss' ? -1 : 1) * Math.abs(rNum) * oneR : null;

  return (
    <div className="p-3 h-full flex flex-col gap-2.5 min-h-0">
      {/* ── Symbol switcher (top) ───────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap flex-shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`${labelCls} mr-1`}>Symbol</span>
          {symbols.map(sym => (
            <div key={sym} className="relative group">
              <button
                onClick={() => setActive(sym)}
                className={`px-4 py-1.5 rounded text-sm font-mono border transition-colors ${
                  activeSymbol === sym
                    ? 'bg-terminal-green/15 border-terminal-green text-terminal-green'
                    : 'bg-terminal-card border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-dim'
                }`}
              >{sym}</button>
              {symbols.length > 1 && (
                <button onClick={() => removeSymbol(sym)} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-terminal-surface border border-terminal-border text-terminal-dim hover:text-terminal-red opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center" title={`Remove ${sym}`}>
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          ))}
          {addingSymbol ? (
            <input autoFocus value={newSymbol} onChange={e => setNewSymbol(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addSymbol(); if (e.key === 'Escape') { setAdding(false); setNewSymbol(''); } }}
              onBlur={addSymbol} placeholder="Symbol…" className={`${inputCls} w-28`} />
          ) : (
            <button onClick={() => setAdding(true)} className="px-2 py-1.5 rounded text-terminal-dim hover:text-terminal-green border border-dashed border-terminal-border hover:border-terminal-green transition-colors" title="Add symbol">
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="w-16 text-right">
          {status === 'saving' && <span className="text-[11px] font-mono text-terminal-dim">Saving…</span>}
          {status === 'saved'  && <span className="text-[11px] font-mono text-terminal-green flex items-center justify-end gap-1"><Check className="w-3 h-3" /> Saved</span>}
        </div>
      </div>

      {/* ── 2×2 quadrant: Chart 1 | Chart 2 / Chart 3 | Data cluster ─────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 xl:grid-rows-2 gap-3 flex-1 min-h-0">
        {/* Info box — top-left quadrant */}
        <div className="rounded border border-terminal-border bg-terminal-surface p-3 space-y-2.5 overflow-auto min-h-0">
          {/* Calendar + Checklist side by side */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="sm:w-[230px] flex-shrink-0 space-y-1.5">
              <div className={labelCls}>Trading Day</div>
              <MiniCalendar value={date} onChange={setDate} />
            </div>
            <div className="flex-1 space-y-2">
              <div className={labelCls}>Checklist</div>
              {[0, 1, 2].map(i => {
                const key = `check${i + 1}`;
                return (
                  <div key={key} className="flex items-center justify-between gap-2 rounded border border-terminal-border bg-terminal-card px-2.5 py-1.5">
                    <EditableLabel value={checklist[i]} onChange={v => renameChecklist(i, v)} className="text-xs font-mono text-terminal-text flex-1 min-w-0" />
                    <Toggle on={entry[key]} onClick={() => set({ [key]: !entry[key] })} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Outcome + balance/risk + result */}
          <div className="border-t border-terminal-border pt-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className={labelCls}>Outcome</span>
              <div className="flex gap-2">
                <button onClick={() => set({ outcome: entry.outcome === 'win' ? '' : 'win' })}
                  className={`px-4 py-1.5 rounded text-sm font-mono border transition-colors ${entry.outcome === 'win' ? 'bg-terminal-green/15 border-terminal-green text-terminal-green' : 'bg-terminal-card border-terminal-border text-terminal-muted hover:text-terminal-text'}`}>Winner</button>
                <button onClick={() => set({ outcome: entry.outcome === 'loss' ? '' : 'loss' })}
                  className={`px-4 py-1.5 rounded text-sm font-mono border transition-colors ${entry.outcome === 'loss' ? 'bg-terminal-red/15 border-terminal-red text-terminal-red' : 'bg-terminal-card border-terminal-border text-terminal-muted hover:text-terminal-text'}`}>Loss</button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="space-y-1">
                <div className={labelCls}>Balance</div>
                <input type="number" inputMode="decimal" placeholder="10000" value={balance} onChange={e => setBalance(e.target.value)} className={`${inputCls} w-full`} />
              </label>
              <label className="space-y-1">
                <div className={labelCls}>Risk/R %</div>
                <input type="number" inputMode="decimal" step="0.25" placeholder="1" value={riskPct} onChange={e => setRiskPct(e.target.value)} className={`${inputCls} w-full`} />
              </label>
              <label className="space-y-1">
                <div className={labelCls}>R value</div>
                <input type="number" inputMode="decimal" step="0.1" placeholder="0.0" value={entry.rValue} onChange={e => set({ rValue: e.target.value })} className={`${inputCls} w-full text-right`} />
              </label>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-terminal-dim">1R = {oneR != null ? fmtCurrency(oneR) : '—'}</span>
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-mono text-terminal-muted">Result</span>
                <span className={`text-xl font-mono font-semibold ${dollar == null ? 'text-terminal-dim' : dollar >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                  {dollar == null ? '—' : `${dollar >= 0 ? '+' : ''}${fmtCurrency(dollar)}`}
                </span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <div className={labelCls}>Notes</div>
            <textarea value={entry.notes} onChange={e => set({ notes: e.target.value })} rows={2} placeholder="Notes on this day's trade…"
              className="w-full bg-terminal-card border border-terminal-border rounded px-2.5 py-2 text-sm font-mono text-terminal-text focus:outline-none focus:border-terminal-green resize-y" />
          </div>
        </div>

        {/* Charts fill the remaining three quadrants */}
        <ChartBox label={chartLabels[0]} onLabelChange={v => renameChart(0, v)} value={entry.chart1} onChange={v => set({ chart1: v })} />
        <ChartBox label={chartLabels[1]} onLabelChange={v => renameChart(1, v)} value={entry.chart2} onChange={v => set({ chart2: v })} />
        <ChartBox label={chartLabels[2]} onLabelChange={v => renameChart(2, v)} value={entry.chart3} onChange={v => set({ chart3: v })} />
      </div>
    </div>
  );
}
