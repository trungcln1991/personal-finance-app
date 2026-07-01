const CACHE_NAME = 'thu-chi-shell-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './add.html',
  './transactions.html',
  './settings.html',
  './css/style.css',
  './js/config.js',
  './js/github-api.js',
  './js/store.js',
  './js/nav.js',
  './js/dashboard.js',
  './js/add.js',
  './js/transactions.js',
  './js/settings.js',
  './manifest.json',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: luôn ưu tiên lấy bản mới nhất khi có mạng, chỉ dùng cache khi mất mạng.
// (Cache-first từng khiến app kẹt bản cũ vĩnh viễn sau mỗi lần deploy code mới.)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin.includes('api.github.com') || url.hostname.includes('jsdelivr') || url.hostname.includes('workers.dev')) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
