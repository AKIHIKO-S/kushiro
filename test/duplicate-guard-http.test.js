// 二重申込の防止のHTTP経路の回帰テスト(サーバーを起動するので、待ち受けできる環境(CI)で動く)。
//
// 守らせる不変条件:
//   ① 同じ団体・同じ申込者の再送信は400。同名団体でも申込者が違えば通る
//   ② 公開の確認APIは、チケットが無いと使えず、返すのは { duplicate: true|false } だけ(団体名・件数・申込番号を含まない)
//   ③ 自分の申込を直している最中の確認(申込番号で入った本人)は、自分の出場を数えず、他の申込の出場は数える
// 実行: node --test test/duplicate-guard-http.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.DB_PATH = ":memory:";
process.env.KTTA_APP_MODE = "entry";
process.env.ADMIN_KEY = "fixture-dup-guard";

const db = require("../db");
const { app } = require("../server");

test("再送信の拒否・確認APIの出力・本人の自己除外", async t => {
  const tour = db.createTournament({ name: "架空大会", date: "2099-05-01" });
  const M = "一般男子シングルス", F = "一般女子シングルス";
  db.updateEntrySettings(tour.id, { entries_open: 1, event_config: [{ name: M, type: "singles", fee: 500 }, { name: F, type: "singles", fee: 500 }] });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = (path, body, headers = {}) => fetch(base + path, {
    method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
  });
  const submit = (team, contact, event, name, op) => call(`/api/public/tournaments/${tour.id}/submit-team-entry`, {
    team_name: team, contact_name: contact, contact_tel: "000-0000-0000", contact_email: "a@example.invalid",
    entries: [{ event, name, furigana: "かくう " + op, team }],
  }, { "X-Op-Id": "dup-http-" + op });

  const first = await submit("架空クラブ", "検証 担当", M, "架空 太郎", "1");
  assert.equal(first.status, 201);
  const token = (await first.json()).applicant_token;
  assert.ok(token);
  const again = await submit("架空　クラブ", "検証　担当", F, "架空 花子", "2");
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /この団体・申込者の申込は既にあります/);
  assert.equal((await submit("架空クラブ", "別の 担当", F, "架空 花子", "3")).status, 201, "申込者が違えば通る");

  // ② 確認API
  const url = `/api/public/tournaments/${tour.id}/check-duplicate`;
  assert.equal((await call(url, { event: M, name: "架空 太郎" })).status, 401, "チケットが無ければ使えない");
  const ticket = (await (await call(`/api/public/tournaments/${tour.id}/suggest-ticket`, {})).json()).ticket;
  const h = { "X-Suggest-Ticket": ticket };
  const hit = await (await call(url, { event: M, name: "架空 太郎" }, h)).json();
  assert.deepEqual(hit, { duplicate: true });
  assert.deepEqual(await (await call(url, { event: F, name: "架空 太郎" }, h)).json(), { duplicate: false }, "別種目はなし");
  assert.ok(!JSON.stringify(hit).includes("架空クラブ"), "団体名を含まない");

  // ③ 申込番号で入った本人
  const ses = await call("/api/auth/applicant/session", { token });
  assert.equal(ses.status, 200);
  const cookie = ses.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const mine = await call("/api/applicant/check-duplicate", { event: M, name: "架空 太郎" }, { Cookie: cookie, Origin: base });
  assert.deepEqual(await mine.json(), { duplicate: false }, "自分の出場は数えない");
  const others = await call("/api/applicant/check-duplicate", { event: F, name: "架空 花子" }, { Cookie: cookie, Origin: base });
  assert.deepEqual(await others.json(), { duplicate: true }, "他の申込の出場は数える");
});
