// KTTA ルートスコープ Service Worker — アプリ本体のオフラインキャッシュ(network-first)。
// scope "/" で /admin など全ページを対象にする(/viewer は push 併用の /viewer/sw.js が別途担当)。
// 共通のキャッシュ実装は /shared/sw-cache.js に集約。
importScripts("/shared/sw-cache.js");
