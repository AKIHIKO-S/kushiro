// 運営アカウントの氏名の登録・修正(右上の「ログイン中」を氏名で出すための土台)の回帰テスト。
// 守らせる不変条件: ① 氏名を入れるとセッションの name に出る ② 空欄で未登録に戻る(表示はメールに戻る)
// ③ 40文字超・制御文字は拒否 ④ 存在しないアカウントは not_found
// 実行: node --test test/operator-name.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOperatorAccounts } = require("../lib/operator-accounts");

test("氏名の登録・修正・未登録に戻す", async () => {
  const ops = createOperatorAccounts(":memory:");
  const inv = ops.issue("staff@example.com");
  const acc = ops.list().find(a => a.email === "staff@example.com");
  assert.equal(acc.name, "");
  assert.deepEqual(ops.setName(acc.id, "  釧路 太郎 "), { ok: true, name: "釧路 太郎" });
  assert.equal(ops.list().find(a => a.id === acc.id).name, "釧路 太郎");
  assert.deepEqual(ops.setName(acc.id, ""), { ok: true, name: "" });
  assert.equal(ops.list().find(a => a.id === acc.id).name, "");
  assert.equal(ops.setName(acc.id, "あ".repeat(41)).error, "invalid");
  assert.equal(ops.setName(acc.id, "a<b>").error, "invalid");
  assert.equal(ops.setName("nope", "太郎").error, "not_found");
  assert.ok(inv.token);
});
