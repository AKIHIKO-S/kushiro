// 自動返信メール(申込者控え)の回帰テスト。
// 守らせる不変条件:
//   ① 冒頭に要点3行(受付した・支払い場所と金額・変更の期限と申込番号)があり、文字版とHTML版で同じ文言
//   ② 「申込番号」の呼び名は1つ(「申込ID」を併記しない)。団体名・申込者の呼び名がフォーム・台帳と同じ
//   ③ 支払い場所は「本部席裏」。返金不可の注意は文字版にもHTML版にもある
// 実行: node --test test/mail-consistency.test.js
process.env.DB_PATH = ":memory:";
process.env.SMTP_USER = "sender@example.invalid";
process.env.SMTP_PASS = "fixture-only";
process.env.ADMIN_EMAIL = "office@example.invalid";
const { test } = require("node:test");
const assert = require("node:assert");
const nodemailer = require("nodemailer");
const mailer = require("../mailer");

let sent = null;
nodemailer.createTransport = () => ({ sendMail: async m => { sent = m; return { messageId: "<x>", accepted: ["a@example.invalid"] }; } });

test("連絡事項3行・呼び名・支払い場所・返金の注意が文字版とHTML版で一致する", async () => {
  sent = null;
  const r = await mailer.sendConfirmationEmail({
    tournament: { id: "t1", name: "検証大会", date: "2026-12-06", venue: "市民体育館", entry_deadline: "2026-11-30 17:00" },
    formData: { contact_name: "検証 担当", contact_email: "a@example.invalid", contact_tel: "000", team_name: "架空クラブ", entries: [] },
    result: { applicant_token: "ABCD-EFGH-JKLM", total_amount: 3200,
      created_entries: [{ type: "singles", event: "男子シングルス", name: "架空 太郎", team: "架空クラブ", fee: 3200 }] },
    appOrigin: "https://platform.example.invalid",
  });
  assert.ok(r.ok, JSON.stringify(r));
  const { text, html } = sent;
  const points = ["検証大会(12月6日(日)・市民体育館)", "当日は本部席裏で 3,200円 をお支払いください。", "申込内容の変更は 11月30日 まで、この申込番号で行えます。"];
  const head = text.split("下記の内容で承りました。")[0];
  points.forEach(p => { assert.ok(head.includes(p), "文字版の冒頭: " + p); assert.ok(html.includes(p), "HTML版: " + p); });
  assert.ok(!/申込ID/.test(text) && !/申込ID/.test(html), "「申込ID」は使わない");
  assert.ok(text.includes("団体名: 架空クラブ") && html.includes("団体名:"), "団体名");
  assert.ok(text.includes("申込者: 検証 担当") && html.includes("申込者:"), "申込者");
  assert.ok(!/所属:|担当:/.test(text.replace("申込者:", "")) , "所属/担当の呼び名は使わない");
  const refund = "当日のキャンセル・欠席による参加料の返金はできかねます";
  assert.ok(text.includes(refund) && html.includes(refund), "返金不可の注意は両方にある");
  assert.ok(text.includes("本部席裏") && html.includes("本部席裏") && !/開会式前/.test(text + html), "支払い場所は本部席裏");
  assert.ok(html.includes("KUSHIRO TABLE TENNIS ASSOCIATION"), "英語の飾り見出しは残す");
  // 並び: 大見出し → 宛名 → 連絡事項の枠。見出しの繰り返し「申込を受け付けました。」は枠に入れない
  const iH1 = html.indexOf("<h1"), iName = html.indexOf("検証 担当</strong> 様"), iBox = html.indexOf("連絡事項");
  assert.ok(iH1 >= 0 && iH1 < iName && iName < iBox, "HTMLの並び: 大見出し→宛名→連絡事項");
  assert.ok(!html.includes("<li>申込を受け付けました。</li>") && !head.includes("申込を受け付けました。"), "枠に見出しの繰り返しを入れない");
  assert.ok(text.indexOf("検証 担当 様") < text.indexOf("【連絡事項】"), "文字版の並び: 宛名→連絡事項");
  assert.ok(!/要点/.test(text + html), "「要点」の呼び名は使わない");
});

test("日付・会場が未設定の大会は、大会名だけの1行になる", async () => {
  sent = null;
  const r2 = await mailer.sendConfirmationEmail({
    tournament: { id: "t2", name: "日程未定大会", date: "", venue: "" },
    formData: { contact_name: "検証 担当", contact_email: "a@example.invalid", team_name: "架空クラブ", entries: [] },
    result: { applicant_token: "ZZZZ-ZZZZ-ZZZZ", total_amount: 500, created_entries: [{ type: "singles", event: "男子シングルス", name: "架空 太郎", team: "架空クラブ", fee: 500 }] },
    appOrigin: "https://platform.example.invalid",
  });
  assert.ok(r2.ok, JSON.stringify(r2));
  assert.ok(sent.text.includes("  ・日程未定大会\n"), "括弧なしの大会名だけ");
  assert.ok(!sent.text.includes("日程未定大会()"), "空の括弧を出さない");
  assert.ok(sent.html.includes("<li>日程未定大会</li>"));
});
