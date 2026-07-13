// 全種目トーナメント表の一括削除(deleteAllBrackets)と、紙式の選手番号
// (BYEを除く通し番号=左山1..k→右山k+1..N)を検証する。
// 実行: node --test test/delete-all-brackets.test.js
process.env.DB_PATH = "/tmp/ktta_delall_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV1 = "一般男子シングルス", EV2 = "一般女子シングルス";
function setup(n1, n2) {
  const t = db.createTournament({ name: "全削除検証" + n1 + "_" + n2, date: "2027-06-06" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [
    { name: EV1, type: "singles", fee: 0 }, { name: EV2, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= n1; i++) entries.push({ event: EV1, type: "singles", name: "男" + String(i).padStart(2, "0"), team: "ク" + (i % 5) });
  for (let i = 1; i <= n2; i++) entries.push({ event: EV2, type: "singles", name: "女" + String(i).padStart(2, "0"), team: "ク" + (i % 5) });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  db.generateBracket(t.id, EV1, {});
  db.generateBracket(t.id, EV2, {});
  return t;
}

test("deleteAllBrackets: 全種目の表を削除し名簿は残す", () => {
  const t = setup(12, 6);
  assert.ok(db.getMatchesByTournament(t.id).length > 0, "前提: 表が生成済み");
  const r = db.deleteAllBrackets(t.id, {});
  assert.strictEqual(r.ok, true, "削除成功");
  assert.deepStrictEqual(r.events.sort(), [EV1, EV2].sort(), "対象種目一覧: " + JSON.stringify(r.events));
  assert.strictEqual(db.getMatchesByTournament(t.id).length, 0, "matchesが0件");
  assert.strictEqual(db.getEntrants(t.id).length, 18, "名簿(entrants)は残る");
});

test("deleteAllBrackets: 結果入力済みは needs_force、force で削除できる", () => {
  const t = setup(8, 4);
  // 実対戦を1件確定させる
  const m = db.getMatchesByTournament(t.id).find(x =>
    x.bracket_round === 1 && x.player1_name && x.player2_name &&
    x.player1_name !== "BYE" && x.player2_name !== "BYE");
  assert.ok(m, "前提: 実対戦が存在");
  db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0 });
  const r1 = db.deleteAllBrackets(t.id, {});
  assert.strictEqual(r1.needs_force, true, "結果ありは needs_force: " + JSON.stringify(r1));
  assert.ok(db.getMatchesByTournament(t.id).length > 0, "ガード時は未削除");
  const r2 = db.deleteAllBrackets(t.id, { force: true });
  assert.strictEqual(r2.ok, true, "force で削除");
  assert.strictEqual(db.getMatchesByTournament(t.id).length, 0, "全削除済み");
});

test("deleteAllBrackets: 表なしは空成功(冪等)", () => {
  const t = db.createTournament({ name: "表なし", date: "2027-06-06" });
  const r = db.deleteAllBrackets(t.id, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.deleted, 0);
});

test("選手番号: BYEを除く通し番号(左山1..k → 右山k+1..N・欠番なし)", () => {
  const t = setup(12, 4);   // EV1=12人 → 16枠・BYE4
  const ents = db.getEntrants(t.id, EV1);
  const nums = ents.map(e => e.bracket_number).filter(n => n > 0).sort((a, b) => a - b);
  assert.strictEqual(nums.length, 12, "全員に番号");
  assert.deepStrictEqual(nums, [...Array(12)].map((_, i) => i + 1), "1..12の連番(欠番なし): " + JSON.stringify(nums));
  // 左山(L)の番号は右山(R)の番号より全て小さい(紙の 1〜k / k+1〜N 方式)
  const maxL = Math.max(...ents.filter(e => e.bracket_side === "L").map(e => e.bracket_number));
  const minR = Math.min(...ents.filter(e => e.bracket_side === "R").map(e => e.bracket_number));
  assert.ok(maxL < minR, "左山 " + maxL + " < 右山 " + minR);
});
