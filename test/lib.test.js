// 共通ユーティリティ(lib/)の回帰テスト。純粋関数なのでDB不要。
// 実行: node --test test/lib.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { escapeHtml, escapeJs, escapeJsId } = require("../lib/text");
const { eventName } = require("../lib/events");

test("escapeHtml は & < > \" ' の5文字をエスケープ", () => {
  assert.strictEqual(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.strictEqual(escapeHtml(null), "");
  assert.strictEqual(escapeHtml(undefined), "");
});

test("escapeJs は JSON文字列リテラル化", () => {
  assert.strictEqual(escapeJs('a"b'), '"a\\"b"');
  assert.strictEqual(escapeJs(null), '""');
});

test("escapeJsId は英数字以外を _ に", () => {
  assert.strictEqual(escapeJsId("a-b.c 1"), "a_b_c_1");
  assert.strictEqual(escapeJsId(null), "");
});

test("eventName: 種目名がオブジェクトでも内側のname文字列を取り出す(=[object Object]防止)", () => {
  assert.strictEqual(eventName("男子シングルス"), "男子シングルス");
  assert.strictEqual(eventName({ name: "男子ダブルス", fee: 1, type: "doubles" }), "男子ダブルス");
  assert.strictEqual(eventName({ name: { name: "二重ネスト" } }), "二重ネスト");
  assert.strictEqual(eventName(null), "");
});
