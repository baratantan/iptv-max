const CACHE = 'iptvmax-v1';
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(['./', 'manifest.json', 'icon-192.png'].map(u => c.add(u)))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
// شبكة أولاً لملفات الموقع نفسه (ليصل أي تحديث فوراً) ثم النسخة المحفوظة عند انقطاع الاتصال.
// لا نتدخل في طلبات البث أو الـ Worker أو Firebase.
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request))
  );
});
