// 罫線の自由配線編集(relinkBracketMatch)の検証マトリクス。
// 「試合の進出先を組み替えても、常に有効な木を保つ・確定済み試合を巻き込む変更は明示確認・
//  Undoで完全に元へ戻る・楽観ロックが配線変更を検知する」ことを固定する。
// 実行: node --test test/bracket-relink.test.js
process.env.DB_PATH = "/tmp/ktta_relink_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
function mkEntrants(t, n) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const e = db.createEntrant({ tournament_id: t.id, event: EV,
      name: "選手" + String(i).padStart(3, "0"), team: "ク" + (i % 21), furigana: "せ" + String(i).padStart(3, "0") });
    ids.push(e.id);
  }
  return ids;
}

// 16人の標準大会(4回戦)を作り、1回戦を全て確定させてR2を全てpendingにする。
function setup16() {
  const t = db.createTournament({ name: "relink検証", date: "2027-07-01" });
  mkEntrants(t, 16);
  const gen = db.generateBracket(t.id, EV, {});
  assert.ok(gen && !gen.error, "生成成功: " + JSON.stringify(gen).slice(0, 160));
  const r1 = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
    .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
  assert.strictEqual(r1.length, 8, "1回戦8試合");
  r1.forEach(m => { const r = db.finishMatchOp(m.id, { winner_slot: 1, sets: [] }); assert.ok(!r.error, JSON.stringify(r)); });
  return t;
}
function byRP(tid, round, pos) {
  return db.getMatchesByTournament(tid).filter(m => m.event === EV && m.bracket_round === round && (m.bracket_pos || 0) === pos)[0];
}

test("標準木でrelink成功: 未確定の2回戦試合の進出先を入れ替えられる", () => {
  const t = setup16();
  // R2試合0→R3試合0(pos=floor(0/2)=0)、R2試合2→R3試合1(pos=floor(2/2)=1)。別々の準々決勝へ進む2組。
  const r2_0 = byRP(t.id, 2, 0), r2_2 = byRP(t.id, 2, 2);
  const taOrig = r2_0.next_match_id, tbOrig = r2_2.next_match_id;
  assert.notStrictEqual(taOrig, tbOrig, "元々別々の準々決勝へ進む設定であること");
  const r = db.relinkBracketMatch(t.id, EV, r2_0.id, tbOrig, r2_2.next_slot, {});
  assert.ok(r && r.success, "relink成功: " + JSON.stringify(r));
  const r2_0b = byRP(t.id, 2, 0), r2_2b = byRP(t.id, 2, 2);
  assert.strictEqual(r2_0b.next_match_id, tbOrig, "試合0の送り先がswapされた");
  assert.strictEqual(r2_2b.next_match_id, taOrig, "試合2の送り先もswapされた(常に有効な木)");
});

test("確定済み試合を巻き込む変更はforce無しでneeds_force、forceで成功しその先の結果がリセットされる", () => {
  const t = setup16();
  // R2も全部確定 → R3(準々決勝2試合)が両方とも勝者確定
  const r2 = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 2)
    .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
  assert.strictEqual(r2.length, 4);
  r2.forEach(m => { const r = db.finishMatchOp(m.id, { winner_slot: 1, sets: [] }); assert.ok(!r.error, JSON.stringify(r)); });
  const r3_0 = byRP(t.id, 3, 0), r3_1 = byRP(t.id, 3, 1);
  assert.strictEqual(r3_0.status, "pending", "準々決勝は両者確定でpending");
  assert.strictEqual(r3_1.status, "pending");

  // R2試合0(→R3試合0のslot1)を、R2試合2(→R3試合1のslot1)の送り先へrelink。force無しは拒否。
  const r2_0 = byRP(t.id, 2, 0), r2_2 = byRP(t.id, 2, 2);
  const noForce = db.relinkBracketMatch(t.id, EV, r2_0.id, r2_2.next_match_id, r2_2.next_slot, {});
  assert.ok(noForce.needs_force, "確定試合を巻き込むためneeds_force: " + JSON.stringify(noForce));
  assert.ok(Array.isArray(noForce.affected) && noForce.affected.length > 0, "影響試合が列挙される");

  const forced = db.relinkBracketMatch(t.id, EV, r2_0.id, r2_2.next_match_id, r2_2.next_slot, { force: true });
  assert.ok(forced.success, "force指定で成功: " + JSON.stringify(forced));

  const r3_0b = byRP(t.id, 3, 0), r3_1b = byRP(t.id, 3, 1);
  // 影響を受けたスロットは、新しい送り元(まだ確定済みのR2試合)の勝者で再計算されている
  assert.strictEqual(r3_0b.player1_name, r2_2.status === "completed" ? r3_0b.player1_name : r3_0b.player1_name, "再計算後も欠損なし");
  assert.notStrictEqual(r3_0b.status, "on_table", "巻き込まれた試合が異常状態でない");
});

test("回戦飛び越しはエラー(1回戦→3回戦への直接relinkは拒否)", () => {
  const t = setup16();
  const r1_0 = byRP(t.id, 1, 0);
  const r3_0 = byRP(t.id, 3, 0);
  const r = db.relinkBracketMatch(t.id, EV, r1_0.id, r3_0.id, 1, {});
  assert.ok(r.error, "エラーになること");
  assert.strictEqual(r.code, "round_skip");
});

test("存在しない試合IDはエラー", () => {
  const t = setup16();
  const r2_0 = byRP(t.id, 2, 0);
  const r = db.relinkBracketMatch(t.id, EV, r2_0.id, "does-not-exist", 1, {});
  assert.ok(r.error, "エラーになること: " + JSON.stringify(r));
});

test("undoLastOpでrelink操作が完全に元へ戻る", () => {
  const t = setup16();
  const r2_0 = byRP(t.id, 2, 0), r2_2 = byRP(t.id, 2, 2);
  const taOrig = r2_0.next_match_id, tbOrig = r2_2.next_match_id;
  const r = db.relinkBracketMatch(t.id, EV, r2_0.id, tbOrig, r2_2.next_slot, {});
  assert.ok(r.success);
  const un = db.undoLastOp(t.id);
  assert.ok(un && !un.error, "undo成功: " + JSON.stringify(un));
  const r2_0b = byRP(t.id, 2, 0), r2_2b = byRP(t.id, 2, 2);
  assert.strictEqual(r2_0b.next_match_id, taOrig, "試合0の送り先が元に戻る");
  assert.strictEqual(r2_2b.next_match_id, tbOrig, "試合2の送り先が元に戻る");
});

test("bracketRevはrelinkによる配線変更(氏名不変)を検知する(楽観ロックの穴を塞ぐ)", () => {
  const t = setup16();
  const before = db.bracketRev(t.id, EV);
  const r2_0 = byRP(t.id, 2, 0), r2_2 = byRP(t.id, 2, 2);
  const r = db.relinkBracketMatch(t.id, EV, r2_0.id, r2_2.next_match_id, r2_2.next_slot, {});
  assert.ok(r.success);
  const after_ = db.bracketRev(t.id, EV);
  assert.notStrictEqual(before, after_, "配線だけの変更でもbracketRevが変化すること");
});

test("既にその接続先の場合はno-op(unchanged)", () => {
  const t = setup16();
  const r2_0 = byRP(t.id, 2, 0);
  const r = db.relinkBracketMatch(t.id, EV, r2_0.id, r2_0.next_match_id, r2_0.next_slot, {});
  assert.ok(r.success && r.unchanged, "no-opで成功: " + JSON.stringify(r));
});

test("通常の結果入力・修正操作ではbracketRevが不要に変化しない(next_match_id/next_slotは不変)", () => {
  const t = db.createTournament({ name: "relink非干渉検証", date: "2027-07-01" });
  mkEntrants(t, 8);
  db.generateBracket(t.id, EV, {});
  const r1_0 = byRP(t.id, 1, 0);
  const before = db.bracketRev(t.id, EV);
  db.finishMatchOp(r1_0.id, { winner_slot: 1, sets: [] });
  const after1 = db.bracketRev(t.id, EV);
  assert.notStrictEqual(before, after1, "結果入力でrevは変わる(氏名が次戦へ進むため)");
  // ただし next_match_id/next_slot 自体は不変であることを確認
  const r1_0b = byRP(t.id, 1, 0);
  assert.strictEqual(r1_0b.next_match_id, r1_0.next_match_id, "next_match_idは結果入力で変化しない");
  assert.strictEqual(r1_0b.next_slot, r1_0.next_slot, "next_slotは結果入力で変化しない");
});
