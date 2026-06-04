// /api/sync/push の per-IP 鍵総当たりロックアウト(#3)を専用サーバで検証。
// このテストは 127.0.0.1 の sync 失敗カウンタをロックするため、他の sync テスト(server-smoke の i/j)と
// 同一サーバを共有すると(並行実行のタイミングで)それらを 429 で汚染する。独立プロセスに隔離する。
// 実行: node --test test/sync-lock.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/ktta_synclock_" + process.pid + ".db";
const jhead = { "Content-Type": "application/json" };
let srv;

before(async () => {
  srv = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: "k", DB_PATH: DB, NODE_ENV: "test", SYNC_KEY: "lock-sync-key" },
    stdio: "ignore",
  });
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

test("/api/sync/push は鍵総当たりを per-IP ロックアウト(#3)", async () => {
  let got429 = false;
  for (let i = 0; i < 14; i++) {
    const r = await fetch(BASE + "/api/sync/push", { method: "POST",
      headers: { ...jhead, "X-Sync-Key": "WRONG-" + i }, body: JSON.stringify({ tournament: { id: "x" } }) });
    if (r.status === 429) got429 = true;
  }
  assert.ok(got429, "連続した誤キーで 429 ロックアウトに至る");
});
