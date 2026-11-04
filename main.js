const { app, BrowserWindow, globalShortcut, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');

const SHORTCUT = 'Alt+Space';
const URL = 'https://claude.ai/new';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const AEROSPACE = ['/opt/homebrew/bin/aerospace', '/usr/local/bin/aerospace'].find((p) =>
  fs.existsSync(p)
);

let win = null;
let followTimer = null;
let aeroId = null;

function aero(args) {
  return new Promise((resolve) => {
    if (!AEROSPACE) return resolve('');
    execFile(AEROSPACE, args, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

async function findAeroWindowId() {
  const out = await aero([
    'list-windows', '--all', '--format', '%{window-id}|%{app-pid}',
  ]);
  for (const line of out.split('\n')) {
    const [id, pid] = line.split('|');
    if (Number(pid) === process.pid) return id;
  }
  return null;
}

async function startAerospace() {
  if (!AEROSPACE) return;
  aeroId = await findAeroWindowId();
  if (!aeroId) return;
  await aero(['layout', '--window-id', aeroId, 'floating']);
  followTimer = setInterval(async () => {
    const ws = await aero(['list-workspaces', '--focused']);
    if (ws && aeroId) aero(['move-node-to-workspace', '--window-id', aeroId, ws]);
  }, 300);
}

function stopAerospace() {
  clearInterval(followTimer);
  followTimer = null;
  aeroId = null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 640,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setUserAgent(USER_AGENT);
  win.loadURL(URL);

  win.webContents.on('did-finish-load', () => {
    win.webContents.insertCSS(
      '#__drag{position:fixed;top:0;left:0;right:0;height:12px;-webkit-app-region:drag;z-index:2147483647}'
    );
    win.webContents.executeJavaScript(
      "if(!document.getElementById('__drag')){const d=document.createElement('div');d.id='__drag';document.body.appendChild(d)}"
    );
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!new (require('url').URL)(url).hostname.endsWith('claude.ai')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('show', startAerospace);
  win.on('hide', stopAerospace);
}

function toggle() {
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.focus();
  }
}

app.whenReady().then(() => {
  createWindow();
  if (!globalShortcut.register(SHORTCUT, toggle)) {
    console.error(`Failed to register ${SHORTCUT} (already in use?)`);
  }
  toggle();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
