const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PET_SIZE = 128;
const HOME_MARGIN_X = 20;
const HOME_MARGIN_BOTTOM = 60;
// Claude Code hooks (hooks/clawd-hook.js) POST activity events here.
const EVENT_PORT = Number(process.env.CLAWD_PORT) || 47321;
const CONTROL_FLAGS = ['--show', '--hide', '--quit', '--startup-on', '--startup-off'];

let win;
let tray;
let config = { autoStart: true, x: null, y: null };
let status = { state: 'idle', label: 'santai' };
let saveTimer = null;

app.commandLine.appendSwitch('disable-background-timer-throttling');

// --- persisted settings (position, auto-start) ------------------------------

function configPath() {
  return path.join(app.getPath('userData'), 'clawd-config.json');
}

function loadConfig() {
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(configPath(), 'utf8')));
  } catch {
    // first run or unreadable file: keep defaults
  }
}

function writeConfigNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('[clawd] cannot save config:', err.message);
  }
}

function saveConfigSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfigNow, 1000);
}

// --- window -----------------------------------------------------------------

function homePosition() {
  const { x, y, height } = screen.getPrimaryDisplay().workArea;
  return { x: x + HOME_MARGIN_X, y: y + height - PET_SIZE - HOME_MARGIN_BOTTOM };
}

function isOnScreen(x, y) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    x >= a.x && y >= a.y && x + PET_SIZE <= a.x + a.width && y + PET_SIZE <= a.y + a.height);
}

function startPosition() {
  if (Number.isFinite(config.x) && Number.isFinite(config.y) && isOnScreen(config.x, config.y)) {
    return { x: config.x, y: config.y };
  }
  return homePosition();
}

function ensureOnScreen() {
  if (!win) return;
  const [x, y] = win.getPosition();
  if (isOnScreen(x, y)) return;
  // setPosition grows the window a few pixels per call under fractional DPI
  // scaling (e.g. 150%); setBounds with an explicit size keeps it fixed.
  win.setBounds({ ...homePosition(), width: PET_SIZE, height: PET_SIZE });
}

function createWindow({ hidden }) {
  win = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    ...startPosition(),
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (!hidden) win.showInactive();
  });

  // The pet is draggable (CSS app-region); remember where the user put it.
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    config.x = x;
    config.y = y;
    saveConfigSoon();
  });

  // Keep the pet alive if the renderer ever crashes.
  win.webContents.on('render-process-gone', () => {
    if (win && !win.isDestroyed()) win.reload();
  });

  win.on('closed', () => {
    win = null;
  });
}

function showPet() {
  if (!win) return;
  win.showInactive();
  win.moveTop();
}

function hidePet() {
  if (win) win.hide();
}

// --- tray & auto-start -------------------------------------------------------

function applyLoginItem() {
  // In dev (`npm start`) execPath is the bare electron.exe without the project
  // path, so registering it would launch the default Electron app at login.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: config.autoStart, name: 'ClaudePet' });
  }
}

function setAutoStart(on) {
  config.autoStart = on;
  writeConfigNow();
  applyLoginItem();
  if (tray) buildTrayMenu();
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: showPet },
    { label: 'Hide', click: hidePet },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: config.autoStart,
      enabled: app.isPackaged,
      click: (item) => setAutoStart(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.ico');
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Claude Pet');
  buildTrayMenu();
}

// --- Claude Code events (localhost only) --------------------------------------

const shortString = (v) => (typeof v === 'string' ? v.slice(0, 64) : undefined);

function startEventServer() {
  const server = http.createServer((req, res) => {
    // Browsers attach Origin to cross-site requests; hook scripts and curl don't.
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...status, visible: Boolean(win && win.isVisible()), autoStart: config.autoStart }));
      return;
    }
    const isJson = String(req.headers['content-type'] || '').startsWith('application/json');
    if (req.method !== 'POST' || req.url !== '/event' || !isJson) {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on('end', () => {
      let ev;
      try {
        ev = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!ev || typeof ev.event !== 'string') {
        res.writeHead(400).end();
        return;
      }
      if (win) {
        win.webContents.send('claude-event', {
          event: shortString(ev.event),
          tool: shortString(ev.tool),
          kind: shortString(ev.kind),
          notification: shortString(ev.notification),
        });
      }
      res.writeHead(204).end();
    });
  });

  server.on('error', (err) => console.error('[clawd] event server:', err.message));
  server.listen(EVENT_PORT, '127.0.0.1');
}

ipcMain.on('pet-status', (_event, s) => {
  status = { state: shortString(s && s.state), label: shortString(s && s.label) };
  if (tray) tray.setToolTip(`Claude Pet — ${status.label || status.state}`);
});

// --- command-line control (clawd.cmd: ClaudePet.exe --hide, --quit, ...) -------

function parseFlags(argv) {
  return new Set(argv.filter((a) => CONTROL_FLAGS.includes(a)));
}

function applyFlags(flags) {
  if (flags.has('--quit')) {
    app.quit();
    return;
  }
  if (flags.has('--startup-on')) setAutoStart(true);
  if (flags.has('--startup-off')) setAutoStart(false);
  if (flags.has('--hide')) hidePet();
  else if (flags.has('--show') || flags.size === 0) showPet();
}

const startFlags = parseFlags(process.argv);

// Only one pet at a time: a second launch forwards its flags and exits.
if (!app.requestSingleInstanceLock() || startFlags.has('--quit')) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => applyFlags(parseFlags(argv)));

  app.whenReady().then(() => {
    loadConfig();
    applyFlags(startFlags);

    // `clawd startup on|off` while the pet isn't running: just save and exit.
    const settingsOnly = startFlags.size > 0 && [...startFlags].every((f) => f.startsWith('--startup-'));
    if (settingsOnly) {
      app.quit();
      return;
    }

    createWindow({ hidden: startFlags.has('--hide') });
    createTray();
    startEventServer();
    applyLoginItem();

    screen.on('display-removed', ensureOnScreen);
    screen.on('display-metrics-changed', ensureOnScreen);
  });
}

app.on('before-quit', () => {
  if (saveTimer) writeConfigNow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
