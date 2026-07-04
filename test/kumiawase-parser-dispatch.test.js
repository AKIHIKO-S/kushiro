// /kumiawase/upload のパーサー振り分け順の回帰 (#268 昇格)。
//   主系統 = Python 罫線パーサー(tools/bracket_parser) / 副系統 = JS parse_bracket_seedlist.js。
// server.js を実プロセスで起動し dry_run アップロードの used_parser を検証する(server-smoke と同方式)。
//  - python 利用可時: 罫線フィクスチャ → used_parser = "bracket_parser (python)"
//  - KTTA_DISABLE_PYTHON_PARSER=1 (or python不在): JSフィクスチャ → "parse_bracket_seedlist.js"
// 解析精度自体は python の `bracket_parser.selftest` と JS の excel-parser.test.js が担保する。
// 実行: node --test test/kumiawase-parser-dispatch.test.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const XLSX = require("xlsx");

const ROOT = path.join(__dirname, "..");
const pyEnvPaths = [path.join(ROOT, "tools"), path.join(ROOT, ".python-packages")].join(path.delimiter);

function pythonAvailable() {
  try {
    const r = spawnSync("python3", ["-c", "import openpyxl, bracket_parser"], {
      env: { ...process.env, PYTHONPATH: pyEnvPaths }, timeout: 8000,
    });
    return r.status === 0;
  } catch { return false; }
}
const PY = pythonAvailable();

// JS(SheetJS)で読める罫線なし合成ブック: import-pipeline-e2e と同形 [seed,氏名,所属]。
function buildJsFixture(p) {
  const wb = XLSX.utils.book_new();
  const singles = XLSX.utils.aoa_to_sheet([
    [1, "甲山 一郎", "A会"], [2, "乙川 二郎", "B会"], [3, "丙田 三郎", "C会"],
    [4, "丁原 四郎", "D会"], [5, "戊野 五郎", "E会"], [6, "己島 六郎", "F会"],
  ]);
  XLSX.utils.book_append_sheet(wb, singles, "一般男子シングルス");
  XLSX.writeFile(wb, p);
}
// 組番号 4 を欠番にした合成ブック(seed_gap 警告の全経路化を検証するため)。
function buildJsFixtureGapped(p) {
  const wb = XLSX.utils.book_new();
  const singles = XLSX.utils.aoa_to_sheet([
    [1, "甲山 一郎", "A会"], [2, "乙川 二郎", "B会"], [3, "丙田 三郎", "C会"],
    [5, "戊野 五郎", "E会"], [6, "己島 六郎", "F会"], [7, "庚村 七郎", "G会"],
  ]);
  XLSX.utils.book_append_sheet(wb, singles, "一般男子シングルス");
  XLSX.writeFile(wb, p);
}
// Python(openpyxl)で読める罫線ありブックをパーサ自身の selftest ビルダで生成(PIIなし合成)。
function buildPyFixture(p) {
  const code = "from openpyxl import Workbook\n" +
    "from bracket_parser.selftest import _build_singles\n" +
    "import sys\n" +
    "wb=Workbook(); ws=wb.active; ws.title='男子シングルス'\n" +
    "_build_singles(ws)\n" +
    "wb.save(sys.argv[1])\n";
  const r = spawnSync("python3", ["-c", code, p], { env: { ...process.env, PYTHONPATH: pyEnvPaths }, timeout: 15000 });
  if (r.status !== 0) throw new Error("py fixture build failed: " + String(r.stderr || ""));
}

function startServer({ port, key, dbPath, extraEnv }) {
  return spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_KEY: key, DB_PATH: dbPath, NODE_ENV: "test", SSE_MAX: "10", ...extraEnv },
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
    body: JSON.stringify({ name: "dispatch-test", date: "2027-12-01" }),
  });
  const j = await r.json();
  assert.ok(j.id, "大会作成: " + JSON.stringify(j));
  return j.id;
}
async function uploadDryRun(base, key, tid, filePath) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), path.basename(filePath));
  fd.append("dry_run", "1");
  const r = await fetch(`${base}/api/tournaments/${tid}/kumiawase/upload`, {
    method: "POST", headers: { "X-Admin-Key": key }, body: fd,
  });
  return r.json();
}
function rmDb(dbPath) { for (const x of ["", "-wal", "-shm"]) { try { fs.rmSync(dbPath + x, { force: true }); } catch (e) {} } }

describe("kumiawase 振り分け: JS フォールバック (KTTA_DISABLE_PYTHON_PARSER=1)", () => {
  const PORT = 3925, KEY = "disp-js-key", DB = path.join(os.tmpdir(), `ktta_disp_js_${process.pid}.db`);
  const FX = path.join(os.tmpdir(), `ktta_disp_js_${process.pid}.xlsx`);
  const BASE = `http://127.0.0.1:${PORT}`;
  let srv;
  before(async () => {
    srv = startServer({ port: PORT, key: KEY, dbPath: DB, extraEnv: { KTTA_DISABLE_PYTHON_PARSER: "1" } });
    await waitHealth(BASE);
    buildJsFixture(FX);
  });
  after(() => {
    if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
    rmDb(DB); try { fs.rmSync(FX, { force: true }); } catch (e) {}
  });

  it("python 無効化時は JS seed-list パーサーが使われる", async () => {
    const tid = await createTournament(BASE, KEY);
    const j = await uploadDryRun(BASE, KEY, tid, FX);
    assert.strictEqual(j.used_parser, "parse_bracket_seedlist.js", "used_parser=JS: " + JSON.stringify(j));
    assert.ok(j.preview && Array.isArray(j.preview.events) && j.preview.events.length >= 1, "種目が解析される: " + JSON.stringify(j));
    assert.strictEqual(j.preview.events[0].count, 6, "6名: " + JSON.stringify(j.preview.events[0]));
  });

  it("組番号に欠番があると preview に seed_gap 警告が付く", async () => {
    const gapFx = path.join(os.tmpdir(), `ktta_disp_js_gap_${process.pid}.xlsx`);
    buildJsFixtureGapped(gapFx);
    try {
      const tid = await createTournament(BASE, KEY);
      const j = await uploadDryRun(BASE, KEY, tid, gapFx);
      const ev = j.preview && j.preview.events && j.preview.events[0];
      assert.ok(ev && Array.isArray(ev.notices), "notices フィールドが存在する: " + JSON.stringify(j));
      const gap = ev.notices.find(n => n.type === "seed_gap");
      assert.ok(gap && gap.count === 1, "組番号4の欠番が seed_gap として検出される: " + JSON.stringify(ev.notices));
    } finally {
      try { fs.rmSync(gapFx, { force: true }); } catch (e) {}
    }
  });
});

describe("kumiawase 振り分け: Python 主系統 (python+openpyxl 利用可時)", { skip: PY ? false : "python3+openpyxl が無いためスキップ" }, () => {
  const PORT = 3926, KEY = "disp-py-key", DB = path.join(os.tmpdir(), `ktta_disp_py_${process.pid}.db`);
  const FX = path.join(os.tmpdir(), `ktta_disp_py_${process.pid}.xlsx`);
  const BASE = `http://127.0.0.1:${PORT}`;
  let srv;
  before(async () => {
    srv = startServer({ port: PORT, key: KEY, dbPath: DB, extraEnv: {} });
    await waitHealth(BASE);
    buildPyFixture(FX);
  });
  after(() => {
    if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
    rmDb(DB); try { fs.rmSync(FX, { force: true }); } catch (e) {}
  });

  it("python 利用可時は罫線表で Python パーサーが主系統として使われる", async () => {
    const tid = await createTournament(BASE, KEY);
    const j = await uploadDryRun(BASE, KEY, tid, FX);
    assert.strictEqual(j.used_parser, "bracket_parser (python)", "used_parser=python: " + JSON.stringify(j));
    assert.ok(j.preview && Array.isArray(j.preview.events) && j.preview.events.length >= 1, "種目が解析される: " + JSON.stringify(j));
    // 主系統(Python)経路でも品質警告が後付けされ、notices フィールドが存在する(#268 の逆転解消)。
    assert.ok(Array.isArray(j.preview.events[0].notices), "python preview に notices フィールドが存在: " + JSON.stringify(j.preview.events[0]));
  });
});
