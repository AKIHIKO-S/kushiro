// 観戦ライブの「コート盤面(tables)」のサイズ決定の回帰テスト。
//   旧実装は既定レイアウト 4×11=44 を court_count に関係なく使い、4コート運用でも44台を並べていた。
//   修正後: 既定レイアウトのままなら court_count から実コート数のグリッドを導出。明示レイアウトは尊重。
// 実行: node --test test/live-court-grid.test.js
process.env.DB_PATH = "/tmp/ktta_courtgrid_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

let seq = 0;
function mk(courtCount, layout) {
  const t = db.createTournament(Object.assign({ name: "court" + (++seq), date: "2027-10-10", court_count: courtCount }, layout || {}));
  return t;
}
const tableCount = (tid) => db.getOperationState(tid).tables.length;

test("court_count=4 / 既定レイアウト → ライブ盤面は4台(44ではない)", () => {
  const t = mk(4);
  assert.strictEqual(tableCount(t.id), 4, "4コート運用は4台");
});

test("court_count=44 / 既定レイアウト → 4×11=44台のまま(本番大会場は不変)", () => {
  const t = mk(44);
  assert.strictEqual(tableCount(t.id), 44, "44コートは44台(従来どおり)");
});

test("court_count=12 → 折返しグリッドで12台(過不足なし)", () => {
  const t = mk(12);
  const n = tableCount(t.id);
  assert.ok(n >= 12 && n <= 12 + 11, "12台近傍(余剰は1行未満): " + n);
  // 余剰セルが極小であること(タイトな折返し)
  assert.ok(n - 12 < 11, "余剰セルは11未満: " + (n - 12));
});

test("court_count=8 → 8台", () => {
  assert.strictEqual(tableCount(mk(8).id), 8);
});

test("明示レイアウト(court_rows×court_cols)を設定したら court_count より優先・尊重", () => {
  // レイアウトを 2×3=6 に明示設定。court_count=4 でも盤面は6台(運営の明示指定を尊重)。
  const t = mk(4, { court_rows: 2, court_cols: 3 });   // createTournament は court_rows/cols を受ける
  assert.strictEqual(tableCount(t.id), 6, "明示2×3=6台が尊重される");
  // setCourtLayout 経由での更新も尊重される
  db.setCourtLayout(t.id, { court_rows: 3, court_cols: 5 });
  assert.strictEqual(tableCount(t.id), 15, "setCourtLayoutで3×5=15台に");
});

test("呼出中の試合は実台番号の盤面セルに乗る(小規模グリッドでも消えない)", () => {
  const t = mk(4);
  db.createEntrant({ tournament_id: t.id, event: "男子シングルス", surname: "甲", given_name: "一", team: "A", status: "confirmed" });
  db.createEntrant({ tournament_id: t.id, event: "男子シングルス", surname: "乙", given_name: "二", team: "B", status: "confirmed" });
  db.generateBracket(t.id, "男子シングルス", { regenerate: true });
  db.updateTournament(t.id, { status: "ongoing" });
  const m = db.getMatchesByTournament(t.id).find(x => x.event === "男子シングルス" && x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  db.callMatch(m.id, 1);
  const st = db.getOperationState(t.id);
  const cell = st.tables.find(c => c.table_no === 1);
  assert.ok(cell, "台1のセルが盤面にある");
  assert.ok(cell.match && (cell.match.player1_name === "甲 一" || cell.match.player2_name === "甲 一"),
    "台1セルに呼出中の試合が乗る: " + JSON.stringify(cell.match && [cell.match.player1_name, cell.match.player2_name]));
});
