// 当日進行の核心(勝者の次戦進出)の回帰テスト。
//   ① finish → 勝者が next_match の正しいスロットへ進出
//   ② BYE は自動繰り上げ(generateBracket 時に実選手が次戦へ)
//   ③ 冪等: 同じ勝者で再 finish しても二重進出しない
//   ④ 競合: 完了済み試合を別勝者で finish すると上書きせず conflict を返す
//   ⑤ 修正: correctResult で勝者反転 → 次戦が新勝者に貼り替わる(旧勝者は消える)
// これらは結果入力の中枢で、壊れるとブラケットが静かに不整合化する。elo-integrity/team-tie は
// Elo・団体内訳を見るが「進出そのもの」を直接は固定していないため本テストで担保する。
// 実行: node --test test/progression-advance.test.js
process.env.DB_PATH = "/tmp/ktta_prog_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const EV = "男子シングルス";
let seq = 0;
function setup(names) {
  const t = db.createTournament({ name: "prog" + (++seq), date: "2027-09-09" });
  names.forEach((n, i) => db.createEntrant({ tournament_id: t.id, event: EV, surname: n, given_name: "", team: "T" + i, status: "confirmed" }));
  db.generateBracket(t.id, EV, { regenerate: true });
  return t;
}
const matches = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV);
const round1Real = (t) => matches(t).filter(m => m.bracket_round === 1 &&
  m.player1_name && m.player2_name && m.player1_name !== "BYE" && m.player2_name !== "BYE")
  .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
const byId = (t, id) => matches(t).find(m => m.id === id);

test("① finish → 勝者が next_match の正しいスロットへ進出", () => {
  const t = setup(["甲", "乙", "丙", "丁"]);
  const r1 = round1Real(t);
  assert.strictEqual(r1.length, 2, "1回戦は実戦2試合");
  const m0 = r1[0];
  const winnerName = m0.player1_name;
  const r = db.finishMatchOp(m0.id, { winner_slot: 1, sets: [[11, 5], [11, 7]] });
  assert.ok(r && r.status === "completed", "完了: " + JSON.stringify(r && r.status));
  const next = byId(t, m0.next_match_id);
  assert.ok(next, "next_match がある");
  const slotName = m0.next_slot === 1 ? next.player1_name : next.player2_name;
  assert.strictEqual(slotName, winnerName, `勝者(${winnerName})が next の slot${m0.next_slot} に: ` + JSON.stringify([next.player1_name, next.player2_name]));
});

test("② BYE は自動繰り上げ(3人/4枠 → BYE相手が決勝枠に既に進出)", () => {
  const t = setup(["甲", "乙", "丙"]);   // 3人=4枠, 1 BYE
  const ms = matches(t);
  // BYEと当たった実選手の試合は completed(不戦勝)
  const byeMatch = ms.find(m => m.bracket_round === 1 && (m.player1_name === "BYE" || m.player2_name === "BYE"));
  assert.ok(byeMatch, "BYEを含む1回戦がある");
  assert.strictEqual(byeMatch.status, "completed", "BYE戦は自動完了(不戦勝)");
  // その勝者が2回戦(決勝)の枠に入っている
  const advanced = byeMatch.player1_name === "BYE" ? byeMatch.player2_name : byeMatch.player1_name;
  const final = ms.find(m => m.bracket_round === 2);
  assert.ok(final, "決勝がある");
  const inFinal = final.player1_name === advanced || final.player2_name === advanced;
  assert.ok(inFinal, `BYE不戦勝者(${advanced})が決勝枠に: ` + JSON.stringify([final.player1_name, final.player2_name]));
});

test("③ 冪等: 同じ勝者で再 finish しても二重進出しない", () => {
  const t = setup(["甲", "乙", "丙", "丁"]);
  const m0 = round1Real(t)[0];
  const winnerName = m0.player1_name;
  db.finishMatchOp(m0.id, { winner_slot: 1, sets: [[11, 5], [11, 7]] });
  const next1 = byId(t, m0.next_match_id);
  const slotBefore = m0.next_slot === 1 ? next1.player1_name : next1.player2_name;
  // 連打/オフライン再送を模して同じ勝者で再 finish
  const r2 = db.finishMatchOp(m0.id, { winner_slot: 1, sets: [[11, 5], [11, 7]] });
  assert.ok(r2 && !r2.conflict, "同じ勝者の再finishは冪等(競合にしない)");
  const next2 = byId(t, m0.next_match_id);
  const slotAfter = m0.next_slot === 1 ? next2.player1_name : next2.player2_name;
  assert.strictEqual(slotAfter, slotBefore, "next の勝者枠は不変(二重進出なし)");
  assert.strictEqual(slotAfter, winnerName, "勝者は変わらず " + winnerName);
});

test("④ 競合: 完了済み試合を別勝者で finish すると上書きせず conflict", () => {
  const t = setup(["甲", "乙", "丙", "丁"]);
  const m0 = round1Real(t)[0];
  db.finishMatchOp(m0.id, { winner_slot: 1, sets: [[11, 5], [11, 7]] });
  const r = db.finishMatchOp(m0.id, { winner_slot: 2, sets: [[5, 11], [7, 11]] });
  assert.ok(r && r.conflict, "別勝者の再finishは conflict を返す: " + JSON.stringify(r));
  // 結果は元のまま(上書きされていない)
  const m = byId(t, m0.id);
  assert.strictEqual(m.winner_name, m0.player1_name, "勝者は最初のまま(上書き無し)");
});

test("⑤ 修正: correctResult で勝者反転 → 次戦が新勝者へ貼り替わる", () => {
  const t = setup(["甲", "乙", "丙", "丁"]);
  const m0 = round1Real(t)[0];
  const p1 = m0.player1_name, p2 = m0.player2_name;
  db.finishMatchOp(m0.id, { winner_slot: 1, sets: [[11, 5], [11, 7]] });
  const nextSlot = m0.next_slot;
  let next = byId(t, m0.next_match_id);
  assert.strictEqual(nextSlot === 1 ? next.player1_name : next.player2_name, p1, "進出は当初 p1");
  // 勝者を p2 に修正
  const r = db.correctResult(m0.id, { winner_slot: 2, sets: [[5, 11], [7, 11]] });
  assert.ok(r && !r.error, "修正成功: " + JSON.stringify(r && r.error));
  next = byId(t, m0.next_match_id);
  const slotName = nextSlot === 1 ? next.player1_name : next.player2_name;
  assert.strictEqual(slotName, p2, `次戦の枠が新勝者(${p2})に貼り替わる: ` + JSON.stringify([next.player1_name, next.player2_name]));
  assert.notStrictEqual(slotName, p1, "旧勝者は次戦から消える");
});
