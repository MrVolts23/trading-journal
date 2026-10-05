#!/usr/bin/env node
// Alchemy Trading Desk — put the data robot into the DEMO MetaTrader and compile it.
//
// Hard rules:
//   - the ONLY folder this script will ever write into is  …/Program Files/MetaTrader 5 Demo
//     (the live terminal next door, "MetaTrader 5", is never read, written or started)
//   - it refuses if that demo copy's saved login is not a demo server
//   - the robot it installs is read-only and demo-only by its own code (mt5/AlchemyDeskExporter.mq5)
//
// Usage: npm run install-robot
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const WINEPREFIX = path.join(os.homedir(), 'Library/Application Support/net.metaquotes.wine.metatrader5');
const PROGRAM_FILES = path.join(WINEPREFIX, 'drive_c/Program Files');
const DEMO_DIR = path.join(PROGRAM_FILES, 'MetaTrader 5 Demo');
const LIVE_DIR = path.join(PROGRAM_FILES, 'MetaTrader 5');
const WINE = '/Applications/MetaTrader 5.app/Contents/SharedSupport/wine/bin/wine';
const ROBOT = 'AlchemyDeskExporter';
const SRC = path.join(__dirname, `${ROBOT}.mq5`);

const say = (...a) => console.log(...a);
const fail = (msg) => { console.error('STOPPED: ' + msg); process.exit(1); };
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const readUtf16 = (f) => { const b = fs.readFileSync(f); return (b[0] === 0xff && b[1] === 0xfe ? b.slice(2) : b).toString('utf16le'); };

// ── guards ───────────────────────────────────────────────────────────────────────────
if (path.resolve(DEMO_DIR) === path.resolve(LIVE_DIR) || !/MetaTrader 5 Demo$/.test(DEMO_DIR)) fail('the target is not the demo copy.');
if (!fs.existsSync(path.join(DEMO_DIR, 'terminal64.exe'))) fail(`there is no demo MetaTrader at ${DEMO_DIR}`);
if (!fs.existsSync(SRC)) fail(`robot source missing: ${SRC}`);
if (/OrderSend|CTrade|PositionClose|MqlTradeRequest|Trade\.mqh/i.test(fs.readFileSync(SRC, 'utf8'))) fail('the robot source contains trading code. It must not.');

const commonIni = path.join(DEMO_DIR, 'config', 'common.ini');
if (fs.existsSync(commonIni)) {
  const ini = readUtf16(commonIni);
  const server = (ini.match(/^Server=(.*)$/m) || [])[1] || '';
  const login = (ini.match(/^Login=(.*)$/m) || [])[1] || '';
  if (server && !/demo/i.test(server)) fail(`the demo copy's saved login is on "${server.trim()}", which is not a demo server. Log it into a demo account first.`);
  say(`Demo copy's saved login: ${login.trim() || '(none yet)'} on ${server.trim() || '(none yet)'}`);
}

// ── install ──────────────────────────────────────────────────────────────────────────
const expertsDir = path.join(DEMO_DIR, 'MQL5', 'Experts');
const dst = path.join(expertsDir, `${ROBOT}.mq5`);
fs.mkdirSync(expertsDir, { recursive: true });
for (const d of ['in', 'out']) fs.mkdirSync(path.join(DEMO_DIR, 'MQL5', 'Files', 'alchemy_feed', d), { recursive: true });
fs.copyFileSync(SRC, dst);
say(`Robot source copied into the demo copy: MQL5/Experts/${ROBOT}.mq5`);

// ── compile (headless MetaEditor from the demo copy; relative paths from its own folder) ──
const ex5 = path.join(expertsDir, `${ROBOT}.ex5`);
const logFile = path.join(expertsDir, 'alchemy_compile.log');
for (const f of [ex5, logFile]) { try { fs.unlinkSync(f); } catch (_) { /* not there */ } }
const editor = ['MetaEditor64.exe', 'metaeditor64.exe'].find((n) => fs.existsSync(path.join(DEMO_DIR, n)));
if (!editor) fail('MetaEditor is missing from the demo copy.');
if (!fs.existsSync(WINE)) fail(`wine not found at ${WINE}`);

function compile(extraArgs) {
  return spawnSync(WINE, [editor, `/compile:MQL5\\Experts\\${ROBOT}.mq5`, '/log:MQL5\\Experts\\alchemy_compile.log', ...extraArgs], {
    cwd: DEMO_DIR, env: { ...process.env, WINEPREFIX, WINEDEBUG: '-all' }, timeout: 180000, stdio: 'ignore',
  });
}
say('Compiling (this starts MetaEditor quietly for a few seconds)…');
compile(['/portable']);
if (!fs.existsSync(ex5)) { say('  retrying without the portable flag…'); compile([]); }

const log = fs.existsSync(logFile) ? readUtf16(logFile) : '';
const result = (log.match(/Result:.*$/m) || log.match(/\d+ errors?, \d+ warnings?.*$/m) || [''])[0].trim();
if (!fs.existsSync(ex5)) {
  say(log.split(/\r?\n/).filter((l) => /error|warning/i.test(l)).slice(0, 12).join('\n'));
  fail(`the robot did not compile. ${result || 'See ' + logFile}`);
}
fs.writeFileSync(path.join(expertsDir, `${ROBOT}.installed.json`), JSON.stringify({
  robot: ROBOT, source_sha256: sha256(SRC), installed_at: new Date().toISOString(), compile_result: result,
}, null, 2));
say(`Compiled: ${result || 'ok'}`);
say(`Installed: MQL5/Experts/${ROBOT}.ex5 (${(fs.statSync(ex5).size / 1024).toFixed(0)} KB) — it will show in the demo MetaTrader's Navigator under Expert Advisors.`);
