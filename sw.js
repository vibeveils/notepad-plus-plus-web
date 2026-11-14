// Offline cache for the Notepad++ web build. Bump VERSION when deploying.
const VERSION = 'npp-web-v2';
const CORE = ['./', 'index.html', 'npp.js', 'npp.wasm', 'css/npp.css', 'css/sci.css', 'favicon.png',
  'js/app.js', 'js/version.js', 'js/config.js', 'js/encoding.js', 'js/find.js', 'js/md5.js', 'js/mobile.js', 'js/sci-consts.js', 'js/sciview.js', 'js/storage.js', 'js/ui.js',
  'config/langs.xml', 'config/stylers.xml', 'config/languages.json', 'config/themes/index.json', 'config/rgba_icons.json',
  'img/npp-256.png', 'img/chameleon.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (so deployments show up), falling back to the cache when offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
