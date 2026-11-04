const {
  app,
  BaseWindow,
  WebContentsView,
  Menu,
  Tray,
  globalShortcut,
  nativeImage,
  nativeTheme,
  screen,
  shell,
} = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const URL = 'https://claude.ai/new';
const HOTKEY = 'Alt+Space';
const TITLE_H = 28;
const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

// ---------- tracing (CLAUDE_FLOAT_TRACE=1) ----------
const TRACE = process.env.CLAUDE_FLOAT_TRACE === '1';
const traceFile = path.join(app.getPath('logs'), 'trace.log');
function trace(ev, data = {}) {
  if (!TRACE) return;
  const line = JSON.stringify({ t: +performance.now().toFixed(1), ev, ...data }) + '\n';
  fs.appendFile(traceFile, line, () => {});
}

// ---------- persisted window bounds ----------
const stateFile = path.join(app.getPath('userData'), 'state.json');
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return {};
  }
}
let saveTimer = null;
function saveBounds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) {
      if (goodBounds) fs.writeFile(stateFile, JSON.stringify({ bounds: goodBounds }), () => {});
    }
  }, 300);
}

// ---------- AeroSpace workspace following ----------
// The panel floats on every Space and AeroSpace normally leaves it alone, but
// it adopts the window once the app is activated (e.g. `open -a`). After that,
// AeroSpace "hides" it on workspace switches by parking it off-screen.
// Two layers keep it with you:
//  1. In-process: when the window is moved off-screen without us asking,
//     put it straight back (same frame, no process spawn).
//  2. One long-lived `aerospace subscribe`: move the node to the newly focused
//     workspace so AeroSpace agrees and stops re-hiding it.
const AEROSPACE = ['/opt/homebrew/bin/aerospace', '/usr/local/bin/aerospace'].find((p) =>
  fs.existsSync(p)
);
let aeroId = null;

function aero(args) {
  return new Promise((resolve) =>
    execFile(AEROSPACE, args, (err, stdout) => resolve(err ? null : stdout.trim()))
  );
}

async function findAeroId() {
  const out = await aero(['list-windows', '--all', '--format', '%{window-id}|%{app-pid}']);
  for (const line of (out || '').split('\n')) {
    const [id, pid] = line.split('|');
    if (Number(pid) === process.pid) return id;
  }
  return null; // not managed by AeroSpace → nothing to do
}

async function followTo(ws) {
  const t0 = performance.now();
  if (!aeroId) aeroId = await findAeroId();
  if (!aeroId) return trace('ws:unmanaged', { ws });
  const ok = await aero(['move-node-to-workspace', '--window-id', aeroId, ws]);
  if (ok === null) aeroId = null; // stale id; re-find next time
  trace('ws:moved', { ws, ok: ok !== null, ms: +(performance.now() - t0).toFixed(1) });
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
        const ws = JSON.parse(line).workspace;
        if (ws && win) followTo(ws);
      } catch {}
    }
  });
  sub.on('exit', () => {
    if (!app.isQuitting) setTimeout(followWorkspaces, 1000);
  });
  app.on('will-quit', () => sub.kill());
}

// Is (nearly) all of the window on some display? AeroSpace parks hidden
// windows almost entirely off-screen, and sometimes drops restored ones
// partly off the edge; neither counts as a real position.
function onScreen(b) {
  const area = b.width * b.height;
  return screen.getAllDisplays().some(({ bounds: d }) => {
    const w = Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x);
    const h = Math.min(b.y + b.height, d.y + d.height) - Math.max(b.y, d.y);
    return w > 0 && h > 0 && w * h >= area * 0.9;
  });
}

// ---------- window ----------
let win = null;
let titleView = null;
let pageView = null;
let tray = null;
let goodBounds = null; // last on-screen bounds

const bg = () => (nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5');

function layout() {
  const { width, height } = win.getContentBounds();
  titleView.setBounds({ x: 0, y: 0, width, height: TITLE_H });
  pageView.setBounds({ x: 0, y: TITLE_H, width, height: Math.max(0, height - TITLE_H) });
}

function onMove() {
  const b = win.getBounds();
  if (onScreen(b)) {
    goodBounds = b;
  } else if (goodBounds && win.isVisible()) {
    // AeroSpace parked us off-screen for a workspace switch: undo it now.
    win.setBounds(goodBounds);
    trace('ws:restored');
  }
}

function createWindow() {
  // Drag strip lives in its own tiny view: its drag region never changes, so
  // macOS drags the window natively and claude.ai's DOM churn can't affect it.
  titleView = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  titleView.webContents.loadFile(path.join(__dirname, 'title.html'));

  pageView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // stay painted while hidden → instant show
    },
  });
  pageView.setBackgroundColor(bg());

  const saved = loadState().bounds;
  win = new BaseWindow({
    width: 520,
    height: 640,
    ...(saved && onScreen(saved) ? saved : {}),
    minWidth: 360,
    minHeight: 300,
    show: false,
    // NSPanel: floats over full-screen apps, joins every Space, and takes key
    // focus without activating the app (Spotlight-style).
    type: 'panel',
    frame: false,
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: bg(),
    hiddenInMissionControl: true,
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.contentView.addChildView(pageView);
  win.contentView.addChildView(titleView);
  layout();
  goodBounds = win.getBounds();

  if (TRACE) {
    let lastMove = 0;
    win.on('move', () => {
      const now = performance.now();
      trace('move', { dt: +(now - lastMove).toFixed(1) });
      lastMove = now;
    });
  }
  win.on('move', onMove);
  win.on('resize', layout);
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      hide();
    }
  });

  const wc = pageView.webContents;
  wc.setUserAgent(USER_AGENT);
  wc.loadURL(URL);

  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!new globalThis.URL(url).hostname.endsWith('claude.ai')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  const onKey = (e, input) => {
    if (input.type !== 'keyDown') return;
    const cmd = input.meta && !input.control && !input.alt;
    if ((input.key === 'Escape' && !input.meta && !input.shift && !input.alt) ||
        (cmd && input.key.toLowerCase() === 'w')) {
      e.preventDefault();
      hide();
    }
  };
  wc.on('before-input-event', onKey);
  titleView.webContents.on('before-input-event', onKey);

  if (TRACE) {
    wc.on('dom-ready', () =>
      wc.executeJavaScript(`(() => {
        if (window.__cfObs) return;
        window.__cfObs = new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            console.log('__cf ' + JSON.stringify({ ev: 'input', name: e.name,
              dur: Math.round(e.duration), delay: Math.round(e.processingStart - e.startTime),
              proc: Math.round(e.processingEnd - e.processingStart) }));
        });
        window.__cfObs.observe({ type: 'event', durationThreshold: 16, buffered: false });
      })()`).catch(() => {})
    );
    wc.on('console-message', ({ message }) => {
      if (typeof message === 'string' && message.startsWith('__cf ')) {
        const d = JSON.parse(message.slice(5));
        trace(d.ev, d);
      }
    });
  }

  nativeTheme.on('updated', () => {
    win.setBackgroundColor(bg());
    pageView.setBackgroundColor(bg());
  });
}

const FOCUS_COMPOSER = `(() => {
  const el = document.querySelector('[contenteditable="true"].ProseMirror, [contenteditable="true"], textarea');
  if (!el || el.contains(document.activeElement)) return;
  el.focus();
  if (el.isContentEditable) {
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
})()`;

function show() {
  const t0 = performance.now();
  trace('show:start');
  if (goodBounds && !onScreen(win.getBounds())) win.setBounds(goodBounds);
  win.show();
  win.focus();
  pageView.webContents.focus();
  trace('shown', { ms: +(performance.now() - t0).toFixed(1) });
  pageView.webContents.executeJavaScript(FOCUS_COMPOSER).catch(() => {});
  if (TRACE) {
    pageView.webContents
      .executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
      .then(() => trace('firstFrame', { ms: +(performance.now() - t0).toFixed(1) }))
      .catch(() => {});
  }
}

function hide() {
  trace('hide');
  // The panel is non-activating, so hiding it hands keyboard focus straight
  // back to the app underneath. (app.hide() would leave the app flagged hidden,
  // which drops the window from the accessibility tree on the next show.)
  win.hide();
}

function toggle(source) {
  trace('toggle', { source, visible: win.isVisible() });
  if (win.isVisible() && win.isFocused()) hide();
  else show();
}

// ---------- tray ----------
function trayIcon() {
  // 4-point sparkle drawn into a template bitmap (16pt @1x and @2x).
  const make = (size) => {
    const buf = Buffer.alloc(size * size * 4);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = Math.abs(x - c) / c;
        const dy = Math.abs(y - c) / c;
        // astroid-like star: |x|^0.5 + |y|^0.5 <= 1, plus a small center disc
        const star = Math.sqrt(dx) + Math.sqrt(dy);
        const a = Math.max(0, Math.min(1, (1.0 - star) * size * 0.35 + 0.5));
        buf[(y * size + x) * 4 + 3] = Math.round(a * 255); // BGRA, black w/ alpha
      }
    }
    return buf;
  };
  const img = nativeImage.createFromBitmap(make(16), { width: 16, height: 16, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: make(32) });
  img.setTemplateImage(true);
  return img;
}

function buildTrayMenu() {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: 'Show / Hide', accelerator: HOTKEY, click: () => toggle('tray') },
    { label: 'Reload', click: () => pageView.webContents.reload() },
    { type: 'separator' },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: login,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    { label: 'Quit Claude Float', accelerator: 'Cmd+Q', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Claude Float');
  tray.setContextMenu(buildTrayMenu());
}

function createAppMenu() {
  // No Dock/menu bar presence, but these keep Cmd+C/V/Z/A/R/Q working.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Claude Float',
        submenu: [
          { label: 'Reload', accelerator: 'Cmd+R', click: () => pageView.webContents.reload() },
          {
            label: 'Toggle DevTools',
            accelerator: 'Alt+Cmd+I',
            click: () => pageView.webContents.toggleDevTools(),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
    ])
  );
}

// ---------- launcher hotkey via AeroSpace ----------
// ~/.aerospace.toml:
//   alt-space = 'exec-and-forget pkill -USR2 -x "Claude Float" || open -g -a "Claude Float"'
// Running → SIGUSR2 toggles us. Not running → launched in the background.
// (SIGUSR1 is reserved by Node for the inspector.)
function aerospaceOwnsHotkey() {
  try {
    const cfg = fs.readFileSync(path.join(app.getPath('home'), '.aerospace.toml'), 'utf8');
    return /^\s*alt-space\s*=.*pkill -USR2 -x "Claude Float"/m.test(cfg);
  } catch {
    return false;
  }
}
process.on('SIGUSR2', () => win && toggle('signal'));

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && show());

  app.whenReady().then(() => {
    if (app.dock) app.dock.hide();
    createAppMenu();
    createWindow();
    createTray();
    followWorkspaces();
    // If AeroSpace owns Option+Space (so the key can also launch the app
    // after a quit), it toggles us with SIGUSR2; don't register it twice.
    if (aerospaceOwnsHotkey()) {
      trace('hotkey:aerospace');
    } else if (!globalShortcut.register(HOTKEY, () => toggle('hotkey'))) {
      trace('hotkey:register-failed');
      console.error(`Could not register ${HOTKEY}; is another app holding it?`);
    }
    // Launched by the user (not at login) → show immediately.
    if (!app.getLoginItemSettings().wasOpenedAtLogin) show();
  });

  // `open -a "Claude Float"` on a running instance lands here.
  app.on('activate', () => win && show());
  app.on('before-quit', () => {
    app.isQuitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', (e) => e.preventDefault());
}
