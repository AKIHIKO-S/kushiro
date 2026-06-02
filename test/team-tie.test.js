// 団体戦(tie)運営の回帰テスト (中スコープ: チーム表+結果手入力)。
//  - 団体種目はチーム同士のブラケットを生成(1チーム=1枠)
//  - 対戦(tie)は通常の finish に winner_sets/loser_sets(=チームスコア)+ tie_results(内訳)を渡して記録
//  - 勝者チームが次戦へ進む / correct でやり直せる
// 実行: node --test test/team-tie.test.js
process.env.DB_PATH = "/tmp/ktta_teamtie_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子団体戦";
function teamTournament() {
  const t = db.createTournament({ name: "団体戦検証", date: "2027-11-11" });
  db.updateEntrySettings(t.id, { entries_open: 1,
    event_config: [{ name: EV, type: "team", fee: 4000, per_team: 6, tie_format: "S,S,D,S,S" }] });
  return t;
}
function addTeam(tid, name, members) {
  db.createTeamEntry(tid, { team_name: name, contact_name: "x", contact_email: "x@y.jp",
    entries: [{ event: EV, type: "team", team_name: name, members }] });
}

test("団体種目は1チーム=1枠でブラケット生成される", () => {
  const t = teamTournament();
  ["甲", "乙", "丙", "丁"].forEach(n => addTeam(t.id, n, [n + "1", n + "2", n + "3", n + "4", n + "5"]));
  const r = db.generateBracket(t.id, EV, {});
  assert.ok(!r.error, "生成成功: " + JSON.stringify(r).slice(0, 80));
  assert.strictEqual(r.player_count, 4, "4チームが4枠に");
  const teamNames = new Set();
  db.getOpMatchList(t.id).matches.forEach(m => {
    [m.player1_name, m.player2_name].forEach(n => { if (n && n !== "BYE") teamNames.add(n); });
  });
  ["甲", "乙", "丙", "丁"].forEach(n => assert.ok(teamNames.has(n), n + " がブラケットに居る"));
});

test("tie結果(チームスコア+内訳)を通常 finish で記録でき勝者チームが次戦へ進む", () => {
  const t = teamTournament();
  ["甲", "乙", "丙", "丁"].forEach(n => addTeam(t.id, n, [n + "1", n + "2", n + "3"]));
  db.generateBracket(t.id, EV, {});
  const r1matches = db.getOpMatchList(t.id).matches.filter(
    m => m.player1_name && m.player2_name && m.player1_name !== "BYE" && m.player2_name !== "BYE");
  assert.ok(r1matches.length >= 1, "実チーム同士の1回戦がある");
  const m = r1matches[0];
  const home = m.player1_name, away = m.player2_name;

  // home が 3-2 で勝利(S1,S2 home / D1 away / S3 home / S4 away → home 3, away 2)
  const tie_results = [
    { slot: "S1", type: "S", winner: "home", home: home + "1", away: away + "1", score: "3-0" },
    { slot: "S2", type: "S", winner: "home", home: home + "2", away: away + "2", score: "3-1" },
    { slot: "D1", type: "D", winner: "away", home: home + "/", away: away + "/", score: "1-3" },
    { slot: "S3", type: "S", winner: "home", home: home + "3", away: away + "3", score: "3-2" },
    { slot: "S4", type: "S", winner: "away", home: home + "1", away: away + "1", score: "0-3" },
  ];
  const res = db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 2, tie_results });
  assert.ok(res && !res.error, "finish 成功");

  const saved = db.getMatch(m.id);
  assert.strictEqual(saved.status, "completed");
  assert.strictEqual(saved.winner_name, home, "home チームが勝者");
  assert.strictEqual(saved.winner_sets, 3, "チームスコア 3");
  assert.strictEqual(saved.loser_sets, 2, "チームスコア 2");
  assert.ok(Array.isArray(saved.tie_results) && saved.tie_results.length === 5, "内訳5試合が保存");
  assert.strictEqual(saved.tie_results[2].winner, "away");

  // 勝者チームが次戦へ送り込まれている
  if (saved.next_match_id) {
    const nm = db.getMatch(saved.next_match_id);
    const advanced = [nm.player1_name, nm.player2_name].includes(home);
    assert.ok(advanced, "勝者チームが次戦に進出");
  }
});

test("団体戦は player_id 無なので Elo を更新しない(team×teamは非Elo)", () => {
  const t = teamTournament();
  ["甲", "乙"].forEach(n => addTeam(t.id, n, [n + "1", n + "2"]));
  db.generateBracket(t.id, EV, {});
  const m = db.getOpMatchList(t.id).matches.find(
    x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  const res = db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0, tie_results: [] });
  const saved = db.getMatch(m.id);
  assert.strictEqual(saved.winner_rating_delta || 0, 0, "Elo差分は0(団体は非Elo)");
});

test("tie結果を correct でやり直すと内訳・勝者が更新される", () => {
  const t = teamTournament();
  ["甲", "乙", "丙", "丁"].forEach(n => addTeam(t.id, n, [n + "1", n + "2", n + "3"]));
  db.generateBracket(t.id, EV, {});
  const m = db.getOpMatchList(t.id).matches.find(
    x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  const home = m.player1_name, away = m.player2_name;
  db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0,
    tie_results: [{ slot: "S1", winner: "home" }] });
  // away 勝ちへ訂正
  const c = db.correctResult(m.id, { winner_slot: 2, winner_sets: 3, loser_sets: 1,
    tie_results: [{ slot: "S1", winner: "away" }, { slot: "S2", winner: "away" }] });
  assert.ok(!c.error, "correct 成功: " + JSON.stringify(c).slice(0, 80));
  const saved = db.getMatch(m.id);
  assert.strictEqual(saved.winner_name, away, "訂正後は away が勝者");
  assert.strictEqual(saved.tie_results.length, 2, "内訳が訂正後の内容に置換");
});
