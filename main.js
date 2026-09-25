const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const createWindow = () => {
  const win = new BrowserWindow({
    title: 'Musify',
    width: 1200,
    height: 800,
    minWidth: 360,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  // Load the index.html of the app.
  win.loadFile('swift-index.html')
}

const { spawn } = require('child_process')
let proxyProcess;

app.whenReady().then(() => {
  // Start the proxy server automatically
  proxyProcess = spawn('bun', ['run', 'youtube-proxy.js'], { cwd: __dirname });
  
  proxyProcess.stdout.on('data', (data) => console.log(`Proxy: ${data}`));
  proxyProcess.stderr.on('data', (data) => console.error(`Proxy Error: ${data}`));
  proxyProcess.on('error', (err) => console.log('Proxy background spawn notice (safe to ignore if running python backend):', err.message));

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (proxyProcess) proxyProcess.kill();
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  if (proxyProcess) proxyProcess.kill();
})
