// 役員の自己登録(承認待ち → オーナーが承認)の回帰テスト。ライブラリ(lib/operator-accounts.js)を直接検証する。
//
// 守らせる不変条件:
//   ① 登録すると「承認待ち」。パスワードが合っていても、承認前はログインできない(承認待ちと伝わる)
//   ② 承認するとログインできる。却下すると申請が消え、同じアドレスで申し込み直せる
//   ③ 承認前のアカウントは、パスワード再設定の発行で承認を回避できない
//   ④ 既に登録のあるアドレスで申し込んでも、既存のアカウントは変わらない(created:false)
//   ⑤ 承認待ちは30件まで。承認前のアカウントにオーナー権限は付けられない
//   ⑥ 既存のアカウント(招待で作ったもの)は、従来どおり承認済みとして動く
// 実行: node --test test/operator-register.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { createOperatorAccounts } = require("../lib/operator-accounts");

const PW = "Fixture-pass1";

test("① 登録すると承認待ち。承認前はパスワードが合ってもログインできない", async () => {
  const a = createOperatorAccounts(":memory:");
  const r = await a.register("yakuin@example.invalid", "役員 太郎", PW);
  assert.deepStrictEqual(r, { created: true });
  const row = a.list().find(x => x.email === "yakuin@example.invalid");
  assert.strictEqual(row.status, "awaiting");
  assert.strictEqual(row.name, "役員 太郎");
  assert.deepStrictEqual(await a.login("yakuin@example.invalid", PW), { pending: true }, "合っていても承認待ち");
  assert.deepStrictEqual(await a.login("yakuin@example.invalid", "Wrong-pass9"), {}, "違うパスワードは区別なく拒否");
  assert.strictEqual(a.session("x".repeat(43)), null);
});

test("② 承認するとログインできる。却下すると消えて申し込み直せる", async () => {
  const a = createOperatorAccounts(":memory:");
  await a.register("ok@example.invalid", "承認 花子", PW);
  const id = a.list().find(x => x.email === "ok@example.invalid").id;
  assert.strictEqual(a.approve(id), true);
  assert.strictEqual(a.approve(id), false, "承認済みには効かない");
  const login = await a.login("ok@example.invalid", PW);
  assert.ok(login.id && login.token, "承認後はログインできる");
  assert.strictEqual(a.session(login.token).principal_type, "admin", "オーナー権限は付かない");
  assert.strictEqual(a.session(login.token).name, "承認 花子");

  await a.register("ng@example.invalid", "却下 次郎", PW);
  const ng = a.list().find(x => x.email === "ng@example.invalid").id;
  assert.strictEqual(a.reject(ng), true);
  assert.ok(!a.list().some(x => x.email === "ng@example.invalid"), "申請が消える");
  assert.deepStrictEqual(await a.register("ng@example.invalid", "却下 次郎", PW), { created: true }, "申し込み直せる");
  assert.strictEqual(a.reject(id), false, "承認済みのアカウントは却下で消えない");
});

test("③ 承認前は、パスワード再設定の発行で承認を回避できない", async () => {
  const a = createOperatorAccounts(":memory:");
  await a.register("bypass@example.invalid", "回避 三郎", PW);
  assert.strictEqual(a.issueReset("bypass@example.invalid"), null, "承認前は再設定を発行しない");
  const id = a.list()[0].id;
  a.approve(id);
  assert.ok(a.issueReset("bypass@example.invalid"), "承認後は発行できる");
});

test("④ 登録済みアドレスで申し込んでも、既存のアカウントは変わらない", async () => {
  const a = createOperatorAccounts(":memory:");
  await a.register("dup@example.invalid", "最初 四郎", PW);
  const id = a.list()[0].id;
  a.approve(id);
  const again = await a.register("dup@example.invalid", "乗っ取り 犯", "Other-pass9!");
  assert.deepStrictEqual(again, { created: false });
  const login = await a.login("dup@example.invalid", PW);
  assert.ok(login.id, "元のパスワードのまま");
  assert.strictEqual(a.list()[0].name, "最初 四郎", "氏名も変わらない");
});

test("⑤ 承認待ちは30件まで。承認前にオーナー権限は付けられない", async () => {
  const a = createOperatorAccounts(":memory:");
  for (let i = 0; i < 30; i++) assert.deepStrictEqual(await a.register(`u${i}@example.invalid`, "氏名" + i, PW), { created: true });
  assert.deepStrictEqual(await a.register("over@example.invalid", "超過", PW), { full: true });
  const id = a.list()[0].id;
  assert.deepStrictEqual(a.setOwner(id, true), { error: "not_active" }, "承認前は付けられない");
  a.approve(id);
  assert.ok(a.setOwner(id, true).ok, "承認後は付けられる");
});

test("⑥ 招待で作った既存のアカウントは、従来どおり承認済みとして使える", async () => {
  const a = createOperatorAccounts(":memory:");
  const inv = a.issue("invited@example.invalid");
  const acc = await a.accept(inv.token, PW, "招待 五郎");
  assert.ok(acc.id);
  const login = await a.login("invited@example.invalid", PW);
  assert.ok(login.id && login.token);
  assert.strictEqual(a.list().find(x => x.email === "invited@example.invalid").status, "active");
  // オーナーが招待を出すと、承認待ちの申請も承認されてログインできる(オーナーが明示的に招いたため)
  await a.register("both@example.invalid", "両方 六郎", PW);
  const inv2 = a.issue("both@example.invalid");
  assert.ok((await a.accept(inv2.token, "New-pass99!", "両方 六郎")).id);
  assert.ok((await a.login("both@example.invalid", "New-pass99!")).id);
});
