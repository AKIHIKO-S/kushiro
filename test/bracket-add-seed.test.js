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

test("promoteToSeed: クリックした枠の選手をシードに繰り上げ(元位置から外し、登場回戦から合流・他は保持)", () => {
  const t = setup(8);
  const r1 = r1Of(t).sort((a, b) => a.bracket_pos - b.bracket_pos);
  const sizeBefore = r1.length * 2;
  const target = r1[0].player1_name;   // pos0 / slot1 の選手を繰り上げる
  const otherPairs = new Set(r1.filter((m, i) => i > 0 && m.player1_name && m.player2_name).map(pairKey));

  const res = db.promoteToSeed(t.id, EV, 0, 1, { entry_round: 2, side: "top" });
  assert.ok(res && !res.error, "繰り上げ成功: " + JSON.stringify(res).slice(0, 160));

  const newR1 = r1Of(t);
  assert.ok(newR1.length * 2 > sizeBefore, "枠が広がる: " + sizeBefore + "→" + newR1.length * 2);
  const newPairs = new Set(newR1.map(pairKey));
  for (const p of otherPairs) assert.ok(newPairs.has(p), "繰り上げ以外の対戦は保持: " + p);
  const tgtR1 = newR1.find(m => m.player1_name === target || m.player2_name === target);
  assert.ok(tgtR1, "繰り上げた選手は1回戦の枠に居る");
  const opp = tgtR1.player1_name === target ? tgtR1.player2_name : tgtR1.player1_name;
  assert.ok(!opp || opp === "" || opp === "BYE", "繰り上げた選手の1回戦相手はBYE(=シード上がり・進行開始で2回戦へ): opp=" + opp);
});

test("promoteToSeed: BYE枠を指定したらエラー", () => {
  const t = setup(4);
  // 末尾に空きを作る: 5人目をシードにして枠を広げ、BYE枠を発生させる
  db.addBracketSeed(t.id, EV, { name: "追加シード", side: "bottom", entry_round: 3 });
  const r1 = r1Of(t).sort((a, b) => a.bracket_pos - b.bracket_pos);
  const byeIdx = r1.findIndex(m => !m.player2_name || m.player2_name === "");
  if (byeIdx >= 0) {
    const res = db.promoteToSeed(t.id, EV, r1[byeIdx].bracket_pos, 2, { entry_round: 2 });
    assert.ok(res && res.error, "BYE枠の繰り上げはエラー: " + JSON.stringify(res));
  }
});
