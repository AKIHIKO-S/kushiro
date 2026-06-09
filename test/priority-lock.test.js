// 種目優先順位ロック(このシステムの中核)の回帰テスト。
//   団体 > 混合ダブルス > ダブルス > シングルス。上位種目で生存中(未敗退で将来試合あり)の選手は、
//   下位種目では呼べない(上位の決着待ち)。force で強制呼出は可能。
//   通しリハーサルで動作確認した挙動を固定する(callMatch / getPriorityLockForPlayer)。
// 実行: node --test test/priority-lock.test.js
process.env.DB_PATH = "/tmp/ktta_priolock_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

// 指定種目・選手で pending の対戦カードを1つ作る(player_id/氏名/status を設定)。
function mkMatch(tid, event, round, pA, pB) {
  const m = db.createMatch({ tournament_id: tid, event, round });
  db.editMatch(m.id, {
    event, round, status: "pending",
    player1_id: pA.id, player1_name: pA.name, player2_id: pB.id, player2_name: pB.name,
  });
  return db.getMatch(m.id);
}

test("上位種目(混合D)で生存中の選手は下位種目(男子S)で呼べない・force で可・上位決着後は可", () => {
  const t = db.createTournament({ name: "priolock", date: "2027-07-07" });
  const p1 = db.createPlayer({ name: "甲 一郎", team: "A" });
  const p2 = db.createPlayer({ name: "乙 二郎", team: "B" });
  const p3 = db.createPlayer({ name: "丙 三郎", team: "C" });
  db.updateTournament(t.id, { status: "ongoing" });   // 呼出は ongoing のみ可(#9)

  const mixed = mkMatch(t.id, "混合ダブルス", "1回戦", p1, p2);  // 上位種目(priority 2)
  const singles = mkMatch(t.id, "男子シングルス", "1回戦", p1, p3); // 下位種目(priority 10), p1 共有

  // 1) p1 が混合Dで生存中 → 男子Sの呼出はロック
  let r = db.callMatch(singles.id, 1);
  assert.ok(r && r.error && /上位種目/.test(r.error), "上位種目ロックで拒否: " + JSON.stringify(r).slice(0, 120));
  assert.ok((r.blocked || []).some(b => b.type === "priority"), "priority ブロックが含まれる");

  // 2) force=true なら強制呼出できる
  const rf = db.callMatch(singles.id, 1, null, { force: true });
  assert.ok(rf && !rf.error, "force で呼出成功: " + JSON.stringify(rf).slice(0, 120));
  db.uncallMatch(singles.id);  // 後続テストのため戻す

  // 3) 混合Dを決着(p1のペア敗退=p2勝ち) → p1 は混合Dで敗退 → 男子S が呼べる
  db.callMatch(mixed.id, 2);
  db.finishMatchOp(mixed.id, { winner_slot: 2, sets: [[11, 5], [11, 5]] });   // p2 勝ち, p1 敗退
  const r3 = db.callMatch(singles.id, 1);
  assert.ok(r3 && !r3.error, "上位種目決着後は男子Sを呼べる: " + JSON.stringify(r3).slice(0, 120));
});

test("同位/下位種目は呼出をロックしない(ダブルス生存中でも混合Dは呼べる)", () => {
  const t = db.createTournament({ name: "priolock2", date: "2027-07-08" });
  const p1 = db.createPlayer({ name: "戊 五郎", team: "E" });
  const p2 = db.createPlayer({ name: "己 六郎", team: "F" });
  const p3 = db.createPlayer({ name: "庚 七郎", team: "G" });
  db.updateTournament(t.id, { status: "ongoing" });

  mkMatch(t.id, "一般男子ダブルス", "1回戦", p1, p2);            // priority 3(下位)
  const mixed = mkMatch(t.id, "混合ダブルス", "1回戦", p1, p3);   // priority 2(上位)
  // p1 がダブルス(下位)で生存中でも、上位の混合Dは呼べる(下位はロックしない)
  const r = db.callMatch(mixed.id, 1);
  assert.ok(r && !r.error, "下位種目生存は上位種目の呼出をロックしない: " + JSON.stringify(r).slice(0, 120));
});
