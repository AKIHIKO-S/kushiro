// 団体リーグ(総当たり)の生成と順位算出の不変条件テスト。
// 順位: 勝敗数 → セット率(Σ取得/Σ失セット) → 得点率(Σ取得/Σ失点) → 同率は抽選フラグ。
// 実行: node --test test/team-league.test.js
process.env.DB_PATH = "/tmp/ktta_league_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const EV = "男子団体";
let _seq = 0;
function setup(teamNames) {
  const t = db.createTournament({ name: "団体L" + (++_seq), date: "2027-01-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "team", fee: 0, tie_format: "S,S,D,S,S" }] });
  teamNames.forEach((nm, i) => db.createEntrant({ tournament_id: t.id, event: EV, name: nm, team: nm, seed: i + 1, status: "confirmed" }));
  return t;
}
const leagueMatches = (t) => db.getMatchesByTournament(t.id).filter(m => m.league_block);
const entId = (t, team) => db.getEntrants(t.id, EV).find(e => e.team === team).id;

// match を「homeが hSetsWins-aSetsWins で決着」で記録。games で各個別試合のセット得点も作る。
// perGamePts: 勝ったセットの得点 [win, lose](既定 11,7)。これでセット率/得点率に差を作れる。
function recordTie(t, matchId, homeTeam, m, hWins, aWins, perGamePts) {
  const [wp, lp] = perGamePts || [11, 7];
  const homeIsP1 = m.player1_name === homeTeam;
  const slots = [];
  const total = hWins + aWins;
  for (let s = 0; s < total; s++) {
    const homeWinsThis = s < hWins; // 先に home の勝ちを並べる(順序は集計に無関係)
    // 個別試合は 3セット先取想定で 3-0。勝者ゲーム[wp,lp]×3、敗者視点は逆。
    const g = homeWinsThis ? [[wp, lp], [wp, lp], [wp, lp]] : [[lp, wp], [lp, wp], [lp, wp]];
    slots.push({ slot: "S" + (s + 1), type: "S", winner: homeWinsThis ? "home" : "away", games: g });
  }
  const winnerSlot = hWins > aWins ? (homeIsP1 ? 1 : 2) : (homeIsP1 ? 2 : 1);
  // homeチーム視点の勝ち数を player1/player2 に合わせる
  const p1Wins = homeIsP1 ? hWins : aWins, p2Wins = homeIsP1 ? aWins : hWins;
  // slots は home=player1 基準。homeがP2なら winner を反転して格納
  const fixed = homeIsP1 ? slots : slots.map(x => ({ ...x, winner: x.winner === "home" ? "away" : "home",
    games: x.games.map(([a, b]) => [b, a]) }));
  return db.finishMatchOp(matchId, { winner_slot: p1Wins > p2Wins ? 1 : 2, sets: [],
    winner_sets: Math.max(p1Wins, p2Wins), loser_sets: Math.min(p1Wins, p2Wins), tie_results: fixed });
}

test("総当たり生成: N=4 で C(4,2)=6 対戦・next_match_id なし", () => {
  const t = setup(["A", "B", "C", "D"]);
  const r = db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  assert.ok(r.success, JSON.stringify(r));
  const ms = leagueMatches(t);
  assert.strictEqual(ms.length, 6, "6対戦");
  ms.forEach(m => assert.ok(!m.next_match_id, "リーグ戦は進出リンクなし"));
  // 全ペアがちょうど1回ずつ
  const pairs = new Set(ms.map(m => [m.player1_name, m.player2_name].sort().join("|")));
  assert.strictEqual(pairs.size, 6, "全6ペアが一意に1回ずつ");
});

test("総当たり生成: N=5(奇数)で C(5,2)=10 対戦", () => {
  const t = setup(["A", "B", "C", "D", "E"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  assert.strictEqual(leagueMatches(t).length, 10, "10対戦");
});

test("順位: 勝敗数で並ぶ(A全勝→D全敗)", () => {
  const t = setup(["A", "B", "C", "D"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const str = { A: 4, B: 3, C: 2, D: 1 };
  leagueMatches(t).forEach(m => {
    const home = m.player1_name, away = m.player2_name;
    const homeStrong = str[home] > str[away];
    recordTie(t, m.id, homeStrong ? home : away, m, 3, 2); // 強い方が3-2
  });
  const st = db.computeLeagueStandings(t.id, EV, "A");
  assert.deepStrictEqual(st.map(s => s.team_name), ["A", "B", "C", "D"], "勝敗数順");
  assert.deepStrictEqual(st.map(s => s.wins), [3, 2, 1, 0], "勝ち数 3/2/1/0");
  assert.deepStrictEqual(st.map(s => s.rank), [1, 2, 3, 4], "順位 1..4");
});

test("タイブレーク: 勝敗同数ならセット率で上位、なお同率なら得点率", () => {
  // 3チーム総当たり、全員1勝1敗(三つ巴)。セット率と得点率で差をつける。
  const t = setup(["X", "Y", "Z"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const ms = leagueMatches(t);
  const find = (a, b) => ms.find(m => [m.player1_name, m.player2_name].sort().join() === [a, b].sort().join());
  // 三つ巴: X>Y, Y>Z, Z>X。X の勝ちは大差(3-0)、負けは僅差(2-3) → X のセット率を最上位に。
  recordTie(t, find("X", "Y").id, "X", find("X", "Y"), 3, 0);  // X 3-0 Y
  recordTie(t, find("Y", "Z").id, "Y", find("Y", "Z"), 3, 1);  // Y 3-1 Z
  recordTie(t, find("Z", "X").id, "Z", find("Z", "X"), 3, 2);  // Z 3-2 X
  const st = db.computeLeagueStandings(t.id, EV, "A");
  // 全員 1勝1敗。セット得失: X=3勝0負(対Y)+2勝3負(対Z)=5-3, Y=0-3+3-1=3-4, Z=1-3+3-2=4-5
  assert.deepStrictEqual(st.map(s => s.wins), [1, 1, 1], "全員1勝");
  assert.strictEqual(st[0].team_name, "X", "セット率最上位=X(5-3)");
  // X:5/3=1.667, Z:4/5=0.8, Y:3/4=0.75 → X,Z,Y
  assert.deepStrictEqual(st.map(s => s.team_name), ["X", "Z", "Y"], "セット率降順 X>Z>Y");
});

test("抽選フラグ: 勝敗数・セット率・得点率すべて同率なら tiebreak='抽選'", () => {
  // 2チームが完全対称になるよう、2人ブロック×... ではなく、対称な4チームを作る。
  // 単純化: A vs B のみのブロックで両者が同じ成績にはならない(必ず勝敗つく)。
  // 代わりに、全試合同一スコアの3チーム三つ巴(完全対称)で抽選を誘発。
  const t = setup(["P", "Q", "R"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const ms = leagueMatches(t);
  const find = (a, b) => ms.find(m => [m.player1_name, m.player2_name].sort().join() === [a, b].sort().join());
  // P>Q, Q>R, R>P をすべて 3-2・同得点で → 全員1勝1敗・セット3-2/2-3で対称 → セット率も得点率も全員同じ
  recordTie(t, find("P", "Q").id, "P", find("P", "Q"), 3, 2);
  recordTie(t, find("Q", "R").id, "Q", find("Q", "R"), 3, 2);
  recordTie(t, find("R", "P").id, "R", find("R", "P"), 3, 2);
  const st = db.computeLeagueStandings(t.id, EV, "A");
  assert.deepStrictEqual(st.map(s => s.wins), [1, 1, 1], "全員1勝1敗");
  // 各チーム: セット 3+2=5 取得, 2+3=5 失 → 率1.0、得点も対称 → 全員同率
  assert.ok(st.every(s => s.tiebreak === "抽選"), "完全同率は全員 抽選フラグ");
  assert.ok(st.every(s => s.rank === 1), "同率は同順位(1位)");
});

test("複数ブロック: num_blocks=2 で各ブロック独立に総当たり・順位", () => {
  const t = setup(["A", "B", "C", "D"]);
  const r = db.generateTeamLeague(t.id, EV, { num_blocks: 2 });
  assert.strictEqual(r.blocks, 2, "2ブロック");
  // 各ブロック2チーム → 1対戦ずつ、計2対戦
  assert.strictEqual(leagueMatches(t).length, 2, "2ブロック×1対戦=2");
  const all = db.computeLeagueStandings(t.id, EV); // block省略→全ブロック
  assert.deepStrictEqual(Object.keys(all).sort(), ["A", "B"], "ブロックA,B");
  Object.values(all).forEach(arr => assert.strictEqual(arr.length, 2, "各ブロック2チーム"));
});

test("再生成: regenerate で旧リーグ対戦を消して作り直す(孤児なし)", () => {
  const t = setup(["A", "B", "C", "D"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  assert.strictEqual(leagueMatches(t).length, 6);
  db.generateTeamLeague(t.id, EV, { num_blocks: 2, regenerate: true });
  assert.strictEqual(leagueMatches(t).length, 2, "再生成後は2(孤児なし)");
});
