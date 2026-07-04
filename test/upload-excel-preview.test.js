// 申込Excel取込(/entrants/upload-excel)の安全統一の回帰 (WP1-4)。
//   - dry_run=1 でプレビューが返り、entrants は取り込まれない(未確定)
//   - dry_run 無しは従来どおり取込まれる
//   - 組合せ表取込と同一チェーン(JS seed-list 主/副系統)を通り used_parser が付く
// server.js を実プロセスで起動して検証(kumiawase-parser-dispatch と同方式)。
// 実行: node --test test/upload-excel-preview.test.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const XLSX = require("xlsx");

const ROOT = path.join(__dirname, "..");

// JS(SheetJS)で読める合成ブック [seed,氏名,所属]。python を無効化して JS 経路を確定的に通す。
function buildFixture(p) {
  const wb = XLSX.utils.book_new();
  const singles = XLSX.utils.aoa_to_sheet([
    [1, "甲山 一郎", "A会"], [2, "乙川 二郎", "B会"], [3, "丙田 三郎", "C会"],
    [4, "丁原 四郎", "D会"], [5, "戊野 五郎", "E会"], [6, "己島 六郎", "F会"],
  ]);
  XLSX.utils.book_append_sheet(wb, singles, "一般男子シングルス");
  XLSX.writeFile(wb, p);
}

function startServer({ port, key, dbPath }) {
  return spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_KEY: key, DB_PATH: dbPath, NODE_ENV: "test", SSE_MAX: "10", KTTA_DISABLE_PYTHON_PARSER: "1" },
    stdio: "ignore",
  });
}
async function waitHealth(base) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/api/health"); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server が起動しませんでした: " + base);
}
async function createTournament(base, key) {
  const r = await fetch(base + "/api/tournaments", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": key },
    body: JSON.stringify({ name: "upload-excel-test", date: "2027-12-01" }),
  });
  const j = await r.json();
  assert.ok(j.id, "大会作成: " + JSON.stringify(j));
  return j.id;
}
async function upload(base, key, tid, filePath, { dry }) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), path.basename(filePath));
  fd.append("format", "singles");
  if (dry) fd.append("dry_run", "1");
  const r = await fetch(`${base}/api/tournaments/${tid}/entrants/upload-excel`, {
    method: "POST", headers: { "X-Admin-Key": key }, body: fd,
  });
  return r.json();
}
async function entrantCount(base, key, tid) {
  const r = await fetch(`${base}/api/tournaments/${tid}/entrants`, { headers: { "X-Admin-Key": key } });
  const j = await r.json();
  const list = Array.isArray(j) ? j : (j.entrants || j.rows || []);
  return list.length;
}
function rmDb(dbPath) { for (const x of ["", "-wal", "-shm"]) { try { fs.rmSync(dbPath + x, { force: true }); } catch (e) {} } }

describe("upload-excel: dry_run プレビュー + チェーン統一", () => {
  const PORT = 3931, KEY = "ue-key", DB = path.join(os.tmpdir(), `ktta_ue_${process.pid}.db`);
  const FX = path.join(os.tmpdir(), `ktta_ue_${process.pid}.xlsx`);
  const BASE = `http://127.0.0.1:${PORT}`;
  let srv;
  before(async () => {
    srv = startServer({ port: PORT, key: KEY, dbPath: DB });
    await waitHealth(BASE);
    buildFixture(FX);
  });
  after(() => {
    if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
    rmDb(DB); try { fs.rmSync(FX, { force: true }); } catch (e) {}
  });

  it("dry_run=1 はプレビューを返し、entrants は取り込まれない", async () => {
    const tid = await createTournament(BASE, KEY);
    const j = await upload(BASE, KEY, tid, FX, { dry: true });
    assert.ok(j.preview && Array.isArray(j.preview.events) && j.preview.events.length >= 1, "preview.events が返る: " + JSON.stringify(j));
    assert.strictEqual(j.preview.events[0].count, 6, "6名検出: " + JSON.stringify(j.preview.events[0]));
    assert.strictEqual(j.used_parser, "parse_bracket_seedlist.js", "seed-list 経路: " + JSON.stringify(j));
    assert.strictEqual(await entrantCount(BASE, KEY, tid), 0, "dry_run では取り込まれない");
  });

  it("dry_run 無しは従来どおり取り込まれる", async () => {
    const tid = await createTournament(BASE, KEY);
    const j = await upload(BASE, KEY, tid, FX, { dry: false });
    assert.ok(j.ok || j.imported, "取込レスポンス: " + JSON.stringify(j));
    assert.strictEqual(j.used_parser, "parse_bracket_seedlist.js", "seed-list 経路: " + JSON.stringify(j));
    assert.ok(await entrantCount(BASE, KEY, tid) >= 6, "6名以上が取り込まれる");
  });
});
