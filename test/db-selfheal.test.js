// 起動時 自己修復(DB破損→安全網スナップショットから自動復旧)を検証する。
// これが無いと、復元(restore)のコピー中断などで DB_PATH が破損した場合、起動時に
// 例外→クラッシュループ→恒久502 となり、SSHでの手動復旧まで停止し続ける。
// 検証: 健全なスナップショットを1つ作る → DB_PATH を破損させる → 再起動すると
//        自動復旧して health が立ち、破損DBは .corrupt-* に退避され、DB_PATH は健全。
// 実行: node --test test/db-selfheal.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const PORT1 = 3919, PORT2 = 3920;   // srv1(作成用) と srv2(自己修復後) でポートを分け競合回避
const KEY = "sh-admin";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ktta_sh_"));
const DB = path.join(TMP, "tournament.db");
const SNAP = path.join(TMP, "snapshots");
let srv2;

function spawnSrv(port) {
  return spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    // OWNER_KEY は未設定 → requireOwner は requireAdmin にフォールバック(X-Admin-Key で通る)
    env: { ...process.env, PORT: String(port), ADMIN_KEY: KEY, DB_PATH: DB, SNAPSHOT_DIR: SNAP, NODE_ENV: "test" },
    stdio: "ignore",
  });
}
async function waitHealth(port, label) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(label + " が起動しませんでした(自己修復に失敗した可能性)");
}
function waitExit(srv) {
  return new Promise(res => { if (srv.exitCode != null) return res(); srv.on("exit", res); setTimeout(res, 3000); });
}

before(async () => {
  // 1) 正常起動して、健全なスナップショットをAPIで1つ作る
  const s1 = spawnSrv(PORT1);
  await waitHealth(PORT1, "srv1");
  const mk = await fetch(`http://127.0.0.1:${PORT1}/api/admin/snapshots`, { method: "POST", headers: { "X-Admin-Key": KEY } });
  assert.strictEqual(mk.status, 200, "健全なスナップショット作成は200: " + mk.status);
  s1.kill("SIGKILL");
  await waitExit(s1);
  // 2) DB_PATH を破損させる(コピー中断などで起きる torn/garbage を模擬)。wal/shm も除去。
  fs.writeFileSync(DB, crypto.randomBytes(4096));
  for (const ext of ["-wal", "-shm"]) try { fs.rmSync(DB + ext, { force: true }); } catch (e) {}
  // 3) 破損DBで起動 → 自己修復が効けば health が立つ(効かなければ waitHealth が throw)
  srv2 = spawnSrv(PORT2);
  await waitHealth(PORT2, "srv2(自己修復後)");
});
after(() => {
  if (srv2) try { srv2.kill("SIGKILL"); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

test("破損DBでも安全網スナップショットから自動復旧して起動する(health 200)", async () => {
  const r = await fetch(`http://127.0.0.1:${PORT2}/api/health`);
  assert.strictEqual(r.status, 200, "自己修復後は health 200");
});

test("破損DBは削除されず .corrupt-* に退避される(証跡)", () => {
  const corrupt = fs.readdirSync(TMP).filter(f => f.includes(".corrupt-"));
  assert.ok(corrupt.length >= 1, ".corrupt-* が存在するはず: " + fs.readdirSync(TMP).join(","));
});

test("復旧後の DB_PATH は健全(integrity_check = ok)", () => {
  const Database = require("better-sqlite3");
  const d = new Database(DB, { readonly: true, fileMustExist: true });
  const integ = (d.pragma("integrity_check", { simple: true }) || "").toString();
  d.close();
  assert.strictEqual(integ, "ok", "復旧後の DB_PATH は健全であること");
});
