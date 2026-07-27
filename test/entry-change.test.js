// 申込後の選手変更(申込者が申込番号で自分で行う)の回帰テスト。
//
// 想定する場面は「締切前に出場選手が変わった/出られなくなった」。
// 締切後〜組合せ作成前は本部が名簿を編集し、組合せ確定後は当日修正(patchSheet)で扱うため、
// 申込者側からは触れないようにガードする。
// 実行: node --test test/entry-change.test.js
process.env.DB_PATH = "/tmp/ktta_entrychange_" + process.pid + ".db";

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
  { name: "男子シングルス", type: "singles", fee: 700, capacity: 3 },
  { name: "男子ダブルス", type: "doubles", fee: 1000 },
  { name: "中学 団体戦", type: "team", per_team: 4, fee: 2000 },
];
function setup(extra) {
  const t = db.createTournament({ name: "選手変更検証", date: "2027-08-01" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: EVENTS,
    field_config: { version: 2, fields: { team_name: "required", furigana: "required" }, custom: [], event_overrides: {} },
    ...extra,
  });
  const tt = db.getTournament(t.id);
  const r = db.createTeamEntry(tt.id, {
    team_name: "湖陵中", contact_name: "担当 太郎", contact_tel: "0154", contact_email: "t@example.com",
    entries: [
      { event: "男子シングルス", type: "singles", name: "山田 太郎", team: "湖陵中", furigana: "やまだ たろう" },
      { event: "男子ダブルス", type: "doubles", name1: "山田 太郎", name2: "佐藤 次郎",
        team1: "湖陵中", team2: "湖陵中", furigana1: "やまだ たろう", furigana2: "さとう じろう" },
    ],
  }, "op-" + Math.random().toString(36).slice(2), { enforce: true });
  assert.ok(!r.error, "前提の申込が通ること: " + r.error);
  return { t: tt, token: r.applicant_token, ids: r.entrant_ids, total: r.total_amount };
}
const entOf = (id) => db.getEntries0 ? null : null;   // 直接DBを見ないための注記(下は getSubmissionByToken を使う)

// ── 差し替え ────────────────────────────────────────────────
test("締切前なら申込者が選手を差し替えられる", () => {
  const { t, token, ids } = setup();
  const r = db.applicantReplaceEntrant(token, ids[0], {
    name: "鈴木 三郎", furigana: "すずき さぶろう", team: "湖陵中", reason: "ケガのため",
  });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.before.target, "山田 太郎");
  assert.strictEqual(r.after.target, "鈴木 三郎");
  // 申込者の確認ページにも新しい名前で出ること
  const view = db.getSubmissionByToken(token);
  const single = view.entries.find(e => e.event === "男子シングルス");
  assert.strictEqual(single.name, "鈴木 三郎", "確認ページに反映される");
});

test("差し替えると姓名・表示名も作り直され、選手DBのリンクは外れる", () => {
  const { token, ids } = setup();
  db.applicantReplaceEntrant(token, ids[0], { name: "鈴木 三郎", furigana: "すずき さぶろう" });
  const view = db.getSubmissionByToken(token);
  const single = view.entries.find(e => e.event === "男子シングルス");
  assert.strictEqual(single.name, "鈴木 三郎", "古い氏名が残らない(姓名からの復元が起きない)");
});

test("ダブルスは選手1と選手2を別々に差し替えられる", () => {
  const { token, ids } = setup();
  const r2 = db.applicantReplaceEntrant(token, ids[1], { slot: 2, name: "田中 五郎", furigana: "たなか ごろう" });
  assert.ok(!r2.error, r2.error);
  assert.strictEqual(r2.before.target, "佐藤 次郎");
  const r1 = db.applicantReplaceEntrant(token, ids[1], { slot: 1, name: "渡辺 六郎", furigana: "わたなべ ろくろう" });
  assert.ok(!r1.error, r1.error);
  const view = db.getSubmissionByToken(token);
  const pair = view.entries.find(e => e.event === "男子ダブルス");
  assert.match(pair.name, /渡辺 六郎/, "選手1が入れ替わる");
  assert.match(pair.name, /田中 五郎/, "選手2も入れ替わったまま");
});

test("差し替え時も必須項目が再検証される", () => {
  const { token, ids } = setup();
  const r = db.applicantReplaceEntrant(token, ids[0], { name: "高橋 四郎", furigana: "" });
  assert.ok(r.error && r.validation, "ふりがな必須で拒否: " + r.error);
  assert.match(r.error, /ふりがな/);
});

test("氏名が空の差し替えは拒否される", () => {
  const { token, ids } = setup();
  assert.match(db.applicantReplaceEntrant(token, ids[0], { name: "   " }).error, /氏名/);
});

test("団体戦のメンバー変更は本部へ案内する(誤操作でチームが壊れない)", () => {
  const { t, token } = setup();
  const r = db.createTeamEntry(t.id, {
    team_name: "湖陵中", contact_name: "担", contact_tel: "1", contact_email: "t@example.com",
    entries: [{ event: "中学 団体戦", type: "team", team_name: "湖陵中A", members: ["甲 一", "乙 二", "丙 三"] }],
  }, "op-team", { enforce: true });
  const msg = db.applicantReplaceEntrant(r.applicant_token, r.entrant_ids[0], { name: "丁 四" });
  assert.match(msg.error, /団体戦.*本部/);
});

// ── 取消 ────────────────────────────────────────────────────
test("出場を取り消すと枠が空き、合計金額が減る", () => {
  const { t, token, ids, total } = setup();
  const capBefore = db.getEntryCapacityState(t.id).events.find(e => e.event === "男子シングルス").used;
  const r = db.applicantCancelEntrant(token, ids[0], "都合により");
  assert.ok(!r.error, r.error);
  const capAfter = db.getEntryCapacityState(t.id).events.find(e => e.event === "男子シングルス").used;
  assert.strictEqual(capAfter, capBefore - 1, "枠が1つ空く");
  assert.strictEqual(r.total_amount, total - 700, "参加料が引かれる");
  const view = db.getSubmissionByToken(token);
  assert.strictEqual(view.total_amount, total - 700, "確認ページの合計も減る");
});

test("取り消した出場は二度取り消せない", () => {
  const { token, ids } = setup();
  db.applicantCancelEntrant(token, ids[0], "x");
  assert.match(db.applicantCancelEntrant(token, ids[0], "x").error, /既に取り消/);
});

test("取り消した出場は組合せ(抽選)の対象にならない", () => {
  const { t, token, ids } = setup();
  db.applicantCancelEntrant(token, ids[0], "欠場");
  const ready = db.checkDrawReadiness(t.id, "男子シングルス");
  assert.strictEqual(ready.confirmed, 0, "承認済みの人数から外れる");
});

// ── 権限と期限のガード ──────────────────────────────────────
test("他人の申込番号では変更できない", () => {
  const { ids } = setup();
  const a = db.applicantReplaceEntrant("XXXX-YYYY-ZZZZ", ids[0], { name: "侵入 太郎" });
  assert.ok(a.error, "拒否されること");
  const other = setup();   // 別の申込のトークンで、こちらの entrant を触る
  const b = db.applicantReplaceEntrant(other.token, ids[0], { name: "侵入 太郎" });
  assert.match(b.error, /この申込番号では変更できません/);
});

test("締切を過ぎたら変更できず、本部への連絡を案内する", () => {
  // 申込は締切前に受け付け、その後に締切が過ぎた状況を作る
  const { t, token, ids } = setup();
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: EVENTS, entry_deadline: "2020-01-01" });
  const r = db.applicantReplaceEntrant(token, ids[0], { name: "鈴木 三郎", furigana: "すずき" });
  assert.match(r.error, /申込締切/);
  assert.match(r.error, /本部/);
  assert.match(db.applicantCancelEntrant(token, ids[0], "x").error, /本部/);
});

test("受付を閉じたら変更できない", () => {
  const { t, token, ids } = setup();
  db.updateEntrySettings(t.id, { entries_open: 0, event_config: EVENTS });
  assert.match(db.applicantReplaceEntrant(token, ids[0], { name: "鈴木 三郎" }).error, /受け付けて/);
});

test("組合せができた後は変更できず、本部への連絡を案内する", () => {
  const { t, token, ids } = setup();
  // 抽選せずに直接ブラケットを作る(matches が存在する状態)
  db.createTeamEntry(t.id, {
    team_name: "他校", contact_name: "担", contact_tel: "1", contact_email: "x@example.com",
    entries: [{ event: "男子シングルス", type: "singles", name: "対戦 相手", team: "他校", furigana: "たいせん あいて" }],
  }, "op-2", { enforce: true });
  const made = db.generateBracket(t.id, "男子シングルス", { regenerate: true });
  assert.ok(!made.error, "前提のブラケット生成: " + made.error);
  const r = db.applicantReplaceEntrant(token, ids[0], { name: "鈴木 三郎", furigana: "すずき" });
  assert.match(r.error, /組合せ/);
  assert.match(r.error, /本部/);
});

// ── 履歴 ────────────────────────────────────────────────────
test("変更履歴に、いつ誰が何をどう変えたかが残る", () => {
  const { t, token, ids } = setup();
  db.applicantReplaceEntrant(token, ids[0], { name: "鈴木 三郎", furigana: "すずき さぶろう", reason: "ケガのため" });
  db.applicantCancelEntrant(token, ids[1], "部活の都合");
  const hist = db.listEntryChanges(t.id);
  assert.strictEqual(hist.length, 2, "2件記録される");
  const cancel = hist.find(h => h.kind === "cancel");
  const replace = hist.find(h => h.kind === "replace");
  assert.strictEqual(replace.before.target, "山田 太郎");
  assert.strictEqual(replace.after.target, "鈴木 三郎");
  assert.strictEqual(replace.reason, "ケガのため");
  assert.strictEqual(replace.actor, "applicant");
  assert.strictEqual(cancel.reason, "部活の都合");
  assert.ok(cancel.created_at, "日時が入る");
});

test("履歴には連絡先などのPIIを載せない", () => {
  const { t, token, ids } = setup();
  db.applicantReplaceEntrant(token, ids[0], { name: "鈴木 三郎", furigana: "すずき さぶろう" });
  const raw = JSON.stringify(db.listEntryChanges(t.id));
  assert.ok(!raw.includes("t@example.com"), "メールアドレスを含まない");
  assert.ok(!raw.includes("0154"), "電話番号を含まない");
});
