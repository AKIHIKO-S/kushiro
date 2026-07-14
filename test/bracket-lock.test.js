// トーナメント表の手動ロック(setBracketLock)と、進行後入替のforce対応を検証する。
// 実行: node --test test/bracket-lock.test.js
process.env.DB_PATH = "/tmp/ktta_lock_" + process.pid + ".db";

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
function setup() {
  const t = db.createTournament({ name: "ロック検証", date: "2027-05-01" });
  for (let i = 1; i <= 8; i++) db.createEntrant({ tournament_id: t.id, event: EV,
    name: "選手" + i, team: "ク" + i, furigana: "せ" + i });
  db.generateBracket(t.id, EV, {});
  return t;
}

test("手動ロック: ロック中は入替/スロット編集を拒否・解除で再び可能", () => {
  const t = setup();
  const r1 = db.setBracketLock(t.id, EV, true);
  assert.strictEqual(r1.ok, true);
  const sw = db.swapBracketSlots(t.id, EV, { pos: 0, slot: 1 }, { pos: 1, slot: 1 });
  assert.ok(sw.error && sw.locked, "ロック中はswap拒否: " + JSON.stringify(sw));
  const ss = db.setBracketSlot(t.id, EV, 0, 1, { bye: true });
  assert.ok(ss.error && ss.locked, "ロック中はset-slot拒否");
  db.setBracketLock(t.id, EV, false);
  const sw2 = db.swapBracketSlots(t.id, EV, { pos: 0, slot: 1 }, { pos: 1, slot: 1 });
  assert.ok(!sw2.error, "解除後はswap可: " + JSON.stringify(sw2).slice(0, 80));
});

test("進行後の入替: needs_force → force指定で選手名のみ入替(結果は保持)", () => {
  const t = setup();
  const m = db.getMatchesByTournament(t.id).find(x => x.event === EV && x.bracket_round === 1
    && x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0 });
  const other = db.getMatchesByTournament(t.id).find(x => x.event === EV && x.bracket_round === 1
    && x.id !== m.id && x.player1_name && x.player1_name !== "BYE");
  const before1 = db.getMatchesByTournament(t.id).find(x => x.id === m.id).player1_name;
  const beforeO = db.getMatchesByTournament(t.id).find(x => x.id === other.id).player1_name;
  const r1 = db.swapBracketSlots(t.id, EV, { pos: m.bracket_pos, slot: 1 }, { pos: other.bracket_pos, slot: 1 });
  assert.strictEqual(r1.needs_force, true, "確定済みはneeds_force: " + JSON.stringify(r1));
  const r2 = db.swapBracketSlots(t.id, EV, { pos: m.bracket_pos, slot: 1 }, { pos: other.bracket_pos, slot: 1 }, { force: true });
  assert.ok(!r2.error, "forceで入替可: " + JSON.stringify(r2).slice(0, 80));
  const after1 = db.getMatchesByTournament(t.id).find(x => x.id === m.id).player1_name;
  const afterO = db.getMatchesByTournament(t.id).find(x => x.id === other.id).player1_name;
  assert.strictEqual(after1, beforeO); assert.strictEqual(afterO, before1);
});
