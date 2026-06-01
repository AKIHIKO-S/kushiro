// Elo レーティング整合性の回帰テスト (#3/#4/#6/#10/#11/#12/#22)。
// finish 時に適用差分を試合行へ保存し、correct/undo/edit で「保存差分」を厳密に逆算/再適用する。
// 旧実装は post-rating から再計算(rating*2-newWin)していたため往復でドリフトしていた。
// 実行: node --test test/elo-integrity.test.js
process.env.DB_PATH = "/tmp/ktta_elotest_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

function setup() {
  const t = db.createTournament({ name: "Elo検証", date: "2027-02-02" });
  const p1 = db.createPlayer({ name: "甲 一郎", team: "A" });   // rating 1500
  const p2 = db.createPlayer({ name: "乙 二郎", team: "B" });   // rating 1500
  // createMatch は legacy(勝敗)形状で player1/2_id を持たないため、進行用の対戦カードは
  // editMatch で player1_id/player2_id + pending を設定する (勝者は与えないので Elo は未適用)。
  const created = db.createMatch({ tournament_id: t.id, event: "男子シングルス", round: "決勝" });
  db.editMatch(created.id, {
    player1_id: p1.id, player2_id: p2.id, status: "pending",
    event: "男子シングルス", round: "決勝",
  });
  return { t, p1, p2, m: db.getMatch(created.id) };
}
const rating = (id) => db.getPlayer(id).rating;

test("finish→correct で勝者反転しても厳密に逆算でき、往復してもドリフトしない (#10/#12/#22)", () => {
  const { m, p1, p2 } = setup();
  assert.strictEqual(rating(p1.id), 1500);
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  const w1 = rating(p1.id), l1 = rating(p2.id);
  assert.ok(w1 > 1500 && l1 < 1500, "P1勝ち → P1上昇/P2下降");
  assert.strictEqual(w1 + l1, 3000, "ゼロサム (合計保存)");

  // 勝者をP2へ訂正 → 元の勝敗値が左右入れ替わるだけ (再計算ドリフトしない)
  db.correctResult(m.id, { winner_slot: 2, sets: [[5, 11], [5, 11], [5, 11]] });
  assert.strictEqual(rating(p1.id), l1, "訂正後 P1 = 元の敗者値");
  assert.strictEqual(rating(p2.id), w1, "訂正後 P2 = 元の勝者値");

  // 何度往復してもドリフトしない (旧実装は ±1 ずつズレていた)
  for (let i = 0; i < 6; i++) {
    db.correctResult(m.id, { winner_slot: 1, sets: [[11, 0], [11, 0], [11, 0]] });
    db.correctResult(m.id, { winner_slot: 2, sets: [[0, 11], [0, 11], [0, 11]] });
  }
  assert.strictEqual(rating(p1.id), l1, "往復後も P1 値が不変 (drift なし)");
  assert.strictEqual(rating(p2.id), w1, "往復後も P2 値が不変 (drift なし)");
});

test("undo(finish) で rating が baseline に厳密復帰し試合も未完了へ戻る (#3/#6)", () => {
  const { t, m, p1, p2 } = setup();
  const ids = db.collectForwardChain(m.id);
  const before = db.snapshotMatchRows(ids);
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  db.recordOp(t.id, "finish", "結果入力", ids, before);
  assert.notStrictEqual(rating(p1.id), 1500, "finish で rating 変化");

  const r = db.undoLastOp(t.id);
  assert.ok(r.ok, "undo 成功");
  assert.strictEqual(rating(p1.id), 1500, "undo で P1 が 1500 に復帰");
  assert.strictEqual(rating(p2.id), 1500, "undo で P2 が 1500 に復帰");
  assert.notStrictEqual(db.getMatch(m.id).status, "completed", "undo で未完了へ戻る");
});

test("undo(correct)→undo(finish) の二段で 元結果→baseline へ正確に戻る (#3/#6)", () => {
  const { t, m, p1, p2 } = setup();
  let ids = db.collectForwardChain(m.id), before = db.snapshotMatchRows(ids);
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  db.recordOp(t.id, "finish", "f", ids, before);
  const w1 = rating(p1.id), l1 = rating(p2.id);

  ids = db.collectForwardChain(m.id); before = db.snapshotMatchRows(ids);
  db.correctResult(m.id, { winner_slot: 2, sets: [[5, 11], [5, 11], [5, 11]] });
  db.recordOp(t.id, "correct", "c", ids, before);
  assert.strictEqual(rating(p2.id), w1, "correct 後 P2 = 勝者値");

  db.undoLastOp(t.id);   // undo correct → 元の finish(P1勝ち)状態
  assert.strictEqual(rating(p1.id), w1, "undo(correct) で P1 が勝者値へ");
  assert.strictEqual(rating(p2.id), l1, "undo(correct) で P2 が敗者値へ");

  db.undoLastOp(t.id);   // undo finish → baseline
  assert.strictEqual(rating(p1.id), 1500, "undo(finish) で P1=1500");
  assert.strictEqual(rating(p2.id), 1500, "undo(finish) で P2=1500");
});

test("editMatch: 完了結果の勝者反転で Elo も移動し is_walkover を再計算 (#4/#11)", () => {
  const { m, p1, p2 } = setup();
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  const w1 = rating(p1.id), l1 = rating(p2.id);

  db.editMatch(m.id, { winner_slot: 2, sets: [[5, 11], [5, 11], [5, 11]] });
  assert.strictEqual(rating(p2.id), w1, "edit で P2 = 勝者値 (Elo 移動)");
  assert.strictEqual(rating(p1.id), l1, "edit で P1 = 敗者値");
  assert.strictEqual(db.getMatch(m.id).is_walkover, 0, "実結果なので is_walkover=0");
});
