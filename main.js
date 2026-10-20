// main.js — Veliance: invisible, hotkey-driven AI overlay
const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer,
  session, systemPreferences, Tray, Menu, nativeImage, shell, net
} = require('electron');
const path = require('path');
const store = require('./store');
const ai = require('./ai');

const IS_MAC = process.platform === 'darwin';
const DEV = process.argv.includes('--dev');

const WIN_W = 640;          // default overlay width/height
const WIN_H = 640;
const WIN_MIN = 420;        // smallest the overlay shrinks to
const WIN_MAX = 1100;       // largest it grows to
const SIZE_STEP = 60;       // px added/removed per Grow/Shrink keypress
const MOVE_STEP = 40;

// Where published builds live, for the in-app updater
const REPO = 'aomine97/veliance';

function clampSize(n) { return Math.max(WIN_MIN, Math.min(WIN_MAX, Math.round(n))); }

let win = null;
let tray = null;
let visible = true;
let currentAbort = null;

// Single instance — a second launch just reveals the existing overlay
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showOverlay());
}

// Keep the app out of the Dock on macOS (LSUIElement-style agent app)
if (IS_MAC) app.dock?.hide();


function startPosition() {
  const saved = store.get('position');
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.workArea;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // make sure it's still on some display
    const onScreen = screen.getAllDisplays().some(d =>
      saved.x >= d.bounds.x - WIN_W + 80 && saved.x <= d.bounds.x + d.bounds.width - 80 &&
      saved.y >= d.bounds.y - 20 && saved.y <= d.bounds.y + d.bounds.height - 60);
    if (onScreen) return saved;
  }
  return { x: Math.round(x + (width - WIN_W) / 2), y: y + 8 };
}

function startSize() {
  const saved = store.get('size');
  if (saved && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
    return { w: clampSize(saved.w), h: clampSize(saved.h) };
  }
  return { w: WIN_W, h: WIN_H };
}

function createWindow() {
  const pos = startPosition();
  const size = startSize();

  win = new BrowserWindow({
    width: size.w,
    height: size.h,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    // NSPanel on macOS: floats above full-screen apps and doesn't steal Space focus
    ...(IS_MAC ? { type: 'panel' } : {}),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  // ---- Invisibility ----------------------------------------------------
  applyInvisibility(win);
  // Let clicks fall through the transparent parts; renderer flips this when hovering UI.
  // Kept out of applyInvisibility() so re-asserts don't clobber the renderer's hover state.
  win.setIgnoreMouseEvents(true, { forward: true });

  // ---- Navigation lockdown --------------------------------------------
  // The overlay only ever shows its local renderer. Block any attempt to
  // navigate elsewhere or spawn a new window (a new window would not inherit
  // content protection, so it could leak into screen capture). External links
  // are routed through the vetted https-only window:openExternal handler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    applyInvisibility(win);   // macOS can drop these the first time a panel is shown
    win.setOpacity(Number(store.get('opacity')) || 1);
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Re-assert every time the panel is shown again (across Spaces / after hide)
  win.on('show', () => applyInvisibility(win));

  win.on('closed', () => { win = null; });

  // Re-apply if macOS ever drops the flags after a display change
  screen.on('display-metrics-changed', () => applyInvisibility(win));
}

// Re-assert the OS-level invisibility flags. macOS occasionally drops these on
// `panel`-type windows when they move across Spaces, re-show, or the display
// layout changes, so this runs at creation and on every show / display change.
function applyInvisibility(w) {
  if (!w || w.isDestroyed()) return;
  // Exclude from screen capture:
  //   macOS  -> NSWindowSharingNone   (Zoom, Meet, Teams, QuickTime, screenshots)
  //   Windows-> WDA_EXCLUDEFROMCAPTURE
  w.setContentProtection(true);
  // Above everything, incl. other always-on-top windows (NSWindow maximumWindowLevel)
  w.setAlwaysOnTop(true, 'screen-saver', 1);
  // Float across all Spaces and over full-screen apps (canJoinAllSpaces | fullScreenAuxiliary)
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (IS_MAC && typeof w.setHiddenInMissionControl === 'function') w.setHiddenInMissionControl(true);
  if (IS_MAC && typeof w.setWindowButtonVisibility === 'function') w.setWindowButtonVisibility(false);
}

// ---- Show / hide ---------------------------------------------------------
function hideOverlay() {
  if (!win) return;
  visible = false;
  win.webContents.send('overlay:visibility', false);
  setTimeout(() => { if (win && !visible) win.hide(); }, 120);
}
function showOverlay() {
  if (!win) return;
  visible = true;
  win.show();
  win.webContents.send('overlay:visibility', true);
}
function toggleOverlay() { visible ? hideOverlay() : showOverlay(); }

function moveBy(dx, dy) {
  if (!win) return;
  const [x, y] = win.getPosition();
  const nx = x + dx, ny = y + dy;
  win.setPosition(nx, ny, true);
  store.set({ position: { x: nx, y: ny } });
}

// Grow / shrink the overlay by a fixed step, clamped, keeping it centered on
// its current spot. Size persists between launches (store.size).
function resizeBy(delta) {
  if (!win) return;
  const b = win.getBounds();
  const w = clampSize(b.width + delta);
  const h = clampSize(b.height + delta);
  if (w === b.width && h === b.height) return;   // already at the limit
  const x = Math.round(b.x + (b.width - w) / 2);
  const y = Math.round(b.y + (b.height - h) / 2);
  win.setBounds({ x, y, width: w, height: h }, true);
  store.set({ size: { w, h }, position: { x, y } });
  applyInvisibility(win);   // macOS can drop the capture-protection flags on a resize
}

function sendHotkey(name) {
  if (!win) return;
  if (!visible) showOverlay();
  if (name === 'ask') win.focus();
  win.webContents.send('hotkey', name);
}

// ---- Global shortcuts (user-configurable) --------------------------------
const ACTIONS = [
  { id: 'toggle',     accel: 'CommandOrControl+\\',          label: 'Show / hide overlay',            run: () => toggleOverlay() },
  { id: 'ask',        accel: 'CommandOrControl+Enter',       label: 'Ask / answer transcript',        run: () => sendHotkey('ask') },
  { id: 'screenshot', accel: 'CommandOrControl+Shift+S',     label: 'Screenshot & answer',            run: () => sendHotkey('screenshot') },
  { id: 'listen',     accel: 'CommandOrControl+Shift+L',     label: 'Start / stop Listen',            run: () => sendHotkey('listen') },
  { id: 'clear',      accel: 'CommandOrControl+Shift+C',     label: 'Clear conversation',             run: () => sendHotkey('clear') },
  { id: 'moveUp',     accel: 'CommandOrControl+Shift+Up',    label: 'Move overlay up',                run: () => moveBy(0, -MOVE_STEP) },
  { id: 'moveDown',   accel: 'CommandOrControl+Shift+Down',  label: 'Move overlay down',              run: () => moveBy(0, MOVE_STEP) },
  { id: 'moveLeft',   accel: 'CommandOrControl+Shift+Left',  label: 'Move overlay left',              run: () => moveBy(-MOVE_STEP, 0) },
  { id: 'moveRight',  accel: 'CommandOrControl+Shift+Right', label: 'Move overlay right',             run: () => moveBy(MOVE_STEP, 0) },
  { id: 'grow',       accel: 'CommandOrControl+=',           label: 'Grow overlay',                   run: () => resizeBy(SIZE_STEP) },
  { id: 'shrink',     accel: 'CommandOrControl+-',           label: 'Shrink overlay',                 run: () => resizeBy(-SIZE_STEP) },
  { id: 'quit',       accel: 'CommandOrControl+Shift+Q',     label: 'Quit Veliance',                  run: () => app.quit() }
];
let shortcutStatus = {};   // id -> 'ok' | 'failed' | 'off'

function accelFor(a) {
  const o = store.get('hotkeys') || {};
  return Object.prototype.hasOwnProperty.call(o, a.id) ? o[a.id] : a.accel;
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  shortcutStatus = {};
  for (const a of ACTIONS) {
    const accel = accelFor(a);
    if (!accel) { shortcutStatus[a.id] = 'off'; continue; }
    try {
      shortcutStatus[a.id] = globalShortcut.register(accel, a.run) ? 'ok' : 'failed';
    } catch { shortcutStatus[a.id] = 'failed'; }
  }
  const failed = ACTIONS.filter(a => shortcutStatus[a.id] === 'failed').map(a => `${a.id} (${accelFor(a)})`);
  if (failed.length) console.warn('[veliance] could not register shortcuts:', failed.join(', '));
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function hotkeyList() {
  return ACTIONS.map(a => ({
    id: a.id, label: a.label, accel: accelFor(a), default: a.accel,
    status: shortcutStatus[a.id] || 'off',
    custom: accelFor(a) !== a.accel
  }));
}

// Returns null if valid, else an error string
function validateAccel(accel) {
  if (accel === '' || accel === null) return null;  // disabled
  if (typeof accel !== 'string' || accel.length > 60) return 'bad accelerator';
  const parts = accel.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const okMods = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'];
  if (!mods.every(m => okMods.includes(m))) return 'unknown modifier';
  if (!key) return 'no key';
  if (!mods.length && !/^F\d{1,2}$/.test(key)) return 'needs a modifier (⌘, ⌥, ⌃ or ⇧)';
  return null;
}

function setHotkey(id, accel) {
  const a = ACTIONS.find(x => x.id === id);
  if (!a) throw new Error('unknown action');
  const err = validateAccel(accel);
  if (err) throw new Error(err);
  const hot = { ...(store.get('hotkeys') || {}) };
  if (accel === a.accel) delete hot[id]; else hot[id] = accel;
  // one combo per action
  if (accel) for (const other of ACTIONS) if (other.id !== id && accelFor(other) === accel) hot[other.id] = '';
  store.set({ hotkeys: hot });
  registerShortcuts();
  return hotkeyList();
}

// ---- Tray (the only visible trace of the app) ----------------------------
function buildTrayMenu() {
  const acc = id => accelFor(ACTIONS.find(a => a.id === id)) || undefined;
  return Menu.buildFromTemplate([
    { label: 'Show / Hide Overlay', accelerator: acc('toggle'), click: toggleOverlay },
    { label: 'Reset Position', click: () => { store.set({ position: null }); const p = startPosition(); win?.setPosition(p.x, p.y, true); } },
    { label: 'Reset Size', click: () => { store.set({ size: null }); win?.setSize(WIN_W, WIN_H, true); if (win) applyInvisibility(win); } },
    { type: 'separator' },
    { label: 'Check for Updates…', click: async () => {
      const info = await checkForUpdate();
      if (info.hasUpdate) shell.openExternal(info.url);
      else shell.openExternal(`https://github.com/${REPO}/releases/latest`);
    } },
    { type: 'separator' },
    { label: 'Screen Recording permission…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'), visible: IS_MAC },
    { label: 'Microphone permission…', click: () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'), visible: IS_MAC },
    { type: 'separator' },
    { label: 'Quit Veliance', accelerator: acc('quit'), click: () => app.quit() }
  ]);
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Veliance');
    tray.setContextMenu(buildTrayMenu());
  } catch (e) {
    console.warn('[veliance] tray unavailable:', e.message);
  }
}

// ---- Screenshot ----------------------------------------------------------
async function captureScreen() {
  if (IS_MAC) {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      // Triggers the system prompt on first use; user must approve then relaunch
      const err = new Error('Screen Recording permission needed. Enable Veliance (or Electron) under System Settings → Privacy & Security → Screen Recording, then relaunch.');
      err.code = 'NO_SCREEN_PERMISSION';
      // still attempt: on first launch this is what makes macOS show the dialog
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
      throw err;
    }
  }

  const bounds = win ? win.getBounds() : screen.getPrimaryDisplay().bounds;
  const display = screen.getDisplayMatching(bounds);
  const scale = display.scaleFactor || 1;
  const maxW = 1600;
  const targetW = Math.min(display.size.width * scale, maxW);
  const targetH = Math.round(targetW * (display.size.height / display.size.width));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: targetW, height: targetH }
  });
  if (!sources.length) throw new Error('No screen sources found.');

  const match = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
  const img = match.thumbnail;
  if (img.isEmpty()) throw new Error('Screen capture returned an empty image (permission?).');
  return img.toPNG().toString('base64');
}

// ---- Updates -------------------------------------------------------------
// Veliance ships as an ad-hoc-signed DMG (no Apple Developer ID), so Squirrel
// auto-install isn't available. Instead we check GitHub Releases for a newer
// version and hand the user the right DMG to drag over — same flow as a fresh
// install, one click from Settings. Builds are published by the release
// workflow (.github/workflows/release.yml) on every `v*` tag.
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, headers: { 'User-Agent': 'Veliance-Updater', 'Accept': 'application/vnd.github+json' } });
    let body = '';
    req.on('response', res => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.on('data', () => {});
        res.on('end', () => reject(new Error('GitHub returned HTTP ' + res.statusCode)));
        return;
      }
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// >0 when a is newer than b. Tolerates a leading "v" and missing segments.
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function checkForUpdate() {
  const current = app.getVersion();
  const fallback = `https://github.com/${REPO}/releases/latest`;
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const latest = (rel.tag_name || '').replace(/^v/i, '');
    if (!latest) return { current, latest: null, hasUpdate: false, url: fallback };
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const asset = assets.find(a => a.name && a.name.includes(arch) && a.name.endsWith('.dmg'))
               || assets.find(a => a.name && a.name.endsWith('.dmg'));
    return {
      current,
      latest,
      hasUpdate: compareVersions(latest, current) > 0,
      url: (asset && asset.browser_download_url) || rel.html_url || fallback,
      notes: rel.name || rel.tag_name || ''
    };
  } catch (e) {
    return { current, latest: null, hasUpdate: false, error: e.message, url: fallback };
  }
}

// ---- IPC -----------------------------------------------------------------
function wireIpc() {
  ipcMain.handle('settings:get', () => store.publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = ['provider', 'anthropicModel', 'openaiModel', 'transcribeModel', 'systemPrompt', 'opacity', 'audioSource', 'listenChunkSeconds'];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    store.set(clean);
    if ('opacity' in clean && win) win.setOpacity(Number(clean.opacity) || 1);
    return store.publicSettings();
  });
  ipcMain.handle('settings:setKey', (_e, { name, value }) => {
    if (!['anthropic', 'openai'].includes(name)) throw new Error('bad key name');
    store.setKey(name, (value || '').trim());
    return store.publicSettings();
  });
  ipcMain.handle('models:list', () => ai.listModels());
  ipcMain.handle('settings:test', async (_e, provider) => {
    await ai.testKey(provider);
    return true;
  });

  ipcMain.handle('chat:send', async (e, { id, messages }) => {
    if (currentAbort) currentAbort.abort();
    const ctrl = new AbortController();
    currentAbort = ctrl;
    const wc = e.sender;
    try {
      const full = await ai.stream({
        messages,
        signal: ctrl.signal,
        onDelta: d => { if (!wc.isDestroyed()) wc.send('chat:delta', { id, delta: d }); }
      });
      if (!wc.isDestroyed()) wc.send('chat:done', { id, text: full });
      return full;
    } catch (err) {
      if (err.name === 'AbortError') { if (!wc.isDestroyed()) wc.send('chat:done', { id, text: null, aborted: true }); return null; }
      if (!wc.isDestroyed()) wc.send('chat:error', { id, message: err.message, code: err.code });
      return null;
    } finally {
      if (currentAbort === ctrl) currentAbort = null;
    }
  });
  ipcMain.handle('chat:abort', () => { currentAbort?.abort(); return true; });

  ipcMain.handle('screenshot:capture', () => captureScreen());

  ipcMain.handle('audio:transcribe', async (_e, { buffer, mime }) => {
    return ai.transcribe(Buffer.from(buffer), mime);
  });

  ipcMain.handle('window:setIgnoreMouse', (_e, ignore) => {
    if (!win) return;
    win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });
  ipcMain.handle('window:hide', () => hideOverlay());
  ipcMain.handle('window:quit', () => app.quit());
  ipcMain.handle('window:openExternal', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('window:dragBy', (_e, { dx, dy }) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    win.setPosition(Math.round(x + dx), Math.round(y + dy), false);
  });
  ipcMain.handle('window:dragEnd', () => {
    if (!win) return;
    const [x, y] = win.getPosition();
    store.set({ position: { x, y } });
  });
  ipcMain.handle('hotkeys:list', () => hotkeyList());
  ipcMain.handle('hotkeys:set', (_e, { id, accel }) => setHotkey(id, accel));
  ipcMain.handle('hotkeys:reset', () => { store.set({ hotkeys: {} }); registerShortcuts(); return hotkeyList(); });
  // while the user is recording a new combo, nothing global should fire
  ipcMain.handle('hotkeys:suspend', () => { globalShortcut.unregisterAll(); return true; });
  ipcMain.handle('hotkeys:resume', () => { registerShortcuts(); return hotkeyList(); });
  ipcMain.handle('perm:status', () => ({
    screen: IS_MAC ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
    mic: IS_MAC ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'
  }));
  ipcMain.handle('perm:askMic', async () => {
    if (!IS_MAC) return true;
    return systemPreferences.askForMediaAccess('microphone');
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:open', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

// ---- Media (Listen mode) -------------------------------------------------
function wireMedia() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'audioCapture'].includes(permission));
  });
  // getDisplayMedia -> hand back the screen the overlay is on, with system audio loopback
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      const bounds = win ? win.getBounds() : screen.getPrimaryDisplay().bounds;
      const display = screen.getDisplayMatching(bounds);
      const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
      cb({ video: src, audio: 'loopback' });
    } catch (e) {
      console.warn('[veliance] display media failed:', e.message);
      cb({});
    }
  }, { useSystemPicker: false });
}

// ---- Lifecycle -----------------------------------------------------------
app.whenReady().then(() => {
  wireMedia();
  wireIpc();
  createWindow();
  registerShortcuts();
  createTray();

  app.on('activate', () => { if (!win) createWindow(); else showOverlay(); });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* stay alive in the tray */ });
