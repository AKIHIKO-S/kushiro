// 管理画面の通知(ナビの鈴)の元データ(db.listAdminNotifications)の回帰テスト。
//
// 守らせる不変条件:
//   ① 「前に見た時刻」より後の新しい申込と、申込者本人による変更が出る。本部の操作は出さない
//   ② 返した now を次の since に使うと、同じ出来事は二度と出ない(開いたら既読になる)
//   ③ 初回(since なし・不正)は「いま」から数える(過去の分で数字を膨らませない)
//   ④ 通知に連絡先などの個人情報を載せない
// 実行: node --test test/admin-notifications.test.js
process.env.DB_PATH = "/tmp/ktta_notif_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} }
});

function setup() {
  const t = db.createTournament({ name: "通知検証大会", date: "2099-05-04", venue: "架空会場" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 500 }] });
  const r = db.createTeamEntry(t.id, {
    team_name: "通知クラブ", contact_name: "連絡 太郎", contact_tel: "0154-00-0000", contact_email: "tsuuchi@example.invalid",
    entries: [{ event: "男子シングルス", type: "singles", name: "通知 一郎", furigana: "つうち いちろう", team: "通知クラブ" }],
  }, "op-notif-" + Math.random().toString(36).slice(2), { enforce: true });
  assert.ok(r.submission_id, JSON.stringify(r));
  return { t, r };
}
const LONG_AGO = "2000-01-01 00:00:00";

test("① 新しい申込と、申込者本人による変更が出る。本部の操作は出さない", () => {
  const { t, r } = setup();
  const view = db.getSubmissionEditView(r.submission_id, { admin: false });
  const eid = view.entries[0].entry_id;
  db.editSubmission(r.submission_id, { entries: [{ entrant_id: eid, name: "通知 二郎" }], reason: "記入ミス" }, { actor: "applicant" });
  db.editSubmission(r.submission_id, { entries: [{ entrant_id: eid, name: "通知 三郎" }], reason: "本部の直し" }, { actor: "admin" });
  const n = db.listAdminNotifications(LONG_AGO);
  const kinds = n.items.map(i => i.kind).sort();
  assert.deepStrictEqual(kinds, ["change", "entry"], "申込1件+申込者の変更1件。本部の変更は出ない: " + JSON.stringify(n.items));
  const entry = n.items.find(i => i.kind === "entry");
  assert.match(entry.detail, /通知クラブ/);
  assert.match(entry.detail, /通知検証大会/);
  assert.strictEqual(entry.tournament_id, t.id);
});

test("② 返した now を次の since にすると、同じ出来事は出ない", () => {
  setup();
  const first = db.listAdminNotifications(LONG_AGO);
  assert.ok(first.items.length >= 1);
  assert.strictEqual(db.listAdminNotifications(first.now).items.length, 0, "既読にした後は出ない");
});

test("③ 初回・不正な since は、いまから数える", () => {
  setup();
  assert.strictEqual(db.listAdminNotifications("").items.length, 0);
  assert.strictEqual(db.listAdminNotifications("not-a-date").items.length, 0);
  assert.strictEqual(db.listAdminNotifications(undefined).items.length, 0);
});

test("④ 通知に連絡先などの個人情報を載せない", () => {
  setup();
  const json = JSON.stringify(db.listAdminNotifications(LONG_AGO));
  assert.ok(!/tsuuchi@example|連絡 太郎|0154-00-0000|通知 一郎|つうち/.test(json), "連絡先・選手名・ふりがなは載せない");
});

test("要対応(メール送信失敗・控えの未送信)の件数が返る", () => {
  const { r } = setup();
  const before = db.listAdminNotifications(LONG_AGO).alerts;
  const sqlite = require("better-sqlite3")(process.env.DB_PATH);
  sqlite.prepare("INSERT OR REPLACE INTO entry_mail_jobs (submission_id, recipient, state) VALUES (?, 'admin', 'failed')").run(r.submission_id);
  assert.ok(db.listAdminNotifications(LONG_AGO).alerts.mail_failed >= before.mail_failed + 1);
});
