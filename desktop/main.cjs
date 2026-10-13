// Gungnir for Mac: a window onto your hosted Gungnir server. It remembers the server's address,
// keeps you signed in, lets the platforms' sign-in pages open in the window (so connecting an
// account works), sends every other link to the default browser, and shows how many posts
// failed to publish on the Dock icon, with a notification when a new one fails.
const { app, BrowserWindow, Menu, Notification, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Gungnir';
const PARTITION = 'persist:gungnir';
const CONNECT_PAGE = path.join(__dirname, 'connect.html');
// How often to check for failed posts. Tests shorten it.
const POLL_MS = Number(process.env.GUNGNIR_POLL_MS) || 60_000;
const isSafeExternal = (url) => /^(https?:|mailto:)/i.test(url);
// The platforms' sign-in pages, which must open inside the window to connect an account.
const SIGN_IN_HOSTS = ['facebook.com', 'fb.com', 'instagram.com', 'meta.com', 'google.com', 'youtube.com', 'tiktok.com', 'tiktokv.com'];

app.setName(APP_NAME);
// Lets tests (and power users) point the app at a different data folder.
if (process.env.GUNGNIR_USER_DATA) app.setPath('userData', process.env.GUNGNIR_USER_DATA);
// Present as plain Chrome: some sign-in pages refuse browsers they don't recognise.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|Gungnir|gungnir-desktop)\/\S+/gi, '');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

/** The saved server address (an origin like https://gungnir.onrender.com), or ''. */
const serverUrl = () => readSettings().serverUrl || '';

/** Turns what was typed ("gungnir.onrender.com/") into an origin, or throws. */
function normalizeServer(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Enter your Gungnir address.');
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That isn’t a web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address must start with https://');
  return url.origin;
}

/** Checks the address really is a Gungnir server before saving it. */
async function checkServer(origin) {
  let res;
  try {
    res = await session.fromPartition(PARTITION).fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  } catch {
    throw new Error(`Couldn’t reach ${origin}. Check the address and your internet connection.`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.needsSetup !== 'boolean' || typeof body?.providers !== 'object') {
    throw new Error(`${origin} doesn’t look like a Gungnir server.`);
  }
}

const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** Pages the window may show: the server itself and the platforms' sign-in pages. */
function mayOpenInWindow(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const server = serverUrl();
  if (server && parsed.origin === server) return true;
  return parsed.protocol === 'https:' && SIGN_IN_HOSTS.some((d) => hostMatches(parsed.hostname, d));
}

let win = null;

function showConnectPage(params = {}) {
  const query = { server: serverUrl(), ...params };
  void win.loadFile(CONNECT_PAGE, { query });
}

function openServer() {
  const server = serverUrl();
  if (!server) return showConnectPage();
  void win.loadURL(server);
}

function setTitle(failed) {
  if (!win) return;
  win.setTitle(failed ? `${APP_NAME} (${failed} failed)` : APP_NAME);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = win.webContents;

  // New windows (a published post, a platform's terms) open in the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (event, url) => {
    if (url.startsWith('file://') || mayOpenInWindow(url)) return;
    event.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);

  // The server is down, asleep or unreachable: say so, with Try again.
  contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted by a newer navigation */ || url.startsWith('file://')) return;
    showConnectPage({ error: `Couldn’t open ${new URL(url).host} (${description}). Check your internet connection, then try again.`, retry: '1' });
  });
  contents.on('did-navigate', (_e, url, httpCode) => {
    if (httpCode >= 500 && serverUrl() && url.startsWith(serverUrl())) {
      showConnectPage({ error: `${serverUrl()} isn’t responding right now (error ${httpCode}). It may be restarting; try again in a minute.`, retry: '1' });
    }
  });
  // The window title shows the failed count instead of the page's title.
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    setTitle(lastFailed.size);
  });
  win.on('closed', () => {
    win = null;
  });

  win.once('ready-to-show', () => win.show());
  openServer();
}

// ---- failed posts: Dock badge, window title and notifications ------------------------------

/** Failed target ids from the last check, so only new failures notify. */
let lastFailed = new Set();
let checkedOnce = false;

async function checkFailures() {
  const server = serverUrl();
  if (!server) return;
  let posts;
  try {
    const res = await session.fromPartition(PARTITION).fetch(`${server}/api/posts`, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return; // signed out or the server is busy; try next time
    posts = await res.json();
  } catch {
    return;
  }
  if (!Array.isArray(posts)) return;
  const failed = new Map();
  for (const post of posts) for (const t of post.targets ?? []) if (t.status === 'failed') failed.set(t.id, post);
  if (checkedOnce && Notification.isSupported()) {
    // One notification per post, however many of its accounts failed.
    const newPosts = new Map();
    for (const [id, post] of failed) if (!lastFailed.has(id)) newPosts.set(post.id, post);
    for (const post of newPosts.values()) notifyFailure(server, post);
  }
  checkedOnce = true;
  lastFailed = new Set(failed.keys());
  app.setBadgeCount(failed.size);
  setTitle(failed.size);
}

function notifyFailure(server, post) {
  const caption = String(post.caption ?? '').split('\n')[0].trim();
  const note = new Notification({
    title: 'A post failed to publish',
    body: caption ? (caption.length > 80 ? `${caption.slice(0, 79)}…` : caption) : 'Open it to see what went wrong.',
  });
  note.on('click', () => {
    if (!win) createWindow();
    win.show();
    win.focus();
    void win.loadURL(`${server}/#/posts/${encodeURIComponent(post.id)}`);
  });
  note.show();
}

// ---- connect page bridge (see preload.cjs) -------------------------------------------------

function registerIpc() {
  // Only the local connect page may change the server, never a web page.
  const fromConnectPage = (event) => event.senderFrame?.url.startsWith('file://');
  ipcMain.handle('server:get', (event) => (fromConnectPage(event) ? serverUrl() : ''));
  ipcMain.handle('server:set', async (event, input) => {
    if (!fromConnectPage(event)) throw new Error('Not allowed');
    try {
      const origin = normalizeServer(input);
      await checkServer(origin);
      if (origin !== serverUrl()) {
        writeSettings({ ...readSettings(), serverUrl: origin });
        lastFailed = new Set();
        checkedOnce = false;
        app.setBadgeCount(0);
        setTitle(0);
      }
      openServer();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('server:retry', (event) => {
    if (fromConnectPage(event)) openServer();
  });
}

function buildMenu() {
  const current = () => win?.webContents.getURL() ?? '';
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Change Server…', click: () => win && showConnectPage() },
        {
          label: 'Open in Browser',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            const url = current().startsWith('http') ? current() : serverUrl();
            if (url) void shell.openExternal(url);
          },
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => win?.webContents.navigationHistory.canGoBack() && win.webContents.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => win?.webContents.navigationHistory.canGoForward() && win.webContents.navigationHistory.goForward() },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    registerIpc();
    buildMenu();
    createWindow();
    void checkFailures();
    setInterval(() => void checkFailures(), POLL_MS);
    app.on('activate', () => {
      if (!win) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    // On a Mac the app keeps running in the Dock, so the badge stays current.
    if (process.platform !== 'darwin') app.quit();
  });
}
