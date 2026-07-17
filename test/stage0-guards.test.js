// 第0段(共通土台)の回帰: 「選手がどこかに行った」系の構造事故を止める修正を固定する。
//  1. placeEntrantInSlot の原子性(移動先拒否で選手が消えない)+交換モード
//  2. setBracketSlotFromPlayer の重複配置遮断
//  3. setEntrantSeedRound の entry_round 先行書込(キャンセル時限爆弾)修正
//  4. deleteEventMatches / undoDraw の結果入力済みガード
// 実行: node --test test/stage0-guards.test.js
process.env.DB_PATH = "/tmp/ktta_stage0_" + process.pid + ".db";

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
  const t = db.createTournament({ name: "第0段検証" + (++seq), date: "2027-03-01" });
  const eids = [];
  for (let i = 1; i <= n; i++) {
    const e = db.createEntrant({ tournament_id: t.id, event: EV,
      name: "選手" + String(i).padStart(2, "0"), team: "ク" + (i % 5), furigana: "せ" + String(i).padStart(2, "0") });
    eids.push(e.id);
  }
  const gen = db.generateBracket(t.id, EV, {});
  assert.ok(gen && !gen.error, "生成: " + JSON.stringify(gen).slice(0, 120));
  return { t, eids };
}
const r1 = (tid) => db.getMatchesByTournament(tid).filter(m => m.event === EV && m.bracket_round === 1)
  .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
const byRP = (tid, round, pos) => db.getMatchesByTournament(tid)
  .filter(m => m.event === EV && m.bracket_round === round && (m.bracket_pos || 0) === pos)[0];
// entrant が1回戦のどの枠にいるか(いなければ null)
function findPos(tid, entrantId) {
  for (const m of r1(tid)) {
    if (m.player1_entrant_id === entrantId) return { pos: m.bracket_pos || 0, slot: 1 };
    if (m.player2_entrant_id === entrantId) return { pos: m.bracket_pos || 0, slot: 2 };
  }
  return null;
}

test("placeEntrantInSlot 原子性: 移動先が編集不可(次戦確定済み)なら元の枠に残る(選手が消えない)", () => {
  const { t } = setup(8);
  // R1試合0・1を確定→R2試合0を確定 → R1試合0の枠は「次戦確定済み」で setBracketSlot が拒否する状態
  for (const p of [0, 1]) {
    const m = byRP(t.id, 1, p);
    const r = db.finishMatchOp(m.id, { winner_slot: 1, sets: [] });
    assert.ok(!r.error, JSON.stringify(r));
  }
  const r2m = byRP(t.id, 2, 0);
  const fr = db.finishMatchOp(r2m.id, { winner_slot: 1, sets: [] });
  assert.ok(!fr.error, JSON.stringify(fr));
  // R1試合2の選手を、編集不可の R1試合0 slot1 へ移動しようとする
  const src = byRP(t.id, 1, 2);
  const entId = src.player1_entrant_id;
  const before = findPos(t.id, entId);
  assert.ok(before && before.pos === 2, "移動前は枠2にいる");
  const r = db.placeEntrantInSlot(t.id, EV, 0, 1, entId);
  assert.ok(r && r.error, "移動先拒否でエラーが返る: " + JSON.stringify(r));
  const after_ = findPos(t.id, entId);
  assert.deepStrictEqual(after_, before, "拒否されたら選手は元の枠に残る(どこにも行かない)");
});

test("placeEntrantInSlot 交換モード: 双方配置済みなら2枠が入れ替わり、誰も未配置にならない", () => {
  const { t } = setup(8);
  const a = byRP(t.id, 1, 0), b = byRP(t.id, 1, 3);
  const entA = a.player1_entrant_id, entB = b.player2_entrant_id;
  const posA = findPos(t.id, entA), posB = findPos(t.id, entB);
  const r = db.placeEntrantInSlot(t.id, EV, posB.pos, posB.slot, entA, { mode: "exchange" });
  assert.ok(r && !r.error, "交換成功: " + JSON.stringify(r));
  assert.strictEqual(r.applied, "exchange", "適用された操作が exchange と報告される");
  assert.deepStrictEqual(findPos(t.id, entA), posB, "AはBの枠へ");
  assert.deepStrictEqual(findPos(t.id, entB), posA, "BはAの枠へ(未配置にならない)");
});

test("placeEntrantInSlot 移動モード(既定): 空き枠へは従来どおり移動し applied=move", () => {
  const { t } = setup(6);   // 8枠中2枠BYE=空きがある
  const src = r1(t.id).find(m => m.player1_entrant_id);
  const entId = src.player1_entrant_id;
  // BYE枠(空き)を探す
  let empty = null;
  for (const m of r1(t.id)) {
    if (!m.player1_entrant_id && (m.player1_name === "BYE" || !m.player1_name)) { empty = { pos: m.bracket_pos || 0, slot: 1 }; break; }
    if (!m.player2_entrant_id && (m.player2_name === "BYE" || !m.player2_name)) { empty = { pos: m.bracket_pos || 0, slot: 2 }; break; }
  }
  assert.ok(empty, "空き(BYE)枠がある");
  const r = db.placeEntrantInSlot(t.id, EV, empty.pos, empty.slot, entId);
  assert.ok(r && !r.error, "移動成功: " + JSON.stringify(r));
  assert.strictEqual(r.applied, "move");
  assert.deepStrictEqual(findPos(t.id, entId), empty, "空き枠へ移動");
});

test("setBracketSlotFromPlayer: 配置済み選手を別枠に入れると旧枠が空く(重複配置が作れない)", () => {
  const { t } = setup(8);
  const src = byRP(t.id, 1, 0);
  const entId = src.player1_entrant_id;
  // entrant に player を連携させる(選手DBから選択の前提)
  const pl = db.createPlayer({ name: "重複検証太郎", furigana: "じゅうふく", team: "ク1", gender: "male" });
  db.updateEntrant(entId, { player_id: pl.id });
  // 同じ選手を枠3 slot2 へ「選手DBから選択」で配置
  const r = db.setBracketSlotFromPlayer(t.id, EV, 3, 2, pl.id);
  assert.ok(r && !r.error, "配置成功: " + JSON.stringify(r));
  // 1回戦全枠を走査して、この entrant が「1箇所にだけ」いることを確認
  let count = 0;
  for (const m of r1(t.id)) {
    if (m.player1_entrant_id === entId) count++;
    if (m.player2_entrant_id === entId) count++;
  }
  assert.strictEqual(count, 1, "同一選手の枠は常に1つ(旧枠は自動で空く)");
});

test("setEntrantSeedRound: needs_force で止まったら entry_round は書き込まれない(時限爆弾の解除)", () => {
  const { t } = setup(8);
  // 結果を1件入れて破壊ガードが立つ状態にする
  const m0 = byRP(t.id, 1, 0);
  const fr = db.finishMatchOp(m0.id, { winner_slot: 1, sets: [] });
  assert.ok(!fr.error);
  const target = byRP(t.id, 1, 2).player1_entrant_id;
  const before = db.getEntrant ? db.getEntrant(target) : null;
  const r = db.setEntrantSeedRound(target, 3, {});
  assert.ok(r && r.needs_force, "結果入力済みなので needs_force: " + JSON.stringify(r));
  const after_ = db.getEntrant(target);
  assert.strictEqual(parseInt(after_.entry_round) || 1, parseInt((before && before.entry_round)) || 1,
    "キャンセル相当(force無し)では entry_round が変わらない");
});

test("deleteEventMatches: 結果入力済みは needs_force、force で削除できる", () => {
  const { t } = setup(8);
  const m0 = byRP(t.id, 1, 0);
  db.finishMatchOp(m0.id, { winner_slot: 1, sets: [] });
  const r = db.deleteEventMatches(t.id, EV);
  assert.ok(r && r.needs_force, "ガードが立つ: " + JSON.stringify(r));
  assert.ok(r1(t.id).length > 0, "拒否時は表が残っている");
  const rf = db.deleteEventMatches(t.id, EV, { force: true });
  assert.ok(rf && rf.ok, "force で削除: " + JSON.stringify(rf));
  assert.strictEqual(r1(t.id).length, 0, "削除された");
});

test("undoDraw: 結果入力済みは needs_force、force で取り消せる", () => {
  const t = db.createTournament({ name: "抽選ガード検証", date: "2027-03-02" });
  for (let i = 1; i <= 8; i++) db.createEntrant({ tournament_id: t.id, event: EV,
    name: "抽" + i, team: "ク" + (i % 3), furigana: "ちゆ" + String(i).padStart(2, "0") });
  const dr = db.drawSingleBracket(t.id, EV, { drawn_by: "テスト" });
  assert.ok(dr && !dr.error, "抽選確定: " + JSON.stringify(dr).slice(0, 120));
  const m0 = r1(t.id)[0];
  const fr = db.finishMatchOp(m0.id, { winner_slot: 1, sets: [] });
  assert.ok(!fr.error);
  const r = db.undoDraw(t.id, EV);
  assert.ok(r && r.needs_force, "結果入力済みなので needs_force: " + JSON.stringify(r));
  const rf = db.undoDraw(t.id, EV, { force: true });
  assert.ok(rf && rf.ok, "force で取り消し: " + JSON.stringify(rf));
});
