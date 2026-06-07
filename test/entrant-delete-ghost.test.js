// 整合性チェックの「重複削除」回帰: 進出済み(2回戦以降)の entrant を削除したとき、
// 焼き込まれた表示名が次戦の枠に「ゴースト」として残らないこと(deleteEntrant が全ラウンドの
// 未消化枠の氏名/参照を消す)。確定済みの試合は対戦履歴として氏名を残す。
// 実行: node --test test/entrant-delete-ghost.test.js
process.env.DB_PATH = "/tmp/ktta_delghost_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const EV = "男子シングルス";
let _seq = 0;

test("deleteEntrant: BYEで2回戦に進出した entrant を削除すると次戦のゴースト名が残らない", () => {
  const t = db.createTournament({ name: "削除ゴースト" + (++_seq), date: "2027-10-01" });
  // 3名 → サイズ4・1BYE。上位シードが1回戦不戦勝で2回戦(決勝)へ自動進出する。
  db.createEntrant({ tournament_id: t.id, event: EV, seed: 1, surname: "山田", given_name: "一", team: "A", status: "confirmed" });
  db.createEntrant({ tournament_id: t.id, event: EV, seed: 2, surname: "佐藤", given_name: "二", team: "B", status: "confirmed" });
  db.createEntrant({ tournament_id: t.id, event: EV, seed: 3, surname: "鈴木", given_name: "三", team: "C", status: "confirmed" });
  db.generateBracket(t.id, EV, { regenerate: true });

  // 2回戦(決勝)で、片側だけ埋まっている(=BYE勝ち上がりが焼き込まれた)枠を探す。
  const allMatches = () => db.getMatchesByTournament(t.id).filter(m => m.event === EV);
  const r2 = allMatches().find(m => m.bracket_round === 2);
  assert.ok(r2, "2回戦の試合が存在する");
  const advancedEid = r2.player1_entrant_id || r2.player2_entrant_id;
  assert.ok(advancedEid, "BYE勝ち上がりの entrant が2回戦の枠に入っている: " + JSON.stringify(r2));
  const advancedSlot = r2.player1_entrant_id === advancedEid ? 1 : 2;
  const ghostName = advancedSlot === 1 ? r2.player1_name : r2.player2_name;
  assert.ok(ghostName && ghostName.trim(), "進出枠に表示名が焼き込まれている: " + ghostName);

  // この進出済み entrant を削除。
  db.deleteEntrant(advancedEid);

  const r2after = allMatches().find(m => m.id === r2.id);
  const nameAfter = advancedSlot === 1 ? r2after.player1_name : r2after.player2_name;
  const eidAfter = advancedSlot === 1 ? r2after.player1_entrant_id : r2after.player2_entrant_id;
  assert.strictEqual((nameAfter || "").trim(), "", "削除後、2回戦のゴースト名が消えている: '" + nameAfter + "'");
  assert.strictEqual(eidAfter, null, "削除後、2回戦の entrant 参照も外れている: " + eidAfter);
});

test("deleteEntrant: 確定済み(completed)の試合の氏名は対戦履歴として残す", () => {
  const t = db.createTournament({ name: "削除履歴" + (++_seq), date: "2027-10-02" });
  const a = db.createEntrant({ tournament_id: t.id, event: EV, seed: 1, surname: "甲", given_name: "一", team: "A", status: "confirmed" });
  const b = db.createEntrant({ tournament_id: t.id, event: EV, seed: 2, surname: "乙", given_name: "二", team: "B", status: "confirmed" });
  db.generateBracket(t.id, EV, { regenerate: true });

  // 2名=サイズ2、決勝1試合を消化する。
  const m = db.getMatchesByTournament(t.id).find(x => x.event === EV && x.bracket_round === 1);
  assert.ok(m, "1回戦(決勝)が存在");
  const winnerSlot = m.player1_entrant_id === a.id ? 1 : 2;
  db.finishMatchOp(m.id, { winner_slot: winnerSlot, sets: [[11, 5], [11, 7], [11, 9]] });
  const done = db.getMatchesByTournament(t.id).find(x => x.id === m.id);
  assert.strictEqual(done.status, "completed", "試合が確定済み");
  const aName = winnerSlot === 1 ? done.player1_name : done.player2_name;
  assert.ok(aName && aName.trim(), "確定済み試合に勝者名が入っている: " + aName);

  // 勝者(a)を削除しても、確定済み試合の氏名は履歴として残る(FK だけ外れる)。
  db.deleteEntrant(a.id);
  const after = db.getMatchesByTournament(t.id).find(x => x.id === m.id);
  const aNameAfter = winnerSlot === 1 ? after.player1_name : after.player2_name;
  const aEidAfter = winnerSlot === 1 ? after.player1_entrant_id : after.player2_entrant_id;
  assert.strictEqual((aNameAfter || "").trim(), (aName || "").trim(), "確定済み試合の氏名は残る(履歴保持): " + aNameAfter);
  assert.strictEqual(aEidAfter, null, "確定済み試合の entrant 参照は外れる: " + aEidAfter);
});
