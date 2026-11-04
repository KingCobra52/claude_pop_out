const { app, BrowserWindow, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');

const URL = 'https://claude.ai/new';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const AEROSPACE = ['/opt/homebrew/bin/aerospace', '/usr/local/bin/aerospace'].find((p) =>
  fs.existsSync(p)
);

const startedAt = Date.now();
let win = null;

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

// Floating is handled by an on-window-detected rule in ~/.aerospace.toml.
// To follow workspace switches with minimal lag, keep one long-lived
// `aerospace subscribe` process and move the window the instant an event arrives.
let aeroId = null;

async function moveToWorkspace(ws) {
  if (!ws) return;
  if (!aeroId) aeroId = await findAeroWindowId();
  if (!aeroId) return;
  const before = aeroId;
  await new Promise((resolve) =>
    execFile(AEROSPACE, ['move-node-to-workspace', '--window-id', before, ws], (err) => {
      if (err) aeroId = null; // stale id (window recreated); re-find next time
      resolve();
    })
  );
}

async function moveToFocusedWorkspace() {
  if (AEROSPACE) moveToWorkspace(await aero(['list-workspaces', '--focused']));
}

function followWorkspaces() {
  if (!AEROSPACE) return;
  const sub = spawn(AEROSPACE, ['subscribe', 'focused-workspace-changed']);
  let buf = '';
  sub.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        if (win && win.isVisible()) moveToWorkspace(JSON.parse(line).workspace);
      } catch {}
    }
  });
  sub.on('exit', () => setTimeout(followWorkspaces, 1000));
  process.on('exit', () => sub.kill());
  app.on('before-quit', () => sub.removeAllListeners('exit'));
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
  win.on('show', moveToFocusedWorkspace);
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
  followWorkspaces();
  toggle();
});

// Option+Space is bound in AeroSpace to `open -a "Claude Float"`: it launches
// the app if closed, and re-opening a running app lands here.
app.on('activate', () => {
  if (win && Date.now() - startedAt > 1500) toggle();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
app.on('window-all-closed', (e) => e.preventDefault());
