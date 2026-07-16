// リーグ順位表 Excel(buildStandingsXlsx)の回帰。
// 「画面(TT.leagueTableEl)と同一定義」の契約を固定する: 順位・並び・勝敗表記・
// 同率「＊(抽選)」注記が computeLeagueStandings の出力とExcel上で一致すること。
// バッファを xlsx(CE) で読み戻して値を検証する(罫線スタイル自体はCE読取対象外のため値のみ)。
// チーム名はすべて合成。
// 実行: node --test test/standings-xlsx.test.js
process.env.DB_PATH = "/tmp/ktta_standxlsx_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const XLSX = require("xlsx");
const db = require("../db");
const reports = require("../reports");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const EV = "男子団体";
let _seq = 0;
function setup(teamNames) {
  const t = db.createTournament({ name: "順位表xlsx" + (++_seq), date: "2027-09-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "team", fee: 0, tie_format: "S,S,D,S,S" }] });
  teamNames.forEach((nm, i) => db.createEntrant({ tournament_id: t.id, event: EV, name: nm, team: nm, seed: i + 1, status: "confirmed" }));
  return t;
}
const leagueMatches = (t) => db.getMatchesByTournament(t.id).filter(m => m.league_block);
function recordTie(t, matchId, homeTeam, m, hWins, aWins) {
  const homeIsP1 = m.player1_name === homeTeam;
  const slots = [];
  for (let s = 0; s < hWins + aWins; s++) {
    const homeWinsThis = s < hWins;
    const g = homeWinsThis ? [[11, 7], [11, 7], [11, 7]] : [[7, 11], [7, 11], [7, 11]];
    slots.push({ slot: "S" + (s + 1), type: "S", winner: homeWinsThis ? "home" : "away", games: g });
  }
  const p1Wins = homeIsP1 ? hWins : aWins, p2Wins = homeIsP1 ? aWins : hWins;
  const fixed = homeIsP1 ? slots : slots.map(x => ({ ...x, winner: x.winner === "home" ? "away" : "home",
    games: x.games.map(([a, b]) => [b, a]) }));
  return db.finishMatchOp(matchId, { winner_slot: p1Wins > p2Wins ? 1 : 2, sets: [],
    winner_sets: Math.max(p1Wins, p2Wins), loser_sets: Math.min(p1Wins, p2Wins), tie_results: fixed });
}
const findMatch = (t, a, b) => leagueMatches(t).find(m =>
  (m.player1_name === a && m.player2_name === b) || (m.player1_name === b && m.player2_name === a));

function buildBuf(t) {
  const standings = { [EV]: db.computeLeagueStandings(t.id, EV) };
  const matches = { [EV]: db.getLeagueMatchResults(t.id, EV) };
  return reports.buildStandingsXlsx(db.getTournament(t.id), standings, matches);
}
const sheetVals = (buf, name) => {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[name];
  assert.ok(ws, "シートあり: " + name + " (実際: " + wb.SheetNames.join(",") + ")");
  const vals = {};
  Object.keys(ws).filter(k => k[0] !== "!").forEach(k => { vals[k] = ws[k].v; });
  return vals;
};

test("順位・並び・勝敗表記が computeLeagueStandings と一致する(A全勝→D全敗)", () => {
  const t = setup(["Aクラブ", "Bクラブ", "Cクラブ", "Dクラブ"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  // A > B > C > D の力関係で全6試合消化
  recordTie(t, findMatch(t, "Aクラブ", "Bクラブ").id, "Aクラブ", findMatch(t, "Aクラブ", "Bクラブ"), 3, 1);
  recordTie(t, findMatch(t, "Aクラブ", "Cクラブ").id, "Aクラブ", findMatch(t, "Aクラブ", "Cクラブ"), 3, 0);
  recordTie(t, findMatch(t, "Aクラブ", "Dクラブ").id, "Aクラブ", findMatch(t, "Aクラブ", "Dクラブ"), 3, 0);
  recordTie(t, findMatch(t, "Bクラブ", "Cクラブ").id, "Bクラブ", findMatch(t, "Bクラブ", "Cクラブ"), 3, 1);
  recordTie(t, findMatch(t, "Bクラブ", "Dクラブ").id, "Bクラブ", findMatch(t, "Bクラブ", "Dクラブ"), 3, 0);
  recordTie(t, findMatch(t, "Cクラブ", "Dクラブ").id, "Cクラブ", findMatch(t, "Cクラブ", "Dクラブ"), 3, 2);
  const st = db.computeLeagueStandings(t.id, EV);
  const bk = Object.keys(st)[0];
  const rows = st[bk];
  assert.strictEqual(rows[0].team_name, "Aクラブ", "前提: Aが1位");

  const buf = buildBuf(t);
  const vals = sheetVals(buf, EV);
  const cells = Object.entries(vals);
  // ブロック見出しとヘッダ
  assert.ok(cells.some(([, v]) => String(v).includes(bk + "ブロック")), "ブロック見出し");
  assert.ok(cells.some(([, v]) => v === "勝-敗") && cells.some(([, v]) => v === "セット率"), "ヘッダ列");
  // 1位行: rank=1, チーム名, 勝-敗=3-0 が同じ行に並ぶ
  const teamCell = cells.find(([, v]) => String(v).startsWith("1. ")); // 表示は "行番号. チーム名"
  assert.ok(teamCell, "1行目のチーム表示がある");
  assert.strictEqual(String(teamCell[1]), "1. " + rows[0].team_name, "Excel1行目=standings1位");
  const rowN = teamCell[0].replace(/[A-Z]+/, "");
  assert.strictEqual(String(vals["A" + rowN]), "1", "順位列=1");
  // 勝敗マーク: ○/● がスコア付きで書かれている
  assert.ok(cells.some(([, v]) => /^○\d+-\d+$/.test(String(v))), "勝ちセル ○W-L");
  assert.ok(cells.some(([, v]) => /^●\d+-\d+$/.test(String(v))), "負けセル ●W-L");
  // 全順位が standings と同順で書かれている
  rows.forEach((r0, i) => {
    assert.ok(cells.some(([, v]) => String(v) === (i + 1) + ". " + r0.team_name),
      `${i + 1}位 ${r0.team_name} が行順どおり`);
  });
});

test("同率(完全同率2チーム)は順位セルに ＊ が付き、注記が入る", () => {
  const t = setup(["同率X", "同率Y", "その他Z"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  // X, Y がともに Z にだけ 3-0 で勝ち、X-Y は未消化 → X/Y が完全同率
  recordTie(t, findMatch(t, "同率X", "その他Z").id, "同率X", findMatch(t, "同率X", "その他Z"), 3, 0);
  recordTie(t, findMatch(t, "同率Y", "その他Z").id, "同率Y", findMatch(t, "同率Y", "その他Z"), 3, 0);
  const st = db.computeLeagueStandings(t.id, EV);
  const rows = st[Object.keys(st)[0]];
  const tied = rows.filter(r => r.tiebreak === "抽選");
  assert.strictEqual(tied.length, 2, "前提: 2チームが抽選同率");

  const vals = sheetVals(buildBuf(t), EV);
  const cells = Object.entries(vals);
  assert.ok(cells.filter(([, v]) => String(v) === "1*").length >= 2, "順位セルに 1* が2つ");
  assert.ok(cells.some(([, v]) => String(v).includes("順位は現地抽選")), "抽選注記");
});

test("リーグ種目なし → 案内シート(クラッシュしない)、listLeagueEvents は空", () => {
  const t = db.createTournament({ name: "リーグ無し", date: "2027-09-02" });
  assert.deepStrictEqual(db.listLeagueEvents(t.id), [], "リーグ種目なし");
  const buf = reports.buildStandingsXlsx(db.getTournament(t.id), {}, {});
  const wb = XLSX.read(buf, { type: "buffer" });
  assert.ok(wb.SheetNames.length >= 1, "案内シートが返る");
});

test("listLeagueEvents がリーグ種目のみ列挙する(ノックアウト種目は含まない)", () => {
  const t = setup(["A1", "B1", "C1"]);
  db.generateTeamLeague(t.id, EV, { num_blocks: 1 });
  // 同大会にノックアウトの個人戦も作る
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [
    { name: EV, type: "team", fee: 0, tie_format: "S,S,D,S,S" },
    { name: "男子シングルス", type: "singles", fee: 0 }] });
  for (let i = 1; i <= 4; i++) db.createEntrant({ tournament_id: t.id, event: "男子シングルス", name: "個人" + i, team: "T" + i });
  db.generateBracket(t.id, "男子シングルス", {});
  assert.deepStrictEqual(db.listLeagueEvents(t.id), [EV], "リーグ=団体のみ");
});
