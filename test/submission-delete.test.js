// 申込1件の削除(受付台帳の「この申込を削除」)の回帰テスト。
//
// 守らせる不変条件:
//   ① 削除すると台帳・出場者から消え、他の団体の申込は変わらない
//   ② 削除前の中身が控え(deleted_submissions)に残り、元に戻すと件数・申込番号の閲覧が復活する
//   ③ 履歴に「削除」「元に戻した」が残る
//   ④ 組合せ(試合)に入っている出場がある申込は削除しない
// 実行: node --test test/submission-delete.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_subdel_" + process.pid + ".db");

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} }
});

const EVENTS = [{ name: "一般男子シングルス", type: "singles", fee: 700 }];
function setup() {
  const t = db.createTournament({ name: "削除検証大会", date: "2099-12-06" });
  db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "", event_config: EVENTS });
  return db.getTournament(t.id);
}
// 削除は取り消し済みの申込だけ(2段階)。テストでは出場をすべて取り消してから削除する
function cancelAll(tid, sid) {
  db.getEntryDesk(tid).rows.find(x => x.submission_id === sid)
    .players.forEach(p => db.updateEntrant(p.entrant_id, { status: "cancelled" }));
}
function apply(t, team, names) {
  const r = db.createTeamEntry(t.id, {
    team_name: team, contact_name: "連絡 担当", contact_tel: "0154-00-0000", contact_email: "del@example.com",
    entries: names.map((n, i) => ({ event: EVENTS[0].name, type: "singles", name: n, furigana: "かくう " + i, team })),
  }, "op-del-" + Math.random().toString(36).slice(2), { enforce: true });
  assert.ok(!r.error, r.error);
  return r.submission_id;
}

test("削除→控えが残る→元に戻せる。他の団体は変わらない", () => {
  const t = setup();
  const a = apply(t, "架空クラブ", ["架空 太郎", "架空 次郎"]);
  const b = apply(t, "見本中学校", ["見本 花子"]);
  assert.strictEqual(db.getEntryDesk(t.id).rows.length, 2);

  const early = db.deleteSubmission(a, { reason: "二重申込のため", operator: "OP1" });
  assert.ok(early.error && early.need_cancel, "取り消す前は削除できない(2段階)");
  assert.strictEqual(db.getEntryDesk(t.id).rows.length, 2, "拒否されたら何も消えない");
  cancelAll(t.id, a);
  const r = db.deleteSubmission(a, { reason: "二重申込のため", operator: "OP1" });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.entrants, 2);
  const d = db.getEntryDesk(t.id);
  assert.deepStrictEqual(d.rows.map(x => x.submission_id), [b], "削除した申込だけ台帳から消える");
  assert.strictEqual(d.totals.entries, 1);

  const list = db.listDeletedSubmissions(t.id);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].team_name, "架空クラブ");
  assert.strictEqual(list[0].operator, "OP1");
  assert.strictEqual(list[0].reason, "二重申込のため");

  const back = db.restoreDeletedSubmission(list[0].id);
  assert.ok(back.ok, back.error);
  const d2 = db.getEntryDesk(t.id);
  assert.strictEqual(d2.rows.length, 2);
  assert.strictEqual(d2.rows.find(x => x.submission_id === a).players.length, 2, "出場は取り消し済みのまま復元される");
  assert.ok(db.restoreDeletedSubmission(list[0].id).error, "二重に戻せない");
});

test("存在しない申込は削除できない", () => {
  assert.ok(db.deleteSubmission("no-such").error);
  assert.ok(db.restoreDeletedSubmission("no-such").error);
});
