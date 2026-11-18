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
  // 右上の表示用: メールのアカウントはメールアドレス、管理キーは操作担当コード、オーナーは役割が分かる
  const who = async cookie => (await request("/api/auth/session", { cookie })).json();
  assert.deepEqual(
    (({ authenticated, principal_type, kind, label }) => ({ authenticated, principal_type, kind, label }))(await who(replaced)),
    { authenticated: true, principal_type: "admin", kind: "account", label: email });
  assert.equal((await who(legacy)).kind, "key");
  assert.equal((await who(owner)).principal_type, "owner");
  assert.deepEqual(await who(""), { authenticated: false });
  // メール設定の値(送信サーバー・アカウント等)は画面へ返さない
  const mail = await (await request("/api/mail/status", { cookie: legacy })).json();
  assert.deepEqual(Object.keys(mail).sort(), ["enabled", "notify_configured"]);
  // 動作状況(診断)はオーナーだけ
  assert.equal((await request("/api/diagnostics", { cookie: legacy })).status, 401);
  assert.equal((await request("/api/diagnostics", { cookie: owner })).status, 200);
  // 個人情報を含む書き出しは、日時と担当コードだけを監査ログに残す(メールアドレスは残さない)
  assert.equal((await post("/api/admin/export-log", { kind: "nope" }, legacy)).status, 400);
  assert.equal((await post("/api/admin/export-log", { kind: "players_csv" })).status, 401);
  assert.equal((await post("/api/admin/export-log", { kind: "players_csv" }, replaced)).status, 200);
  const exportLog = db.getOwnerAudit(5).find(e => e.action === "書き出し:選手CSV");
  assert.ok(exportLog && /^acct-[0-9a-f]{8}$/.test(exportLog.operator));
  assert.ok(!JSON.stringify(db.getOwnerAudit(50)).includes(email));
  assert.equal((await request("/api/auth/session", { method: "DELETE", cookie: replaced })).status, 200);
  assert.equal((await request("/api/tournaments", { cookie: replaced })).status, 401);
  const last = getCookie(await login(newPassword));
  assert.equal((await post("/api/owner/operators/" + principal.principal_id + "/disable", {}, owner)).status, 200);
  assert.equal((await request("/api/tournaments", { cookie: last })).status, 401);
  assert.equal((await login(newPassword)).status, 401);
  const listing = await request("/api/owner/operators", { cookie: owner });
  assert.equal(listing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listing.json(), { accounts: [{ id: principal.principal_id, email, status: "disabled", owner: false }] });
});

test("オーナー権限の付与はキー保持者だけ・上限つき・剥奪と停止は即時に効く", async t => {
  const emails = [];
  t.mock.method(mailer, "isEnabled", () => true);
  t.mock.method(mailer, "sendOperatorInvite", async (to, link) => { emails.push({ to, link }); });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const origin = process.env.PUBLIC_BASE_URL;
  const request = (url, { method = "GET", body, cookie } = {}) => fetch(base + url, {
    method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie && { Cookie: cookie }) },
    body: body && JSON.stringify(body),
  });
  const post = (url, body, cookie) => request(url, { method: "POST", body, cookie });
  const getCookie = r => r.headers.get("set-cookie").split(";")[0];
  const owner = getCookie(await post("/api/auth/owner/session", { key: process.env.OWNER_KEY, operator: "keyholder" }));
  const legacy = getCookie(await post("/api/auth/admin/session", { key: process.env.ADMIN_KEY }));
  const password = "fixture owner grant password";
  // 3アカウントを利用中にする
  const accounts = [];
  for (const address of ["grant-a@example.invalid", "grant-b@example.invalid", "grant-c@example.invalid"]) {
    assert.equal((await post("/api/owner/operators/invite", { email: address }, owner)).status, 201);
    const token = new URL(emails.at(-1).link).hash.split("=")[1];
    assert.equal((await post("/api/auth/admin/activate", { token, password })).status, 200);
    const r = await post("/api/auth/admin/password", { email: address, password });
    accounts.push({ address, id: (await r.clone().json()).principal_id, cookie: getCookie(r) });
  }
  const [a, b, c] = accounts;
  const grant = (id, granted, cookie) => post("/api/owner/operators/" + id + "/owner", { granted }, cookie);
  // オーナー操作の失敗は同じIPで数えて一時ロックする(401→429)。どちらも「拒否」として扱う。
  const refused = async r => assert.ok([401, 429].includes((await r).status));
  // 付与前: メールのアカウントはオーナー操作に入れない
  await refused(request("/api/owner/verify", { cookie: a.cookie }));
  // 付与はキー保持者だけ(管理キー・権限なしアカウントは不可)
  await refused(grant(a.id, true, legacy));
  await refused(grant(a.id, true, a.cookie));
  assert.equal((await grant(a.id, "yes", owner)).status, 400);
  assert.equal((await grant(a.id, true, owner)).status, 200);
  // 付与後: ログイン中の同じ端末が、キー入力なしでオーナー操作に入れる
  assert.equal((await request("/api/owner/verify", { cookie: a.cookie })).status, 200);
  assert.equal((await request("/api/owner/operators", { cookie: a.cookie })).status, 200);
  assert.equal((await request("/api/diagnostics", { cookie: a.cookie })).status, 200);
  assert.equal((await request("/api/tournaments", { cookie: a.cookie })).status, 200);
  const who = await (await request("/api/auth/session", { cookie: a.cookie })).json();
  assert.equal(who.principal_type, "owner");
  assert.equal(who.kind, "account");
  // 付与されたアカウントは、別アカウントへ権限を広げられない・オーナー仲間を停止できない
  assert.equal((await grant(b.id, true, a.cookie)).status, 403);
  assert.equal((await grant(a.id, false, a.cookie)).status, 403);
  // 上限: 2アカウントまで
  assert.equal((await grant(b.id, true, owner)).status, 200);
  assert.equal((await post("/api/owner/operators/" + a.id + "/disable", {}, b.cookie)).status, 403);
  const over = await grant(c.id, true, owner);
  assert.equal(over.status, 409);
  assert.match((await over.json()).error, /2 アカウントまで/);
  // 権限なしのアカウントの停止は、付与されたアカウントでもできる(運営アカウント管理)
  assert.equal((await post("/api/owner/operators/" + c.id + "/disable", {}, a.cookie)).status, 200);
  assert.equal((await request("/api/tournaments", { cookie: c.cookie })).status, 401);
  // 停止中・未設定のアカウントには付けられない
  assert.equal((await grant(c.id, true, owner)).status, 409);
  assert.equal((await grant("missing", true, owner)).status, 404);
  // 剥奪はログイン中の端末に次の通信から効く(運営権限には残る)
  assert.equal((await grant(b.id, false, owner)).status, 200);
  await refused(request("/api/owner/verify", { cookie: b.cookie }));
  assert.equal((await request("/api/tournaments", { cookie: b.cookie })).status, 200);
  // 停止はオーナー権限ごと即時に無効。再招待しても権限は戻らない
  assert.equal((await post("/api/owner/operators/" + a.id + "/disable", {}, owner)).status, 200);
  await refused(request("/api/owner/verify", { cookie: a.cookie }));
  assert.equal(db.operatorAccounts.isOwner(a.id), false);
  const listed = (await (await request("/api/owner/operators", { cookie: owner })).json()).accounts;
  assert.ok(listed.every(x => x.owner === false));
  // 監査ログ: 付与・解除・停止を担当コードで残し、メールアドレスは残さない
  const log = db.getOwnerAudit(100);
  const code = id => "acct-" + id.slice(0, 8);
  assert.ok(log.some(e => e.action === "運営アカウント:オーナー権限を付与 " + code(a.id) && e.operator === "keyholder"));
  assert.ok(log.some(e => e.action === "運営アカウント:オーナー権限を解除 " + code(b.id)));
  assert.ok(log.some(e => e.action === "運営アカウント:停止 " + code(c.id) && e.operator === code(a.id)));
  assert.ok(!JSON.stringify(log).includes("@example.invalid"));
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
