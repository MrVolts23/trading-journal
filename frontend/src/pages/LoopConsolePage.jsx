import { useState, useEffect, useCallback } from 'react';
import { Activity, AlertTriangle, Check, RefreshCw, Scale } from 'lucide-react';
import {
  gmaGetStatus, gmaGetRuns, gmaGetEscalations, gmaPatchEscalation, gmaGetRecon, gmaIngestRun,
} from '../lib/api';

export default function LoopConsolePage() {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [escalations, setEscalations] = useState([]);
  const [recon, setRecon] = useState([]);
  const [ingestMsg, setIngestMsg] = useState('');

  const refresh = useCallback(() => {
    gmaGetStatus().then(setStatus).catch(() => {});
    gmaGetRuns().then(setRuns).catch(() => {});
    gmaGetEscalations().then(setEscalations).catch(() => {});
    gmaGetRecon().then(setRecon).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const runIngest = async () => {
    setIngestMsg('running…');
    try {
      const r = await gmaIngestRun();
      setIngestMsg(`snapshots +${r.snapshots}, deals +${r.deals}, trades +${r.trades_created}`);
      refresh();
    } catch (e) {
      setIngestMsg(`failed: ${e.response?.data?.error || e.message}`);
    }
  };

  const budgetPct = status ? Math.min(100, (status.budget.spent_today_usd / status.budget.daily_cap_usd) * 100) : 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-terminal-green" />
          <h1 className="text-lg font-mono text-terminal-text">Loop Console</h1>
        </div>
        <div className="flex items-center gap-3">
          {ingestMsg && <span className="text-xs font-mono text-terminal-dim">{ingestMsg}</span>}
          <button onClick={runIngest}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text">
            <RefreshCw className="w-3.5 h-3.5" /> Ingest MT5 now
          </button>
        </div>
      </div>

      {/* Budget */}
      {status && (
        <div className="border border-terminal-border rounded-lg bg-terminal-surface p-4">
          <div className="flex justify-between text-xs font-mono text-terminal-muted mb-2">
            <span>Daily token budget</span>
            <span>${status.budget.spent_today_usd.toFixed(2)} / ${status.budget.daily_cap_usd.toFixed(2)}
              · {status.budget.runs_today} runs today</span>
          </div>
          <div className="h-2 rounded bg-terminal-border overflow-hidden">
            <div className={`h-full ${budgetPct >= 100 ? 'bg-red-500' : budgetPct > 70 ? 'bg-amber-500' : 'bg-terminal-green'}`}
              style={{ width: `${budgetPct}%` }} />
          </div>
        </div>
      )}

      {/* Escalations */}
      <div className="border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-terminal-surface text-xs font-mono text-terminal-dim flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> Waiting on you ({escalations.length})
        </div>
        {escalations.length ? escalations.map((e) => (
          <div key={e.id} className="border-t border-terminal-border px-3 py-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-mono text-terminal-text">{e.title}</div>
              <div className="text-xs font-mono text-terminal-dim mt-0.5">
                {e.loop_name} · {e.created_at} {e.status === 'acked' && '· acked'}
              </div>
              {e.detail && <div className="text-xs font-mono text-terminal-muted mt-1 whitespace-pre-wrap">{e.detail}</div>}
            </div>
            <div className="flex gap-2 flex-shrink-0">
              {e.status === 'open' && (
                <button onClick={() => gmaPatchEscalation(e.id, 'acked').then(refresh)}
                  className="px-2 py-1 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text">Ack</button>
              )}
              <button onClick={() => gmaPatchEscalation(e.id, 'resolved').then(refresh)}
                className="px-2 py-1 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-green-400">
                <Check className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )) : <div className="px-3 py-4 text-center text-xs font-mono text-terminal-dim">Nothing waiting. Loops are quiet.</div>}
      </div>

      {/* Run history */}
      <div className="border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-terminal-surface text-xs font-mono text-terminal-dim">Recent loop runs</div>
        <table className="w-full text-xs font-mono">
          <tbody>
            {runs.slice(0, 25).map((r) => (
              <tr key={r.id} className="border-t border-terminal-border">
                <td className="px-3 py-2 text-terminal-text whitespace-nowrap">{r.loop_name}</td>
                <td className={`px-3 py-2 whitespace-nowrap ${
                  r.status === 'done' ? 'text-green-400'
                  : r.status === 'failed' ? 'text-red-400'
                  : r.status.startsWith('skipped') ? 'text-amber-400' : 'text-terminal-muted'}`}>
                  {r.status}
                </td>
                <td className="px-3 py-2 text-terminal-dim whitespace-nowrap">{r.started_at}</td>
                <td className="px-3 py-2 text-terminal-dim whitespace-nowrap">${(r.cost_usd || 0).toFixed(2)}</td>
                <td className="px-3 py-2 text-terminal-muted">{r.summary ? r.summary.slice(0, 140) : ''}</td>
              </tr>
            ))}
            {!runs.length && (
              <tr><td className="px-3 py-4 text-center text-terminal-dim">
                No runs yet. Test one with: node loops/run.js recon
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Reconciliation */}
      <div className="border border-terminal-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-terminal-surface text-xs font-mono text-terminal-dim flex items-center gap-1.5">
          <Scale className="w-3.5 h-3.5" /> Balance reconciliation (journal vs MT5)
        </div>
        <table className="w-full text-xs font-mono">
          <tbody>
            {recon.slice(0, 14).map((r) => (
              <tr key={r.id} className="border-t border-terminal-border">
                <td className="px-3 py-2 text-terminal-text">{r.date}</td>
                <td className="px-3 py-2 text-terminal-muted">journal ${r.journal_balance?.toFixed(2) ?? '—'}</td>
                <td className="px-3 py-2 text-terminal-muted">MT5 ${r.mt5_balance?.toFixed(2) ?? '—'}</td>
                <td className={`px-3 py-2 ${Math.abs(r.delta || 0) < 1 ? 'text-green-400' : 'text-amber-400'}`}>
                  Δ ${r.delta?.toFixed(2) ?? '—'}
                </td>
                <td className={`px-3 py-2 ${
                  r.status === 'matched' ? 'text-green-400'
                  : r.status === 'flagged' ? 'text-red-400' : 'text-terminal-muted'}`}>{r.status}</td>
              </tr>
            ))}
            {!recon.length && (
              <tr><td className="px-3 py-4 text-center text-terminal-dim">
                No reconciliation runs yet — starts once the MT5 exporter is live.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
