const CACHE_NAME = 'thu-chi-shell-v1';
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

// Chỉ cache app shell (HTML/CSS/JS tĩnh). Không cache API GitHub — luôn lấy dữ liệu mới nhất.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin.includes('api.github.com') || url.hostname.includes('jsdelivr')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
