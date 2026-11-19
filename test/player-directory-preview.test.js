const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.DB_PATH = ":memory:";
process.env.KTTA_APP_MODE = "entry";
process.env.ADMIN_KEY = "fixture-player-directory";
const { app } = require("../server");

test("選手名鑑の見本は管理セッション限定で、キャッシュや検索の対象にならない", async t => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const req = (url, init) => fetch(base + url, init);
  for (const path of ["/players", "/players/", "/api/public/players"]) {
    assert.ok([401, 404].includes((await req(path)).status), path);
  }
  assert.doesNotMatch(await (await req("/lib/player-directory-preview.html")).text(), /管理者プレビュー・架空データ/);
  const login = await req("/api/auth/admin/session", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: process.env.ADMIN_KEY }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const preview = await req("/players/", { headers: { Cookie: cookie } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.equal(preview.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await preview.text(), /管理者プレビュー・架空データ/);
  assert.equal((await req("/shared/assets/player-directory-action.webp")).status, 200);
});
