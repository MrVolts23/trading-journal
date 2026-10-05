// Trading Desk — talking to Clef (the local decision model) through its sidecar service.
//
// The sidecar lives in ~/Projects/alchemy-clef (Python + MLX). This file starts it when needed, builds one record
// per skill from a saved example (facts + the right pictures + the skill's questions), sends it, and stores
// exactly what was sent and what came back. Nothing is summarised on the way in or out.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const store = require('./store');

const CLEF_DIR = process.env.CLEF_DIR || path.join(os.homedir(), 'Projects', 'alchemy-clef');
const PYTHON = path.join(CLEF_DIR, '.venv', 'bin', 'python');
const SERVER = path.join(CLEF_DIR, 'clef_server.py');
const PORT = Number(process.env.CLEF_PORT || 3021);
let child = null;

function installed() { return fs.existsSync(PYTHON) && fs.existsSync(SERVER); }

function request(method, p, body, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, timeout: timeoutMs }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => { try { const j = JSON.parse(buf); if (res.statusCode >= 400) reject(new Error(j.error || `Clef answered ${res.statusCode}`)); else resolve(j); } catch (e) { reject(new Error('Clef gave an unreadable answer')); } });
    });
    req.on('timeout', () => { req.destroy(new Error('Clef took too long to answer')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function health() { try { return await request('GET', '/health', null, 3000); } catch (_) { return null; } }

// Start the sidecar if it is not answering; wait for it (the model takes a few seconds to load the first time).
async function ensure() {
  if (!installed()) { const e = new Error('Clef is not installed on this Mac (expected ~/Projects/alchemy-clef with its .venv).'); e.status = 503; throw e; }
  if (await health()) return true;
  if (!child || child.exitCode != null) {
    const log = fs.openSync(path.join(store.DIR, 'clef-sidecar.log'), 'a');
    child = spawn(PYTHON, [SERVER], { cwd: CLEF_DIR, env: { ...process.env, CLEF_PORT: String(PORT) }, stdio: ['ignore', log, log] });
    child.unref();
  }
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 1000)); if (await health()) return true; }
  const e = new Error('Clef did not start. See clef-sidecar.log in the trading-desk folder.'); e.status = 503; throw e;
}

function stop() { if (child && child.exitCode == null) { try { child.kill(); } catch (_) {} } child = null; }

// Which saved picture a skill should look at: the chart whose timeframe matches what it reads.
const PIC = ['top', 'bottom', 'third'];
function pictureFor(ex, skill, moment) {
  const tfs = ex.charts && ex.charts.tfs && ex.charts.tfs.length ? ex.charts.tfs : [ex.top_tf, ex.bottom_tf];
  const wantFast = ['bos_3m', 'exit_structure', 'market_state'].includes(skill.key);
  let idx = 0;
  if (wantFast) { let best = Infinity; tfs.forEach((t, i) => { if (t < best) { best = t; idx = i; } }); }
  else { let best = -1; tfs.forEach((t, i) => { if (t > best) { best = t; idx = i; } }); }
  const name = `${PIC[idx]}_${moment}`;
  const p = ex.images && ex.images[name] ? store.imagePath(ex.id, name) : null;
  return { name, path: p, tf: tfs[idx] };
}

const VAN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const when = (utc) => (utc == null ? null : VAN.format(new Date(utc * 1000)));

// The facts Clef gets. Deliberately NOT included: Mike's own answer (take/skip, grade, trend call) — that is the
// thing Clef is being tested against.
function stateFor(ex, skill, pic) {
  const inst = store.listInstruments().find((i) => i.symbol === ex.symbol) || {};
  const rule = ex.entry_rule || {};
  const state = {
    task: `You are judging a ${inst.name || ex.symbol} (${ex.symbol}) chart for the skill "${skill.name}".`,
    skill: skill.description || '',
    rules: [
      'Points 1, 2 and 3 are tops or bottoms of finished candles. For a buy: 1 bottom, 2 top, 3 higher bottom. For a sell: the mirror.',
      'Point 3 must stay inside the 1-2 leg; if it goes past point 1 the setup is invalid.',
      'The entry (point 4) is when price trades through point 2 in the direction of the trade.',
      'We never trade against the trend; a 1-2-3 against the trend is a reversal call and is ignored.',
      'On the chart: blue numbered tags are points 1-3, a gold tag is point 4, orange E tags are the exit pattern, a red/green box is the planned trade, the blue line is the 15-minute 50 EMA, the green line the 1-hour 200 EMA, shaded boxes are the Tokyo / London / New York sessions.',
    ],
    picture: { chart_timeframe_minutes: pic.tf, moment: pic.name.replace(/^(top|bottom|third)_/, ''), time_zone: 'America/Vancouver' },
    trade: { side: ex.side, entry_time: when(ex.entry_time), entry: ex.entry, stop: ex.stop, target: ex.target },
  };
  if (rule.points) state.marked_points = Object.fromEntries(Object.entries(rule.points).map(([n, p]) => [n, { price: p.p, time: when(p.t), kind: p.kind, chart_minutes: p.tf }]));
  if (rule.exit && rule.exit.points) state.marked_exit_points = Object.fromEntries(Object.entries(rule.exit.points).map(([n, p]) => [n, { price: p.p, time: when(p.t), kind: p.kind }]));
  return state;
}

function ensureTable() {
  const db = store.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS clef_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    example_id INTEGER NOT NULL,
    skill_key TEXT NOT NULL,
    model TEXT,
    picture TEXT,
    record TEXT NOT NULL,      -- exactly what was sent (minus the picture bytes)
    answers TEXT NOT NULL,     -- exactly what came back
    ms INTEGER
  )`);
  return db;
}

// Ask Clef every taught skill the example teaches (or the ones named), one record per skill.
async function askExample(exampleId, skillKeys = null) {
  const ex = store.getExample(exampleId);
  if (!ex) { const e = new Error('That example no longer exists.'); e.status = 404; throw e; }
  const all = store.listSkills().filter((s) => s.kind === 'taught');
  const keys = skillKeys && skillKeys.length ? skillKeys : Object.keys(ex.skills || {});
  const skills = all.filter((s) => keys.includes(s.key) && Object.keys(s.questions || {}).length);
  if (!skills.length) { const e = new Error('No taught skill with questions applies to this example. Tick the skills it teaches, or add questions on the Skills tab.'); e.status = 400; throw e; }
  await ensure();
  const db = ensureTable();
  const out = [];
  for (const skill of skills) {
    const moment = skill.key === 'exit_structure' ? 'exit' : 'decision';
    let pic = pictureFor(ex, skill, moment);
    if (!pic.path && moment === 'exit') pic = pictureFor(ex, skill, 'full');
    if (!pic.path) { out.push({ skill: skill.key, error: `No "${moment}" picture saved for this example.` }); continue; }
    const record = { state: stateFor(ex, skill, pic), questions: skill.questions };
    const t0 = Date.now();
    let res;
    try { res = await request('POST', '/ask', { ...record, images: [pic.path] }); }
    catch (e) { out.push({ skill: skill.key, error: e.message }); continue; }
    const info = db.prepare('INSERT INTO clef_runs (example_id, skill_key, model, picture, record, answers, ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ex.id, skill.key, res.model || null, pic.name, JSON.stringify(record), JSON.stringify(res.answers), Date.now() - t0);
    out.push({ id: info.lastInsertRowid, skill: skill.key, skill_name: skill.name, picture: pic.name, record, answers: res.answers, ms: Date.now() - t0, model: res.model });
  }
  return { example_id: ex.id, runs: out };
}

function runsFor(exampleId) {
  const db = ensureTable();
  return db.prepare('SELECT * FROM clef_runs WHERE example_id = ? ORDER BY id DESC').all(exampleId)
    .map((r) => ({ ...r, record: JSON.parse(r.record), answers: JSON.parse(r.answers) }));
}
function allRuns(limit = 200) {
  const db = ensureTable();
  return db.prepare('SELECT r.*, e.side, e.decision, e.quality, e.setup, e.entry_time, e.skills AS example_skills FROM clef_runs r LEFT JOIN examples e ON e.id = r.example_id ORDER BY r.id DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, record: undefined, answers: JSON.parse(r.answers), example_skills: r.example_skills ? JSON.parse(r.example_skills) : null }));
}

async function status() {
  const h = await health();
  return { installed: installed(), running: !!h, loaded: !!(h && h.loaded), model: h ? h.model : null, answers: h ? h.answers : 0, dir: CLEF_DIR };
}

module.exports = { status, ensure, stop, askExample, runsFor, allRuns };
