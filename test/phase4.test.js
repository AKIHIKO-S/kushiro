// Phase4: データ形状の完全性 回帰テスト。
//  - 申込時に 区分(division)/参加料(fee)/団体メンバー/連絡先 を構造化列へ保存
//  - 申込番号トークンで本人が閲覧 (PII非開示)
//  - createTeamEntry の冪等dedup
//  - admin直接追加(createEntry)の種目名→性別/カテゴリ推定
//  - データ品質検出(findEntrantDataIssues)と一括/個別修正
// 実行: node --test test/phase4.test.js
process.env.DB_PATH = "/tmp/ktta_phase4_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

function openTournament(eventConfig) {
  const t = db.createTournament({ name: "Phase4検証", date: "2027-10-10" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: eventConfig || [
      { name: "男子シングルス", type: "singles", fee: 700, fee_student: 400 },
      { name: "男子団体戦", type: "team", fee: 2000 },
    ],
  });
  return t;
}

test("申込時に 区分/参加料/連絡先 が構造化列へ保存される", () => {
  const t = openTournament();
  const r = db.createTeamEntry(t.id, {
    team_name: "甲高校", contact_name: "監督A", contact_email: "k@a.jp", contact_tel: "090-1",
    entries: [{ event: "男子シングルス", type: "singles", name: "山田 太郎", team: "甲高校", division: "high" }],
  });
  assert.ok(r.ok && r.entry_count === 1);
  const e = db.getEntries(t.id)[0];
  assert.strictEqual(e.division, "high", "区分が保存される");
  assert.strictEqual(e.fee, 400, "参加料は event_config の fee_student を正として保存(クライアント値非依存)");
  assert.strictEqual(e.category, "high");
  assert.strictEqual(e.contact_email, "k@a.jp", "連絡先メールは構造化列に保存");
  assert.strictEqual(e.contact_name, "監督A");
});

test("参加料は event_config を正に再計算 (一般=fee / 中高生=fee_student)", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "一般 太郎", team: "T", division: "general", fee: 99999 },
    { event: "男子シングルス", type: "singles", name: "中学 次郎", team: "T", division: "middle", fee: 0 },
  ] });
  const es = db.getEntries(t.id);
  assert.strictEqual(es.find(e => e.name === "一般 太郎").fee, 700, "一般は fee。クライアント供給の99999は無視");
  assert.strictEqual(es.find(e => e.name === "中学 次郎").fee, 400, "中学は fee_student");
});

test("団体メンバーは構造化列(team_members)に保存され getTeamRosters/getEntries で読める", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "甲高校", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子団体戦", type: "team", team_name: "甲高校", members: ["山田 太郎", "佐藤 次郎", "鈴木 三郎"] },
  ] });
  const e = db.getEntries(t.id).find(e => e.entry_event === "男子団体戦");
  assert.deepStrictEqual(e.team_members, ["山田 太郎", "佐藤 次郎", "鈴木 三郎"], "getEntries が構造化メンバーを返す");
  const rosters = db.getTeamRosters(t.id);
  assert.strictEqual(rosters.length, 1);
  assert.deepStrictEqual(rosters[0].members, ["山田 太郎", "佐藤 次郎", "鈴木 三郎"]);
});

test("申込番号トークンで本人が閲覧でき、PII(メール)は開示されない", () => {
  const t = openTournament();
  const r = db.createTeamEntry(t.id, { team_name: "甲", contact_name: "監督", contact_email: "secret@a.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "山田 太郎", team: "甲", division: "high" },
  ] });
  assert.ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.applicant_token), "申込番号は 4-4-4 形式: " + r.applicant_token);
  const view = db.getSubmissionByToken(r.applicant_token);
  assert.ok(view.ok);
  assert.strictEqual(view.entries.length, 1);
  assert.strictEqual(view.entries[0].fee, 400);
  assert.strictEqual(view.team_name, "甲");
  assert.ok(!JSON.stringify(view).includes("secret@a.jp"), "連絡先メールは閲覧APIに含めない");
});

test("不正な申込番号トークンは error を返す", () => {
  assert.ok(db.getSubmissionByToken("BADX-BADX-BADX").error);
  assert.ok(db.getSubmissionByToken("").error);
});

test("createTeamEntry は同一(種目・氏名・所属)の重複を作らない(冪等)", () => {
  const t = openTournament();
  // 1回の申込内に同一エントリーが2件 → 1件のみ
  const r1 = db.createTeamEntry(t.id, { team_name: "甲", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "重複 太郎", team: "甲" },
    { event: "男子シングルス", type: "singles", name: "重複 太郎", team: "甲" },
  ] });
  assert.strictEqual(r1.entry_count, 1, "同一申込内の重複は1件に");
  assert.strictEqual(r1.skipped_duplicate, 1);
  // 別申込で再送 → 0件作成
  const r2 = db.createTeamEntry(t.id, { team_name: "甲", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "重複 太郎", team: "甲" },
  ] });
  assert.strictEqual(r2.entry_count, 0, "再送は重複として作成しない");
  assert.strictEqual(db.getEntries(t.id).filter(e => e.name === "重複 太郎").length, 1);
});

test("全件 spam の申込はトークンを発行しない", () => {
  const t = openTournament();
  const r = db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "http://spam.example.com", team: "X" },
  ] });
  assert.strictEqual(r.entry_count, 0);
  assert.strictEqual(r.applicant_token, "", "1件も作成されなければ申込番号は出さない");
});

test("admin直接追加(createEntry)は種目名から性別・カテゴリを推定する", () => {
  const t = openTournament([{ name: "高校女子シングルス", type: "singles", fee: 600 }]);
  db.createEntry(t.id, { name: "花子 一", team: "乙", events: ["高校女子シングルス"], auto_confirm: true });
  const e = db.getEntries(t.id).find(e => e.name.includes("花子"));
  assert.strictEqual(e.gender, "female", "種目名 女子 → female");
  assert.strictEqual(e.category, "high", "種目名 高校 → high");
});

test("findEntrantDataIssues が種目とgender/categoryの不整合・ふりがな欠落を検出する", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "甲", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "山田 太郎", team: "甲" },
  ] });
  const e = db.getEntries(t.id)[0];
  db.fixEntrant(e.id, { gender: "female" });   // 種目=男子 なのに female にして不整合を作る
  const issues = db.findEntrantDataIssues(t.id);
  assert.ok(issues.total >= 1);
  assert.ok(issues.counts.gender_mismatch >= 1, "性別不一致を検出");
  const item = issues.items.find(it => it.id === e.id);
  assert.ok(item.issues.some(is => is.code === "gender_mismatch" && is.suggested === "male"), "推定値 male を提案");
});

test("bulkFixEntrantInference が推定値で不整合を一括修正する", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "甲", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "高校男子シングルス", type: "singles", name: "山田 太郎", team: "甲" },
  ] });
  const e = db.getEntries(t.id)[0];
  db.fixEntrant(e.id, { gender: "female", category: "general" });   // 二重に不整合化
  let issues = db.findEntrantDataIssues(t.id);
  assert.ok(issues.counts.gender_mismatch >= 1 && issues.counts.category_mismatch >= 1);
  const bf = db.bulkFixEntrantInference(t.id, { gender: true, category: true, furigana: true });
  assert.ok(bf.fixed >= 1);
  const fixed = db.getEntries(t.id)[0];
  assert.strictEqual(fixed.gender, "male", "性別が種目から推定され修正");
  assert.strictEqual(fixed.category, "high", "区分が種目から推定され修正");
});

test("created_entries は作成分のみ・権威料金で確認メールが台帳とズレない (review #3/#4)", () => {
  const t = openTournament();
  const r = db.createTeamEntry(t.id, { team_name: "甲", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "一般 太郎", team: "甲", division: "general", fee: 99999 },
    { event: "男子シングルス", type: "singles", name: "一般 太郎", team: "甲", division: "general" }, // 重複
    { event: "男子シングルス", type: "singles", name: "http://spam.example.com", team: "X" },          // spam
  ] });
  assert.strictEqual(r.entry_count, 1);
  assert.strictEqual(r.created_entries.length, 1, "created_entries は作成分のみ(spam/重複を除く)");
  assert.strictEqual(r.created_entries[0].fee, 700, "権威料金(クライアントの99999は無視)");
  assert.strictEqual(r.created_entries.reduce((s, e) => s + e.fee, 0), r.total_amount, "明細合計=台帳合計");
});

test("全件重複の再送は already_registered=true を返す (review #5)", () => {
  const t = openTournament();
  const mk = () => ({ team_name: "甲", contact_name: "x", contact_email: "x@y.jp",
    entries: [{ event: "男子シングルス", type: "singles", name: "再送 太郎", team: "甲" }] });
  const r1 = db.createTeamEntry(t.id, mk());
  assert.strictEqual(r1.entry_count, 1);
  assert.ok(!r1.already_registered);
  const r2 = db.createTeamEntry(t.id, mk());
  assert.strictEqual(r2.entry_count, 0);
  assert.strictEqual(r2.already_registered, true, "全件重複は already_registered=true");
  assert.strictEqual(r2.applicant_token, "");
});

test("団体名が空でも先頭選手同名の別チームを誤って捨てない (review #11)", () => {
  const t = openTournament([{ name: "男子団体戦", type: "team", fee: 2000 }]);
  db.createTeamEntry(t.id, { contact_name: "x", contact_email: "x@y.jp",
    entries: [{ event: "男子団体戦", type: "team", team_name: "", members: ["山田 太郎", "A 一"] }] });
  db.createTeamEntry(t.id, { contact_name: "y", contact_email: "y@y.jp",
    entries: [{ event: "男子団体戦", type: "team", team_name: "", members: ["山田 太郎", "B 二"] }] });
  const teams = db.getEntries(t.id).filter(e => e.entry_event === "男子団体戦");
  assert.strictEqual(teams.length, 2, "団体名が空でも別メンバーの2チームが残る(members[0]衝突で誤dedupしない)");
});

test("同一 op_id の再送は replay として entrant を二重作成しない (review #5: 真のDB冪等)", () => {
  const t = openTournament();
  const mk = () => ({ team_name: "甲", contact_name: "x", contact_email: "x@y.jp",
    entries: [{ event: "男子シングルス", type: "singles", name: "冪等 太郎", team: "甲" }] });
  const r1 = db.createTeamEntry(t.id, mk(), "OP-IDEMP-1");
  assert.strictEqual(r1.entry_count, 1);
  assert.ok(r1.applicant_token);
  // メモリキャッシュを介さない直接再送(=再起動後のコールド再送相当)でも replay 判定される
  const r2 = db.createTeamEntry(t.id, mk(), "OP-IDEMP-1");
  assert.strictEqual(r2.entry_count, 0, "二重作成しない");
  assert.strictEqual(r2.replayed, true);
  assert.strictEqual(r2.applicant_token, "", "平文トークンは保持しないので返さない");
  assert.strictEqual(db.getEntries(t.id).filter(e => e.name === "冪等 太郎").length, 1);
});

test("部分再送(種目追加)は既存申込へ併合し、新旧どちらの申込番号でも全種目が見える (review #8)", () => {
  const t = db.createTournament({ name: "併合検証", date: "2027-01-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [
    { name: "男子シングルス", type: "singles", fee: 700 },
    { name: "女子シングルス", type: "singles", fee: 600 },
  ] });
  const r1 = db.createTeamEntry(t.id, { team_name: "甲", contact_name: "x", contact_email: "x@y.jp",
    entries: [{ event: "男子シングルス", type: "singles", name: "山田 太郎", team: "甲" }] }, "OP-M1");
  const tokenOld = r1.applicant_token;
  // 後から女子シングルスを追加(男子は重複)
  const r2 = db.createTeamEntry(t.id, { team_name: "甲", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "山田 太郎", team: "甲" },
    { event: "女子シングルス", type: "singles", name: "佐藤 花子", team: "甲" },
  ] }, "OP-M2");
  assert.strictEqual(r2.merged, true, "既存申込へ併合");
  assert.strictEqual(r2.entry_count, 1);
  assert.strictEqual(r2.submission_id, r1.submission_id, "同じ申込原本へ");
  const tokenNew = r2.applicant_token;
  for (const [label, tok] of [["旧", tokenOld], ["新", tokenNew]]) {
    const v = db.getSubmissionByToken(tok);
    assert.ok(v.ok, label + "トークンで閲覧可");
    assert.strictEqual(v.entries.length, 2, label + "トークンで全2種目が見える");
    assert.strictEqual(v.total_amount, 1300, label + "トークンで全体合計が出る");
  }
});

test("fixEntrant は許可フィールドのみ更新する", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "甲", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "男子シングルス", type: "singles", name: "山田 太郎", team: "甲" },
  ] });
  const e = db.getEntries(t.id)[0];
  const r = db.fixEntrant(e.id, { furigana: "やまだ たろう", category: "middle" });
  assert.ok(r.ok);
  const after = db.getEntries(t.id)[0];
  assert.strictEqual(after.furigana, "やまだ たろう");
  assert.strictEqual(after.category, "middle");
  assert.ok(db.fixEntrant("no-such-id", { furigana: "x" }).error, "存在しないidはerror");
});
