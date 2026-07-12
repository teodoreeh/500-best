// sw.js — офлайн-кэш для 500 BEST (PWA)
// Стратегии:
//   • app-shell (html, manifest, иконки) — cache-first (мгновенный старт офлайн)
//   • данные (movies*.json, живой список) — network-first с откатом в кэш
//   • постеры TMDB и шрифты Google — stale-while-revalidate (быстро + обновляется в фоне)
// Версию бампаем при изменениях, чтобы обновить кэш.
const VERSION = 'v11';
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

// то, что кэшируем при установке (по одному, чтобы отсутствие файла не сломало install)
const PRECACHE = [
  './', 'index.html', 'manifest.json',
  'data/movies.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isData = (url) =>
  /\/data\/movies.*\.json$/.test(url.pathname) ||
  url.hostname === 'raw.githubusercontent.com';

const isAsset = (url) =>
  url.pathname.includes('/posters/') ||          // локальные постеры (скачаны в проект)
  url.hostname === 'fonts.googleapis.com' ||
  url.hostname === 'fonts.gstatic.com';

async function networkFirst(req) {
  const cache = await caches.open(RUNTIME);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return hit || (await net) || Response.error();
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) (await caches.open(SHELL)).put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isData(url)) { e.respondWith(networkFirst(req)); return; }
  if (isAsset(url)) { e.respondWith(staleWhileRevalidate(req)); return; }

  // навигация и всё остальное с нашего origin — cache-first, офлайн-откат на оболочку
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await networkFirst(req); }
      catch (err) { return (await caches.match('index.html')) || (await caches.match('./')); }
    })());
    return;
  }
  if (url.origin === self.location.origin) e.respondWith(cacheFirst(req));
});
