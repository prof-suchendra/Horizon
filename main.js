const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

let mainWindow;
let proxyProcess = null;

app.setName('Horizon');

const createWindow = () => {
  mainWindow = new BrowserWindow({
    title: 'Horizon',
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 600,
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  if (mainWindow.setAppDetails) {
    mainWindow.setAppDetails({ appId: 'horizon' });
  }

  // Load the index.html of the app.
  mainWindow.loadFile('swift-index.html');
};

function getBackendExecutable() {
  const binaryPath = path.join(__dirname, 'horizon-backend');
  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }
  return null;
}

function startBackendProxy() {
  const bin = getBackendExecutable();
  if (!bin) {
    console.warn('[Horizon] horizon-backend binary not found. Build it with: go build -o horizon-backend main.go');
    return;
  }
  console.log(`[Horizon] Starting local Go backend: ${bin}`);

  try {
    proxyProcess = spawn(bin, [], {
      cwd: __dirname,
      env: { ...process.env, PORT: '8000' }
    });

    proxyProcess.stdout.on('data', (data) => {
      console.log(`[Backend] ${data}`.trim());
    });

    proxyProcess.stderr.on('data', (data) => {
      console.log(`[Backend log] ${data}`.trim());
    });

    proxyProcess.on('error', (err) => {
      console.log(`[Backend Notice] (Proxy may already be running): ${err.message}`);
    });

    proxyProcess.on('exit', (code, signal) => {
      console.log(`[Backend] Process exited with code ${code}, signal ${signal}`);
    });
  } catch (err) {
    console.log(`[Backend Spawn Error] ${err.message}`);
  }
}

function stopBackendProxy() {
  if (proxyProcess) {
    try {
      console.log('[Horizon] Stopping local Go backend process...');
      proxyProcess.kill('SIGTERM');
      proxyProcess = null;
    } catch (e) {
      // Ignored
    }
  }
}

app.whenReady().then(() => {
  startBackendProxy();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBackendProxy();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  stopBackendProxy();
});

process.on('SIGINT', () => {
  stopBackendProxy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopBackendProxy();
  process.exit(0);
});
