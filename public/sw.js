const CACHE_NAME = 'musicflow-v3.0';

// index.html loads app.js with a cache-busting query string. Precaching the
// bare '/js/app.js' produced a cache entry that never matched the real request,
// so the app shell was effectively uncached offline.
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js?v=3.0',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll() rejects the whole install if a single asset 404s, which left
      // the worker stuck on an old version. Cache each asset independently.
      return Promise.all(
        ASSETS.map((asset) => cache.add(asset).catch((err) => {
          console.warn('[sw] could not precache', asset, err && err.message);
        }))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only GET requests can be cached; cache.put() throws on anything else.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never intercept the API, audio streams, downloads, or cross-origin assets.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Range requests (audio seeking) must go straight to the network — a cached
  // 200 response cannot satisfy a partial-content request.
  if (req.headers.has('range')) return;

  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const cacheCopy = networkResponse.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(req, cacheCopy))
            .catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => caches.match(req).then((cached) => {
        if (cached) return cached;
        // Navigations should still land on the app shell when offline.
        if (req.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      }))
  );
});
