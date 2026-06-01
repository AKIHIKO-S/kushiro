"use strict";
// サーバ耐性ハードニング: HTTPタイムアウト調整 + graceful shutdown。
// app.listen() が返す http.Server を渡して使う。server.js への変更は最小(2行)で済む。
//
// 方針:
//  - keepAliveTimeout を延長し、リバースプロキシ(nginx/Cloudflare)との接続再利用を増やして
//    TCP/TLS ハンドシェイクを削減 (=リクエスト処理を軽量化)。既定5sは100同時接続だと短すぎ再接続が頻発。
//  - headersTimeout を keepAliveTimeout より大きく設定し、ヘッダを遅延送信する slow-loris を遮断
//    (早すぎる 408 も回避)。本体側の slow-loris は Node 既定の requestTimeout(300s) が上限化する
//    (低速回線での Excel 取込 ~20MB を許容するため敢えて既定維持)。
//  - SIGTERM/SIGINT で graceful shutdown: 新規接続の受付を止め、在席リクエストの完了を待ち、
//    長寿命接続(SSE)を明示的に閉じてクライアントの自動再接続を促す。デプロイ時の取りこぼしを防ぐ。
function installServerHardening(server, opts = {}) {
  const { closeExtras, label = "lifecycle" } = opts;

  // ── タイムアウト ──
  server.keepAliveTimeout = 65_000;   // 65s: LB/プロキシの idle より長め (接続再利用を最大化)
  server.headersTimeout = 66_000;     // keepAliveTimeout より僅かに大きく (slow-loris ヘッダ遮断)
  // server.requestTimeout は既定(300s)を維持 = 低速アップロード許容 + 本体slow-lorisの上限

  // ── graceful shutdown ──
  let shuttingDown = false, finished = false;
  const finish = (code) => { if (finished) return; finished = true; process.exit(code || 0); };
  const shutdown = (sig) => {
    if (shuttingDown) return;            // 二重発火ガード
    shuttingDown = true;
    try { console.log(`[${label}] ${sig} 受信 → graceful shutdown 開始`); } catch (e) {}
    // 新規接続の受付を停止し、在席リクエストの完了後に終了
    try { server.close(() => { try { console.log(`[${label}] 全接続クローズ完了`); } catch (e) {} finish(0); }); }
    catch (e) { finish(0); }
    // 長寿命接続(SSE等)を明示的に閉じる → クライアントは新インスタンスへ自動再接続
    try { if (typeof closeExtras === "function") closeExtras(); } catch (e) {}
    // 保険: 一定時間で在席が残っていても強制終了 (systemd TimeoutStopSec=15 内に収める)
    try { setTimeout(() => { try { console.warn(`[${label}] shutdown timeout → 強制終了`); } catch (e) {} finish(0); }, 8_000).unref(); }
    catch (e) {}
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}

module.exports = { installServerHardening };
