// コートレイアウト設定とコート盤面(tables)の整合を検証する。
// バグ: 既定値が4×11のため「明示的に44コート(4×11)を保存」しても court_count(既定4)からの
// 縮小推定(db.js getOperationState)が発動し、観戦/進行のコート盤面が4台になっていた。
// 修正: setCourtLayout が court_count = rows×cols も更新する(レイアウト保存を正とする)。
// 実行: node --test test/court-layout.test.js
process.env.DB_PATH = "/tmp/ktta_courtlayout_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

test("44コート(4×11)を明示保存すると盤面が44台になる", () => {
  const t = db.createTournament({ name: "レイアウト44", date: "2027-02-01" });   // court_count 既定4
  db.setCourtLayout(t.id, { court_rows: 4, court_cols: 11, hq_position: "bottom", numbering_origin: "bottom-right" });
  const st = db.getOperationState(t.id);
  assert.strictEqual((st.tables || []).length, 44, "盤面44台: " + (st.tables || []).length);
  const t2 = db.getTournament(t.id);
  assert.strictEqual(t2.court_count, 44, "court_countも44に同期: " + t2.court_count);
});

test("小規模大会(court_count=6・レイアウト未保存)は縮小推定が生きる", () => {
  const t = db.createTournament({ name: "小規模6", date: "2027-02-01", court_count: 6 });
  const st = db.getOperationState(t.id);
  assert.strictEqual((st.tables || []).length, 6, "未保存時はcourt_countから6台: " + (st.tables || []).length);
});

test("任意レイアウト(2×5)の保存で10台+court_count=10", () => {
  const t = db.createTournament({ name: "レイアウト10", date: "2027-02-01" });
  db.setCourtLayout(t.id, { court_rows: 2, court_cols: 5, hq_position: "top", numbering_origin: "top-left" });
  const st = db.getOperationState(t.id);
  assert.strictEqual((st.tables || []).length, 10, "盤面10台");
  assert.strictEqual(db.getTournament(t.id).court_count, 10, "court_count=10");
  // 番号は1..10が一度ずつ
  const nos = (st.tables || []).map(x => x.table_no).sort((a, b) => a - b);
  assert.deepStrictEqual(nos, [...Array(10)].map((_, i) => i + 1), "台番号1..10");
});
