// 申込集計モード: 閉じる入口と残す入口の回帰テスト。
//
// 守らせる不変条件:
//   ① モードは 環境変数 > 管理画面で選んだ値 > 既定 entry の順に決まる
//   ② 閉じる機能(組合せ・試合・観戦・表彰・統計・監督/審判)の API は通さない
//   ③ 申込・後日修正・シート反映・選手DBの API は通す
//   ④ 申込者が使う画面の fetch 先と、管理画面の残す操作の API がすべて通る
//   ⑤ server.js の全 API のうち申込集計モードで通るものが、下の一覧と一致する(新しい入口の持ち込みを検知)
// 実行: node --test test/app-mode.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const M = require("../app-mode");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("モードの決定順: 環境変数 > 保存値 > 既定(entry)。不正値は無視する", () => {
  assert.strictEqual(M.resolveMode(undefined, null), "entry");
  assert.strictEqual(M.resolveMode(undefined, "full"), "full");
  assert.strictEqual(M.resolveMode("entry", "full"), "entry");
  assert.strictEqual(M.resolveMode("full", "entry"), "full");
  assert.strictEqual(M.resolveMode("x", "y"), "entry");
});

test("閉じる機能の API は通さない", () => {
  const hidden = [
    ["POST", "/api/tournaments/t1/bracket/generate"], ["GET", "/api/tournaments/t1/bracket/sheet"],
    ["POST", "/api/tournaments/t1/bracket/import-xlsx"], ["DELETE", "/api/tournaments/t1/brackets"],
    ["POST", "/api/tournaments/t1/league/generate"], ["POST", "/api/tournaments/t1/kumiawase/upload"],
    ["GET", "/api/tournaments/t1/matches"], ["POST", "/api/matches/m1/finish"], ["POST", "/api/matches/m1/call"],
    ["GET", "/api/tournaments/t1/operations"], ["GET", "/api/tournaments/t1/team-rosters"],
    ["GET", "/api/tournaments/t1/podium"], ["GET", "/api/tournaments/t1/podium.xlsx"], ["GET", "/api/tournaments/t1/best8"],
    ["GET", "/api/tournaments/t1/standings.xlsx"], ["GET", "/api/tournaments/t1/match-cards.xlsx"],
    ["GET", "/api/tournaments/t1/receipts.html"], ["GET", "/api/tournaments/t1/reception.html"],
    ["GET", "/api/stats"], ["GET", "/api/public/stats"], ["GET", "/api/public/stats/breakdowns"], ["GET", "/api/public/tournaments"],
    ["GET", "/api/public/tournaments/t1"], ["GET", "/api/public/tournaments/t1/live"], ["GET", "/api/public/tournaments/t1/matches"],
    ["GET", "/api/public/tournaments/t1/ops-stream"], ["GET", "/api/public/tournaments/t1/bracket/export.xlsx"],
    ["GET", "/api/public/tournaments/t1/entrants"], ["GET", "/api/ref/state"], ["POST", "/api/ref/session"],
    ["POST", "/api/auth/coach/session"], ["POST", "/api/auth/player/session"], ["GET", "/api/coach/dashboard"],
    ["POST", "/api/push/subscribe"], ["GET", "/api/admin/coaches"], ["POST", "/api/admin/push/broadcast"],
    ["GET", "/api/players/p1/match-records"], ["POST", "/api/players/p1/achievements"], ["POST", "/api/players/p1/access-code"],
    ["PUT", "/api/tournaments/t1/entries/e1/seed"], ["PUT", "/api/tournaments/t1/entries/e1/entry-round"],
    ["DELETE", "/api/tournaments/t1/entrants"], ["POST", "/api/tournaments/t1/entrants/upload-excel"],
    ["PUT", "/api/entrants/e1/bracket-number"],
  ];
  hidden.forEach(([m, p]) => assert.strictEqual(M.isApiAllowedInEntryMode(m, p), false, m + " " + p));
});

test("申込・後日修正・シート反映・選手DBの API は通す", () => {
  const kept = [
    ["GET", "/api/app-mode"], ["GET", "/api/health"], ["GET", "/api/auth/session"], ["POST", "/api/auth/admin/session"],
    ["POST", "/api/auth/owner/session"], ["POST", "/api/auth/applicant/session"], ["PUT", "/api/owner/app-mode"],
    ["GET", "/api/tournaments"], ["POST", "/api/tournaments"], ["GET", "/api/tournaments/t1"], ["PUT", "/api/tournaments/t1"],
    ["DELETE", "/api/tournaments/t1"], ["GET", "/api/tournaments/t1/submissions"], ["GET", "/api/tournaments/t1/entry-changes"],
    ["GET", "/api/tournaments/t1/entries"], ["PUT", "/api/tournaments/t1/entries/e1/status"], ["POST", "/api/tournaments/t1/entries/e1/fix"],
    ["GET", "/api/tournaments/t1/entry-issues"], ["POST", "/api/tournaments/t1/entry-issues/bulk-fix"],
    ["GET", "/api/tournaments/t1/gas-sync"], ["POST", "/api/tournaments/t1/gas-sync/resend/s1"], ["GET", "/api/tournaments/t1/gas-sync/reconcile"],
    ["PUT", "/api/tournaments/t1/entry-settings"], ["POST", "/api/tournaments/t1/entry-settings/copy"],
    ["GET", "/api/tournaments/t1/applicants.xlsx"], ["GET", "/api/tournaments/t1/aggregation.xlsx"], ["GET", "/api/tournaments/t1/gas-stats"],
    ["GET", "/api/tournaments/t1/entry-form.html"], ["GET", "/api/tournaments/t1/entry-form-config"],
    ["POST", "/api/public/tournaments/t1/submit-team-entry"], ["POST", "/api/public/tournaments/t1/entry"], ["GET", "/api/public/open-tournaments"],
    ["POST", "/api/forms/submit"], ["GET", "/api/applicant/edit-view"], ["POST", "/api/applicant/submission"], ["GET", "/api/applicant/me"],
    ["GET", "/api/submissions/s1/edit-view"], ["PUT", "/api/submissions/s1"], ["POST", "/api/submissions/s1/sheet-resend"],
    ["GET", "/api/entrants/e1"], ["PUT", "/api/entrants/e1"], ["DELETE", "/api/entrants/e1"], ["PUT", "/api/entrants/e1/link"],
    ["GET", "/api/players"], ["PUT", "/api/players/p1"], ["POST", "/api/players/p1/merge"], ["GET", "/api/player-merge/candidates"],
    ["GET", "/api/players/p1/affiliations"], ["POST", "/api/affiliations/a1/end"], ["GET", "/api/registered-teams"],
    ["POST", "/api/admin/snapshots/restore"], ["GET", "/api/owner/db-download"],
  ];
  kept.forEach(([m, p]) => assert.strictEqual(M.isApiAllowedInEntryMode(m, p), true, m + " " + p));
});

test("公開画面: 閲覧・観戦・審判・埋込・トップは閉じ、申込と画面の部品は残す", () => {
  ["/", "/viewer", "/viewer/", "/viewer/index.html", "/viewer/live", "/viewer/live/index.html", "/ref", "/ref/", "/widget", "/widget/index.html"]
    .forEach(p => assert.strictEqual(M.isHiddenPageInEntryMode(p), true, p));
  // Express の経路は大文字小文字を区別しないので、書き方を変えてもすり抜けない
  ["/VIEWER", "/Viewer/live/", "/Ref/", "/WIDGET/"].forEach(p => assert.strictEqual(M.isHiddenPageInEntryMode(p), true, p));
  ["/entry", "/entry/t1", "/entry/status", "/forms/masters2026", "/admin", "/admin/", "/viewer/sw.js", "/viewer/manifest.webmanifest", "/shared/common.js", "/viewerx"]
    .forEach(p => assert.strictEqual(M.isHiddenPageInEntryMode(p), false, p));
});

test("申込者の画面と修正部品が呼ぶ API はすべて通る", () => {
  assert.ok(M.isApiAllowedInEntryMode("POST", "/api/public/tournaments/abc/submit-team-entry"));
  ["entry_form.js", "public/shared/submission-editor.js"].forEach(f => {
    const urls = read(f).match(/\/api\/[a-z][a-zA-Z0-9_\-/]*/g) || [];
    urls.filter(u => !u.endsWith("/")).forEach(u => {
      const concrete = u === "/api/applicant" ? "/api/applicant/me" : u;
      assert.ok(M.isApiAllowedInEntryMode("POST", concrete) || M.isApiAllowedInEntryMode("GET", concrete), f + ": " + u);
    });
  });
});

test("server.js の全 API を分類: 申込集計モードで通る入口は承認済みの一覧と一致する", () => {
  const src = read("server.js");
  const found = new Set();
  const re = /app\.(get|post|put|delete|all)\(\s*"(\/api\/[^"]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    const concrete = m[2].replace(/:[a-zA-Z]+/g, "x1");
    const method = m[1] === "all" ? "GET" : m[1].toUpperCase();
    if (M.isApiAllowedInEntryMode(method, concrete)) found.add(m[1].toUpperCase() + " " + m[2]);
  }
  const approved = JSON.parse(read("test/fixtures/app-mode-entry-routes.json"));
  assert.deepStrictEqual([...found].sort(), approved.slice().sort(),
    "申込集計モードで通る API が変わりました。意図した変更なら test/fixtures/app-mode-entry-routes.json を更新してください");
});

// ── 実サーバで通す(環境変数を外し、既定と管理画面の切替を確かめる) ──
const { spawn } = require("child_process");
const os = require("os");
test("実サーバ: 既定は申込集計モード。閉じた入口は案内され、申込→修正が通り、オーナーが元に戻せる", async (t) => {
  const PORT = 3977, BASE = `http://127.0.0.1:${PORT}`, ADMIN = "am-admin-test-key", OWNER = "am-owner-test-key";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ktta-appmode-"));
  const env = { ...process.env, PORT: String(PORT), ADMIN_KEY: ADMIN, OWNER_KEY: OWNER, DB_PATH: path.join(dir, "t.db"), SNAPSHOT_DIR: path.join(dir, "snap") };
  // _setup.js が子プロセスでも full を入れるので、NODE_OPTIONS ごと外して既定の動きを見る
  delete env.KTTA_APP_MODE;
  delete env.NODE_OPTIONS;
  const srv = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env, stdio: "ignore" });
  t.after(() => { srv.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(BASE + "/api/health")).ok; } catch (e) {}
    if (!up) await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(up, "サーバが起動する");
  const noFollow = (p) => fetch(BASE + p, { redirect: "manual" });
  const adm = { "Content-Type": "application/json", "X-Admin-Key": ADMIN };

  assert.deepStrictEqual(await fetch(BASE + "/api/app-mode").then(r => r.json()), { mode: "entry", locked: false });
  for (const p of ["/", "/viewer", "/viewer/live/?t=x", "/ref/", "/widget/", "/no-such-page"]) {
    const r = await noFollow(p);
    assert.strictEqual(r.status, 302, p);
    assert.strictEqual(r.headers.get("location"), "/entry", p);
  }
  const hidden = await fetch(BASE + "/api/public/tournaments");
  assert.strictEqual(hidden.status, 404);
  assert.strictEqual((await hidden.json()).app_mode, "entry");
  for (const p of ["/API/public/tournaments", "/Api/tournaments/x/operations"]) {
    assert.strictEqual((await fetch(BASE + p)).status, 404, p);
  }
  assert.strictEqual((await noFollow("/VIEWER/live/")).headers.get("location"), "/entry");
  assert.strictEqual((await fetch(BASE + "/admin")).status, 200, "管理画面は開ける");
  assert.strictEqual((await fetch(BASE + "/api/tournaments/x/bracket/generate", { method: "POST", headers: adm, body: "{}" })).status, 404);

  // 大会作成 → 申込 → 申込者の修正 → 本部の一覧
  const c = await fetch(BASE + "/api/tournaments", { method: "POST", headers: adm, body: JSON.stringify({ name: "モード検証大会", date: "2099-09-01", venue: "架空会場" }) }).then(r => r.json());
  assert.ok(c.id, JSON.stringify(c));
  const es = await fetch(BASE + `/api/tournaments/${c.id}/entry-settings`, { method: "PUT", headers: adm,
    body: JSON.stringify({ entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 700 }] }) });
  assert.strictEqual(es.status, 200);
  const land = await fetch(BASE + "/entry").then(r => r.text());
  assert.match(land, /モード検証大会/);
  assert.ok(land.includes(`/entry/${c.id}`));
  assert.strictEqual((await fetch(BASE + `/entry/${c.id}`)).status, 200, "申込フォームは開ける");
  const sub = await fetch(BASE + `/api/public/tournaments/${c.id}/submit-team-entry`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ team_name: "架空クラブ", contact_name: "担当 一郎", contact_tel: "0154-12-3456", contact_email: "tanto@example.com",
      entries: [{ event: "男子シングルス", type: "singles", name: "架空 太郎", team: "架空クラブ" }] }) }).then(r => r.json());
  assert.ok(sub.applicant_token, JSON.stringify(sub).slice(0, 160));
  const login = await fetch(BASE + "/api/auth/applicant/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: sub.applicant_token }) });
  const ck = { "Content-Type": "application/json", Cookie: (login.headers.get("set-cookie") || "").split(";")[0], Origin: BASE };
  const view = await fetch(BASE + "/api/applicant/edit-view", { headers: ck }).then(r => r.json());
  const saved = await fetch(BASE + "/api/applicant/submission", { method: "POST", headers: ck,
    body: JSON.stringify({ entries: [{ entrant_id: view.entries[0].entry_id, name: "架空 二郎" }], reason: "記入ミス" }) }).then(r => r.json());
  assert.ok(saved.ok, JSON.stringify(saved));
  const list = await fetch(BASE + `/api/tournaments/${c.id}/submissions`, { headers: adm }).then(r => r.json());
  assert.strictEqual(list.rows.length, 1);

  // 元に戻す: オーナーだけが切り替えられ、データはそのまま
  assert.ok([401, 403].includes((await fetch(BASE + "/api/owner/app-mode", { method: "PUT", headers: adm, body: '{"mode":"full"}' })).status), "管理者キーでは切り替えられない");
  const ownerLogin = await fetch(BASE + "/api/auth/owner/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: OWNER }) });
  assert.strictEqual(ownerLogin.status, 200);
  const own = { "Content-Type": "application/json", Cookie: (ownerLogin.headers.get("set-cookie") || "").split(";")[0], Origin: BASE };
  assert.strictEqual((await fetch(BASE + "/api/owner/app-mode", { method: "PUT", headers: own, body: '{"mode":"bad"}' })).status, 400);
  assert.strictEqual((await fetch(BASE + "/api/owner/app-mode", { method: "PUT", headers: own, body: '{"mode":"full"}' })).status, 200);
  assert.strictEqual((await noFollow("/viewer")).status, 200, "通常モードでは閲覧画面に戻る");
  assert.strictEqual((await noFollow("/entry")).headers.get("location"), "/viewer");
  const pub = await fetch(BASE + "/api/public/tournaments");
  assert.strictEqual(pub.status, 200);
  assert.strictEqual((await fetch(BASE + `/api/tournaments/${c.id}/submissions`, { headers: adm }).then(r => r.json())).rows.length, 1, "申込は消えていない");
});
