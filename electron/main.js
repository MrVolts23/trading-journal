const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path  = require('path');
const http  = require('http');
const { fork } = require('child_process');

const PORT = 3001;
let mainWindow   = null;
let backendProc  = null;

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
    titleBarStyle: 'hiddenInset',
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

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update-downloaded');
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update ready',
      message: 'A new version has been downloaded. Restart to apply the update.',
      buttons: ['Restart now', 'Later'],
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', err => console.error('[updater]', err.message));

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
