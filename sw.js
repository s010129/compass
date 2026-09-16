/*
 * 離線快取。
 *
 * 程式碼類的檔案走 network-first：有網路就一定拿到最新版，離線才回頭用快取。
 * 之前用 cache-first，結果推了新版之後手機還是跑舊的（要重整兩次才會換），
 * 裝成 PWA 之後更難察覺。圖檔不會變，維持 cache-first。
 *
 * 改動程式碼時記得把 VERSION 一起往上跳，並和 src/app.js 的 BUILD 保持一致。
 */
const VERSION = 'v6';
const CACHE = `turntable-${VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'src/app.js',
  'src/mc-compass.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

/** 圖檔以外都當成程式碼，要優先拿網路上的版本。 */
const isImmutable = (url) => /\.(png|ico|svg|jpg|webp)$/i.test(url.pathname);

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (isImmutable(url)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
    return;
  }

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
