const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
process.env.DB_PATH = path.join(__dirname, "../scratchpad", "result-boundaries-" + process.pid + ".db");
const db = require("../db");
after(() => { for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(process.env.DB_PATH + suffix, { force: true }); });
const event = "男子シングルス";
function match(round, pos, a, b, result, extra = {}) {
  return { bracket_round: round, bracket_pos: pos, player1_name: a, player1_team: "検証甲クラブ", player2_name: b, player2_team: "検証乙クラブ", result, ...extra };
}
const result = (a, b) => ({ winner_name: a, loser_name: b, winner_sets: 3, loser_sets: 1, sets: [] });

test("要確認の確定が、終了済み次戦の結果・状態・Elo差分を保持する", () => {
  const t = db.createTournament({ name: "境界検証大会", date: "2026-11-25" });
  const imported = db.importBracket(t.id, { format: "tabletennis-bracket-v1", event, auto_create_players: true, matches: [
    match(1, 0, "試験 甲", "試験 乙", result("試験 甲", "試験 乙")),
    match(1, 1, "試験 丙", "試験 丁", result("試験 丙", "試験 丁"), { needs_review: true }),
    match(2, 0, "試験 甲", "試験 丙", result("試験 甲", "試験 丙")),
  ] });
  assert.ok(!imported.error, JSON.stringify(imported));
  const finalBefore = db.getMatch(db.getMatchesByTournament(t.id).find(m => m.bracket_round === 2).id);
  assert.equal(finalBefore.status, "completed");
  const pending = db.getReviewMatches(t.id)[0];
  assert.ok(db.resolveReviewMatch(t.id, pending.id, { winner_slot: 1, winner_sets: 3, loser_sets: 1, by: "fixture" }).ok);
  assert.deepEqual(db.getMatch(finalBefore.id), finalBefore, "同じ選手の再進出で次戦を変更しない");
  const ids = [finalBefore.player1_id, finalBefore.player2_id];
  const ratings = ids.map(id => db.getPlayer(id).rating);
  db.finishMatchOp(finalBefore.id, { winner_slot: 1, winner_sets: 3, loser_sets: 1 });
  assert.deepEqual(ids.map(id => db.getPlayer(id).rating), ratings, "再確定でEloを加算しない");
  assert.ok(db.undoReviewMatch(t.id, pending.id, "fixture").ok);
  const sql = require("better-sqlite3")(process.env.DB_PATH);
  sql.prepare("UPDATE matches SET status='on_table' WHERE id=?").run(finalBefore.id);
  sql.close();
  const playing = db.getMatch(finalBefore.id);
  assert.ok(db.resolveReviewMatch(t.id, pending.id, { winner_slot: 1, winner_sets: 3, loser_sets: 1, by: "fixture" }).ok);
  assert.deepEqual(db.getMatch(finalBefore.id), playing, "進行中の次戦も保持する");
});

test("一意に照合できる選手2の勝利と空白の正規化を維持する", () => {
  const t = db.createTournament({ name: "選手二勝利検証", date: "2026-11-25" });
  const r = db.importBracket(t.id, { format: "tabletennis-bracket-v1", event, matches: [
    match(1, 0, "試験 一", "試験 二", result(" 試験　二 ", "試験 一")),
  ] });
  assert.ok(!r.error);
  const saved = db.getMatchesByTournament(t.id)[0];
  assert.equal(saved.status, "completed");
  assert.equal(saved.winner_name, "試験 二");
  assert.equal(r.matches_with_results, 1);
});

test("不一致・曖昧な取込勝者は要確認となり、勝敗へ加算しない", () => {
  for (const [a, b, winner] of [["検証 一", "検証 二", "別の 人"], ["同名 選手", "同名 選手", "同名 選手"]]) {
    const t = db.createTournament({ name: "勝者照合検証", date: "2026-11-25" });
    const r = db.importBracket(t.id, { format: "tabletennis-bracket-v1", event, matches: [match(1, 0, a, b, result(winner, b))] });
    assert.ok(!r.error, JSON.stringify(r));
    const saved = db.getMatchesByTournament(t.id)[0];
    assert.notEqual(saved.status, "completed");
    assert.equal(saved.winner_name, "");
    assert.equal(db.getReviewMatches(t.id)[0].state, "pending");
    assert.equal(r.matches_with_results, 0);
  }
});

test("BYEの誤った勝者候補は採用せず、実選手を進出させて要確認を残さない", () => {
  for (const round of [1, 2]) {
    const t = db.createTournament({ name: "不戦勝候補検証", date: "2026-11-25" });
    const r = db.importBracket(t.id, { format: "tabletennis-bracket-v1", event, matches: [
      match(round, 0, "試験 不戦", "BYE", result("別の 人", "BYE")),
    ] });
    assert.ok(!r.error);
    const saved = db.getMatchesByTournament(t.id)[0];
    assert.equal(saved.status, "completed");
    assert.equal(saved.winner_name, "試験 不戦");
    assert.equal(saved.is_walkover, 1);
    assert.equal(db.getReviewMatches(t.id).length, 0);
    assert.equal(r.matches_with_results, 0);
  }
});

test("名前が同じでも別の出場IDが次戦にあれば、確定を巻き戻して拒否する", () => {
  const t = db.createTournament({ name: "同名別出場検証", date: "2026-11-25" });
  db.importBracket(t.id, { format: "tabletennis-bracket-v1", event, auto_create_players: false, matches: [
    match(1, 0, "同名 検証", "対戦 甲", result("同名 検証", "対戦 甲"), { needs_review: true }),
    match(1, 1, "決勝 乙", "対戦 丙", result("決勝 乙", "対戦 丙")),
    match(2, 0, "同名 検証", "決勝 乙", result("決勝 乙", "同名 検証")),
  ] });
  const final = db.getMatchesByTournament(t.id).find(m => m.bracket_round === 2);
  const pending = db.getReviewMatches(t.id)[0];
  const other = db.createEntrant({ tournament_id: t.id, event, name: "同名 検証", team: "別所属クラブ" });
  const sql = require("better-sqlite3")(process.env.DB_PATH);
  sql.prepare("UPDATE matches SET player1_entrant_id=? WHERE id=?").run(other.id, final.id);
  sql.close();
  const before = db.getMatch(final.id);
  assert.throws(() => db.resolveReviewMatch(t.id, pending.id, { winner_slot: 1 }), /出場者を変更できません/);
  assert.deepEqual(db.getMatch(final.id), before);
  assert.equal(db.getReviewMatches(t.id)[0].state, "pending");
  assert.equal(db.getMatch(pending.id).winner_name, "");
});
