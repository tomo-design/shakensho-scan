"use strict";
/* Service Worker — オフライン動作(アプリシェル + 車両DBキャッシュ) */
const CACHE = "shaken-scan-v60";
const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./db/vehicles.json",
  "./db/dtc.json",
  "./db/symptoms.json",
  "./db/guides.json",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./lib/jsQR.js",
  "./lib/zxing.js",
  "./img/mecha.png",
  "./img/hero.png",
  "./img/thinking.png",
  "./img/kangae.png",
  "./img/speak.png",
  "./img/ic-photo.png",
  "./img/ic-photo-cam.png",
  "./img/ic-video.png",
  "./img/ic-video-cam.png",
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      // cache:"reload" でHTTPキャッシュをバイパスし、新バージョンは必ずネットワークから取得
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // DB類(json): stale-while-revalidate (オフラインでも使え、オンラインなら更新)
  if (/\/db\/[\w-]+\.json$/.test(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const cached = await c.match(e.request);
        const fetched = fetch(e.request).then(res => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        }).catch(() => null);
        return cached || fetched || Response.error();
      })
    );
    return;
  }

  // その他: キャッシュ優先 → ネット → 取得成功ならキャッシュに追加(フォント等)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const cacheable = res.ok && (url.origin === location.origin ||
          ["cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname));
        if (cacheable) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      });
    })
  );
});
