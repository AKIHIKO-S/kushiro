// 取込の「要確認(手動推奨)」対戦の回帰テスト。
//   ① needs_review の対戦は、取込時に結果を入れず「要確認」の印だけ付く(読み取りの候補は残る)
//   ② 確定前は勝敗・履歴・Eloに入らない。確定すると入る(勝者・セット数・棄権)
//   ③ 先の試合に別の人が入っていれば止める / 二重確定・選んでいない確定・セット数の矛盾は断る
//   ④ 確定した人と日時が残る。取り消すと勝敗・Eloが外れ、要確認に戻る。先の試合の並びは変えない
//   ⑤ 公開の勝敗履歴は、確定した試合だけを出す
// 実行: node --test test/review-matches.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
process.env.DB_PATH = path.join(process.env.TMPDIR || require("os").tmpdir(), "ktta_review_" + process.pid + ".db");
process.env.ADMIN_KEY = "fixture-review";
const db = require("../db");
const PP = require("../lib/public-players").create(db);
after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const EV = "男子シングルス";
const mm = (r, pos, a, b, res, extra) => ({ bracket_round: r, bracket_pos: pos, player1_name: a, player1_team: "甲中学校", player2_name: b, player2_team: "乙中学校", result: res, ...(extra || {}) });
let T;
test("下ごしらえ: 4人のトーナメント(準決勝の1試合だけ要確認)", () => {
  T = db.createTournament({ name: "検証の大会", date: "2026-11-22", venue: "体育館" });
  const r = db.importBracket(T.id, { format: "tabletennis-bracket-v1", event: EV, auto_create_players: true, matches: [
    mm(1, 0, "一番 太郎", "二番 次郎", { winner_name: "一番 太郎", loser_name: "二番 次郎", winner_sets: 3, loser_sets: 1, sets: [] }),
    // 疑義: 読み取りの候補は「三番 三郎の勝ち 3-0」だが、確定はしない
    mm(1, 1, "三番 三郎", "四番 四郎", { winner_name: "三番 三郎", loser_name: "四番 四郎", winner_sets: 3, loser_sets: 0, sets: [] }, { needs_review: true, review_note: "線が薄く、どちらが勝ったか読めない" }),
    // 決勝: 用紙では三番 三郎が上がっている(先に名前が入っている)
    mm(2, 0, "一番 太郎", "三番 三郎", { winner_name: "一番 太郎", loser_name: "三番 三郎", winner_sets: 3, loser_sets: 2, sets: [] }),
  ] });
  assert.ok(!r.error, JSON.stringify(r));
});

const rowsOf = (name) => { PP._reset && PP._reset(); const l = PP.listPlayers({ q: name }).items[0]; return PP.playerPage(l.pid); };
const review = () => db.getReviewMatches(T.id);

test("① 要確認の印が付き、結果は入っていない(候補だけ残る)", () => {
  const list = review();
  assert.equal(list.length, 1);
  const x = list[0];
  assert.equal(x.state, "pending"); assert.equal(x.p1, "三番 三郎"); assert.equal(x.p2, "四番 四郎");
  assert.equal(x.note, "線が薄く、どちらが勝ったか読めない");
  assert.deepEqual(x.guess, { winner: "三番 三郎", winner_sets: 3, loser_sets: 0, walkover: false });
  assert.equal(x.winner, "");
  const m = (db.getTournament(T.id).matches || []).find(m => m.id === x.id);
  assert.equal(m.status, "pending"); assert.equal(m.winner_name, "", "自動では確定しない");
});

test("② 確定前は勝敗に入らない / 確定すると入る", () => {
  const four = rowsOf("四番 四郎");
  assert.deepEqual([four.wins, four.losses], [0, 0], "要確認の試合は、勝ちにも負けにも入らない");
  assert.equal(four.tournaments.length ? four.tournaments[0].rows.length : 0, 0, "履歴にも出ない");
  const id = review()[0].id;
  assert.equal(db.resolveReviewMatch(T.id, id, {}).error, "どちらが勝ったかを選んでください");
  assert.match(db.resolveReviewMatch(T.id, id, { winner_slot: 1, winner_sets: 3 }).error, /両方を入れて/);
  assert.match(db.resolveReviewMatch(T.id, id, { winner_slot: 1, winner_sets: 1, loser_sets: 3 }).error, /勝った側が多く/);
  const r = db.resolveReviewMatch(T.id, id, { winner_slot: 1, winner_sets: 3, loser_sets: 1, by: "ope01" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.match.state, "resolved"); assert.equal(r.match.winner, "三番 三郎"); assert.equal(r.match.by, "ope01"); assert.ok(r.match.at);
  const three = rowsOf("三番 三郎");
  const row = three.tournaments[0].rows.find(x => x.opp_name === "四番 四郎");
  assert.equal(row.result, "win"); assert.equal(row.score, "3-1");
  const four2 = rowsOf("四番 四郎");
  assert.deepEqual([four2.wins, four2.losses], [0, 1], "確定すると負けに入る");
  assert.match(db.resolveReviewMatch(T.id, id, { winner_slot: 1 }).error, /すでに確定済み/, "二重に確定できない");
});

test("④ 取り消すと勝敗が外れ、要確認に戻る。もう一度、別の選択もできる", () => {
  const id = review()[0].id;
  const u = db.undoReviewMatch(T.id, id, "ope02");
  assert.ok(u.ok); assert.equal(u.match.state, "pending"); assert.match(u.match.by, /^取消:ope02/);
  assert.deepEqual([rowsOf("四番 四郎").wins, rowsOf("四番 四郎").losses], [0, 0]);
  assert.deepEqual([rowsOf("三番 三郎").wins, rowsOf("三番 三郎").losses], [0, 1], "決勝の結果だけが残る(先の試合は変えない)");
  assert.match(db.undoReviewMatch(T.id, id, "x").error, /確定済みの「要確認」ではありません/);
});

test("③ 先の試合と食い違う勝者は止める / 棄権として確定できる", () => {
  const id = review()[0].id;
  const c = db.resolveReviewMatch(T.id, id, { winner_slot: 2, by: "ope01" });   // 四番 四郎の勝ち → 決勝には三番 三郎が入っている
  assert.ok(c.error && c.conflict_next, "先の試合の組合せと食い違う");
  assert.match(c.error, /三番 三郎/);
  const w = db.resolveReviewMatch(T.id, id, { winner_slot: 1, walkover: true, by: "ope01" });   // 三番 三郎の不戦勝(四番 棄権)
  assert.ok(w.ok); assert.equal(w.match.walkover, true);
  const three = rowsOf("三番 三郎"), four = rowsOf("四番 四郎");
  assert.equal(three.tournaments[0].rows.find(x => x.opp_name === "四番 四郎").result, "walkover_win");
  assert.equal(four.tournaments[0].rows.find(x => x.opp_name === "三番 三郎").result, "withdrew");
  assert.deepEqual([four.wins, four.losses], [0, 0], "棄権は勝敗に入れない");
});

test("⑤ 通常の取込(要確認なし)は従来どおり。別の大会の要確認は混ざらない", () => {
  const T2 = db.createTournament({ name: "別の大会", date: "2026-11-23", venue: "x" });
  assert.equal(db.getReviewMatches(T2.id).length, 0);
  assert.match(db.resolveReviewMatch(T2.id, review()[0].id, { winner_slot: 1 }).error, /見つかりません/, "他の大会の試合は確定できない");
});
