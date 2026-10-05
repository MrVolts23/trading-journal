// entryGate contract tests + schema/DEFAULTS consistency (the latter needs no data).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const E = require(path.join(__dirname, '..', 'engine', 'engine.js'));
const CSV = path.join(__dirname, '..', 'data', 'XAUUSD_M1.csv');
const HAVE_DATA = fs.existsSync(CSV);
const SKIP = HAVE_DATA ? false : `desk/data/XAUUSD_M1.csv absent — run: node desk/scripts/import_gma.js (copies the goldbridge/out history once)`;

const CHAMPION = { pivotStrengthLtf: 1, armMode: 'either', maxEntriesPerArm: 3, exitModel: 'liquidity_v1', trailPadUsd: 0.30 };

let m1 = null;
const bars = () => (m1 ||= E.loadM1(CSV));

// ── No-data tests ──────────────────────────────────────────────────────────────
test('exports: unchanged names plus DEFAULTS and PARAM_SCHEMA', () => {
  for (const name of ['loadM1', 'aggregate', 'findPivots', 'bosEvents', 'runDoubleBOS', 'metrics', 'ptHour'])
    assert.equal(typeof E[name], 'function', name);
  assert.equal(typeof E.DEFAULTS, 'object');
  assert.equal(typeof E.PARAM_SCHEMA, 'object');
  assert.ok(Object.isFrozen(E.DEFAULTS));
});

test('schema.json: every entry has the required shape and its default equals DEFAULTS', () => {
  const schema = E.PARAM_SCHEMA;
  const keys = Object.keys(schema);
  assert.ok(keys.length >= 30, 'schema covers the engine params');
  for (const [k, spec] of Object.entries(schema)) {
    for (const f of ['type', 'unit', 'default', 'min', 'max', 'description'])
      assert.ok(f in spec, `${k}.${f} present`);
    assert.ok(['integer', 'number', 'boolean', 'string', 'json'].includes(spec.type), `${k}.type`);
    assert.ok(k in E.DEFAULTS, `${k} is a real engine default`);
    assert.deepEqual(spec.default, E.DEFAULTS[k], `${k} default matches DEFAULTS`);
    if (spec.choices) assert.ok(spec.choices.includes(spec.default), `${k} default in choices`);
    if (spec.type === 'integer' || spec.type === 'number') {
      if (spec.default != null) {
        assert.ok(spec.default >= spec.min && spec.default <= spec.max, `${k} default within [min,max]`);
      }
    }
  }
  // and every DEFAULTS key is documented
  for (const k of Object.keys(E.DEFAULTS)) assert.ok(k in schema, `DEFAULTS.${k} documented in schema.json`);
  // contract-required params present, exitModel choices fixed
  for (const k of ['htf', 'ltf', 'pivotStrengthHtf', 'pivotStrengthLtf', 'rr', 'exitModel', 'trailPadUsd', 'requireSweep', 'armMode',
    'maxEntriesPerArm', 'maxConcurrent', 'addGateR', 'beAtR', 'slPaddingUsd', 'maxSlUsd', 'spreadUsd', 'slippageUsd', 'armExpiryHtfBars',
    'liquidityLookbackDays', 'tpBufferUsd', 'minProfitRForOppExit', 'useOppBos', 'useTerminalTp', 'trailActivateR', 'useEmaExit', 'emaPeriod', 'windows'])
    assert.ok(k in schema, `contract param ${k}`);
  assert.deepEqual(schema.exitModel.choices, ['fixed_rr', 'trail_ltf', 'liquidity_v1', 'liquidity_v2', 'opposite_bos', 'combo']);
  assert.deepEqual(schema.armMode.choices, ['either', 'sweep', 'retrace']);
});

test('PT keys: ptDate/weekKey/monthKey use PT = server − 10h and ISO weeks', () => {
  // 2026-03-30 05:00 server → 2026-03-29 19:00 PT (Sunday) → ISO week 13 of 2026
  const t = Date.UTC(2026, 2, 30, 5, 0) / 1000;
  assert.equal(E.ptDate(t), '2026-03-29');
  assert.equal(E.weekKey(t), '2026-W13');
  assert.equal(E.monthKey(t), '2026-03');
  // 2026-03-30 10:00 server → 2026-03-30 00:00 PT (Monday) → ISO week 14
  const t2 = Date.UTC(2026, 2, 30, 10, 0) / 1000;
  assert.equal(E.ptDate(t2), '2026-03-30');
  assert.equal(E.weekKey(t2), '2026-W14');
  // ISO year-boundary sanity: 2027-01-01 12:00 PT is a Friday → belongs to 2026-W53
  const t3 = Date.UTC(2027, 0, 1, 22, 0) / 1000;
  assert.equal(E.ptDate(t3), '2027-01-01');
  assert.equal(E.weekKey(t3), '2026-W53');
  assert.equal(E.monthKey(t3), '2027-01');
});

// ── Data tests ─────────────────────────────────────────────────────────────────
test('gate: an always-true gate is called exactly once per taken trade with a matching ctx', { skip: SKIP }, () => {
  const base = E.runDoubleBOS(bars(), CHAMPION);
  const calls = [];
  const gated = E.runDoubleBOS(bars(), {
    ...CHAMPION,
    entryGate: (ctx) => {
      calls.push({ ...ctx, tradesSoFar: ctx.tradesSoFar.length });
      return true;
    },
  });
  assert.equal(gated.trades.length, base.trades.length);
  assert.deepEqual(gated.trades, base.trades, 'a permissive gate changes nothing');
  assert.equal(calls.length, base.trades.length, 'one gate call per opened position');

  const byEntry = new Map(base.trades.map((t) => [t.entryT, t]));
  for (const c of calls) {
    for (const f of ['t', 'dir', 'session', 'armType', 'entry', 'sl', 'risk', 'tradesSoFar', 'openCount'])
      assert.ok(f in c, `ctx.${f}`);
    assert.ok(['bull', 'bear'].includes(c.dir));
    assert.ok(['asia', 'ny'].includes(c.session));
    assert.ok(['sweep', 'retrace'].includes(c.armType));
    assert.equal(c.openCount, 0, 'maxConcurrent 1 → gate only sees 0 open positions');
    const tr = byEntry.get(c.t);
    assert.ok(tr, 'ctx.t is the entry time of a recorded trade');
    assert.equal(tr.dir, c.dir);
    assert.equal(tr.session, c.session);
    assert.equal(tr.armType, c.armType);
    assert.ok(Math.abs(tr.entry - c.entry) < 0.006, 'entry price');
    assert.ok(Math.abs(tr.initial_sl - c.sl) < 0.006, 'initial stop (trade.sl is the final trailed stop)');
    assert.ok(Math.abs(tr.risk - c.risk) < 0.006, 'risk distance');
  }
  // tradesSoFar grows monotonically (closed trades in close order)
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].tradesSoFar >= calls[i - 1].tradesSoFar);
});

test('gate: refusing every ny entry leaves only asia trades — same asia count as the ungated run', { skip: SKIP }, () => {
  const base = E.runDoubleBOS(bars(), CHAMPION);
  const baseM = E.metrics(base.trades);
  const gated = E.runDoubleBOS(bars(), { ...CHAMPION, entryGate: (ctx) => ctx.session !== 'ny' });
  const gatedM = E.metrics(gated.trades);
  assert.ok(gated.trades.length > 0);
  assert.ok(gated.trades.every((t) => t.session === 'asia'), 'no ny trades survive the gate');
  assert.equal(gatedM.by_session.ny, undefined);
  assert.equal(gatedM.by_session.asia.n, baseM.by_session.asia.n, 'asia count unchanged');
  assert.equal(gated.trades.length, baseM.by_session.asia.n);
});

test('gate: a gated skip does NOT consume the arm (entriesLeft untouched)', { skip: SKIP }, () => {
  // With maxEntriesPerArm 1, an always-false gate must keep offering entries off the SAME
  // arm on later LTF triggers. If a skip decremented entriesLeft, each arm could be offered
  // at most once.
  const calls = [];
  const res = E.runDoubleBOS(bars(), {
    ...CHAMPION,
    maxEntriesPerArm: 1,
    entryGate: (ctx) => { calls.push(ctx.armFromT); return false; },
  });
  assert.equal(res.trades.length, 0, 'nothing opens');
  assert.ok(calls.length > 0);
  const perArm = new Map();
  for (const a of calls) perArm.set(a, (perArm.get(a) || 0) + 1);
  const reoffered = [...perArm.values()].filter((n) => n > 1).length;
  assert.ok(reoffered > 0, `at least one arm offered more than once (got ${reoffered} of ${perArm.size})`);
});

test('gate: a stateful gate sees closed trades (tradesSoFar) and can stop a PT day after −2R', { skip: SKIP }, () => {
  // Mirrors what rails.makeEntryGate will do: stop entries for the PT day once the closed
  // R on that PT date is <= −2.
  const CAP = 2.0;
  const gate = (ctx) => {
    const day = E.ptDate(ctx.t);
    let r = 0;
    for (const t of ctx.tradesSoFar) if (t.pt_date === day) r += t.r;
    return r > -CAP;
  };
  const base = E.runDoubleBOS(bars(), CHAMPION);
  const gated = E.runDoubleBOS(bars(), { ...CHAMPION, entryGate: gate });
  assert.ok(gated.trades.length < base.trades.length, 'the cap removed some entries');
  // Invariant: no trade is ENTERED on a PT day whose prior closed R already breached the cap
  const byDay = new Map();
  for (const t of gated.trades) {
    const day = t.entry_pt_date;
    const before = byDay.get(day) || 0;
    assert.ok(before > -CAP, `${day}: entry after day R ${before.toFixed(2)}`);
    // realized on the exit date (same PT day for windowed trades)
    byDay.set(t.pt_date, (byDay.get(t.pt_date) || 0) + t.r);
  }
});

test('gate: null/undefined gate = original behaviour', { skip: SKIP }, () => {
  const a = E.runDoubleBOS(bars(), CHAMPION);
  const b = E.runDoubleBOS(bars(), { ...CHAMPION, entryGate: null });
  const c = E.runDoubleBOS(bars(), { ...CHAMPION, entryGate: undefined });
  assert.deepEqual(a.trades, b.trades);
  assert.deepEqual(a.trades, c.trades);
});
