// Gold Metal Alchemist — local backtest engine v1 (MT5 data only, SCOPE decision #11).
// Implements swing pivots, break-of-structure (BOS) detection, session windows, and a
// cost-aware trade simulator. First strategy family: Mike's Double BOS.
//
// Every structural definition here is a PARAMETER — Mike calibrates them as we go.

const fs = require('fs');

// ── Data ───────────────────────────────────────────────────────────────────────
function loadM1(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const [ts, o, h, l, c] = lines[i].trim().split(',');
    if (!ts || !o) continue;
    const m = ts.match(/^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/);
    if (!m) continue;
    bars.push({ t: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000, o: +o, h: +h, l: +l, c: +c });
  }
  return bars;
}

function aggregate(m1, minutes) {
  if (minutes === 1) return m1;
  const out = [];
  let bucket = null, key = null;
  for (const b of m1) {
    const k = Math.floor(b.t / (minutes * 60));
    if (k !== key) {
      if (bucket) out.push(bucket);
      bucket = { t: k * minutes * 60, o: b.o, h: b.h, l: b.l, c: b.c };
      key = k;
    } else {
      bucket.h = Math.max(bucket.h, b.h);
      bucket.l = Math.min(bucket.l, b.l);
      bucket.c = b.c;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

// Server wall-clock (UTC+3-style) → PT hour-of-day (float). PT = server − 10h year-round.
function ptHour(t) {
  const d = new Date((t - 10 * 3600) * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}
function inWindow(t, win) {
  const h = ptHour(t);
  return win.start <= win.end ? h >= win.start && h < win.end : h >= win.start || h < win.end;
}

// ── Structure: swing pivots + BOS events ──────────────────────────────────────
// Pivot high at i: high[i] strictly greater than the `strength` bars on each side.
// Confirmed only `strength` bars later (no lookahead — the confirm index is recorded).
function findPivots(bars, strength) {
  const pivots = [];
  for (let i = strength; i < bars.length - strength; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (bars[i].h <= bars[i - k].h || bars[i].h < bars[i + k].h) isHigh = false;
      if (bars[i].l >= bars[i - k].l || bars[i].l > bars[i + k].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) pivots.push({ type: 'H', i, price: bars[i].h, confirmedAt: i + strength });
    if (isLow) pivots.push({ type: 'L', i, price: bars[i].l, confirmedAt: i + strength });
  }
  return pivots;
}

// BOS stream: walking the bars, a bullish BOS fires when close breaks above the most recent
// CONFIRMED swing high; bearish when close breaks below the most recent confirmed swing low.
// Each swing can only be broken once.
function bosEvents(bars, strength) {
  const pivots = findPivots(bars, strength);
  const events = [];
  let lastHigh = null, lastLow = null; // most recent confirmed, unbroken
  let pi = 0;
  const sorted = pivots.slice().sort((a, b) => a.confirmedAt - b.confirmedAt);
  for (let i = 0; i < bars.length; i++) {
    while (pi < sorted.length && sorted[pi].confirmedAt <= i) {
      if (sorted[pi].type === 'H') lastHigh = sorted[pi];
      else lastLow = sorted[pi];
      pi++;
    }
    if (lastHigh && bars[i].c > lastHigh.price) {
      events.push({ dir: 'bull', i, t: bars[i].t, brokeLevel: lastHigh.price });
      lastHigh = null;
    }
    if (lastLow && bars[i].c < lastLow.price) {
      events.push({ dir: 'bear', i, t: bars[i].t, brokeLevel: lastLow.price });
      lastLow = null;
    }
  }
  return { events, pivots };
}

// ── Double BOS strategy ────────────────────────────────────────────────────────
// Arm: two consecutive same-direction BOS on the HTF (15m default) with no opposite BOS
// between, inside a session window. Trigger: next LTF (3m) BOS in that direction.
// Entry at LTF bar close. SL behind the most recent opposite LTF pivot. TP at rr × risk.
// Flat at window end. One position at a time.
function runDoubleBOS(m1, params) {
  const P = {
    htf: 15, ltf: 3,
    pivotStrengthHtf: 2, pivotStrengthLtf: 2,
    rr: 2.0,
    exitModel: 'fixed_rr',    // fixed_rr | trail_ltf (structure-trail behind LTF swings)
    trailPadUsd: 0.30,
    requireSweep: false,      // v2: between the two HTF BOS, price must run the prior swing low/high (liquidity grab)
    maxEntriesPerArm: 1,      // v2: Mike took 3 entries off one arm on Jul 2
    slPaddingUsd: 0.30,       // pad beyond the swing
    maxSlUsd: 12,             // skip absurdly wide setups
    spreadUsd: 0.25, slippageUsd: 0.05,
    armExpiryHtfBars: 8,      // arm goes stale after N HTF bars without a trigger
    windows: [{ name: 'asia', start: 15, end: 23 }, { name: 'ny', start: 4, end: 13.5 }],
    ...params,
  };

  const htfBars = aggregate(m1, P.htf);
  const ltfBars = aggregate(m1, P.ltf);
  const { events: htfBos, pivots: htfPivots } = bosEvents(htfBars, P.pivotStrengthHtf);
  const { events: ltfBosAll, pivots: ltfPivots } = bosEvents(ltfBars, P.pivotStrengthLtf);

  // For the sweep check: most recent confirmed opposite pivot LEVEL at any HTF bar index
  const htfSortedPivots = htfPivots.slice().sort((a, b) => a.confirmedAt - b.confirmedAt);
  function lastOppositeLevelAt(barIdx, dir) {
    let level = null;
    for (const p of htfSortedPivots) {
      if (p.confirmedAt > barIdx) break;
      if (dir === 'bull' && p.type === 'L') level = p.price;
      if (dir === 'bear' && p.type === 'H') level = p.price;
    }
    return level;
  }

  // Build arm intervals from HTF double-BOS. Between the two breaks there is always a
  // pullback (a new pivot must confirm); we CLASSIFY it: 'sweep' if the pullback ran the
  // prior swing's liquidity, else 'retrace'. armMode selects which variants arm:
  //   'either' (Mike: both are valid) | 'sweep' | 'retrace'
  const arms = [];
  let prev = null;
  for (const e of htfBos) {
    if (prev && prev.dir === e.dir) {
      let armType = 'retrace';
      const level = lastOppositeLevelAt(prev.i, e.dir);
      if (level != null) {
        for (let k = prev.i; k <= e.i; k++) {
          if (e.dir === 'bull' && htfBars[k].l < level) { armType = 'sweep'; break; }
          if (e.dir === 'bear' && htfBars[k].h > level) { armType = 'sweep'; break; }
        }
      }
      const mode = P.armMode || (P.requireSweep ? 'sweep' : 'either');
      if (mode === 'either' || mode === armType) {
        arms.push({
          dir: e.dir, armType, entriesLeft: P.maxEntriesPerArm,
          fromT: e.t + P.htf * 60, toT: e.t + P.htf * 60 * (1 + P.armExpiryHtfBars),
        });
      }
    }
    prev = e;
  }

  // LTF pivot lookup for stop placement
  const confirmedPivots = ltfPivots.slice().sort((a, b) => a.confirmedAt - b.confirmedAt);

  const trades = [];
  const positions = []; // multi-position: pyramiding adds while a move runs (maxConcurrent)
  let armIdx = 0;
  const activeArms = [];

  const ltfIndexByT = new Map(ltfBars.map((b, i) => [b.t, i]));

  // Mike: the 15m 50-EMA is often a stopping point — exit winners approaching/touching it.
  // Precompute HTF EMA and an index from any timestamp to the latest CLOSED htf bar's EMA
  // (no lookahead: use the EMA of the previous completed 15m bar).
  let htfEma = null, htfIdxByKey = null;
  if (P.useEmaExit) {
    const period = P.emaPeriod || 50;
    const k = 2 / (period + 1);
    htfEma = new Array(htfBars.length);
    let e = htfBars[0].c;
    for (let j = 0; j < htfBars.length; j++) { e = j ? htfBars[j].c * k + e * (1 - k) : e; htfEma[j] = e; }
    htfIdxByKey = new Map(htfBars.map((b, j) => [Math.floor(b.t / (P.htf * 60)), j]));
  }
  function emaAt(t) {
    if (!htfEma) return null;
    const j = htfIdxByKey.get(Math.floor(t / (P.htf * 60)));
    return j != null && j > 0 ? htfEma[j - 1] : null; // previous CLOSED htf bar
  }

  // Trailing-structure state: most recent confirmed LTF pivot on the protecting side
  let cpIdx = 0;
  let lastLowPivot = null, lastHighPivot = null;
  // separate trackers for the (possibly looser) trail source
  let tpiIdx = 0, trailLow = null, trailHigh = null;
  // Exit-BOS stream may use a STRICTER pivot definition than entries (lab: which opposite
  // break "counts" — Mike's eye ignores noise breaks; strength + in-profit filters test that)
  const exitBosSource = P.exitBosStrength && P.exitBosStrength !== P.pivotStrengthLtf
    ? bosEvents(ltfBars, P.exitBosStrength).events
    : ltfBosAll;
  const bosByIdx = new Map(exitBosSource.map((e) => [e.i, e]));

  // Trail source (Mike: trail winners, but not so tight noise stops you out — lab-tunable):
  //   trailMode 'pivot' (ltf swings at trailPivotStrength) | 'htf_pivot' | 'chandelier'
  const trailMode = P.trailMode || 'pivot';
  let trailPivotsSorted = null;
  if (trailMode === 'pivot') {
    const s = P.trailPivotStrength || P.pivotStrengthLtf;
    const src = s === P.pivotStrengthLtf ? ltfPivots : findPivots(ltfBars, s);
    trailPivotsSorted = src.slice().sort((a, b) => a.confirmedAt - b.confirmedAt);
  } else if (trailMode === 'htf_pivot') {
    // map htf pivot confirm times onto ltf bar indices
    trailPivotsSorted = htfPivots
      .map((p) => ({ ...p, confT: htfBars[Math.min(p.confirmedAt, htfBars.length - 1)].t }))
      .sort((a, b) => a.confT - b.confT);
  }
  // ATR(14) on LTF for chandelier trails
  let atr = null;
  if (trailMode === 'chandelier') {
    atr = new Array(ltfBars.length).fill(null);
    let trSum = 0; const trArr = [];
    for (let i = 0; i < ltfBars.length; i++) {
      const b = ltfBars[i], pc = i ? ltfBars[i - 1].c : b.o;
      const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
      trArr.push(tr); trSum += tr;
      if (trArr.length > 14) trSum -= trArr.shift();
      atr[i] = trSum / trArr.length;
    }
  }

  for (let i = 0; i < ltfBars.length; i++) {
    const bar = ltfBars[i];

    // advance confirmed-pivot trackers (no lookahead: only pivots confirmed by bar i)
    while (cpIdx < confirmedPivots.length && confirmedPivots[cpIdx].confirmedAt <= i) {
      const p = confirmedPivots[cpIdx++];
      if (p.type === 'L') lastLowPivot = p;
      else lastHighPivot = p;
    }

    // advance trail-source trackers
    if (trailPivotsSorted) {
      while (tpiIdx < trailPivotsSorted.length) {
        const p = trailPivotsSorted[tpiIdx];
        const due = trailMode === 'htf_pivot' ? p.confT <= bar.t : p.confirmedAt <= i;
        if (!due) break;
        if (p.type === 'L') trailLow = p; else trailHigh = p;
        tpiIdx++;
      }
    }

    // manage open positions on this bar (conservative: SL checked before TP)
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const open = positions[pi];
      if (open.dir === 'bull' && bar.h > open.hh) open.hh = bar.h;
      if (open.dir === 'bear' && bar.l < open.ll) open.ll = bar.l;
      const unrealR = (open.dir === 'bull' ? bar.c - open.entry : open.entry - bar.c) / open.risk;

      // Breakeven ratchet [mike]: once the trade exceeds beAtR, stop jumps to entry —
      // "zero out" so a paid trade can never become a full -1R loser. Composes with trails
      // (all ratchets only ever tighten).
      if (P.beAtR != null && unrealR >= P.beAtR) {
        if (open.dir === 'bull' && open.sl < open.entry) open.sl = open.entry;
        if (open.dir === 'bear' && open.sl > open.entry) open.sl = open.entry;
      }

      // trail ratchet — for classic models and for 'combo' (Mike: trail winners, tunably loose)
      const trailOn =
        P.exitModel === 'trail_ltf' || P.exitModel === 'liquidity_v1' ||
        (P.exitModel === 'combo' && unrealR >= (P.trailActivateR ?? 0));
      if (trailOn) {
        let candLow = null, candHigh = null;
        if (trailMode === 'chandelier') {
          candLow = open.hh - (P.atrMult ?? 3) * atr[i];
          candHigh = open.ll + (P.atrMult ?? 3) * atr[i];
        } else {
          const lowSrc = trailPivotsSorted ? trailLow : lastLowPivot;
          const highSrc = trailPivotsSorted ? trailHigh : lastHighPivot;
          if (lowSrc) candLow = lowSrc.price - P.trailPadUsd;
          if (highSrc) candHigh = highSrc.price + P.trailPadUsd;
        }
        if (open.dir === 'bull' && candLow != null && candLow > open.sl) open.sl = candLow;
        if (open.dir === 'bear' && candHigh != null && candHigh < open.sl) open.sl = candHigh;
      }
      // Liquidity pt.2 (Mike): an opposite-direction LTF BOS is the exit bell.
      // 'opposite_bos'  → literal: any opposite 3m BOS closes the trade [mike-confirmed]
      // 'liquidity_v2'  → pt.1+pt.2 combined: only AFTER a liquidity pool has been tapped
      //                   does the opposite BOS trigger the exit [claude-assumed synthesis]
      let oppBosExit = false;
      if (P.exitModel === 'opposite_bos' || P.exitModel === 'liquidity_v2' ||
          (P.exitModel === 'combo' && P.useOppBos)) {
        if (open.pools && open.pools.length) {
          const buf = P.tpBufferUsd ?? 0.5;
          if (open.dir === 'bull' && bar.h >= Math.min(...open.pools) - buf) open.tapped = true;
          if (open.dir === 'bear' && bar.l <= Math.max(...open.pools) + buf) open.tapped = true;
        }
        const e2 = bosByIdx.get(i);
        if (e2 && e2.dir !== open.dir) {
          const profitOk = unrealR >= (P.minProfitRForOppExit ?? 0);
          oppBosExit = profitOk &&
            (P.exitModel === 'opposite_bos' || P.exitModel === 'combo' || open.tapped === true);
        }
      }

      // 15m 50-EMA wall exit [mike]: EMA overhead in the trade's path + winner approaching it
      let emaExit = null;
      if (P.useEmaExit) {
        const ema = emaAt(bar.t);
        const prox = P.emaProxUsd ?? 0.5;
        const emaAllowed = !P.emaOnlyWhenNoTerminal || open.tp == null;
        if (ema != null && emaAllowed && unrealR >= (P.emaMinProfitR ?? 0)) {
          if (open.dir === 'bull' && ema > open.entry && bar.h >= ema - prox)
            emaExit = Math.max(bar.o, ema - prox);
          if (open.dir === 'bear' && ema < open.entry && bar.l <= ema + prox)
            emaExit = Math.min(bar.o, ema + prox);
        }
      }

      const hitSL = open.dir === 'bull' ? bar.l <= open.sl : bar.h >= open.sl;
      const hitTP = open.tp != null && (open.dir === 'bull' ? bar.h >= open.tp : bar.l <= open.tp);
      const windowOver = !inWindow(bar.t, open.window);
      if (emaExit != null && !hitSL) {
        trades.push(close(open, emaExit, bar.t, 'ema50_15m', P));
        positions.splice(pi, 1);
      } else if (hitSL) {
        trades.push(close(open, open.sl, bar.t, open.sl === open.initialSl ? 'sl' : 'trail_stop', P));
        positions.splice(pi, 1);
      } else if (oppBosExit) {
        trades.push(close(open, bar.c, bar.t, 'opp_bos', P));
        positions.splice(pi, 1);
      } else if (hitTP) {
        trades.push(close(open, open.tp, bar.t, 'tp', P));
        positions.splice(pi, 1);
      } else if (windowOver) {
        trades.push(close(open, bar.c, bar.t, 'window_close', P));
        positions.splice(pi, 1);
      }
    }

    // activate arms whose window has arrived
    while (armIdx < arms.length && arms[armIdx].fromT <= bar.t) activeArms.push(arms[armIdx++]);
    for (let a = activeArms.length - 1; a >= 0; a--) if (activeArms[a].toT < bar.t) activeArms.splice(a, 1);

    // room for another position? (maxConcurrent=1 → classic single-position behavior;
    // >1 → pyramiding: add on further same-direction 3m BOS while the move runs)
    if (positions.length >= (P.maxConcurrent || 1)) continue;

    // trigger: LTF BOS matching an active arm, inside a session window
    const ev = ltfBosAll.find((e) => e.i === i);
    if (!ev) continue;
    if (positions.length && positions[0].dir !== ev.dir) continue; // never hedge
    // pyramiding gate: only add when every open position is already ≥ addGateR in profit
    if (positions.length && P.addGateR != null) {
      const allOk = positions.every((p) =>
        ((p.dir === 'bull' ? bar.c - p.entry : p.entry - bar.c) / p.risk) >= P.addGateR);
      if (!allOk) continue;
    }
    const win = P.windows.find((w) => inWindow(bar.t, w));
    if (!win) continue;
    const arm = activeArms.find((a) => a.dir === ev.dir);
    if (!arm) continue;

    // stop: most recent confirmed opposite pivot before this bar
    let stopPivot = null;
    for (const p of confirmedPivots) {
      if (p.confirmedAt > i) break;
      if (ev.dir === 'bull' && p.type === 'L') stopPivot = p;
      if (ev.dir === 'bear' && p.type === 'H') stopPivot = p;
    }
    if (!stopPivot) continue;

    const entry = bar.c + (ev.dir === 'bull' ? P.spreadUsd + P.slippageUsd : -P.slippageUsd);
    const sl = ev.dir === 'bull' ? stopPivot.price - P.slPaddingUsd : stopPivot.price + P.slPaddingUsd;
    const risk = Math.abs(entry - sl);
    if (risk < 0.5 || risk > P.maxSlUsd) continue;
    let tp;
    let pools = null;
    if (P.exitModel === 'combo') {
      // terminal target (pt.1) optional in combos
      tp = null;
      if (P.useTerminalTp !== false) {
        const lookback = (P.liquidityLookbackDays || 5) * 86400;
        let terminal = null;
        for (const p of htfSortedPivots) {
          const pt = htfBars[p.i].t, ct = htfBars[Math.min(p.confirmedAt, htfBars.length - 1)].t;
          if (ct > bar.t || pt < bar.t - lookback) continue;
          if (ev.dir === 'bull' && p.type === 'H' && p.price > entry + 1) terminal = Math.max(terminal ?? -Infinity, p.price);
          if (ev.dir === 'bear' && p.type === 'L' && p.price < entry - 1) terminal = Math.min(terminal ?? Infinity, p.price);
        }
        tp = terminal == null ? null
          : ev.dir === 'bull' ? terminal - (P.tpBufferUsd ?? 0.5) : terminal + (P.tpBufferUsd ?? 0.5);
      }
    } else if (P.exitModel === 'opposite_bos' || P.exitModel === 'liquidity_v2') {
      tp = null;
      // pt.1 pools: ALL prior-traverse HTF pivot levels beyond entry within lookback
      const lookback = (P.liquidityLookbackDays || 5) * 86400;
      pools = [];
      for (const p of htfSortedPivots) {
        const pt = htfBars[p.i].t, ct = htfBars[Math.min(p.confirmedAt, htfBars.length - 1)].t;
        if (ct > bar.t || pt < bar.t - lookback) continue;
        if (ev.dir === 'bull' && p.type === 'H' && p.price > entry + 1) pools.push(p.price);
        if (ev.dir === 'bear' && p.type === 'L' && p.price < entry - 1) pools.push(p.price);
      }
    } else if (P.exitModel === 'trail_ltf') tp = null;
    else if (P.exitModel === 'liquidity_v1') {
      // Mike's liquidity teaching pt.1 (proxy until pt.2): target the TERMINAL liquidity of
      // the prior traverse — the furthest confirmed HTF pivot beyond entry within lookback
      // ("where it stopped and reversed last time") — front-run by tpBufferUsd.
      const lookback = (P.liquidityLookbackDays || 5) * 86400;
      let terminal = null;
      for (const p of htfSortedPivots) {
        const pt = htfBars[p.i].t, ct = htfBars[Math.min(p.confirmedAt, htfBars.length - 1)].t;
        if (ct > bar.t || pt < bar.t - lookback) continue;
        if (ev.dir === 'bull' && p.type === 'H' && p.price > entry + 1) terminal = Math.max(terminal ?? -Infinity, p.price);
        if (ev.dir === 'bear' && p.type === 'L' && p.price < entry - 1) terminal = Math.min(terminal ?? Infinity, p.price);
      }
      tp = terminal == null ? null
        : ev.dir === 'bull' ? terminal - (P.tpBufferUsd ?? 0.5) : terminal + (P.tpBufferUsd ?? 0.5);
    } else tp = ev.dir === 'bull' ? entry + P.rr * risk : entry - P.rr * risk;

    positions.push({ dir: ev.dir, armType: arm.armType, entry, sl, initialSl: sl, tp, pools, tapped: false, risk, entryT: bar.t, window: win, session: win.name, hh: bar.h, ll: bar.l });
    // arm allows up to maxEntriesPerArm sequential attempts (Mike took 3 on Jul 2)
    arm.entriesLeft--;
    if (arm.entriesLeft <= 0) activeArms.splice(activeArms.indexOf(arm), 1);
  }
  for (const open of positions) trades.push(close(open, ltfBars[ltfBars.length - 1].c, ltfBars[ltfBars.length - 1].t, 'data_end', P));

  return { trades, params: P };
}

function close(pos, price, t, reason, P) {
  const exit = pos.dir === 'bull' ? price - P.slippageUsd : price + P.spreadUsd + P.slippageUsd;
  const move = pos.dir === 'bull' ? exit - pos.entry : pos.entry - exit;
  return {
    dir: pos.dir, session: pos.session, armType: pos.armType,
    entryT: pos.entryT, exitT: t,
    entry: +pos.entry.toFixed(2), exit: +exit.toFixed(2),
    sl: +pos.sl.toFixed(2), tp: pos.tp == null ? null : +pos.tp.toFixed(2),
    r: +(move / pos.risk).toFixed(3),
    reason,
  };
}

// ── Metrics ────────────────────────────────────────────────────────────────────
function metrics(trades) {
  if (!trades.length) return { trades: 0 };
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const netR = rs.reduce((a, b) => a + b, 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let peak = 0, dd = 0, cum = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const bySession = {};
  for (const t of trades) {
    (bySession[t.session] ||= { n: 0, netR: 0 });
    bySession[t.session].n++;
    bySession[t.session].netR = +(bySession[t.session].netR + t.r).toFixed(2);
  }
  return {
    trades: trades.length,
    winrate: +(wins.length / trades.length).toFixed(3),
    net_r: +netR.toFixed(2),
    expectancy_r: +(netR / trades.length).toFixed(3),
    profit_factor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
    max_dd_r: +dd.toFixed(2),
    by_session: bySession,
    by_reason: trades.reduce((m, t) => ((m[t.reason] = (m[t.reason] || 0) + 1), m), {}),
  };
}

module.exports = { loadM1, aggregate, findPivots, bosEvents, runDoubleBOS, metrics, ptHour };
