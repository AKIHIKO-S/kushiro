// KTTA Platform - Service Worker (Web Push 受信 + アプリ本体のオフラインキャッシュ)
// スコープ: /viewer/  — マイ番号(選手本人)の呼出通知 + 会場WiFi断/リロード時のシェル提供。
// オフラインキャッシュ(network-first)は /shared/sw-cache.js に集約し import する。
importScripts("/shared/sw-cache.js");

self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

// サーバーからのプッシュを受信して通知を表示
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || "KTTA 呼出通知";
  const options = {
    body: data.body || "あなたの試合の順番です。",
    icon: "/shared/assets/icon-192.png",
    badge: "/shared/assets/icon-192.png",
    tag: data.tag || "ktta-call",
    requireInteraction: true,
    vibrate: [300, 150, 300, 150, 300],
    data: { url: data.url || "/viewer/#mynumber" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 通知タップ → マイ番号ページを開く/フォーカス
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/viewer/#mynumber";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes("/viewer") && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
