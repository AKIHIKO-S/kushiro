// 起動時 自己修復の保険: DB_PATH が「空(KTTAテーブル無し)」だが健全な安全網スナップショットが
// 存在する場合、integrity_check=ok を通ってしまっても、空のまま無音起動せず安全網から復旧する。
// (例: 何らかの理由で DB_PATH が 0 バイト/空になったが snapshots は残っている状況)
// 実行: node --test test/db-selfheal-empty.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT1 = 3921, PORT2 = 3922;
const KEY = "she-admin";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ktta_she_"));
const DB = path.join(TMP, "tournament.db");
const SNAP = path.join(TMP, "snapshots");
let srv2;

function spawnSrv(port) {
  return spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), ADMIN_KEY: KEY, DB_PATH: DB, SNAPSHOT_DIR: SNAP, NODE_ENV: "test" },
    stdio: "ignore",
  });
}
async function waitHealth(port, label) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(label + " が起動しませんでした");
}
function waitExit(srv) {
  return new Promise(res => { if (srv.exitCode != null) return res(); srv.on("exit", res); setTimeout(res, 3000); });
}

before(async () => {
  const s1 = spawnSrv(PORT1);
  await waitHealth(PORT1, "srv1");
  const mk = await fetch(`http://127.0.0.1:${PORT1}/api/admin/snapshots`, { method: "POST", headers: { "X-Admin-Key": KEY } });
  assert.strictEqual(mk.status, 200, "健全スナップショット作成200: " + mk.status);
  s1.kill("SIGKILL");
  await waitExit(s1);
  // DB_PATH を「空」にする(0バイト)。new Database はこれを空DBとして開き integrity_check=ok を返すが、
  // KTTAテーブルが無く健全スナップが存在するので保険が発火して復旧するはず。
  fs.writeFileSync(DB, Buffer.alloc(0));
  for (const ext of ["-wal", "-shm"]) try { fs.rmSync(DB + ext, { force: true }); } catch (e) {}
  srv2 = spawnSrv(PORT2);
  await waitHealth(PORT2, "srv2(空DB保険の復旧後)");
});
after(() => {
  if (srv2) try { srv2.kill("SIGKILL"); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

test("空DB+健全スナップなら、空のまま起動せず安全網から復旧する(KTTAテーブルが復活)", () => {
  const Database = require("better-sqlite3");
  const d = new Database(DB, { readonly: true, fileMustExist: true });
  const c = d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('tournaments','players','matches')").get().c;
  const integ = (d.pragma("integrity_check", { simple: true }) || "").toString();
  d.close();
  assert.ok(c >= 3, "復旧後はKTTAテーブルが揃う(空のまま起動していない): tables=" + c);
  assert.strictEqual(integ, "ok", "復旧後DBは健全");
});

test("退避ファイル(.corrupt-*)が残る(消えていない)", () => {
  const aside = fs.readdirSync(TMP).filter(f => f.includes(".corrupt-"));
  assert.ok(aside.length >= 1, ".corrupt-* が存在する: " + fs.readdirSync(TMP).join(","));
});
