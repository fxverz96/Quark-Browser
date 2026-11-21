const { contextBridge, ipcRenderer: ipc } = require('electron');
// Only Quark's own pages (local files) get the API; websites never see it.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('hub', {
    cmd: (c, a) => ipc.send('cmd', c, a),
    data: (w, a) => ipc.invoke('data', w, a),
    onState: fn => ipc.on('state', (_, s) => fn(s)),
    onFocusUrl: fn => ipc.on('focus-url', () => fn()),
    onMsg: fn => ipc.on('msg', (_, m) => fn(m))
  });
}

// Same Firefox identity on the JavaScript side for Google's sign-in pages, so it matches the request headers
if (/^accounts\.(google|youtube)\.com$/.test(location.hostname)) {
  const win = process.platform === 'win32', mac = process.platform === 'darwin';
  const ua = `Mozilla/5.0 (${win ? 'Windows NT 10.0; Win64; x64' : mac ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64'}; rv:140.0) Gecko/20100101 Firefox/140.0`;
  contextBridge.executeInMainWorld({
    func: (ua, appVersion) => {
      const d = (k, v) => { try { Object.defineProperty(navigator, k, { get: () => v, configurable: true }); } catch {} };
      d('userAgent', ua); d('appVersion', appVersion); d('vendor', ''); d('productSub', '20100101'); d('userAgentData', undefined);
      try { delete window.chrome; } catch {}
    },
    args: [ua, '5.0 (' + (win ? 'Windows' : mac ? 'Macintosh' : 'X11') + ')']
  });
}

// Floating "Download" button on YouTube video pages (drawn by the browser, not by the website)
if (window === window.top && /(^|\.)youtube\.com$/.test(location.hostname)) {
  const tick = () => {
    const ok = location.pathname === '/watch' || location.pathname.startsWith('/shorts/');
    let b = document.getElementById('quark-dl');
    if (!ok) { if (b) b.remove(); return; }
    if (b || !document.body) return;
    b = document.createElement('button');
    b.id = 'quark-dl'; b.type = 'button'; b.textContent = '⬇  Download'; b.title = 'Download this video with Quark';
    b.setAttribute('style', 'all:initial;display:block;position:fixed;top:68px;right:18px;z-index:2147483647;cursor:pointer;font:600 13px "Segoe UI",system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,#22d3ee,#8b5cf6 60%,#f472b6);padding:9px 16px;border-radius:20px;box-shadow:0 4px 18px rgba(0,0,0,.45)');
    b.addEventListener('click', e => { e.stopPropagation(); ipc.send('ytdl:open'); });
    document.body.appendChild(b);
  };
  setInterval(tick, 1000);
  window.addEventListener('DOMContentLoaded', tick);
}
