// 団体リーグ(総当たり)の生成と順位算出の不変条件テスト。
// 順位(KTTAルール): 勝敗数 → セット得失差(Σ取得-Σ失) → 総得点(Σ取得点) → 同率は抽選フラグ。直接対決は不使用。
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

test("タイブレーク: 勝敗同数ならセット得失差で上位、なお同率なら総得点", () => {
  // 3チーム総当たり、全員1勝1敗(三つ巴)。セット得失差と総得点で差をつける。
  const t = setup(["X", "Y", "Z"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const ms = leagueMatches(t);
  const find = (a, b) => ms.find(m => [m.player1_name, m.player2_name].sort().join() === [a, b].sort().join());
  // 三つ巴: X>Y, Y>Z, Z>X。X の勝ちは大差(3-0)、負けは僅差(2-3) → X のセット得失差を最上位に。
  recordTie(t, find("X", "Y").id, "X", find("X", "Y"), 3, 0);  // X 3-0 Y
  recordTie(t, find("Y", "Z").id, "Y", find("Y", "Z"), 3, 1);  // Y 3-1 Z
  recordTie(t, find("Z", "X").id, "Z", find("Z", "X"), 3, 2);  // Z 3-2 X
  const st = db.computeLeagueStandings(t.id, EV, "A");
  // 全員 1勝1敗。セット得失差: X=(5-3)=+2, Y=(3-4)=-1, Z=(4-5)=-1
  assert.deepStrictEqual(st.map(s => s.wins), [1, 1, 1], "全員1勝");
  assert.strictEqual(st[0].team_name, "X", "セット得失差最上位=X(+2)");
  // X:+2 → 1位確定。Z(-1)と Y(-1)は同得失差なので総得点で比較: Z>Y → X,Z,Y
  assert.deepStrictEqual(st.map(s => s.team_name), ["X", "Z", "Y"], "セット得失差→総得点 降順 X>Z>Y");
});

test("抽選フラグ: 勝敗数・セット得失差・総得点がすべて同率なら tiebreak='抽選'", () => {
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
  // 各チーム: セット 3+2=5 取得, 2+3=5 失 → 得失差0、得点も完全対称 → 全員同率
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

// 個別スコアを player1 視点で明示記録するヘルパ(games から セット/得点を導出)
function recExplicit(matchId, p1slots) {
  const slots = p1slots.map((sp, i) => ({ slot: "M" + (i + 1), type: "S", winner: sp[0] ? "home" : "away", games: sp[1] }));
  const p1w = slots.filter(s => s.winner === "home").length, p2w = slots.length - p1w;
  return db.finishMatchOp(matchId, { winner_slot: p1w > p2w ? 1 : 2, sets: [], winner_sets: Math.max(p1w, p2w), loser_sets: Math.min(p1w, p2w), tie_results: slots });
}
// teamA 視点の結果を、その対戦の player1 視点に変換して記録
function recAB(m, teamA, aSlots) {
  const p1IsA = m.player1_name === teamA;
  return recExplicit(m.id, aSlots.map(([aWon, g]) => p1IsA ? [aWon, g] : [!aWon, g.map(x => [x[1], x[0]])]));
}

test("総得点タイブレーク: 勝敗・セット得失差が同じでも総得点で順位が決まる", () => {
  // 3チーム三つ巴。全員1勝1敗、各対戦2-1でセット得失差も全員0。総得点(pts_won)の大小で P>R>Q。
  // 得点率(pts_won/pts_lost)だと P>R>Q と同じ順になるが、
  // 同じ得点率でも率と総得点が乖離するケースは後続テストで確認。
  const t = setup(["P", "Q", "R"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const ms = leagueMatches(t);
  const find = (a, b) => ms.find(m => [m.player1_name, m.player2_name].sort().join() === [a, b].sort().join());
  recAB(find("P", "Q"), "P", [[true, [[11, 1]]], [true, [[11, 1]]], [false, [[9, 11]]]]); // P 大勝・僅敗
  recAB(find("Q", "R"), "Q", [[true, [[11, 5]]], [true, [[11, 5]]], [false, [[7, 11]]]]);
  recAB(find("R", "P"), "R", [[true, [[11, 9]]], [true, [[11, 9]]], [false, [[1, 11]]]]); // R 僅勝・大敗
  const st = db.computeLeagueStandings(t.id, EV, "A");
  assert.deepStrictEqual(st.map(s => s.wins), [1, 1, 1], "全員1勝");
  // セット得失差: 全員 3-3=0
  assert.ok(st.every(s => s.sets_won === 3 && s.sets_lost === 3), "セット得失差は全員 0(3-3)");
  // 総得点: P=60 > R=44 > Q=42(計算: P:31+29=60, R:21+23=44, Q:13+29=42)
  assert.deepStrictEqual(st.map(s => s.team_name), ["P", "R", "Q"], "総得点降順 P>R>Q");
  assert.ok(st[0].pts_won > st[1].pts_won && st[1].pts_won > st[2].pts_won, "pts_won が厳密に降順");
});

test("セット率と総得点で順位が逆転するケース: 率と差は乖離する(KTTAルールは差優先)", () => {
  // 3チーム三つ巴。全員1勝1敗・セット得失差0(3-3)だが総得点の差で順位が決まる。
  // 旧ルール(セット率)では P(1.31)>R(1.12)>Q(0.68) だが、
  // KTTAルール(総得点)では R(57)>P(51)>Q(39) に逆転する。
  const t = setup(["P", "Q", "R"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const ms = leagueMatches(t);
  const find = (a, b) => ms.find(m => [m.player1_name, m.player2_name].sort().join() === [a, b].sort().join());
  // P>Q 3-0(P:11/game, Q:2/game), Q>R 3-0(Q:11/game, R:8/game), R>P 3-0(R:11/game, P:6/game)
  recAB(find("P", "Q"), "P", [[true, [[11, 2]]], [true, [[11, 2]]], [true, [[11, 2]]]]);
  recAB(find("Q", "R"), "Q", [[true, [[11, 8]]], [true, [[11, 8]]], [true, [[11, 8]]]]);
  recAB(find("R", "P"), "R", [[true, [[11, 6]]], [true, [[11, 6]]], [true, [[11, 6]]]]);
  const st = db.computeLeagueStandings(t.id, EV, "A");
  assert.deepStrictEqual(st.map(s => s.wins), [1, 1, 1], "全員1勝1敗");
  // 得失差: 全員 3-3=0
  assert.ok(st.every(s => st[0].set_diff === 0), "セット得失差は全員0");
  // 総得点: R(33+24=57) > P(33+18=51) > Q(6+33=39)
  assert.deepStrictEqual(st.map(s => s.team_name), ["R", "P", "Q"], "総得点降順 R>P>Q");
  assert.ok(st[0].pts_won > st[1].pts_won && st[1].pts_won > st[2].pts_won, "pts_won 厳密降順");
  // 確認: 旧方式(セット率)ならP>R>Q になるが KTTAルールは総得点優先
  const rateP = st.find(s => s.team_name === "P").pts_rate;
  const rateR = st.find(s => s.team_name === "R").pts_rate;
  assert.ok(rateP > rateR, "得点率はP>Rだが KTTAルール(総得点)ではR>P に逆転");
});

test("訂正(correctResult): 勝者反転してもゲーム得点(games)が保持され順位に反映", () => {
  const t = setup(["A", "B"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const m = leagueMatches(t)[0];
  const aIsP1 = m.player1_name === "A";
  recExplicit(m.id, aIsP1 ? [[true, [[11, 2]]], [true, [[11, 3]]], [false, [[5, 11]]]]
    : [[false, [[2, 11]]], [false, [[3, 11]]], [true, [[11, 5]]]]); // A が 2-1 勝ち
  let st = db.computeLeagueStandings(t.id, EV, "A");
  assert.strictEqual(st.find(s => s.team_name === "A").wins, 1, "訂正前: A 1勝");
  // B が勝つよう全slot反転(games保持)
  const cur = db.getMatchesByTournament(t.id).find(x => x.id === m.id).tie_results;
  const flipped = cur.map(s => ({ ...s, winner: s.winner === "home" ? "away" : "home", games: s.games.map(g => [g[1], g[0]]) }));
  const bWins = flipped.filter(s => s.winner === "home").length, aw = flipped.length - bWins;
  const r = db.correctResult(m.id, { winner_slot: bWins > aw ? 1 : 2, sets: [], winner_sets: Math.max(bWins, aw), loser_sets: Math.min(bWins, aw), tie_results: flipped });
  assert.ok(!r.error, "訂正成功: " + JSON.stringify(r).slice(0, 80));
  const m2 = db.getMatchesByTournament(t.id).find(x => x.id === m.id);
  assert.ok(m2.tie_results[0].games, "訂正後も games が保持される");
  st = db.computeLeagueStandings(t.id, EV, "A");
  assert.strictEqual(st.find(s => s.team_name === "A").wins, 0, "訂正後: A 0勝");
  assert.strictEqual(st.find(s => s.team_name === "B").wins, 1, "訂正後: B 1勝");
});

test("個別試合の不戦勝(3-0): セット率に3-0で反映・得点率は実戦のみ・対戦の勝敗に算入", () => {
  const t = setup(["A", "B"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const m = leagueMatches(t)[0];
  const aIsP1 = m.player1_name === "A";
  const wh = aIsP1 ? "home" : "away", wa = aIsP1 ? "away" : "home";
  // A視点: M1=不戦勝3-0(A勝), M2=実戦3-0(A勝, 11-9/11-7/11-8), M3=実戦0-3(A負)
  const slots = [
    { slot: "M1", type: "S", winner: wh, walkover: true, home_sets: aIsP1 ? 3 : 0, away_sets: aIsP1 ? 0 : 3 },
    { slot: "M2", type: "S", winner: wh, games: aIsP1 ? [[11, 9], [11, 7], [11, 8]] : [[9, 11], [7, 11], [8, 11]] },
    { slot: "M3", type: "D", winner: wa, games: aIsP1 ? [[5, 11], [6, 11], [7, 11]] : [[11, 5], [11, 6], [11, 7]] },
  ];
  const p1w = slots.filter(s => s.winner === "home").length, p2w = slots.length - p1w;
  db.finishMatchOp(m.id, { winner_slot: p1w > p2w ? 1 : 2, sets: [], winner_sets: Math.max(p1w, p2w), loser_sets: Math.min(p1w, p2w), tie_results: slots });
  const A = db.computeLeagueStandings(t.id, EV, "A").find(s => s.team_name === "A");
  assert.strictEqual(A.wins, 1, "対戦は A の勝ち(2-1)");
  assert.strictEqual(A.sets_won, 6, "不戦勝3 + 実戦勝3 = 6セット取得");
  assert.strictEqual(A.sets_lost, 3, "実戦負け3セット失");
  assert.strictEqual(A.pts_won, 33 + 18, "得点は実戦のみ(不戦勝M1は0点)");
});

test("未消化(0-0)チームは実際に戦って負けたチームより下位・抽選フラグも付かない(率∞誤適用の修正)", () => {
  const t = setup(["A", "B", "C", "D"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const ms = leagueMatches(t);
  const find = (a, b) => ms.find(m => [m.player1_name, m.player2_name].sort().join() === [a, b].sort().join());
  recAB(find("A", "B"), "A", [[true, [[11, 2]]], [true, [[11, 3]]], [true, [[11, 4]]]]); // A 3-0 B(他は未消化)
  const st = db.computeLeagueStandings(t.id, EV, "A");
  const rk = (nm) => st.find(s => s.team_name === nm).rank;
  assert.strictEqual(rk("A"), 1, "A 全勝1位");
  assert.ok(rk("B") < rk("C") && rk("B") < rk("D"), `戦って負けたB(${rk("B")})は未消化C/D(${rk("C")}/${rk("D")})より上位`);
  assert.strictEqual(st.find(s => s.team_name === "C").tiebreak, "", "未消化Cに抽選フラグなし");
  assert.strictEqual(st.find(s => s.team_name === "C").played, 0, "Cは未消化");
});

test("引き分け(内訳 2-2): winner_name に関わらず両者 draws として集計", () => {
  const t = setup(["A", "B"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const m = leagueMatches(t)[0];
  const slots = [ // home=player1 視点で 2-2
    { slot: "M1", type: "S", winner: "home", games: [[11, 5], [11, 5], [11, 5]] },
    { slot: "M2", type: "S", winner: "home", games: [[11, 6], [11, 6], [11, 6]] },
    { slot: "M3", type: "D", winner: "away", games: [[5, 11], [5, 11], [5, 11]] },
    { slot: "M4", type: "S", winner: "away", games: [[6, 11], [6, 11], [6, 11]] },
  ];
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [], winner_sets: 2, loser_sets: 2, tie_results: slots }); // 勝者強制でも
  const st = db.computeLeagueStandings(t.id, EV, "A");
  const A = st.find(s => s.team_name === "A"), B = st.find(s => s.team_name === "B");
  assert.strictEqual(A.wins, 0, "引き分けは勝ちでない");
  assert.strictEqual(A.draws, 1, "A 引き分け1");
  assert.strictEqual(B.draws, 1, "B 引き分け1");
});

test("walkover(対戦まるごと不戦勝)はセット率/得点率の集計から除外される", () => {
  const t = setup(["A", "B", "C"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  const ms = leagueMatches(t);
  const find = (a, b) => ms.find(m => [m.player1_name, m.player2_name].sort().join() === [a, b].sort().join());
  // A vs B は通常勝ち、A vs C は walkover(A の不戦勝)
  recAB(find("A", "B"), "A", [[true, [[11, 5]]], [true, [[11, 5]]], [false, [[7, 11]]]]);
  const avc = find("A", "C"); const aIsP1 = avc.player1_name === "A";
  db.finishMatchOp(avc.id, { winner_slot: aIsP1 ? 1 : 2, sets: [], winner_sets: 0, loser_sets: 0, walkover: true });
  const st = db.computeLeagueStandings(t.id, EV, "A");
  const A = st.find(s => s.team_name === "A");
  // walkover は集計対象外。A vs B のみ算入(2勝1敗のslot → 2セット取得・1失、得点 11+11+7=29)。
  assert.strictEqual(A.played, 1, "集計対象は walkover を除く1対戦のみ");
  assert.strictEqual(A.sets_won, 2, "A vs B の取得セットのみ(2)");
  assert.strictEqual(A.sets_lost, 1, "A vs B の失セットのみ(1)");
  assert.strictEqual(A.pts_won, 29, "A vs B の得点のみ(11+11+7=29)");
  assert.strictEqual(A.wins, 1, "walkover も勝敗には数えない方針なら... A vs B の1勝");
});

test("釧路リーグ: 前回順位から昇降格を提案(1-2位昇格/3位残留/4位降格/新規new/最上位最下位クランプ)", () => {
  // 前回大会: 2部制。1部=[A,B,C,D], 2部=[E,F,G,H]。各部で総当たり→強い順に順位確定。
  const prev = db.createTournament({ name: "前回", date: "2027-01-01" });
  db.updateEntrySettings(prev.id, { entries_open: 1, event_config: [{ name: EV, type: "team", fee: 0, tie_format: "S,S,D" }] });
  const d1 = ["A", "B", "C", "D"], d2 = ["E", "F", "G", "H"];
  [...d1, ...d2].forEach((nm, i) => db.createEntrant({ tournament_id: prev.id, event: EV, name: nm, team: nm, seed: i + 1, status: "confirmed" }));
  const pe = db.getEntrants(prev.id, EV), pid = (nm) => pe.find(e => e.team === nm).id;
  const assignments = {}; d1.forEach(nm => assignments[pid(nm)] = "1"); d2.forEach(nm => assignments[pid(nm)] = "2");
  db.generateTeamLeague(prev.id, EV, { assignments });
  const str = { A: 4, B: 3, C: 2, D: 1, E: 4, F: 3, G: 2, H: 1 };
  db.getMatchesByTournament(prev.id).filter(m => m.league_block).forEach(m => {
    const strong = str[m.player1_name] > str[m.player2_name] ? m.player1_name : m.player2_name;
    recAB(m, strong, [[true, [[11, 2]]], [true, [[11, 3]]], [true, [[11, 4]]]]); // 強い方が3-0
  });
  assert.deepStrictEqual(db.computeLeagueStandings(prev.id, EV, "1").map(s => s.team_name), ["A", "B", "C", "D"], "1部 A>B>C>D");
  assert.deepStrictEqual(db.computeLeagueStandings(prev.id, EV, "2").map(s => s.team_name), ["E", "F", "G", "H"], "2部 E>F>G>H");

  // 今回大会: 同チーム + 新規 I
  const cur = db.createTournament({ name: "今回", date: "2027-02-01" });
  db.updateEntrySettings(cur.id, { entries_open: 1, event_config: [{ name: EV, type: "team", fee: 0, tie_format: "S,S,D" }] });
  [...d1, ...d2, "I"].forEach((nm, i) => db.createEntrant({ tournament_id: cur.id, event: EV, name: nm, team: nm, seed: i + 1, status: "confirmed" }));
  const sug = db.computePromotionSuggestion(prev.id, EV, db.getEntrants(cur.id, EV));
  const bt = {}; sug.suggestions.forEach(s => bt[s.team_name] = s);
  assert.strictEqual(sug.max_division, 2, "前回は2部制");
  assert.strictEqual(bt["A"].suggested_division, "1", "1部1位→残留(最上位クランプ)");
  assert.strictEqual(bt["B"].suggested_division, "1", "1部2位→残留(最上位)");
  assert.strictEqual(bt["C"].suggested_division, "1", "1部3位→残留");
  assert.strictEqual(bt["D"].suggested_division, "2", "1部4位→降格");
  assert.strictEqual(bt["E"].suggested_division, "1", "2部1位→昇格");
  assert.strictEqual(bt["F"].suggested_division, "1", "2部2位→昇格");
  assert.strictEqual(bt["G"].suggested_division, "2", "2部3位→残留");
  assert.strictEqual(bt["H"].suggested_division, "2", "2部4位→降格(最下位クランプで残留)");
  assert.strictEqual(bt["I"].status, "new", "新規はnew");
  assert.strictEqual(bt["I"].suggested_division, null, "新規は提案なし");
  assert.strictEqual(sug.new_count, 1, "新規1");
  assert.strictEqual(sug.returning_count, 8, "復帰8");
});

test("リーグのブロック分けで同一基部(所属)が別ブロックに散る", () => {
  // 4基部×A/B = 8チーム。num_blocks=2 で同基部(例 北陽A/北陽B)は別ブロックへ(所属分散)。
  const names = ["北陽Ａ", "北陽 B", "森A", "森B", "星A", "星B", "空A", "空B"]; // 表記ゆれ込み
  const t = setup(names);
  const r = db.generateTeamLeague(t.id, EV, { num_blocks: 2, regenerate: true, force: true });
  assert.ok(!r.error, "生成成功: " + JSON.stringify(r.error || ""));
  const blockOf = {}; db.getEntrants(t.id, EV).forEach(e => { blockOf[e.team] = e.block; });
  let same = 0;
  [["北陽Ａ", "北陽 B"], ["森A", "森B"], ["星A", "星B"], ["空A", "空B"]].forEach(([a, b]) => {
    if (blockOf[a] && blockOf[b] && blockOf[a] === blockOf[b]) same++;
  });
  assert.strictEqual(same, 0, "同一基部が同ブロックに固まっていない(所属分散が効く)");
});

test("予選リーグ→決勝T(上位1名進出): 各ブロック1位が決勝Tへ", () => {
  const names = ["甲", "乙", "丙", "丁", "戊", "己"];
  const t = setup(names);
  const idOf = (nm) => entId(t, nm);
  const assignments = {};
  ["甲", "乙", "丙"].forEach(n => assignments[idOf(n)] = "A");
  ["丁", "戊", "己"].forEach(n => assignments[idOf(n)] = "B");
  db.generateTeamLeague(t.id, EV, { assignments, regenerate: true, force: true });
  // 強さ: 甲>乙>丙, 丁>戊>己 (上位が必ず勝つ→ブロック1位=甲/丁)
  const strong = { "甲": 2, "乙": 1, "丙": 0, "丁": 2, "戊": 1, "己": 0 };
  leagueMatches(t).forEach(m => {
    const win = strong[m.player1_name] > strong[m.player2_name] ? m.player1_name : m.player2_name;
    recordTie(t, m.id, win, db.getMatchesByTournament(t.id).find(x => x.id === m.id), 3, 0);
  });
  const r = db.generateLeaguePlayoff(t.id, EV, { mode: "top", advance_n: 1, force: true });
  assert.ok(!r.error, "生成成功: " + JSON.stringify(r.error || ""));
  assert.strictEqual(r.created.length, 1, "決勝T1つ");
  const poEnts = db.getEntrants(t.id, EV + " 決勝T");
  assert.strictEqual(poEnts.length, 2, "通過者2名(各ブロック1位)");
  assert.deepStrictEqual(poEnts.map(e => e.team).sort(), ["丁", "甲"], "甲と丁が通過");
  // ブラケットが生成されている
  const poMatches = db.getMatchesByTournament(t.id).filter(m => m.event === EV + " 決勝T");
  assert.ok(poMatches.length >= 1, "決勝Tのブラケット生成");
});

test("予選リーグ→順位別トーナメント(1位T/2位T)", () => {
  const names = ["甲", "乙", "丙", "丁", "戊", "己"];
  const t = setup(names);
  const idOf = (nm) => entId(t, nm);
  const assignments = {};
  ["甲", "乙", "丙"].forEach(n => assignments[idOf(n)] = "A");
  ["丁", "戊", "己"].forEach(n => assignments[idOf(n)] = "B");
  db.generateTeamLeague(t.id, EV, { assignments, regenerate: true, force: true });
  const strong = { "甲": 2, "乙": 1, "丙": 0, "丁": 2, "戊": 1, "己": 0 };
  leagueMatches(t).forEach(m => {
    const win = strong[m.player1_name] > strong[m.player2_name] ? m.player1_name : m.player2_name;
    recordTie(t, m.id, win, db.getMatchesByTournament(t.id).find(x => x.id === m.id), 3, 0);
  });
  const r = db.generateLeaguePlayoff(t.id, EV, { mode: "byrank", advance_n: 2, force: true });
  assert.ok(!r.error, "生成成功: " + JSON.stringify(r.error || ""));
  assert.strictEqual(r.created.length, 2, "1位T・2位Tの2つ");
  assert.deepStrictEqual(db.getEntrants(t.id, EV + " 1位T").map(e => e.team).sort(), ["丁", "甲"], "1位T=甲丁");
  assert.deepStrictEqual(db.getEntrants(t.id, EV + " 2位T").map(e => e.team).sort(), ["乙", "戊"], "2位T=乙戊");
});
