const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path  = require('path');
const http  = require('http');
const fs    = require('fs');
const { fork, spawn } = require('child_process');

const PORT = 3001;
let mainWindow   = null;
let backendProc  = null;
let downloadedUpdateFile = null; // path to the staged update .zip (from electron-updater)

// ── Data path ────────────────────────────────────────────────────────────────
// On Mac: ~/Library/Application Support/MikeTradingJournal/journal.db
// Survives app updates automatically.
const DB_PATH = path.join(app.getPath('userData'), 'journal.db');

// ── Start the Express backend ─────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    const entry = app.isPackaged
      ? path.join(process.resourcesPath, 'backend', 'src', 'index.js')
      : path.join(__dirname, '../backend/src/index.js');

    const frontendDist = app.isPackaged
      ? path.join(process.resourcesPath, 'frontend', 'dist')
      : path.join(__dirname, '../frontend/dist');

    backendProc = fork(entry, [], {
      env: {
        ...process.env,
        PORT: String(PORT),
        TRADING_JOURNAL_DB: DB_PATH,
        FRONTEND_DIST: frontendDist,
        NODE_ENV: 'production',
      },
      silent: true,
    });

    backendProc.stdout?.on('data', d => console.log('[backend]', d.toString().trim()));
    backendProc.stderr?.on('data', d => console.error('[backend err]', d.toString().trim()));
    backendProc.on('error', reject);

    // Poll health endpoint until the server is up
    let attempts = 0;
    function poll() {
      http.get(`http://localhost:${PORT}/api/health`, res => {
        resolve();
      }).on('error', () => {
        if (++attempts < 40) setTimeout(poll, 500);
        else reject(new Error('Backend failed to start after 20 seconds'));
      });
    }
    setTimeout(poll, 800);
  });
}

// ── Create the main window ────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:    1440,
    height:   900,
    minWidth: 1100,
    minHeight: 700,
    titleBarStyle: 'default',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupUpdater() {
  autoUpdater.autoDownload = true;
  // OFF on purpose: the built-in on-quit installer would run at the same moment as our own swap
  // script below and the two would tear the app bundle apart ("damaged or incomplete").
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', info => {
    mainWindow?.webContents.send('update-available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-not-available');
  });

  autoUpdater.on('download-progress', info => {
    // info: { percent, transferred, total, bytesPerSecond }
    mainWindow?.webContents.send('update-download-progress', info);
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateFile = info?.downloadedFile || null;
    updaterLog(`downloaded ${info?.version} -> ${downloadedUpdateFile}`);
    mainWindow?.webContents.send('update-downloaded');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update ready',
      message: 'A new version has been downloaded. Restart to apply the update.',
      buttons: ['Restart now', 'Later'],
    }).then(({ response }) => {
      if (response === 0) applyUpdateAndRestart();
    });
  });

  autoUpdater.on('error', err => {
    console.error('[updater]', err.message);
    updaterLog(`updater error: ${err.message}`);
    mainWindow?.webContents.send('update-error', err.message);
  });

  // Allow renderer to manually trigger a check
  const { ipcMain } = require('electron');
  ipcMain.on('check-for-updates', () => {
    if (app.isPackaged) autoUpdater.checkForUpdates();
  });

  if (app.isPackaged) {
    // Check on startup, then every 15 minutes
    autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates(), 15 * 60 * 1000);
  }
}

// ── Custom self-installer (unsigned-app friendly) ─────────────────────────────
// macOS Squirrel.Mac refuses to apply updates to UNSIGNED apps, so quitAndInstall()
// silently fails. Instead we swap the .app bundle ourselves: a detached script waits
// for this process to exit, replaces the app in /Applications with the freshly
// downloaded build, strips the quarantine flag, and relaunches it.
function findStagedZip() {
  if (downloadedUpdateFile && fs.existsSync(downloadedUpdateFile)) return downloadedUpdateFile;
  try {
    const dir = path.join(app.getPath('home'), 'Library/Caches', `${app.getName()}-updater`, 'pending');
    const f = fs.readdirSync(dir).find(n => n.toLowerCase().endsWith('.zip'));
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}

const RELEASES_URL = 'https://github.com/MrVolts23/trading-journal/releases/latest';
function updaterLog(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'updater.log'), `${new Date().toISOString()} ${msg}\n`); } catch (_) {}
}
function updateFailedDialog(reason) {
  updaterLog(`FAILED: ${reason}`);
  mainWindow?.webContents.send('update-error', reason);
  dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Update could not be installed',
    message: 'The update could not be installed automatically.',
    detail: `${reason}\n\nYour current version and all your data are untouched. You can download the latest installer from the releases page.`,
    buttons: ['Open releases page', 'Close'],
  }).then(({ response }) => { if (response === 0) shell.openExternal(RELEASES_URL); });
}

function applyUpdateAndRestart() {
  try {
    const zip = findStagedZip();
    const appPath = path.resolve(process.execPath, '..', '..', '..'); // /Applications/Trading Journal.app
    if (!zip) return updateFailedDialog('The downloaded update file could not be found.');
    if (!appPath.endsWith('.app')) return updateFailedDialog(`Unexpected app location: ${appPath}`);
    const log    = path.join(app.getPath('userData'), 'updater.log');
    const tmp    = path.join(app.getPath('temp'), 'tj-update-extract');
    const script = path.join(app.getPath('temp'), 'tj-apply-update.sh');
    // Safe swap: extract → validate → stage next to the app → move old aside → move new in →
    // verify → only then delete the old copy. Any failure puts the old app back and relaunches it.
    const sh = `#!/bin/bash
# args: <app_pid> <zip> <app_path> <tmp_dir> <log>
APP_PID="$1"; ZIP="$2"; APP_PATH="$3"; TMP="$4"; LOG="$5"
NEW="$APP_PATH.new"; OLD="$APP_PATH.old"
say() { echo "$(date -u +%FT%TZ) [swap] $*" >> "$LOG"; }
fail() { say "FAIL: $*"; rm -rf "$NEW" "$TMP"; if [ ! -d "$APP_PATH" ] && [ -d "$OLD" ]; then mv "$OLD" "$APP_PATH"; say "old app restored"; fi; /usr/bin/open "$APP_PATH"; exit 1; }
say "start pid=$APP_PID zip=$ZIP app=$APP_PATH"
for i in $(seq 1 120); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.5; done
# helpers (backend, GPU, renderer) live inside the bundle; make sure none still hold it open
/usr/bin/pkill -f "$APP_PATH/Contents/" 2>/dev/null; sleep 1
rm -rf "$TMP" "$NEW" "$OLD"; mkdir -p "$TMP"
/usr/bin/ditto -x -k "$ZIP" "$TMP" || fail "could not extract the update zip"
SRC="$(/usr/bin/find "$TMP" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$SRC" ] || fail "no .app inside the update zip"
[ -f "$SRC/Contents/Info.plist" ] || fail "update is missing Info.plist"
EXE="$(/usr/bin/defaults read "$SRC/Contents/Info" CFBundleExecutable 2>/dev/null)"
[ -n "$EXE" ] && [ -x "$SRC/Contents/MacOS/$EXE" ] || fail "update is missing its executable"
/usr/bin/codesign --verify --deep --strict "$SRC" 2>>"$LOG" || fail "update failed its signature check"
/usr/bin/ditto "$SRC" "$NEW" || fail "could not stage the new app"
/usr/bin/codesign --verify --deep --strict "$NEW" 2>>"$LOG" || fail "staged copy failed its signature check"
mv "$APP_PATH" "$OLD" || fail "could not move the old app aside"
mv "$NEW" "$APP_PATH" || fail "could not move the new app into place"
/usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
say "installed $(/usr/bin/defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
rm -rf "$OLD" "$TMP"
/usr/bin/open "$APP_PATH"
`;
    fs.writeFileSync(script, sh, { mode: 0o755 });
    updaterLog(`applying update from ${zip}`);
    const child = spawn('/bin/bash', [script, String(process.pid), zip, appPath, tmp, log], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    setTimeout(() => app.quit(), 250);
  } catch (e) {
    console.error('[updater] custom install failed:', e.message);
    updateFailedDialog(`Install failed: ${e.message}`);
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await startBackend();
    createWindow();
    setupUpdater();
  } catch (err) {
    dialog.showErrorBox('Startup error', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('before-quit', () => {
  backendProc?.kill();
});
