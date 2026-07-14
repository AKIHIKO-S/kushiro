// 構造バリデータ(validateBracketStructure)の検証マトリクス。
// 「細かな対戦設定(1回戦/2回戦/SS区画/進出リンク/決勝固定ペア)が確実に通る」ことを固定する。
// 実行: node --test test/bracket-structure.test.js
process.env.DB_PATH = "/tmp/ktta_struct_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const Database = require("better-sqlite3");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
function mkEntrants(t, n) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const e = db.createEntrant({ tournament_id: t.id, event: EV,
      name: "選手" + String(i).padStart(3, "0"), team: "ク" + (i % 21), furigana: "せ" + String(i).padStart(3, "0") });
    ids.push(e.id);
  }
  return ids;
}

test("SS大会フル構成(306人・シード32・外R5/中R3): 構造チェックOK・決勝固定ペア", () => {
  const t = db.createTournament({ name: "構造SS", date: "2027-07-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0, open: true }] });
  const ids = mkEntrants(t, 306);
  const sq = new Database(process.env.DB_PATH);
  for (let r = 1; r <= 32; r++) {
    const local = ((r - 1) % 8) + 1;
    const er = (local === 1 || local === 8) ? 5 : 3;
    sq.prepare("UPDATE entrants SET seed=?, entry_round=? WHERE id=?").run(r, er, ids[r - 1]);
  }
  sq.close();
  const dr = db.drawSingleBracket(t.id, EV, { drawn_by: "検証" });
  assert.strictEqual(dr.success, true, JSON.stringify(dr).slice(0, 200));
  const v = db.validateBracketStructure(t.id, EV);
  assert.strictEqual(v.ok, true, JSON.stringify(v.issues).slice(0, 400));
  assert.strictEqual(v.summary.players, 306);
  assert.strictEqual(v.summary.ss_ok, 32, "SS32名全員の登場回戦が構造成立");
  assert.strictEqual(v.summary.finals_fixed, true, "決勝=Ａ×Ｂ/Ｃ×Ｄ固定");
  assert.deepStrictEqual(v.summary.blocks, [76, 76, 77, 77], "4ブロック均等(端数は末尾)");
});

test("通常大会(for_mac標準・シード8+2回戦シード混在): 構造チェックOK", () => {
  const t = db.createTournament({ name: "構造通常", date: "2027-07-01" });
  const ids = mkEntrants(t, 40);
  const sq = new Database(process.env.DB_PATH);
  for (let r = 1; r <= 8; r++) sq.prepare("UPDATE entrants SET seed=? WHERE id=?").run(r, ids[r - 1]);
  sq.prepare("UPDATE entrants SET entry_round=2 WHERE id=?").run(ids[0]);   // 第1シード=2回戦から
  sq.prepare("UPDATE entrants SET entry_round=2 WHERE id=?").run(ids[1]);
  sq.close();
  const dr = db.drawSingleBracket(t.id, EV, { drawn_by: "検証" });
  assert.strictEqual(dr.success, true, JSON.stringify(dr).slice(0, 160));
  const v = db.validateBracketStructure(t.id, EV);
  assert.strictEqual(v.ok, true, JSON.stringify(v.issues).slice(0, 300));
  assert.strictEqual(v.summary.ss_ok, 2, "2回戦シード2名の区画成立");
});

test("破壊検知: スロットBYE化=未配置warn / next_matchリンク破壊=block", () => {
  const t = db.createTournament({ name: "構造破壊", date: "2027-07-01" });
  mkEntrants(t, 16);
  db.generateBracket(t.id, EV, {});
  let v = db.validateBracketStructure(t.id, EV);
  assert.strictEqual(v.ok, true, "初期はOK");
  // (a) 1スロットをBYE化 → 未配置warn(okは維持)
  db.setBracketSlot(t.id, EV, 0, 1, { bye: true });
  v = db.validateBracketStructure(t.id, EV);
  assert.strictEqual(v.summary.unplaced, 1, "未配置1名を検出");
  assert.ok(v.issues.some(i => i.level === "warn" && /未配置/.test(i.msg)));
  // (b) next_match_id を故意に破壊 → block
  const sq = new Database(process.env.DB_PATH);
  const m = sq.prepare("SELECT id FROM matches WHERE tournament_id=? AND event=? AND bracket_round=1 LIMIT 1").get(t.id, EV);
  sq.prepare("UPDATE matches SET next_match_id='broken' WHERE id=?").run(m.id);
  sq.close();
  v = db.validateBracketStructure(t.id, EV);
  assert.strictEqual(v.ok, false, "リンク破壊はok=false");
  assert.ok(v.issues.some(i => i.level === "block" && /進出先リンク/.test(i.msg)), JSON.stringify(v.issues));
});

test("二重配置の検知(block)", () => {
  const t = db.createTournament({ name: "構造二重", date: "2027-07-01" });
  mkEntrants(t, 8);
  db.generateBracket(t.id, EV, {});
  // 同一entrantを別スロットへ複製(異常状態を直接作る)
  const sq = new Database(process.env.DB_PATH);
  const r1 = sq.prepare("SELECT id, player1_entrant_id, player1_name FROM matches WHERE tournament_id=? AND event=? AND bracket_round=1 ORDER BY bracket_pos").all(t.id, EV);
  sq.prepare("UPDATE matches SET player2_entrant_id=?, player2_name=? WHERE id=?")
    .run(r1[0].player1_entrant_id, r1[0].player1_name, r1[1].id);
  sq.close();
  const v = db.validateBracketStructure(t.id, EV);
  assert.strictEqual(v.ok, false);
  assert.ok(v.issues.some(i => /二重配置/.test(i.msg)), JSON.stringify(v.issues));
});

test("種目指定Undo: 直前の操作が別種目なら巻き込まず明示エラー", () => {
  const t = db.createTournament({ name: "Undo種目絞り", date: "2027-07-01" });
  const EV2 = "女子シングルス";
  for (let i = 1; i <= 4; i++) db.createEntrant({ tournament_id: t.id, event: EV,
    name: "男" + i, team: "ク" + i, furigana: "あ" + i });
  for (let i = 1; i <= 4; i++) db.createEntrant({ tournament_id: t.id, event: EV2,
    name: "女" + i, team: "ク" + i, furigana: "か" + i });
  db.generateBracket(t.id, EV, {});
  db.generateBracket(t.id, EV2, {});
  const sw = db.swapBracketSlots(t.id, EV2, { pos: 0, slot: 1 }, { pos: 1, slot: 1 });
  assert.ok(!sw.error, "女子で入替: " + JSON.stringify(sw).slice(0, 60));
  const r1 = db.undoLast(t.id, EV);   // 男子指定 → 直前op=女子 → エラー
  assert.ok(r1.error && r1.other_event === EV2, "別種目は巻き込まない: " + JSON.stringify(r1).slice(0, 120));
  const r2 = db.undoLast(t.id, EV2);  // 女子指定 → 取り消せる
  assert.ok(!r2.error && r2.kind === "op", "同種目は取消可: " + JSON.stringify(r2).slice(0, 80));
});
