"use strict";
// HTTP 条件付きGET ヘルパ (リクエスト軽量化)。
// 安価な内容フィンガープリント(進行fingerprint等)を ETag として立て、
// クライアントの If-None-Match が一致すれば 304(本体なし)を返して true を返す。
// 呼び出し側は true なら早期 return することで、本体JSONの送信(帯域)と
// Express 既定の弱ETag再計算(本体ハッシュ=CPU)を省ける。
// Cloudflare/ブラウザはこの ETag + Cache-Control で安価に再検証でき、原サーバ到達を削減できる。
function conditional(req, res, etagValue, cacheControl) {
  if (cacheControl) res.set("Cache-Control", cacheControl);
  if (etagValue == null || etagValue === "") return false;
  const etag = '"' + String(etagValue) + '"';
  res.set("ETag", etag);
  const inm = req.headers["if-none-match"];
  // 強い一致 + 弱いバリデータ(W/接頭辞)も許容
  if (inm && (inm === etag || inm.replace(/^W\//, "") === etag)) {
    res.status(304).end();
    return true;
  }
  return false;
}

module.exports = { conditional };
