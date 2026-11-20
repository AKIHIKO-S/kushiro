// 申込フォームの二重申込の防止(サーバー側の判定)の回帰テスト。
//
// 守らせる不変条件:
//   ① 同じ団体名(表記ゆれを吸収)・同じ申込者名の有効な申込があるとき、新規の申込はエラーになる。
//      同名団体でも申込者が違えば通る
//   ② 取り消し済みだけの申込は対象外(再び申し込める)
//   ③ 「同じ種目に同じ名前の選手」の有無は、別種目では「なし」。取り消した選手も「なし」
//   ④ 自分の申込を直している最中は、自分自身の出場を数えない
// 実行: node --test test/duplicate-guard.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_dupguard_" + process.pid + ".db");
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const M = "一般男子シングルス", F = "一般女子シングルス";
function setup() {
  const t = db.createTournament({ name: "二重申込検証大会", date: "2099-12-06" });
  db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "", event_config: [{ name: M, type: "singles", fee: 700 }, { name: F, type: "singles", fee: 700 }] });
  return db.getTournament(t.id);
}
let n = 0;
function apply(t, team, contact, event, player, opts) {
  return db.createTeamEntry(t.id, {
    team_name: team, contact_name: contact, contact_tel: "0154-00-0000", contact_email: "dup@example.com",
    entries: [{ event, type: "singles", name: player, furigana: "かくう " + (++n), team }],
  }, "op-dup-" + (++n), { enforce: true, reject_registered: true, ...(opts || {}) });
}
const PUBLIC = { reject_same_applicant: true };

test("① 同じ団体・同じ申込者の再送信はエラー(表記ゆれを吸収)。申込者が違えば通る", () => {
  const t = setup();
  const a = apply(t, "架空クラブ", "検証 担当", M, "架空 太郎", PUBLIC);
  assert.ok(!a.error, a.error);
  const again = apply(t, " 架空ＣＬＵＢ ".replace("ＣＬＵＢ", "クラブ"), "検証　担当", M, "架空 次郎", PUBLIC);
  assert.ok(again.error && again.duplicate_applicant, "全角空白・前後の空白でも同じ団体・同じ申込者として弾く");
  assert.ok(!again.error.includes("架空 太郎"), "他の選手名は出さない");
  const upper = db.createTeamEntry(t.id, { team_name: "ＴＵ ｎｉｏｎ", contact_name: "甲 乙", contact_tel: "1", contact_email: "u@example.com", entries: [{ event: M, type: "singles", name: "別 人一", furigana: "べつ ひといち", team: "x" }] }, "op-u1", { enforce: true, ...PUBLIC });
  assert.ok(!upper.error, upper.error);
  const upper2 = db.createTeamEntry(t.id, { team_name: "tu nion", contact_name: "甲　乙", contact_tel: "1", contact_email: "u@example.com", entries: [{ event: F, type: "singles", name: "別 人二", furigana: "べつ ひとに", team: "x" }] }, "op-u2", { enforce: true, ...PUBLIC });
  assert.ok(upper2.error && upper2.duplicate_applicant, "半角・大文字小文字のゆれも同じ団体として扱う");
  const other = apply(t, "架空クラブ", "別の 担当", F, "架空 花子", PUBLIC);
  assert.ok(!other.error, "同名団体でも申込者が違えば弾かない: " + other.error);
  // 運営の操作(公開フォームの経路ではない)は弾かない
  const admin = apply(t, "架空クラブ", "検証 担当", F, "架空 三郎", {});
  assert.ok(!admin.error, "運営の追加は弾かない: " + admin.error);
});

test("② 取り消し済みだけの申込は対象外", () => {
  const t = setup();
  const a = apply(t, "取消クラブ", "取消 担当", M, "取消 太郎", PUBLIC);
  assert.ok(!a.error, a.error);
  assert.ok(apply(t, "取消クラブ", "取消 担当", F, "取消 次郎", PUBLIC).error, "有効な申込があるうちは弾く");
  const view = db.getSubmissionEditView(a.submission_id, { admin: true });
  const r = db.editSubmission(a.submission_id, { entries: view.entries.map(e => ({ entrant_id: e.entry_id, cancel: true })), reason: "検証" }, { actor: "admin" });
  assert.ok(!r.error, r.error);
  const again = apply(t, "取消クラブ", "取消 担当", F, "取消 次郎", PUBLIC);
  assert.ok(!again.error, "取り消した後は申し込める: " + again.error);
});

test("③④ 同名警告: 同種目だけ・取消は除く・自分の申込は除く。返すのは真偽だけ", () => {
  const t = setup();
  const a = apply(t, "警告クラブ", "警告 担当", M, "警告 太郎");
  assert.ok(!a.error, a.error);
  assert.strictEqual(db.isNameEnteredInEvent(t.id, M, "警告 太郎"), true);
  assert.strictEqual(db.isNameEnteredInEvent(t.id, M, "警告　太郎"), true, "空白のゆれ");
  assert.strictEqual(db.isNameEnteredInEvent(t.id, F, "警告 太郎"), false, "別種目(別性別)は対象外");
  assert.strictEqual(db.isNameEnteredInEvent(t.id, M, "警告 花子"), false);
  assert.strictEqual(db.isNameEnteredInEvent(t.id, M, "太"), false, "短すぎる入力は照会しない");
  assert.strictEqual(typeof db.isNameEnteredInEvent(t.id, M, "警告 太郎"), "boolean", "団体名・人数・申込番号は返さない");
  // ④ 自分の申込を直している最中
  assert.strictEqual(db.isNameEnteredInEvent(t.id, M, "警告 太郎", a.submission_id), false, "自分の申込の出場は数えない");
  const b = apply(t, "別のクラブ", "別 担当", F, "別 花子");
  assert.strictEqual(db.isNameEnteredInEvent(t.id, F, "別 花子", a.submission_id), true, "他の申込の出場は数える");
  // ② 取り消した選手は「なし」
  const view = db.getSubmissionEditView(b.submission_id, { admin: true });
  db.editSubmission(b.submission_id, { entries: view.entries.map(e => ({ entrant_id: e.entry_id, cancel: true })), reason: "検証" }, { actor: "admin" });
  assert.strictEqual(db.isNameEnteredInEvent(t.id, F, "別 花子"), false);
});

test("⑤ 警告の文面は一般的で、団体名・人数・申込番号の欄を持たない", () => {
  const src = fs.readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  const a = src.indexOf('"/api/public/tournaments/:id/check-duplicate"');
  const b = src.indexOf('app.get("/api/public/tournaments/:id/suggest/teams"');
  const block = src.slice(a, b);
  assert.ok(/res\.json\(\{ duplicate:/.test(block), "公開の確認APIは duplicate だけを返す");
  assert.ok(!/team_name|submission_id|count/.test(block.replace(/_dupBudget/g, "")), "団体名・申込番号・件数を返す処理がない");
  const form = fs.readFileSync(require("path").join(__dirname, "..", "entry_form.js"), "utf8");
  assert.ok(form.includes("同じ名前の選手が、この種目に既に申込されている可能性があります。二重申込でないか確認してください"));
});
