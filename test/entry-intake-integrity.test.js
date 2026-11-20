const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { Script } = require("node:vm");
const XLSX = require("xlsx-js-style");

process.env.DB_PATH = ":memory:";
process.env.KTTA_APP_MODE = "entry";
process.env.ADMIN_KEY = "entry-test-fixture";
const db = require("../db");
const reports = require("../reports");
const { app } = require("../server");

const EVENT = "男子シングルス";
const entrant = name => ({ event: EVENT, type: "singles", name, team: "架空クラブ" });
const form = entries => ({ team_name: "架空クラブ", contact_name: "検証担当",
  contact_tel: "000-0000-0000", contact_email: "test@example.invalid", entries });
const desks = id => `/api/tournaments/${id}/desk`;
const exportPath = id => `/api/tournaments/${id}/aggregation.xlsx`;
const sheetRows = (book, name) => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 });

function tournament(name, settings = {}) {
  const t = db.createTournament({ name, date: "2099-05-04" });
  db.updateEntrySettings(t.id, { entries_open: 1,
    event_config: [{ name: EVENT, type: "singles", fee: 500 }], ...settings });
  return t;
}

test("両モードで日本時間の翌日0時に終了し、公開一覧・台帳・送信が揃う", t => {
  const item = tournament("日付境界", { entry_deadline: "2099-04-30", entry_deadline_time: "17:00" });
  const originalMode = process.env.KTTA_APP_MODE;
  t.after(() => { process.env.KTTA_APP_MODE = originalMode; });
  const clock = t.mock.method(Date, "now", () => 0);
  for (const mode of ["entry", "full"]) {
    process.env.KTTA_APP_MODE = mode;
    clock.mock.mockImplementation(() => Date.parse("2099-04-30T14:59:59Z"));
    assert.equal(db.entryDeadlineLabel(db.getTournament(item.id)), "2099-04-30");
    assert.ok(db.getOpenTournaments().some(x => x.id === item.id));
    assert.equal(db.getEntryCapacityState(item.id).closed, false);
    assert.equal(db.getEntryDesk(item.id).tournament.state, "open");
    assert.ok(db.createTeamEntry(item.id, form([entrant(`検証 締切前 ${mode}`)])).submission_id);
    clock.mock.mockImplementation(() => Date.parse("2099-04-30T15:00:00Z"));
    assert.equal(db.getEntryCapacityState(item.id).closed, true);
    assert.equal(db.getEntryDesk(item.id).tournament.state, "closed");
    assert.ok(!db.getOpenTournaments().some(x => x.id === item.id));
    assert.match(db.createTeamEntry(item.id, form([entrant("検証 締切後")])).error, /締切/);
  }
});

test("受付・本部登録・本人修正・確定件数を実HTTPで検証する", async t => {
  const fetchLocal = global.fetch;
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { "X-Admin-Key": process.env.ADMIN_KEY };
  const request = (url, method = "GET", data, headers) => fetchLocal(base + url, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const a = tournament("架空大会A");
  const b = tournament("架空大会B");
  const formHtml = await (await request("/entry/" + a.id)).text();
  const inlineScripts = [...formHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(inlineScripts.some(x => x[1].includes("async function submitForm")));
  for (const [, source] of inlineScripts) assert.doesNotThrow(() => new Script(source));
  const submit = (id, entries, opId) => request(`/api/public/tournaments/${id}/submit-team-entry`, "POST",
    { ...form(entries), tournament_id: "偽の大会", action: "update" }, { "X-Op-Id": opId, Origin: base });
  assert.equal((await request(`/api/public/tournaments/${a.id}/submit-team-entry`, "POST",
    form([entrant("検証 外部")]), { Origin: "https://unexpected.example.invalid" })).status, 403);
  const first = await submit(a.id, [entrant("検証 甲")], "same-request-id");
  assert.equal(first.status, 201);
  const subA = await first.json();
  const subB = await (await submit(b.id, [entrant("検証 乙")], "same-request-id")).json();
  assert.ok(subA.applicant_token && subB.applicant_token);
  assert.notEqual(subA.submission_id, subB.submission_id, "同じ申込IDでも別の大会なら別の申込になる");

  assert.equal((await submit(a.id, [entrant("検証 甲"), entrant("検証 追加")], "mixed-duplicate")).status, 400);
  assert.equal(db.getEntrants(a.id).length, 1);
  const auth = token => ({ token, tournament_id: a.id });
  assert.equal((await request("/api/auth/applicant/session", "POST", auth(subB.applicant_token))).status, 404);
  const login = await request("/api/auth/applicant/session", "POST", auth(subA.applicant_token));
  assert.equal(login.status, 200);
  const applicant = { Cookie: login.headers.get("set-cookie").split(";")[0], Origin: base };
  const previous = await (await request("/api/applicant/edit-view", "GET", undefined, applicant)).json();
  assert.equal(previous.entries.length, 1);
  const updated = await (await request("/api/applicant/submission", "POST", {
    add: [entrant("検証 追加")], entries: [{ entrant_id: previous.entries[0].entry_id, name: "検証 修正" }],
  }, applicant)).json();
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.view.entries.length, 2);
  assert.equal(updated.view.submission.id, subA.submission_id);

  db.updateEntrySettings(a.id, { entries_open: 1, entry_deadline: "2000-01-01" });
  assert.equal((await submit(a.id, [entrant("検証 締切後")], "closed-request")).status, 400);
  assert.equal((await request("/api/applicant/submission", "POST", { add: [entrant("検証 締切後")] }, applicant)).status, 400);

  const manualUrl = `/api/tournaments/${a.id}/desk/manual`;
  const manual = { contact: { team_name: "架空クラブ" }, add: [entrant("検証 本部")], request_id: "manual-fixture-0001" };
  assert.equal((await request(manualUrl, "POST", manual)).status, 401);
  assert.equal((await request(manualUrl, "GET", undefined, admin)).status, 200);
  const response = await request(manualUrl, "POST", manual, admin);
  assert.equal(response.status, 201, await response.clone().text());
  const saved = await response.json();
  assert.equal(saved.applicant_token, undefined);
  assert.equal((await request(manualUrl, "POST", manual, admin)).status, 200);

  const rows = db.getEntrants(a.id);
  db.setEntrantStatus(rows.find(x => x.submission_id !== saved.submission_id).id, "pending");
  const counts = (await (await request(`/api/tournaments/${a.id}`, "GET", undefined, admin)).json()).entry_summary;
  assert.deepEqual(counts, { confirmed: 2, pending: 1, teams: 1 });
  const bookRows = reports.buildAggregation(db.getTournament(a.id), db.getEntrants(a.id));
  assert.equal([...bookRows.teams.values()].flat().length, counts.confirmed);
  const print = await request(`/api/tournaments/${a.id}/reception.html`, "GET", undefined, admin);
  assert.equal(print.status, 200);
  const html = await print.text();
  assert.match(html, /確定出場 2件/);
  assert.doesNotMatch(html, /領収印|合計予定額/);
});

test("実HTTPの確定出場数が台帳・Excel・各印刷名簿で揃い、保存した参加費を出す", async t => {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const originalMode = process.env.KTTA_APP_MODE;
  t.after(() => { process.env.KTTA_APP_MODE = originalMode; });
  const request = path => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    headers: { "X-Admin-Key": process.env.ADMIN_KEY },
  });
  const item = tournament("架空帳票大会", { event_config: [{
    name: EVENT, type: "singles", fee: 500, entry_categories: [
      { value: "general", label: "一般" }, { value: "exempt", label: "免除", fee_override: 0 },
    ],
  }] });
  const save = (name, division = "general") => {
    const result = db.createTeamEntry(item.id, form([{ ...entrant(name), division }]));
    assert.ok(result.ok, result.error);
    return result.entrant_ids[0];
  };
  save("検証 保存額");
  save("検証 免除", "exempt");
  db.setEntrantStatus(save("検証 保留"), "pending");
  db.updateEntrant(save("検証 取消"), { status: "cancelled" });
  db.setEntrantStatus(save("検証 却下"), "rejected");
  db.createEntrant({ tournament_id: item.id, ...entrant("検証 旧データ"), status: "confirmed" });
  db.updateEntrySettings(item.id, { event_config: [{ name: EVENT, type: "singles", fee: 1500 }] });

  for (const mode of ["entry", "full"]) {
    process.env.KTTA_APP_MODE = mode;
    const desk = await (await request(desks(item.id))).json();
    assert.equal(desk.totals.entries, 3);
    assert.equal(desk.totals.teams, 2);
    assert.equal(desk.unlinked, 1);
    assert.equal(desk.events.find(e => e.name === EVENT).count, 3);
    assert.ok(desk.rows.some(r => r.issues.some(i => i.title === "承認待ち")));
    const list = await (await request("/api/entry-desk/tournaments")).json();
    const listed = list.items.find(row => row.id === item.id);
    assert.deepEqual([listed.entries, listed.teams], [3, 2]);
    const excel = await request(exportPath(item.id));
    assert.equal(excel.status, 200);
    const book = XLSX.read(Buffer.from(await excel.arrayBuffer()), { type: "buffer" });
    assert.deepEqual(sheetRows(book, "集計用").at(-1).slice(3, 6), [3, 3, 500]);
    const roster = sheetRows(book, "選手名簿").filter(r => /^検証 /.test(r[2] || ""));
    assert.deepEqual(Object.fromEntries(roster.map(r => [r[2], r[8]])), {
      "検証 保存額": 500, "検証 免除": 0, "検証 旧データ": "未確認",
    });
    const byEvent = sheetRows(book, EVENT);
    assert.equal(byEvent.filter(r => /^検証 /.test(r[1] || "")).length, 3);
    const review = sheetRows(book, "要確認").flat();
    assert.ok(review.includes("検証 保留") && review.includes("承認待ち"));
    assert.ok(review.includes("検証 旧データ"));
    assert.ok(!review.includes("検証 取消") && !review.includes("検証 却下"));
    const receipts = sheetRows(book, "領収書差し込み用").slice(4);
    assert.deepEqual(receipts.map(r => r[3]).sort((a, b) => a - b), [0, 500]);
    const print = await (await request(`/api/tournaments/${item.id}/reception.html`)).text();
    assert.match(print, /確定出場 3件/);
    assert.doesNotMatch(print, /検証 (保留|取消|却下)/);
    if (mode === "full") {
      assert.match(print, /保存済み参加費 ¥500（未確認 1件）/);
      assert.match(print, /<td class="fee">¥0<\/td>/);
      assert.doesNotMatch(print, /¥1,500/);
      const byEventPrint = await (await request(`/api/tournaments/${item.id}/roster.html`)).text();
      assert.match(byEventPrint, /検証 免除/);
      assert.doesNotMatch(byEventPrint, /検証 (保留|取消|却下)/);
    }
  }

  const pending = tournament("架空確認のみ");
  const result = db.createTeamEntry(pending.id, form([entrant("検証 承認のみ")]));
  assert.ok(result.ok, result.error);
  db.setEntrantStatus(result.entrant_ids[0], "pending");
  const response = await request(exportPath(pending.id));
  assert.equal(response.status, 200);
  const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: "buffer" });
  assert.ok(sheetRows(book, "要確認").flat().includes("検証 承認のみ"));
  assert.ok(!sheetRows(book, "選手名簿").flat().includes("検証 承認のみ"));
});

test("締切未設定の大会は開催日翌日の日本時間0時に公開受付から外す", t => {
  const item = tournament("開催日境界");
  const clock = t.mock.method(Date, "now", () => Date.parse("2099-05-04T14:59:59Z"));
  assert.ok(db.getOpenTournaments().some(x => x.id === item.id));
  clock.mock.mockImplementation(() => Date.parse("2099-05-04T15:00:00Z"));
  assert.ok(!db.getOpenTournaments().some(x => x.id === item.id));
  assert.equal(db.getEntryCapacityState(item.id).closed, true);
  assert.match(db.createTeamEntry(item.id, form([entrant("検証 開催後")])).error, /開催日/);
  assert.ok(db.createManualSubmission(item.id, {
    contact: { team_name: "架空クラブ" }, add: [entrant("検証 本部")],
  }, "past-event-fixture").submission_id);
});
