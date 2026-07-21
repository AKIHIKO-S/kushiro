// getPublicBreakdowns(全体統計ダッシュボードの横断集計)の契約を検証する。
// viewer統計タブが依存する「全キーの存在」「選手構成の集計」「試合ゼロ時の母数ガード(null)」を固定する。
// 母集団フィルタ(地区大会のみ・BYE除外)の SQL は getGlobalMatchAverages と同一の実証済み条件を踏襲。
// 実行: node --test test/public-breakdowns.test.js
process.env.DB_PATH = "/tmp/ktta_breakdowns_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

test("getPublicBreakdowns: 選手構成の集計・全キー・試合ゼロ時の母数ガード", () => {
  // 学年区分・支部・性別をばらして登録(team は非学校名にして _autoCategory の上書きを避ける)
  db.createPlayer({ name: "一般太郎", team: "クラブ", category: "general", branch: "釧路", gender: "male" });
  db.createPlayer({ name: "一般次郎", team: "クラブ", category: "general", branch: "釧路", gender: "male" });
  db.createPlayer({ name: "中学花子", team: "クラブ", category: "middle", branch: "帯広", gender: "female" });

  const bd = db.getPublicBreakdowns();

  // (1) viewer が参照する全キーが存在する(欠けると統計タブの該当セクションが壊れる)
  for (const k of ["categoryDist", "genderDist", "branchPlayerDist", "eventCounts", "byYear", "byMonth", "gameStats", "venueCount", "activeMatches", "branchCount"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(bd, k), "キー " + k + " が存在する");
  }

  // (2) 学年区分の集計: general=2, middle=1
  const cat = Object.fromEntries(bd.categoryDist.map((r) => [r.k, r.c]));
  assert.strictEqual(cat.general, 2, "一般2名");
  assert.strictEqual(cat.middle, 1, "中学1名");

  // (3) 支部の集計: 釧路=2, 帯広=1, 支部数=2
  const br = Object.fromEntries(bd.branchPlayerDist.map((r) => [r.k, r.c]));
  assert.strictEqual(br["釧路"], 2, "釧路2名");
  assert.strictEqual(br["帯広"], 1, "帯広1名");
  assert.strictEqual(bd.branchCount, 2, "支部数2");

  // (4) 試合がゼロ → gameStats は母数ガードの契約で null(viewer はこれを「集計中」表示にする)
  assert.strictEqual(bd.gameStats.n, 0, "試合0件");
  assert.strictEqual(bd.gameStats.avgGames, null, "n=0 は avgGames=null");
  assert.strictEqual(bd.gameStats.fullSetPct, null, "n=0 は fullSetPct=null");
  assert.strictEqual(bd.gameStats.shutoutPct, null, "n=0 は shutoutPct=null");
  assert.strictEqual(bd.activeMatches, 0, "活動試合0");
});
