/* Jalan service worker: app works offline, map tiles served from cache first. */
const SHELL = 'jalan-shell-v1';
const TILES = 'jalan-tiles';
const ASSETS = [
  './', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('jalan-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isTile = url => url.origin !== self.location.origin && /\/\d+\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)(\?|$)/.test(url.pathname + url.search);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) {
    // cache first; tiles you browse online are kept for offline too
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req.url, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req.url, res.clone());
        return res;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    // app shell: serve cached copy instantly, refresh in background
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      const res = await net;
      return res || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
    })());
  }
  // everything else (routing, search) goes straight to the network
});
