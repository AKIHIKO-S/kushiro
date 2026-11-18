const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.DB_PATH = ":memory:";
process.env.KTTA_APP_MODE = "entry";
process.env.ADMIN_KEY = "fixture-entry-mail";
process.env.SMTP_USER = "sender@example.invalid";
process.env.SMTP_PASS = "fixture-only";
process.env.ADMIN_EMAIL = "office@example.invalid";
process.env.PUBLIC_BASE_URL = "https://platform.example.invalid";

const nodemailer = require("nodemailer");
const db = require("../db");
const { app, __test__ } = require("../server");

test("申込保存・集計とメールを分離し、失敗した運営通知だけを再送する", async t => {
  const mail = [];
  let failAdmin = true;
  let releaseApplicant;
  const gate = new Promise(resolve => { releaseApplicant = resolve; });
  t.after(releaseApplicant);
  t.mock.method(nodemailer, "createTransport", options => {
    assert.equal(options.host, "smtp.gmail.com");
    return { sendMail: async message => {
      mail.push(message);
      if (message.to.address === "club@example.invalid") await gate;
      if (message.to === "office@example.invalid" && failAdmin) throw new Error("fixture unavailable");
      return { messageId: "<fixture>", accepted: [message.to.address || message.to] };
    } };
  });

  const tournament = db.createTournament({ name: "架空大会", date: "2099-05-01" });
  const event = "中学男子シングルス";
  db.updateEntrySettings(tournament.id, { entries_open: 1, event_config: [{ name: event, type: "singles", fee: 500 }],
    field_config: { fields: { grade: "required" }, custom: [{ key: "school", label: "学校名", scope: "player" }] } });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (path, body, headers = {}) => fetch(base + path, {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const url = `/api/public/tournaments/${tournament.id}/submit-team-entry`;
  const form = { team_name: "架空クラブ", contact_name: "検証担当", contact_tel: "000-0000-0000", contact_email: "club@example.invalid",
    entries: [{ event, name: "検証 選手", team: "架空クラブ", extra_json: { grade: "中2", birth_date: "2085-04-10", answers: { school: "架空中学" } } }] };
  assert.equal((await request(url, { ...form, contact_email: "club@example.invalid,other@example.invalid" })).status, 400);
  const res = await request(url, form, { "X-Op-Id": "fixture-1" });
  assert.equal(res.status, 201);
  const receipt = await res.json();
  assert.ok(receipt.applicant_token);
  assert.equal(receipt.mail.queued, true);
  assert.equal(db.getEntryDesk(tournament.id).totals.entries, 1);
  assert.equal(db.getEntryDesk(tournament.id).events[0].count, 1);
  assert.equal((await request(url, form, { "X-Op-Id": "fixture-1" })).status, 201);
  assert.equal(mail.length, 2);
  for (const message of mail) {
    assert.match(message.text, /中学男子シングルス.*検証 選手/);
    assert.match(message.text, /学年: 中2.*学校名: 架空中学/);
    assert.doesNotMatch(message.text, /2085-04-10/);
    assert.match(message.text, /https:\/\/forms\.gle\/CSP5RwciRL7GFALM6/);
    assert.match(message.text, /Mail：kushirotta@gmail\.com\nURL：https:\/\/www\.kushirotta\.jp\//);
  }
  const applicant = mail.find(m => m.to.address);
  assert.match(applicant.html, /href="mailto:kushirotta@gmail\.com"/);
  assert.match(applicant.html, /href="https:\/\/forms\.gle\/CSP5RwciRL7GFALM6"/);
  const mailCode = applicant.text.match(/申込番号: ([A-Z0-9-]+)/)[1];
  assert.equal(db.resolveSubmissionToken(mailCode).id, receipt.submission_id);
  assert.match(applicant.text, /platform\.example\.invalid\/entry\/status\?tournament=/);
  assert.doesNotMatch(mail.find(m => typeof m.to === "string").text, /申込番号:/);
  releaseApplicant();
  await new Promise(resolve => setImmediate(resolve));
  let row = db.getEntryDesk(tournament.id).rows[0];
  assert.equal(row.mail.find(m => m.recipient === "applicant").state, "sent");
  assert.equal(row.issues.find(i => i.type === "mail").recipient, "admin");

  const retry = `/api/submissions/${receipt.submission_id}/mail-resend`;
  assert.equal((await request(retry, { recipient: "admin" })).status, 401);
  failAdmin = false;
  assert.equal((await request(retry, { recipient: "admin" }, { "X-Admin-Key": process.env.ADMIN_KEY })).status, 202);
  await __test__.deliverEntryMail();
  row = db.getEntryDesk(tournament.id).rows[0];
  assert.equal(row.mail.find(m => m.recipient === "admin").state, "sent");
  assert.equal(mail.length, 3);
  assert.equal(db.getEntryDesk(tournament.id).totals.entries, 1);
});

test("処理途中に止まったメールだけリース期限後に取り直せる", () => {
  const tournament = db.createTournament({ name: "送信保留の検証", date: "2099-06-01" });
  const event = "男子シングルス";
  db.updateEntrySettings(tournament.id, { entries_open: 1, event_config: [{ name: event, type: "singles" }] });
  const r = db.createTeamEntry(tournament.id, { team_name: "架空クラブ", contact_email: "club@example.invalid",
    entries: [{ event, name: "検証 保留", team: "架空クラブ" }] }, "lease-fixture", { queue_mail: true });
  assert.ok(r.submission_id);
  const jobs = db.claimEntryMail(r.submission_id, 10);
  assert.equal(jobs.length, 2);
  db.finishEntryMail(jobs.find(j => j.recipient === "applicant"), true, 11);
  assert.equal(db.claimEntryMail(r.submission_id, 12).length, 0);
  const recovered = db.claimEntryMail(r.submission_id, 300011);
  assert.deepEqual(recovered.map(j => [j.recipient, j.attempts]), [["admin", 2]]);
});
