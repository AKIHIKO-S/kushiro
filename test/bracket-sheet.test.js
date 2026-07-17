// 割当表正本(案B) P1 の回帰: シート⇔木の変換層。
//  - sheetHashOf の正準性(順序・欠落枠・余分キーに不変)
//  - synthesizeSheetFromMatches → materializeSheet の往復一致(標準/BYE/スーパーシード)
//  - canonicalStructHash の ID 非依存性(再導出で match ID が変わっても同一ハッシュ=移行突合の前提)
//  - materializeSheet の入力検証(重複・枠数・別種目)と破壊ガード
// 実行: node --test test/bracket-sheet.test.js
process.env.DB_PATH = "/tmp/ktta_sheet_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
let seq = 0;
function setup(n) {
  const t = db.createTournament({ name: "sheet検証" + (++seq), date: "2027-05-01" });
  for (let i = 1; i <= n; i++) {
    db.createEntrant({ tournament_id: t.id, event: EV,
      name: "席" + String(i).padStart(2, "0"), team: "ク" + (i % 5), furigana: "せき" + String(i).padStart(2, "0") });
  }
  const gen = db.generateBracket(t.id, EV, {});
  assert.ok(gen && !gen.error, "生成: " + JSON.stringify(gen).slice(0, 120));
  return t;
}

test("sheetHashOf: 順序・欠落枠・余分キーに依存しない正準ハッシュ", () => {
  const a = db.sheetHashOf(8, [
    { pos: 0, entrant_id: "e1", entry_round: 1 },
    { pos: 3, entrant_id: "e2", entry_round: 2 },
  ]);
  const b = db.sheetHashOf(8, [
    { pos: 3, entrant_id: "e2", entry_round: 2, extra: "無視される" },
    { pos: 1, entrant_id: null },                    // 空き枠の明示は省略と等価
    { pos: 0, entrant_id: "e1" },                    // entry_round省略=1
  ]);
  assert.strictEqual(a, b, "同じ配置なら同じハッシュ");
  const c = db.sheetHashOf(8, [{ pos: 0, entrant_id: "e1" }, { pos: 3, entrant_id: "e2", entry_round: 3 }]);
  assert.notStrictEqual(a, c, "登場回戦が違えば別ハッシュ");
});

test("往復一致(標準8人): 逆算シート→導出で構造ハッシュが不変・match IDは変わる=ID非依存の証明", () => {
  const t = setup(8);
  const h1 = db.canonicalStructHash(t.id, EV);
  const ids1 = db.getMatchesByTournament(t.id).map(m => m.id).sort().join(",");
  const sheet = db.synthesizeSheetFromMatches(t.id, EV);
  assert.ok(sheet && sheet.size === 8 && sheet.seats.filter(s => s.entrant_id).length === 8, "8人全員が逆算に載る");
  const r = db.materializeSheet(t.id, EV, sheet, {});
  assert.ok(r && !r.error, "導出成功: " + JSON.stringify(r).slice(0, 120));
  const h2 = db.canonicalStructHash(t.id, EV);
  const ids2 = db.getMatchesByTournament(t.id).map(m => m.id).sort().join(",");
  assert.strictEqual(h2, h1, "構造ハッシュは往復で不変(移行突合の合格条件)");
  assert.notStrictEqual(ids2, ids1, "match ID は再生成で変わっている(=bracketRevでは突合できない証明)");
});

test("往復一致(6人=BYEあり)", () => {
  const t = setup(6);
  const h1 = db.canonicalStructHash(t.id, EV);
  const sheet = db.synthesizeSheetFromMatches(t.id, EV);
  assert.strictEqual(sheet.seats.filter(s => s.entrant_id).length, 6, "実選手6・空き2");
  const r = db.materializeSheet(t.id, EV, sheet, {});
  assert.ok(r && !r.error, JSON.stringify(r).slice(0, 120));
  assert.strictEqual(db.canonicalStructHash(t.id, EV), h1, "BYEありでも往復一致");
});

test("往復一致(スーパーシード=登場回戦3)", () => {
  const t = setup(8);
  const r1m = db.getMatchesByTournament(t.id).filter(m => m.bracket_round === 1)
    .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
  const ssEnt = r1m[0].player1_entrant_id;
  const sr = db.setEntrantSeedRound(ssEnt, 3, { force: true });
  assert.ok(sr && !sr.error, "SS設定: " + JSON.stringify(sr).slice(0, 120));
  const h1 = db.canonicalStructHash(t.id, EV);
  const sheet = db.synthesizeSheetFromMatches(t.id, EV);
  const ssSeat = sheet.seats.find(s => s.entrant_id === ssEnt);
  assert.strictEqual(ssSeat.entry_round, 3, "逆算シートに登場回戦3が載る");
  const r = db.materializeSheet(t.id, EV, sheet, {});
  assert.ok(r && !r.error, JSON.stringify(r).slice(0, 120));
  assert.strictEqual(db.canonicalStructHash(t.id, EV), h1, "SSの大区画も往復一致");
});

test("materializeSheet の入力検証: 重複配置・枠数不正・2名未満を拒否", () => {
  const t = setup(4);
  const sheet = db.synthesizeSheetFromMatches(t.id, EV);
  const eid = sheet.seats.find(s => s.entrant_id).entrant_id;
  const dup = { size: 4, seats: [{ pos: 0, entrant_id: eid }, { pos: 2, entrant_id: eid }] };
  assert.ok(/2つの枠/.test((db.materializeSheet(t.id, EV, dup, {}) || {}).error || ""), "重複配置は拒否");
  assert.ok((db.materializeSheet(t.id, EV, { size: 6, seats: [] }, {}) || {}).error, "枠数6(非2の累乗)は拒否");
  assert.ok((db.materializeSheet(t.id, EV, { size: 4, seats: [{ pos: 0, entrant_id: eid }] }, {}) || {}).error, "1名だけは拒否");
});

test("materializeSheet: 結果入力済みは needs_force(既存破壊ガードが効く)", () => {
  const t = setup(4);
  const m = db.getMatchesByTournament(t.id).find(x => x.bracket_round === 1);
  const fr = db.finishMatchOp(m.id, { winner_slot: 1, sets: [] });
  assert.ok(!fr.error);
  const sheet = db.synthesizeSheetFromMatches(t.id, EV);
  const r = db.materializeSheet(t.id, EV, sheet, {});
  assert.ok(r && r.needs_force, "結果ありは needs_force: " + JSON.stringify(r).slice(0, 120));
  const rf = db.materializeSheet(t.id, EV, sheet, { force: true });
  assert.ok(rf && !rf.error, "force で導出できる");
});
