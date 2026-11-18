const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.NODE_ENV = "production";
process.env.KTTA_APP_MODE = "entry";
process.env.DB_PATH = ":memory:";
process.env.ADMIN_KEY = "test-admin-key";
process.env.OWNER_KEY = "test-owner-key";
process.env.PUBLIC_BASE_URL = "https://accounts.example.invalid";

const db = require("../db");
const mailer = require("../mailer");
const { app } = require("../server");
const { validPassword } = require("../lib/operator-accounts");

test("パスワードは6文字以上で英字・数字・記号をそれぞれ含む", () => {
  for (const ok of ["Abc12!", "kushiro#1", "P@ss9word", "a1-b2c3"]) assert.equal(validPassword(ok), true, ok);
  for (const ng of ["Ab1!", "abcdef", "abc123", "abc!!!", "123!!!", "", "a1!".repeat(50)]) assert.equal(validPassword(ng), false, ng);
});

test("本人がパスワード再設定メールを受け取り、オーナーなしで設定し直せる", async t => {
  const emails = [];
  t.mock.method(mailer, "isEnabled", () => true);
  t.mock.method(mailer, "sendOperatorInvite", async (to, link) => { emails.push({ kind: "invite", to, link }); });
  t.mock.method(mailer, "sendOperatorReset", async (to, link) => { emails.push({ kind: "reset", to, link }); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const origin = process.env.PUBLIC_BASE_URL;
  const post = (url, body, from = origin) => fetch(base + url, {
    method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const until = async cond => { for (let i = 0; i < 50 && !cond(); i++) await new Promise(r => setTimeout(r, 20)); };
  const tokenOf = mail => new URL(mail.link).hash.split("=")[1];
  const email = "reset@example.invalid";
  const first = "First-pw1";
  const owner = (await post("/api/auth/owner/session", { key: process.env.OWNER_KEY })).headers.get("set-cookie").split(";")[0];
  await fetch(base + "/api/owner/operators/invite", { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: owner }, body: JSON.stringify({ email }) });
  // 規則に合わないパスワードは設定できない
  const weak = await post("/api/auth/admin/activate", { token: tokenOf(emails[0]), password: "abcdef" });
  assert.equal(weak.status, 400);
  assert.match((await weak.json()).error, /6文字以上/);
  assert.equal((await post("/api/auth/admin/activate", { token: tokenOf(emails[0]), password: first })).status, 200);
  const reset = body => post("/api/auth/admin/password-reset", body);
  // 別サイトからは受け付けない・形式不正は400
  assert.equal((await post("/api/auth/admin/password-reset", { email }, "https://other.example.invalid")).status, 403);
  assert.equal((await reset({ email: "not-an-address" })).status, 400);
  // 未登録でも登録済みでも同じ応答。未登録には送らない
  const unknown = await reset({ email: "nobody@example.invalid" });
  const known = await reset({ email: "Reset@EXAMPLE.invalid" });
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), await known.json());
  await until(() => emails.some(m => m.kind === "reset"));
  const resets = emails.filter(m => m.kind === "reset");
  assert.equal(resets.length, 1);
  assert.equal(resets[0].to, email);
  assert.equal(new URL(resets[0].link).origin, origin);
  // 申込だけでは締め出されない(今のパスワードは使える)
  assert.equal((await post("/api/auth/admin/password", { email, password: first })).status, 200);
  // リンクから新しいパスワードを設定 → 古いパスワードは使えない・リンクは1回限り
  const second = "Second-pw2";
  assert.equal((await post("/api/auth/admin/activate", { token: tokenOf(resets[0]), password: second })).status, 200);
  assert.equal((await post("/api/auth/admin/activate", { token: tokenOf(resets[0]), password: second })).status, 400);
  assert.equal((await post("/api/auth/admin/password", { email, password: first })).status, 401);
  assert.equal((await post("/api/auth/admin/password", { email, password: second })).status, 200);
  // 監査ログに担当コードで残し、メールアドレスは残さない
  assert.ok(db.getOwnerAudit(20).some(e => /^運営アカウント:パスワード再設定メール acct-[0-9a-f]{8}$/.test(e.action)));
  assert.ok(!JSON.stringify(db.getOwnerAudit(50)).includes(email));
  // 停止したアカウントには送らない
  const id = db.operatorAccounts.list().find(a => a.email === email).id;
  db.operatorAccounts.disable(id);
  assert.equal((await reset({ email })).status, 200);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(emails.filter(m => m.kind === "reset").length, 1);
  // 回数制限(同じアドレス宛て1時間3回・同じIPから15分5回)を超えると断る
  assert.equal((await reset({ email })).status, 200);
  assert.equal((await reset({ email })).status, 429);
});

test("再設定リンクは1時間で切れ、未設定・停止のアカウントには発行しない", t => {
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  const address = "unit-reset@example.invalid";
  const invite = db.operatorAccounts.issue(address);
  assert.equal(db.operatorAccounts.issueReset(address), null);   // まだパスワード未設定
  db.operatorAccounts.cancelInvite(invite.token);
  assert.equal(db.operatorAccounts.issueReset("none@example.invalid"), null);
  return (async () => {
    const again = db.operatorAccounts.issue(address);
    assert.ok((await db.operatorAccounts.accept(again.token, "Unit-pw1")).id);
    const r = db.operatorAccounts.issueReset(address);
    assert.ok(r && r.token);
    clock.mock.mockImplementation(() => now + 60 * 60 * 1000 + 1);
    assert.deepEqual(await db.operatorAccounts.accept(r.token, "Unit-pw2"), {});
  })();
});
