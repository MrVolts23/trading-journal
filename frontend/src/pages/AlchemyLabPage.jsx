import { useState, useEffect, useCallback } from 'react';
import { FlaskConical, Upload, Eye, EyeOff, Check, X, HelpCircle, RotateCcw } from 'lucide-react';
import {
  gmaGetDays, gmaGetDay, gmaPostVerdict, gmaGetAgreement, gmaCalendarImport, gmaUndoVerdict,
  gmaGetVentures, gmaPeek,
} from '../lib/api';

// Bar timestamps are MT5 server wall-clock stored as UTC-ish seconds; server runs 10h ahead
// of Pacific year-round (UTC+3/EEST vs UTC-7/PDT, UTC+2 vs UTC-8 in winter).
const SERVER_TO_PT_SECONDS = 10 * 3600;
function ptTime(t) {
  const d = new Date((t - SERVER_TO_PT_SECONDS) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function ptDate(t) {
  const d = new Date((t - SERVER_TO_PT_SECONDS) * 1000);
  return d.toISOString().slice(5, 10); // MM-DD
}
function rangeLabel(bars, barMinutes) {
  if (!bars?.length) return '';
  const first = bars[0].t, last = bars[bars.length - 1].t + barMinutes * 60;
  return `${ptDate(first)} ${ptTime(first)} → ${ptDate(last)} ${ptTime(last)} PT`;
}

// ── SVG candle chart (renders OHLC bars; flips applied to the DATA mapping) ────
function CandleChart({ bars, width = 560, height = 200, flipH = false, flipV = false, accent, label }) {
  if (!bars || !bars.length) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center border border-terminal-border rounded text-terminal-dim text-xs font-mono">
        no data
      </div>
    );
  }
  const seq = flipH ? bars.slice().reverse() : bars;
  const highs = seq.map((b) => b.high ?? b.h);
  const lows = seq.map((b) => b.low ?? b.l);
  let min = Math.min(...lows), max = Math.max(...highs);
  const pad = (max - min) * 0.05 || 1;
  min -= pad; max += pad;
  // Vertical flip = invert the price axis mapping
  const y = (p) => flipV
    ? ((p - min) / (max - min)) * height
    : height - ((p - min) / (max - min)) * height;
  const n = seq.length;
  const step = width / n;
  const cw = Math.max(1, Math.min(step * 0.7, 9));

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      {label && (
        <text x="4" y="12" fill="#8b949e" fontSize="10" fontFamily="ui-monospace, monospace">
          {label}
        </text>
      )}
      {seq.map((b, i) => {
        const o = b.open ?? b.o, c = b.close ?? b.c, h = b.high ?? b.h, l = b.low ?? b.l;
        // A "vertical flip" also flips bull/bear: color by rendered direction
        const rawUp = c >= o;
        const up = flipV ? !rawUp : rawUp;
        const color = accent || (up ? '#22c55e' : '#ef4444');
        const x = i * step + step / 2;
        const top = y(Math.max(o, c)), bot = y(Math.min(o, c));
        const [bodyY, bodyH] = top <= bot ? [top, Math.max(1, bot - top)] : [bot, Math.max(1, top - bot)];
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(h)} y2={y(l)} stroke={color} strokeWidth="1" />
            <rect x={x - cw / 2} y={bodyY} width={cw} height={bodyH} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}

const CODES = [
  { value: 'none',  label: 'None',   flipH: false, flipV: false },
  { value: 'flipH', label: 'Flip H', flipH: true,  flipV: false },
  { value: 'flipV', label: 'Flip V', flipH: false, flipV: true  },
  { value: 'both',  label: 'Both',   flipH: true,  flipV: true  },
];

// ── Verdict card: blind call first, machine reveal after ──────────────────────
function VerdictCard({ dayId, onVerdict }) {
  const [day, setDay] = useState(null);
  const [reveal, setReveal] = useState(null); // { machine_code } after human commits
  const [peek, setPeek] = useState(null);     // machine call shown pre-verdict (non-blind)
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    setReveal(null);
    setPeek(null);
    gmaGetDay(dayId).then(setDay).catch(() => setDay(null));
  }, [dayId]);

  if (!day) return null;
  const keyBars = day.key_ohlc ? JSON.parse(day.key_ohlc) : null;
  const printBars = day.print_ohlc ? JSON.parse(day.print_ohlc) : null;
  const alreadyCalled = day.verdict?.human_code;

  const commit = async (code) => {
    setPosting(true);
    try {
      const res = await gmaPostVerdict(day.id, { human_code: code, venture_id: day.verdict?.venture_id || 1 });
      setReveal({
        human: code,
        machine: res.machine_code,
        scores: res.machine_scores || null,
        confidence: res.machine_confidence,
      });
      onVerdict?.();
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="border border-terminal-border rounded-lg bg-terminal-surface p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-mono text-sm text-terminal-text">
          {day.date} · {day.symbol} — day print
          {day.print_range && <span className="text-terminal-dim ml-2">range {day.print_range}</span>}
        </div>
        {(alreadyCalled || reveal) && (
          <div className="flex items-center gap-3">
            {alreadyCalled && !reveal && (
              <span className="text-xs font-mono text-terminal-dim">verdict recorded: {day.verdict.human_code}</span>
            )}
            <button
              onClick={async () => {
                await gmaUndoVerdict(day.id);
                const fresh = await gmaGetDay(day.id);
                setDay(fresh); setReveal(null); onVerdict?.();
              }}
              title="Clears your call so you can redo it. The redo is logged as non-blind — you've already seen the machine's answer."
              className="flex items-center gap-1 px-2 py-1 rounded border border-terminal-border text-xs font-mono text-terminal-dim hover:text-amber-400 hover:border-amber-600/60"
            >
              <RotateCcw className="w-3 h-3" /> undo call
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <CandleChart
          bars={printBars} width={720} height={220}
          label={printBars ? `DAY PRINT · 15-min · ${rangeLabel(printBars, 15)}` : ''}
        />
      </div>

      <div className="text-xs font-mono text-terminal-muted flex items-center gap-1">
        <EyeOff className="w-3.5 h-3.5" />
        KEY HOUR · 1-min · {keyBars ? rangeLabel(keyBars, 1) : 'not captured yet'} — four orientations, make your call BEFORE the machine shows its hand.
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {CODES.map((c) => (
          <button
            key={c.value}
            disabled={posting || !!reveal || !!alreadyCalled}
            onClick={() => commit(c.value)}
            className="group border border-terminal-border rounded p-2 hover:border-terminal-green transition-colors text-left disabled:cursor-default"
          >
            <CandleChart bars={keyBars} width={160} height={90} flipH={c.flipH} flipV={c.flipV}
              label={`key 1-min · ${c.label.toLowerCase()}`} />
            <div className="mt-1 text-xs font-mono text-terminal-muted group-hover:text-terminal-green">
              {c.label}
            </div>
          </button>
        ))}
      </div>

      {!reveal && !alreadyCalled && (
        <div className="flex items-center gap-2">
          <button
            disabled={posting}
            onClick={() => commit('unclear')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-dim hover:text-terminal-text"
          >
            <HelpCircle className="w-3.5 h-3.5" /> Unclear / no call
          </button>
          {!peek && (
            <button
              disabled={posting}
              onClick={async () => {
                try { setPeek(await gmaPeek(day.id)); } catch { setPeek({ machine_code: null }); }
              }}
              title="See the machine's call before making yours. This day is then flagged non-blind and won't count toward the calibration gate."
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-dim hover:text-amber-400 hover:border-amber-600/60"
            >
              <Eye className="w-3.5 h-3.5" /> Peek at machine (breaks blind)
            </button>
          )}
        </div>
      )}

      {peek && !reveal && !alreadyCalled && (
        <div className="rounded border border-amber-600/40 px-3 py-2 font-mono text-amber-400/90">
          <div className="flex items-center gap-2 text-sm">
            <Eye className="w-4 h-4" />
            {peek.machine_code == null ? 'Machine has no call for this day yet.'
              : peek.machine_code === 'unclear' ? 'Machine abstained — nothing scored strong enough.'
              : `Machine sees: ${peek.machine_code}`}
            <span className="text-terminal-dim text-xs">· non-blind day — your call is still welcome, it just won't count toward the gate</span>
          </div>
          {peek.machine_scores && (
            <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-terminal-muted">
              {Object.entries(peek.machine_scores).map(([code, s]) => (
                <span key={code}>{code} {s.toFixed(2)}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {reveal && (
        <div className={`rounded border px-3 py-2 font-mono ${
          reveal.machine == null ? 'border-terminal-border text-terminal-muted'
          : reveal.machine === reveal.human ? 'border-green-600/60 text-green-400'
          : 'border-amber-600/60 text-amber-400'
        }`}>
          <div className="flex items-center gap-2 text-sm">
            {reveal.machine == null ? (
              <><Eye className="w-4 h-4" /> Machine has no call yet (needs both windows captured).</>
            ) : reveal.machine === 'unclear' ? (
              <><HelpCircle className="w-4 h-4" /> Machine abstained — no orientation scored strong enough to call.</>
            ) : reveal.machine === reveal.human ? (
              <><Check className="w-4 h-4" /> Machine agrees: {reveal.machine}</>
            ) : (
              <><X className="w-4 h-4" /> Machine saw {reveal.machine} — disagreement logged. Your call stands.</>
            )}
          </div>
          {reveal.scores && (
            <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-terminal-muted">
              {Object.entries(reveal.scores).map(([code, s]) => {
                const best = Math.max(...Object.values(reveal.scores)) === s;
                return (
                  <span key={code} className={best ? 'text-terminal-text' : ''}>
                    {code} {s.toFixed(2)}
                  </span>
                );
              })}
              <span className="text-terminal-dim">
                (1.00 = perfect match, 0 = noise, below 0.40 the machine abstains)
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function AlchemyLabPage() {
  const [days, setDays] = useState([]);
  const [agreement, setAgreement] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [importMsg, setImportMsg] = useState('');
  const [ventures, setVentures] = useState([]);
  const [activeVenture, setActiveVenture] = useState(null);

  useEffect(() => {
    gmaGetVentures().then((v) => {
      setVentures(v);
      if (v.length && activeVenture == null) setActiveVenture(v[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    gmaGetDays().then((d) => {
      setDays(d);
      if (d.length && selectedId == null) {
        const pending = d.find((x) => !x.human_code) || d[0];
        setSelectedId(pending.id);
      }
    });
    gmaGetAgreement().then(setAgreement);
  }, [selectedId]);

  useEffect(() => { refresh(); }, [refresh]);

  const importCalendar = async () => {
    try {
      const raw = localStorage.getItem('alchemy_calendar_v1');
      if (!raw) return setImportMsg('No old calendar data found in this browser.');
      const res = await gmaCalendarImport(JSON.parse(raw));
      setImportMsg(`Imported ${res.imported} day codes (${res.skipped} skipped). Original calendar untouched.`);
      refresh();
    } catch (e) {
      setImportMsg(`Import failed: ${e.message}`);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-terminal-green" />
          <h1 className="text-lg font-mono text-terminal-text">Alchemy Lab</h1>
          <span className="text-xs font-mono text-terminal-dim">Gold Metal Alchemist</span>
        </div>
        <div className="flex items-center gap-3">
          {agreement && agreement.scored > 0 && (
            <span className="text-xs font-mono text-terminal-muted">
              machine vs you: {(agreement.rate * 100).toFixed(0)}% over {agreement.scored} days
              {agreement.gate_met
                ? <span className="text-green-400 ml-1">· auto-label gate MET</span>
                : <span className="text-terminal-dim ml-1">· gate {Math.round(agreement.auto_label_gate * 100)}% / 30d</span>}
            </span>
          )}
          <button onClick={importCalendar}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text">
            <Upload className="w-3.5 h-3.5" /> Import old calendar
          </button>
        </div>
      </div>
      {importMsg && <div className="text-xs font-mono text-terminal-muted">{importMsg}</div>}

      {/* Venture tabs — each sweep scenario gets its own tab (days are venture-scoped in Phase 2) */}
      {ventures.length > 0 && (
        <div className="flex items-center gap-1 border-b border-terminal-border">
          {ventures.map((v) => (
            <button
              key={v.id}
              onClick={() => setActiveVenture(v.id)}
              title={v.description}
              className={`px-3 py-1.5 text-xs font-mono rounded-t border border-b-0 transition-colors ${
                v.id === activeVenture
                  ? 'border-terminal-border bg-terminal-surface text-amber-400'
                  : 'border-transparent text-terminal-dim hover:text-terminal-text'
              }`}
            >
              {v.name.replace(/ — .*/, '')}
              <span className="ml-1.5 text-terminal-dim">
                {v.config?.key?.timeframe}→{v.config?.print?.baseline_timeframe}
              </span>
            </button>
          ))}
          <span className="ml-2 text-xs font-mono text-terminal-dim">+ new ventures land here (Phase 2)</span>
        </div>
      )}

      {selectedId != null && <VerdictCard dayId={selectedId} onVerdict={refresh} />}

      <div className="border border-terminal-border rounded-lg overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead className="bg-terminal-surface text-terminal-dim">
            <tr>
              <th className="text-left px-3 py-2">Date</th>
              <th className="text-left px-3 py-2">Your code</th>
              <th className="text-left px-3 py-2">Machine</th>
              <th className="text-left px-3 py-2">Agree</th>
              <th className="text-left px-3 py-2">Expansion</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`border-t border-terminal-border cursor-pointer hover:bg-terminal-surface ${
                  d.id === selectedId ? 'bg-terminal-surface' : ''}`}>
                <td className="px-3 py-2 text-terminal-text">{d.date}</td>
                <td className="px-3 py-2 text-terminal-muted">{d.human_code || <span className="text-terminal-dim">— pending</span>}</td>
                <td className="px-3 py-2 text-terminal-muted">
                  {d.human_code ? (d.machine_code || '—') : <span className="text-terminal-dim">hidden until you call</span>}
                </td>
                <td className="px-3 py-2">
                  {d.agreed === 1 ? <span className="text-green-400">✓</span>
                   : d.agreed === 0 ? <span className="text-amber-400">✗</span> : '—'}
                </td>
                <td className="px-3 py-2 text-terminal-muted">
                  {d.key_range && d.print_range ? `${(d.print_range / d.key_range).toFixed(2)}×` : '—'}
                </td>
              </tr>
            ))}
            {!days.length && (
              <tr><td colSpan="5" className="px-3 py-6 text-center text-terminal-dim">
                No captured days yet — the capture loop fills this automatically each session.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
