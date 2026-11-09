'use strict';

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
} = require('electron');

const WHATSAPP_URL = 'https://web.whatsapp.com/';
const APP_ID = 'io.portapps.whatsapp-portable';
const ICON_PATH = path.join(__dirname, 'icon.ico');

// Keep all data inside the portable folder, even when WhatsApp.exe is started directly
// instead of through whatsapp-portable.exe.
if (app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.resolve(app.commandLine.getSwitchValue('user-data-dir')));
} else if (app.isPackaged) {
  app.setPath('userData', path.resolve(path.dirname(process.execPath), '..', 'data'));
}
app.setPath('crashDumps', path.join(app.getPath('userData'), 'Crashpad'));
app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const startMinimized = process.argv.includes('--start-minimized');
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let unreadCount = 0;
let reloadTimer = null;

function chromeUserAgent() {
  // WhatsApp Web refuses or degrades unknown browsers, so present a plain Chrome UA.
  const major = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function isWhatsAppUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'whatsapp.com' || hostname.endsWith('.whatsapp.com'));
  } catch {
    return false;
  }
}

function isExternalUrl(url) {
  try {
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function backgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#111b21' : '#f0f2f5';
}

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      state.x < a.x + a.width && state.x + state.width > a.x &&
      state.y < a.y + a.height && state.y + state.height > a.y);
    if (!visible) {
      delete state.x;
      delete state.y;
    }
    return state;
  } catch {
    return { width: 1200, height: 800 };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    const bounds = mainWindow.getNormalBounds();
    fs.writeFileSync(stateFile, JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }));
  } catch {
    // Not critical (e.g. read-only media).
  }
}

function showWindow() {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function badgeImage() {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - center, y - center);
      const alpha = Math.max(0, Math.min(1, size / 2 - d)) * 255;
      const i = (y * size + x) * 4;
      // BGRA, premultiplied
      buffer[i] = Math.round(0x55 * alpha / 255);
      buffer[i + 1] = Math.round(0xd3 * alpha / 255);
      buffer[i + 2] = Math.round(0x25 * alpha / 255);
      buffer[i + 3] = Math.round(alpha);
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function updateUnread(title) {
  const match = /^\((\d+)\)/.exec(title || '');
  const count = match ? parseInt(match[1], 10) : 0;
  if (count === unreadCount) {
    return;
  }
  unreadCount = count;
  if (tray) {
    tray.setToolTip(count > 0 ? `WhatsApp (${count} unread)` : 'WhatsApp');
  }
  if (mainWindow) {
    mainWindow.setOverlayIcon(count > 0 ? badgeImage() : null, count > 0 ? `${count} unread` : '');
    if (count > 0 && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
    }
  }
}

async function clearCacheAndReload() {
  // Keeps the login (IndexedDB / Local Storage) but drops caches that can break rendering.
  const ses = session.defaultSession;
  await ses.clearCache();
  await ses.clearStorageData({ storages: ['cachestorage', 'serviceworkers', 'shadercache'] });
  mainWindow.webContents.reloadIgnoringCache();
}

function scheduleReload(delay) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(WHATSAPP_URL);
    }
  }, delay);
}

function buildMenu() {
  const template = [
    {
      label: '&WhatsApp',
      submenu: [
        { label: 'Reload', accelerator: 'F5', click: () => mainWindow.webContents.reload() },
        { label: 'Force reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow.webContents.reloadIgnoringCache() },
        { label: 'Clear cache and reload', click: () => clearCacheAndReload() },
        { type: 'separator' },
        { label: 'Hide to tray', accelerator: 'CmdOrCtrl+W', click: () => mainWindow.hide() },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=', visible: false },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH));
  tray.setToolTip('WhatsApp');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show WhatsApp', click: showWindow },
    { label: 'Reload', click: () => mainWindow.webContents.reload() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleWindow);
}

function attachContextMenu(contents) {
  contents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      }
      items.push({
        label: 'Add to dictionary',
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: 'separator' });
    }
    if (params.linkURL && isExternalUrl(params.linkURL)) {
      items.push({ label: 'Open link in browser', click: () => shell.openExternal(params.linkURL) });
      items.push({ label: 'Copy link', click: () => require('electron').clipboard.writeText(params.linkURL) });
      items.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      items.push({ label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: params.editFlags.canCut });
      items.push({ role: 'copy', enabled: params.editFlags.canCopy });
      items.push({ role: 'paste', enabled: params.editFlags.canPaste });
      items.push({ role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    while (items.length && items[items.length - 1].type === 'separator') {
      items.pop();
    }
    if (items.length) {
      Menu.buildFromTemplate(items).popup({ window: mainWindow });
    }
  });
}

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width || 1200,
    height: state.height || 800,
    minWidth: 400,
    minHeight: 500,
    title: 'WhatsApp',
    icon: ICON_PATH,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColor(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  if (state.maximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', () => {
    if (!startMinimized) {
      showWindow();
    }
  });

  mainWindow.on('close', (event) => {
    saveWindowState();
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  mainWindow.on('page-title-updated', (event, title) => {
    event.preventDefault();
    mainWindow.setTitle('WhatsApp');
    updateUnread(title);
  });

  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isWhatsAppUrl(url)) {
      event.preventDefault();
      if (isExternalUrl(url)) {
        shell.openExternal(url);
      }
    }
  });
  contents.on('did-fail-load', (_event, errorCode, _desc, _url, isMainFrame) => {
    // -3 = ERR_ABORTED (navigation replaced), not a real failure.
    if (isMainFrame && errorCode !== -3) {
      scheduleReload(5000);
    }
  });
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      scheduleReload(1000);
    }
  });
  attachContextMenu(contents);

  mainWindow.loadURL(WHATSAPP_URL);
}

app.on('second-instance', () => showWindow());

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowState();
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.whenReady().then(() => {
  const ses = session.defaultSession;
  const userAgent = chromeUserAgent();
  ses.setUserAgent(userAgent);
  app.userAgentFallback = userAgent;

  const allowed = new Set(['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowed.has(permission) && isWhatsAppUrl(contents.getURL()));
  });
  ses.setPermissionCheckHandler((_contents, permission, origin) =>
    allowed.has(permission) && isWhatsAppUrl(origin));

  nativeTheme.on('updated', () => {
    if (mainWindow) {
      mainWindow.setBackgroundColor(backgroundColor());
    }
  });

  buildMenu();
  buildTray();
  createWindow();
});

app.on('window-all-closed', () => {
  // Stay alive in the tray; quitting is explicit.
});
