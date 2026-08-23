/* FCM(プッシュ通知)のバックグラウンド受信用 Service Worker
   ※アプリ本体の sw.js とは別物。アプリを完全に閉じている時の通知表示を担当。
   Firebase SDK に依存せず、生の push イベントで通知を表示する(SDKの読込失敗や
   onBackgroundMessage未登録で「閉じてると通知が来ない」問題を防ぐ)。
   トークン取得はページ側の firebase.messaging().getToken(...) が担当し、
   このSWは購読済みの push を受けて showNotification するだけ。 */

self.addEventListener("push", e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; }
  catch (_) { try { p = { data: { body: e.data && e.data.text() } }; } catch (__) { p = {}; } }
  // FCMのpushペイロードは { data:{...} } または { notification:{...} } で届く。両対応。
  const src = (p && (p.data || p.notification)) || {};
  const title = src.title || "メカノAI";
  const body = src.body || "新しい通知があります。";
  const link = src.link || (p.fcmOptions && p.fcmOptions.link) || "./";
  const tag = src.tag || "mechano";
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag,
      renotify: true,          // 同tagでも新着として鳴らす
      data: { link },
    })
  );
});

// 通知タップでアプリを前面に(既に開いていればそれをフォーカス、無ければ開く)
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || "./";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(link);
    })
  );
});
