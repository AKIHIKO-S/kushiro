// 「線を引っ張ってシードに上げる」= 割当表(シート)の set_entry_round op が
//  「自動で大罫線」を作ることの回帰(オーナー要望 2026-07-18・案B Phase1):
//   - 登場回戦R>1 は 2^(R-1) 枠の区画を専有し、本人以外はBYE(空き)に
//   - 押し出された選手は席を失う=未配置(displaced)に落ちる(消えない)
//   - 確定(materialize)すると本人はR回戦から登場(autoAdvanceByesの多段BYE)
//   - 往復: synthesizeSheetFromMatches が entry_round を復元する
// 実行: node --test test/bracket-seed-drag.test.js
process.env.DB_PATH = "/tmp/ktta_seeddrag_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// 指定人数を枠1..N に配置した確定済みシートを作る
function setupEvent(name, date, event, n) {
  const t = db.createTournament({ name, date });
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ event, pos: i, name: "選手" + i, furigana: "せんしゆ", team: "クラブ" + i });
  const ap = db.importSheetRows(t.id, rows, { create_missing: true });
  assert.ok(ap.ok, JSON.stringify(ap).slice(0, 200));
  assert.ok(db.confirmSheet(t.id, event, {}).ok, "初期確定");
  return t;
}
const entByName = (tid, ev) => new Map(db.getEntrants(tid, ev).map(e => [e.name, e]));
const applySeed = (tid, ev, pos, er) => db.applySheetOps(tid, ev, "", [{ op: "set_entry_round", pos, entry_round: er }]);

test("登場回戦2: 枠1をシード→枠2(R1の相手)がBYE化・選手2は未配置・本人は1回戦不戦勝", () => {
  const EV = "男子シングルス";
  const t = setupEvent("SS検証R2", "2027-12-05", EV, 4);   // 枠1..4 = pos 0..3
  const r = applySeed(t.id, EV, 0, 2);
  assert.ok(r.ok, JSON.stringify(r).slice(0, 200));
  assert.deepStrictEqual(r.displaced, ["選手2"], "区画の隣接(枠2)が未配置へ押し出される");
  assert.ok(db.confirmSheet(t.id, EV, {}).ok, "大罫線つきで再確定");

  // 未配置に 選手2 が現れる(消えない)
  const st = db.getSheetState(t.id, EV);
  assert.ok((st.unplaced || []).some(u => u.name === "選手2"), "選手2は未配置トレイに残る");

  // 本人(選手1)は1回戦不戦勝: R1の枠0の試合で相手がBYE
  const by = entByName(t.id, EV);
  const r1 = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
    .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
  const m0 = r1.find(m => m.player1_entrant_id === by.get("選手1").id || m.player2_entrant_id === by.get("選手1").id);
  assert.ok(m0, "選手1のR1試合がある");
  const oppName = m0.player1_entrant_id === by.get("選手1").id ? m0.player2_name : m0.player1_name;
  assert.strictEqual(oppName, "BYE", "選手1の1回戦相手はBYE(大罫線)");
});

test("登場回戦3(スーパーシード): 4枠区画を専有・3名を未配置・本人は3回戦から登場・往復一致", () => {
  const EV = "男子シングルス";
  const t = setupEvent("SS検証R3", "2027-12-06", EV, 8);   // 枠1..8 = pos 0..7
  const r = applySeed(t.id, EV, 0, 3);
  assert.ok(r.ok, JSON.stringify(r).slice(0, 200));
  assert.deepStrictEqual(r.displaced.sort(), ["選手2", "選手3", "選手4"], "区画[枠1..4]の枠2-4が未配置へ");
  assert.ok(db.confirmSheet(t.id, EV, {}).ok, "スーパーシードで再確定");

  const by = entByName(t.id, EV);
  // 本人(選手1)は3回戦まで実対戦なし=1・2回戦の相手がBYEで繰り上がる
  const ms = db.getMatchesByTournament(t.id).filter(m => m.event === EV);
  const firstReal = ms.filter(m =>
    (m.player1_entrant_id === by.get("選手1").id || m.player2_entrant_id === by.get("選手1").id) &&
    m.player1_name && m.player2_name && m.player1_name !== "BYE" && m.player2_name !== "BYE");
  // 選手1の初の実対戦は3回戦(bracket_round===3)
  const rounds = firstReal.map(m => m.bracket_round).sort();
  assert.ok(rounds.length === 0 || rounds[0] >= 3, "選手1の初の実対戦は3回戦以降: " + JSON.stringify(rounds));

  // 往復: entrants.entry_round が3で同期され、synthesizeSheetFromMatches が復元する
  assert.strictEqual(parseInt(by.get("選手1").entry_round), 3, "entrants.entry_round=3 に同期");
  const synth = db.synthesizeSheetFromMatches(t.id, EV);
  assert.ok(synth, "matchesからシート合成できる");
  const seat1 = (synth.seats || []).find(s => s.entrant_id === by.get("選手1").id);
  assert.ok(seat1 && seat1.entry_round === 3, "合成シートで登場回戦3が復元される");
});

test("登場回戦1に戻す: opは通り、区画のBYE化はしない(押し出しゼロ)", () => {
  const EV = "男子シングルス";
  const t = setupEvent("SS検証戻し", "2027-12-07", EV, 4);
  db.applySheetOps(t.id, EV, "", [{ op: "set_entry_round", pos: 0, entry_round: 2 }]);
  const back = db.applySheetOps(t.id, EV, "", [{ op: "set_entry_round", pos: 0, entry_round: 1 }]);
  assert.ok(back.ok, JSON.stringify(back).slice(0, 150));
  assert.deepStrictEqual(back.displaced, [], "登場回戦1へ戻すときは押し出しなし");
});
