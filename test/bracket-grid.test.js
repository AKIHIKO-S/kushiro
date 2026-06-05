// トーナメント管理タブ Phase2: エクセル風グリッド用データ(getBracketGrid)と
// 氏名/所属編集の表への再同期(syncEntrantsToBracket)の回帰テスト。
// 実行: node --test test/bracket-grid.test.js
process.env.DB_PATH = "/tmp/ktta_grid_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const EV = "一般男子シングルス";
let _seq = 0;
function singles(n) {
  const t = db.createTournament({ name: "グリッド検証" + (++_seq), date: "2027-10-10" });
  for (let i = 1; i <= n; i++) {
    db.createEntrant({ tournament_id: t.id, event: EV, seed: i, surname: "選手" + String(i).padStart(2, "0"), given_name: "太郎", team: "ク" + i, status: "confirmed" });
  }
  db.generateBracket(t.id, EV, { regenerate: true });
  return t;
}
const r1Matches = (t, ev) => db.getMatchesByTournament(t.id).filter(m => m.event === ev && m.bracket_round === 1);

test("getBracketGrid: シングルス4人=1回戦4スロットを行化し、各スロットに entrant_id と編集用フィールドが付く", () => {
  const t = singles(4);
  const g = db.getBracketGrid(t.id, EV);
  assert.ok(g && Array.isArray(g.rows), "grid 返却: " + JSON.stringify(g).slice(0, 120));
  assert.strictEqual(g.bracket_size, 4, "bracket_size=4");
  assert.strictEqual(g.rows.length, 4, "4スロット=4行");
  for (const row of g.rows) {
    assert.ok([1, 2].includes(row.slot), "slot は1か2");
    assert.ok(Number.isInteger(row.pos), "pos は整数");
    assert.ok(row.entrant_id, "各スロットに entrant_id: " + JSON.stringify(row).slice(0, 120));
    assert.strictEqual(row.is_bye, false, "BYEではない");
    assert.ok(row.name && row.team, "name/team あり");
    assert.ok("seed" in row && "entry_round" in row, "seed/entry_round あり");
  }
});

test("getBracketGrid: 3人=BYEスロットは is_bye=true・entrant_id=null", () => {
  const t = singles(3);
  const g = db.getBracketGrid(t.id, EV);
  assert.strictEqual(g.bracket_size, 4, "3人→ブラケット4");
  const byes = g.rows.filter(r => r.is_bye);
  assert.strictEqual(byes.length, 1, "BYEスロットが1つ");
  assert.strictEqual(byes[0].entrant_id, null, "BYEスロットは entrant_id=null");
  const real = g.rows.filter(r => !r.is_bye && r.entrant_id);
  assert.strictEqual(real.length, 3, "実選手3スロット");
});

test("getBracketGrid: ダブルスは is_doubles=true・partner_name/partner_team を含む", () => {
  const ev = "混合ダブルス";
  const t = db.createTournament({ name: "Dグリッド" + (++_seq), date: "2027-10-11" });
  db.createEntrant({ tournament_id: t.id, event: ev, seed: 1, is_doubles: 1, surname: "前", given_name: "太", team: "工業", partner_surname: "小山内", partner_given_name: "花", partner_team: "北陽", status: "confirmed" });
  db.createEntrant({ tournament_id: t.id, event: ev, seed: 2, is_doubles: 1, surname: "今野", given_name: "健", team: "北陽", partner_surname: "板垣", partner_given_name: "翼", partner_team: "Neo", status: "confirmed" });
  db.generateBracket(t.id, ev, { regenerate: true });
  const g = db.getBracketGrid(t.id, ev);
  const d = g.rows.find(r => r.entrant_id && r.is_doubles);
  assert.ok(d, "ダブルス行がある");
  assert.ok(d.partner_name && d.partner_team, "partner_name/partner_team あり: " + JSON.stringify(d).slice(0, 160));
});

test("syncEntrantsToBracket: 氏名変更は単独では表に出ないが、再同期で player*_name が更新され bracketRev も変わる(id/BYEは保持)", () => {
  const t = singles(4);
  const g0 = db.getBracketGrid(t.id, EV);
  const target = g0.rows.find(r => r.entrant_id);
  const eid = target.entrant_id;

  // 1) entrant 正本を改名(updateEntrant は matches を同期しない)。
  //    注: updateEntrant は merged={...existing,...data} を buildEntrantNames に渡すため、
  //    name だけ渡しても既存 surname/given_name が優先される。改名は surname/given_name で送る。
  db.updateEntrant(eid, { surname: "改姓" });
  const before = r1Matches(t, EV);
  const slotBefore = before.find(m => m.player1_entrant_id === eid || m.player2_entrant_id === eid);
  assert.ok(slotBefore, "改名した entrant の枠を特定");
  const sideOf = (m) => (m.player1_entrant_id === eid) ? 1 : 2;
  const s = sideOf(slotBefore);
  const nameBefore = s === 1 ? slotBefore.player1_name : slotBefore.player2_name;
  assert.ok(nameBefore.indexOf("改姓") < 0, "単独PUTでは表の名前は未更新(古いまま): " + nameBefore);

  const revBefore = db.bracketRev(t.id, EV);

  // 2) 再同期
  const r = db.syncEntrantsToBracket(t.id, EV);
  assert.ok(r && r.ok, "再同期成功: " + JSON.stringify(r));

  const after = r1Matches(t, EV);
  const slotAfter = after.find(m => m.id === slotBefore.id);
  const nameAfter = s === 1 ? slotAfter.player1_name : slotAfter.player2_name;
  const entAfter = s === 1 ? slotAfter.player1_entrant_id : slotAfter.player2_entrant_id;
  assert.ok(nameAfter.indexOf("改姓") >= 0, "再同期で表の名前が更新: " + nameAfter);
  assert.strictEqual(entAfter, eid, "entrant_id は保持される");

  const revAfter = db.bracketRev(t.id, EV);
  assert.notStrictEqual(revAfter, revBefore, "名前が変わったので bracketRev も変化");

  // BYE枠は触らない(別大会で3人=BYE生成し再同期してもBYEのまま)
  const t2 = singles(3);
  db.syncEntrantsToBracket(t2.id, EV);
  const byeStill = r1Matches(t2, EV).some(m => m.player1_name === "BYE" || m.player2_name === "BYE");
  assert.ok(byeStill, "BYE表記は再同期後も保持");
});

test("syncEntrantsToBracket: 完了済み試合の勝者を改名すると winner_name も追従(勝敗表示が壊れない)", () => {
  const t = singles(4);
  const r1 = r1Matches(t, EV).sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
  const m = r1[0];
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  const m0 = r1Matches(t, EV).find(x => x.id === m.id);
  const winnerEid = m0.player1_entrant_id;
  assert.ok(winnerEid, "勝者スロットに entrant_id がある");
  assert.strictEqual(m0.winner_name, m0.player1_name, "確定直後は winner_name===player1_name");

  db.updateEntrant(winnerEid, { surname: "優勝改姓" });
  db.syncEntrantsToBracket(t.id, EV);

  const m1 = r1Matches(t, EV).find(x => x.id === m.id);
  assert.ok(m1.player1_name.indexOf("優勝改姓") >= 0, "player1_name が新名: " + m1.player1_name);
  assert.strictEqual(m1.winner_name, m1.player1_name,
    "winner_name も新名に追従(勝敗判定の文字列一致が壊れない): winner=" + m1.winner_name + " p1=" + m1.player1_name);
});

test("syncEntrantsToBracket: 同名対決でも敗者の改名が winner_name を汚染しない(winner_entrant_id判定)", () => {
  const ev = "同名検証";
  const t = db.createTournament({ name: "同名" + (++_seq), date: "2027-10-12" });
  const a = db.createEntrant({ tournament_id: t.id, event: ev, seed: 1, surname: "鈴木", given_name: "一郎", team: "A", status: "confirmed" });
  const b = db.createEntrant({ tournament_id: t.id, event: ev, seed: 2, surname: "鈴木", given_name: "一郎", team: "B", status: "confirmed" });
  db.generateBracket(t.id, ev, { regenerate: true });
  const m = r1Matches(t, ev)[0];
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  const m0 = r1Matches(t, ev).find(x => x.id === m.id);
  const loserEid = m0.player2_entrant_id;
  assert.strictEqual(m0.winner_name, m0.player1_name, "確定直後 winner=player1");

  db.updateEntrant(loserEid, { surname: "敗者改姓" });   // 敗者(同名)を改名
  db.syncEntrantsToBracket(t.id, ev);

  const m1 = r1Matches(t, ev).find(x => x.id === m.id);
  assert.ok(m1.player2_name.indexOf("敗者改姓") >= 0, "player2(敗者)が新名: " + m1.player2_name);
  assert.ok(m1.winner_name.indexOf("敗者改姓") < 0, "winner_name は敗者の新名に汚染されない: " + m1.winner_name);
  assert.ok(m1.loser_name.indexOf("敗者改姓") >= 0, "loser_name は敗者の新名に追従: " + m1.loser_name);
});

test("syncEntrantsToBracket: display_name='BYE' になっても実スロットを偽BYE化しない", () => {
  const t = singles(4);
  const before = r1Matches(t, EV);
  const slot = before.find(x => x.player1_entrant_id);
  const eid = slot.player1_entrant_id;
  db.updateEntrant(eid, { surname: "BYE", given_name: "" });   // 表示名が 'BYE' になる入力
  db.syncEntrantsToBracket(t.id, EV);
  const after = r1Matches(t, EV).find(x => x.id === slot.id);
  assert.notStrictEqual(after.player1_name, "BYE", "実選手枠が 'BYE' に化けない: " + after.player1_name);
});
