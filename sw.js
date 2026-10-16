/* ============================================================
   СЕРВИС-ВОРКЕР
   ------------------------------------------------------------
   Две задачи: чтобы приложение ставилось на телефон (Chrome без
   сервис-воркера установить не предложит) и чтобы открывалось без
   сети — с прошлым списком.

   Свои файлы — «сначала сеть»: модель пересобирается каждые три часа,
   код тоже меняется, и показывать устаревшее при живой сети нельзя.
   Сеть упала — отдаём сохранённое. Шрифты Google не меняются —
   «сначала кеш». Запросы к серверу на Railway не трогаем вовсе:
   свежесть плейлиста решает само приложение.
   ============================================================ */
const CACHE = 'razneset-v1';
const SHELL = [
  './', 'index.html', 'app/style.css', 'app/main.mjs',
  'lib/predict.mjs', 'lib/names.mjs', 'lib/spotify.mjs',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'data/model.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return r;
    }).catch(async () =>
      (await caches.match(req, { ignoreSearch: true })) ||
      // открыли с параметрами или по старому адресу — отдаём страницу
      (req.mode === 'navigate' ? caches.match('./') : Response.error())));
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy));
      return r;
    })));
  }
});
