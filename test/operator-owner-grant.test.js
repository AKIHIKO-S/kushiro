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
  const password = "Grant-pass3";
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
