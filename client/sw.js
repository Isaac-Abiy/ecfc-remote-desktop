/* ECFC Remote Desktop service worker — installability only.
   Network passthrough: every request goes straight to the network,
   nothing is cached, nothing about the site changes. */
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));
