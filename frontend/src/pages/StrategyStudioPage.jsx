import { useState, useEffect, useRef, useCallback } from 'react';
import { GitBranch, Upload, Trash2, ChevronUp, ChevronDown, Archive, Camera } from 'lucide-react';
import {
  gmaGetStrategies, gmaGetStrategy, gmaPatchStrategy, gmaAddExample, gmaDeleteExample,
} from '../lib/api';

const LIFECYCLE_ORDER = ['idea', 'in_sample', 'out_of_sample', 'demo', 'promoted'];
const LIFECYCLE_STYLE = {
  idea:          'text-terminal-dim border-terminal-border',
  in_sample:     'text-blue-400 border-blue-600/50',
  out_of_sample: 'text-purple-400 border-purple-600/50',
  demo:          'text-amber-400 border-amber-600/50',
  promoted:      'text-green-400 border-green-600/50',
  retired:       'text-terminal-dim border-terminal-border line-through',
};

function Badge({ lifecycle }) {
  return (
    <span className={`px-2 py-0.5 rounded border text-[10px] font-mono uppercase tracking-wide ${LIFECYCLE_STYLE[lifecycle] || ''}`}>
      {lifecycle.replace('_', ' ')}
    </span>
  );
}

function Lightbox({ src, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center cursor-zoom-out p-4">
      <img src={src} alt="fullscreen" className="max-w-full max-h-full object-contain rounded" />
    </div>
  );
}

// Cumulative-R equity curve from a trade log
function EquityCurve({ trades, width = 640, height = 120 }) {
  if (!trades?.length) return null;
  let cum = 0;
  const pts = [{ x: 0, y: 0 }, ...trades.map((t, i) => ({ x: i + 1, y: (cum += t.r) }))];
  const ys = pts.map((p) => p.y);
  const min = Math.min(...ys, 0), max = Math.max(...ys, 0.5);
  const X = (x) => (x / (pts.length - 1)) * (width - 8) + 4;
  const Y = (y) => height - 14 - ((y - min) / (max - min)) * (height - 28);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1].y;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      <line x1="4" x2={width - 4} y1={Y(0)} y2={Y(0)} stroke="#30363d" strokeDasharray="3,3" />
      <path d={path} fill="none" stroke={last >= 0 ? '#22c55e' : '#ef4444'} strokeWidth="1.5" />
      <text x={width - 6} y={Y(last) - 4} fill={last >= 0 ? '#22c55e' : '#ef4444'} fontSize="10"
        fontFamily="monospace" textAnchor="end">{last.toFixed(1)}R</text>
    </svg>
  );
}

function MetricsRow({ label, m }) {
  if (!m || !m.trades) return (
    <tr className="border-t border-terminal-border">
      <td className="px-3 py-2 text-terminal-muted">{label}</td>
      <td colSpan="6" className="px-3 py-2 text-terminal-dim">no trades</td>
    </tr>
  );
  return (
    <tr className="border-t border-terminal-border">
      <td className="px-3 py-2 text-terminal-muted">{label}</td>
      <td className="px-3 py-2 text-terminal-text">{m.trades}</td>
      <td className="px-3 py-2 text-terminal-text">{(m.winrate * 100).toFixed(0)}%</td>
      <td className={`px-3 py-2 ${m.net_r >= 0 ? 'text-green-400' : 'text-red-400'}`}>{m.net_r > 0 ? '+' : ''}{m.net_r}R</td>
      <td className="px-3 py-2 text-terminal-text">{m.expectancy_r}</td>
      <td className="px-3 py-2 text-terminal-text">{m.profit_factor ?? '—'}</td>
      <td className="px-3 py-2 text-terminal-text">{m.max_dd_r}R</td>
    </tr>
  );
}

export default function StrategyStudioPage() {
  const [strategies, setStrategies] = useState([]);
  const [selected, setSelected] = useState(null);   // full detail object
  const [lightbox, setLightbox] = useState(null);
  const [caption, setCaption] = useState('');
  const fileRef = useRef(null);

  const refreshList = useCallback(() => gmaGetStrategies().then(setStrategies), []);
  const openDetail = useCallback((id) => gmaGetStrategy(id).then(setSelected), []);

  useEffect(() => {
    refreshList().then(() => {});
  }, [refreshList]);
  useEffect(() => {
    if (!selected && strategies.length) openDetail(strategies[0].id);
  }, [strategies, selected, openDetail]);

  const setLifecycle = async (lc) => {
    await gmaPatchStrategy(selected.id, { lifecycle: lc });
    await openDetail(selected.id);
    refreshList();
  };

  const uploadExample = (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      await gmaAddExample(selected.id, { image: e.target.result, caption: caption || null });
      setCaption('');
      openDetail(selected.id);
      refreshList();
    };
    reader.readAsDataURL(file);
  };

  const lcIdx = selected ? LIFECYCLE_ORDER.indexOf(selected.lifecycle) : -1;
  const fullBt = selected?.backtests?.find((b) => b.split === 'full');

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-2">
        <GitBranch className="w-5 h-5 text-terminal-green" />
        <h1 className="text-lg font-mono text-terminal-text">Strategy Studio</h1>
        <span className="text-xs font-mono text-terminal-dim">Gold Metal Alchemist · registry & human gates</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Registry list */}
        <div className="border border-terminal-border rounded-lg overflow-hidden self-start">
          <div className="px-3 py-2 bg-terminal-surface text-xs font-mono text-terminal-dim">Registry</div>
          {strategies.map((s) => (
            <div key={s.id} onClick={() => openDetail(s.id)}
              className={`px-3 py-2.5 border-t border-terminal-border cursor-pointer hover:bg-terminal-surface ${selected?.id === s.id ? 'bg-terminal-surface' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-mono text-terminal-text">{s.name}</span>
                <Badge lifecycle={s.lifecycle} />
              </div>
              <div className="mt-1 text-[11px] font-mono text-terminal-dim">
                {s.created_by} · {s.family} · {s.example_count} playbook pics
                {s.latest_metrics.full?.net_r != null && (
                  <span className={s.latest_metrics.full.net_r >= 0 ? ' text-green-400' : ' text-red-400'}>
                    {' '}· {s.latest_metrics.full.net_r > 0 ? '+' : ''}{s.latest_metrics.full.net_r}R
                  </span>
                )}
              </div>
            </div>
          ))}
          {!strategies.length && <div className="px-3 py-6 text-center text-xs font-mono text-terminal-dim">Registry empty.</div>}
        </div>

        {/* Detail */}
        {selected && (
          <div className="lg:col-span-2 space-y-4">
            <div className="border border-terminal-border rounded-lg bg-terminal-surface p-4 space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-mono text-terminal-text">{selected.name}</span>
                    <Badge lifecycle={selected.lifecycle} />
                  </div>
                  <p className="mt-2 text-xs font-mono text-terminal-muted leading-relaxed max-w-xl">{selected.hypothesis}</p>
                </div>
                {/* Human gates */}
                <div className="flex gap-2">
                  {lcIdx > 0 && lcIdx < LIFECYCLE_ORDER.length && selected.lifecycle !== 'retired' && (
                    <button onClick={() => setLifecycle(LIFECYCLE_ORDER[lcIdx - 1])}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-amber-400">
                      <ChevronDown className="w-3.5 h-3.5" /> Demote
                    </button>
                  )}
                  {lcIdx >= 0 && lcIdx < LIFECYCLE_ORDER.length - 1 && selected.lifecycle !== 'retired' && (
                    <button onClick={() => setLifecycle(LIFECYCLE_ORDER[lcIdx + 1])}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-green-400">
                      <ChevronUp className="w-3.5 h-3.5" /> Promote → {LIFECYCLE_ORDER[lcIdx + 1].replace('_', ' ')}
                    </button>
                  )}
                  <button onClick={() => setLifecycle('retired')}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-dim hover:text-red-400">
                    <Archive className="w-3.5 h-3.5" /> Retire
                  </button>
                </div>
              </div>
              {selected.notes && <div className="text-[11px] font-mono text-terminal-dim border-t border-terminal-border pt-2">{selected.notes}</div>}
            </div>

            {/* Backtests */}
            <div className="border border-terminal-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-terminal-surface text-xs font-mono text-terminal-dim">Latest backtests</div>
              <table className="w-full text-xs font-mono">
                <thead className="text-terminal-dim">
                  <tr>
                    <th className="text-left px-3 py-1.5">Split</th><th className="text-left px-3 py-1.5">Trades</th>
                    <th className="text-left px-3 py-1.5">Win</th><th className="text-left px-3 py-1.5">Net</th>
                    <th className="text-left px-3 py-1.5">Exp/R</th><th className="text-left px-3 py-1.5">PF</th>
                    <th className="text-left px-3 py-1.5">MaxDD</th>
                  </tr>
                </thead>
                <tbody>
                  {['in_sample', 'out_of_sample', 'full'].map((split) => (
                    <MetricsRow key={split} label={split.replace('_', ' ')}
                      m={selected.backtests.find((b) => b.split === split)?.metrics} />
                  ))}
                </tbody>
              </table>
              {fullBt?.trade_log?.length > 0 && (
                <div className="px-3 py-2 border-t border-terminal-border overflow-x-auto">
                  <div className="text-[10px] font-mono text-terminal-dim mb-1">Equity (cumulative R, full period)</div>
                  <EquityCurve trades={fullBt.trade_log} />
                </div>
              )}
            </div>

            {/* Playbook */}
            <div className="border border-terminal-border rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-terminal-surface text-xs font-mono text-terminal-dim flex items-center justify-between">
                <span className="flex items-center gap-1.5"><Camera className="w-3.5 h-3.5" />
                  Playbook — your marked-up trade screenshots teach the machine this setup</span>
              </div>
              <div className="p-3 space-y-3">
                <div className="flex gap-2">
                  <input value={caption} onChange={(e) => setCaption(e.target.value)}
                    placeholder="What you saw / did on this one (optional caption)…"
                    className="flex-1 bg-transparent border border-terminal-border rounded px-2 py-1.5 text-xs font-mono text-terminal-text placeholder:text-terminal-dim outline-none focus:border-terminal-green" />
                  <button onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-green hover:border-terminal-green">
                    <Upload className="w-3.5 h-3.5" /> Upload example
                  </button>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => uploadExample(e.target.files[0])} />
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  {selected.examples.map((ex) => (
                    <div key={ex.id} className="relative group border border-terminal-border rounded overflow-hidden">
                      <img src={ex.image} alt={ex.caption || 'playbook example'}
                        onClick={() => setLightbox(ex.image)}
                        className="w-full h-28 object-cover cursor-zoom-in" />
                      {ex.caption && <div className="px-2 py-1 text-[10px] font-mono text-terminal-muted truncate">{ex.caption}</div>}
                      <button onClick={() => gmaDeleteExample(ex.id).then(() => openDetail(selected.id))}
                        className="absolute top-1.5 right-1.5 p-1 rounded bg-black/70 text-terminal-red opacity-0 group-hover:opacity-100 border border-terminal-red/40">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {!selected.examples.length && (
                    <div className="col-span-full py-4 text-center text-xs font-mono text-terminal-dim">
                      No examples yet — upload marked-up screenshots of trades you'd take, and the next
                      calibration session reads them to write v2 rules.
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
