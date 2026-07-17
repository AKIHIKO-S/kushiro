// 割当表の当日修正(案B P7)の回帰: patchSheet。
//  - 進行中でも 2枠入替/補欠差替 ができ、matches とシートが同時に更新され新版が採番される
//  - 試合が始まった枠は拒否 / 理由必須
// (予選→決勝Tのシート化は、migrateBracketSheets が ongoing 大会の新種目を拾うことを
//  sheet-migration.test.js で検証済み。playoffルートはそれを1回呼ぶだけ。)
// 実行: node --test test/sheet-patch.test.js
process.env.DB_PATH = "/tmp/ktta_sheetpt_" + process.pid + ".db";

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
function setupOngoing(n) {
  const t = db.createTournament({ name: "当日修正検証" + (++seq), date: "2027-09-01" });
  const eids = [];
  for (let i = 1; i <= n; i++) {
    const e = db.createEntrant({ tournament_id: t.id, event: EV,
      name: "当" + String(i).padStart(2, "0"), team: "ク" + (i % 3), furigana: "とう" + String(i).padStart(2, "0") });
    eids.push(e.id);
  }
  db.ensureDraftSheet(t.id, EV);
  const c = db.confirmSheet(t.id, EV, {});
  assert.ok(c.ok, JSON.stringify(c).slice(0, 120));
  db.updateTournament(t.id, { status: "ongoing" });
  return { t, eids };
}
const seatsOf = (tid) => db.getSheetState(tid, EV).confirmed.seats;
const leafEnt = (tid, pos) => {
  const m = db.getMatchesByTournament(tid).find(x => x.event === EV && x.bracket_round === 1 && (x.bracket_pos || 0) === Math.floor(pos / 2));
  return (pos % 2 === 0) ? m.player1_entrant_id : m.player2_entrant_id;
};

test("当日入替(swap): 進行中でも実行でき、matchesとシートが同時に新版へ", () => {
  const { t } = setupOngoing(8);
  const before = seatsOf(t.id);
  const entA = before[0].entrant_id, entB = before[5].entrant_id;
  const r = db.patchSheet(t.id, EV, { type: "swap", a_pos: 0, b_pos: 5, reason: "体調不良" });
  assert.ok(r.ok, JSON.stringify(r).slice(0, 150));
  assert.strictEqual(r.rev_no, 2, "新版=第2版");
  const st = db.getSheetState(t.id, EV);
  assert.strictEqual(st.confirmed.rev_no, 2);
  assert.ok(!st.dirty, "patchはdirtyを残さない(write-through)");
  assert.strictEqual(st.confirmed.seats[0].entrant_id, entB, "シート側が入替済み");
  assert.strictEqual(st.confirmed.seats[5].entrant_id, entA);
  assert.strictEqual(leafEnt(t.id, 0), entB, "matches側も入替済み(同一トランザクション)");
  assert.strictEqual(leafEnt(t.id, 5), entA);
  assert.strictEqual(st.confirmed.tree_hash, db.canonicalStructHash(t.id, EV), "封印ハッシュも現物と一致");
  assert.ok(/体調不良/.test(st.confirmed.reason), "理由が記録される");
});

test("試合が始まった枠(on_table)は当日入替を拒否", () => {
  const { t } = setupOngoing(8);
  // 枠0/1の試合を呼出(ongoingなので可)
  const m = db.getMatchesByTournament(t.id).find(x => x.event === EV && x.bracket_round === 1 && (x.bracket_pos || 0) === 0);
  const call = db.callMatch(m.id, 1, null, {});
  assert.ok(!call.error, "呼出成功: " + JSON.stringify(call).slice(0, 100));
  const r = db.patchSheet(t.id, EV, { type: "swap", a_pos: 0, b_pos: 5, reason: "遅刻" });
  assert.ok(r.error && /始まっている/.test(r.error), "開始済みは拒否: " + r.error);
});

test("補欠差替(substitute): 未配置の選手を空いた枠に入れられる・理由なしは拒否", () => {
  const { t } = setupOngoing(8);
  // 1人を座席から外して(下書き→clear→…はongoingでは confirm できないため)、
  // 未配置選手は「確定前に外しておいた」状態を作る: いったんscheduledに戻して再確定する。
  db.updateTournament(t.id, { status: "scheduled" });
  const d = db.ensureDraftSheet(t.id, EV);
  const outEnt = d.seats[7].entrant_id;
  assert.ok(db.applySheetOps(t.id, EV, d.sheet_hash, [{ op: "clear", pos: 7 }]).ok);
  assert.ok(db.confirmSheet(t.id, EV, { force: true }).ok, "第2版(1名外し)");
  db.updateTournament(t.id, { status: "ongoing" });
  // 理由なしは拒否
  const noReason = db.patchSheet(t.id, EV, { type: "substitute", pos: 7, entrant_id: outEnt, reason: "" });
  assert.ok(noReason.error && /理由/.test(noReason.error), "理由必須");
  // 補欠として枠7へ
  const r = db.patchSheet(t.id, EV, { type: "substitute", pos: 7, entrant_id: outEnt, reason: "その他(補欠繰上げ)" });
  assert.ok(r.ok, JSON.stringify(r).slice(0, 150));
  const st = db.getSheetState(t.id, EV);
  assert.strictEqual(st.confirmed.seats[7].entrant_id, outEnt, "シートに入った");
  assert.strictEqual(leafEnt(t.id, 7), outEnt, "matchesにも入った");
  assert.strictEqual(st.unplaced.length, 0, "未配置から消えた");
});
