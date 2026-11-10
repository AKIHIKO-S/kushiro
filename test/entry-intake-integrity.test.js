const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { Script } = require("node:vm");

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

function tournament(name, settings = {}) {
  const t = db.createTournament({ name, date: "2099-05-04" });
  db.updateEntrySettings(t.id, { entries_open: 1,
    event_config: [{ name: EVENT, type: "singles", fee: 500 }], ...settings });
  return t;
}

test("受付日は日本時間の翌日0時で終わり、公開一覧と送信が同じ条件を使う", t => {
  const item = tournament("日付境界", { entry_deadline: "2099-04-30", entry_deadline_time: "17:00" });
  t.mock.method(Date, "now", () => Date.parse("2099-04-30T14:59:59Z"));
  assert.equal(db.entryDeadlineLabel(db.getTournament(item.id)), "2099-04-30");
  assert.ok(db.getOpenTournaments().some(x => x.id === item.id));
  assert.equal(db.getEntryCapacityState(item.id).closed, false);
  assert.ok(db.createTeamEntry(item.id, form([entrant("検証 締切前")])).submission_id);
  Date.now.mock.mockImplementation(() => Date.parse("2099-04-30T15:00:00Z"));
  assert.equal(db.getEntryCapacityState(item.id).closed, true);
  assert.ok(!db.getOpenTournaments().some(x => x.id === item.id));
  assert.match(db.createTeamEntry(item.id, form([entrant("検証 締切後")])).error, /締切/);
});

test("受付・本部登録・本人修正・シート照合・確定件数を実HTTPで検証する", async t => {
  const sends = [];
  const storedKeys = new Map();
  const fetchLocal = global.fetch;
  t.mock.method(global, "fetch", async (url, opts) => {
    const u = new URL(url);
    assert.equal(u.hostname, "script.google.com");
    if (u.searchParams.get("action") === "entry_ids") {
      const ids = storedKeys.get(u.searchParams.get("tournament_id")) || [];
      return Response.json({ ok: true, has_id_column: true, ids, count: ids.length });
    }
    const body = JSON.parse(opts.body);
    sends.push({ path: u.pathname, body });
    if (body.action === "create") {
      const ids = storedKeys.get(body.tournament_id) || [];
      if (!ids.includes(body.op_id)) ids.push(body.op_id);
      storedKeys.set(body.tournament_id, ids);
    }
    return Response.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { "X-Admin-Key": process.env.ADMIN_KEY };
  const request = (url, method = "GET", data, headers) => fetchLocal(base + url, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const a = tournament("架空大会A", { entry_gas_url: "https://script.google.com/macros/s/A/exec" });
  const b = tournament("架空大会B", { entry_gas_url: "https://script.google.com/macros/s/B/exec" });
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
  assert.deepEqual(sends.map(x => x.body.tournament_id), [a.id, b.id]);
  assert.equal(sends[0].body.action, "create");
  assert.notEqual(sends[0].body.op_id, sends[1].body.op_id);
  assert.equal((await (await request(`/api/tournaments/${a.id}/gas-sync/reconcile`, "GET", undefined, admin)).json()).missing_count, 0);
  assert.equal((await request(`/api/tournaments/${a.id}/gas-sync/resend/${subB.submission_id}`, "POST", {}, admin)).status, 400);
  assert.equal(sends.length, 2);

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
  assert.equal(sends.at(-1).body.submission.ledger_key, sends[0].body.op_id);

  const resend = await request(`/api/tournaments/${a.id}/gas-sync/resend/${subA.submission_id}`, "POST", {}, admin);
  assert.equal(resend.status, 200, await resend.clone().text());
  assert.deepEqual(sends.slice(-2).map(x => x.body.action), ["create", "update"]);
  assert.equal(sends.at(-2).body.op_id, sends[0].body.op_id);
  assert.equal(sends.at(-1).body.submission.ledger_key, sends[0].body.op_id);
  assert.ok(sends.slice(-2).every(x => x.path === "/macros/s/A/exec" && x.body.tournament_id === a.id));

  const beforeClosed = sends.length;
  db.updateEntrySettings(a.id, { entries_open: 1, entry_deadline: "2000-01-01" });
  assert.equal((await submit(a.id, [entrant("検証 締切後")], "closed-request")).status, 400);
  assert.equal((await request("/api/applicant/submission", "POST", { add: [entrant("検証 締切後")] }, applicant)).status, 400);
  assert.equal(sends.length, beforeClosed);

  const manualUrl = `/api/tournaments/${a.id}/desk/manual`;
  const manual = { contact: { team_name: "架空クラブ" }, add: [entrant("検証 本部")], request_id: "manual-fixture-0001" };
  assert.equal((await request(manualUrl, "POST", manual)).status, 401);
  assert.equal((await request(manualUrl, "GET", undefined, admin)).status, 200);
  const response = await request(manualUrl, "POST", manual, admin);
  assert.equal(response.status, 201, await response.clone().text());
  const saved = await response.json();
  assert.equal(saved.applicant_token, undefined);
  assert.equal((await request(manualUrl, "POST", manual, admin)).status, 200);
  assert.equal(sends.length, beforeClosed);
  assert.equal(db.getGasSyncState(a.id).total, 1);
  assert.deepEqual(db.buildSheetUpdatePayload(saved.submission_id), { skipped: true });

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
