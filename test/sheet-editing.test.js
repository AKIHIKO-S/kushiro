// 割当表正本(案B) P3-1 の回帰: 下書き・編集ops・undo・確定のDAL。
//  - place/swap/clear/set_entry_round/set_size の意味論(重複配置が構造的に不可能)
//  - 全席スナップショットundo(1操作=1枚戻る)
//  - 楽観ロック(base_hash不一致=conflict)
//  - 確定=第N版採番+導出+tree_hash。ongoing中は初回確定のみ可(決勝T新種目対応)
// 実行: node --test test/sheet-editing.test.js
process.env.DB_PATH = "/tmp/ktta_sheeted_" + process.pid + ".db";

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
function setup(n, withBracket) {
  const t = db.createTournament({ name: "編集検証" + (++seq), date: "2027-07-01" });
  const eids = [];
  for (let i = 1; i <= n; i++) {
    const e = db.createEntrant({ tournament_id: t.id, event: EV,
      name: "編" + String(i).padStart(2, "0"), team: "ク" + (i % 3), furigana: "へ" + String(i).padStart(2, "0") });
    eids.push(e.id);
  }
  if (withBracket) {
    const gen = db.generateBracket(t.id, EV, {});
    assert.ok(gen && !gen.error);
  }
  return { t, eids };
}

test("下書き初期化: 表が無ければ名簿から紙順で作られ、未配置ゼロ", () => {
  const { t } = setup(6, false);
  const d = db.ensureDraftSheet(t.id, EV);
  assert.ok(!d.error, JSON.stringify(d).slice(0, 100));
  assert.strictEqual(d.size, 8, "6名→最小の2累乗8枠");
  assert.strictEqual(d.seats.filter(s => s.entrant_id).length, 6);
  const st = db.getSheetState(t.id, EV);
  assert.strictEqual(st.unplaced.length, 0, "全員配置済み");
  assert.ok(st.draft && !st.confirmed, "下書きのみ");
});

test("編集ops: swap/clear/place の意味論と、外した選手が未配置に現れること", () => {
  const { t } = setup(4, false);
  const d = db.ensureDraftSheet(t.id, EV);
  const init = d.seats.map(s => s.entrant_id);   // 初期配置(紙順ソート)を正として期待値を導く
  // 枠1と枠3を入替
  let r = db.applySheetOps(t.id, EV, d.sheet_hash, [{ op: "swap", a: 0, b: 2 }]);
  assert.ok(r.ok, JSON.stringify(r).slice(0, 120));
  assert.strictEqual(r.sheet.seats[0].entrant_id, init[2]);
  assert.strictEqual(r.sheet.seats[2].entrant_id, init[0]);
  // 枠2を空きに → その選手は未配置リストへ
  const outEnt = init[1];
  r = db.applySheetOps(t.id, EV, r.sheet.sheet_hash, [{ op: "clear", pos: 1 }]);
  assert.ok(r.ok);
  const st = db.getSheetState(t.id, EV);
  assert.strictEqual(st.unplaced.length, 1, "外した選手が未配置に見える(消える先が無い)");
  assert.strictEqual(st.unplaced[0].id, outEnt);
  // 未配置の選手を枠4に置き、続けて枠2へ移動→枠4は自動で空く(旧枠クリア)
  r = db.applySheetOps(t.id, EV, st.draft.sheet_hash, [
    { op: "place", pos: 3, entrant_id: outEnt },
    { op: "place", pos: 1, entrant_id: outEnt },
  ]);
  assert.ok(r.ok);
  const ids = r.sheet.seats.map(s => s.entrant_id);
  assert.strictEqual(ids.filter(x => x === outEnt).length, 1, "重複配置は構造的に不可能");
  assert.strictEqual(r.sheet.seats[1].entrant_id, outEnt);
});

test("楽観ロック: 古い base_hash での編集は conflict", () => {
  const { t } = setup(4, false);
  const d = db.ensureDraftSheet(t.id, EV);
  const r1 = db.applySheetOps(t.id, EV, d.sheet_hash, [{ op: "swap", a: 0, b: 1 }]);
  assert.ok(r1.ok);
  const r2 = db.applySheetOps(t.id, EV, d.sheet_hash, [{ op: "swap", a: 2, b: 3 }]);   // 古いhash
  assert.ok(r2.conflict, "他端末の先行編集を検知: " + JSON.stringify(r2).slice(0, 100));
});

test("undo: 1操作=全席スナップショット1枚が戻る", () => {
  const { t, eids } = setup(4, false);
  const d = db.ensureDraftSheet(t.id, EV);
  const before = JSON.stringify(d.seats);
  const r = db.applySheetOps(t.id, EV, d.sheet_hash, [{ op: "swap", a: 0, b: 3 }]);
  assert.ok(r.ok);
  const u = db.undoSheetOp(t.id, EV);
  assert.ok(u.ok, JSON.stringify(u));
  const st = db.getSheetState(t.id, EV);
  assert.strictEqual(JSON.stringify(st.draft.seats), before, "編集前の全席に戻る");
  assert.ok(db.undoSheetOp(t.id, EV).error, "履歴が尽きたらエラー");
});

test("確定: 第1版採番+木の導出+tree_hash記録。再確定で第2版・旧版はsuperseded", () => {
  const { t } = setup(8, false);
  db.ensureDraftSheet(t.id, EV);
  const c1 = db.confirmSheet(t.id, EV, { by: "検証者" });
  assert.ok(c1.ok, JSON.stringify(c1).slice(0, 150));
  assert.strictEqual(c1.rev_no, 1);
  let st = db.getSheetState(t.id, EV);
  assert.ok(st.confirmed && st.confirmed.rev_no === 1 && !st.draft, "確定版のみ");
  assert.strictEqual(st.confirmed.tree_hash, db.canonicalStructHash(t.id, EV), "導出後の構造と封印が一致");
  // もう一度下書き→入替→確定で第2版
  const d2 = db.ensureDraftSheet(t.id, EV);
  const r = db.applySheetOps(t.id, EV, d2.sheet_hash, [{ op: "swap", a: 0, b: 7 }]);
  assert.ok(r.ok);
  const c2 = db.confirmSheet(t.id, EV, { by: "検証者", force: true });
  assert.ok(c2.ok, JSON.stringify(c2).slice(0, 150));
  assert.strictEqual(c2.rev_no, 2);
  st = db.getSheetState(t.id, EV);
  assert.strictEqual(st.confirmed.rev_no, 2);
});

test("ongoing中: 確定済み種目の再確定は拒否・確定版の無い新種目(決勝T相当)の初回確定は通る", () => {
  const { t } = setup(8, false);
  db.ensureDraftSheet(t.id, EV);
  assert.ok(db.confirmSheet(t.id, EV, {}).ok, "事前確定");
  db.updateTournament(t.id, { status: "ongoing" });
  const d = db.ensureDraftSheet(t.id, EV);
  const deny = db.confirmSheet(t.id, EV, { force: true });
  assert.ok(deny.error && deny.ongoing, "進行中の再確定は拒否: " + JSON.stringify(deny).slice(0, 120));
  // 新種目(決勝T)を進行中に作って初回確定
  const EV2 = EV + " 決勝T";
  for (let i = 1; i <= 4; i++) db.createEntrant({ tournament_id: t.id, event: EV2,
    name: "決" + i, team: "T", furigana: "けつ" + i });
  const d2 = db.ensureDraftSheet(t.id, EV2);
  assert.ok(!d2.error);
  const ok = db.confirmSheet(t.id, EV2, {});
  assert.ok(ok.ok, "進行中でも新種目の初回確定は通る: " + JSON.stringify(ok).slice(0, 120));
});

test("markSheetDirty: 旧経路の編集で確定版が dirty に落ち、確定し直しで解消する", () => {
  const { t } = setup(4, false);
  db.ensureDraftSheet(t.id, EV);
  assert.ok(db.confirmSheet(t.id, EV, {}).ok);
  db.markSheetDirty(t.id, EV);
  let st = db.getSheetState(t.id, EV);
  assert.ok(st.dirty, "dirtyフラグが立つ");
  assert.ok(!st.confirmed, "dirty中は確定版なし扱い");
  db.ensureDraftSheet(t.id, EV);
  const c = db.confirmSheet(t.id, EV, { force: true });
  assert.ok(c.ok);
  st = db.getSheetState(t.id, EV);
  assert.ok(!st.dirty && st.confirmed, "確定し直しで解消");
});
