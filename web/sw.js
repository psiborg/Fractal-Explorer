// Network-first service worker: always fetches fresh files while you develop,
// and falls back to the cached copy when offline.
const CACHE = 'fractal-explorer-v12';
const SHELL = [
  './', 'index.html', 'manifest.json', 'css/app.css', 'js/app.js', 'js/debug.js', 'js/guide.js', 'js/places.js', 'js/insight.js', 'js/windows.js', 'js/about.js',
  'libs/fractal/fractal_explorer.js', 'libs/fractal/fractal_explorer_bg.wasm',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
