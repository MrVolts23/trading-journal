import { useState, useEffect, useCallback } from 'react';
import { Beaker, RefreshCw } from 'lucide-react';
import { gmaGetVentures, gmaGetExperiments } from '../lib/api';

const fmtR = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v + 'R');
const rColor = (v) => (v == null ? 'text-terminal-dim' : v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-terminal-muted');

function parseExp(e) {
  let params = {}, results = null;
  try { params = JSON.parse(e.params); } catch {}
  try { results = e.result_metrics ? JSON.parse(e.result_metrics) : null; } catch {}
  return { ...e, p: params, r: results };
}

// Entry × Exit matrix for the Combo Lab
function ComboMatrix({ experiments }) {
  const done = experiments.filter((e) => e.r?.full);
  const entries = [...new Set(done.map((e) => e.p.entry_label))];
  const exits = [...new Set(done.map((e) => e.p.exit_label))];
  if (!done.length) return <div className="p-4 text-xs font-mono text-terminal-dim">No baked combos yet — the nightly baker fills this.</div>;
  return (
    <div className="overflow-x-auto p-3">
      <table className="text-xs font-mono border-collapse">
        <thead>
          <tr>
            <th className="text-left px-3 py-2 text-terminal-dim">entry ↓ / exit →</th>
            {exits.map((x) => <th key={x} className="px-3 py-2 text-terminal-dim text-left">{x}</th>)}
          </tr>
        </thead>
        <tbody>
          {entries.map((en) => (
            <tr key={en} className="border-t border-terminal-border">
              <td className="px-3 py-2 text-terminal-text whitespace-nowrap">{en}</td>
              {exits.map((x) => {
                const e = done.find((d) => d.p.entry_label === en && d.p.exit_label === x);
                return (
                  <td key={x} className="px-3 py-2 whitespace-nowrap">
                    {e ? (
                      <div>
                        <span className={rColor(e.r.full.net_r)}>{fmtR(e.r.full.net_r)}</span>
                        <span className="text-terminal-dim"> pf {e.r.full.pf ?? '—'} · {e.r.full.trades}t</span>
                        <div className="text-[10px] text-terminal-dim">oos <span className={rColor(e.r.oos?.net_r)}>{fmtR(e.r.oos?.net_r)}</span></div>
                      </div>
                    ) : <span className="text-terminal-dim">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[10px] font-mono text-terminal-dim">
        full period +R / profit factor / trade count · oos = out-of-sample (last 30%, untouched by tuning)
      </div>
    </div>
  );
}

function ExperimentTable({ experiments }) {
  return (
    <table className="w-full text-xs font-mono">
      <thead className="text-terminal-dim">
        <tr>
          <th className="text-left px-3 py-2">Experiment</th>
          <th className="text-left px-3 py-2">Status</th>
          <th className="text-left px-3 py-2">Full</th>
          <th className="text-left px-3 py-2">OOS</th>
          <th className="text-left px-3 py-2">Why it was run</th>
        </tr>
      </thead>
      <tbody>
        {experiments.map((e) => (
          <tr key={e.id} className="border-t border-terminal-border align-top">
            <td className="px-3 py-2 text-terminal-text whitespace-nowrap">
              {e.p.entry_label || e.p.rule || e.p.grid || e.p.feature || e.p.type || 'experiment #' + e.id}
              {e.p.exit_label && <span className="text-terminal-dim"> × {e.p.exit_label}</span>}
            </td>
            <td className={`px-3 py-2 ${e.status === 'done' ? 'text-green-400' : e.status === 'planned' ? 'text-amber-400' : 'text-red-400'}`}>{e.status}</td>
            <td className="px-3 py-2 whitespace-nowrap">
              {e.r?.full ? (
                <><span className={rColor(e.r.full.net_r)}>{fmtR(e.r.full.net_r)}</span>
                <span className="text-terminal-dim"> pf {e.r.full.pf ?? '—'} dd {e.r.full.dd ?? '—'}R</span></>
              ) : <span className="text-terminal-dim">{e.score != null ? 'score ' + e.score : '—'}</span>}
            </td>
            <td className="px-3 py-2 whitespace-nowrap">
              {e.r?.oos ? <span className={rColor(e.r.oos.net_r)}>{fmtR(e.r.oos.net_r)}</span> : '—'}
            </td>
            <td className="px-3 py-2 text-terminal-muted max-w-md">{e.rationale}</td>
          </tr>
        ))}
        {!experiments.length && (
          <tr><td colSpan="5" className="px-3 py-5 text-center text-terminal-dim">Nothing here yet.</td></tr>
        )}
      </tbody>
    </table>
  );
}

export default function LabPage() {
  const [labs, setLabs] = useState([]);          // ventures whose name contains 'Lab'
  const [active, setActive] = useState(null);
  const [experiments, setExperiments] = useState([]);

  const refresh = useCallback(() => {
    gmaGetVentures().then((vs) => {
      const l = vs.filter((v) => /lab/i.test(v.name));
      setLabs(l);
      if (l.length && active == null) setActive(l[0].id);
    });
  }, [active]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (active != null) gmaGetExperiments(active).then((es) => setExperiments(es.map(parseExp)));
  }, [active]);

  const activeLab = labs.find((l) => l.id === active);
  const isCombo = activeLab && /combo/i.test(activeLab.name);
  const planned = experiments.filter((e) => e.status === 'planned').length;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Beaker className="w-5 h-5 text-terminal-green" />
          <h1 className="text-lg font-mono text-terminal-text">The Lab</h1>
          <span className="text-xs font-mono text-terminal-dim">
            experiments bake nightly (1:00am, local math, zero tokens) — planner queues, baker executes, you judge
          </span>
        </div>
        <button onClick={() => { refresh(); if (active != null) gmaGetExperiments(active).then((es) => setExperiments(es.map(parseExp))); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-terminal-border">
        {labs.map((l) => (
          <button key={l.id} onClick={() => setActive(l.id)} title={l.description}
            className={`px-3 py-1.5 text-xs font-mono rounded-t border border-b-0 ${
              l.id === active ? 'border-terminal-border bg-terminal-surface text-terminal-green' : 'border-transparent text-terminal-dim hover:text-terminal-text'}`}>
            {l.name.replace(' — Double BOS', '')}
          </button>
        ))}
      </div>

      {activeLab && (
        <div className="text-xs font-mono text-terminal-muted">{activeLab.description}
          {planned > 0 && <span className="text-amber-400 ml-2">· {planned} queued for tonight's bake</span>}
        </div>
      )}

      <div className="border border-terminal-border rounded-lg overflow-hidden">
        {isCombo
          ? <ComboMatrix experiments={experiments} />
          : <ExperimentTable experiments={experiments.slice().sort((a, b) => (b.score ?? -999) - (a.score ?? -999))} />}
      </div>
    </div>
  );
}
