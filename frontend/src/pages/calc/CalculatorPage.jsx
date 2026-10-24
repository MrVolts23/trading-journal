import { useEffect, useState } from 'react';

// A plain calculator. Type or click; Enter = equals, Escape = clear, Backspace deletes. Percent, parentheses OK.
const KEYS = [['7', '8', '9', '÷'], ['4', '5', '6', '×'], ['1', '2', '3', '−'], ['0', '.', '%', '+'], ['(', ')', '⌫', '=']];
const toJs = (s) => s.replace(/÷/g, '/').replace(/×/g, '*').replace(/−/g, '-').replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
function evaluate(expr) {
  const js = toJs(expr);
  if (!/^[\d+\-*/().\s]+$/.test(js) || !js.trim()) return null;
  try { const v = Function(`"use strict"; return (${js});`)(); return Number.isFinite(v) ? v : null; } catch { return null; }
}

export default function CalculatorPage() {
  const [expr, setExpr] = useState('');
  const [history, setHistory] = useState(() => { try { return JSON.parse(localStorage.getItem('calc_history') || '[]'); } catch { return []; } });
  const live = evaluate(expr);
  const press = (k) => {
    if (k === '=') { if (live != null) { setHistory((h) => [{ e: expr, v: live }, ...h].slice(0, 20)); setExpr(String(live)); } return; }
    if (k === '⌫') { setExpr((s) => s.slice(0, -1)); return; }
    setExpr((s) => s + k);
  };
  useEffect(() => { try { localStorage.setItem('calc_history', JSON.stringify(history)); } catch { /* private mode */ } }, [history]);
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.id !== 'calc-input') return;
      if (e.key === 'Enter') { e.preventDefault(); press('='); }
      else if (e.key === 'Escape') setExpr('');
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr, live]);
  const fmt = (v) => (Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : String(+v.toFixed(10)));
  const key = 'h-12 rounded border border-terminal-border text-base font-mono text-terminal-text hover:bg-terminal-hover active:bg-terminal-surface';
  return (
    <div className="p-6 flex gap-6 flex-wrap">
      <div className="w-80 space-y-2">
        <h1 className="text-sm font-mono text-terminal-muted">Calculator</h1>
        <input id="calc-input" autoFocus value={expr} onChange={(e) => setExpr(e.target.value.replace(/[^\d+\-*/().%\s÷×−]/g, ''))} placeholder="0" className="input-field w-full text-right text-2xl font-mono py-2" />
        <div className="text-right text-sm font-mono text-amber-400 h-5">{live != null && expr && String(live) !== expr ? `= ${fmt(live)}` : ''}</div>
        <div className="grid grid-cols-4 gap-1.5">
          {KEYS.flat().map((k) => <button key={k} onClick={() => press(k)} className={`${key} ${k === '=' ? 'border-amber-400 text-amber-400' : /[÷×−+%]/.test(k) ? 'text-amber-400' : ''}`}>{k}</button>)}
          <button onClick={() => setExpr('')} className={`${key} col-span-4 text-terminal-muted`}>Clear (Esc)</button>
        </div>
        <p className="text-[10px] font-mono text-terminal-dim">Type freely: 4162.73 - 4156.09, (30.18/5.56), 2.5*1000, 15%*4000. Enter works it out.</p>
      </div>
      <div className="w-64 space-y-1">
        <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">Recent</div>
        {history.length === 0 && <p className="text-xs font-mono text-terminal-dim">Nothing yet.</p>}
        {history.map((h, i) => (
          <button key={i} onClick={() => setExpr(String(h.v))} className="w-full text-left text-xs font-mono text-terminal-muted hover:text-terminal-text truncate" title="Use this result">
            {h.e} <span className="text-terminal-text">= {fmt(h.v)}</span>
          </button>
        ))}
        {history.length > 0 && <button onClick={() => setHistory([])} className="text-[10px] font-mono text-terminal-dim hover:text-terminal-text">clear recent</button>}
      </div>
    </div>
  );
}
