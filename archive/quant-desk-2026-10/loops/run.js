#!/usr/bin/env node
// Gold Metal Alchemist — loop runner.
// Usage: node loops/run.js <loop-name>
// Runs loops/prompts/<loop-name>.md through headless Claude Code, enforcing:
//   1. GoldBridge HALT kill switch  → skip run
//   2. $10/day token budget (summed across ALL loops) → skip run, escalate once
// Every run (including skips) is recorded in gma_loop_runs.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DAILY_CAP_USD = 10;
const HALT_FILE = path.join(os.homedir(), 'Projects/goldbridge/HALT');
// Absolute path first: launchd jobs don't inherit shell PATH (learned the hard way, Jul 5)
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ||
  [path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
    .find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ||
  'claude';
const MAX_TURNS = process.env.GMA_MAX_TURNS || '40';

// Loops have their OWN better-sqlite3 (loops/node_modules) built for system node.
// The backend's copy is compiled for Electron's ABI — never require or rebuild it from here.
const Database = require('better-sqlite3');
// Same DB the Electron app uses (electron/main.js: app.getPath('userData') + journal.db)
const DB_PATH =
  process.env.TRADING_JOURNAL_DB ||
  path.join(os.homedir(), 'Library/Application Support/mikes-trading-journal/journal.db');

const loopName = process.argv[2];
if (!loopName) {
  console.error('Usage: node loops/run.js <loop-name>');
  process.exit(1);
}
const promptFile = path.join(__dirname, 'prompts', `${loopName}.md`);
if (!fs.existsSync(promptFile)) {
  console.error(`No prompt file: ${promptFile}`);
  process.exit(1);
}

const db = new Database(DB_PATH);

function record(status, extra = {}) {
  db.prepare(
    `INSERT INTO gma_loop_runs (loop_name, status, finished_at, cost_usd, tokens_in, tokens_out, summary, detail)
     VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?)`
  ).run(
    loopName,
    status,
    extra.cost_usd || 0,
    extra.tokens_in || null,
    extra.tokens_out || null,
    extra.summary || null,
    extra.detail ? JSON.stringify(extra.detail) : null
  );
}

function escalateOnce(title, detail) {
  const existing = db
    .prepare(`SELECT id FROM gma_escalations WHERE title = ? AND status = 'open'`)
    .get(title);
  if (!existing) {
    db.prepare('INSERT INTO gma_escalations (loop_name, title, detail) VALUES (?, ?, ?)').run(
      loopName,
      title,
      detail
    );
  }
}

// ── Guard 1: kill switch ────────────────────────────────────────────────────────
if (fs.existsSync(HALT_FILE)) {
  record('skipped_halt', { summary: 'GoldBridge HALT file present — all loops stand down.' });
  console.log(`[${loopName}] HALT file present. Skipping.`);
  process.exit(0);
}

// ── Guard 2: daily budget ───────────────────────────────────────────────────────
const spent = db
  .prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM gma_loop_runs WHERE date(started_at) = date('now')`)
  .get().s;
if (spent >= DAILY_CAP_USD) {
  record('skipped_budget', {
    summary: `Daily budget hit ($${spent.toFixed(2)} / $${DAILY_CAP_USD}). Auto-paused until midnight.`,
  });
  escalateOnce(
    'Daily token budget reached — loops paused',
    `Spent $${spent.toFixed(2)} of $${DAILY_CAP_USD} today. Loops resume automatically tomorrow.`
  );
  console.log(`[${loopName}] Budget cap reached ($${spent.toFixed(2)}). Skipping.`);
  process.exit(0);
}

// ── Run ────────────────────────────────────────────────────────────────────────
const prompt = fs.readFileSync(promptFile, 'utf8');
console.log(`[${loopName}] Starting (spent today: $${spent.toFixed(2)} / $${DAILY_CAP_USD})`);

try {
  const out = execFileSync(
    CLAUDE_BIN,
    ['-p', prompt, '--output-format', 'json', '--max-turns', MAX_TURNS],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 55 * 60 * 1000 }
  );
  let cost = 0, summary = null, usage = {};
  try {
    const parsed = JSON.parse(out);
    cost = parsed.total_cost_usd || 0;
    usage = parsed.usage || {};
    summary = typeof parsed.result === 'string' ? parsed.result.slice(0, 2000) : null;
  } catch {
    summary = out.slice(0, 2000);
  }
  record('done', {
    cost_usd: cost,
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
    summary,
  });
  console.log(`[${loopName}] Done. Cost: $${cost.toFixed(4)}`);
} catch (err) {
  record('failed', { summary: String(err.message).slice(0, 2000) });
  escalateOnce(`Loop failed: ${loopName}`, String(err.message).slice(0, 2000));
  console.error(`[${loopName}] FAILED: ${err.message}`);
  process.exit(1);
}
