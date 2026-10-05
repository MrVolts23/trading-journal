import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import {
  MousePointer2, TrendingUp, TrendingDown, Slash, Minus, Square, Type, Flag, Trash2,
  Play, Pause, ChevronLeft, ChevronRight, Link2, History, X, Save, Plus, Info, ListOrdered, ListEnd, Ruler,
} from 'lucide-react';
import ChartPane from './ChartPane';
import ClefPanel from './ClefPanel';
import { useEdges } from './useEdges';
import {
  barIndexAt, fmtVan, fmtVanYear, vanInputToUtc, utcToVanInput, isPosition, positionStats, describeOutcome, TF_LABEL, newId, round2, clampPosition, fmtP, setPriceDigits,
} from './trainerUtil';
import {
  tdStatus, tdFetchHistory, tdTopUp, tdBars, tdExamples, tdExample, tdSaveExample, tdRemoveExample, tdImageUrl, tdEntryMoment, tdExits, tdSkills,
} from '../../lib/api';

// Trading Desk · Trainer
// Two gold charts stacked (15-minute over 3-minute by default). Mike goes back through history, draws the
// trade he would have taken (or skipped) plus the marks that show why, and saves it. Each saved example
// keeps the pictures, the exact prices and times, his notes, and the result the app worked out.

const TOOLS = [
  { id: 'cursor', label: 'Move',      icon: MousePointer2, hint: 'Drag a chart to move through time. Click a mark to select it, then drag it or its dots to adjust.' },
  { id: 'long',   label: 'Long',      icon: TrendingUp,    hint: 'Click the candle and price where you would buy. Then drag the stop and target into place.' },
  { id: 'short',  label: 'Short',     icon: TrendingDown,  hint: 'Click the candle and price where you would sell. Then drag the stop and target into place.' },
  { id: 'trend',  label: 'Line',      icon: Slash,         hint: 'Click and drag to draw a line between two points.' },
  { id: 'hline',  label: 'Level',     icon: Minus,         hint: 'Click a price to drop a level line across both charts.' },
  { id: 'rect',   label: 'Box',       icon: Square,        hint: 'Click and drag to draw a box around a zone.' },
  { id: 'text',   label: 'Label',     icon: Type,          hint: 'Click where the label should sit, then type its words in the panel on the right.' },
  { id: 'exit',   label: 'Best exit', icon: Flag,          hint: 'Click the candle and price where getting out would have been best.' },
  { id: 'xsteps', label: 'Exit 1-2-3', icon: ListEnd,       hint: 'After the entry, click the candle for E1, then E2, then E3 of the opposite 1-2-3 (for a buy: top, bottom, top). The app then finds the exit.' },
  { id: 'steps',  label: '1-2-3',     icon: ListOrdered,   hint: 'Click the candle for point 1, then 2, then 3 on the chart you are making the call on; the marks stay on that chart. Each mark snaps to the candle\'s top or bottom, whichever is nearer. The app then finds 4.' },
];
// Chart layouts, like TradingView's picker: 1, 2 or 3 charts. `areas` is a CSS grid; a = chart 1, b = chart 2, c = chart 3.
const LAYOUTS = [
  { id: '1',  n: 1, name: 'One chart',                 cols: '1fr',         rows: '1fr',         areas: '"a"' },
  { id: '2h', n: 2, name: 'Two, side by side',         cols: '1fr 1fr',     rows: '1fr',         areas: '"a b"' },
  { id: '2v', n: 2, name: 'Two, stacked',              cols: '1fr',         rows: '1fr 1fr',     areas: '"a" "b"' },
  { id: '3h', n: 3, name: 'Three, side by side',       cols: '1fr 1fr 1fr', rows: '1fr',         areas: '"a b c"' },
  { id: '3v', n: 3, name: 'Three, stacked',            cols: '1fr',         rows: '1fr 1fr 1fr', areas: '"a" "b" "c"' },
  { id: '3l', n: 3, name: 'One left, two right',       cols: '1fr 1fr',     rows: '1fr 1fr',     areas: '"a b" "a c"' },
  { id: '3r', n: 3, name: 'Two left, one right',       cols: '1fr 1fr',     rows: '1fr 1fr',     areas: '"a c" "b c"' },
  { id: '3b', n: 3, name: 'Two on top, one below',     cols: '1fr 1fr',     rows: '1fr 1fr',     areas: '"a b" "c c"' },
  { id: '3t', n: 3, name: 'One on top, two below',     cols: '1fr 1fr',     rows: '1fr 1fr',     areas: '"a a" "b c"' },
];
const AREA = ['a', 'b', 'c'];
const PIC = ['top', 'bottom', 'third'];           // picture names for chart 1, 2, 3
const DEFAULT_TFS = [15, 3, 1];
const SPEEDS = [{ ms: 1000, label: 'Slow' }, { ms: 400, label: 'Medium' }, { ms: 120, label: 'Fast' }];
const EMPTY_FORM = { decision: 'take', notes_entry: '', notes_stop: '', notes_target: '', notes_exit: '' };
const lsFloat = (k, fb) => { try { const v = localStorage.getItem(k); return v == null || v === '' || isNaN(+v) ? fb : +v; } catch { return fb; } };
const lsNum = (k, fb) => { try { const v = Number(localStorage.getItem(k)); return v > 0 ? v : fb; } catch { return fb; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// What one chart should show at replay moment T: its finished candles, plus the candle still forming
// (built from the faster chart's candles, so nothing from after T leaks in).
function asOf(bars, fine, T) {
  if (T == null || !bars) return { shownN: null, partial: null };
  const step = bars.tf * 60;
  const shownN = barIndexAt(bars.t, T - step) + 1;
  let partial = null;
  if (fine && fine.tf < bars.tf && bars.tf % fine.tf === 0 && shownN < bars.n && bars.t[shownN] < T) {
    const a = barIndexAt(fine.t, bars.t[shownN] - 1) + 1, b = barIndexAt(fine.t, T - fine.tf * 60);
    if (b >= a) {
      let h = -Infinity, l = Infinity;
      for (let i = a; i <= b; i++) { if (fine.h[i] > h) h = fine.h[i]; if (fine.l[i] < l) l = fine.l[i]; }
      partial = { t: bars.t[shownN], o: fine.o[a], h, l, c: fine.c[b], e50: fine.e50[b], e200: fine.e200[b] };
    }
  }
  return { shownN, partial };
}

// Small picture of a layout for the picker (the same grid, drawn tiny).
function LayoutIcon({ layout, active }) {
  return (
    <span className="inline-grid gap-[2px]" style={{ width: 22, height: 16, gridTemplateColumns: layout.cols, gridTemplateRows: layout.rows, gridTemplateAreas: layout.areas }}>
      {AREA.slice(0, layout.n).map((a) => <span key={a} style={{ gridArea: a }} className={`rounded-[2px] border ${active ? 'border-amber-400 bg-amber-400/20' : 'border-terminal-muted'}`} />)}
    </span>
  );
}

export default function TrainerPage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [layoutId, setLayoutId] = useState(() => { try { return localStorage.getItem('td_layout') || '2v'; } catch { return '2v'; } });
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [tfs, setTfs] = useState(() => [lsNum('td_top_tf', 15), lsNum('td_bottom_tf', 3), lsNum('td_third_tf', 1)]);
  const [barsAll, setBarsAll] = useState([null, null, null]);   // candles for chart 1, 2, 3
  const layout = LAYOUTS.find((l) => l.id === layoutId) || LAYOUTS[2];
  const N = layout.n;
  const setTf = (i, tf) => setTfs((a) => a.map((v, k) => (k === i ? tf : v)));
  const [drawings, setDrawings] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [tool, setTool] = useState('cursor');
  const [linked, setLinked] = useState(true);
  const [showInfo, setShowInfo] = useState(() => { try { return localStorage.getItem('td_show_info') === '1'; } catch { return false; } });
  // Standard view (Mike, 2026-10-03): a fixed scale so every picture looks the same — gold $2 per step on fast charts
  // (5 min and under), $4 on slower ones; forex the same in pips (20 / 40); fixed candle width; fixed chart size.
  // the locked step in dollars per gridline (gold); forex uses the same number in pips
  const [lockStep, setLockStep] = useState(() => lsFloat('td_lock_step', 4));
  const [standardOn, setStandardOn] = useState(() => { try { return localStorage.getItem('td_standard') === '1'; } catch { return false; } });
  const [hover, setHover] = useState(null);
  const [activePosId, setActivePosId] = useState(null);
  const edgesApi = useEdges();
  const edge = edgesApi.current;
  const symbol = edge?.symbol || 'XAUUSD';
  const instrument = status?.instruments?.find((i) => i.symbol === symbol) || null;
  const standardFor = () => {
    const metal = (instrument?.market || 'metal') === 'metal';
    const unit = metal ? 1 : 10 ** -(instrument?.digits ?? 5) * 10; // $1 for gold, 1 pip for forex
    return { step: lockStep * unit, pxPerStep: 22, barSpacing: 8, padSteps: 1 };
  };
  const [buffer, setBuffer] = useState(() => lsFloat('td_buffer', 0.1));   // how far above point 2 the entry sits
  const [spread, setSpread] = useState(() => lsFloat('td_spread', 0.25));  // spread to add (live spread from the robot comes later)
  // the edge's rulebook gives the starting buffer and spread; they can still be changed per example
  const edgeSeen = useRef(null);
  useEffect(() => { if (edge && edgeSeen.current !== edge.id) { edgeSeen.current = edge.id; setBuffer(edge.buffer); setSpread(edge.spread); } }, [edge]);
  const [stepMsg, setStepMsg] = useState('');
  const [exitPlans, setExitPlans] = useState([]);
  const [exitPlanId, setExitPlanId] = useState(null);   // the exit plan this example is taught with (defaults to the edge's)
  useEffect(() => { tdExits().then((r) => setExitPlans(r.plans)).catch(() => {}); }, []);
  useEffect(() => { if (edge && !editing) setExitPlanId(edge.exit_plan_id ?? null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [edge?.id, edge?.exit_plan_id]);

  const [finding, setFinding] = useState(false);
  const [guide, setGuide] = useState(null);       // price of the edge being dragged (dotted line on both charts)
  const [replayT, setReplayT] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(400);
  const [goTo, setGoTo] = useState('');
  const [setup, setSetup] = useState(() => { try { return localStorage.getItem('td_setup') || ''; } catch { return ''; } });
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(null);   // the saved example on the charts, if any
  const [examples, setExamples] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);   // { ok, text }
  const [zoom, setZoom] = useState(null);         // picture shown large

  const ref0 = useRef(null), ref1 = useRef(null), ref2 = useRef(null);
  const refs = [ref0, ref1, ref2];
  const cache = useRef(new Map());
  const pendingCenter = useRef(null);
  const timeframes = status?.timeframes || [1, 2, 3, 5, 10, 15, 30, 60, 120, 240];

  // ── data ────────────────────────────────────────────────────────────────────────────
  const loadBars = useCallback((tf) => {
    const key = `${symbol}:${tf}`;
    if (!cache.current.has(key)) cache.current.set(key, tdBars(tf, symbol).then((b) => { setPriceDigits(b.digits); return b; }).catch((e) => { cache.current.delete(key); throw e; }));
    return cache.current.get(key);
  }, [symbol]);
  const fail = (e) => setError(e?.response?.data?.error || e.message || 'Something went wrong.');

  const [dataVersion, setDataVersion] = useState(0);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        await tdTopUp(symbol).catch(() => null);    // newest candles from the demo MetaTrader, if it is open
        const s = await tdStatus(symbol); if (dead) return;
        setStatus(s);
        setExamples(await tdExamples(edge?.id));
      } catch (e) { if (!dead) fail(e); }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion, edge?.id, symbol]);

  const hasData = (status?.coverage?.bars || 0) > 0;
  // each chart loads the candles for its own timeframe (charts not in the layout load nothing)
  const want = [tfs[0], N > 1 ? tfs[1] : null, N > 2 ? tfs[2] : null];
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      setBarsAll((a) => a.map((v, k) => (k === i ? null : v)));
      if (!hasData || want[i] == null) return;
      let dead = false;
      loadBars(want[i]).then((b) => { if (!dead) setBarsAll((a) => a.map((v, k) => (k === i ? b : v))); }).catch(fail);
      lsSet(['td_top_tf', 'td_bottom_tf', 'td_third_tf'][i], want[i]);
      return () => { dead = true; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [want[i], hasData, dataVersion, loadBars, symbol]);
  }
  useEffect(() => { lsSet('td_layout', layoutId); }, [layoutId]);
  const panes = AREA.slice(0, N).map((area, i) => ({ i, area, ref: refs[i], bars: barsAll[i], tf: tfs[i] }));
  const allLoaded = panes.every((p) => p.bars);

  // while a history fetch is running, keep checking; when it lands, reload the charts
  useEffect(() => {
    if (!status?.pending) return;
    const id = setInterval(async () => {
      try {
        const s = await tdStatus(symbol);
        if (!s.pending) { cache.current.clear(); setDataVersion((v) => v + 1); }
        else setStatus(s);
      } catch { /* try again next tick */ }
    }, 2000);
    return () => clearInterval(id);
  }, [status?.pending]);

  const fetchHistory = async () => {
    setError('');
    try { await tdFetchHistory({ months: 12, symbol }); setStatus(await tdStatus(symbol)); } catch (e) { fail(e); }
  };

  // after loading a saved example, every chart settles on that moment
  useEffect(() => {
    if (pendingCenter.current == null || !allLoaded) return;
    const T = pendingCenter.current; pendingCenter.current = null;
    requestAnimationFrame(() => panes.forEach((p) => p.ref.current?.centerOn(T)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLoaded, barsAll, N]);

  // ── replay ──────────────────────────────────────────────────────────────────────────
  // replay steps one candle of the FASTEST chart on screen
  const fine = panes.reduce((best, p) => (p.bars && (!best || p.bars.tf < best.tf) ? p.bars : best), null);
  const views = useMemo(() => barsAll.map((b, i) => (i < N ? asOf(b, fine !== b ? fine : null, replayT) : { shownN: null, partial: null })),
    [barsAll, N, fine, replayT]);

  const startReplayAt = (T) => {
    if (!fine) return;
    const fs = fine.tf * 60;
    const i = Math.max(0, barIndexAt(fine.t, T));
    const at = fine.t[i] + fs;
    setReplayT(at); setPlaying(false);
    requestAnimationFrame(() => {
      panes.forEach((p) => p.ref.current?.alignRightEdge(at + 25 * p.tf * 60));
    });
  };
  const step = useCallback((dir) => {
    setReplayT((T) => {
      if (T == null || !fine) return T;
      const fs = fine.tf * 60, i = barIndexAt(fine.t, T - fs), j = i + dir;
      if (j < 0 || j >= fine.n) return T;
      return fine.t[j] + fs;
    });
  }, [fine]);
  useEffect(() => {
    if (replayT == null) return;
    panes.forEach((p) => { if (views[p.i].shownN != null) p.ref.current?.keepInView(views[p.i].shownN); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayT, views]);
  useEffect(() => {
    if (!playing || replayT == null) return;
    const id = setInterval(() => step(1), speed);
    return () => clearInterval(id);
  }, [playing, speed, replayT == null, step]);
  const atEnd = replayT != null && fine && replayT >= fine.t[fine.n - 1] + fine.tf * 60;
  useEffect(() => { if (atEnd) setPlaying(false); }, [atEnd]);
  const exitReplay = () => { setReplayT(null); setPlaying(false); if (tool === 'pick') setTool('cursor'); };

  const jump = () => {
    const T = vanInputToUtc(goTo);
    if (T == null) return;
    if (replayT != null) startReplayAt(T);
    else panes.forEach((p) => p.ref.current?.centerOn(T));
  };

  // ── drawings ────────────────────────────────────────────────────────────────────────
  // Several longs/shorts can be on the charts for playing around. The example being saved is ONE of them:
  // the one clicked most recently (or the only one).
  const positions = drawings.filter(isPosition);
  const position = positions.find((d) => d.id === activePosId) || positions[positions.length - 1] || null;
  const exitMark = drawings.find((d) => d.type === 'exit') || null;
  const selected = drawings.find((d) => d.id === selectedId) || null;

  // ── the 1-2-3-4 entry ───────────────────────────────────────────────────────────────
  const steps = drawings.filter((d) => d.type === 'step' && d.n < 4).sort((a, b) => a.n - b.n);
  const four = drawings.find((d) => d.type === 'step' && d.n === 4) || null;
  const [p1, p2, p3] = [1, 2, 3].map((n) => steps.find((d) => d.n === n) || null);
  const stepSide = p1 ? (p1.kind === 'low' ? 'long' : 'short') : null;
  const stepLong = stepSide === 'long';
  const entryPrice = p2 ? round2(stepLong ? p2.p + buffer + spread : p2.p - buffer - spread) : null;
  const stepProblem = (() => {
    if (!p1) return null;
    if (p2 && p2.t <= p1.t) return 'Point 2 has to come after point 1.';
    if (p2 && p2.kind === p1.kind) return stepLong ? 'For a buy, point 2 is a top.' : 'For a sell, point 2 is a bottom.';
    if (p3 && p2 && p3.t <= p2.t) return 'Point 3 has to come after point 2.';
    if (p3 && p3.kind !== p1.kind) return stepLong ? 'For a buy, point 3 is a bottom.' : 'For a sell, point 3 is a top.';
    if (p3 && p2 && (stepLong ? p3.p >= p2.p : p3.p <= p2.p)) return stepLong ? 'Point 3 has to be below point 2 (the pullback).' : 'Point 3 has to be above point 2 (the pullback).';
    if (p3 && (stepLong ? p3.p <= p1.p : p3.p >= p1.p)) return stepLong ? 'Point 3 went below point 1, so this setup is invalid.' : 'Point 3 went above point 1, so this setup is invalid.';
    return null;
  })();
  const onStep = (c) => {
    const n = steps.length + 1;
    if (n > 3) { setStepMsg('All three points are marked. Select one and delete it to mark it again.'); setTool('cursor'); return; }
    // point 1 takes the nearer of top/bottom; 2 and 3 then alternate (buy: bottom, top, bottom; sell: the reverse)
    const kind = n === 1 ? c.kind : n === 2 ? (p1.kind === 'low' ? 'high' : 'low') : p1.kind;
    const d = { id: newId(), type: 'step', n, t: c.t, tf: c.tf, p: kind === 'high' ? c.h : c.l, kind };
    setDrawings((ds) => [...ds.filter((x) => !(x.type === 'step' && x.n === 4)), d]); // a new point makes any old 4 stale
    setSelectedId(d.id); setStepMsg('');
    if (n === 3) setTool('cursor');
  };
  useEffect(() => { lsSet('td_buffer', buffer); lsSet('td_spread', spread); }, [buffer, spread]);

  // ── the exit 1-2-3: the same pattern the other way, marked after the entry ──────────
  const xsteps = drawings.filter((d) => d.type === 'xstep' && d.n < 4).sort((a, b) => a.n - b.n);
  const xfour = drawings.find((d) => d.type === 'xstep' && d.n === 4) || null;
  const [x1, x2, x3] = [1, 2, 3].map((n) => xsteps.find((d) => d.n === n) || null);
  const tradeLong = position ? position.type === 'long' : stepLong;   // the exit pattern is the opposite of the trade
  const exitLevel = x2 && position ? round2(tradeLong ? x2.p - buffer : x2.p + buffer) : null;
  const [xMsg, setXMsg] = useState('');
  const [findingX, setFindingX] = useState(false);
  const xProblem = (() => {
    if (!x1) return null;
    if (!position) return 'Draw the trade (or find point 4) first; the exit pattern comes after the entry.';
    if (x1.t < position.t) return 'E1 has to come after the entry.';
    const wantKind1 = tradeLong ? 'high' : 'low';
    if (x1.kind !== wantKind1) return tradeLong ? 'To get out of a buy, E1 is a top.' : 'To get out of a sell, E1 is a bottom.';
    if (x2 && x2.t <= x1.t) return 'E2 has to come after E1.';
    if (x3 && x2 && x3.t <= x2.t) return 'E3 has to come after E2.';
    if (x3 && x2 && (tradeLong ? x3.p <= x2.p : x3.p >= x2.p)) return tradeLong ? 'E3 has to be above E2 (the pullback).' : 'E3 has to be below E2 (the pullback).';
    if (x3 && (tradeLong ? x3.p >= x1.p : x3.p <= x1.p)) return tradeLong ? 'E3 went above E1, so this exit pattern is invalid.' : 'E3 went below E1, so this exit pattern is invalid.';
    return null;
  })();
  const onXStep = (c) => {
    const n = xsteps.length + 1;
    if (n > 3) { setXMsg('All three exit points are marked. Select one and delete it to mark it again.'); setTool('cursor'); return; }
    // E1 is a top for a buy (bottom for a sell); E2 and E3 alternate from there
    const first = tradeLong ? 'high' : 'low';
    const kind = n === 2 ? (first === 'high' ? 'low' : 'high') : first;
    const d = { id: newId(), type: 'xstep', n, t: c.t, tf: c.tf, p: kind === 'high' ? c.h : c.l, kind };
    setDrawings((ds) => [...ds.filter((x) => !(x.type === 'xstep' && x.n === 4)), d]);
    setSelectedId(d.id); setXMsg('');
    if (n === 3) setTool('cursor');
  };
  // the trend skill's label: the EMA makes a first guess (side + slope of the 15-min 50 EMA at the entry), Mike confirms
  const [trend, setTrend] = useState(null);
  // the taught skills, and which ones this example is saved to (pre-ticked from the marks; Mike can change it)
  const [taughtSkills, setTaughtSkills] = useState([]);
  const [teachOverride, setTeachOverride] = useState(null);   // null = follow the marks; otherwise Mike's ticks
  useEffect(() => { tdSkills().then((r) => setTaughtSkills(r.skills.filter((k) => k.kind === 'taught'))).catch(() => {}); }, []);
  const emaGuess = (T) => {
    const b = panes.map((p) => p.bars).find((x) => x && x.tf === 15) || panes.map((p) => p.bars).find(Boolean);
    if (!b || T == null) return null;
    const i = Math.max(0, Math.min(b.n - 1, barIndexAt(b.t, T)));
    const back = Math.max(0, i - Math.round((8 * 15 * 60) / (b.tf * 60)));
    const e = b.e50[i], e0 = b.e50[back], px = b.c[i];
    if (e == null || e0 == null) return null;
    const slopeUp = e > e0, slopeDown = e < e0;
    if (px > e && slopeUp) return 'up';
    if (px < e && slopeDown) return 'down';
    return 'none';
  };
  useEffect(() => {
    if (!position || (trend && trend.source === 'mike')) return;
    const g = emaGuess(position.t);
    if (g) setTrend({ value: g, source: 'ema' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.t, barsAll]);
  const inferredKeys = [
    ...(steps.length === 3 ? [steps[0].tf <= 5 ? 'bos_3m' : 'bos_15m'] : []),
    ...(xsteps.length === 3 ? ['exit_structure'] : []),
    ...(trend ? ['trend'] : []),
  ];
  const teaches = teachOverride ?? inferredKeys;
  const toggleTeach = (key) => setTeachOverride((cur) => { const base = cur ?? inferredKeys; return base.includes(key) ? base.filter((k) => k !== key) : [...base, key]; });
  const skillsTaught = [
    ...(steps.length === 3 ? [`${TF_LABEL[steps[0].tf] || steps[0].tf + ' min'} break of structure${four ? '' : ' (find 4 to complete)'}`] : []),
    ...(xsteps.length === 3 ? ['Break of structure the other way (exit)'] : []),
    ...(trend ? [`Trend: ${trend.value}${trend.source === 'ema' ? ' (EMA guess)' : ''}`] : []),
  ];
  const findExit = async () => {
    if (!x1 || !x2 || !x3 || xProblem || !position) return;
    setFindingX(true); setXMsg('');
    try {
      // the exit fires when price trades through E2 the other way; if it goes through E1 first the pattern failed
      const r = await tdEntryMoment({ side: tradeLong ? 'short' : 'long', after_t: x3.t + x3.tf * 60, entry: exitLevel, invalid: x1.p, symbol });
      if (r.t == null) {
        setXMsg(r.invalidated_at ? `Price went through E1 at ${fmtVan(r.invalidated_at)} before breaking E2, so this exit never triggered.`
          : r.gave_up ? 'Price never broke E2 in the five days after E3.' : 'Not enough price data after E3 yet.');
        return;
      }
      const mark = { id: newId(), type: 'xstep', n: 4, t: r.t, tf: x3.tf, p: exitLevel, kind: tradeLong ? 'low' : 'high' };
      setDrawings((ds) => [...ds.filter((x) => !(x.type === 'xstep' && x.n === 4)), mark]);
      const risk = Math.abs(position.entry - position.stop);
      const rAt = risk > 0 ? ((tradeLong ? exitLevel - position.entry : position.entry - exitLevel) / risk).toFixed(2) : '?';
      setXMsg(`Exit: price broke E2 at ${fmtVan(r.t)}, ${fmtP(exitLevel)} (${rAt > 0 ? '+' : ''}${rAt}R from the entry).`);
      panes.forEach((p) => p.ref.current?.centerOn(r.t));
    } catch (e) { setXMsg(e?.response?.data?.error || e.message); }
    finally { setFindingX(false); }
  };
  const findFour = async () => {
    if (!p1 || !p2 || !p3 || stepProblem) return;
    setFinding(true); setStepMsg('');
    try {
      const r = await tdEntryMoment({ side: stepSide, after_t: p3.t + p3.tf * 60, entry: entryPrice, invalid: p1.p, symbol });
      if (r.t == null) {
        setStepMsg(r.invalidated_at ? `Price went through point 1 at ${fmtVan(r.invalidated_at)} before reaching the entry, so there was no trade.`
          : r.gave_up ? 'Price never reached the entry in the five days after point 3.' : 'Not enough price data after point 3 yet.');
        return;
      }
      const fourMark = { id: newId(), type: 'step', n: 4, t: r.t, tf: p3.tf, p: entryPrice, kind: stepLong ? 'high' : 'low' }; // shown on the chart the points were made on
      const stop = round2(stepLong ? p3.p - buffer : p3.p + buffer);
      const target = round2(stepLong ? entryPrice + 2 * (entryPrice - stop) : entryPrice - 2 * (stop - entryPrice));
      setDrawings((ds) => {
        const rest = ds.filter((x) => !(x.type === 'step' && x.n === 4));
        const cur = rest.find((x) => x.id === position?.id);
        if (cur) return rest.map((x) => (x.id === cur.id ? clampPosition({ ...x, type: stepSide, t: r.t, t2: Math.max(x.t2, r.t + 60 * 15), entry: entryPrice }) : x)).concat(fourMark);
        const box = clampPosition({ id: newId(), type: stepSide, t: r.t, t2: r.t + (fine ? fine.tf : 1) * 60 * 14, entry: entryPrice, stop, target });
        return [...rest, box, fourMark];
      });
      setStepMsg(`Point 4: price reached ${fmtP(entryPrice)} at ${fmtVan(r.t)}${r.minutes_waited ? ` (${r.minutes_waited} minutes after point 3)` : ''}. ${position ? 'Your box now starts there.' : 'A box is placed there with the stop just past point 3; drag the stop and target as you like.'}`);
      panes.forEach((p) => p.ref.current?.centerOn(r.t));
    } catch (e) { setStepMsg(e?.response?.data?.error || e.message); }
    finally { setFinding(false); }
  };
  const stats = position ? positionStats(position) : null;
  useEffect(() => { if (selectedId && drawings.some((d) => d.id === selectedId && isPosition(d))) setActivePosId(selectedId); }, [selectedId, drawings]);
  const removeSelected = useCallback(() => {
    setDrawings((ds) => ds.filter((d) => d.id !== selectedId)); setSelectedId(null);
  }, [selectedId]);
  const startNew = () => {
    setDrawings([]); setSelectedId(null); setEditing(null); setForm(EMPTY_FORM); setMessage(null); setTool('cursor'); setExitPlanId(edge?.exit_plan_id ?? null); setTrend(null); setTeachOverride(null);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); removeSelected(); }
      else if (e.key === 'Escape') { setTool('cursor'); setSelectedId(null); setZoom(null); }
      else if (replayT != null && e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (replayT != null && e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (replayT != null && e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, replayT, removeSelected, step]);

  // ── save / load ─────────────────────────────────────────────────────────────────────
  const save = async () => {
    if (!position) { setMessage({ ok: false, text: 'Draw a long or a short first.' }); return; }
    if (!allLoaded) return;
    setSaving(true); setMessage(null);
    try {
      flushSync(() => { setSelectedId(null); setHover(null); setPlaying(false); });
      await nextFrame();
      const E = position.t;
      // the decision moment: with a found point 4 it is the end of the minute price reached the entry (so the
      // live candle shows as it stood); otherwise the start of the box
      const decisionT = four && four.t === position.t ? four.t + 60 : E;
      const frameToT = Math.max(position.t2, exitMark ? exitMark.t : 0, xfour ? xfour.t + 60 : 0);
      const images = {};
      for (const { i, ref, bars } of panes) {
        const name = PIC[i];
        // one picture as each of points 1, 2, 3 had just finished (only when all three are marked)
        if (p1 && p2 && p3 && four) for (const st of [p1, p2, p3]) {
          const T = st.t + st.tf * 60;
          const cut = asOf(bars, fine !== bars ? fine : null, T);
          images[`${name}_step${st.n}`] = await ref.current.capture({ shownN: cut.shownN, partial: cut.partial, hideExit: true, frameT: T, onlyPosId: position.id, cutT: T });
        }
        const cut = asOf(bars, fine !== bars ? fine : null, decisionT);
        // decision picture: only what existed at the entry moment. full picture: what happened next.
        images[`${name}_decision`] = await ref.current.capture({ shownN: cut.shownN, partial: cut.partial, hideExit: true, frameT: E, onlyPosId: position.id, cutT: decisionT });
        images[`${name}_full`] = await ref.current.capture({ frameT: E, frameToT, onlyPosId: position.id });
        // the exit 1-2-3 as it stood the minute E2 broke (nothing after it)
        if (xfour) {
          const T = xfour.t + 60;
          const cut = asOf(bars, fine !== bars ? fine : null, T);
          images[`${name}_exit`] = await ref.current.capture({ shownN: cut.shownN, partial: cut.partial, hideExit: true, frameT: xfour.t, onlyPosId: position.id, cutT: T });
        }
      }
      const body = {
        edge_id: edge?.id, exit_plan_id: exitPlanId ?? undefined, trend: trend ? { value: trend.value, source: trend.source, tf: 15 } : undefined, teaches, symbol, setup, side: position.type, decision: form.decision,
        entry_time: position.t, entry: position.entry, stop: position.stop, target: position.target,
        top_tf: tfs[0], bottom_tf: N > 1 ? tfs[1] : tfs[0], layout: layout.id, tfs: tfs.slice(0, N),
        notes_entry: form.notes_entry, notes_stop: form.notes_stop, notes_target: form.notes_target,
        best_exit_time: exitMark ? exitMark.t : null, best_exit_price: exitMark ? exitMark.p : null, notes_exit: form.notes_exit,
        drawings: drawings.filter((d) => !isPosition(d) || d.id === position.id), images,
        entry_rule: p1 && p2 && p3 ? {
          kind: '1-2-3', buffer, spread,
          points: Object.fromEntries([p1, p2, p3, four].filter(Boolean).map((d) => [d.n, { t: d.t, tf: d.tf, p: d.p, kind: d.kind }])),
          exit: x1 && x2 && x3 && xfour ? { kind: 'opposite 1-2-3', points: Object.fromEntries([x1, x2, x3, xfour].map((d) => [d.n, { t: d.t, tf: d.tf, p: d.p, kind: d.kind }])), t: xfour.t, p: xfour.p } : null,
        } : (x1 && x2 && x3 && xfour ? { kind: 'drawn', exit: { kind: 'opposite 1-2-3', points: Object.fromEntries([x1, x2, x3, xfour].map((d) => [d.n, { t: d.t, tf: d.tf, p: d.p, kind: d.kind }])), t: xfour.t, p: xfour.p } } : null),
      };
      const saved = await tdSaveExample(body, editing?.id);
      lsSet('td_setup', setup);
      setEditing(saved);
      setExamples(await tdExamples(edge?.id));
      setMessage({ ok: true, text: `Saved as example ${saved.id} under ${edge?.name || 'this edge'}.` });
    } catch (e) {
      setMessage({ ok: false, text: e?.response?.data?.error || e.message });
    } finally { setSaving(false); }
  };

  const open = async (id) => {
    try {
      const ex = await tdExample(id);
      exitReplay();
      setDrawings(ex.drawings || []); setSelectedId(null); setTool('cursor');
      setSetup(ex.setup || '');
      setForm({ decision: ex.decision, notes_entry: ex.notes_entry || '', notes_stop: ex.notes_stop || '', notes_target: ex.notes_target || '', notes_exit: ex.notes_exit || '' });
      setEditing(ex); setMessage(null); setExitPlanId(ex.exit_plan_id ?? null); setTrend(ex.skills?.trend ? { value: ex.skills.trend.value, source: ex.skills.trend.source || 'mike' } : null); setTeachOverride(Object.keys(ex.skills || {}));
      // put the charts back the way they were when it was saved (layout and timeframes), then go to the entry
      const exLayout = LAYOUTS.find((l) => l.id === ex.charts?.layout) || LAYOUTS[2];
      const exTfs = ex.charts?.tfs?.length ? ex.charts.tfs : [ex.top_tf, ex.bottom_tf];
      const same = exLayout.id === layout.id && exTfs.every((t, i) => t === tfs[i]);
      if (same && allLoaded) panes.forEach((p) => p.ref.current?.centerOn(ex.entry_time));
      else if (same) pendingCenter.current = ex.entry_time; // charts still loading: settle there once they are in
      else {
        pendingCenter.current = ex.entry_time;
        setLayoutId(exLayout.id);
        setTfs((a) => a.map((v, i) => exTfs[i] ?? v));
      }
    } catch (e) { fail(e); }
  };
  // "Open in Trainer" from the Library arrives as ?example=<number>
  const [params, setParams] = useSearchParams();
  const wanted = params.get('example');
  useEffect(() => {
    if (!wanted || !hasData) return;
    setParams({}, { replace: true });
    open(Number(wanted));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, hasData]);
  // the trash icon asks twice: first click arms it, second click removes (no pop-up dialogs; they don't show here)
  const [armRemove, setArmRemove] = useState(null);
  const remove = async (id) => {
    if (armRemove !== id) { setArmRemove(id); return; }
    setArmRemove(null);
    try { await tdRemoveExample(id); if (editing?.id === id) startNew(); setExamples(await tdExamples(edge?.id)); } catch (e) { fail(e); }
  };

  // ── render ──────────────────────────────────────────────────────────────────────────
  const activeTool = TOOLS.find((t) => t.id === tool);
  const hint = tool === 'pick' ? 'Click the candle where replay should start. Everything after it is hidden until you step forward.' : activeTool?.hint;
  const paneProps = (which) => ({
    timeframes, drawings, selectedId, tool, showInfo,
    onDrawingsChange: setDrawings, onSelect: setSelectedId, onToolDone: () => setTool('cursor'),
    onPick: startReplayAt, guide, onGuide: setGuide, onStep, onXStep,
    hoverT: hover && hover.from !== which ? hover.t : null,
    hoverP: hover && hover.from !== which ? hover.p : null,
    onHover: (t, p) => setHover(t == null ? null : { t, p, from: which }),
    onUserScroll: (T) => { if (linked) panes.forEach((p) => { if (p.i !== which) p.ref.current?.alignRightEdge(T); }); },
    onActive: () => {},
  });
  const cov = status?.coverage;
  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-xs font-mono transition-colors';
  const idle = 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover';
  const on = 'border-amber-400 text-amber-400 bg-amber-400/10';
  const field = 'input-field w-full text-xs font-mono';
  const label = 'text-[10px] font-mono text-terminal-dim uppercase tracking-widest';

  if (status && !hasData) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-lg font-mono text-terminal-text">Trainer</h1>
          {status.pending ? (
            <p className="text-sm font-mono text-terminal-muted">Fetching a year of {instrument?.name || symbol} prices from the demo MetaTrader. Gold takes under a minute; a new instrument can take a few minutes the first time.</p>
          ) : status.robot?.alive ? (
            <>
              <p className="text-sm font-mono text-terminal-muted">The charts need price history for {instrument?.name || symbol} ({symbol}). One click pulls the last 12 months from the demo MetaTrader. The first pull of a new instrument can take a few minutes while MetaTrader downloads it from the broker.</p>
              <button onClick={fetchHistory} className={`${btn} ${on} mx-auto`}>Load 12 months of {instrument?.name || symbol} history</button>
            </>
          ) : (
            <p className="text-sm font-mono text-terminal-muted">{status.robot?.why} Then come back to this tab.</p>
          )}
          {error && <p className="text-xs font-mono text-terminal-red">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* tools */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-terminal-border flex-shrink-0">
        {TOOLS.map((t) => (
          <button key={t.id} onClick={() => setTool(t.id)} className={`${btn} ${tool === t.id ? on : idle}`} title={t.hint}>
            <t.icon size={14} />{t.label}
          </button>
        ))}
        <button onClick={removeSelected} disabled={!selected} className={`${btn} ${idle} disabled:opacity-40`} title="Remove the selected mark">
          <Trash2 size={14} />Delete
        </button>
        <span className="w-px h-5 bg-terminal-border mx-1" />
        {replayT == null ? (
          <button onClick={() => setTool('pick')} className={`${btn} ${tool === 'pick' ? on : idle}`} title="Hide the future and step through one candle at a time">
            <History size={14} />Replay
          </button>
        ) : (
          <>
            <button onClick={() => step(-1)} className={`${btn} ${idle}`} title="Back one candle (left arrow)"><ChevronLeft size={14} /></button>
            <button onClick={() => setPlaying((p) => !p)} className={`${btn} ${playing ? on : idle}`} title="Play or pause (space bar)">
              {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? 'Pause' : 'Play'}
            </button>
            <button onClick={() => step(1)} className={`${btn} ${idle}`} title="Forward one candle (right arrow)"><ChevronRight size={14} /></button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="bg-terminal-surface border border-terminal-border rounded px-2 py-1.5 text-xs font-mono text-terminal-text">
              {SPEEDS.map((s) => <option key={s.ms} value={s.ms}>{s.label}</option>)}
            </select>
            <button onClick={() => setTool('pick')} className={`${btn} ${tool === 'pick' ? on : idle}`}>New start point</button>
            <button onClick={exitReplay} className={`${btn} ${idle}`}><X size={14} />Leave replay</button>
          </>
        )}
        <span className="w-px h-5 bg-terminal-border mx-1" />
        <input type="datetime-local" value={goTo} onChange={(e) => setGoTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && jump()}
          min={cov?.first_t ? utcToVanInput(cov.first_t) : undefined} max={cov?.last_t ? utcToVanInput(cov.last_t) : undefined}
          className="bg-terminal-surface border border-terminal-border rounded px-2 py-1 text-xs font-mono text-terminal-text" />
        <button onClick={jump} disabled={!goTo} className={`${btn} ${idle} disabled:opacity-40`}>Go to date</button>
        <div className="relative ml-auto">
          <button onClick={() => setLayoutOpen((o) => !o)} className={`${btn} ${layoutOpen ? on : idle}`} title="Choose how many charts and how they are arranged">
            <LayoutIcon layout={layout} active={layoutOpen} />Layout
          </button>
          {layoutOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 rounded border border-terminal-border bg-terminal-surface p-2 space-y-1 shadow-lg">
              {[1, 2, 3].map((n) => (
                <div key={n} className="flex items-center gap-1">
                  <span className="w-4 text-[10px] font-mono text-terminal-dim">{n}</span>
                  {LAYOUTS.filter((l) => l.n === n).map((l) => (
                    <button key={l.id} title={l.name} onClick={() => { setLayoutId(l.id); setLayoutOpen(false); }}
                      className={`p-1.5 rounded ${l.id === layout.id ? 'bg-amber-400/10' : 'hover:bg-terminal-hover'}`}>
                      <LayoutIcon layout={l} active={l.id === layout.id} />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center rounded border border-terminal-border">
          <button onClick={() => setStandardOn((v) => { lsSet('td_standard', v ? '0' : '1'); return !v; })} className={`${btn} border-0 rounded-r-none ${standardOn ? on : idle}`}
            title="Locks every chart to a fixed scale: this many dollars per gridline (22 px), candles 8 px wide, centred on your marks. The charts keep their size; the saved pictures are the charts as you see them. Pictures are always saved locked, whether or not this is lit.">
            <Ruler size={14} />Lock scale
          </button>
          <select value={lockStep} onChange={(e) => { setLockStep(Number(e.target.value)); lsSet('td_lock_step', e.target.value); }} className="bg-terminal-surface text-xs font-mono text-terminal-text px-1.5 py-1.5 border-l border-terminal-border rounded-r" title="Dollars per gridline (pips for forex)">
            {[1, 2, 4, 5, 10].map((v) => <option key={v} value={v}>${v} / line</option>)}
          </select>
        </div>
        <button onClick={() => setShowInfo((v) => { lsSet('td_show_info', v ? '0' : '1'); return !v; })} className={`${btn} ${showInfo ? on : idle}`} title="When on, every mark shows its numbers. When off, only the mark you have selected does. Saved pictures always include the numbers.">
          <Info size={14} />Show all info
        </button>
        <button onClick={() => setLinked((l) => !l)} className={`${btn} ${linked ? on : idle}`} title="When on, moving one chart moves the other to the same moment">
          <Link2 size={14} />Charts move together
        </button>
      </div>
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-terminal-border flex-shrink-0 text-xs font-mono">
        <span className="text-terminal-muted">{hint}</span>
        {replayT != null && <span className="ml-auto text-amber-400">Replay · it is {fmtVan(replayT)} (Vancouver). {atEnd ? 'That is the end of the loaded history.' : 'Later candles are hidden.'}</span>}
        {replayT == null && cov?.first_t && <span className="ml-auto text-terminal-dim">{instrument?.name || symbol} history: {fmtVanYear(cov.first_t)} to {fmtVanYear(cov.last_t)}</span>}
      </div>
      {error && <div className="px-3 py-1.5 text-xs font-mono text-terminal-red border-b border-terminal-border flex-shrink-0">{error}</div>}

      <div className="flex-1 flex min-h-0">
        {/* charts */}
        <div className="flex-1 min-w-0 min-h-0 grid gap-2 p-2" style={{ gridTemplateColumns: layout.cols.replace(/1fr/g, 'minmax(0, 1fr)'), gridTemplateRows: layout.rows.replace(/1fr/g, 'minmax(0, 1fr)'), gridTemplateAreas: layout.areas }}>
          {panes.map((p) => (
            <ChartPane key={p.i} ref={p.ref} area={p.area} symbolName={`${instrument?.name || symbol} · ${symbol}`} digits={instrument?.digits ?? 2} title={N === 1 ? 'Chart' : `Chart ${p.i + 1}`} bars={p.bars} tf={p.tf} onTfChange={(tf) => setTf(p.i, tf)}
              shownN={views[p.i].shownN} partial={views[p.i].partial} standard={standardFor()} locked={standardOn} {...paneProps(p.i)} />
          ))}
        </div>

        {/* the example being built */}
        <div className="w-80 flex-shrink-0 border-l border-terminal-border overflow-y-auto p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-mono text-terminal-text">{editing ? `Example ${editing.id}` : 'New example'}</span>
            <button onClick={startNew} className={`${btn} ${idle}`} title="Clear the charts and start another example"><Plus size={14} />New</button>
          </div>

          {!position ? (
            <p className="text-xs font-mono text-terminal-muted leading-relaxed">
              Find a trade on the charts. Pick <span className="text-terminal-text">Long</span> or <span className="text-terminal-text">Short</span> above and click where you would get in. Add lines, boxes and labels that show why. Then fill in the notes and save.
            </p>
          ) : (
            <div className="rounded border border-terminal-border p-2 space-y-1 text-xs font-mono">
              <div className="flex justify-between"><span className="text-terminal-muted">{position.type === 'long' ? 'Long' : 'Short'} at</span><span className="text-terminal-text">{fmtP(position.entry)}</span></div>
              <div className="flex justify-between"><span className="text-terminal-muted">Entry time</span><span className="text-terminal-text">{fmtVan(position.t)}</span></div>
              <div className="flex justify-between"><span className="text-terminal-muted">Stop</span><span className="text-terminal-red">{fmtP(position.stop)} ({fmtP(stats.risk)} away)</span></div>
              <div className="flex justify-between"><span className="text-terminal-muted">Target</span><span className="text-terminal-green">{fmtP(position.target)} ({fmtP(stats.reward)} away)</span></div>
              <div className="flex justify-between"><span className="text-terminal-muted">Risk/reward</span><span className="text-terminal-text">1 : {stats.rr.toFixed(2)}</span></div>
              {positions.length > 1 && <p className="text-[10px] text-amber-400 leading-relaxed pb-1">{positions.length} trades are on the charts. This is the one that gets saved; the others stay out of the pictures. Click a different box to switch.</p>}
              {exitMark && <div className="flex justify-between"><span className="text-terminal-muted">Best exit</span><span className="text-purple-400">{fmtP(exitMark.p)} · {fmtVan(exitMark.t)}</span></div>}
            </div>
          )}

          {selected?.type === 'text' && (
            <div className="space-y-1">
              <div className={label}>Words on the selected label</div>
              <input autoFocus value={selected.text} onChange={(e) => setDrawings((ds) => ds.map((d) => (d.id === selected.id ? { ...d, text: e.target.value } : d)))} className={field} />
            </div>
          )}

          {(steps.length > 0 || tool === 'steps') && (
            <div className="rounded border border-sky-400/40 p-2 space-y-2 text-xs font-mono">
              <div className={label}>1-2-3-4 entry</div>
              {[p1, p2, p3].map((d, i) => (
                <div key={i} className="flex justify-between"><span className="text-terminal-muted">Point {i + 1}</span>
                  <span className={d ? 'text-terminal-text' : 'text-terminal-dim'}>{d ? `${d.kind === 'high' ? 'Top' : 'Bottom'} ${fmtP(d.p)} · ${fmtVan(d.t)}` : 'click a candle'}</span></div>
              ))}
              {stepProblem && <p className="text-terminal-red leading-relaxed">{stepProblem}</p>}
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-0.5"><span className="text-[10px] text-terminal-dim">Buffer past point 2</span>
                  <input type="number" step="0.05" value={buffer} onChange={(e) => setBuffer(+e.target.value || 0)} className={field} /></label>
                <label className="space-y-0.5"><span className="text-[10px] text-terminal-dim">Spread</span>
                  <input type="number" step="0.05" value={spread} onChange={(e) => setSpread(+e.target.value || 0)} className={field} /></label>
              </div>
              {entryPrice != null && !stepProblem && <div className="flex justify-between"><span className="text-terminal-muted">{stepLong ? 'Buy' : 'Sell'} when price reaches</span><span className="text-terminal-text">{fmtP(entryPrice)}</span></div>}
              <button onClick={findFour} disabled={!p1 || !p2 || !p3 || !!stepProblem || finding} className={`${btn} ${on} w-full justify-center disabled:opacity-40`}>
                {finding ? 'Looking…' : four ? 'Find 4 again' : 'Find 4'}
              </button>
              {four && <div className="flex justify-between"><span className="text-terminal-muted">Point 4</span><span className="text-amber-400">{fmtP(four.p)} · {fmtVan(four.t)}</span></div>}
              {stepMsg && <p className="text-terminal-muted leading-relaxed">{stepMsg}</p>}
            </div>
          )}
          {(xsteps.length > 0 || tool === 'xsteps') && (
            <div className="rounded border border-orange-400/40 p-2 space-y-2 text-xs font-mono">
              <div className={label}>Exit 1-2-3 (the pattern the other way)</div>
              {[x1, x2, x3].map((d, i) => (
                <div key={i} className="flex justify-between"><span className="text-terminal-muted">E{i + 1}</span>
                  <span className={d ? 'text-terminal-text' : 'text-terminal-dim'}>{d ? `${d.kind === 'high' ? 'Top' : 'Bottom'} ${fmtP(d.p)} · ${fmtVan(d.t)}` : 'click a candle'}</span></div>
              ))}
              {xProblem && <p className="text-terminal-red leading-relaxed">{xProblem}</p>}
              {exitLevel != null && !xProblem && <div className="flex justify-between"><span className="text-terminal-muted">Out when price breaks</span><span className="text-terminal-text">{fmtP(exitLevel)}</span></div>}
              <button onClick={findExit} disabled={!x1 || !x2 || !x3 || !!xProblem || findingX} className={`${btn} ${on} w-full justify-center disabled:opacity-40`}>
                {findingX ? 'Looking…' : xfour ? 'Find the exit again' : 'Find the exit'}
              </button>
              {xfour && <div className="flex justify-between"><span className="text-terminal-muted">Exit (E4)</span><span className="text-rose-400">{fmtP(xfour.p)} · {fmtVan(xfour.t)}</span></div>}
              {xMsg && <p className="text-terminal-muted leading-relaxed">{xMsg}</p>}
              <p className="text-[10px] text-terminal-dim">Saved with the example as the structure exit. Pick an exit plan with "Break of structure" and the result uses it.</p>
            </div>
          )}
          <div className="space-y-1">
            <div className={label}>Setup name</div>
            <input value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="What you call this entry" className={field} />
          </div>
          <div className="rounded border border-terminal-border p-2 space-y-2">
            <div className={label}>Save this example to these skills</div>
            <div className="flex flex-wrap gap-1.5">
              {taughtSkills.map((k) => (
                <button key={k.key} onClick={() => toggleTeach(k.key)} className={`${btn} ${teaches.includes(k.key) ? 'border-sky-400 text-sky-400 bg-sky-400/10' : idle}`} title={k.description || ''}>
                  {teaches.includes(k.key) ? '✓ ' : ''}{k.name}{inferredKeys.includes(k.key) ? '' : ''}
                </button>
              ))}
            </div>
            <p className="text-[10px] font-mono text-terminal-dim">{skillsTaught.length ? `From the marks: ${skillsTaught.join(' · ')}. ` : 'Mark a 1-2-3, an exit 1-2-3, or call the trend and the matching skills tick themselves. '}Tick or untick to change what this example teaches.</p>
            <div className={label}>Trend at the entry (15-minute)</div>
            <div className="grid grid-cols-3 gap-1.5">
              {[['up', 'Up'], ['down', 'Down'], ['none', 'No trend']].map(([v, l]) => (
                <button key={v} onClick={() => setTrend({ value: v, source: 'mike' })} className={`${btn} justify-center ${trend?.value === v ? (trend.source === 'mike' ? on : 'border-sky-400 text-sky-400 bg-sky-400/10') : idle}`}>{l}</button>
              ))}
            </div>
            <p className="text-[10px] font-mono text-terminal-dim">{trend?.source === 'ema' ? 'Blue = the EMA\'s guess (price side and slope of the 15-minute 50 EMA). Click to confirm or correct it.' : trend ? 'Your call.' : 'Pick one; the EMA guess fills in once the chart and a box are there.'}</p>
            <div className={label}>Edge you had in mind (a tag only)</div>
            <select value={edge?.id || ''} onChange={(e) => edgesApi.select(Number(e.target.value))} className="bg-terminal-surface border border-terminal-border rounded px-2 py-1.5 text-xs font-mono text-terminal-text w-full">
              {edgesApi.edges.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <p className="text-[10px] font-mono text-terminal-dim">Examples teach skills, not edges. The tag just remembers what you were working on; the result is worked out under that edge's exit.</p>
          </div>
          <div className="space-y-1">
            <div className={label}>Would you take it?</div>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => setForm((f) => ({ ...f, decision: 'take' }))} className={`${btn} justify-center ${form.decision === 'take' ? 'border-terminal-green text-terminal-green bg-terminal-green/10' : idle}`}>Take it</button>
              <button onClick={() => setForm((f) => ({ ...f, decision: 'skip' }))} className={`${btn} justify-center ${form.decision === 'skip' ? 'border-terminal-red text-terminal-red bg-terminal-red/10' : idle}`}>Skip it</button>
            </div>
          </div>
          {[['notes_entry', 'Why this entry', 'What you saw that says get in here (or why you would pass)'],
            ['notes_stop', 'Why the stop goes there', 'What the stop is hiding behind'],
            ['notes_target', 'Why that target', 'What price is likely to reach for'],
            ['notes_exit', 'Best exit', 'Mark it with the Best exit tool, then say why getting out there was best']].map(([k, title, ph]) => (
            <div key={k} className="space-y-1">
              <div className={label}>{title}</div>
              <textarea rows={k === 'notes_entry' ? 3 : 2} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={ph} className={`${field} resize-y`} />
            </div>
          ))}

          <button onClick={save} disabled={saving || !position} className={`${btn} ${on} w-full justify-center disabled:opacity-40`}>
            <Save size={14} />{saving ? 'Taking the pictures…' : editing ? 'Save changes' : 'Save example'}
          </button>
          {message && <p className={`text-xs font-mono ${message.ok ? 'text-terminal-green' : 'text-terminal-red'}`}>{message.text}</p>}

          {editing && (
            <div className="rounded border border-terminal-border p-2 space-y-2">
              <div className={label}>Clef's read of this example</div>
              <ClefPanel exampleId={editing.id} skillNames={Object.fromEntries(taughtSkills.map((k) => [k.key, k.name]))} compact />
            </div>
          )}
          {editing && (
            <div className="rounded border border-terminal-border p-2 space-y-2">
              <div className={label}>What happened</div>
              <p className="text-xs font-mono text-terminal-text leading-relaxed">{describeOutcome(editing.outcome)}</p>
              {editing.outcome?.best_exit_r != null && <p className="text-xs font-mono text-purple-400">Your best exit was worth {editing.outcome.best_exit_r > 0 ? '+' : ''}{editing.outcome.best_exit_r}R.</p>}
              {editing.images && Object.keys(editing.images).length > 0 && (
                <>
                  <div className={label}>Pictures kept</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {Object.keys(editing.images).sort().map((n) => [n, n.replace(/^top/, 'Chart 1').replace(/^bottom/, 'Chart 2').replace(/^third/, 'Chart 3').replace('_decision', ' · at entry').replace('_full', ' · after').replace(/_step(\d)/, ' · point $1').replace('_exit', ' · at the exit')]).filter(([n]) => editing.images[n]).map(([n, cap]) => {
                      const src = `${tdImageUrl(editing.id, n)}?v=${encodeURIComponent(editing.updated_at || '')}`;
                      return (
                        <button key={n} onClick={() => setZoom({ src, cap })} className="text-left">
                          <img src={src} alt={cap} className="w-full rounded border border-terminal-border" />
                          <span className="text-[10px] font-mono text-terminal-dim">{cap}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="space-y-1.5 pt-1">
            <div className={label}>Saved examples ({examples.length})</div>
            {examples.length === 0 && <p className="text-xs font-mono text-terminal-dim">None yet. Your first save lands here.</p>}
            {examples.map((ex) => {
              const r = ex.outcome?.result;
              return (
                <div key={ex.id} className={`flex items-center gap-2 rounded border px-2 py-1.5 cursor-pointer ${editing?.id === ex.id ? 'border-amber-400' : 'border-terminal-border hover:bg-terminal-hover'}`} onClick={() => open(ex.id)}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-terminal-text truncate">{ex.setup || 'Unnamed'} · {ex.side} · {ex.decision === 'take' ? 'take' : 'skip'}</div>
                    <div className="text-[10px] font-mono text-terminal-dim">{fmtVanYear(ex.entry_time)} · {(ex.charts?.tfs || [ex.top_tf, ex.bottom_tf]).map((t) => TF_LABEL[t]).join(' / ')}</div>
                  </div>
                  <span className={`text-[10px] font-mono ${ex.outcome?.r > 0 ? 'text-terminal-green' : ex.outcome?.r < 0 ? 'text-terminal-red' : r === 'open' ? 'text-terminal-muted' : 'text-terminal-text'}`}>
                    {ex.outcome?.r != null ? `${ex.outcome.r > 0 ? '+' : ''}${ex.outcome.r}R` : 'open'}
                  </span>
                  <button onClick={(e) => { e.stopPropagation(); remove(ex.id); }} className={`flex items-center gap-1 ${armRemove === ex.id ? 'text-terminal-red' : 'text-terminal-dim hover:text-terminal-red'}`} title="Remove this example (it goes to the removed list in the Library)">
                    {armRemove === ex.id && <span className="text-[10px]">click again</span>}<Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] font-mono text-terminal-dim pt-2">Charts drawn with TradingView Lightweight Charts. Gold prices from the Eightcap demo MetaTrader.</p>
        </div>
      </div>

      {zoom && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-6" onClick={() => setZoom(null)}>
          <img src={zoom.src} alt={zoom.cap} className="max-w-full max-h-[90%] rounded border border-terminal-border" />
          <span className="mt-2 text-xs font-mono text-white">{zoom.cap} · click anywhere to close</span>
        </div>
      )}
    </div>
  );
}
