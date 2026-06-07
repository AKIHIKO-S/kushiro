// ダブルスの入替(選手1↔2 一括 / 相方入替)が Undo できる回帰。
// op_log に entrant 行と参照先 matches をスナップショットし、undoLastOp が両方を元へ戻す。
// 実行: node --test test/entrant-swap-undo.test.js
process.env.DB_PATH = "/tmp/ktta_swapundo_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const EV = "混合ダブルス";
let _seq = 0;
const r1Names = (t, ev) => db.getMatchesByTournament(t.id)
  .filter(m => m.event === ev && m.bracket_round === 1)
  .flatMap(m => [m.player1_name, m.player2_name]).filter(Boolean).join(" / ");

test("swapDoublesOrder → undoLastOp で entrant の並びと表の氏名が元へ戻る", () => {
  const t = db.createTournament({ name: "入替undo" + (++_seq), date: "2027-11-01" });
  const a = db.createEntrant({ tournament_id: t.id, event: EV, seed: 1, is_doubles: 1,
    surname: "前", given_name: "太", furigana: "まえ", team: "工業",
    partner_surname: "小山内", partner_given_name: "花", partner_furigana: "おさない", partner_team: "北陽", status: "confirmed" });
  db.createEntrant({ tournament_id: t.id, event: EV, seed: 2, is_doubles: 1,
    surname: "今野", given_name: "健", furigana: "こんの", team: "北陽",
    partner_surname: "板垣", partner_given_name: "翼", partner_furigana: "いたがき", partner_team: "Neo", status: "confirmed" });
  db.generateBracket(t.id, EV, { regenerate: true });
  const namesBefore = r1Names(t, EV);

  const r = db.swapDoublesOrder(t.id, EV);
  assert.ok(r && r.swapped === 2, "2ペア入替: " + JSON.stringify(r));
  // 入替後: 選手1が小山内に
  assert.ok(db.getEntrants(t.id, EV).some(e => e.surname === "小山内"), "入替後は選手1=小山内");

  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo 成功: " + JSON.stringify(u));

  const A = db.getEntrants(t.id, EV).find(e => e.id === a.id);
  assert.strictEqual(A.surname, "前", "undo で選手1が前に戻る: " + A.surname);
  assert.strictEqual(A.furigana, "まえ", "undo で選手1の読みも戻る: " + A.furigana);
  assert.strictEqual(A.partner_surname, "小山内", "undo で相方が小山内に戻る: " + A.partner_surname);
  assert.strictEqual(A.partner_furigana, "おさない", "undo で相方の読みも戻る: " + A.partner_furigana);
  assert.strictEqual(r1Names(t, EV), namesBefore, "undo で表の氏名も元へ: " + r1Names(t, EV));
});

test("swapEntrantPartners → undoLastOp でペア構成と表が元へ戻る", () => {
  const t = db.createTournament({ name: "相方undo" + (++_seq), date: "2027-11-02" });
  const a = db.createEntrant({ tournament_id: t.id, event: EV, seed: 1, is_doubles: 1,
    surname: "前", given_name: "太", team: "工業",
    partner_surname: "小山内", partner_given_name: "花", partner_furigana: "おさない", partner_team: "北陽", status: "confirmed" });
  const b = db.createEntrant({ tournament_id: t.id, event: EV, seed: 2, is_doubles: 1,
    surname: "今野", given_name: "健", team: "北陽",
    partner_surname: "板垣", partner_given_name: "翼", partner_furigana: "いたがき", partner_team: "Neo", status: "confirmed" });
  db.generateBracket(t.id, EV, { regenerate: true });
  const namesBefore = r1Names(t, EV);

  const r = db.swapEntrantPartners(t.id, EV, a.id, b.id);
  assert.ok(r && !r.error, "相方入替成功");
  assert.ok((db.getEntrants(t.id, EV).find(e => e.id === a.id).partner_name || "").indexOf("板垣") >= 0, "入替後A相方=板垣");

  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo 成功: " + JSON.stringify(u));

  const A = db.getEntrants(t.id, EV).find(e => e.id === a.id);
  const B = db.getEntrants(t.id, EV).find(e => e.id === b.id);
  assert.ok((A.partner_name || "").indexOf("小山内") >= 0, "undo でA相方が小山内へ戻る: " + A.partner_name);
  assert.strictEqual(A.partner_furigana, "おさない", "undo でA相方の読みも戻る: " + A.partner_furigana);
  assert.ok((B.partner_name || "").indexOf("板垣") >= 0, "undo でB相方が板垣へ戻る: " + B.partner_name);
  assert.strictEqual(r1Names(t, EV), namesBefore, "undo で表の氏名も元へ: " + r1Names(t, EV));
});
