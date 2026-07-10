"use strict";
/* Service Worker — オフライン動作(アプリシェル + 車両DBキャッシュ) */
const CACHE = "shaken-scan-v172";
const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./cloud.js",
  "./i18n.js",
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
  // ここでは skipWaiting しない。使用中に新SWが勝手に有効化→リロードして作業が飛ぶのを防ぐ。
  // 新版は「待機」させ、起動直後(操作前)にアプリ側から明示的に適用する。
  e.waitUntil(
    caches.open(CACHE)
      // cache:"reload" でHTTPキャッシュをバイパスし、新バージョンは必ずネットワークから取得
      .then(c => Promise.allSettled(PRECACHE.map(u => c.add(new Request(u, { cache: "reload" })))))
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// アプリからの合図で待機中の新SWを即時有効化(更新を早く反映)
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });

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

  // チラシ・マニュアル等の配布ページ: ネット優先(常に最新を表示。オフライン時のみキャッシュ)
  if (/\/(flyer|manual)\.html$/.test(url.pathname)) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || Response.error()))
    );
    return;
  }

  // HTML本体(ページ遷移): ネット優先 → 常に最新の画面。オフライン時のみキャッシュにフォールバック
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); }
        return res;
      }).catch(() => caches.match(e.request).then(c => c || caches.match("./index.html")))
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
