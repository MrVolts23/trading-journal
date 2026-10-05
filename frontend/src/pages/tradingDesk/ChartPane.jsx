import { useEffect, useRef, useState, useMemo, useImperativeHandle, forwardRef, useId } from 'react';
import { flushSync } from 'react-dom';
import { createChart, CrosshairMode } from 'lightweight-charts';
import {
  toChartTime, timeToIndex, indexToTime, sessionBoxes, TF_LABEL, newId, isPosition, positionStats, clampPosition, round2, fmtP, tick,
} from './trainerUtil';

// One chart (candles + the two EMAs) with a drawing layer on top.
// The chart library draws candles and scales; everything Mike draws lives in the SVG layer above it and
// is positioned from times + prices, so the same drawing appears on both charts.

const COLORS = { up: '#26a69a', down: '#ef5350', ema50: '#3b82f6', ema200: '#22c55e', target: '#26a69a', stop: '#ef5350', entry: '#8a8f9c', draw: '#e0b341' };
const FONT = 'ui-monospace, Menlo, monospace';
const CHAR_W = 6.65; // width of one character at 11px in the font above (labels size themselves from this)

// The Alchemy mark for the chart corner, loaded once as embedded data so it also lands in the saved pictures.
let _markPromise = null;
const loadMark = () => (_markPromise ||= fetch('/alchemy-mark.png').then((r) => (r.ok ? r.blob() : Promise.reject(new Error('no mark'))))
  .then((b) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); }))
  .catch(() => null));

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const light = document.documentElement.classList.contains('light');
  return {
    bg: (cs.getPropertyValue('--t-bg') || (light ? '#f4f4f5' : '#0a0a0a')).trim(),
    text: light ? '#52525b' : '#9aa0aa',
    grid: light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.045)',
    border: light ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.12)',
    labelBg: light ? '#ffffff' : '#111418',
    labelText: light ? '#18181b' : '#e6e8eb',
  };
}

function Label({ x, y, text, bg, fg = '#fff', stroke, anchor = 'start' }) {
  const w = text.length * CHAR_W + 10;
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return (
    <g pointerEvents="none">
      <rect x={left} y={y - 9} width={w} height={18} rx={3} fill={bg} stroke={stroke || 'none'} strokeWidth={1} />
      <text x={left + 5} y={y + 4} fontSize={11} fontFamily={FONT} fill={fg}>{text}</text>
    </g>
  );
}

const ChartPane = forwardRef(function ChartPane({
  bars, shownN, partial, tf, timeframes, onTfChange, title, area, symbolName, digits = 2,
  drawings, selectedId, tool, onDrawingsChange, onSelect, onToolDone, onPick, showInfo, guide, onGuide, onStep, onXStep,
  hoverT, hoverP, onHover, onUserScroll, onActive, standard, locked,
}, ref) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const appliedRef = useRef({ bars: null, shownN: 0, hadPartial: false });
  const activeRef = useRef(false);
  const rightTRef = useRef(null);
  const leftTRef = useRef(null);   // the visible window as TIMES, so a timeframe change keeps the same zoomed-in stretch
  const dragRef = useRef(null);
  const capturingRef = useRef(false); // while a picture is being taken, the chart's moves are not passed to the other chart
  const live = useRef({});
  live.current = { bars, shownN, partial, drawings, tool, onDrawingsChange, onSelect, onToolDone, onHover, onUserScroll, onPick, onGuide, onStep, onXStep, standard };
  const clipId = useId().replace(/:/g, '');

  const [view, setView] = useState(null);          // how times/prices map to pixels right now
  const [override, setOverride] = useState(null);  // while a picture is being taken: { shownN, hideExit }
  const stdActiveRef = useRef(false);               // the price scale is locked right now (the button, or mid-capture)
  const [stdActive, setStdActive] = useState(false);
  const [colors, setColors] = useState(themeColors);
  const [mark, setMark] = useState(null);
  useEffect(() => { let dead = false; loadMark().then((m) => { if (!dead) setMark(m); }); return () => { dead = true; }; }, []);

  // ── candle / EMA objects for the chart library (built once per timeframe) ───────────
  const prepared = useMemo(() => {
    if (!bars || !bars.n) return null;
    const n = bars.n, candles = new Array(n), e50 = new Array(n), e200 = new Array(n);
    for (let i = 0; i < n; i++) {
      const time = toChartTime(bars.t[i]);
      candles[i] = { time, open: bars.o[i], high: bars.h[i], low: bars.l[i], close: bars.c[i] };
      e50[i] = bars.e50[i] == null ? null : { time, value: bars.e50[i] };
      e200[i] = bars.e200[i] == null ? null : { time, value: bars.e200[i] };
    }
    return { candles, e50, e200 };
  }, [bars]);
  const preparedRef = useRef(null); preparedRef.current = prepared;

  // ── chart lifecycle ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = themeColors();
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: { background: { color: c.bg }, textColor: c.text, fontFamily: FONT, fontSize: 11, attributionLogo: false }, // credit to TradingView is in the Trainer's side panel
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7, minBarSpacing: 0.4 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const candle = chart.addCandlestickSeries({
      upColor: COLORS.up, downColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down, borderVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, priceLineVisible: false,
      // auto-fit the price scale around the candles AND any long/short box in view, so stop and target stay visible
      autoscaleInfoProvider: (original) => {
        const res = original();
        const L = live.current, r = chart.timeScale().getVisibleLogicalRange();
        if (!res || !res.priceRange || !L.bars || !r) return res;
        // Standard view: a fixed number of dollars per pixel, centred on the trade (or the middle of what is shown),
        // so every picture shows the same scale whatever the window size
        // Locked scale: a fixed number of dollars per pixel, centred on the marks (or on the candles if nothing is drawn)
        if (stdActiveRef.current && stdBoxRef.current) {
          const b = stdBoxRef.current, el = boxRef.current;
          const paneH = el ? el.clientHeight - chart.timeScale().height() : 0;
          const span = paneH > 0 ? (paneH / L.standard.pxPerStep) * L.standard.step : L.standard.step * 10;
          return { priceRange: { minValue: b.mid - span / 2, maxValue: b.mid + span / 2 }, margins: { above: 0, below: 0 } };
        }
        const a = indexToTime(L.bars, r.from), b = indexToTime(L.bars, r.to);
        let { minValue, maxValue } = res.priceRange;
        for (const d of L.drawings) {
          if (!isPosition(d) || d.t > b || d.t2 < a) continue;
          minValue = Math.min(minValue, d.stop, d.target); maxValue = Math.max(maxValue, d.stop, d.target);
        }
        return { ...res, priceRange: { minValue, maxValue } };
      },
    });
    // the EMA lines never stretch the price scale in Standard view (the 1-hour 200 EMA can sit far from price)
    const line = (color) => chart.addLineSeries({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      autoscaleInfoProvider: (original) => (stdActiveRef.current ? null : original()) });
    const e50 = line(COLORS.ema50), e200 = line(COLORS.ema200);
    chartRef.current = chart; seriesRef.current = { candle, e50, e200 };
    appliedRef.current = { bars: null, shownN: 0, hadPartial: false }; // a fresh chart has nothing on it yet

    chart.subscribeCrosshairMove((p) => {
      const L = live.current;
      if (!L.bars || !activeRef.current) return;
      if (!(p && p.logical != null && p.point)) { L.onHover(null); return; }
      const price = seriesRef.current.candle?.coordinateToPrice(p.point.y);
      L.onHover(indexToTime(L.bars, p.logical), price == null ? null : price);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      const L = live.current;
      if (!range || !L.bars) return;
      rightTRef.current = indexToTime(L.bars, range.to); leftTRef.current = indexToTime(L.bars, range.from);
      setView(readView()); // keep the drawings glued on even when the window is in the background (no animation frames)
      if (activeRef.current && !dragRef.current && !capturingRef.current) L.onUserScroll(rightTRef.current);
    });

    // keep the drawing layer glued to the chart: re-read the mapping every frame, re-render only when it moved
    let raf = 0, last = '';
    const loop = () => {
      const v = readView();
      const sig = v ? `${v.x0.toFixed(2)}|${v.sp.toFixed(4)}|${v.ky.toFixed(5)}|${v.by.toFixed(2)}|${v.w}|${v.h}|${v.paneW}` : '';
      if (sig !== last) { last = sig; setView(v); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const obs = new MutationObserver(() => {
      const t = themeColors(); setColors(t);
      chart.applyOptions({ layout: { background: { color: t.bg }, textColor: t.text }, grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } }, rightPriceScale: { borderColor: t.border }, timeScale: { borderColor: t.border } });
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => { cancelAnimationFrame(raf); obs.disconnect(); chart.remove(); chartRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Locked scale ───────────────────────────────────────────────────────────────────
  // The chart keeps its pane size. What is fixed: dollars per pixel (22 px per $2/$4 step) and candle width. The
  // price range is centred on the marks, so the pictures all share one scale and the picture is just the pane.
  const stdBox = useMemo(() => {
    if (!standard || !bars || !bars.n) return null;
    const S = standard;
    const ts = [], ps = [];
    for (const d of drawings) {
      if (isPosition(d)) { ts.push(d.t, d.t2); ps.push(d.entry, d.stop, d.target); }
      else if (d.type === 'trend' || d.type === 'rect') { ts.push(d.t1, d.t2); ps.push(d.p1, d.p2); }
      else if (d.type === 'hline') ps.push(d.price);
      else if (d.t != null && d.p != null) { ts.push(d.t); ps.push(d.p); }
    }
    const lastShown = Math.max(0, Math.min(shownN == null ? bars.n : shownN, bars.n) - 1);
    let fromIdx = null, toIdx = null;
    if (ts.length) { fromIdx = Math.floor(timeToIndex(bars, Math.min(...ts))); toIdx = Math.ceil(timeToIndex(bars, Math.max(...ts))); }
    if (!ps.length) { const a = fromIdx ?? Math.max(0, lastShown - 120), b = toIdx ?? lastShown; for (let i = Math.max(0, a); i <= Math.min(bars.n - 1, b); i++) ps.push(bars.h[i], bars.l[i]); }
    if (!ps.length) ps.push(bars.c[lastShown]);
    const lo = Math.min(...ps), hi = Math.max(...ps);
    return { mid: (lo + hi) / 2, lo, hi, fromIdx, toIdx, spanNeeded: (hi - lo) / S.step + 2 * S.padSteps };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standard, bars, drawings, shownN]);
  const stdBoxRef = useRef(null); stdBoxRef.current = stdBox;
  // does the marked trade fit the pane at the locked scale?
  const [fitsNote, setFitsNote] = useState('');
  const applyLock = (sync = false) => {
    const chart = chartRef.current, b = stdBoxRef.current, el = boxRef.current; if (!chart || !b || !el) return false;
    stdActiveRef.current = true;
    chart.applyOptions({ grid: { horzLines: { visible: false } }, rightPriceScale: { scaleMargins: { top: 0, bottom: 0 } }, timeScale: { barSpacing: standard.barSpacing } });
    chart.priceScale('right').applyOptions({ autoScale: true });
    // centre the marks sideways too (keeps the user's own scroll if nothing is drawn)
    const paneW = el.clientWidth - chart.priceScale('right').width();
    if (b.fromIdx != null) { const bars_ = paneW / standard.barSpacing, mid = (b.fromIdx + b.toIdx) / 2; chart.timeScale().setVisibleLogicalRange({ from: mid - bars_ / 2, to: mid + bars_ / 2 }); }
    const paneH = el.clientHeight - chart.timeScale().height();
    const stepsAvail = paneH / standard.pxPerStep;
    const note = b.spanNeeded > stepsAvail ? `The marks span ${fmtP(b.hi - b.lo)} but this chart only shows ${fmtP(stepsAvail * standard.step)} at ${fmtP(standard.step)} per line. Make the chart taller or use a bigger step.` : '';
    if (sync) flushSync(() => { setStdActive(true); setFitsNote(note); }); else { setStdActive(true); setFitsNote(note); }
    return true;
  };
  const releaseLock = (sync = false) => {
    const chart = chartRef.current; if (!chart) return;
    stdActiveRef.current = false;
    const c = themeColors();
    chart.applyOptions({ grid: { horzLines: { visible: true, color: c.grid } }, rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.08 } }, timeScale: { barSpacing: 7 } });
    chart.priceScale('right').applyOptions({ autoScale: true });
    if (sync) flushSync(() => { setStdActive(false); setFitsNote(''); }); else { setStdActive(false); setFitsNote(''); }
  };
  useEffect(() => {
    if (locked && stdBox) applyLock(); else if (!locked && stdActiveRef.current && !capturingRef.current) releaseLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, stdBox && stdBox.mid, stdBox && stdBox.fromIdx, stdBox && stdBox.toIdx, standard && standard.step, standard && standard.pxPerStep]);
  // where a mouse event lands inside the (possibly scrolled) chart box
  const localXY = (e) => { const r = svgRef.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function readView() {
    const chart = chartRef.current, s = seriesRef.current.candle, el = boxRef.current;
    if (!chart || !s || !el) return null;
    const ts = chart.timeScale();
    const x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(1);
    const ref = live.current.bars && live.current.bars.n ? live.current.bars.c[live.current.bars.n - 1] : 1000;
    const stepP = ref * 0.01 || 1; // a 1% price step keeps the maths sane for gold (4000s) and forex (1.2xx) alike
    const y1 = s.priceToCoordinate(ref), y2 = s.priceToCoordinate(ref + stepP);
    if (x0 == null || x1 == null || y1 == null || y2 == null) return null;
    const w = el.clientWidth, h = el.clientHeight;
    const ky = (y2 - y1) / stepP;
    return { x0, sp: x1 - x0, ky, by: y1 - ky * ref, w, h, paneW: w - chart.priceScale('right').width(), paneH: h - ts.height() };
  }

  // ── put data on the chart (all of it, or only up to the replay cursor) ───────────────
  function applyData(force) {
    const chart = chartRef.current, P = preparedRef.current, { candle, e50, e200 } = seriesRef.current;
    if (!chart) return;
    const L = live.current, A = appliedRef.current;
    if (!P || !L.bars) { candle.setData([]); e50.setData([]); e200.setData([]); appliedRef.current = { bars: null, shownN: 0, hadPartial: false }; return; }
    const n = L.shownN == null ? L.bars.n : Math.max(0, Math.min(L.shownN, L.bars.n));
    const part = L.shownN == null ? null : L.partial;
    const partPoint = part ? { time: toChartTime(part.t), open: part.o, high: part.h, low: part.l, close: part.c } : null;
    const sameBars = A.bars === L.bars;
    const smallStep = sameBars && !force && n >= A.shownN && n - A.shownN <= 6;
    if (smallStep) {
      // stepping forward in replay: add the new candles one by one (fast, and the view does not jump)
      for (let i = Math.max(0, A.shownN - (A.hadPartial ? 0 : 1)); i < n; i++) {
        if (i < 0) continue;
        candle.update(P.candles[i]);
        if (P.e50[i]) e50.update(P.e50[i]);
        if (P.e200[i]) e200.update(P.e200[i]);
      }
      if (partPoint) {
        candle.update(partPoint);
        if (part.e50 != null) e50.update({ time: partPoint.time, value: part.e50 });
        if (part.e200 != null) e200.update({ time: partPoint.time, value: part.e200 });
      }
    } else {
      const range = sameBars ? chart.timeScale().getVisibleLogicalRange() : null;
      const keepL = leftTRef.current, keepR = rightTRef.current; // read before the new candles go on
      const cs = n === L.bars.n ? P.candles : P.candles.slice(0, n);
      const a = (n === L.bars.n ? P.e50 : P.e50.slice(0, n)).filter(Boolean);
      const b = (n === L.bars.n ? P.e200 : P.e200.slice(0, n)).filter(Boolean);
      if (partPoint) {
        candle.setData([...cs, partPoint]);
        e50.setData(part.e50 != null ? [...a, { time: partPoint.time, value: part.e50 }] : a);
        e200.setData(part.e200 != null ? [...b, { time: partPoint.time, value: part.e200 }] : b);
      } else { candle.setData(cs); e50.setData(a); e200.setData(b); }
      if (range) chart.timeScale().setVisibleLogicalRange(range);
      else {
        // a new timeframe: keep looking at exactly the same stretch of time (same zoom, same place)
        const to = keepR != null ? timeToIndex(L.bars, keepR) : n + 8;
        const from = keepL != null && keepR != null ? timeToIndex(L.bars, keepL) : to - 160;
        chart.timeScale().setVisibleLogicalRange({ from: Math.min(from, to - 5), to });
        chart.priceScale('right').applyOptions({ autoScale: true });
      }
    }
    appliedRef.current = { bars: L.bars, shownN: n, hadPartial: !!partPoint };
    setView(readView());
  }
  useEffect(() => { applyData(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [prepared, shownN, partial]);
  useEffect(() => { seriesRef.current.candle?.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } }); }, [digits]);

  // ── things the page can ask this chart to do ─────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    rightVisibleIndex() {
      const r = chartRef.current?.timeScale().getVisibleLogicalRange();
      const L = live.current;
      if (!r || !L.bars) return null;
      return Math.max(0, Math.min(L.bars.n - 1, Math.floor(r.to)));
    },
    alignRightEdge(T) {
      const chart = chartRef.current, L = live.current;
      if (!chart || !L.bars) return;
      const r = chart.timeScale().getVisibleLogicalRange(); if (!r) return;
      const to = timeToIndex(L.bars, T);
      chart.timeScale().setVisibleLogicalRange({ from: to - (r.to - r.from), to });
    },
    centerOn(T) {
      const chart = chartRef.current, L = live.current;
      if (!chart || !L.bars) return;
      const r = chart.timeScale().getVisibleLogicalRange(); const width = r ? r.to - r.from : 160;
      const at = timeToIndex(L.bars, T);
      chart.timeScale().setVisibleLogicalRange({ from: at - width * 0.65, to: at + width * 0.35 });
    },
    keepInView(index) {
      const chart = chartRef.current; const r = chart?.timeScale().getVisibleLogicalRange(); if (!r) return;
      if (index > r.to - 3) chart.timeScale().setVisibleLogicalRange({ from: r.from + (index - r.to + 3), to: index + 3 });
    },
    // A PNG of this chart with the drawings on it, framed the same way every time (the entry sits about
    // two-thirds across). `shownN` limits the candles to what existed at that moment (the decision picture);
    // the chart is redrawn for an instant, photographed, then put back exactly as it was.
    async capture({ shownN: capN = null, partial: capPartial = null, hideExit = false, frameT = null, frameToT = null, onlyPosId = null, cutT = null } = {}) {
      const chart = chartRef.current; if (!chart || !live.current.bars) return null;
      const keep = { shownN: live.current.shownN, partial: live.current.partial };
      const range = chart.timeScale().getVisibleLogicalRange();
      const fullN = live.current.bars.n;
      let wasStd = false;
      capturingRef.current = true;
      try {
        live.current = { ...live.current, shownN: capN == null ? fullN : capN, partial: capN == null ? null : capPartial };
        applyData(true);
        // every picture is taken in the standard box: fixed scale, sized so that every mark fits
        if (stdBoxRef.current) { wasStd = stdActiveRef.current; applyLock(true); }
        else if (frameT != null) { const at = timeToIndex(live.current.bars, frameT); const end = frameToT != null ? timeToIndex(live.current.bars, frameToT) + 10 : 0; chart.timeScale().setVisibleLogicalRange({ from: at - 110, to: Math.max(at + 55, end) }); }
        else if (range) chart.timeScale().setVisibleLogicalRange(range);
        chart.priceScale('right').applyOptions({ autoScale: true });
        const shot = chart.takeScreenshot();       // also settles the chart's layout for the data just set
        const v = readView();
        flushSync(() => { setView(v); setOverride({ shownN: capN == null ? fullN : capN, hideExit, cutT: cutT != null ? cutT : hideExit ? frameT : null, onlyPosId }); });
        const svg = new XMLSerializer().serializeToString(svgRef.current);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('could not draw the marks onto the picture')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
        const out = document.createElement('canvas'); out.width = shot.width; out.height = shot.height;
        const ctx = out.getContext('2d'); ctx.drawImage(shot, 0, 0); ctx.drawImage(img, 0, 0, out.width, out.height);
        return out.toDataURL('image/png');
      } finally {
        live.current = { ...live.current, shownN: keep.shownN, partial: keep.partial };
        applyData(true);
        if (stdBoxRef.current && !wasStd) releaseLock(true);
        if (range && !wasStd) chart.timeScale().setVisibleLogicalRange(range);
        chart.takeScreenshot();
        flushSync(() => { setOverride(null); setView(readView()); });
        capturingRef.current = false;
      }
    },
  }));

  // ── pixels <-> time / price ──────────────────────────────────────────────────────────
  const X = (T) => view.x0 + timeToIndex(bars, T) * view.sp;
  const Y = (p) => view.by + view.ky * p;
  function pointFromEvent(e, snap = true) {
    const { x, y } = localXY(e);
    const v = view;
    const idx = (x - v.x0) / v.sp;
    return { x, y, idx: snap ? Math.round(idx) : idx, t: indexToTime(bars, snap ? Math.round(idx) : idx), p: round2((y - v.by) / v.ky) };
  }
  const barSeconds = (bars ? bars.tf : tf) * 60;

  const setDrawings = (fn) => live.current.onDrawingsChange(fn(live.current.drawings));
  const patch = (id, next) => setDrawings((ds) => ds.map((d) => (d.id === id ? next : d)));

  // ── placing a new drawing ────────────────────────────────────────────────────────────
  function onPlaceDown(e) {
    if (!view || !bars) return;
    e.preventDefault();
    const pt = pointFromEvent(e);
    const visiblePrices = view.paneH / Math.abs(view.ky);
    if (tool === 'pick') { live.current.onPick(pt.t); onToolDone(); return; }
    if (tool === 'steps' || tool === 'xsteps') {
      // the 1-2-3 marks (entry, or the opposite 1-2-3 for the exit): click a finished candle; the mark snaps to its
      // high or low, whichever is nearer the click
      const c = candleAt(e); if (!c) return;
      if (tool === 'steps') live.current.onStep(c); else live.current.onXStep(c);
      return;
    }
    if (tool === 'long' || tool === 'short') {
      const risk = Math.max(50 * tick(), round2(visiblePrices * 0.05));
      const d = clampPosition({
        id: newId(), type: tool, t: pt.t, t2: pt.t + 14 * barSeconds, entry: pt.p,
        stop: round2(tool === 'long' ? pt.p - risk : pt.p + risk), target: round2(tool === 'long' ? pt.p + 2 * risk : pt.p - 2 * risk),
      });
      setDrawings((ds) => [...ds, d]); // several longs/shorts can sit on the charts at once
      onSelect(d.id); onToolDone();
    } else if (tool === 'hline') {
      const d = { id: newId(), type: 'hline', price: pt.p };
      setDrawings((ds) => [...ds, d]); onSelect(d.id); onToolDone();
    } else if (tool === 'text') {
      const d = { id: newId(), type: 'text', t: pt.t, p: pt.p, text: 'Note' };
      setDrawings((ds) => [...ds, d]); onSelect(d.id); onToolDone();
    } else if (tool === 'exit') {
      const d = { id: newId(), type: 'exit', t: pt.t, p: pt.p };
      setDrawings((ds) => [...ds.filter((x) => x.type !== 'exit'), d]); onSelect(d.id); onToolDone();
    } else if (tool === 'trend' || tool === 'rect') {
      const d = { id: newId(), type: tool, t1: pt.t, p1: pt.p, t2: pt.t, p2: pt.p };
      setDrawings((ds) => [...ds, d]); onSelect(d.id);
      dragRef.current = { id: d.id, handle: 'p2', start: pt, orig: d, placing: true };
      svgRef.current.setPointerCapture(e.pointerId);
    }
  }

  // the candle under the pointer, with the nearer of its high and low
  function candleAt(e) {
    const { x, y } = localXY(e);
    const shown = live.current.shownN == null ? bars.n : Math.min(live.current.shownN, bars.n);
    const i = Math.floor((x - view.x0) / view.sp + 0.5); // bar i is drawn centred on index i
    if (i < 0 || i >= shown) return null;
    const dh = Math.abs(Y(bars.h[i]) - y), dl = Math.abs(Y(bars.l[i]) - y);
    const kind = dh <= dl ? 'high' : 'low';
    return { t: bars.t[i], tf: bars.tf, p: kind === 'high' ? bars.h[i] : bars.l[i], kind, h: bars.h[i], l: bars.l[i] };
  }

  // ── moving / reshaping an existing drawing ───────────────────────────────────────────
  function startDrag(e, d, handle) {
    if (tool !== 'cursor') return;
    e.preventDefault(); e.stopPropagation();
    onSelect(d.id);
    dragRef.current = { id: d.id, handle, start: pointFromEvent(e), orig: d };
    svgRef.current.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    const g = dragRef.current; if (!g || !view) return;
    const pt = pointFromEvent(e), o = g.orig;
    const dIdx = pt.idx - g.start.idx, dP = round2(pt.p - g.start.p);
    const shiftT = (T) => indexToTime(bars, Math.round(timeToIndex(bars, T) + dIdx));
    let n = o;
    if (isPosition(o)) {
      if (g.handle === 'target') n = { ...o, target: pt.p };
      else if (g.handle === 'stop') n = { ...o, stop: pt.p };
      else if (g.handle === 'right') n = { ...o, t2: Math.max(pt.t, o.t + barSeconds) };
      else if (g.handle === 'entry') n = { ...o, t: Math.min(pt.t, o.t2 - barSeconds), entry: pt.p };
      else n = { ...o, t: shiftT(o.t), t2: shiftT(o.t2), entry: round2(o.entry + dP), stop: round2(o.stop + dP), target: round2(o.target + dP) };
      n = clampPosition(n);
    } else if (o.type === 'trend' || o.type === 'rect') {
      if (g.handle === 'p1') n = { ...o, t1: pt.t, p1: pt.p };
      else if (g.handle === 'p2') n = { ...o, t2: pt.t, p2: pt.p };
      else n = { ...o, t1: shiftT(o.t1), t2: shiftT(o.t2), p1: round2(o.p1 + dP), p2: round2(o.p2 + dP) };
    } else if (o.type === 'hline') n = { ...o, price: round2(o.price + dP) };
    else if (o.type === 'text' || o.type === 'exit') n = { ...o, t: shiftT(o.t), p: round2(o.p + dP) };
    else if (o.type === 'step' || o.type === 'xstep') { // steps 1-3 slide from candle to candle and keep snapping to a high or low
      if (o.n === 4) return;
      const c = candleAt(e); if (!c) return;
      n = { ...o, t: c.t, tf: c.tf, p: o.kind === 'high' ? c.h : c.l }; // a mark keeps being a top or a bottom while it slides
    }
    patch(o.id, n);
    // a dotted line across both charts at the price being dragged, to line it up with candles
    const gp = isPosition(n) ? (g.handle === 'target' ? n.target : g.handle === 'stop' ? n.stop : g.handle === 'right' ? null : n.entry)
      : n.type === 'hline' ? n.price : (n.type === 'text' || n.type === 'exit' || n.type === 'step' || n.type === 'xstep') ? n.p
      : g.handle === 'p1' ? n.p1 : g.handle === 'p2' ? n.p2 : null;
    live.current.onGuide(gp);
  }
  function onUp(e) {
    const g = dragRef.current; if (!g) return;
    dragRef.current = null; live.current.onGuide(null);
    try { svgRef.current.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (g.placing) {
      const pt = pointFromEvent(e);
      if (Math.abs(pt.x - g.start.x) < 4 && Math.abs(pt.y - g.start.y) < 4) {
        // a plain click: give the new line / box a sensible starting size
        const span = 12 * barSeconds, dy = round2((view.paneH / Math.abs(view.ky)) * 0.06);
        patch(g.id, { ...g.orig, t2: g.orig.t1 + span, p2: g.orig.type === 'rect' ? round2(g.orig.p1 - dy) : g.orig.p1 });
      }
      onToolDone();
    }
  }

  // ── what to draw ─────────────────────────────────────────────────────────────────────
  const effShown = override ? (override.shownN == null ? (bars ? bars.n : 0) : override.shownN) : (shownN == null ? (bars ? bars.n : 0) : shownN);
  const sessions = useMemo(() => {
    if (!view || !bars || !bars.n) return [];
    const i0 = Math.floor(-view.x0 / view.sp) - 2, i1 = Math.ceil((view.paneW - view.x0) / view.sp) + 2;
    if (view.sp < 0.6) return []; // zoomed far out: boxes would be slivers
    return sessionBoxes(bars, effShown, indexToTime(bars, i0), indexToTime(bars, i1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, effShown, view && Math.round(view.x0 / 8), view && view.sp, view && view.paneW]);

  const ready = view && bars && bars.n > 0;
  // gridlines every step ($2 on the fast chart, $4 on the slow one for gold) across the visible prices
  const stdLines = useMemo(() => {
    if (!stdActive || !ready) return [];
    const top = (0 - view.by) / view.ky, bottom = (view.paneH - view.by) / view.ky;
    const lo = Math.min(top, bottom), hi = Math.max(top, bottom), out = [];
    for (let p = Math.ceil(lo / standard.step) * standard.step; p <= hi; p += standard.step) out.push(+p.toFixed(8));
    return out.length > 400 ? [] : out;
  }, [stdActive, ready, view]);
  const scaleW = ready ? view.w - view.paneW : 0;
  const sel = (d) => d.id === selectedId;
  const info = (d) => showInfo || sel(d) || !!override; // (saved pictures always carry the numbers) // the words and price tags show for the selected mark, or for all when the toggle is on
  const grab = tool === 'cursor' ? 'move' : 'crosshair';
  const hit = (d, handle = 'body') => ({ onPointerDown: (e) => startDrag(e, d, handle), style: { cursor: grab, pointerEvents: tool === 'cursor' ? 'auto' : 'none' } });
  const Handle = ({ d, handle, x, y, cursor }) => (
    <circle cx={x} cy={y} r={5} fill={colors.bg} stroke="#3b82f6" strokeWidth={2} onPointerDown={(e) => startDrag(e, d, handle)} style={{ cursor, pointerEvents: 'auto' }} />
  );
  const Tag = ({ y, text, bg }) => (
    <g pointerEvents="none"><rect x={view.paneW} y={y - 9} width={Math.max(0, scaleW)} height={18} fill={bg} /><text x={view.paneW + 5} y={y + 4} fontSize={11} fontFamily={FONT} fill="#fff">{text}</text></g>
  );

  function renderDrawing(d) {
    if (d.type === 'exit' && override?.hideExit) return null;
    if (override?.onlyPosId && isPosition(d) && d.id !== override.onlyPosId) return null; // pictures show only the trade being saved
    // 1-2-3 entry and exit points belong to the chart they were clicked on; they do not mirror (boxes, lines, levels, labels do)
    if ((d.type === 'step' || d.type === 'xstep') && d.tf != null && bars && d.tf !== bars.tf) return null;
    // the decision picture shows only marks that could have been drawn by the entry moment
    if (override?.cutT != null && d.type !== 'hline' && Math.min(d.t ?? Infinity, d.t1 ?? Infinity, isPosition(d) ? Infinity : (d.t2 ?? Infinity)) > override.cutT) return null;
    if (isPosition(d)) {
      const xL = X(d.t), xR = Math.max(X(d.t2), xL + 12), yE = Y(d.entry), yS = Y(d.stop), yT = Y(d.target);
      const st = positionStats(d), long = d.type === 'long';
      const mid = (xL + xR) / 2, up = (y) => y - 13, dn = (y) => y + 13;
      return (
        <g key={d.id}>
          <rect x={xL} y={Math.min(yE, yT)} width={xR - xL} height={Math.abs(yT - yE)} fill={COLORS.target} fillOpacity={0.28} {...hit(d)} />
          <rect x={xL} y={Math.min(yE, yS)} width={xR - xL} height={Math.abs(yS - yE)} fill={COLORS.stop} fillOpacity={0.28} {...hit(d)} />
          <line x1={xL} x2={xR} y1={yE} y2={yE} stroke={COLORS.entry} strokeWidth={1.5} pointerEvents="none" />
          {info(d) && <>
          <Label x={mid} y={long ? up(yT) : dn(yT)} anchor="middle" bg={COLORS.target} text={`Target: ${fmtP(st.reward)} (${st.targetPct.toFixed(3)}%)`} />
          <Label x={mid} y={long ? dn(yS) : up(yS)} anchor="middle" bg={COLORS.stop} text={`Stop: ${fmtP(st.risk)} (${st.stopPct.toFixed(3)}%)`} />
          <Label x={mid} y={long ? up(yE) : dn(yE)} anchor="middle" bg={colors.labelBg} fg={colors.labelText} stroke={long ? COLORS.target : COLORS.stop} text={`${long ? 'Long' : 'Short'} · Risk/reward ratio: ${st.rr.toFixed(2)}`} />
          </>}
          {sel(d) && <>
            <Handle d={d} handle="entry" x={xL} y={yE} cursor="move" />
            <Handle d={d} handle="target" x={xL} y={yT} cursor="ns-resize" />
            <Handle d={d} handle="stop" x={xL} y={yS} cursor="ns-resize" />
            <Handle d={d} handle="right" x={xR} y={yE} cursor="ew-resize" />
          </>}
        </g>
      );
    }
    if (d.type === 'trend') {
      const x1 = X(d.t1), y1 = Y(d.p1), x2 = X(d.t2), y2 = Y(d.p2);
      return (
        <g key={d.id}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} {...hit(d)} />
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={COLORS.draw} strokeWidth={sel(d) ? 2.5 : 1.75} pointerEvents="none" />
          {info(d) && <Label x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 14} anchor="middle" bg={colors.labelBg} fg={colors.labelText} stroke={COLORS.draw} text={`Line: ${fmtP(d.p1)} to ${fmtP(d.p2)}`} />}
          {sel(d) && <><Handle d={d} handle="p1" x={x1} y={y1} cursor="move" /><Handle d={d} handle="p2" x={x2} y={y2} cursor="move" /></>}
        </g>
      );
    }
    if (d.type === 'rect') {
      const x1 = X(d.t1), y1 = Y(d.p1), x2 = X(d.t2), y2 = Y(d.p2);
      return (
        <g key={d.id}>
          <rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} fill={COLORS.draw} fillOpacity={0.12} stroke={COLORS.draw} strokeWidth={sel(d) ? 2 : 1.25} {...hit(d)} />
          {info(d) && <Label x={(x1 + x2) / 2} y={Math.min(y1, y2) - 13} anchor="middle" bg={colors.labelBg} fg={colors.labelText} stroke={COLORS.draw} text={`Box: ${fmtP(Math.max(d.p1, d.p2))} to ${fmtP(Math.min(d.p1, d.p2))}`} />}
          {sel(d) && <><Handle d={d} handle="p1" x={x1} y={y1} cursor="move" /><Handle d={d} handle="p2" x={x2} y={y2} cursor="move" /></>}
        </g>
      );
    }
    if (d.type === 'hline') {
      const y = Y(d.price);
      return (
        <g key={d.id}>
          <line x1={0} x2={view.paneW} y1={y} y2={y} stroke="transparent" strokeWidth={12} {...hit(d)} style={{ cursor: tool === 'cursor' ? 'ns-resize' : 'crosshair', pointerEvents: tool === 'cursor' ? 'auto' : 'none' }} />
          <line x1={0} x2={view.paneW} y1={y} y2={y} stroke={COLORS.draw} strokeWidth={sel(d) ? 2.25 : 1.5} pointerEvents="none" />
          {info(d) && <Label x={view.paneW - 8} y={y - 13} anchor="end" bg={colors.labelBg} fg={colors.labelText} stroke={COLORS.draw} text={`Level: ${fmtP(d.price)}`} />}
        </g>
      );
    }
    if (d.type === 'text') {
      const x = X(d.t), y = Y(d.p), w = (d.text || ' ').length * CHAR_W + 10;
      return (
        <g key={d.id}>
          <rect x={x} y={y - 9} width={w} height={18} rx={3} fill={colors.labelBg} stroke={sel(d) ? '#3b82f6' : COLORS.draw} strokeWidth={1} {...hit(d)} />
          <text x={x + 5} y={y + 4} fontSize={11} fontFamily={FONT} fill={colors.labelText} pointerEvents="none">{d.text}</text>
        </g>
      );
    }
    if (d.type === 'step' || d.type === 'xstep') {
      // numbered tag on the candle's high or low; 4 is the moment the app found (entry, or the exit for E4)
      const isExit = d.type === 'xstep';
      const x = d.n === 4 ? X(d.t) : X(d.t + (d.tf || 1) * 30), y = Y(d.p);
      const above = d.kind === 'high';
      const cy = above ? y - 14 : y + 14, col = d.n === 4 ? (isExit ? '#f43f5e' : '#e0b341') : isExit ? '#fb923c' : '#38bdf8';
      return (
        <g key={d.id}>
          <line x1={x} x2={x} y1={y} y2={cy} stroke={col} strokeWidth={1} pointerEvents="none" />
          <circle cx={x} cy={cy} r={sel(d) ? 10 : 9} fill={col} stroke={colors.bg} strokeWidth={1.5} {...hit(d)} />
          <text x={x} y={cy + 4} textAnchor="middle" fontSize={isExit ? 9 : 11} fontWeight="700" fontFamily={FONT} fill="#0a0a0a" pointerEvents="none">{isExit ? `E${d.n}` : d.n}</text>
          {info(d) && <Label x={x + 14} y={cy} bg={colors.labelBg} fg={colors.labelText} stroke={col} text={`${d.n === 4 ? (isExit ? 'Exit' : 'Entry') : d.kind === 'high' ? 'Top' : 'Bottom'} ${fmtP(d.p)}`} />}
        </g>
      );
    }
    if (d.type === 'exit') {
      const x = X(d.t), y = Y(d.p);
      return (
        <g key={d.id}>
          <line x1={x - 22} x2={x + 22} y1={y} y2={y} stroke="#a855f7" strokeWidth={2} pointerEvents="none" />
          <circle cx={x} cy={y} r={sel(d) ? 7 : 6} fill="#a855f7" stroke="#fff" strokeWidth={1.5} {...hit(d)} />
          {info(d) && <Label x={x + 12} y={y - 14} bg="#a855f7" text={`Best exit ${fmtP(d.p)}`} />}
        </g>
      );
    }
    return null;
  }

  const tags = [];
  if (ready) for (const d of drawings) {
    if (!info(d)) continue;
    if (override?.onlyPosId && isPosition(d) && d.id !== override.onlyPosId) continue;
    if (override?.cutT != null && d.type !== 'hline' && Math.min(d.t ?? Infinity, d.t1 ?? Infinity) > override.cutT) continue; // not yet drawn at that moment
    if ((d.type === 'step' || d.type === 'xstep') && d.tf != null && bars && d.tf !== bars.tf) continue;
    if (isPosition(d)) { tags.push([d.id + 't', d.target, COLORS.target], [d.id + 'e', d.entry, COLORS.entry], [d.id + 's', d.stop, COLORS.stop]); }
    else if (d.type === 'hline') tags.push([d.id, d.price, '#b08a1e']);
    else if (d.type === 'exit' && !override?.hideExit) tags.push([d.id, d.p, '#a855f7']);
  }

  return (
    <div className="flex flex-col min-h-0 min-w-0 border border-terminal-border rounded bg-terminal-bg" style={{ gridArea: area }}
      onPointerEnter={() => { activeRef.current = true; onActive(); }}
      onPointerLeave={() => { activeRef.current = false; live.current.onHover(null); }}>
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-terminal-border flex-shrink-0">
        <span className="text-xs font-mono text-terminal-muted">{title}</span>
        <select value={tf} onChange={(e) => onTfChange(Number(e.target.value))}
          className="bg-terminal-surface border border-terminal-border rounded px-2 py-0.5 text-xs font-mono text-terminal-text">
          {timeframes.map((m) => <option key={m} value={m}>{TF_LABEL[m] || `${m} min`}</option>)}
        </select>
        <span className="flex items-center gap-1.5 text-[11px] font-mono text-terminal-muted"><span className="inline-block w-3 h-0.5" style={{ background: COLORS.ema50 }} />15-min 50 EMA</span>
        <span className="flex items-center gap-1.5 text-[11px] font-mono text-terminal-muted"><span className="inline-block w-3 h-0.5" style={{ background: COLORS.ema200 }} />1-hour 200 EMA</span>
        <span className="ml-auto text-[11px] font-mono text-terminal-muted">{symbolName || 'Gold'} · Vancouver time</span>
      </div>
      {/* clicking empty chart space lets go of the selected mark (marks stop the click before it gets here) */}
      <div className="relative flex-1 min-h-0 overflow-hidden" onPointerDown={() => { if (tool === 'cursor' && selectedId) onSelect(null); }}>
        {stdActive && fitsNote && <div className="absolute top-1 left-1/2 -translate-x-1/2 z-10 text-[10px] font-mono text-terminal-red bg-terminal-bg/85 rounded px-2 py-0.5 pointer-events-none max-w-[90%] text-center">{fitsNote}</div>}
        <div className="absolute inset-0">
        <div ref={boxRef} className="absolute inset-0" />
        <svg ref={svgRef} xmlns="http://www.w3.org/2000/svg" width={view ? view.w : 0} height={view ? view.h : 0}
          className="absolute inset-0" style={{ pointerEvents: 'none', zIndex: 5 }}
          onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {ready && (
            <>
              <defs><clipPath id={clipId}><rect x={0} y={0} width={view.paneW} height={view.paneH} /></clipPath></defs>
              <g clipPath={`url(#${clipId})`}>
                {sessions.map((s) => {
                  const x1 = X(s.t1) - view.sp / 2, x2 = X(s.t2) - view.sp / 2, y1 = Y(s.hi), y2 = Y(s.lo);
                  if (x2 - x1 < 5) return null;
                  return (
                    <g key={s.key} pointerEvents="none">
                      <rect x={x1} y={y1} width={x2 - x1} height={Math.max(1, y2 - y1)} fill={s.color} fillOpacity={0.09} stroke={s.color} strokeOpacity={0.55} strokeWidth={1} />
                      {x2 - x1 > 60 && <text x={x1 + 4} y={y1 - 4} fontSize={10} fontFamily={FONT} fill={s.color}>{s.name}</text>}
                    </g>
                  );
                })}
                {hoverT != null && !activeRef.current && <line x1={X(hoverT)} x2={X(hoverT)} y1={0} y2={view.paneH} stroke={colors.text} strokeOpacity={0.45} strokeDasharray="3 3" pointerEvents="none" />}
                {hoverP != null && !activeRef.current && <line x1={0} x2={view.paneW} y1={Y(hoverP)} y2={Y(hoverP)} stroke={colors.text} strokeOpacity={0.45} strokeDasharray="3 3" pointerEvents="none" />}
                {stdActive && stdLines.map((p) => (
                  <g key={p} pointerEvents="none">
                    <line x1={0} x2={view.paneW} y1={Y(p)} y2={Y(p)} stroke={colors.text} strokeOpacity={0.3} strokeDasharray="1 3" />
                    <text x={6} y={Y(p) - 3} fontSize={10} fontFamily={FONT} fill={colors.text} fillOpacity={0.7}>{fmtP(p)}</text>
                  </g>
                ))}
                {tool !== 'cursor' && <rect x={0} y={0} width={view.paneW} height={view.paneH} fill="transparent" style={{ pointerEvents: 'auto', cursor: 'crosshair' }} onPointerDown={onPlaceDown} />}
                {drawings.map(renderDrawing)}
                {guide != null && !override && <line x1={0} x2={view.paneW} y1={Y(guide)} y2={Y(guide)} stroke={colors.labelText} strokeOpacity={0.8} strokeWidth={1} strokeDasharray="2 4" pointerEvents="none" />}
              </g>
              {mark && <image href={mark} x={10} y={view.paneH - 38} width={20} height={30} opacity={0.9} pointerEvents="none" />}
              {hoverP != null && !activeRef.current && <Tag y={Y(hoverP)} text={fmtP(hoverP)} bg="#52525b" />}
              {tags.map(([k, price, bg]) => <Tag key={k} y={Y(price)} text={fmtP(price)} bg={bg} />)}
              {guide != null && !override && <Tag y={Y(guide)} text={fmtP(guide)} bg="#3b82f6" />}
            </>
          )}
        </svg>
        </div>
        {!ready && <div className="absolute inset-0 flex items-center justify-center text-xs font-mono text-terminal-muted">{bars ? 'No prices loaded yet.' : 'Loading prices…'}</div>}
      </div>
    </div>
  );
});

export default ChartPane;
