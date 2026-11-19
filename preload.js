const { contextBridge, ipcRenderer: ipc } = require('electron');
// Only Quark's own pages (local files) get the API; websites never see it.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('hub', {
    cmd: (c, a) => ipc.send('cmd', c, a),
    data: (w, a) => ipc.invoke('data', w, a),
    onState: fn => ipc.on('state', (_, s) => fn(s)),
    onFocusUrl: fn => ipc.on('focus-url', () => fn())
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
