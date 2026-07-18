// 出場回数(appearances)を試合データ由来の自動集計に一本化(オーナー決定 2026-07-18)の回帰:
//  - 手動格納値を無視し、その選手が対戦した「大会の異なり数」を返す(閲覧の「出場大会」と一致)。
//  - getPlayer(単体)・getPlayers(一覧)の双方で成立。
// 実行: node --test test/player-appearances-auto.test.js
process.env.DB_PATH = "/tmp/ktta_appear_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// 指定選手が1試合する大会を1つ作る(相手も選手連携し勝敗=winner_id/loser_idが入る)
function playOneTournament(name, date, event, meId, oppId) {
  const t = db.createTournament({ name, date });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: event, type: "singles", fee: 0 }] });
  db.createEntrant({ tournament_id: t.id, event, name: "自分", player_id: meId, status: "confirmed" });
  db.createEntrant({ tournament_id: t.id, event, name: "相手", player_id: oppId, status: "confirmed" });
  db.generateBracket(t.id, event, { regenerate: true });
  const m = db.getMatchesByTournament(t.id).find(x => x.event === event && (x.bracket_round || 1) === 1
    && x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  assert.ok(m, "実対戦がある");
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  return t;
}

test("出場回数は試合由来の自動集計=大会の異なり数(手動値は無視)", () => {
  const EV = "男子シングルス";
  // 手動 appearances=99 を指定しても、表示は自動集計に上書きされる
  const me = db.createPlayer({ name: "出場 太郎", furigana: "しゆつじよう たろう", team: "釧路ク", gender: "male", appearances: 99 });
  const opp = db.createPlayer({ name: "相手 次郎", furigana: "あいて じろう", team: "帯広中", gender: "male" });

  // まだ試合が無い時点では 0
  assert.strictEqual(db.getPlayer(me.id).appearances, 0, "試合が無ければ自動集計は0(手動99は無視)");

  playOneTournament("出場検証大会A", "2027-11-01", EV, me.id, opp.id);
  playOneTournament("出場検証大会B", "2027-11-02", EV, me.id, opp.id);

  // getPlayer(単体)=2大会
  assert.strictEqual(db.getPlayer(me.id).appearances, 2, "2大会に出場=自動集計2");
  // getPlayers(一覧)でも2
  const row = db.getPlayers({}).find(x => x.id === me.id);
  assert.ok(row, "一覧に居る");
  assert.strictEqual(row.appearances, 2, "一覧の出場回数も自動集計2");
  // レート順ソート等が使う値も自動集計(sort=appearances)
  const sorted = db.getPlayers({ sort: "appearances" });
  assert.strictEqual(sorted.find(x => x.id === me.id).appearances, 2, "appearancesソートでも自動集計");
});
