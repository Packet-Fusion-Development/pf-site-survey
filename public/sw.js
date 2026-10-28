/**
 * Service worker: makes the survey app open with no signal.
 *
 * Online-first throughout. The network is always tried first and the
 * response is what the engineer sees; the cached copy is only used when the
 * network fails, or is so slow (NETWORK_TIMEOUT_MS) that a basement
 * connection would otherwise leave a blank screen.
 *
 * /api/* is deliberately not handled here — the app keeps survey data in
 * IndexedDB itself (js/net.js), where it can also queue writes. Two
 * exceptions are safe to cache: photos (an id never changes content) and
 * floor-plan PDFs, both kept only once they have been viewed.
 *
 * Bump VERSION whenever SHELL changes so installed apps pick up the update.
 */

const VERSION = 'pfss-v6';
const SHELL_CACHE = `${VERSION}-shell`;
const PLANS_CACHE = 'pfss-plans';
const PHOTOS_CACHE = 'pfss-photos';
const NETWORK_TIMEOUT_MS = 4000;

// '/survey', not '/survey.html': Workers Static Assets redirects the .html
// form, and a cached redirect cannot answer a navigation.
const SHELL = [
  '/survey',
  '/survey.css',
  '/survey.js',
  '/style.css',
  '/js/net.js',
  '/js/idb.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/brand/packet-fusion-logo-white.png',
  '/vendor/pdfjs-3.11.174/pdf.min.js',
  '/vendor/pdfjs-3.11.174/pdf.worker.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, PLANS_CACHE, PHOTOS_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Access login/logout and identity must always hit the network.
  if (url.pathname.startsWith('/cdn-cgi/')) return;

  if (url.pathname.startsWith('/api/photos/')) {
    event.respondWith(cacheFirst(request, PHOTOS_CACHE));
  } else if (url.pathname.startsWith('/api/')) {
    return;
  } else if (url.pathname.startsWith('/pdfs/')) {
    // Range requests stream big drawings; only whole-file responses are cached.
    if (request.headers.has('range')) return;
    event.respondWith(networkFirst(request, PLANS_CACHE, { timeoutMs: 0 }));
  } else {
    event.respondWith(networkFirst(request, SHELL_CACHE, { timeoutMs: NETWORK_TIMEOUT_MS }));
  }
});

/** Only plain same-origin 200s are stored — never Access redirects or errors. */
function cacheable(response) {
  return response && response.ok && response.status === 200 && response.type === 'basic';
}

async function networkFirst(request, cacheName, { timeoutMs }) {
  const cache = await caches.open(cacheName);
  const network = fetch(request).then(response => {
    if (cacheable(response)) cache.put(request, response.clone());
    return response;
  });
  // If the cached copy already answered, a later network failure is expected.
  network.catch(() => {});

  // On a slow link, answer from cache after timeoutMs but let the fetch
  // finish in the background so the cache is fresh next time.
  if (timeoutMs > 0) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) {
      const timeout = new Promise(resolve => setTimeout(() => resolve(cached), timeoutMs));
      return Promise.race([network.catch(() => cached), timeout]);
    }
  }

  try {
    return await network;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await caches.match('/survey');
      if (shell) return shell;
    }
    return new Response('Offline and not saved on this device.', { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) cache.put(request, response.clone());
  return response;
}
