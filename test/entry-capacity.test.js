// 申込の受付制御(P3): 締切日時と定員の回帰テスト。
//  - 締切は日付+時刻(JST)。時刻未設定なら締切日の終日まで受け付ける(従来互換)
//  - 定員は「申込枠の数」(ダブルス=1ペア, 団体=1チームで1枠)。種目ごと/大会全体の2段
//  - 満員種目はフォームで選べなくなり、締切超過はフォームを開いた時点で案内+送信停止
// 実行: node --test test/entry-capacity.test.js
process.env.DB_PATH = "/tmp/ktta_capacity_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const entryForm = require("../entry_form.js");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const JST = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString();
const today = () => JST().slice(0, 10);

function mkTournament(settings) {
  const t = db.createTournament({ name: "受付制御検証", date: "2027-03-01" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [
      { name: "男子シングルス", type: "singles", fee: 1000, capacity: 2 },
      { name: "女子シングルス", type: "singles", fee: 1000 },
      { name: "男子ダブルス", type: "doubles", fee: 2000, capacity: 1 },
    ],
    ...settings,
  });
  return db.getTournament(t.id);
}
const submit = (t, entries) => db.createTeamEntry(t.id, {
  team_name: "検証クラブ", contact_name: "担当 太郎",
  contact_tel: "0154-00-0000", contact_email: "t@example.com",
  entries,
}, "op-" + Math.random().toString(36).slice(2), { enforce: true });
const single = (name, ev) => ({ event: ev || "男子シングルス", type: "singles", name, team: "検証ク" });

// ── 締切: 日付+時刻 ──────────────────────────────────────────
test("締切の時刻が未設定なら締切日の終日まで受け付ける(従来互換)", () => {
  const t = mkTournament({ entry_deadline: today(), entry_deadline_time: "" });
  assert.strictEqual(db.entryDeadlineAt(t), today() + " 23:59");
  assert.strictEqual(db.entryDeadlineLabel(t), today(), "表示は日付のみ");
  const r = submit(t, [single("甲 一")]);
  assert.ok(!r.error, "締切日当日は受け付ける: " + r.error);
});

test("締切に時刻を設定すると、その時刻で締め切られる", () => {
  const past = mkTournament({ entry_deadline: today(), entry_deadline_time: "00:01" });
  const r = submit(past, [single("乙 二")]);
  assert.ok(r.error && /申込締切/.test(r.error), "時刻超過で締切: " + r.error);
  assert.match(r.error, /00:01/, "締切時刻が文言に出る");

  const future = mkTournament({ entry_deadline: today(), entry_deadline_time: "23:59" });
  assert.ok(!submit(future, [single("丙 三")]).error, "まだ締切前なら受け付ける");
});

test("締切日を過ぎていれば時刻に関係なく締切", () => {
  const t = mkTournament({ entry_deadline: "2020-01-01", entry_deadline_time: "23:59" });
  const r = submit(t, [single("丁 四")]);
  assert.ok(r.error && /2020-01-01/.test(r.error), "過去日は締切: " + r.error);
});

test("不正な締切時刻は無視され終日扱いになる(壊れた設定で締切が消えない)", () => {
  const t = mkTournament({ entry_deadline: today(), entry_deadline_time: "25時ごろ" });
  assert.strictEqual(db.entryDeadlineAt(t), today() + " 23:59");
  assert.ok(!submit(t, [single("戊 五")]).error);
});

// ── 定員: 種目ごと ──────────────────────────────────────────
test("種目の定員に達すると、その種目だけ受け付けなくなる", () => {
  const t = mkTournament({});
  assert.ok(!submit(t, [single("一 郎")]).error, "1人目");
  assert.ok(!submit(t, [single("二 郎")]).error, "2人目");
  const over = submit(t, [single("三 郎")]);
  assert.ok(over.error && over.full, "定員2を超えたら拒否: " + over.error);
  assert.match(over.error, /男子シングルス.*定員（2）/);
  // 定員のない別種目は通る
  assert.ok(!submit(t, [single("四 郎", "女子シングルス")]).error, "無制限の種目は通る");
});

test("1回の申込に複数人いる場合、残り枠を超えたらまとめて拒否する", () => {
  const t = mkTournament({});
  const r = submit(t, [single("A 子"), single("B 子"), single("C 子")]);   // 定員2に3人
  assert.ok(r.error && /残り2枠/.test(r.error), "残り枠を明示して拒否: " + r.error);
  assert.strictEqual(db.getEntryCapacityState(t.id).events[0].used, 0, "1件も登録されないこと");
});

test("ダブルスは1ペアで1枠として数える", () => {
  const t = mkTournament({});
  const pair = (n1, n2) => ({ event: "男子ダブルス", type: "doubles", name1: n1, name2: n2, team1: "A", team2: "A" });
  assert.ok(!submit(t, [pair("甲 一", "乙 二")]).error, "1ペア目(定員1)");
  const r = submit(t, [pair("丙 三", "丁 四")]);
  assert.ok(r.error && /男子ダブルス/.test(r.error), "2ペア目は定員超過: " + r.error);
  const st = db.getEntryCapacityState(t.id);
  const d = st.events.find(e => e.event === "男子ダブルス");
  assert.strictEqual(d.used, 1, "2名で1枠");
});

// ── 定員: 大会全体 ──────────────────────────────────────────
test("大会全体の定員も効く(種目に空きがあっても止まる)", () => {
  const t = mkTournament({ entry_capacity: 2 });
  assert.ok(!submit(t, [single("一 号", "女子シングルス")]).error);
  assert.ok(!submit(t, [single("二 号", "女子シングルス")]).error);
  const r = submit(t, [single("三 号", "女子シングルス")]);
  assert.ok(r.error && /この大会は定員（2）/.test(r.error), "全体上限で拒否: " + r.error);
});

// ── 受付状況の集計 ──────────────────────────────────────────
test("受付状況(残り枠・満員)を集計できる", () => {
  const t = mkTournament({ entry_capacity: 10 });
  submit(t, [single("甲 一")]);
  const st = db.getEntryCapacityState(t.id);
  const men = st.events.find(e => e.event === "男子シングルス");
  assert.deepStrictEqual({ used: men.used, capacity: men.capacity, remaining: men.remaining, full: men.full },
    { used: 1, capacity: 2, remaining: 1, full: false });
  const women = st.events.find(e => e.event === "女子シングルス");
  assert.strictEqual(women.remaining, null, "定員なしは remaining=null(無制限)");
  assert.strictEqual(st.total_used, 1);
  assert.strictEqual(st.total_remaining, 9);
});

test("却下(rejected)の申込は枠を消費しない", () => {
  const t = mkTournament({});
  const r = submit(t, [single("却下 太郎")]);
  const id = r.entrant_ids[0];
  db.updateEntrant(id, { status: "rejected" });
  assert.strictEqual(db.getEntryCapacityState(t.id).events[0].used, 0, "却下は数えない");
});

// ── フォーム表示 ────────────────────────────────────────────
test("満員の種目はフォームで受付終了と表示され、入力欄が出ない", () => {
  const t = mkTournament({});
  submit(t, [single("一 郎")]);
  submit(t, [single("二 郎")]);
  const cap = db.getEntryCapacityState(t.id);
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1000 },
     { name: "女子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(t), capacity: cap });
  assert.ok(html.includes("受付終了（定員に達しました）"), "満員タグが出る");
  assert.ok(html.includes("この種目は定員に達したため"), "案内が出る");
  // 埋め込まれた種目データで満員フラグが立っていること
  const evJson = html.match(/const EVENTS = (\[[\s\S]*?\]);/);
  assert.ok(evJson, "EVENTS が埋め込まれている");
  const events = JSON.parse(evJson[1]);
  assert.strictEqual(events[0].full, true, "満員種目");
  assert.strictEqual(events[1].full, false, "空きのある種目");
});

test("残りわずかな種目は残り枠がフォームに渡る", () => {
  const t = mkTournament({});
  submit(t, [single("一 郎")]);   // 定員2 → 残り1
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(t), capacity: db.getEntryCapacityState(t.id) });
  // 残り枠のタグは renderEvents が実行時に組み立てるので、埋め込みデータで検証する
  const events = JSON.parse(html.match(/const EVENTS = (\[[\s\S]*?\]);/)[1]);
  assert.strictEqual(events[0].remaining, 1, "残り枠が渡っている");
  assert.strictEqual(events[0].full, false);
  assert.ok(html.includes("cap-tag"), "残り枠タグのスタイルが定義されている");
});

test("締切超過の大会はフォームを開いた時点で案内し、送信ボタンを止める", () => {
  const t = mkTournament({ entry_deadline: "2020-01-01" });
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(t), capacity: db.getEntryCapacityState(t.id) });
  assert.ok(html.includes('<div class="closed-banner">'), "受付終了バナーが出る");
  assert.ok(html.includes("申込は締め切りました"), "見出しが出る");
  assert.ok(/id="submitBtn" disabled/.test(html), "送信ボタンが無効: " + (html.match(/<button[^>]*submitBtn[^>]*>/) || [""])[0]);
  assert.ok(html.includes("受付は終了しました"), "ボタン文言が変わる");
});

test("受付中の大会では従来どおりフォームが出る(バナーなし・送信可)", () => {
  const t = mkTournament({ entry_deadline: "" });
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(t), capacity: db.getEntryCapacityState(t.id) });
  assert.ok(!html.includes('<div class="closed-banner">'), "バナーは出ない");
  assert.ok(!/id="submitBtn" disabled/.test(html), "送信ボタンは有効");
  assert.ok(html.includes("申込内容を送信"));
});

test("capacity 未指定(旧経路)でもフォームは従来どおり生成される", () => {
  const t = mkTournament({});
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(t) });   // capacity を渡さない
  assert.ok(!html.includes('<div class="closed-banner">'));
  assert.ok(html.includes("申込内容を送信"));
  const events = JSON.parse(html.match(/const EVENTS = (\[[\s\S]*?\]);/)[1]);
  assert.strictEqual(events[0].full, false, "満員扱いにならない");
  assert.strictEqual(events[0].remaining, null);
});
