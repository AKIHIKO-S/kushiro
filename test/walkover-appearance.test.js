// 棄権(不戦勝)を「大会参加」に数え、戦績(勝敗・Elo)には入れない回帰テスト。
//
// 守らせる不変条件:
//   ① 結果入りJSONの result.walkover=true の試合は、棄権した選手の出場に数えるが勝敗には入れない(相手の勝ちも入れない)
//   ② 選手の出場回数は、一覧(getPlayers)と詳細(getPlayer)で同じ。BYE(相手が実選手でない)は参加に数えない
//   ③ 取込→書き出し→取込で、不戦勝の印が保たれる
// 実行: node --test test/walkover-appearance.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_walkover_" + process.pid + ".db");
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const EV = "男子シングルス";
const m = (round, pos, p1, p2, result) => ({ bracket_round: round, bracket_pos: pos, player1_name: p1 || "", player1_team: p1 ? "検証中" : "",
  player2_name: p2 || "", player2_team: p2 && p2 !== "BYE" ? "検証中" : "", result: result || undefined });
const res = (w, l, extra) => ({ winner_name: w, loser_name: l, winner_sets: 3, loser_sets: 1, sets: [], ...(extra || {}) });

function bracket() {
  return { format: "tabletennis-bracket-v1", event: EV, bracket_size: 8, matches: [
    m(1, 0, "棄権 一郎", "勝上 二郎", res("勝上 二郎", "棄権 一郎", { winner_sets: 0, loser_sets: 0, walkover: true })),   // 棄権
    m(1, 1, "実戦 三郎", "実戦 四郎", res("実戦 三郎", "実戦 四郎")),
    m(1, 2, "不戦 五郎", "BYE", res("不戦 五郎", "BYE", { winner_sets: 0, loser_sets: 0 })),                                   // BYE
    m(1, 3, "実戦 六郎", "実戦 七郎", res("実戦 六郎", "実戦 七郎")),
    m(2, 0, "勝上 二郎", "実戦 三郎", res("実戦 三郎", "勝上 二郎")),
    m(2, 1, "不戦 五郎", "実戦 六郎", res("実戦 六郎", "不戦 五郎")),
    m(3, 0, "実戦 三郎", "実戦 六郎", res("実戦 三郎", "実戦 六郎")),
  ] };
}
const byName = (n) => db.getPlayers({ search: n }).find(p => p.name === n);

test("①② 棄権した選手は出場1・勝敗0。相手の不戦勝は勝ちに入らない。一覧と詳細の出場が一致", () => {
  const t = db.createTournament({ name: "棄権検証大会", date: "2099-12-06" });
  const r = db.importBracket(t.id, bracket());
  assert.ok(!r.error, r.error);
  const quit = byName("棄権 一郎"), winner = byName("勝上 二郎");
  assert.ok(quit && winner);
  const dq = db.getPlayer(quit.id);
  assert.strictEqual(dq.appearances, 1, "棄権した選手の出場は1");
  assert.strictEqual(quit.appearances, 1, "一覧でも出場1");
  assert.strictEqual(quit.match_wins || 0, 0); assert.strictEqual(quit.match_losses || 0, 0);
  assert.strictEqual(dq.matches.length, 0, "戦績の試合には入らない");
  // 相手: 不戦勝は勝ちに入らず、2回戦の負けだけが入る
  assert.strictEqual(winner.match_wins || 0, 0, "不戦勝の勝ちは入らない");
  assert.strictEqual(winner.match_losses || 0, 1);
  assert.strictEqual(db.getPlayer(winner.id).appearances, 1);
  // Elo: 棄権の試合では動かない(2人とも初期値のまま、または勝上は2回戦の敗戦分だけ)
  assert.strictEqual(db.getPlayer(quit.id).rating, 1500, "棄権した選手のEloは動かない");
  // BYEだけの選手でも、2回戦で実選手と対戦しているので出場は1(BYE自体は数えない)
  assert.strictEqual(byName("不戦 五郎").appearances, 1);
  // 一覧と詳細の出場回数が全員一致
  db.getPlayers().forEach(p => assert.strictEqual(db.getPlayer(p.id).appearances, p.appearances, p.name));
});

test("② BYEしかない選手は参加に数えない", () => {
  const t = db.createTournament({ name: "BYEのみ検証大会", date: "2099-12-07" });
  const r = db.importBracket(t.id, { format: "tabletennis-bracket-v1", event: EV, bracket_size: 2, matches: [
    m(1, 0, "ひとり 八郎", "BYE", res("ひとり 八郎", "BYE", { winner_sets: 0, loser_sets: 0 })) ] });
  assert.ok(!r.error, r.error);
  const p = byName("ひとり 八郎");
  assert.strictEqual(p ? p.appearances : 0, 0, "相手が実選手でない試合だけなら出場に数えない");
});

test("③ 取込→書き出し→取込で不戦勝の印が保たれる", () => {
  const t1 = db.createTournament({ name: "往復検証大会A", date: "2099-12-08" });
  assert.ok(!db.importBracket(t1.id, bracket()).error);
  const exp = db.exportBracket(t1.id, EV);
  const wos = exp.matches.filter(x => x.result && x.result.walkover);
  assert.strictEqual(wos.length, 1, "書き出しに不戦勝の印が出る(BYEは印にしない)");
  assert.strictEqual(wos[0].result.loser_name, "棄権 一郎");
  const t2 = db.createTournament({ name: "往復検証大会B", date: "2099-12-09" });
  const r = db.importBracket(t2.id, JSON.parse(JSON.stringify(exp)));
  assert.ok(!r.error, r.error);
  const again = db.exportBracket(t2.id, EV);
  assert.strictEqual(again.matches.filter(x => x.result && x.result.walkover).length, 1, "取込し直しても印が残る");
});
