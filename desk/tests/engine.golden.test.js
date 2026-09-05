// Golden test: the desk engine must reproduce the July champion's numbers exactly on the
// seeded (burned) research CSV. Skips with a clear message when the CSV is absent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const E = require(path.join(__dirname, '..', 'engine', 'engine.js'));
const CSV = path.join(__dirname, '..', 'data', 'XAUUSD_M1.csv');
const HAVE_DATA = fs.existsSync(CSV);
const SKIP = HAVE_DATA ? false : `desk/data/XAUUSD_M1.csv absent — run: node desk/scripts/import_gma.js (copies the goldbridge/out history once)`;

const CHAMPION = { pivotStrengthLtf: 1, armMode: 'either', maxEntriesPerArm: 3, exitModel: 'liquidity_v1', trailPadUsd: 0.30 };
const GOLDEN = { trades: 312, net_r: 30.64, profit_factor: 1.25, max_dd_r: 11.05 };

let m1 = null;
const bars = () => (m1 ||= E.loadM1(CSV));

test('golden: champion params reproduce 312 trades / net_r 30.64 / PF 1.25 / max_dd_r 11.05 (no gate)', { skip: SKIP }, () => {
  const res = E.runDoubleBOS(bars(), CHAMPION);
  const m = E.metrics(res.trades);
  assert.equal(m.trades, GOLDEN.trades);
  assert.equal(m.net_r, GOLDEN.net_r);
  assert.equal(m.profit_factor, GOLDEN.profit_factor);
  assert.equal(m.max_dd_r, GOLDEN.max_dd_r);
  assert.equal(res.warmupBars, 0, 'no countFrom → no warm-up');
  assert.equal(m.by_session.asia.n + m.by_session.ny.n, GOLDEN.trades);
});

test('golden: DEFAULTS + champion merged gives the identical result (params_resolved path)', { skip: SKIP }, () => {
  const res = E.runDoubleBOS(bars(), { ...E.DEFAULTS, ...CHAMPION });
  const m = E.metrics(res.trades);
  assert.deepEqual(
    { trades: m.trades, net_r: m.net_r, profit_factor: m.profit_factor, max_dd_r: m.max_dd_r },
    GOLDEN,
  );
});

test('golden: every trade record carries the desk fields (risk, entryIdx/exitIdx, pt_date, week, month)', { skip: SKIP }, () => {
  const { trades } = E.runDoubleBOS(bars(), CHAMPION);
  for (const tr of trades) {
    assert.ok(tr.risk >= 0.5 && tr.risk <= 12, `risk in [0.5, maxSlUsd]: ${tr.risk}`);
    assert.ok(Number.isInteger(tr.entryIdx) && Number.isInteger(tr.exitIdx) && tr.exitIdx >= tr.entryIdx, 'ltf bar indexes');
    assert.match(tr.pt_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(tr.week, /^\d{4}-W\d{2}$/);
    assert.match(tr.month, /^\d{4}-\d{2}$/);
    assert.equal(tr.month, tr.pt_date.slice(0, 7), 'month key agrees with pt_date');
    assert.equal(tr.pt_date, E.ptDate(tr.exitT), 'pt_date is the exit date in PT');
  }
  // data span 2026-03-24..2026-07-03 (server) → PT keys stay inside that range
  const months = new Set(trades.map((t) => t.month));
  for (const mo of months) assert.ok(mo >= '2026-03' && mo <= '2026-07', mo);
});

test('golden: countFrom at the 70% bar → exact tail of the full run (every entryT >= countFrom), warmupBars, cold-slice comparison', { skip: SKIP }, () => {
  const all = bars();
  const idx70 = Math.floor(all.length * 0.7);
  const countFrom = all[idx70].t;

  const full = E.runDoubleBOS(all, CHAMPION);
  const warm = E.runDoubleBOS(all, { ...CHAMPION, countFrom });
  const slice = E.runDoubleBOS(all.slice(idx70), CHAMPION);

  assert.ok(warm.trades.length > 0, 'warm-up run produced trades');
  for (const tr of warm.trades) assert.ok(tr.entryT >= countFrom, 'every counted trade enters at/after countFrom');
  assert.equal(warm.warmupBars, idx70, 'warmupBars = number of M1 bars before countFrom');

  // the counted set is exactly the tail of the full run (warm-up changes nothing else)
  const tail = full.trades.filter((t) => t.entryT >= countFrom);
  assert.equal(warm.trades.length, tail.length);
  assert.deepEqual(warm.trades, tail);

  // Cold-start slice comparison. The contract expected warm >= cold ("warm-up makes it >=").
  // That is NOT an invariant of this engine: a cold slice fabricates structure from its first
  // few bars (e.g. liquidity_v1 finds a spurious nearby "terminal" target, hits TP early, and
  // takes another entry off the same arm). Observed at the 70% bar: warm 108 vs cold 109.
  // So the assertions above (warm == exact tail of the full run) are the real invariant; here
  // we only require both runs to trade and to differ by at most a handful of path-dependent
  // trades, and we print the counts for the record.
  assert.ok(slice.trades.length > 0, "cold slice produced trades");
  const diff = Math.abs(warm.trades.length - slice.trades.length);
  assert.ok(diff <= 5, `warm ${warm.trades.length} vs cold slice ${slice.trades.length} (diff ${diff})`);
  console.log(`countFrom@70%: warm ${warm.trades.length} trades, cold slice ${slice.trades.length}, full ${full.trades.length}, warmupBars ${warm.warmupBars}`);
});
