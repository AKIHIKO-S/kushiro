// KTTA アプリ本体のオフラインキャッシュ (network-first)。
// ・オンライン時は常にネットワークの最新を返す → 新コード即反映・古コード固着なし
//   (過去の「確定ボタン無反応」事故は cache-first/ヒューリスティックキャッシュ由来。network-first で回避)。
// ・オフライン/本部サーバ不達時のみキャッシュへフォールバックし、リロードでも画面が出る(会場WiFi断対策)。
// importScripts で /sw.js(scope "/") と /viewer/sw.js(scope "/viewer/", push 併用) から読み込む。
var KTTA_SHELL_CACHE = "ktta-shell-v1";

self.addEventListener("install", function () { self.skipWaiting(); });

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf("ktta-shell-") === 0 && k !== KTTA_SHELL_CACHE;   // 旧世代キャッシュを掃除
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;       // 同一オリジンのみ
  if (url.pathname.indexOf("/api/") === 0) return;       // データは常にネット(オフラインはアプリの送信キューが担保)
  if (url.pathname.indexOf("/uploads/") === 0) return;   // アップロード画像も素通し
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {                                // 成功した同一オリジンGETをシェルとしてキャッシュ更新
        var copy = res.clone();
        caches.open(KTTA_SHELL_CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {                                // ネット不達 → キャッシュへフォールバック
      return caches.match(req).then(function (r) {
        if (r) return r;
        if (req.mode === "navigate") return caches.match(url.pathname);  // 末尾クエリ違い等の保険
        return Response.error();
      });
    })
  );
});
