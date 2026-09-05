// Gold Metal Alchemist — orientation scorer.
// Machine's blind call on the day's code: compares the key window's close path against the
// day print's close path under the four orientations. Pure math, no tokens.
// The machine's call is SECONDARY to Mike's — see SCOPE.md A1 (agreement gate).

function resample(values, n) {
  if (values.length === n) return values.slice();
  const out = new Array(n);
  const step = (values.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const lo = Math.floor(x);
    const hi = Math.min(lo + 1, values.length - 1);
    out[i] = values[lo] + (values[hi] - values[lo]) * (x - lo);
  }
  return out;
}

function zscore(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1;
  return values.map((v) => (v - mean) / sd);
}

function pearson(a, b) {
  const n = a.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum / n; // both inputs are z-scored, so this IS the correlation
}

// Orientation = the transform applied to the KEY that best matches the print.
function scoreOrientations(keyCloses, printCloses, n = 60) {
  const key = zscore(resample(keyCloses, n));
  const print = zscore(resample(printCloses, n));
  const rev = key.slice().reverse();
  const scores = {
    none: pearson(key, print),
    flipH: pearson(rev, print),
    flipV: pearson(key.map((v) => -v), print),
    both: pearson(rev.map((v) => -v), print),
  };
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestCode, bestScore] = entries[0];
  const margin = bestScore - entries[1][1];
  // Confidence: how good the match is AND how clearly it beats the runner-up.
  const confidence = Math.max(0, Math.min(1, ((bestScore + 1) / 2) * 0.6 + Math.min(margin, 0.5) * 0.8));
  // Abstain: a weak best-of-four is a guess, not a call. Below threshold the machine says
  // 'unclear' — same option the human has. Threshold is a first guess; Mike's verdict labels
  // calibrate it (and every other scoring choice) in the Phase 2 sweep.
  const ABSTAIN_BELOW = 0.40;
  const code = bestScore < ABSTAIN_BELOW ? 'unclear' : bestCode;
  return { scores, code, confidence: Number(confidence.toFixed(3)), best: bestCode, bestScore: Number(bestScore.toFixed(3)) };
}

// Score a captured day and write the machine call to its verdict row (create if none).
// Never overwrites a human_code; recomputes `agreed` if one exists.
function scoreDay(db, dayId, ventureId = 1) {
  const day = db.prepare('SELECT * FROM gma_alchemy_days WHERE id = ?').get(dayId);
  if (!day || !day.key_ohlc || !day.print_ohlc) return null;
  const keyCloses = JSON.parse(day.key_ohlc).map((b) => b.close ?? b.c);
  const printCloses = JSON.parse(day.print_ohlc).map((b) => b.close ?? b.c);
  if (keyCloses.length < 10 || printCloses.length < 10) return null;

  const result = scoreOrientations(keyCloses, printCloses);
  const existing = db
    .prepare('SELECT id, human_code FROM gma_verdicts WHERE day_id = ? ORDER BY id DESC')
    .get(dayId);
  if (existing) {
    db.prepare(
      `UPDATE gma_verdicts SET machine_code = ?, machine_scores = ?, machine_confidence = ?,
         agreed = CASE WHEN human_code IS NULL THEN NULL WHEN human_code = ? THEN 1 ELSE 0 END
       WHERE id = ?`
    ).run(result.code, JSON.stringify(result.scores), result.confidence, result.code, existing.id);
  } else {
    db.prepare(
      `INSERT INTO gma_verdicts (day_id, venture_id, machine_code, machine_scores, machine_confidence)
       VALUES (?, ?, ?, ?, ?)`
    ).run(dayId, ventureId, result.code, JSON.stringify(result.scores), result.confidence);
  }
  return result;
}

module.exports = { scoreOrientations, scoreDay, resample, zscore };
