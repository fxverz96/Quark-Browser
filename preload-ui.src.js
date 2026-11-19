// Preload for the browser's own window: normal StreamHub API + the <browser-action-list> extension toolbar
require('./preload.js');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');
if (location.pathname.endsWith('/index.html')) injectBrowserAction();
