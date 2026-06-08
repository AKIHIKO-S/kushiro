// トーナメント管理の自由入替＋選手DB選択の回帰。
//  - swapBracketMatches: 試合まるごと入替
//  - setBracketSlotFromPlayer: 選手マスタDBから枠へ(entrant自動解決)
//  - set-slot/swap の op_log undo
// 実行: node --test test/bracket-flex-edit.test.js
process.env.DB_PATH = "/tmp/ktta_flexedit_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const EV = "男子シングルス";
let _seq = 0;
function setup4() {
  const t = db.createTournament({ name: "flex" + (++_seq), date: "2027-12-20" });
  ["甲", "乙", "丙", "丁"].forEach((n, i) => db.createEntrant({ tournament_id: t.id, event: EV, surname: n, given_name: "一", team: "T" + i, status: "confirmed" }));
  db.generateBracket(t.id, EV, { regenerate: true });
  return t;
}
const r1 = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1).sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));

test("swapBracketMatches: 2試合の両選手を入替(配置以外は不変)", () => {
  const t = setup4();
  const before = r1(t);
  const m0 = before[0], m1 = before[1];
  const r = db.swapBracketMatches(t.id, EV, m0.bracket_pos, m1.bracket_pos);
  assert.ok(r && r.success, "入替成功: " + JSON.stringify(r));
  const after = r1(t);
  assert.strictEqual(after[0].player1_name, m1.player1_name, "pos0のp1がm1のp1に");
  assert.strictEqual(after[0].player2_name, m1.player2_name, "pos0のp2がm1のp2に");
  assert.strictEqual(after[1].player1_name, m0.player1_name, "pos1のp1がm0のp1に");
});

test("setBracketSlotFromPlayer: 未エントリーのマスタ選手を空き枠へ→entrant自動作成+紐付け", () => {
  const t = setup4();
  const p = db.createPlayer({ name: "新規 太郎", furigana: "しんき", team: "新規ク", gender: "male" });
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  const before = db.getEntrants(t.id, EV).length;
  const r = db.setBracketSlotFromPlayer(t.id, EV, 0, 2, p.id);
  assert.ok(r && r.success, "成功: " + JSON.stringify(r));
  const ents = db.getEntrants(t.id, EV);
  assert.strictEqual(ents.length, before + 1, "entrantが1件自動追加");
  const added = ents.find(e => e.player_id === p.id);
  assert.ok(added, "player_idで紐づくentrantがある");
  const m = r1(t)[0];
  assert.strictEqual(m.player2_name, added.display_name, "枠に選手名が入る: " + m.player2_name);
  assert.strictEqual(m.player2_entrant_id, added.id, "枠にentrant_idが入る");
});

test("setBracketSlotFromPlayer: 既存entrantがあるマスタ選手は再利用(増えない)・冪等", () => {
  const t = setup4();
  const p = db.createPlayer({ name: "既出 花子", furigana: "きしゅつ", team: "既出ク", gender: "female" });
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  db.setBracketSlotFromPlayer(t.id, EV, 0, 2, p.id);     // 1回目: 作成
  const n1 = db.getEntrants(t.id, EV).length;
  db.setBracketSlot(t.id, EV, 1, 2, { mode: "clear" });
  db.setBracketSlotFromPlayer(t.id, EV, 1, 2, p.id);     // 2回目: 同じ選手→再利用
  const n2 = db.getEntrants(t.id, EV).length;
  assert.strictEqual(n2, n1, "2回目は entrant を増やさない(player_idで再利用)");
});

test("undo: setBracketSlot(clear) を undoLastOp で元に戻せる", () => {
  const t = setup4();
  const before = r1(t)[0].player2_name;
  assert.ok(before, "pos0 slot2 に選手がいる");
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  assert.strictEqual(r1(t)[0].player2_name, "", "clearで空に");
  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo成功: " + JSON.stringify(u));
  assert.strictEqual(r1(t)[0].player2_name, before, "undoで選手が戻る: " + r1(t)[0].player2_name);
});

test("undo: swapBracketMatches を undoLastOp で元に戻せる", () => {
  const t = setup4();
  const before = r1(t).map(m => m.player1_name);
  db.swapBracketMatches(t.id, EV, 0, 1);
  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo成功");
  assert.deepStrictEqual(r1(t).map(m => m.player1_name), before, "undoで配置が戻る");
});

test("undo: swapBracketSlots(選手単位) を undoLastOp で元に戻せる", () => {
  const t = setup4();
  const before = r1(t).map(m => [m.player1_name, m.player2_name]);
  db.swapBracketSlots(t.id, EV, { pos: 0, slot: 1 }, { pos: 1, slot: 1 });
  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo成功");
  assert.deepStrictEqual(r1(t).map(m => [m.player1_name, m.player2_name]), before, "undoで配置が戻る");
});
