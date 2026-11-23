// モード切替(申込集計 / 大会運営)の権限の回帰テスト。
// 守らせる不変条件:
//   ① 切替APIは、オーナー権限(オーナーキー)だけが通る。一般の運営(管理キー)は拒否される
//   ② 管理画面は、オーナー権限でないアカウントには切替ボタンを出さない
// 実行: node --test test/mode-switch-auth.test.js(①は待ち受けできる環境=CIで動く)
process.env.DB_PATH = ":memory:";
delete process.env.KTTA_APP_MODE;
process.env.ADMIN_KEY = "fixture-admin-key";
process.env.OWNER_KEY = "fixture-owner-key";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("fs");
const path = require("path");

test("② 切替ボタンはオーナー権限のときだけ作る", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "admin", "index.html"), "utf8");
  assert.ok(/if \(!\(A\.session && A\.session\.owner\)\) \{ box\.hidden = true; return box; \}/.test(html));
  assert.ok(html.includes("A.renderModeSwitch();   // 権限が分かったので"), "権限が分かった時点で表示を作り直す");
});

test("① 切替APIはオーナーだけ(一般の運営は拒否)", async t => {
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(r => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const put = (headers) => fetch(base + "/api/app-mode", { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ mode: "full" }), signal: AbortSignal.timeout(5000) });
  const asAdmin = await put({ "X-Admin-Key": process.env.ADMIN_KEY });
  assert.ok([401, 403].includes(asAdmin.status), "管理キーでは切り替えられない: " + asAdmin.status);
  const none = await put({});
  assert.ok([401, 403].includes(none.status), "未ログインも不可: " + none.status);
  const asOwner = await put({ "X-Owner-Key": process.env.OWNER_KEY });
  assert.equal(asOwner.status, 200);
  assert.deepEqual(await asOwner.json(), { mode: "full" });
});
