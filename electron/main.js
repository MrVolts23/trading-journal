const { app, BrowserWindow, dialog, ipcMain } = require('electron');
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
  autoUpdater.autoInstallOnAppQuit = true;

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

function applyUpdateAndRestart() {
  try {
    const zip = findStagedZip();
    const appPath = path.resolve(process.execPath, '..', '..', '..'); // /Applications/Trading Journal.app
    if (!zip || !appPath.endsWith('.app')) {
      // Couldn't locate the staged build — fall back to the native installer.
      autoUpdater.quitAndInstall();
      return;
    }
    const tmp    = path.join(app.getPath('temp'), 'tj-update-extract');
    const script = path.join(app.getPath('temp'), 'tj-apply-update.sh');
    const sh = `#!/bin/bash
# args: <app_pid> <zip> <app_path> <tmp_dir>
APP_PID="$1"; ZIP="$2"; APP_PATH="$3"; TMP="$4"
# wait for the running app to fully quit
for i in $(seq 1 120); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 0.5; done
rm -rf "$TMP"; mkdir -p "$TMP"
/usr/bin/ditto -x -k "$ZIP" "$TMP" || exit 1
NEW_APP="$(/usr/bin/find "$TMP" -maxdepth 1 -name '*.app' | head -1)"
if [ -n "$NEW_APP" ]; then
  rm -rf "$APP_PATH"
  /usr/bin/ditto "$NEW_APP" "$APP_PATH"
  /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
  /usr/bin/open "$APP_PATH"
fi
rm -rf "$TMP"
`;
    fs.writeFileSync(script, sh, { mode: 0o755 });
    const child = spawn('/bin/bash', [script, String(process.pid), zip, appPath, tmp], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    setTimeout(() => app.quit(), 250);
  } catch (e) {
    console.error('[updater] custom install failed:', e.message);
    mainWindow?.webContents.send('update-error', `Install failed: ${e.message}`);
    try { autoUpdater.quitAndInstall(); } catch (_) {}
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
