// ⑤ トーナメント表に選手を「シード」として追加(addBracketSeed)の回帰テスト。
//  - 既存の1回戦の対戦(組み合わせ)は崩さず保持する。
//  - 追加で枠が広がる。追加選手は entrant に作られ、1回戦の枠(相手BYE)に入る=登場回戦から実戦。
// 実行: node --test test/bracket-add-seed.test.js
process.env.DB_PATH = "/tmp/ktta_addseed_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} });

const EV = "男子シングルス";
let _seq = 0;
function setup(n) {
  const t = db.createTournament({ name: "シード追加検証" + (++_seq), date: "2027-08-08" });
  for (let i = 1; i <= n; i++) db.createEntrant({ tournament_id: t.id, event: EV, seed: i, name: "選手" + String(i).padStart(2, "0"), status: "confirmed" });
  db.generateBracket(t.id, EV, { regenerate: true });
  return t;
}
const r1Of = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1);
const pairKey = (m) => [m.player1_name || "", m.player2_name || ""].sort().join("|");

test("addBracketSeed: 既存の対戦を保持したまま、上にシードを登場回戦2で追加し枠が広がる", () => {
  const t = setup(4);
  const origPairs = new Set(r1Of(t).filter(m => (m.player1_name && m.player2_name)).map(pairKey));
  const sizeBefore = r1Of(t).length * 2;
  assert.strictEqual(sizeBefore, 4, "4人=4枠");

  const r = db.addBracketSeed(t.id, EV, { name: "新シード田中", side: "top", entry_round: 2 });
  assert.ok(r && !r.error, "追加成功: " + JSON.stringify(r).slice(0, 180));

  assert.ok(db.getEntrants(t.id, EV).some(e => (e.display_name || e.name) === "新シード田中"), "新シードがentrantに追加");

  const newR1 = r1Of(t);
  const newSize = newR1.length * 2;
  assert.ok(newSize > sizeBefore, "枠が広がる: " + sizeBefore + "→" + newSize);

  const newPairs = new Set(newR1.map(pairKey));
  for (const p of origPairs) assert.ok(newPairs.has(p), "既存の対戦が保持されている: " + p + " / new=" + [...newPairs].join("  "));

  assert.ok(newR1.some(m => m.player1_name === "新シード田中" || m.player2_name === "新シード田中"), "新シードは1回戦の枠に居る");
});

test("addBracketSeed: 末尾(bottom)に追加でも既存の対戦は保持される", () => {
  const t = setup(8);
  const origPairs = new Set(r1Of(t).filter(m => (m.player1_name && m.player2_name)).map(pairKey));
  const r = db.addBracketSeed(t.id, EV, { name: "末尾シード", side: "bottom", entry_round: 1 });
  assert.ok(r && !r.error, "追加成功: " + JSON.stringify(r).slice(0, 160));
  const newPairs = new Set(r1Of(t).map(pairKey));
  for (const p of origPairs) assert.ok(newPairs.has(p), "既存の対戦が保持: " + p);
});

test("addBracketSeed: 表が無い種目はエラー(先に生成を促す)", () => {
  const t = db.createTournament({ name: "未生成", date: "2027-08-09" });
  db.createEntrant({ tournament_id: t.id, event: EV, seed: 1, name: "X", status: "confirmed" });
  const r = db.addBracketSeed(t.id, EV, { name: "Y", side: "top", entry_round: 1 });
  assert.ok(r && r.error && /トーナメント表がありません/.test(r.error), "未生成はエラー: " + JSON.stringify(r));
});
