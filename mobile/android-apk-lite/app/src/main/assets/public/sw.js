const CACHE_NAME = 'musicflow-v3.5-hyperflow';

const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css?v=3.5',
  '/js/app.js?v=3.5',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
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

self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Audio streams, downloads, or websocket/ranges must bypass cache
  if (url.pathname.startsWith('/api/stream') ||
      url.pathname.startsWith('/api/download') ||
      url.pathname.startsWith('/api/playlist-download') ||
      req.headers.has('range')) {
    return;
  }

  // Stale-While-Revalidate for API search and metadata requests
  if (url.origin === self.location.origin && (url.pathname.startsWith('/api/search') || url.pathname.startsWith('/api/suggestions') || url.pathname.startsWith('/api/recommendations'))) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        const fetchPromise = fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            cache.put(req, networkRes.clone()).catch(() => {});
          }
          return networkRes;
        }).catch(() => cached);

        return cached || fetchPromise;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App shell & static assets: Cache First, falling back to network
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Background revalidate
        fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            caches.open(CACHE_NAME).then((c) => c.put(req, networkRes));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const cacheCopy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, cacheCopy)).catch(() => {});
        }
        return networkResponse;
      }).catch(() => {
        if (req.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      });
    })
  );
});
