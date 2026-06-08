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
