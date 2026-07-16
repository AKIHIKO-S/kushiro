// Python罫線パーサー(tools/bracket_parser)の完全往復回帰: 合成ワークブック(PII無し)を
//   /kumiawase/upload(dry_runなし) → db取込 → DB内容
// まで通し、「全員が欠落・重複なく配置され、氏名/所属が元の合成データと完全一致する」ことを
// 固定する。kumiawase-parser-dispatch.test.js は used_parser の振り分け(dry_runプレビュー止まり)
// までしか見ていないため、こちらは実際のDB反映結果まで検証する棲み分け。
// 実データ(PII)は commit できないため、bracket_parser.selftest の合成データビルダー
// (_build_singles/_build_doubles_stacked/_build_doubles_adjacent、罫線付きの紙式配置)を
// そのまま使う。python3+openpyxl が無い環境では自動skip(CIでも安全)。
// 実行: node --test test/kumiawase-python-roundtrip.test.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

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

// selftest.py の合成データビルダーをそのまま呼び出してExcelを生成する(PIIなし・罫線付き紙式配置)。
function buildPyFixture(p, builderName, sheetTitle) {
  const code =
    "from openpyxl import Workbook\n" +
    `from bracket_parser.selftest import ${builderName}\n` +
    "import sys\n" +
    `wb=Workbook(); ws=wb.active; ws.title='${sheetTitle}'\n` +
    `${builderName}(ws)\n` +
    "wb.save(sys.argv[1])\n";
  const r = spawnSync("python3", ["-c", code, p], { env: { ...process.env, PYTHONPATH: pyEnvPaths }, timeout: 15000 });
  if (r.status !== 0) throw new Error("py fixture build failed: " + String(r.stderr || ""));
}

function startServer({ port, key, dbPath }) {
  return spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ADMIN_KEY: key, DB_PATH: dbPath, NODE_ENV: "test", SSE_MAX: "10" },
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
    body: JSON.stringify({ name: "py-roundtrip-test", date: "2027-12-15" }),
  });
  const j = await r.json();
  assert.ok(j.id, "大会作成: " + JSON.stringify(j));
  return j.id;
}
async function upload(base, key, tid, filePath, dryRun) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), path.basename(filePath));
  if (dryRun) fd.append("dry_run", "1");
  const r = await fetch(`${base}/api/tournaments/${tid}/kumiawase/upload`, {
    method: "POST", headers: { "X-Admin-Key": key }, body: fd,
  });
  return r.json();
}
async function getMatches(base, key, tid) {
  const r = await fetch(`${base}/api/tournaments/${tid}/matches`, { headers: { "X-Admin-Key": key } });
  return r.json();
}
function rmDb(dbPath) { for (const x of ["", "-wal", "-shm"]) { try { fs.rmSync(dbPath + x, { force: true }); } catch (e) {} } }
function r1Names(matches, event) {
  return matches.filter(m => m.event === event && m.bracket_round === 1)
    .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0))
    .flatMap(m => [m.player1_name, m.player2_name]).filter(n => n && n !== "BYE");
}

describe("Python罫線パーサー: 完全往復(合成データ→取込→DB反映)", { skip: PY ? false : "python3+openpyxl が無いためスキップ" }, () => {
  const PORT = 3927, KEY = "py-roundtrip-key", DB = path.join(os.tmpdir(), `ktta_pyrt_${process.pid}.db`);
  const BASE = `http://127.0.0.1:${PORT}`;
  let srv;
  before(async () => {
    srv = startServer({ port: PORT, key: KEY, dbPath: DB });
    await waitHealth(BASE);
  });
  after(() => {
    if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
    rmDb(DB);
  });

  it("シングルス12名(罫線付き紙式配置)が欠落・重複なく取込まれ、氏名・所属が完全一致する", async () => {
    const fx = path.join(os.tmpdir(), `ktta_pyrt_singles_${process.pid}.xlsx`);
    buildPyFixture(fx, "_build_singles", "男子シングルス");
    try {
      const tid = await createTournament(BASE, KEY);
      const j = await upload(BASE, KEY, tid, fx, false);
      assert.ok(!j.error, "取込失敗: " + JSON.stringify(j));
      assert.strictEqual(j.used_parser, "bracket_parser (python)", "Python主系統で読まれること: " + JSON.stringify(j));
      const matches = await getMatches(BASE, KEY, tid);
      const names = r1Names(matches, "男子シングルス");
      assert.strictEqual(names.length, 12, "12名が欠落なく配置される: " + JSON.stringify(names));
      assert.strictEqual(new Set(names).size, 12, "重複なし: " + JSON.stringify(names));
      // selftest._build_singles が生成する12名(ア太郎〜シ一二)が全員含まれること
      const expected = ["ア 太郎", "イ 次郎", "ウ 三郎", "エ 四郎", "オ 五郎", "カ 六郎",
        "キ 七郎", "ク 八郎", "ケ 九郎", "コ 十郎", "サ 一一", "シ 一二"];
      expected.forEach(nm => assert.ok(names.includes(nm), `${nm} が取込まれていること: ${JSON.stringify(names)}`));
    } finally {
      try { fs.rmSync(fx, { force: true }); } catch (e) {}
    }
  });

  it("ダブルス6組(縦結合・所属同一/別混在)が相方・所属を保ったまま取込まれる", async () => {
    const fx = path.join(os.tmpdir(), `ktta_pyrt_dbl_stacked_${process.pid}.xlsx`);
    buildPyFixture(fx, "_build_doubles_stacked", "男子ダブルス");
    try {
      const tid = await createTournament(BASE, KEY);
      const j = await upload(BASE, KEY, tid, fx, false);
      assert.ok(!j.error, "取込失敗: " + JSON.stringify(j));
      const ents = await (await fetch(`${BASE}/api/tournaments/${tid}/entrants?event=${encodeURIComponent("男子ダブルス")}`,
        { headers: { "X-Admin-Key": KEY } })).json();
      assert.strictEqual(ents.length, 6, "6組のペアentrant: " + JSON.stringify(ents.map(e => e.display_name)));
      // 別所属ペア(ス三=黒中 / セ四=金高)の所属が混ざらないこと
      const suzu = ents.find(e => (e.display_name || "").includes("ス 三") || (e.name || "").includes("ス 三"));
      assert.ok(suzu, "ス三のペアが取込まれている: " + JSON.stringify(ents.map(e => e.display_name || e.name)));
      assert.strictEqual(suzu.team, "黒中", "本人所属=黒中: " + suzu.team);
      assert.strictEqual(suzu.partner_team, "金高", "相方所属=金高(別): " + suzu.partner_team);
    } finally {
      try { fs.rmSync(fx, { force: true }); } catch (e) {}
    }
  });

  it("ダブルス6組(横並び・マスター一覧)が欠落なく取込まれる", async () => {
    const fx = path.join(os.tmpdir(), `ktta_pyrt_dbl_adj_${process.pid}.xlsx`);
    buildPyFixture(fx, "_build_doubles_adjacent", "女子ダブルス");
    try {
      const tid = await createTournament(BASE, KEY);
      const j = await upload(BASE, KEY, tid, fx, false);
      assert.ok(!j.error, "取込失敗: " + JSON.stringify(j));
      const ents = await (await fetch(`${BASE}/api/tournaments/${tid}/entrants?event=${encodeURIComponent("女子ダブルス")}`,
        { headers: { "X-Admin-Key": KEY } })).json();
      assert.strictEqual(ents.length, 6, "6組のペアentrant: " + JSON.stringify(ents.map(e => e.display_name)));
    } finally {
      try { fs.rmSync(fx, { force: true }); } catch (e) {}
    }
  });
});
