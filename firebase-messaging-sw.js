/* FCM(プッシュ通知)のバックグラウンド受信用 Service Worker
   ※アプリ本体の sw.js とは別物。閉じている時の通知表示を担当。 */
importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAH5tBm9VDMYas1X0pNBBYHxKO3nfTrEYI",
  authDomain: "mecanoai.firebaseapp.com",
  projectId: "mecanoai",
  storageBucket: "mecanoai.firebasestorage.app",
  messagingSenderId: "126560659288",
  appId: "1:126560659288:web:627b913aef320e7e76a72d"
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || "メカノAI", {
    body: n.body || "新しい通知があります。",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: "mechano-join",
  });
});

// 通知タップでアプリを前面に
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if ("focus" in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow("./");
  }));
});
