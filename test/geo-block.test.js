// 国外アクセス遮断(GEO_ALLOW_COUNTRIES)を専用サーバで検証。
// Cloudflare の CF-IPCountry を見て許可国以外を 403。未設定なら無効(従来どおり)なので、ここでは JP のみ許可で起動。
// 実行: node --test test/geo-block.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3918;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/ktta_geo_" + process.pid + ".db";
let srv;
const get = (p, country) => fetch(BASE + p, { headers: country ? { "CF-IPCountry": country } : {} });

before(async () => {
  srv = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: "k", DB_PATH: DB, NODE_ENV: "test", GEO_ALLOW_COUNTRIES: "JP" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    // health は除外なので国ヘッダ無しでも 200 で起動判定できる
    try { if ((await get("/api/health")).ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("server が起動しませんでした");
});
after(() => {
  if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(DB + ext, { force: true }); } catch (e) {}
});

test("日本以外(CF-IPCountry=US)は 403 で遮断される", async () => {
  const r = await get("/api/public/last-updated", "US");
  assert.strictEqual(r.status, 403, "US は 403");
  const html = await r.text();
  assert.match(html, /日本国内からのみ/, "国外遮断ページが返る");
});

test("日本(CF-IPCountry=JP)は通る", async () => {
  const r = await get("/api/public/last-updated", "JP");
  assert.strictEqual(r.status, 200, "JP は通過");
});

test("判定ヘッダ無し(CF-IPCountry無し)は既定で通る(ローカル/standalone を巻き込まない)", async () => {
  const r = await get("/api/public/last-updated");
  assert.notStrictEqual(r.status, 403, "ヘッダ無しは遮断しない: " + r.status);
});

test("/api/health は国外でも常に通る(監視用に除外)", async () => {
  const r = await get("/api/health", "US");
  assert.strictEqual(r.status, 200, "health は US でも 200(除外)");
});

test("Tor/不明国(XX,T1)は許可国でないため遮断", async () => {
  assert.strictEqual((await get("/api/public/last-updated", "T1")).status, 403, "Tor は遮断");
  assert.strictEqual((await get("/api/public/last-updated", "XX")).status, 403, "不明国は遮断");
});
