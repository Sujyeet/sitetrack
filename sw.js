/* SiteTrack Service Worker */
/* sitetrack-v34 — Real-time GPS: null speed fix, maximumAge 0, visibilitychange restart */

'use strict';

const CACHE = 'sitetrack-v34';
const TILE_CACHE = 'sitetrack-tiles-v1';

const MAX_TILES = 250;        // hard ceiling for tile entries
const EVICT_TO = 220;         // trim back down to this count when ceiling is exceeded

const SHELL = [
  './',
  './index.html',
  './sitetrack.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './safehouse.png',
  './gta-v-death-sound-effect-102.mp3',
  './gta-v-mission-passed.mp3',
  './mission passed.mp4',
  './misson passed.mp4'
];

const CDN = [
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://fonts.cdnfonts.com/css/pricedown'
];

/* Hosts serving map tiles — cache-first into TILE_CACHE */
const TILE_HOSTS = [
  'openfreemap.org',
  'arcgisonline.com'
];

/* Dynamic API hosts — always bypass the SW cache entirely */
const BYPASS_HOSTS = [
  'nominatim.openstreetmap.org',
  'project-osrm.org',
  'routing.openstreetmap.de'
];

const hostMatches = (hostname, patterns) =>
  patterns.some((p) => hostname === p || hostname.endsWith('.' + p));

/* ------------------------------------------------------------------ */
/* INSTALL — precache app shell + CDN assets                           */
/* ------------------------------------------------------------------ */

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Shell assets are same-origin and must all succeed.
      await cache.addAll(SHELL);
      // CDN assets: cache best-effort (no-cors where needed), do not
      // fail the whole install if one CDN hiccups.
      await Promise.all(
        CDN.map(async (url) => {
          try {
            const res = await fetch(url, { mode: 'cors' });
            if (res.ok || res.type === 'opaque') {
              await cache.put(url, res.clone());
            }
          } catch (_) {
            try {
              const res = await fetch(url, { mode: 'no-cors' });
              await cache.put(url, res.clone());
            } catch (_) { /* offline install — CDN filled lazily later */ }
          }
        })
      );
      return self.skipWaiting();
    })
  );
});

/* ------------------------------------------------------------------ */
/* ACTIVATE — purge stale shell caches. NEVER touch TILE_CACHE.        */
/* ------------------------------------------------------------------ */

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE && name !== TILE_CACHE)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

/* ------------------------------------------------------------------ */
/* TILE LRU EVICTION — Pure Cache API circular buffer                  */
/*                                                                     */
/* cache.keys() returns Requests in insertion (FIFO) order, so the     */
/* head of the list is always the oldest tile. No IndexedDB, no        */
/* timestamps, no external libs — zero overhead for budget devices.    */
/* A simple in-flight flag prevents overlapping eviction passes when   */
/* many tiles land at once during fast panning.                        */
/* ------------------------------------------------------------------ */

let evicting = false;

async function evictOldTiles() {
  if (evicting) return;
  evicting = true;
  try {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      const removeCount = keys.length - EVICT_TO;
      const doomed = keys.slice(0, removeCount);
      await Promise.all(doomed.map((req) => cache.delete(req)));
    }
  } catch (_) {
    /* eviction is best-effort; never break tile serving */
  } finally {
    evicting = false;
  }
}

/* ------------------------------------------------------------------ */
/* TILE STRATEGY — cache-first, network fallback, background eviction  */
/* ------------------------------------------------------------------ */

async function tileCacheFirst(e) {
  const cache = await caches.open(TILE_CACHE);

  const cached = await cache.match(e.request);
  if (cached) return cached; // instant offline hit

  const res = await fetch(e.request);

  // Cacheable: standard OK, or opaque cross-origin (status 0), or 200.
  if (res && (res.ok || res.status === 0 || res.status === 200)) {
    const clone = res.clone();
    // Store + evict without delaying the tile response.
    e.waitUntil(
      cache.put(e.request, clone).then(() => evictOldTiles())
    );
  }

  return res;
}

/* ------------------------------------------------------------------ */
/* SHELL STRATEGY — Network-first for HTML pages (so code updates are */
/* immediate upon reload), Cache-first for media/fonts/scripts.       */
/* ------------------------------------------------------------------ */

async function shellCacheFirst(e) {
  // For navigation requests (index.html / sitetrack.html), fetch from network first
  // so users immediately see new code pushes on reload, falling back to cache if offline.
  if (e.request.mode === 'navigate') {
    try {
      const networkRes = await fetch(e.request);
      if (networkRes && networkRes.ok) {
        const clone = networkRes.clone();
        e.waitUntil(
          caches.open(CACHE).then((cache) => cache.put(e.request, clone))
        );
        return networkRes;
      }
    } catch (_) {
      // offline: fallback to cached shell below
    }
  }

  const cached = await caches.match(e.request, { cacheName: CACHE });
  if (cached) return cached;

  try {
    const res = await fetch(e.request);
    // Backfill shell/CDN assets fetched at runtime (GET only).
    if (res && (res.ok || res.status === 0)) {
      const clone = res.clone();
      e.waitUntil(
        caches.open(CACHE).then((cache) => cache.put(e.request, clone))
      );
    }
    return res;
  } catch (err) {
    // Offline navigation fallback to the app shell.
    if (e.request.mode === 'navigate') {
      const fallback =
        (await caches.match('./sitetrack.html', { cacheName: CACHE })) ||
        (await caches.match('./index.html', { cacheName: CACHE })) ||
        (await caches.match('./', { cacheName: CACHE }));
      if (fallback) return fallback;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* FETCH ROUTER                                                        */
/* ------------------------------------------------------------------ */

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  let url;
  try {
    url = new URL(e.request.url);
  } catch (_) {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1. Dynamic APIs (geocoding / routing) — never intercept, always live.
  if (hostMatches(url.hostname, BYPASS_HOSTS)) return;

  // 2. Map tiles — cache-first into TILE_CACHE with LRU circular buffer.
  if (hostMatches(url.hostname, TILE_HOSTS)) {
    e.respondWith(tileCacheFirst(e));
    return;
  }

  // 3. Everything else (shell, CDN assets) — cache-first with fallback.
  e.respondWith(shellCacheFirst(e));
});
