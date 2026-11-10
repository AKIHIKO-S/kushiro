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

test("運営アカウントの招待・ログイン・再設定・停止を本番設定で検証する", async t => {
  const emails = [];
  t.mock.method(mailer, "isEnabled", () => true);
  t.mock.method(mailer, "sendOperatorInvite", async (to, link) => { emails.push({ to, link }); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const origin = process.env.PUBLIC_BASE_URL;
  const request = (url, { method = "GET", body, cookie, from = origin } = {}) => fetch(base + url, {
    method, headers: { Origin: from, "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) },
    body: body && JSON.stringify(body),
  });
  const post = (url, body, cookie) => request(url, { method: "POST", body, cookie });
  const getCookie = r => r.headers.get("set-cookie").split(";")[0];
  const owner = getCookie(await post("/api/auth/owner/session", { key: process.env.OWNER_KEY }));
  const legacy = getCookie(await post("/api/auth/admin/session", { key: process.env.ADMIN_KEY }));
  const email = "staff@example.invalid";
  const password = "fixture first password";
  const newPassword = "fixture replacement password";
  const invitePath = "/api/owner/operators/invite";
  const loginPath = "/api/auth/admin/password";
  const activatePath = "/api/auth/admin/activate";
  const login = (password, address = email) => post(loginPath, { email: address, password });
  const inviteToken = () => new URL(emails.at(-1).link).hash.split("=")[1];
  assert.equal((await post(invitePath, { email }, legacy)).status, 401);
  assert.equal((await request(invitePath, { method: "POST", body: { email }, cookie: owner, from: "https://other.example.invalid" })).status, 403);
  assert.equal(emails.length, 0);
  const invited = await post(invitePath, { email: "Staff@EXAMPLE.invalid " }, owner);
  assert.equal(invited.status, 201);
  assert.deepEqual(await invited.json(), { ok: true });
  assert.equal(emails[0].to, email);
  assert.equal(new URL(emails[0].link).origin, origin);
  assert.equal(new URL(emails[0].link).pathname, "/admin/");
  const token = inviteToken();
  assert.equal((await post(activatePath, { token, password: "short" })).status, 400);
  assert.equal((await post(activatePath, { token, password })).status, 200);
  assert.equal((await post(activatePath, { token, password })).status, 400);
  const denied = await login("wrong");
  const unknown = await login("wrong", "nobody@example.invalid");
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), await unknown.json());

  const loggedIn = await login(password, "Staff@EXAMPLE.invalid");
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Strict/);
  const staff = getCookie(loggedIn);
  const principal = await loggedIn.json();
  assert.equal(principal.principal_type, "admin");
  assert.notEqual(principal.principal_id, email);
  assert.equal((await request("/api/tournaments", { cookie: staff })).status, 200);
  assert.equal((await request("/api/owner/operators", { cookie: staff })).status, 401);
  assert.equal((await request("/api/owner/db-download", { cookie: staff })).status, 401);

  assert.equal((await post(invitePath, { email }, owner)).status, 201);
  assert.equal((await post(activatePath, { token: inviteToken(), password: newPassword })).status, 200);
  assert.equal((await request("/api/tournaments", { cookie: staff })).status, 401);
  assert.equal((await login(password)).status, 401);
  const replaced = getCookie(await login(newPassword));
  assert.equal((await request("/api/auth/session", { method: "DELETE", cookie: replaced })).status, 200);
  assert.equal((await request("/api/tournaments", { cookie: replaced })).status, 401);
  const last = getCookie(await login(newPassword));
  assert.equal((await post("/api/owner/operators/" + principal.principal_id + "/disable", {}, owner)).status, 200);
  assert.equal((await request("/api/tournaments", { cookie: last })).status, 401);
  assert.equal((await login(newPassword)).status, 401);
  const listing = await request("/api/owner/operators", { cookie: owner });
  assert.equal(listing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listing.json(), { accounts: [{ id: principal.principal_id, email, status: "disabled" }] });
});

test("招待の再発行・期限切れ・送信失敗で古いリンクが残らない", async t => {
  const address = "expiry@example.invalid";
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now);
  const first = db.operatorAccounts.issue(address);
  const second = db.operatorAccounts.issue(address);
  assert.deepEqual(await db.operatorAccounts.accept(first.token, "test password long"), {});
  db.operatorAccounts.cancelInvite(second.token);
  assert.deepEqual(await db.operatorAccounts.accept(second.token, "test password long"), {});
  const expired = db.operatorAccounts.issue(address);
  clock.mock.mockImplementation(() => now + 24 * 60 * 60 * 1000);
  assert.deepEqual(await db.operatorAccounts.accept(expired.token, "test password long"), {});
});
