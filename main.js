const { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell, dialog, clipboard, nativeTheme, Notification } = require('electron');
const path = require('path'), fs = require('fs');
const { pathToFileURL } = require('url');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, installExtension, uninstallExtension } = require('electron-chrome-web-store');

// Look like normal Chrome to websites
const OS_UA = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
  : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
const UA = `Mozilla/5.0 (${OS_UA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;
app.userAgentFallback = UA;
// Google sign-in pages get a Firefox identity (Google blocks embedded Chromium apps); all other sites see Chrome
const FF_OS = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
  : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64';
const FF_UA = `Mozilla/5.0 (${FF_OS}; rv:140.0) Gecko/20100101 Firefox/140.0`;
app.on('web-contents-created', (_, wc) => { wc.on('will-attach-webview', e => e.preventDefault()); });
let BUILT = Date.now();
try { BUILT = Date.parse(JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')).builtAt) || BUILT; } catch {}
const ageDays = () => Math.floor((Date.now() - BUILT) / 864e5);

// The browser was renamed; keep using the original data folder so profiles, logins and settings carry over
app.setPath('userData', path.join(app.getPath('appData'), 'StreamHub'));
process.on('uncaughtException', err => { // keep running; note the problem in a log file instead of a crash dialog
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), `${new Date().toISOString()} ${(err && err.stack) || err}\n`); } catch {}
});
const CHROME_H = 88; // tab strip 40 + toolbar 48
const SIDE_W = 52, PANEL_W = 580;
const ICON = path.join(__dirname, 'icon.ico');
const PRELOAD = path.join(__dirname, 'preload.js');
const page = f => pathToFileURL(path.join(__dirname, f)).href;
const NEWTAB = page('newtab.html');
const internal = u => u.startsWith('file://');
const trusted = e => !!e.senderFrame && e.senderFrame.url.startsWith('file://');

const store = (name, def) => {
  const f = path.join(app.getPath('userData'), name + '.json');
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { d = def; }
  return { get: () => d, save: () => fs.writeFileSync(f, JSON.stringify(d)) };
};
const bookmarks = store('bookmarks', []), settings = store('settings', { adblock: true });
const histStores = {};
const hist = id => (histStores[id] ||= store(id === 'default' ? 'history' : 'history-' + id, []));
const downloads = [];
const sideDefaults = [
  { id: 'wa', name: 'WhatsApp', url: 'https://web.whatsapp.com', color: '#25d366' },
  { id: 'tg', name: 'Telegram', url: 'https://web.telegram.org/k/', color: '#2aabee' }
];
if (!settings.get().sidebar) { settings.get().sidebar = sideDefaults; settings.save(); }
const side = () => settings.get().sidebar;
if (!settings.get().liveAdded) { const sb = settings.get().sidebar; sb.splice(Math.min(2, sb.length), 0, { id: 'livetv', name: 'Live TV', url: 'quark://livetv', color: '#8b5cf6' }); settings.get().liveAdded = 1; settings.save(); }
const scDefaults = [
  { name: 'YouTube', url: 'https://www.youtube.com', icon: 'youtube.svg' },
  { name: 'Facebook', url: 'https://www.facebook.com', icon: 'facebook.svg' },
  { name: 'Google', url: 'https://www.google.com', icon: 'google.svg' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org', icon: 'wikipedia.svg' },
  { name: 'Instagram', url: 'https://www.instagram.com', icon: 'instagram.svg' },
  { name: 'TikTok', url: 'https://www.tiktok.com', icon: 'tiktok.svg' }
];
if (!settings.get().shortcuts) { settings.get().shortcuts = scDefaults; settings.save(); }
const shortcuts = () => settings.get().shortcuts;
if (!settings.get().profiles) { settings.get().profiles = [{ id: 'default', name: 'Personal', color: '#2dd4bf' }]; settings.save(); }
const profiles = () => settings.get().profiles;
if (!settings.get().exitFix) { const st = settings.get(); delete st.exitDefaults; st.exitAuto = {}; st.exitAsk = true; st.exitFix = 1; settings.save(); }
const PCOL = ['#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#ec4899', '#10b981', '#f97316'];
const sesOf = id => id === 'default' ? session.defaultSession : session.fromPartition('persist:' + id);
const panels = {};
let openPanel = null, lastPanel = null;

const theme = () => settings.get().theme || 'dark';
nativeTheme.themeSource = theme();
// Dark mode for websites (Chromium's auto dark mode). Read at startup, so changing it needs a restart.
if (settings.get().darkSites !== false && nativeTheme.shouldUseDarkColors) app.commandLine.appendSwitch('blink-settings', 'forceDarkModeEnabled=true');
const tbColors = () => nativeTheme.shouldUseDarkColors
  ? { color: '#1c2130', symbolColor: '#e8ebf2' } : { color: '#dde2ec', symbolColor: '#1d2330' };
function applyTheme() {
  if (!win || win.isDestroyed()) return;
  win.setTitleBarOverlay({ ...tbColors(), height: 40 });
  win.setBackgroundColor(tbColors().color);
}
nativeTheme.on('updated', applyTheme);
function setTheme(t) { settings.get().theme = t; settings.save(); nativeTheme.themeSource = t; applyTheme(); }

let win, blocker, tabs = [], active = 0, nextId = 1, htmlFS = false, blocked = 0, pt;
let adblock = settings.get().adblock !== false;
const tab = () => tabs.find(t => t.id === active);
const cur = () => tab()?.view.webContents;

/* ---------- URL helper ---------- */
function toUrl(s) {
  s = s.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(s)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

/* ---------- Security: HTTPS-first, certificate + malware warnings ---------- */
const certAllow = new Set(), httpAllow = new Set(), malwareAllow = new Set(), phishAllow = new Set();
const upgraded = new Map(); // host -> original http URL (so "Continue anyway" can go back to it)
let badHosts = new Set(), phishHosts = new Set();
const SAFE_HOST = /(^|\.)(google|googleusercontent|github|githubusercontent|microsoft|dropbox|discord|discordapp|telegram|whatsapp|facebook|youtube|cloudflare|amazonaws)\.(com|org|net|me)$/;
const isLocal = h => !h.includes('.') || h.endsWith('.local') || h === '[::1]' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
const warnUrl = (type, url, err = '') => page('warn.html') + '#' + encodeURIComponent(JSON.stringify({ type, url, err }));

// What to really load: known-bad sites -> warning page, http -> https first (unless the user already chose to continue)
function gate(raw) {
  let u; try { u = new URL(raw); } catch { return raw; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
  const host = u.hostname;
  if (badHosts.has(host) && !malwareAllow.has(host) && !SAFE_HOST.test(host)) return warnUrl('malware', raw);
  if (phishHosts.has(host) && !phishAllow.has(host) && !SAFE_HOST.test(host)) return warnUrl('phishing', raw);
  if (u.protocol === 'http:' && !isLocal(host) && !httpAllow.has(host)) {
    upgraded.set(host, raw);
    u.protocol = 'https:';
    return u.href;
  }
  return raw;
}

function proceed(wc, { type, url } = {}) {
  let u; try { u = new URL(url); } catch { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  if (type === 'cert') certAllow.add(u.host);
  else if (type === 'http') httpAllow.add(u.hostname);
  else if (type === 'malware') malwareAllow.add(u.hostname);
  else if (type === 'phishing') phishAllow.add(u.hostname);
  wc?.loadURL(url);
}

app.on('certificate-error', (e, wc, url, error, cert, cb) => {
  let host = ''; try { host = new URL(url).host; } catch {}
  if (certAllow.has(host)) { e.preventDefault(); cb(true); } else cb(false);
});

const parseHosts = text => new Set(text.split('\n').map(l => l.trim()).filter(l => l && l[0] !== '#')
  .map(l => l.split(/\s+/).pop().toLowerCase()).filter(h => h.includes('.') && !h.includes('/')));
async function cachedList(url, file) { // download a list, keep it for a day, fall back to the saved copy offline
  const f = path.join(app.getPath('userData'), file);
  let text = '';
  try { if (Date.now() - fs.statSync(f).mtimeMs < 864e5) text = fs.readFileSync(f, 'utf8'); } catch {}
  if (!text) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { text = await r.text(); fs.writeFileSync(f, text); }
    } catch { try { text = fs.readFileSync(f, 'utf8'); } catch {} }
  }
  return text;
}
async function loadBadHosts() { // malware (URLhaus) + phishing (Phishing Army) domain lists
  badHosts = parseHosts(await cachedList('https://urlhaus.abuse.ch/downloads/hostfile/', 'badhosts.txt'));
  phishHosts = parseHosts(await cachedList('https://phishing.army/download/phishing_army_blocklist.txt', 'phishhosts.txt'));
}

const GOOGLE_LOGIN = 'https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F';
// "Sign in with Google" popups open as a small window (they need window.opener); other links open as tabs
const isAddSession = u => { try { const x = new URL(u); return x.hostname === 'accounts.google.com' && x.pathname.startsWith('/AddSession'); } catch { return false; } };
function openHandler({ url, disposition }) {
  let u; try { u = new URL(url); } catch { return { action: 'deny' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { action: 'deny' };
  if (disposition === 'new-window' && u.hostname === 'accounts.google.com')
    return { action: 'allow', overrideBrowserWindowOptions: { parent: win, width: 500, height: 680, autoHideMenuBar: true, icon: ICON, title: 'Sign in with Google' } };
  if (isAddSession(url)) { addGmailFlow(tab(), url); return { action: 'deny' }; }
  newTab(url); return { action: 'deny' };
}

/* ---------- Window & layout ---------- */
function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 800, minWidth: 720, minHeight: 460,
    backgroundColor: tbColors().color, title: 'Quark', icon: ICON,
    titleBarStyle: 'hidden', titleBarOverlay: { ...tbColors(), height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload-ui.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.loadFile('index.html');
  win.on('close', e => { // ask what to delete before closing
    if (exitOk) return;
    e.preventDefault();
    const st = settings.get();
    if (st.exitAsk === false) finishExit(st.exitAuto || {}); else askExit();
  });
  win.on('session-end', () => { exitOk = true; });
  win.webContents.on('will-navigate', e => e.preventDefault()); // the browser's own window never navigates
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', onKey);
  win.on('resize', layout);
  for (const ev of ['move', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => placeLive());
  win.webContents.once('did-finish-load', () => newTab());
}

function layout() {
  if (!win || win.isDestroyed()) return;
  setImmediate(placeLive);
  const [w, h] = win.getContentSize(), top = htmlFS ? 0 : CHROME_H, left = htmlFS ? 0 : SIDE_W;
  const pw = openPanel && !htmlFS ? Math.min(PANEL_W, w - left - 40) : 0; // panel floats over the page
  tabs.forEach(t => t.view.setBounds({ x: left, y: top, width: w - left, height: h - top }));
  for (const [id, v] of Object.entries(panels)) {
    const show = id === openPanel && pw > 0;
    v.setVisible(show);
    if (show) v.setBounds({ x: left, y: top, width: pw, height: h - top });
  }
}

function push() {
  if (!win || win.isDestroyed()) return;
  const wc = cur(), nav = wc?.navigationHistory, u = wc?.getURL() || '';
  win.webContents.send('state', {
    active, tabs: tabs.map(({ id, title, icon, loading, profile }) => ({ id, title, icon, loading, profile })),
    url: internal(u) ? '' : u, secure: u.startsWith('https:') ? 'https' : u.startsWith('http:') ? 'http' : '', canBack: !!nav?.canGoBack(), canFwd: !!nav?.canGoForward(),
    starred: bookmarks.get().some(b => b.url === u), blocked, adblock,
    dl: downloads.filter(d => d.state === 'progressing').length, dlUnseen,
    dlPct: (() => { const a = downloads.filter(d => d.state === 'progressing'), t = a.reduce((x, d) => x + (d.total || 0), 0), r = a.reduce((x, d) => x + (d.received || 0), 0); return t > 0 ? Math.min(100, Math.round(r / t * 100)) : -1; })(),
    side: side().map(({ id, name, icon, color }) => ({ id, name, icon, color })), panel: openPanel || (live.tabId && active === live.tabId ? 'livetv' : null),
    profiles: profiles(), profile: tab()?.profile || 'default'
  });
}

/* ---------- Tabs ---------- */
function newTab(url = NEWTAB, opts = {}) {
  const profile = opts.profile || tab()?.profile || 'default';
  ensureSession(profile);
  const prefs = { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false };
  if (profile !== 'default') prefs.partition = 'persist:' + profile;
  const view = new WebContentsView({ webPreferences: prefs });
  const t = { id: nextId++, view, title: 'New Tab', icon: '', loading: false, profile };
  const wc = view.webContents;
  if (profile === 'default') extensions?.addTab(wc, win);
  tabs.push(t);
  win.contentView.addChildView(view);
  if (openPanel) win.contentView.addChildView(panels[openPanel]); // keep the sidebar panel on top

  wc.setWindowOpenHandler(openHandler);
  wc.on('before-input-event', onKey);
  wc.on('page-title-updated', (_, title) => {
    t.title = title; push();
    const m = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)\s+-\s+Gmail/.exec(title);
    if (m) {
      const seen = (settings.get().seen ||= {}), l = (seen[profile] ||= []), e = m[1].toLowerCase();
      if (!l.includes(e)) { l.push(e); settings.save(); delete acctCache[profile]; }
    }
  });
  wc.on('page-favicon-updated', (_, icons) => { t.icon = icons[0] || ''; push(); });
  wc.on('did-start-loading', () => { t.loading = true; push(); });
  wc.on('did-stop-loading', () => { t.loading = false; push(); });
  wc.on('did-navigate', () => { if (t.id === live.tabId && !wc.getURL().startsWith(LIVE_URL)) liveStop(true); push(); });
  wc.on('did-navigate-in-page', () => push());
  const nav = d => {
    if (isAddSession(d.url) && !t.allowAdd) { d.preventDefault(); addGmailFlow(t, d.url, true); return; }
    const g = gate(d.url); if (g !== d.url) { d.preventDefault(); wc.loadURL(g); }
  };
  wc.on('will-navigate', nav);
  wc.on('will-redirect', nav);
  wc.on('did-fail-load', (_, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    let host = ''; try { host = new URL(url).hostname; } catch { return; }
    if (code <= -200 && code >= -219) wc.loadURL(warnUrl('cert', url, desc));
    else if (upgraded.has(host) && [-100, -101, -102, -107, -113, -118].includes(code)) wc.loadURL(warnUrl('http', upgraded.get(host), desc));
  });
  wc.setWebRTCIPHandlingPolicy('default_public_interface_only');
  wc.on('enter-html-full-screen', () => { htmlFS = true; win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { htmlFS = false; win.setFullScreen(false); layout(); });
  wc.on('did-finish-load', () => {
    const u = wc.getURL(), hs = hist(profile), h = hs.get();
    if (internal(u) || h[0]?.url === u) return;
    h.unshift({ title: wc.getTitle(), url: u, time: Date.now() });
    h.length = Math.min(h.length, 1000); hs.save();
  });
  wc.on('context-menu', (_, p) => {
    const m = [];
    if (p.linkURL) m.push({ label: 'Open link in new tab', click: () => newTab(p.linkURL) },
      { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    if (p.mediaType === 'image' && p.srcURL) m.push({ label: 'Open image in new tab', click: () => newTab(p.srcURL) });
    if (p.selectionText) m.push({ role: 'copy' });
    if (p.isEditable) m.push({ role: 'paste' });
    m.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Reload', click: () => wc.reload() },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(m).popup();
  });

  wc.loadURL(gate(url));
  switchTab(t.id);
}

function switchTab(id) {
  active = id;
  tabs.forEach(t => t.view.setVisible(t.id === id));
  layout(); push();
  if (cur() && tab().profile === 'default') extensions?.selectTab(cur());
  cur()?.focus();
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  if (t.id === live.tabId) liveStop(true);
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (!tabs.length) return win.close();
  if (active === id) switchTab(tabs[Math.min(i, tabs.length - 1)].id); else push();
}

const openInternal = v => newTab(page('pages.html') + '#' + v);

/* ---------- Keyboard shortcuts ---------- */
const zoom = d => { const wc = cur(); if (wc) wc.setZoomLevel(d === 0 ? 0 : wc.getZoomLevel() + d); };
function onKey(e, i) {
  if (i.type !== 'keyDown') return;
  const c = i.control || i.meta, k = i.key.toLowerCase();
  const run = fn => { e.preventDefault(); fn(); };
  if (c && k === 't') run(() => newTab());
  else if (c && k === 'w') run(() => closeTab(active));
  else if (c && k === 'l') run(() => win.webContents.send('focus-url'));
  else if (c && k === 'd') run(toggleBookmark);
  else if (c && k === 'h') run(() => openInternal('history'));
  else if (c && k === 'j') run(() => openInternal('downloads'));
  else if ((c && k === 'r') || k === 'f5') run(() => cur()?.reload());
  else if (k === 'f12') run(() => cur()?.toggleDevTools());
  else if (c && (k === '=' || k === '+')) run(() => zoom(0.5));
  else if (c && k === '-') run(() => zoom(-0.5));
  else if (c && k === '0') run(() => zoom(0));
  else if (i.alt && k === 'arrowleft') run(() => cur()?.navigationHistory.goBack());
  else if (i.alt && k === 'arrowright') run(() => cur()?.navigationHistory.goForward());
  else if (i.control && k === 'tab') run(() => {
    const n = tabs.length, j = tabs.findIndex(t => t.id === active);
    switchTab(tabs[(j + (i.shift ? n - 1 : 1)) % n].id);
  });
}

/* ---------- Bookmarks, ad blocker, downloads ---------- */
function toggleBookmark() {
  const wc = cur(); if (!wc || internal(wc.getURL())) return;
  const u = wc.getURL(), b = bookmarks.get(), i = b.findIndex(x => x.url === u);
  if (i >= 0) b.splice(i, 1); else b.unshift({ title: wc.getTitle(), url: u, time: Date.now() });
  bookmarks.save(); push();
}

// The ad blocker's helper channels are shared by all sessions, so clear them before another profile session registers them
function blockIn(ses) {
  if (!blocker || blocker.isBlockingEnabled(ses)) return;
  ipcMain.removeHandler('@ghostery/adblocker/inject-cosmetic-filters');
  ipcMain.removeHandler('@ghostery/adblocker/is-mutation-observer-enabled');
  blocker.enableBlockingInSession(ses);
}
function unblockIn(ses) { if (blocker?.isBlockingEnabled(ses)) blocker.disableBlockingInSession(ses); }

async function setupAdblock() {
  const cache = { path: path.join(app.getPath('userData'), 'adblock.bin'),
    read: fs.promises.readFile, write: fs.promises.writeFile };
  blocker = await ElectronBlocker.fromPrebuiltFull(fetch, cache);
  // YouTube's player breaks easily when ad scripts are injected, so by default the blocker skips YouTube (Settings can turn it on)
  const YT_HOST = /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|ytimg\.com|ggpht\.com|youtube-nocookie\.com)$/;
  const host = u => { try { return new URL(u).hostname; } catch { return ''; } };
  const ytSkip = u => !settings.get().ytAds && YT_HOST.test(host(u || ''));
  const pageUrl = d => { try { return d.webContents?.getURL() || ''; } catch { return ''; } };
  const cos = blocker.onInjectCosmeticFilters.bind(blocker);
  blocker.onInjectCosmeticFilters = (e, url, msg) => ytSkip(url) ? undefined : cos(e, url, msg);
  const bef = blocker.onBeforeRequest.bind(blocker);
  blocker.onBeforeRequest = (d, cb) => (ytSkip(d.url) || ytSkip(d.referrer) || ytSkip(pageUrl(d))) ? cb({}) : bef(d, cb);
  blocker.on('request-blocked', () => { blocked++; clearTimeout(pt); pt = setTimeout(push, 500); });
  if (adblock) for (const id of ready) blockIn(sesOf(id));
}

function toggleAdblock() {
  adblock = !adblock;
  settings.get().adblock = adblock; settings.save();
  for (const id of ready) adblock ? blockIn(sesOf(id)) : unblockIn(sesOf(id));
  cur()?.reload(); push();
}

const RISKY = /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|jar|dll|lnk|hta|reg)$/i;
function uniquePath(name) {
  const dir = app.getPath('downloads'), { name: n, ext } = path.parse(name);
  let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${n} (${i++})${ext}`);
  return p;
}

function onDownload(_, item) {
  const p = uniquePath(item.getFilename());
  item.setSavePath(p);
  if (RISKY.test(p)) {
    let host = ''; try { host = new URL(item.getURL()).hostname; } catch {}
    dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel download', 'Keep file'], defaultId: 0, cancelId: 0,
      message: `This file type can harm your computer:\n${path.basename(p)}`,
      detail: `Downloaded from ${host || 'an unknown site'}. Only keep it if you trust this site.` })
      .then(r => { if (r.response !== 1) { item.cancel(); fs.unlink(p, () => {}); } });
  }
  const d = { id: 'd' + Date.now() + Math.random().toString(36).slice(2, 6), kind: 'file', name: path.basename(p), path: p, received: 0, total: item.getTotalBytes(), state: 'progressing', item, cancel: () => item.cancel() };
  downloads.unshift(d); downloads.length = Math.min(downloads.length, 60);
  item.on('updated', () => { d.received = item.getReceivedBytes(); d.total = item.getTotalBytes(); dlChanged(); });
  item.once('done', (_, st) => { d.state = st; dlFinished(d); });
  dlChanged();
}

/* ---------- Three-dot menu ---------- */
function showMenu({ x, y }) {
  const wc = cur();
  Menu.buildFromTemplate([
    { label: 'New tab', click: () => newTab() },
    { type: 'separator' },
    { label: `Ad blocker  (${blocked} blocked)`, type: 'checkbox', checked: adblock, click: toggleAdblock },
    { type: 'separator' },
    { label: 'Downloads', click: () => openInternal('downloads') },
    { label: 'History', click: () => openInternal('history') },
    { label: 'Bookmarks', click: () => openInternal('bookmarks') },
    { label: 'Extensions', click: () => openInternal('extensions') },
    { label: 'Settings', click: () => openInternal('settings') },
    { type: 'separator' },
    { label: 'Zoom in', click: () => zoom(0.5) },
    { label: 'Zoom out', click: () => zoom(-0.5) },
    { label: 'Reset zoom', click: () => zoom(0) },
    { label: 'Print…', click: () => wc?.print() },
    { type: 'separator' },
    { label: 'Theme', submenu: ['dark', 'light', 'system'].map(t => ({ label: t[0].toUpperCase() + t.slice(1),
      type: 'radio', checked: theme() === t, click: () => setTheme(t) })) },
    { label: 'Clear browsing data…', click: clearData },
    { label: 'Developer tools', click: () => wc?.toggleDevTools() },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

async function clearData() {
  const pid = tab()?.profile || 'default', name = profiles().find(p => p.id === pid)?.name || '';
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Clear data', 'Cancel'], defaultId: 1,
    message: `Clear history, cookies and cache for "${name}"?` });
  if (r.response !== 0) return;
  const h = hist(pid); h.get().length = 0; h.save();
  await sesOf(pid).clearStorageData(); await sesOf(pid).clearCache();
}

function profileMenu({ x, y }) {
  const cp = tab()?.profile || 'default';
  Menu.buildFromTemplate([
    { label: 'Open a new tab in:', enabled: false },
    ...profiles().map(p => ({ label: p.name, type: 'radio', checked: p.id === cp, click: () => newTab(NEWTAB, { profile: p.id }) })),
    { type: 'separator' },
    { label: 'Add Gmail account…', click: () => addGmailFlow(tab()) },
    { label: 'New profile…', click: () => addDialog('profile') },
    { label: 'Open Gmail', click: () => newTab('https://mail.google.com') },
    { label: 'Google Account', click: () => newTab('https://myaccount.google.com') },
    { type: 'separator' },
    { label: 'Manage profiles…', click: () => openInternal('settings') }
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

/* ---------- Sessions, site permissions ---------- */
const ready = new Set();
function ensureSession(id) { // every profile has its own session (cookies, logins, cache) with the same protections
  const ses = sesOf(id);
  if (!ready.has(id)) {
    ready.add(id);
    ses.setPermissionRequestHandler(onPermissionRequest);
    ses.setPermissionCheckHandler(onPermissionCheck);
    ses.on('will-download', onDownload);
    ses.setUserAgent(UA);
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*', 'https://accounts.youtube.com/*'] }, (d, cb) => {
      const h = d.requestHeaders;
      h['User-Agent'] = FF_UA;
      for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
      cb({ requestHeaders: h });
    });
    if (adblock) blockIn(ses);
  }
  return ses;
}

const ALWAYS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'speaker-selection', 'mediaKeySystem']);
const ASK = { media: d => { const m = d.mediaTypes || []; return 'use your ' + (m.includes('video') && m.includes('audio') ? 'camera and microphone' : m.includes('video') ? 'camera' : 'microphone'); },
  geolocation: () => 'know your location', notifications: () => 'show notifications', 'clipboard-read': () => 'read your clipboard', midi: () => 'use your MIDI devices' };
const perms = () => (settings.get().perms ||= {});
const originOf = u => { try { return new URL(u).origin; } catch { return ''; } };
let permQueue = Promise.resolve();

function onPermissionCheck(wc, perm, origin) {
  if (ALWAYS.has(perm)) return true;
  return perm in ASK && perms()[originOf(origin) || origin]?.[perm] === 'allow';
}

function onPermissionRequest(wc, perm, cb, details = {}) {
  if (ALWAYS.has(perm)) return cb(true);
  const origin = originOf(details.requestingUrl || wc.getURL());
  if (!(perm in ASK) || !/^https?:/.test(origin)) return cb(false);
  const saved = perms()[origin]?.[perm];
  if (saved) return cb(saved === 'allow');
  permQueue = permQueue.then(async () => { // one prompt at a time
    const again = perms()[origin]?.[perm];
    if (again) return cb(again === 'allow');
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1,
      message: `${new URL(origin).host} wants to ${ASK[perm](details)}`,
      detail: 'You can change this later in Settings → Site permissions.',
      checkboxLabel: 'Remember my choice for this site', checkboxChecked: true });
    const ok = r.response === 0;
    if (r.checkboxChecked) { (perms()[origin] ||= {})[perm] = ok ? 'allow' : 'block'; settings.save(); }
    cb(ok);
  }).catch(() => cb(false));
}

async function confirmInstall(d) { // asked before any Chrome Web Store extension is installed
  const list = [...(d.manifest.permissions || []), ...(d.manifest.host_permissions || [])];
  const broad = list.some(p => /<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*/.test(p));
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Install extension'], defaultId: 0, cancelId: 0,
    message: `Install "${d.localizedName}"?`,
    detail: (broad ? 'This extension can read and change the data on every website you visit, including your email.\n\n' : '') +
      (list.length ? 'Permissions: ' + list.slice(0, 12).join(', ') + (list.length > 12 ? ', …' : '') : 'It asks for no special permissions.') +
      '\n\nOnly install extensions you trust.' });
  return { action: r.response === 1 ? 'allow' : 'deny' };
}

/* ---------- Profiles + "add a Gmail" flow ---------- */
let pendingGmail = false;
function addProfile(name) {
  name = String(name).trim().slice(0, 30); if (!name) return null;
  const p = { id: 'p' + Date.now(), name, color: PCOL[(profiles().length - 1) % PCOL.length] };
  profiles().push(p); settings.save(); push();
  return p;
}

async function profileDelete(id) {
  if (id === 'default' || !profiles().some(p => p.id === id)) return;
  if (tabs.every(t => t.profile === id)) newTab(NEWTAB, { profile: 'default' });
  tabs.filter(t => t.profile === id).forEach(t => closeTab(t.id));
  const ses = sesOf(id);
  await ses.clearStorageData(); await ses.clearCache();
  settings.get().profiles = profiles().filter(p => p.id !== id); settings.save();
  ready.delete(id); push();
}

async function hasGoogleLogin(pid) {
  const c = await sesOf(pid).cookies.get({ domain: 'google.com' });
  return c.some(x => /^(SID|__Secure-1PSID|SAPISID)$/.test(x.name));
}

// Like Chrome: when another Google account is added, offer a separate profile for it
async function addGmailFlow(t, url = GOOGLE_LOGIN, inPlace = false) {
  const pid = t?.profile || 'default';
  const go = () => { if (inPlace && t) { t.allowAdd = true; t.view.webContents.loadURL(url); } else newTab(url, { profile: pid }); };
  if (!(await hasGoogleLogin(pid))) return go();
  const name = profiles().find(p => p.id === pid)?.name || 'this profile';
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Create a new profile', `Use "${name}"`, 'Cancel'], defaultId: 0, cancelId: 2,
    message: 'Add this Gmail in a separate profile?',
    detail: `You are already signed in to a Google account in "${name}". A separate profile keeps this Gmail's logins, cookies and history apart, like Chrome profiles.` });
  if (r.response === 0) { pendingGmail = true; addDialog('profile'); } else if (r.response === 1) go();
}

/* ---------- Closing: choose what to delete; old-build warning ---------- */
let exitOk = false, exitDlg = null;
async function wipe(o = {}) {
  for (const p of profiles()) {
    const ses = sesOf(p.id);
    if (o.cookies) await ses.clearStorageData();
    if (o.cache) await ses.clearCache();
    if (o.history) { const h = hist(p.id); h.get().length = 0; h.save(); }
  }
}
async function flushAll() { for (const p of profiles()) { try { const ses = sesOf(p.id); await ses.cookies.flushStore(); ses.flushStorageData(); } catch {} } }
async function finishExit(o) { try { await wipe(o); } catch {} await flushAll(); exitOk = true; app.quit(); }
function askExit() {
  if (exitDlg && !exitDlg.isDestroyed()) return exitDlg.focus();
  exitDlg = new BrowserWindow({ parent: win, modal: true, width: 480, height: 430, resizable: false, minimizable: false, maximizable: false,
    title: 'Close Quark', icon: ICON, backgroundColor: tbColors().color, webPreferences: { preload: PRELOAD } });
  exitDlg.setMenu(null);
  exitDlg.on('closed', () => { exitDlg = null; if (!exitOk && !tabs.length && win && !win.isDestroyed()) newTab(); });
  exitDlg.loadFile('exit.html');
}
function staleWarning() {
  const today = new Date().toDateString();
  if (ageDays() < 60 || settings.get().staleShown === today) return;
  settings.get().staleShown = today; settings.save();
  dialog.showMessageBox(win, { type: 'warning', buttons: ['OK'], message: 'This Quark version is getting old',
    detail: `It was built ${ageDays()} days ago. Browser engines get security fixes every few weeks, so please ask for a newer version.` });
}

/* ---------- Updates (GitHub Releases) ---------- */
let upd, updBusy = false, updManual = false;
function getUpdater() { // only in the installed Windows app
  if (upd !== undefined) return upd;
  upd = null;
  if (!app.isPackaged || process.platform !== 'win32') return upd;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', async info => {
      updBusy = false;
      const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Download now', 'Later'], defaultId: 0, cancelId: 1,
        message: `Quark ${info.version} is available`, detail: 'New versions carry the latest browser-engine security fixes. Download it now? You can keep browsing meanwhile.' });
      if (r.response === 0) { updBusy = true; autoUpdater.downloadUpdate().catch(() => { updBusy = false; }); }
    });
    autoUpdater.on('update-not-available', () => { updBusy = false; if (updManual) dialog.showMessageBox(win, { type: 'info', message: 'Quark is up to date.' }); });
    autoUpdater.on('update-downloaded', async info => {
      updBusy = false;
      const r = await dialog.showMessageBox(win, { type: 'info', buttons: ['Restart and update', 'Later'], defaultId: 0, cancelId: 1,
        message: `Quark ${info.version} is ready to install`, detail: 'Quark will close and reopen with the new version. Your profiles and logins stay.' });
      if (r.response === 0) { exitOk = true; await flushAll(); autoUpdater.quitAndInstall(false, true); }
    });
    autoUpdater.on('error', e => { updBusy = false; if (updManual) dialog.showMessageBox(win, { type: 'warning', message: 'Could not check for updates', detail: String(e.message || e).slice(0, 300) }); });
    upd = autoUpdater;
  } catch (e) { console.error('Updater:', e.message); }
  return upd;
}
function checkUpdates(manual) {
  const u = getUpdater();
  if (!u) { if (manual) dialog.showMessageBox(win, { type: 'info', message: 'Updates work in the installed version of Quark.' }); return; }
  if (updBusy) return;
  updManual = manual; updBusy = true;
  u.checkForUpdates().catch(() => { updBusy = false; });
}

/* ---------- Profile card (like Chrome's profile bubble) ---------- */
const acctCache = {};
const EMAIL_RE = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const seenList = pid => (settings.get().seen?.[pid] || []).map(e => ({ name: '', email: e, photo: '' }));

function parseAccounts(txt) { // Google's account list: arrays that start with "gaia.l.a" = [.., name, email, photo, ..]
  const out = [];
  const walk = a => {
    if (!Array.isArray(a)) return;
    if (a[0] === 'gaia.l.a' && typeof a[3] === 'string' && EMAIL_RE.test(a[3]) && !out.some(x => x.email === a[3]))
      out.push({ name: typeof a[2] === 'string' ? a[2] : '', email: a[3], photo: /^https:\/\//.test(a[4] || '') ? a[4] : '' });
    a.forEach(walk);
  };
  try { walk(JSON.parse(txt.slice(txt.indexOf('[')))); } catch {}
  return out;
}

async function fetchAccounts(pid) {
  const ses = ensureSession(pid), url = 'https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard';
  for (const method of ['GET', 'POST']) {
    try {
      const r = await ses.fetch(url, { method, body: method === 'POST' ? '' : undefined, signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const list = parseAccounts(await r.text());
      if (list.length) return list;
    } catch {}
  }
  return [];
}

async function accountsOf(pid, fresh) {
  const c = acctCache[pid];
  if (c && !fresh && Date.now() - c.t < 120000) return c.list;
  let list = [];
  if (await hasGoogleLogin(pid)) {
    list = await fetchAccounts(pid);
    if (!list.length) list = seenList(pid);
  }
  acctCache[pid] = { t: Date.now(), list };
  return list;
}

async function cardData(fresh) {
  const cur = tab()?.profile || 'default';
  const rows = await Promise.all(profiles().map(async p => {
    const accounts = fresh ? await accountsOf(p.id, true) : (acctCache[p.id]?.list || seenList(p.id));
    return { ...p, accounts, signedIn: accounts.length > 0 || (fresh && await hasGoogleLogin(p.id)) };
  }));
  return { current: cur, profiles: rows };
}

let pcard = null, pcardClosed = 0;
function showProfileCard({ x, y }) {
  if (pcard && !pcard.isDestroyed()) { pcard.close(); return; }
  if (Date.now() - pcardClosed < 300) return; // that click is the one that just closed the card
  const cb = win.getContentBounds(), W = 340;
  pcard = new BrowserWindow({ parent: win, x: Math.max(cb.x, Math.round(cb.x + x - W)), y: Math.round(cb.y + y + 4), width: W, height: 420,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#252b3a' : '#ffffff',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  pcard.setMenu(null);
  pcard.once('ready-to-show', () => pcard && pcard.show());
  pcard.on('blur', () => { if (pcard && !pcard.isDestroyed()) pcard.close(); });
  pcard.on('closed', () => { pcardClosed = Date.now(); pcard = null; });
  pcard.loadFile('profile.html');
}

/* ---------- YouTube downloader (helper tools are fetched on first use, not bundled) ---------- */
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const EXE = process.platform === 'win32' ? '.exe' : '';
const testMode = () => !app.isPackaged;
const toolsDir = () => (testMode() && process.env.SH_TOOLSDIR) || path.join(app.getPath('userData'), 'components');
const TOOL_FILE = { ytdlp: 'yt-dlp', deno: 'deno', ffmpeg: 'ffmpeg', mpv: 'mpv', '7zr': '7zr' };
const toolPath = n => (testMode() && process.env['SH_' + n.toUpperCase()]) || path.join(toolsDir(), TOOL_FILE[n] + EXE);
const TOOL_INFO = { ytdlp: { name: 'yt-dlp (video fetcher)', mb: 24 }, deno: { name: 'Deno (runs YouTube\'s scripts)', mb: 43 }, ffmpeg: { name: 'FFmpeg (joins video + audio, makes MP3)', mb: 115 } };
const toolsMissing = () => Object.keys(TOOL_INFO).filter(n => !fs.existsSync(toolPath(n)));
const procEnv = () => ({ ...process.env, PATH: toolsDir() + path.delimiter + (process.env.PATH || ''), PYTHONIOENCODING: 'utf-8' });
const ffLoc = () => (testMode() && process.env.SH_FFMPEG) || toolsDir();

async function downloadTo(url, dest, onProgress) {
  const r = await fetch(url, { signal: AbortSignal.timeout(1800000) });
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  let got = 0, last = 0;
  const out = fs.createWriteStream(dest), reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!out.write(value)) await new Promise(res => out.once('drain', res));
    got += value.length;
    if (Date.now() - last > 300) { last = Date.now(); onProgress?.(got, total); }
  }
  await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
  onProgress?.(got, total || got);
}
const sha256 = f => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
const getText = async u => { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); };
const unzip = (zip, dest) => new Promise((res, rej) => execFile(process.platform === 'win32' ? 'tar' : 'unzip',
  process.platform === 'win32' ? ['-xf', zip, '-C', dest] : ['-o', '-q', zip, '-d', dest], { windowsHide: true, maxBuffer: 1 << 24 }, err => err ? rej(err) : res()));
function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; } else if (e.name.toLowerCase() === name) return p;
  }
  return null;
}

async function findFfmpegAsset() {
  try { // the release page lists every file with its SHA-256, so no rate-limited API is needed
    const r = await fetch('https://github.com/GyanD/codexffmpeg/releases/latest', { signal: AbortSignal.timeout(30000) });
    const tag = r.url.split('/tag/')[1];
    const html = await getText('https://github.com/GyanD/codexffmpeg/releases/expanded_assets/' + tag);
    for (const block of html.split(/<li\b/)) {
      const m = block.match(/href="([^"]*essentials_build\.zip)"/), d = block.match(/sha256:([a-f0-9]{64})/);
      if (m && d) return { url: 'https://github.com' + m[1], sha: d[1] };
    }
  } catch {}
  const rel = JSON.parse(await getText('https://api.github.com/repos/GyanD/codexffmpeg/releases/latest'));
  const a = (rel.assets || []).find(x => /essentials_build\.zip$/.test(x.name));
  if (!a) throw new Error('Could not find the FFmpeg download');
  return { url: a.browser_download_url, sha: (a.digest || '').replace('sha256:', '') };
}

// Every file is checked against the publisher's SHA-256 before it is kept
async function installTool(name, report, plat = process.platform) {
  const dir = toolsDir(), ext = plat === 'win32' ? '.exe' : '', tmp = path.join(dir, name + '.part');
  fs.mkdirSync(dir, { recursive: true });
  const verify = async want => { if (!want || (await sha256(tmp)) !== want.toLowerCase()) { fs.rmSync(tmp, { force: true }); throw new Error(`${name} failed the safety check, so it was not installed`); } };
  if (name === 'ytdlp') {
    const asset = plat === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_linux', base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
    const want = (await getText(base + 'SHA2-256SUMS')).split('\n').map(l => l.trim().split(/\s+/)).find(p => (p[1] || '').replace('*', '') === asset)?.[0];
    await downloadTo(base + asset, tmp, report); await verify(want);
    fs.renameSync(tmp, path.join(dir, 'yt-dlp' + ext)); if (plat !== 'win32') fs.chmodSync(path.join(dir, 'yt-dlp'), 0o755);
    return;
  }
  const work = path.join(dir, 'unpack-' + name);
  fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  if (name === 'deno') {
    const f = 'deno-x86_64-pc-windows-msvc.zip', base = 'https://github.com/denoland/deno/releases/latest/download/';
    const want = ((await getText(base + f + '.sha256sum')).match(/[A-Fa-f0-9]{64}/) || [])[0];
    await downloadTo(base + f, tmp, report); await verify(want);
    await unzip(tmp, work);
    fs.copyFileSync(findFile(work, 'deno.exe'), path.join(dir, 'deno' + ext));
  } else if (name === 'ffmpeg') {
    const a = await findFfmpegAsset();
    await downloadTo(a.url, tmp, report); await verify(a.sha);
    await unzip(tmp, work);
    for (const n of ['ffmpeg.exe', 'ffprobe.exe']) { const p = findFile(work, n); if (p) fs.copyFileSync(p, path.join(dir, n)); }
  }
  fs.rmSync(tmp, { force: true }); fs.rmSync(work, { recursive: true, force: true });
}

function runYt(args, { timeout = 120000, onLine, onProc } = {}) {
  return new Promise(res => {
    const p = spawn(toolPath('ytdlp'), args, { env: procEnv(), windowsHide: true });
    onProc?.(p);
    let out = '', err = '', buf = '';
    const timer = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', d => {
      if (!onLine) { out += d; return; }
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); res({ code: -1, out, err: String(e) }); });
    p.on('close', code => { clearTimeout(timer); res({ code, out, err }); });
  });
}
const friendlyErr = e => ((String(e).split('\n').filter(l => /ERROR/.test(l)).pop() || String(e).slice(-200)).replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').trim() || 'Something went wrong');

function canonYt(u) {
  try {
    const x = new URL(u), h = x.hostname.replace(/^(www|m)\./, '');
    let id = '';
    if (h === 'youtube.com') id = x.pathname === '/watch' ? x.searchParams.get('v') : (x.pathname.match(/^\/shorts\/([\w-]{11})/) || [])[1];
    else if (h === 'youtu.be') id = x.pathname.slice(1, 12);
    return /^[\w-]{11}$/.test(id || '') ? 'https://www.youtube.com/watch?v=' + id : null;
  } catch { return null; }
}

function buildOptions(info) {
  const fm = info.formats || [];
  const hasV = f => f.vcodec && f.vcodec !== 'none', hasA = f => f.acodec && f.acodec !== 'none';
  const size = f => !f ? 0 : (f.filesize || f.filesize_approx || ((f.tbr || f.vbr || f.abr) && info.duration ? Math.round((f.tbr || f.vbr || f.abr) * 125 * info.duration) : 0));
  const top = (list, key) => list.slice().sort((a, b) => (b[key] || b.tbr || 0) - (a[key] || a.tbr || 0))[0];
  const audios = fm.filter(f => hasA(f) && !hasV(f));
  const byLang = new Map();
  for (const f of audios) { const k = f.language || 'und'; if (!byLang.has(k)) byLang.set(k, []); byLang.get(k).push(f); }
  let dn = null; try { dn = new Intl.DisplayNames(['en'], { type: 'language' }); } catch {}
  const langs = [...byLang.entries()].map(([code, list]) => {
    const note = list.map(f => f.format_note || '').join(' ');
    const orig = /original/i.test(note), dub = /dub/i.test(note);
    let name = 'Default'; if (code !== 'und') { try { name = dn?.of(code) || code; } catch { name = code; } }
    return { code, label: name + (orig ? ' (original)' : dub ? ' (auto-dubbed)' : ''), pref: orig ? 2 : /default/i.test(note) ? 1 : 0, size: size(top(list, 'abr')) };
  }).sort((a, b) => b.pref - a.pref);
  const bestAudioSize = langs[0]?.size || 0;
  const vids = fm.filter(f => hasV(f) && f.height);
  const video = [...new Set(vids.map(f => f.height))].sort((a, b) => b - a).map(h => {
    const v = top(vids.filter(f => f.height === h), 'tbr');
    return { height: h, label: h + 'p' + (v.fps > 30 ? Math.round(v.fps) : ''), size: size(v) ? size(v) + (hasA(v) ? 0 : bestAudioSize) : 0 };
  });
  const m4a = top(audios.filter(f => f.ext === 'm4a'), 'abr') || top(audios, 'abr');
  const audio = { mp3: info.duration ? Math.round(info.duration * 245000 / 8) : 0, m4a: size(m4a) };
  return { audio, id: info.id, title: info.title || '', uploader: info.uploader || info.channel || '', duration: info.duration || 0, thumb: /^https:/.test(info.thumbnail || '') ? info.thumbnail : '', video, langs };
}

const ytJobs = new Map();
let ytWin = null;
const sendYt = m => { if (ytWin && !ytWin.isDestroyed()) ytWin.webContents.send('msg', m); };

function openYtPanel(url) {
  const cb = win.getContentBounds(), W = 430, H = 580;
  const hash = encodeURIComponent(url);
  if (ytWin && !ytWin.isDestroyed()) { ytWin.loadFile('ytdl.html', { hash }); ytWin.show(); ytWin.focus(); return; }
  ytWin = new BrowserWindow({ parent: win, x: Math.max(cb.x, cb.x + cb.width - W - 18), y: cb.y + 100, width: W, height: H, frame: false, resizable: false,
    minimizable: false, maximizable: false, skipTaskbar: true, show: false, title: 'Download',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#252b3a' : '#ffffff',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  ytWin.setMenu(null);
  ytWin.once('ready-to-show', () => ytWin && ytWin.show());
  ytWin.on('closed', () => { ytWin = null; });
  ytWin.loadFile('ytdl.html', { hash });
}

ipcMain.on('ytdl:open', e => { // sent by the floating Download button, only from a YouTube video page's top frame
  const f = e.senderFrame;
  if (!f || f !== e.sender.mainFrame || !/^https:\/\/(www\.|m\.)?youtube\.com\//.test(f.url)) return;
  const u = canonYt(f.url);
  if (u) openYtPanel(u);
});

async function ytInfo(url) {
  const u = (testMode() && process.env.SH_YT_OVERRIDE) || canonYt(url);
  if (!u) return { error: 'This is not a YouTube video page.' };
  if (toolsMissing().length) return { error: 'tools' };
  if (!testMode()) { // keep yt-dlp fresh: YouTube changes often
    const f = toolPath('ytdlp');
    if (Date.now() - fs.statSync(f).mtimeMs > 2 * 864e5) { await ytUpdate(); const n = new Date(); fs.utimesSync(f, n, n); }
  }
  const r = await runYt(['-J', '--no-playlist', '--no-warnings', '--no-colors', '--', u]);
  if (r.code !== 0 || !r.out) return { error: friendlyErr(r.err) };
  try { return buildOptions(JSON.parse(r.out)); } catch { return { error: 'Could not read the video details.' }; }
}
const ytUpdate = () => new Promise(res => execFile(toolPath('ytdlp'), ['-U', '--no-colors'], { env: procEnv(), windowsHide: true, timeout: 90000 },
  (err, out) => res({ message: String(out || '').trim().split('\n').pop() || (err ? 'Update failed' : 'Done') })));

function ytStart(o) {
  const url = (testMode() && process.env.SH_YT_OVERRIDE) || canonYt(o.url);
  const mode = ['video', 'mp3', 'm4a'].includes(o.mode) ? o.mode : null, height = Math.round(+o.height) || 0;
  const lang = /^[A-Za-z0-9-]{2,12}$/.test(o.lang || '') && o.lang !== 'und' ? o.lang : '';
  if (!url || !mode || (mode === 'video' && !(height > 0 && height < 10000))) return { error: 'Invalid choice' };
  const ba = lang ? `ba[language=${lang}]` : 'ba';
  const tag = lang && o.tagLang ? ` [${lang}]` : '';
  const out = path.join(app.getPath('downloads'), `%(title).120B [%(id)s]${tag}.%(ext)s`);
  const args = ['--no-playlist', '--no-warnings', '--no-mtime', '--windows-filenames', '--no-colors', '--newline', '--progress',
    '--progress-template', 'download:Q|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'after_move:FILE|%(filepath)s', '--ffmpeg-location', ffLoc(), '-o', out];
  if (mode === 'video') args.push('-f', `bv*[height<=${height}]+${ba}/bv*[height<=${height}]+ba/b[height<=${height}]/b`, '-S', 'res,vcodec:h264,acodec:aac', '--merge-output-format', 'mp4');
  else if (mode === 'mp3') args.push('-f', `${ba}/ba/b`, '-x', '--audio-format', 'mp3', '--audio-quality', '0');
  else args.push('-f', `${ba}[ext=m4a]/${ba}/ba[ext=m4a]/ba/b`, '-x', '--audio-format', 'm4a');
  if (testMode() && process.env.SH_YT_LIMIT) args.push('--limit-rate', process.env.SH_YT_LIMIT);
  args.push('--', url);
  const id = 'j' + Date.now(), job = { id, proc: null, file: '', cancelled: false, base: 0, last: 0, lastTotal: 0, seen: 0, est: Math.max(0, Math.round(+o.size) || 0) };
  const entry = { id, kind: 'yt', name: String(o.title || 'YouTube video').slice(0, 150), path: '', received: 0, total: job.est, state: 'progressing', speed: '', eta: '', error: '', cancel: () => ytCancel(id) };
  downloads.unshift(entry); downloads.length = Math.min(downloads.length, 60);
  ytJobs.set(id, job);
  sendYt({ type: 'job', id, state: 'starting' }); dlChanged();
  runYt(args, {
    timeout: 6 * 3600 * 1000,
    onProc: p => { job.proc = p; },
    onLine: l => {
      if (l.startsWith('Q|')) {
        const [, dlb, tb, te, speed, eta] = l.split('|');
        const got = parseInt(dlb) || 0, st = parseInt(tb) || parseInt(te) || 0;
        if (!job.seen || got < job.last) { if (job.seen) job.base += job.lastTotal || job.last; job.seen++; } // a new stream (audio after video) began
        job.last = got; if (st) job.lastTotal = st;
        entry.received = job.base + got;
        entry.total = Math.max(entry.received, job.seen >= 2 && st ? job.base + st : Math.max(job.est, job.base + st));
        entry.speed = (speed || '').trim().replace(/^Unknown.*$/, ''); entry.eta = (eta || '').trim().replace(/^Unknown$/, '');
        sendYt({ type: 'job', id, state: 'downloading', pct: entry.total ? entry.received / entry.total * 100 : 0, speed: entry.speed, eta: entry.eta });
        dlChanged();
      } else if (l.startsWith('FILE|')) job.file = l.slice(5);
    }
  }).then(r => {
    ytJobs.delete(id);
    if (job.cancelled) { entry.state = 'cancelled'; sendYt({ type: 'job', id, state: 'cancelled' }); }
    else if (r.code === 0 && job.file) {
      entry.state = 'completed'; entry.path = job.file; entry.name = path.basename(job.file);
      try { entry.total = entry.received = fs.statSync(job.file).size; } catch {}
      sendYt({ type: 'job', id, state: 'done', file: job.file });
    } else { entry.state = 'interrupted'; entry.error = friendlyErr(r.err); sendYt({ type: 'job', id, state: 'error', error: entry.error }); }
    dlFinished(entry);
  });
  return { id };
}
function ytCancel(id) {
  const j = ytJobs.get(id); if (!j?.proc) return;
  j.cancelled = true;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(j.proc.pid), '/T', '/F'], { windowsHide: true }, () => {}); else j.proc.kill('SIGTERM');
}

/* ---------- Download bubble (popup under the toolbar's download button) ---------- */
let dlUnseen = 0, dlTimer = null, dlRect = { x: 0, y: 88 }, dcard = null, dcardClosed = 0;
const dlView = d => ({ id: d.id, kind: d.kind, name: d.name, state: d.state, received: d.received, total: d.total, speed: d.speed || '', eta: d.eta || '', error: d.error || '' });
function dlChanged() { // at most every 0.4 s: update the toolbar badge and the open popup
  if (dlTimer) return;
  dlTimer = setTimeout(() => {
    dlTimer = null; push();
    if (dcard && !dcard.isDestroyed()) dcard.webContents.send('msg', { type: 'dl', list: downloads.map(dlView) });
  }, 400);
}
function dlFinished(d) {
  if (d.state === 'completed') { dlUnseen++; try { new Notification({ title: 'Download complete', body: d.name }).show(); } catch {} }
  dlChanged(); push();
}
function showDlCard({ x, y } = dlRect) {
  if (dcard && !dcard.isDestroyed()) { dcard.close(); return; }
  if (Date.now() - dcardClosed < 300) return; // that click is the one that just closed it
  dlUnseen = 0; push();
  const cb = win.getContentBounds(), W = 410;
  dcard = new BrowserWindow({ parent: win, x: Math.max(cb.x, Math.round(cb.x + x - W)), y: Math.round(cb.y + y + 4), width: W, height: 220,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#252b3a' : '#ffffff',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  dcard.setMenu(null);
  dcard.once('ready-to-show', () => dcard && dcard.show());
  dcard.on('blur', () => { if (dcard && !dcard.isDestroyed()) dcard.close(); });
  dcard.on('closed', () => { dcardClosed = Date.now(); dcard = null; });
  dcard.loadFile('dl.html');
}

/* ---------- Live TV (mpv plays inside the browser) ---------- */
const os = require('os'), net = require('net');
const LIVE_URL = page('livetv.html');
const LIVE_OK = /^(https?|rtmps?|rtsp|udp|srt):\/\//i;
const liveCfg = () => (settings.get().live ||= { sources: [], favs: [], separate: false, volume: 100 });
const liveDir = () => { const d = path.join(app.getPath('userData'), 'live'); fs.mkdirSync(d, { recursive: true }); return d; };
const liveCache = {};
const live = { proc: null, sock: null, buf: '', host: null, tabId: 0, rect: null, fs: false, reqId: 0, pend: new Map(), autoPaused: false, timer: null,
  st: { name: '', playing: false, paused: false, buffering: false, mute: false, volume: 100, error: '' } };
const hash10 = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 10);
const getTextUA = async (u, ms = 30000) => { const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(); if (t.length > 80e6) throw new Error('That list is too large'); return t; };

function parseM3U(text) { // channels from an IPTV playlist (#EXTINF ... then the stream link)
  const out = []; let cur = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim(); if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const a = {}; line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => (a[k.toLowerCase()] = v));
      cur = { n: line.slice(line.lastIndexOf(',') + 1).trim() || a['tvg-name'] || 'Channel', g: a['group-title'] || '', l: /^https?:\/\//.test(a['tvg-logo'] || '') ? a['tvg-logo'] : '', ua: '', ref: '' };
    } else if (line.startsWith('#EXTVLCOPT:') && cur) {
      const m = /^#EXTVLCOPT:http-(user-agent|referrer|referer)=(.*)$/i.exec(line);
      if (m) { if (/user/i.test(m[1])) cur.ua = m[2]; else cur.ref = m[2]; }
    } else if (line[0] !== '#' && cur) {
      let u = line; const bar = u.indexOf('|');
      if (bar > 0 && /^https?:/i.test(u)) { // Kodi style: link|User-Agent=..&Referer=..
        for (const p of u.slice(bar + 1).split('&')) { const [k, ...v] = p.split('='), val = decodeURIComponent(v.join('=')); if (/^user-agent$/i.test(k)) cur.ua = val; else if (/^referer$/i.test(k)) cur.ref = val; }
        u = u.slice(0, bar);
      }
      if (LIVE_OK.test(u)) out.push({ ...cur, k: hash10(u + out.length), u });
      cur = null;
    }
  }
  return out;
}

const stBase = u => u.replace(/\/manifest\.json(\?.*)?$/i, '');
async function stremioChannels(src) { // Stremio add-on: channels come from its catalogs
  const man = JSON.parse(await getTextUA(src.url)), base = stBase(src.url), out = [], seen = new Set();
  for (const cat of (man.catalogs || []).slice(0, 12)) {
    const req = (cat.extra || []).filter(e => e.isRequired);
    let extra = '';
    if (req.length) { if (req.every(e => Array.isArray(e.options) && e.options.length)) extra = req.map(e => `${e.name}=${encodeURIComponent(e.options[0])}`).join('&'); else continue; }
    for (let skip = 0, pg = 0; pg < 5; pg++) {
      const ex = [extra, skip ? 'skip=' + skip : ''].filter(Boolean).join('&');
      let j; try { j = JSON.parse(await getTextUA(`${base}/catalog/${cat.type}/${cat.id}${ex ? '/' + ex : ''}.json`)); } catch { break; }
      const metas = j.metas || []; if (!metas.length) break;
      for (const m of metas) {
        const k = hash10(`${cat.type}|${m.id}`); if (seen.has(k)) continue; seen.add(k);
        const pic = m.logo || m.poster || '';
        out.push({ k, n: String(m.name || m.id), g: cat.name || cat.type, l: /^https:\/\//.test(pic) ? pic : '', x: { type: m.type || cat.type, id: m.id } });
      }
      skip += metas.length; if (metas.length < 20) break;
    }
  }
  return out;
}
async function stremioStream(src, x) {
  const j = JSON.parse(await getTextUA(`${stBase(src.url)}/stream/${x.type}/${encodeURIComponent(x.id)}.json`));
  const s = (j.streams || []).find(z => LIVE_OK.test(z.url || ''));
  if (!s) throw new Error('This add-on gave no playable link (torrent-only and external links are not supported yet)');
  const rq = (s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.proxyHeaders.request) || {};
  return { url: s.url, ua: rq['User-Agent'] || rq['user-agent'] || '', ref: rq.Referer || rq.referer || '',
    headers: Object.entries(rq).filter(([k]) => !/^(user-agent|referer)$/i.test(k)).map(([k, v]) => `${k}: ${v}`) };
}

async function liveLoad(src, force) {
  if (liveCache[src.id] && !force) return liveCache[src.id];
  const f = path.join(liveDir(), src.id + '.json');
  if (!force) { try { if (Date.now() - fs.statSync(f).mtimeMs < 12 * 3600e3) return (liveCache[src.id] = JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {} }
  let list;
  try {
    if (src.type === 'm3u') list = parseM3U(await getTextUA(src.url));
    else if (src.type === 'stremio') list = await stremioChannels(src);
    else list = [{ k: hash10(src.url), n: src.name, g: '', l: '', u: src.url }];
  } catch (e) { try { return (liveCache[src.id] = JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {} throw e; }
  liveCache[src.id] = list; try { fs.writeFileSync(f, JSON.stringify(list)); } catch {}
  return list;
}

async function liveAdd(raw, name) {
  const url = String(raw || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Paste a link that starts with http:// or https://');
  let text = ''; try { text = await getTextUA(url, 40000); } catch (e) { text = ''; if (/\.(m3u8?|ts|mpd|flv)(\?|$)/i.test(url)) text = '#EXT-X-TARGETDURATION'; else throw new Error('Could not open that link (' + (e.message || e) + ')'); }
  let type = '';
  if (text.trim()[0] === '{') { try { const j = JSON.parse(text); if (j.resources || j.catalogs) type = 'stremio'; } catch {} }
  else if (/#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(text)) type = 'stream';
  else if (/#EXTINF/.test(text)) type = 'm3u';
  if (!type) throw new Error('This link is not an M3U playlist, a Stremio add-on manifest or a stream');
  let nm = String(name || '').trim().slice(0, 40);
  if (!nm) { try { nm = type === 'stremio' ? JSON.parse(text).name : new URL(url).hostname; } catch { nm = 'My source'; } }
  const src = { id: 's' + Date.now().toString(36), type, name: nm || 'My source', url };
  const list = await liveLoad(src, true);
  if (!list.length) throw new Error('No playable channels were found in that source');
  liveCfg().sources.push(src); settings.save();
  return { id: src.id, name: src.name, type, count: list.length };
}

async function liveList(srcId, q = {}) {
  const src = liveCfg().sources.find(s => s.id === srcId); if (!src) return { total: 0, all: 0, groups: [], items: [] };
  const all = await liveLoad(src), favs = new Set(liveCfg().favs), qq = String(q.q || '').trim().toLowerCase();
  const groups = [...new Set(all.map(c => c.g).filter(Boolean))].sort();
  const list = all.filter(c => (!qq || c.n.toLowerCase().includes(qq)) && (!q.group || c.g === q.group) && (!q.fav || favs.has(srcId + '|' + c.k)));
  return { total: list.length, all: all.length, groups, items: list.slice(+q.offset || 0, (+q.offset || 0) + 300).map(c => ({ k: c.k, n: c.n, g: c.g, l: c.l, f: favs.has(srcId + '|' + c.k) })) };
}

/* -- mpv player, drawn inside a borderless window that sits exactly over the page's video area -- */
function sendLt(m) { const t = tabs.find(x => x.id === live.tabId); if (t && !t.view.webContents.isDestroyed()) t.view.webContents.send('msg', m); }
function livePush() { if (live.timer) return; live.timer = setTimeout(() => { live.timer = null; sendLt({ type: 'lt', st: { ...live.st, fs: live.fs } }); }, 120); }

function ensureLiveHost() {
  if (live.host && !live.host.isDestroyed()) return live.host;
  live.host = new BrowserWindow({ parent: win, frame: false, show: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, backgroundColor: '#000000', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  live.host.setMenu(null);
  live.host.loadURL('data:text/html,<body style="margin:0;background:#000"></body>');
  live.host.on('closed', () => { live.host = null; });
  return live.host;
}
const hwndOf = w => { const b = w.getNativeWindowHandle(); return String(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0)); };

function placeLive() { // keep the video window over the page's video area; hide it when that tab is not in front
  const h = live.host; if (!h || h.isDestroyed() || !win || win.isDestroyed()) return;
  const onTab = !!live.tabId && active === live.tabId && tabs.some(t => t.id === live.tabId);
  if (live.sock && !live.sock.destroyed) {
    if (!onTab && !live.autoPaused && !live.st.paused) { live.autoPaused = true; mpvSend(['set_property', 'pause', true]).catch(() => {}); }
    else if (onTab && live.autoPaused) { live.autoPaused = false; mpvSend(['set_property', 'pause', false]).catch(() => {}); }
  }
  const cb = win.getContentBounds();
  let b = null;
  if (onTab && !win.isMinimized() && !liveCfg().separate) {
    if (live.fs) b = { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
    else if (live.rect && !openPanel) { const r = live.rect; b = { x: Math.round(cb.x + SIDE_W + r.x), y: Math.round(cb.y + CHROME_H + r.y), width: Math.max(1, Math.round(r.w)), height: Math.max(1, Math.round(r.h)) }; }
  }
  if (!b) { if (h.isVisible()) h.hide(); return; }
  h.setBounds(b); if (!h.isVisible()) h.showInactive();
}

function mpvSend(command) {
  return new Promise((res, rej) => {
    if (!live.sock || live.sock.destroyed) return rej(new Error('The player is not running'));
    const id = ++live.reqId; live.pend.set(id, { res, rej });
    live.sock.write(JSON.stringify({ command, request_id: id }) + '\n');
    setTimeout(() => { if (live.pend.delete(id)) rej(new Error('The player did not answer')); }, 8000);
  });
}
function mpvLine(line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.request_id && live.pend.has(m.request_id)) { const p = live.pend.get(m.request_id); live.pend.delete(m.request_id); if (m.error === 'success') p.res(m.data); else p.rej(new Error(m.error)); return; }
  const st = live.st;
  if (m.event === 'property-change') {
    if (m.name === 'pause') st.paused = !!m.data; else if (m.name === 'mute') st.mute = !!m.data;
    else if (m.name === 'volume') st.volume = Math.round(m.data || 0); else if (m.name === 'paused-for-cache') st.buffering = !!m.data;
  } else if (m.event === 'start-file') { st.playing = false; st.buffering = true; st.error = ''; }
  else if (m.event === 'file-loaded') { st.playing = true; st.buffering = false; st.error = ''; }
  else if (m.event === 'end-file') { st.playing = false; st.buffering = false; if (m.reason === 'error') st.error = 'This stream could not be played' + (m.file_error ? ' (' + m.file_error + ')' : ''); }
  else if (m.event === 'client-message' && m.args && m.args[0] === 'quark') { if (m.args[1] === 'fs') liveFs(!live.fs); else if (m.args[1] === 'esc' && live.fs) liveFs(false); }
  livePush();
}
function connectPipe(pipe, proc) {
  return new Promise((res, rej) => {
    const t0 = Date.now(); let dead = false;
    proc.once('exit', () => { dead = true; });
    const tryOnce = () => {
      if (dead) return rej(new Error('The player closed right after starting'));
      if (Date.now() - t0 > 8000) return rej(new Error('The player did not start'));
      const s = net.connect(pipe);
      s.once('connect', () => res(s));
      s.once('error', () => setTimeout(tryOnce, 150));
    };
    tryOnce();
  });
}

async function ensureMpv() {
  if (live.proc && live.sock && !live.sock.destroyed) return;
  const exe = toolPath('mpv');
  if (!fs.existsSync(exe)) throw new Error('The player (mpv) is not installed yet');
  const sep = liveCfg().separate;
  let hwnd = '';
  if (!sep) { const h = ensureLiveHost(); placeLive(); hwnd = hwndOf(h); }
  const id = crypto.randomBytes(6).toString('hex');
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\quark-mpv-${id}` : path.join(os.tmpdir(), `quark-mpv-${id}.sock`);
  const conf = path.join(liveDir(), 'input.conf');
  fs.writeFileSync(conf, 'f script-message quark fs\nESC script-message quark esc\nMBTN_LEFT_DBL script-message quark fs\n');
  const args = ['--no-config', '--idle=yes', '--force-window=yes', '--keep-open=yes', `--input-ipc-server=${pipe}`, `--input-conf=${conf}`,
    '--hwdec=auto-safe', '--cache=yes', '--cache-secs=30', '--demuxer-readahead-secs=20', '--demuxer-max-bytes=96MiB', '--network-timeout=20',
    '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5', '--audio-display=no', '--sub-auto=no', '--osd-level=1',
    `--user-agent=${UA}`, `--volume=${liveCfg().volume || 100}`, '--title=Quark Live TV', '--msg-level=all=error'];
  if (testMode() && process.env.SH_MPV_VO) args.push('--vo=' + process.env.SH_MPV_VO);
  if (testMode() && process.env.SH_MPV_AO) args.push('--ao=' + process.env.SH_MPV_AO);
  if (sep) args.push('--osc=yes'); else args.push('--osc=no', '--no-border', '--wid=' + hwnd);
  const proc = spawn(exe, args, { env: procEnv(), windowsHide: false, stdio: 'ignore' });
  live.proc = proc; live.args = args;
  proc.on('exit', () => { if (live.proc === proc) { live.proc = null; if (live.sock) live.sock.destroy(); live.sock = null; live.st.playing = false; live.st.buffering = false; livePush(); } });
  proc.on('error', () => { live.st.error = 'Could not start the player'; livePush(); });
  try { live.sock = await connectPipe(pipe, proc); } catch (e) { try { proc.kill(); } catch {} live.proc = null; throw e; }
  live.buf = '';
  live.sock.on('data', d => { live.buf += d; let i; while ((i = live.buf.indexOf('\n')) >= 0) { mpvLine(live.buf.slice(0, i)); live.buf = live.buf.slice(i + 1); } });
  live.sock.on('close', () => { live.sock = null; });
  live.sock.on('error', () => {});
  let n = 0;
  for (const p of ['pause', 'mute', 'volume', 'paused-for-cache']) await mpvSend(['observe_property', ++n, p]).catch(() => {});
}

async function livePlay(srcId, key) {
  const src = liveCfg().sources.find(s => s.id === srcId); if (!src) throw new Error('That source was removed');
  const c = (await liveLoad(src)).find(x => x.k === key); if (!c) throw new Error('Channel not found');
  let url = c.u, hd = { ua: c.ua || '', ref: c.ref || '', headers: [] };
  live.st = { ...live.st, name: c.n, error: '', playing: false, buffering: true };
  livePush();
  if (c.x) { const r = await stremioStream(src, c.x); url = r.url; hd = { ua: r.ua, ref: r.ref, headers: r.headers }; }
  if (!LIVE_OK.test(url || '')) throw new Error('This link type is not supported');
  await ensureMpv();
  await mpvSend(['set_property', 'user-agent', hd.ua || UA]);
  await mpvSend(['set_property', 'referrer', hd.ref || '']);
  await mpvSend(['set_property', 'http-header-fields', hd.headers || []]);
  await mpvSend(['loadfile', url, 'replace']);
  await mpvSend(['set_property', 'pause', false]);
}

function liveFs(on) { live.fs = !!on; win.setFullScreen(live.fs); setTimeout(placeLive, 80); livePush(); }
function liveStop(kill) {
  if (kill) { try { live.proc && live.proc.kill(); } catch {} live.proc = null; if (live.sock) live.sock.destroy(); live.sock = null; live.tabId = 0; live.rect = null; live.autoPaused = false; }
  else mpvSend(['stop']).catch(() => {});
  if (live.fs) { live.fs = false; if (win && !win.isDestroyed()) win.setFullScreen(false); }
  live.st = { ...live.st, name: kill ? '' : live.st.name, playing: false, buffering: false };
  if (live.host && !live.host.isDestroyed()) live.host.hide();
  if (kill) push();
}
app.on('before-quit', () => liveStop(true));

function openLiveTv() {
  const t = tabs.find(x => x.view.webContents.getURL().startsWith(LIVE_URL));
  if (openPanel) showPanel(null);
  if (t) switchTab(t.id); else newTab(LIVE_URL, { profile: 'default' });
}

async function findGhAsset(repo, re) { // latest GitHub release file + its SHA-256 (read from the release page, no API quota)
  const r = await fetch(`https://github.com/${repo}/releases/latest`, { signal: AbortSignal.timeout(30000) });
  const tag = r.url.split('/tag/')[1];
  const html = await getText(`https://github.com/${repo}/releases/expanded_assets/${tag}`);
  for (const block of html.split(/<li\b/)) {
    const h = [...block.matchAll(/href="([^"]+)"/g)].map(x => x[1]).find(u => re.test(u)), d = block.match(/sha256:([a-f0-9]{64})/);
    if (h && d) return { url: 'https://github.com' + h, sha: d[1] };
  }
  throw new Error('Could not find the download for ' + repo);
}
async function installMpv(report) {
  const dir = toolsDir(); fs.mkdirSync(dir, { recursive: true });
  const fetchChecked = async (a, tmp, rep) => { await downloadTo(a.url, tmp, rep); if ((await sha256(tmp)) !== a.sha.toLowerCase()) { fs.rmSync(tmp, { force: true }); throw new Error('A download failed the safety check, so it was not installed'); } };
  if (!fs.existsSync(toolPath('7zr'))) { const a = await findGhAsset('ip7z/7zip', /\/7zr\.exe$/), tmp = path.join(dir, '7zr.part'); await fetchChecked(a, tmp); fs.renameSync(tmp, path.join(dir, '7zr' + EXE)); }
  const a = await findGhAsset('shinchiro/mpv-winbuild-cmake', /\/mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/), tmp = path.join(dir, 'mpv.part');
  await fetchChecked(a, tmp, report);
  const work = path.join(dir, 'unpack-mpv'); fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  await new Promise((res, rej) => execFile(toolPath('7zr'), ['x', tmp, '-o' + work, '-y', 'mpv.exe', 'd3dcompiler_43.dll'], { windowsHide: true, maxBuffer: 1 << 24 }, err => err ? rej(err) : res()));
  const exe = findFile(work, 'mpv.exe'); if (!exe) throw new Error('The player file was missing from the download');
  fs.copyFileSync(exe, path.join(dir, 'mpv' + EXE));
  const dll = findFile(work, 'd3dcompiler_43.dll'); if (dll) fs.copyFileSync(dll, path.join(dir, 'd3dcompiler_43.dll'));
  fs.rmSync(tmp, { force: true }); fs.rmSync(work, { recursive: true, force: true });
}

/* ---------- Sidebar ---------- */
function showPanel(id) {
  if (openPanel && panels[openPanel]) win.contentView.removeChildView(panels[openPanel]);
  openPanel = id;
  if (id) { lastPanel = id; win.contentView.addChildView(panels[id]); }
  layout(); push();
  (id ? panels[id].webContents : cur())?.focus();
}

function togglePanel(id) {
  if (id === 'livetv') { openLiveTv(); return; }
  if (openPanel === id) return showPanel(null);
  const it = side().find(s => s.id === id); if (!it) return;
  if (!panels[id]) {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }), wc = view.webContents;
    panels[id] = view;
    wc.setWebRTCIPHandlingPolicy('default_public_interface_only');
    wc.setWindowOpenHandler(openHandler);
    wc.on('page-favicon-updated', (_, icons) => {
      if (icons[0] && it.icon !== icons[0]) { it.icon = icons[0]; settings.save(); push(); }
    });
    wc.loadURL(it.url);
  }
  showPanel(id);
}

function addSide(s) {
  const raw = String(s).trim(); if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  let host; try { host = new URL(url).hostname; } catch { return; }
  if (!host.includes('.')) return;
  const n = host.replace(/^(www|web|app)\./, '').split('.')[0];
  const hue = [...host].reduce((a, c) => a + c.charCodeAt(0), 0) * 37 % 360;
  const it = { id: 's' + Date.now(), name: n[0].toUpperCase() + n.slice(1), url, color: `hsl(${hue} 55% 42%)` };
  side().push(it); settings.save();
  togglePanel(it.id);
}

function removeSide(id) {
  const list = side(), i = list.findIndex(s => s.id === id);
  if (i < 0) return;
  list.splice(i, 1); settings.save();
  if (openPanel === id) showPanel(null);
  if (lastPanel === id) lastPanel = null;
  if (panels[id]) { panels[id].webContents.close(); delete panels[id]; }
  push();
}

function sideMenu(id) {
  const it = side().find(s => s.id === id); if (!it) return;
  Menu.buildFromTemplate([
    { label: 'Open in new tab', click: () => (id === 'livetv' ? openLiveTv() : newTab(it.url)) },
    { label: 'Remove from sidebar', click: () => removeSide(id) }
  ]).popup({ window: win });
}

function addDialog(mode = 'sidebar') {
  const d = new BrowserWindow({ parent: win, modal: true, width: 440, height: 190, resizable: false,
    minimizable: false, maximizable: false, title: 'Add to sidebar', icon: ICON, backgroundColor: '#171b24',
    webPreferences: { preload: PRELOAD } });
  d.setMenu(null);
  if (mode === 'profile') d.on('closed', () => { pendingGmail = false; });
  d.loadFile('add.html', { hash: mode });
}

/* ---------- Home page shortcuts ---------- */
function refreshNewtabs() { tabs.forEach(t => { if (t.view.webContents.getURL() === NEWTAB) t.view.webContents.reload(); }); }

function addShortcut(s) {
  const raw = String(s).trim(); if (!raw) return;
  const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  let host; try { host = new URL(url).hostname; } catch { return; }
  if (!host.includes('.')) return;
  const n = host.replace(/^(www|web|app)\./, '').split('.')[0];
  const hue = [...host].reduce((a, c) => a + c.charCodeAt(0), 0) * 37 % 360;
  shortcuts().push({ name: n[0].toUpperCase() + n.slice(1), url, color: `hsl(${hue} 55% 42%)` });
  settings.save(); refreshNewtabs();
}

function shortcutMenu(i) {
  const it = shortcuts()[i]; if (!it) return;
  Menu.buildFromTemplate([
    { label: 'Open in new tab', click: () => newTab(it.url) },
    { label: 'Remove shortcut', click: () => { shortcuts().splice(i, 1); settings.save(); refreshNewtabs(); } }
  ]).popup({ window: win });
}

/* ---------- Extensions ---------- */
let extensions;
const extDir = () => path.join(app.getPath('userData'), 'Extensions');
const tabOf = wc => tabs.find(t => t.view.webContents === wc);

function setupExtensions(ses) {
  extensions = new ElectronChromeExtensions({
    session: ses,
    createTab: async d => { newTab(d.url || NEWTAB, { profile: 'default' }); return [cur(), win]; },
    selectTab: wc => { const t = tabOf(wc); if (t) switchTab(t.id); },
    removeTab: wc => { const t = tabOf(wc); if (t) closeTab(t.id); },
    createWindow: async () => win
  });
  ElectronChromeExtensions.handleCRXProtocol(ses);
}

async function loadExtensions(ses) {
  try { await installChromeWebStore({ session: ses, extensionsPath: extDir(), beforeInstall: confirmInstall }); } catch (e) { console.error('Web Store:', e.message); }
  const st = settings.get(), off = st.extOff || [];
  for (const p of st.unpacked || []) {
    if (off.some(o => o.path === p)) continue;
    try { await ses.extensions.loadExtension(p, { allowFileAccess: true }); } catch (e) { console.error('Extension failed:', p, e.message); }
  }
  for (const o of off) if (ses.extensions.getExtension(o.id)) await ses.extensions.removeExtension(o.id);
  push();
}

function extList() {
  const on = session.defaultSession.extensions.getAllExtensions().map(e =>
    ({ id: e.id, name: e.name, version: e.version, description: e.manifest?.description || '', enabled: true }));
  return [...on, ...(settings.get().extOff || []).map(o => ({ id: o.id, name: o.name, version: o.version, description: '', enabled: false }))];
}

async function extAction(what, a) {
  const ses = session.defaultSession, st = settings.get();
  try {
    if (what === 'extInstall') {
      const id = (String(a).match(/[a-p]{32}/) || [])[0];
      if (!id) return { error: 'Paste an extension ID or a Chrome Web Store link.' };
      const ok = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Install extension'], defaultId: 0, cancelId: 0,
        message: 'Install this extension?', detail: `Extension ID: ${id}\n\nExtensions can read and change the pages you visit, including your email. Only install extensions you trust.` });
      if (ok.response !== 1) return {};
      await installExtension(id, { session: ses, extensionsPath: extDir() });
    } else if (what === 'extUnpacked') {
      const r = await dialog.showOpenDialog(win, { title: 'Choose the extension folder', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return {};
      await ses.extensions.loadExtension(r.filePaths[0], { allowFileAccess: true });
      st.unpacked = [...new Set([...(st.unpacked || []), r.filePaths[0]])]; settings.save();
    } else if (what === 'extToggle') {
      const e = ses.extensions.getExtension(a);
      if (e) {
        st.extOff = [...(st.extOff || []), { id: e.id, name: e.name, version: e.version, path: e.path }]; settings.save();
        await ses.extensions.removeExtension(e.id);
      } else {
        const o = (st.extOff || []).find(x => x.id === a);
        if (o) { st.extOff = st.extOff.filter(x => x.id !== a); settings.save(); await ses.extensions.loadExtension(o.path, { allowFileAccess: true }); }
      }
    } else if (what === 'extRemove') {
      const e = ses.extensions.getExtension(a), o = (st.extOff || []).find(x => x.id === a), p = e?.path || o?.path || '';
      st.extOff = (st.extOff || []).filter(x => x.id !== a);
      st.unpacked = (st.unpacked || []).filter(x => x !== p);
      settings.save();
      if (p.startsWith(extDir())) await uninstallExtension(a, { session: ses, extensionsPath: extDir() });
      else if (e) await ses.extensions.removeExtension(a);
    }
  } catch (err) { return { error: String(err.message || err) }; }
  push();
  return {};
}

/* ---------- IPC ---------- */
ipcMain.on('cmd', (e, c, a) => {
  if (!trusted(e)) return;
  const wc = cur();
  switch (c) {
    case 'go': wc?.loadURL(gate(toUrl(String(a)))); break;
    case 'proceed': proceed(wc, a); break;
    case 'back': wc?.navigationHistory.goBack(); break;
    case 'forward': wc?.navigationHistory.goForward(); break;
    case 'reload': if (wc) { if (wc.isLoading()) wc.stop(); else wc.reload(); } break;
    case 'new': newTab(); break;
    case 'close': closeTab(a); break;
    case 'switch': switchTab(a); break;
    case 'star': toggleBookmark(); break;
    case 'shield': toggleAdblock(); break;
    case 'internal': openInternal(a); break;
    case 'menu': showMenu(a); break;
    case 'home': wc?.loadURL(NEWTAB); break;
    case 'profile': showProfileCard(a); break;
    case 'pm': {
      const k = a?.k, t = tab();
      if (pcard && !pcard.isDestroyed()) pcard.close();
      if (k === 'tab') newTab(NEWTAB, { profile: a.id });
      else if (k === 'add') addGmailFlow(t);
      else if (k === 'new') addDialog('profile');
      else if (k === 'gmail') newTab('https://mail.google.com');
      else if (k === 'acct') newTab('https://myaccount.google.com');
      else if (k === 'manage') openInternal('settings');
      break;
    }
    case 'dlcard': showDlCard(a && isFinite(a.x) && isFinite(a.y) ? { x: +a.x, y: +a.y } : dlRect); break;
    case 'dlrect': if (a && isFinite(a.x) && isFinite(a.y)) dlRect = { x: +a.x, y: +a.y }; break;
    case 'dlcardSize': if (dcard && !dcard.isDestroyed() && e.sender === dcard.webContents) dcard.setContentSize(410, Math.min(Math.max(Math.round(+a) || 120, 120), 560)); break;
    case 'dlAct': {
      const d = downloads.find(x => x.id === a?.id); if (!d) break;
      const inDl = d.path && path.resolve(d.path).startsWith(path.resolve(app.getPath('downloads')));
      if (a.k === 'open' && d.state === 'completed' && inDl) shell.openPath(d.path);
      else if (a.k === 'show' && inDl) shell.showItemInFolder(d.path);
      else if (a.k === 'cancel' && d.state === 'progressing') d.cancel();
      break;
    }
    case 'pcardSize': if (pcard && !pcard.isDestroyed() && e.sender === pcard.webContents) pcard.setContentSize(340, Math.min(Math.max(Math.round(+a) || 200, 160), 660)); break;
    case 'google': addGmailFlow(tab()); break;
    case 'pfNew': addDialog('profile'); break;
    case 'checkUpdates': checkUpdates(true); break;
    case 'ltStage': { const t = tabs.find(x => x.view.webContents.id === e.sender.id); if (t && a && isFinite(a.x + a.y + a.w + a.h)) { live.tabId = t.id; live.rect = { x: +a.x, y: +a.y, w: +a.w, h: +a.h }; placeLive(); } break; }
    case 'ltCtl': {
      const k = a && a.k;
      if (k === 'pause') mpvSend(['cycle', 'pause']).catch(() => {});
      else if (k === 'mute') mpvSend(['cycle', 'mute']).catch(() => {});
      else if (k === 'vol') { const v = Math.max(0, Math.min(130, Math.round(+a.v) || 0)); liveCfg().volume = v; settings.save(); mpvSend(['set_property', 'volume', v]).catch(() => {}); }
      else if (k === 'fs') liveFs(!live.fs);
      else if (k === 'stop') { liveStop(false); livePush(); }
      break;
    }
    case 'ytShow': if (typeof a === 'string' && path.resolve(a).startsWith(path.resolve(app.getPath('downloads')))) shell.showItemInFolder(a); break;
    case 'ytClose': if (ytWin && !ytWin.isDestroyed() && e.sender === ytWin.webContents) ytWin.close(); break;
    case 'pfAdd': { const gm = pendingGmail, p = addProfile(a); BrowserWindow.fromWebContents(e.sender)?.close(); if (p) newTab(gm ? GOOGLE_LOGIN : NEWTAB, { profile: p.id }); break; }
    case 'exitDo': {
      const st = settings.get(), o = { cookies: !!a?.cookies, history: !!a?.history, cache: !!a?.cache };
      if (a?.remember) { st.exitAsk = false; st.exitAuto = o; } settings.save();
      BrowserWindow.fromWebContents(e.sender)?.close(); finishExit(o); break;
    }
    case 'exitCancel': BrowserWindow.fromWebContents(e.sender)?.close(); break;
    case 'side': togglePanel(a); break;
    case 'sideToggle': if (openPanel) showPanel(null); else { const id = lastPanel || side()[0]?.id; if (id) togglePanel(id); } break;
    case 'sideAdd': addDialog(); break;
    case 'scNew': addDialog('shortcut'); break;
    case 'scAdd': addShortcut(a); BrowserWindow.fromWebContents(e.sender)?.close(); break;
    case 'scMenu': shortcutMenu(a); break;
    case 'sideMenu': sideMenu(a); break;
    case 'sbAdd': addSide(a); BrowserWindow.fromWebContents(e.sender)?.close(); break;
  }
});

const pf = e => (tabs.find(t => t.view.webContents.id === e.sender.id) || tab() || {}).profile || 'default';
ipcMain.handle('data', (e, what, a) => {
  if (!trusted(e)) return [];
  const d = downloads[a];
  switch (what) {
    case 'history': return hist(pf(e)).get();
    case 'profiles': return profiles();
    case 'pcard': return cardData(false);
    case 'pcardRefresh': return cardData(true);
    case 'profileDel': return profileDelete(a);
    case 'perms': return Object.entries(perms()).flatMap(([o, m]) => Object.entries(m).map(([p, v]) => ({ origin: o, perm: p, value: v })));
    case 'permReset': {
      if (a === 'all') settings.get().perms = {};
      else { const [o, p] = String(a).split('|'); if (perms()[o]) { delete perms()[o][p]; if (!Object.keys(perms()[o]).length) delete perms()[o]; } }
      settings.save(); break;
    }
    case 'getExit': return { ask: settings.get().exitAsk !== false, auto: settings.get().exitAuto || {} };
    case 'setExitAsk': settings.get().exitAsk = !!a; if (!a) settings.get().exitAuto = {}; settings.save(); break;
    case 'about': return { version: app.getVersion(), built: new Date(BUILT).toDateString(), age: ageDays(), chromium: process.versions.chrome, electron: process.versions.electron };
    case 'getTheme': return theme();
    case 'shortcuts': return shortcuts();
    case 'ytTools': return { ready: toolsMissing().length === 0, missing: toolsMissing().map(k => TOOL_INFO[k]) };
    case 'ytInstall': return (async () => { try { for (const n of toolsMissing()) await installTool(n, (got, total) => sendYt({ type: 'install', tool: TOOL_INFO[n].name, got, total })); return {}; } catch (err) { return { error: String(err.message || err) }; } })();
    case 'ytInfo': return ytInfo(a);
    case 'ytStart': { const r = ytStart(a || {}); if (!r.error) setTimeout(() => { if (ytWin && !ytWin.isDestroyed()) ytWin.close(); setTimeout(() => showDlCard(dlRect), 250); }, 800); return r; }
    case 'dlList': return downloads.map(dlView);
    case 'dlClear': { for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing') downloads.splice(i, 1); dlChanged(); return downloads.map(dlView); }
    case 'ytCancel': ytCancel(a); break;
    case 'ytUpdate': return ytUpdate();
    case 'ltInit': { const t = tabs.find(x => x.view.webContents.id === e.sender.id); if (t) live.tabId = t.id; placeLive(); return { mpv: fs.existsSync(toolPath('mpv')), sources: liveCfg().sources.map(s => ({ id: s.id, name: s.name, type: s.type })), separate: !!liveCfg().separate, st: { ...live.st, fs: live.fs } }; }
    case 'ltInstall': return (async () => { try { await installMpv((got, total) => sendLt({ type: 'lt-install', got, total })); return {}; } catch (err) { return { error: String(err.message || err) }; } })();
    case 'ltAdd': return liveAdd(a && a.url, a && a.name).then(r => r, err => ({ error: String(err.message || err) }));
    case 'ltRemove': { const L = liveCfg(); L.sources = L.sources.filter(x => x.id !== a); delete liveCache[a]; try { fs.rmSync(path.join(liveDir(), a + '.json'), { force: true }); } catch {} settings.save(); break; }
    case 'ltRefresh': return liveLoad(liveCfg().sources.find(x => x.id === a) || {}, true).then(l => ({ count: l.length }), err => ({ error: String(err.message || err) }));
    case 'ltChannels': return liveList(a && a.src, a || {}).catch(err => ({ error: String(err.message || err), total: 0, all: 0, groups: [], items: [] }));
    case 'ltFav': { const k = a.src + '|' + a.k, F = liveCfg().favs, i = F.indexOf(k); if (i >= 0) F.splice(i, 1); else F.push(k); settings.save(); break; }
    case 'ltPlay': return livePlay(a && a.src, a && a.k).then(() => ({}), err => { live.st.error = String(err.message || err); livePush(); return { error: live.st.error }; });
    case 'ltMode': liveCfg().separate = !!a; settings.save(); liveStop(false); if (live.proc) { try { live.proc.kill(); } catch {} } placeLive(); break;
    case 'getYt': return !!settings.get().ytAds;
    case 'setYt': settings.get().ytAds = !!a; settings.save(); break;
    case 'getDark': return settings.get().darkSites !== false;
    case 'setDark': settings.get().darkSites = !!a; settings.save(); break;
    case 'extList': return extList();
    case 'extInstall': case 'extUnpacked': case 'extToggle': case 'extRemove': return extAction(what, a);
    case 'setTheme': setTheme(a); break;
    case 'bookmarks': return bookmarks.get();
    case 'downloads': return downloads.map(({ name, received, total, state }) => ({ name, received, total, state }));
    case 'clearHistory': { const h = hist(pf(e)); h.get().length = 0; h.save(); break; }
    case 'rmBookmark': { const b = bookmarks.get(), k = b.findIndex(x => x.url === a); if (k >= 0) b.splice(k, 1); bookmarks.save(); push(); break; }
    case 'dlOpen': if (d?.state === 'completed') shell.openPath(d.path); break;
    case 'dlShow': if (d) shell.showItemInFolder(d.path); break;
    case 'dlCancel': if (d?.state === 'progressing') d.cancel(); break;
  }
  return [];
});

/* ---------- Start ---------- */
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const ses = ensureSession('default');
  setupExtensions(ses);
  createWindow();
  loadExtensions(ses);
  setupAdblock().catch(err => console.error('Ad blocker failed to load:', err));
  loadBadHosts().catch(() => {});
  setTimeout(staleWarning, 4000);
  setTimeout(() => { const t = new Date().toDateString(); if (settings.get().lastUpd !== t) { settings.get().lastUpd = t; settings.save(); checkUpdates(false); } }, 20000);
});
app.on('window-all-closed', () => app.quit());
