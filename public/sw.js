// Minimal service worker — exists to satisfy Chrome/Android's PWA
// installability requirement (a registered SW with a fetch handler).
// Jarvis is an online-only assistant, so this intentionally does no
// offline caching — just passes every request straight through.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
