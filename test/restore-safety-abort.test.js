// 復元の完全性ハザード回帰: 安全網スナップショットが作れない時は「本番DBを上書きせず中止」する。
// (レビュー指摘 high: 安全網コピー失敗を握り潰してバックアップ無しでDBを潰す欠陥の修正を実証)
// SNAPSHOT_DIR を読み取り専用にして restore-upload を試し、400で中止+DB無傷+サーバ生存 を確認する。
// 実行: node --test test/restore-safety-abort.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3916;
const KEY = "sa-admin", OKEY = "sa-owner-key-7788";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/ktta_sa_" + process.pid + ".db";
const SNAP = "/tmp/ktta_sa_snap_" + process.pid;
let srv;
const oh = { "X-Owner-Key": OKEY };

before(async () => {
  srv = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, OWNER_KEY: OKEY, DB_PATH: DB, SNAPSHOT_DIR: SNAP, NODE_ENV: "test" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + "/api/health")).ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("server が起動しませんでした");
});
after(() => {
  try { fs.chmodSync(SNAP, 0o700); } catch (e) {}
  if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(DB + ext, { force: true }); } catch (e) {}
  try { fs.rmSync(SNAP, { recursive: true, force: true }); } catch (e) {}
});

test("安全網スナップショットを作れない時は復元を中止し、本番DBを破壊しない", async () => {
  // 1) 有効なKTTAの .db を取得(この時点では SNAP は書込可)
  const dl = await fetch(BASE + "/api/owner/db-download", { headers: oh });
  assert.strictEqual(dl.status, 200, "db-download 200");
  const dbBuf = Buffer.from(await dl.arrayBuffer());
  assert.strictEqual(dbBuf.slice(0, 15).toString("latin1"), "SQLite format 3", "有効な.db");

  // 2) SNAPSHOT_DIR を読み取り専用にして安全網コピーを失敗させる
  fs.mkdirSync(SNAP, { recursive: true });
  fs.chmodSync(SNAP, 0o500);

  // 3) 復元を試みる → 安全網が作れないので中止(400)。DBは上書きされない。
  const fd = new FormData();
  fd.append("file", new Blob([dbBuf]), "ktta.db");
  const r = await fetch(BASE + "/api/owner/restore-upload", { method: "POST", headers: oh, body: fd });
  assert.strictEqual(r.status, 400, "安全網失敗で400中止: " + r.status);
  const j = await r.json();
  assert.match(j.error || "", /安全網|中止/, "理由が安全網中止: " + j.error);

  // 4) サーバは生きていて(再起動していない)、DBも無傷で読める
  fs.chmodSync(SNAP, 0o700);   // 後続の通常動作のため戻す
  const health = await fetch(BASE + "/api/health");
  assert.ok(health.ok, "サーバーは生存(再起動/クラッシュしていない)");
  const players = await fetch(BASE + "/api/players", { headers: { "X-Admin-Key": KEY } });
  assert.strictEqual(players.status, 200, "DBは無傷で読める");
});
