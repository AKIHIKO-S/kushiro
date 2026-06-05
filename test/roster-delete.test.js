// 名簿(出場者)の一括削除(deleteRoster / rosterStats)の回帰テスト。
//  - 種目単位削除はその種目の entrants+matches だけ消し、他種目は残す。
//  - 大会まるごと削除は全 entrants+matches を消す。
//  - rosterStats は件数と「結果入力済み」を数える(削除ガードの根拠)。
// 実行: node --test test/roster-delete.test.js
process.env.DB_PATH = "/tmp/ktta_rosterdel_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} });

const EVS = ["男子シングルス", "女子シングルス"];
let _seq = 0;
function setup() {
  const t = db.createTournament({ name: "名簿削除検証" + (++_seq), date: "2027-07-07" });
  for (const ev of EVS) {
    for (let i = 1; i <= 4; i++) db.createEntrant({ tournament_id: t.id, event: ev, seed: i, name: ev + String(i), status: "confirmed" });
  }
  db.generateBracket(t.id, EVS[0], { regenerate: true });
  db.generateBracket(t.id, EVS[1], { regenerate: true });
  return t;
}
const evMatchCount = (t, ev) => db.getMatchesByTournament(t.id).filter(m => m.event === ev).length;

test("deleteRoster(種目): その種目の出場者+表だけ消し、他種目は残す", () => {
  const t = setup();
  const m0 = evMatchCount(t, EVS[0]);
  assert.ok(db.getEntrants(t.id, EVS[0]).length === 4 && m0 >= 1, "前提: 男子に4名+試合あり");
  const r = db.deleteRoster(t.id, EVS[0]);
  assert.strictEqual(r.entrants, 4, "男子の出場者4名を削除");
  assert.ok(r.matches >= 1, "男子の試合も削除");
  assert.strictEqual(db.getEntrants(t.id, EVS[0]).length, 0, "男子 出場者0");
  assert.strictEqual(evMatchCount(t, EVS[0]), 0, "男子 試合0");
  assert.strictEqual(db.getEntrants(t.id, EVS[1]).length, 4, "女子は残る(出場者)");
  assert.ok(evMatchCount(t, EVS[1]) >= 1, "女子は残る(試合)");
});

test("deleteRoster(大会まるごと): 全種目の出場者+表を消す", () => {
  const t = setup();
  const r = db.deleteRoster(t.id, "");
  assert.strictEqual(db.getEntrants(t.id).length, 0, "全出場者0");
  assert.strictEqual(db.getMatchesByTournament(t.id).length, 0, "全試合0");
  assert.ok(r.entrants >= 8 && r.matches >= 2, "削除件数: " + JSON.stringify(r));
});

test("rosterStats: 件数と結果入力済みを数える(削除ガードの根拠)", () => {
  const t = setup();
  let s = db.rosterStats(t.id, EVS[0]);
  assert.strictEqual(s.entrants, 4, "出場者4名");
  assert.strictEqual(s.completed, 0, "結果未入力なら completed 0");
  const m = db.getMatchesByTournament(t.id).find(x => x.event === EVS[0] && x.player1_id && x.player2_id && x.status !== "completed");
  if (m) {
    db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
    assert.ok(db.rosterStats(t.id, EVS[0]).completed >= 1, "結果確定後は completed>=1(=force要求の根拠)");
  }
});
