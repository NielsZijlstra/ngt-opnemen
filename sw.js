// Zorgt dat de app ook zonder internet opent. De opnames zelf staan in
// IndexedDB en komen hier niet langs.
'use strict';

const CACHE = 'ngt-opnemen-20261009-2314';
const BESTANDEN = [
  './',
  'index.html',
  'style.css',
  'zip.js',
  'opslag.js',
  'app.js',
  'gebaren.csv',
  'uitleg.html',
  'manifest.webmanifest',
  'apple-touch-icon.png',
  'icoon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BESTANDEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// Eerst internet proberen (zodat updates direct binnenkomen), anders de opgeslagen versie
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((antwoord) => {
        if (antwoord.ok) {
          const kopie = antwoord.clone();
          caches.open(CACHE).then((c) => c.put(e.request, kopie));
        }
        return antwoord;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
