// 申込PIIの保持期間・削除の回帰。申込原本(entry_submissions)と紐づく entrants の連絡先を、
// 削除依頼(deleteSubmissionPII)・保持期間超過(purgeOldSubmissionPII)で匿名化できること。
// 実行: node --test test/pii-retention.test.js
process.env.DB_PATH = "/tmp/ktta_pii_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const EV = "男子シングルス";
let _seq = 0;
function setupWithEntry(date, contact) {
  const t = db.createTournament({ name: "PII" + (++_seq), date });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  db.createTeamEntry(t.id, Object.assign({
    team_name: "X", entries: [{ event: EV, type: "singles", name: "選手 一", team: "X" }],
  }, contact));
  return t;
}
const contacts = (t) => db.getEntries(t.id).map(e => [e.contact_name, e.contact_email, e.contact_tel].join("|"));

test("purgeOldSubmissionPII: 大会終了からN日超過の連絡先を匿名化(entrants含む)", () => {
  const t = setupWithEntry("2020-01-01", { contact_name: "保護者太郎", contact_email: "parent@example.com", contact_tel: "090-1234-5678" });
  assert.ok(db.getEntries(t.id).some(e => e.contact_email === "parent@example.com"), "purge前: 連絡先あり");
  const r = db.purgeOldSubmissionPII(30);
  assert.ok(r.ok && r.purged >= 1, "purge実行: " + JSON.stringify(r));
  assert.ok(db.getEntries(t.id).every(e => !e.contact_email && !e.contact_tel && !e.contact_name), "purge後: 連絡先が匿名化");
});

test("purgeOldSubmissionPII: 保持期間内(最近の大会)は匿名化しない", () => {
  const today = new Date().toISOString().slice(0, 10);
  const t = setupWithEntry(today, { contact_email: "recent@example.com" });
  db.purgeOldSubmissionPII(30);
  assert.ok(db.getEntries(t.id).some(e => e.contact_email === "recent@example.com"), "保持期間内は連絡先を残す");
});

test("purgeOldSubmissionPII: retentionDays=0/未指定は無効(no-op・自動破壊しない)", () => {
  const t = setupWithEntry("2020-01-01", { contact_email: "keep@example.com" });
  const r = db.purgeOldSubmissionPII(0);
  assert.ok(r.skipped, "0は no-op");
  assert.ok(db.getEntries(t.id).some(e => e.contact_email === "keep@example.com"), "no-op時は残る");
});
