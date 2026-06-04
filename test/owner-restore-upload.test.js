// オーナー権限の「アップロードから復元」(DR=災害復旧)を検証する。
// オフサイト退避(お名前ドットコム等)から落とした .db/.db.gz を、ローカルスナップショットが
// 無い新サーバでも取り込めること、不正ファイル/別アプリDB/無認証を弾くことを保証。
// 注意: 復元成功はプロセスを再起動(exit)するため、その検証は必ず最後に置く。
// 実行: node --test test/owner-restore-upload.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");

const PORT = 3915;
const KEY = "ru-admin", OKEY = "ru-owner-key-5566";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/ktta_ru_" + process.pid + ".db";
let srv;
const oh = { "X-Owner-Key": OKEY };

async function uploadDb(buf, filename, headers) {
  const fd = new FormData();
  fd.append("file", new Blob([buf]), filename);
  return fetch(BASE + "/api/owner/restore-upload", { method: "POST", headers: headers || oh, body: fd });
}

before(async () => {
  srv = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, OWNER_KEY: OKEY, DB_PATH: DB, NODE_ENV: "test" },
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

test("無認証(オーナーキー無し)のアップロード復元は拒否", async () => {
  const r = await uploadDb(Buffer.from("x"), "x.db", {});
  assert.ok(r.status === 401 || r.status === 503, "無認証は拒否: " + r.status);
});

test("SQLiteでないファイルは400で弾く", async () => {
  const r = await uploadDb(Buffer.from("これはDBではありません"), "fake.db", oh);
  assert.strictEqual(r.status, 400, "非SQLiteは400");
  const j = await r.json();
  assert.match(j.error || "", /SQLite/, "理由がSQLite検証: " + j.error);
});

test("KTTA以外のSQLite DBは400で弾く(スキーマ健全性)", async () => {
  // 別スキーマの正当なSQLiteを作る
  const Database = require("better-sqlite3");
  const other = "/tmp/ktta_ru_other_" + process.pid + ".db";
  const d = new Database(other);
  d.exec("CREATE TABLE foo(x); INSERT INTO foo VALUES (1)");
  d.close();
  const buf = fs.readFileSync(other);
  fs.rmSync(other, { force: true });
  const r = await uploadDb(buf, "other.db", oh);
  assert.strictEqual(r.status, 400, "別アプリDBは400");
  const j = await r.json();
  assert.match(j.error || "", /KTTA/, "理由がKTTAスキーマ: " + j.error);
});

test("拡張子が .db/.db.gz 以外は弾く", async () => {
  const r = await uploadDb(Buffer.from("x"), "evil.exe", oh);
  assert.strictEqual(r.status, 400, "非対応拡張子は400");
});

test(".db.gz として送れても、解凍後が非SQLiteなら400(gunzip成功→ヘッダ検証で弾く)", async () => {
  const gz = zlib.gzipSync(Buffer.from("これはSQLiteではない普通のテキスト"));
  const r = await uploadDb(gz, "fake.db.gz", oh);
  assert.strictEqual(r.status, 400, "解凍できても非SQLiteは400");
  const j = await r.json();
  assert.match(j.error || "", /SQLite/, "理由がSQLite検証: " + j.error);
});

// ── 最後: 実際の復元(成功)。サーバが再起動(exit)するため、以降にテストを置かないこと。
test("[最後] 有効なKTTAの .db.gz をアップロードして復元できる(restart_required)", async () => {
  // 現在のDBを db-download で取得(=有効なKTTA .db) → gzip して .db.gz として再アップロード
  const dl = await fetch(BASE + "/api/owner/db-download", { headers: oh });
  assert.strictEqual(dl.status, 200, "db-download 200");
  const dbBuf = Buffer.from(await dl.arrayBuffer());
  assert.strictEqual(dbBuf.slice(0, 15).toString("latin1"), "SQLite format 3", "有効な.db");
  const gz = zlib.gzipSync(dbBuf);
  const r = await uploadDb(gz, "ktta-backup.db.gz", oh);
  const j = await r.json();
  assert.ok(r.ok && j.ok && j.restart_required, "復元成功+再起動要求: " + JSON.stringify(j));
  assert.ok(j.safety_snapshot, "安全網スナップショットが作られる");
});
