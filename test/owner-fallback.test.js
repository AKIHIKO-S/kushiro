// オーナー権限の「後方互換フォールバック」を検証する。
// OWNER_KEY を設定しない状態でこのコードが入っても、既存の管理者フロー(バックアップ/復元/エクスポート/
// 大会削除など)がロックアウトされないこと(=分離は opt-in、鍵を設定するまで従来どおり管理キーで動く)を保証。
// 実行: node --test test/owner-fallback.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3914;
const KEY = "fallback-admin-key";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/ktta_ownerfb_" + process.pid + ".db";
let srv;

before(async () => {
  // OWNER_KEY は意図的に未設定(=分離未活性)。
  const env = { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, DB_PATH: DB, NODE_ENV: "test" };
  delete env.OWNER_KEY;
  srv = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + "/api/health")).ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("server が起動しませんでした");
});
after(() => {
  if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(DB + ext, { force: true }); } catch (e) {}
});

test("OWNER_KEY 未設定: /api/owner/configured は false (UIはプロンプトを出さない)", async () => {
  const c = await fetch(BASE + "/api/owner/configured").then(r => r.json());
  assert.strictEqual(c.configured, false, "未設定なので configured=false");
});

test("OWNER_KEY 未設定: 上級操作は管理キーで通る(ロックアウトしない=後方互換)", async () => {
  // export/all は OWNER_KEY 設定時のみオーナー必須。未設定なら管理キーで200。
  const adminOk = await fetch(BASE + "/api/export/all", { headers: { "X-Admin-Key": KEY } });
  assert.strictEqual(adminOk.status, 200, "未設定時は管理キーで export/all 200(従来どおり)");
  // スナップショット一覧も管理キーで通る
  const snaps = await fetch(BASE + "/api/admin/snapshots", { headers: { "X-Admin-Key": KEY } });
  assert.strictEqual(snaps.status, 200, "未設定時は管理キーで snapshots 200");
});

test("OWNER_KEY 未設定でも、鍵も管理キーも無ければ拒否(無認証は通さない)", async () => {
  const noAuth = await fetch(BASE + "/api/export/all");
  assert.ok(noAuth.status === 401 || noAuth.status === 503, "無認証は拒否: " + noAuth.status);
});
