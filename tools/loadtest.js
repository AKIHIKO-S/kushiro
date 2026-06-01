#!/usr/bin/env node
// KTTA Platform 負荷試験ツール — 試合運用時の同時接続を想定して限界を実測する。
//
// 使い方:
//   1) 隔離サーバを進行中の大会データで起動 (例):
//        DB_PATH=/tmp/x.db ADMIN_KEY=tkey PORT=3995 TRUST_PROXY=true node server.js
//   2) 本ツールを実行:
//        TID=<大会id> node tools/loadtest.js
//   環境変数: HOST(127.0.0.1) PORT(3995) TID(必須) N(100=同時数) SECS(8=読取試験の秒数)
//
// 計測内容:
//   Phase 1: SSE を同一IPで N 本 — 会場の共有WiFi/Cloudflare(=1 IP)を再現し受理率を見る。
//   Phase 2: SSE を分散IPで N 本 — サーバ素の同時SSE収容力 + event-loop 健全性。
//   Phase 3: 読取 API を N 並行で SECS 秒 — 遅延分布・エラー率・スループット・ELブロック。
const http = require("http");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "3995", 10);
const TID = process.env.TID;
const N = parseInt(process.env.N || "100", 10);
const SECS = parseInt(process.env.SECS || "8", 10);
const KEY = process.env.ADMIN_KEY || "tkey";
if (!TID) { console.error("TID 環境変数 (大会id) が必要です"); process.exit(1); }

function req(path, { headers = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const r = http.request({ host: HOST, port: PORT, path, headers }, (res) => {
      let n = 0; res.on("data", (c) => { n += c.length; });
      res.on("end", () => resolve({ status: res.statusCode, ms: performance.now() - t0, bytes: n }));
    });
    r.on("error", () => resolve({ status: 0, ms: performance.now() - t0, err: true }));
    r.end();
  });
}
function openSSE(xff) {
  return new Promise((resolve) => {
    const headers = {}; if (xff) headers["X-Forwarded-For"] = xff;
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const r = http.request({ host: HOST, port: PORT, path: `/api/public/tournaments/${TID}/ops-stream`, headers }, (res) => {
      res.on("data", () => finish({ status: res.statusCode, ok: res.statusCode === 200, close: () => r.destroy() }));
      res.on("end", () => finish({ status: res.statusCode, ok: false, close: () => {} }));
    });
    r.on("error", () => finish({ status: 0, ok: false, close: () => {} }));
    r.end();
    setTimeout(() => finish({ status: -1, ok: false, close: () => r.destroy() }), 4000);
  });
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
function stat(name, arr, errs) {
  if (!arr.length) return console.log(name.padEnd(34), "no data  err", errs);
  console.log(name.padEnd(34), "n=" + String(arr.length).padStart(5),
    "avg", (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1).padStart(7),
    "p95", pct(arr, .95).toFixed(1).padStart(7), "p99", pct(arr, .99).toFixed(1).padStart(7),
    "max", Math.max(...arr).toFixed(1).padStart(8), "err", errs);
}

async function main() {
  console.log(`負荷試験 → ${HOST}:${PORT} TID=${TID} N=${N} SECS=${SECS}\n`);
  console.log(`=== Phase 1: SSE ${N}本 同一IP (会場の共有WiFi/Cloudflare 1IP を再現) ===`);
  let conns = await Promise.all(Array.from({ length: N }, () => openSSE(null)));
  let acc = conns.filter(c => c.ok).length, r429 = conns.filter(c => c.status === 429).length, r503 = conns.filter(c => c.status === 503).length;
  console.log(`  受理 ${acc}/${N}  拒否429 ${r429}  拒否503 ${r503}  → 同一WiFiの${N}人中 ${acc}人だけライブ受信`);
  conns.forEach(c => c.close && c.close());
  await new Promise(r => setTimeout(r, 500));

  console.log(`\n=== Phase 2: SSE ${N}本 分散IP (サーバの同時SSE収容力) ===`);
  conns = await Promise.all(Array.from({ length: N }, (_, i) => openSSE(`10.1.${(i / 256 | 0)}.${i % 256}`)));
  acc = conns.filter(c => c.ok).length;
  console.log(`  受理 ${acc}/${N}  拒否429 ${conns.filter(c => c.status === 429).length}  拒否503 ${conns.filter(c => c.status === 503).length}`);
  const probe = []; for (let i = 0; i < 20; i++) { probe.push((await req("/api/health")).ms); await new Promise(r => setTimeout(r, 50)); }
  stat(`  health (${N}SSE保持中)`, probe, 0);

  console.log(`\n=== Phase 3: 読取 ${N}並行 x ${SECS}秒 (/live + /ops-version) + 上記SSE保持 ===`);
  const live = [], opsv = []; let eLive = 0, eOps = 0, running = true;
  const workers = Array.from({ length: N }, async () => {
    while (running) {
      const a = await req(`/api/public/tournaments/${TID}/live`); a.status === 200 ? live.push(a.ms) : eLive++;
      const b = await req(`/api/public/tournaments/${TID}/ops-version`); b.status === 200 ? opsv.push(b.ms) : eOps++;
    }
  });
  const elp = []; const probeLoop = (async () => { while (running) { elp.push((await req("/api/health")).ms); await new Promise(r => setTimeout(r, 100)); } })();
  await new Promise(r => setTimeout(r, SECS * 1000)); running = false;
  await Promise.all([...workers, probeLoop]);
  stat("  /live (キャッシュ)", live, eLive);
  stat("  /ops-version", opsv, eOps);
  stat("  /health (負荷中=ELブロック指標)", elp, 0);
  const tot = live.length + opsv.length;
  console.log(`  スループット ${(tot / SECS).toFixed(0)} req/s  総エラー ${eLive + eOps}`);
  conns.forEach(c => c.close && c.close());
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
