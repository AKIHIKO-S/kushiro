// 受付台帳(申込集計モードの受付画面)の集計の回帰テスト。
//
// 守らせる不変条件:
//   ① 出場数は申込の一覧・集計と同じ定義(取り消した出場は数えない)
//   ② 種目の並びは要項(event_config)の順。団体ごとに種目別の数が出る
//   ③ 別の団体から同じ人が同じ種目に申し込むと、両方の団体に「重複の疑い」が出る
//   ④ 電話・メールは返さない
//   ⑤ 大会一覧は 受付中 → 受付前 → 終了 の順
// 実行: node --test test/entry-desk.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_entrydesk_" + process.pid + ".db");

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EVENTS = [
  { name: "一般男子シングルス", type: "singles", fee: 700 },
  { name: "一般女子シングルス", type: "singles", fee: 700 },
  { name: "男子ダブルス", type: "doubles", fee: 1000 },
];

function tournament(name, open, deadline) {
  const t = db.createTournament({ name, date: "2099-12-06" });
  db.updateEntrySettings(t.id, { entries_open: open ? 1 : 0, entry_deadline: deadline || "", event_config: EVENTS });
  return db.getTournament(t.id);
}
function apply(t, team, entries) {
  const r = db.createTeamEntry(t.id, {
    team_name: team, contact_name: "連絡 担当", contact_tel: "0154-00-0000", contact_email: "desk@example.com",
    entries,
  }, "op-desk-" + Math.random().toString(36).slice(2), { enforce: true });
  assert.ok(!r.error, "前提の申込が通ること: " + r.error);
  return r.submission_id;
}

test("団体ごとの種目別の数・合計・重複の疑い・連絡先を出さないこと", () => {
  const t = tournament("受付台帳検証大会", true, "2099-11-20");
  const a = apply(t, "架空クラブ", [
    { event: "一般男子シングルス", type: "singles", name: "架空 太郎", furigana: "かくう たろう", team: "架空クラブ" },
    { event: "一般男子シングルス", type: "singles", name: "架空 次郎", furigana: "かくう じろう", team: "架空クラブ" },
    { event: "男子ダブルス", type: "doubles", name1: "架空 三郎", name2: "架空 四郎", team1: "架空クラブ", team2: "架空クラブ" },
  ]);
  apply(t, "見本中学校", [
    { event: "一般男子シングルス", type: "singles", name: "架空 太郎", furigana: "かくう たろう", team: "見本中学校" },
    { event: "一般女子シングルス", type: "singles", name: "見本 花子", furigana: "みほん はなこ", team: "見本中学校" },
  ]);

  const d = db.getEntryDesk(t.id);
  assert.ok(!d.error, d.error);
  assert.deepStrictEqual(d.events.map(e => e.name), EVENTS.map(e => e.name), "要項の順");
  assert.deepStrictEqual(d.events.map(e => e.count), [3, 1, 1]);
  assert.strictEqual(d.totals.entries, 5);
  assert.strictEqual(d.totals.submissions, 2);
  assert.strictEqual(d.totals.by_route.web, 2);

  const rowA = d.rows.find(r => r.submission_id === a);
  assert.strictEqual(rowA.entries, 3);
  assert.deepStrictEqual(rowA.by_event, { "一般男子シングルス": 2, "男子ダブルス": 1 });
  assert.ok(rowA.players.some(p => p.label === "架空 三郎・架空 四郎"), "ダブルスは2人を並べる");

  // ③ 重複の疑いは両方の団体に1件ずつ
  d.rows.forEach(r => {
    const dup = r.issues.filter(i => i.type === "dup");
    assert.strictEqual(dup.length, 1, r.team_name + " に重複の疑いが1件");
    assert.match(dup[0].detail, /架空 太郎/);
  });

  // ① 集計の定義が申込の一覧と同じ
  const list = db.getSubmissionList(t.id);
  assert.strictEqual(list.totals.confirmed, d.totals.entries);
  assert.strictEqual(list.rows.reduce((n, r) => n + r.entries, 0), d.rows.reduce((n, r) => n + r.entries, 0));

  // ④ 連絡先(電話・メール)を返さない
  const raw = JSON.stringify(d);
  assert.ok(!raw.includes("0154-00-0000") && !raw.includes("desk@example.com"), "電話・メールを含めない");

  // ① 取り消した出場は数えない
  const view = db.getSubmissionEditView(a, { admin: true });
  const one = view.entries.find(e => e.event === "男子ダブルス");
  const r = db.editSubmission(a, { entries: [{ entrant_id: one.entry_id, cancel: true }], reason: "検証" }, { actor: "admin" });
  assert.ok(!r.error, r.error);
  const d2 = db.getEntryDesk(t.id);
  const rowA2 = d2.rows.find(x => x.submission_id === a);
  assert.strictEqual(rowA2.entries, 2);
  assert.strictEqual(rowA2.cancelled, 1);
  assert.strictEqual(d2.totals.entries, 4);
});

test("大会一覧は 受付中 → 受付前 → 終了 の順で、出場数と団体数が出る", () => {
  const before = tournament("受付前の大会", false, "2099-10-01");
  const open = tournament("受付中の大会", true, "2099-10-05");
  const done = db.createTournament({ name: "終わった大会", date: "2000-01-01" });
  apply(open, "架空クラブ", [{ event: "一般男子シングルス", type: "singles", name: "一覧 太郎", furigana: "いちらん たろう", team: "架空クラブ" }]);
  const { items } = db.getEntryDeskList();
  const pos = (id) => items.findIndex(x => x.id === id);
  assert.ok(pos(open.id) < pos(before.id) && pos(before.id) < pos(done.id), "並び順");
  const it = items.find(x => x.id === open.id);
  assert.strictEqual(it.state, "open");
  assert.strictEqual(it.entries, 1);
  assert.strictEqual(it.teams, 1);
  assert.strictEqual(items.find(x => x.id === done.id).state, "closed");
  assert.strictEqual(items.find(x => x.id === before.id).state, "before");
});

test("存在しない大会は error", () => {
  assert.ok(db.getEntryDesk("nope").error);
});

test("種目の略称: 表の見出しに収まる短い名前。重なるときは先頭6字", () => {
  const { shortEventName } = require("../public/admin/entry-desk.js");
  const all = ["一般男子シングルス", "中学女子シングルス", "男子ダブルス", "混合ダブルス", "団体戦", "男子団体"];
  assert.deepStrictEqual(all.map(n => shortEventName(n, all)), ["一般男", "中学女", "男D", "混D", "団体", "男団体"]);
  assert.strictEqual(shortEventName("ラージボール"), "ラージボー", "当たらないものは先頭5字");
  const clash = ["一般男子シングルスA", "一般男子シングルスB"];
  assert.deepStrictEqual(clash.map(n => shortEventName(n, clash)), ["一般男子シン", "一般男子シン"]);
});
