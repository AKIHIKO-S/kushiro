// 外部申込フォームHTML生成の回帰テスト。
// escapeJs()の戻り値(JSON.stringify済み=クォート込み)をテンプレート側でさらに
// シングルクォートで囲んでしまい、FORM_TYPEが二重クォート化(例: '"largeball_national_2026"')
// されるとGAS側のFORM_CONFIG参照が外れ、"不明なフォーム種別"で早期リターンし
// スプレッドシート書き込み・通知メールが一切行われないまま静かに失敗する不具合があった
// (largeball系フォームのみ。masters2026はFORM_TYPEが静的コードのため無関係)。
const { test } = require("node:test");
const assert = require("node:assert");
const {
  buildMasters2026FormHTML,
  buildLargeballNational2026FormHTML,
  buildLargeballAllJapan2026FormHTML,
} = require("../external_forms.js");

function extractFormType(html) {
  const m = html.match(/var FORM_TYPE=(.*?), FORM_NAME=(.*?);/);
  assert.ok(m, "FORM_TYPE/FORM_NAME代入行が見つかること");
  return {
    formType: Function("return " + m[1])(),
    formName: Function("return " + m[2])(),
  };
}

test("masters2026: FORM_TYPEが二重クォート化されていない", () => {
  const html = buildMasters2026FormHTML({ gas_url: "" });
  const { formType } = extractFormType(html);
  assert.strictEqual(formType, "masters_2026");
});

test("largeball-national2026: FORM_TYPEが二重クォート化されていない", () => {
  const html = buildLargeballNational2026FormHTML({ gas_url: "" });
  const { formType, formName } = extractFormType(html);
  assert.strictEqual(formType, "largeball_national_2026");
  assert.strictEqual(formName, "第39回全国ラージボール卓球大会 北海道予選");
});

test("largeball-alljapan2026: FORM_TYPEが二重クォート化されていない", () => {
  const html = buildLargeballAllJapan2026FormHTML({ gas_url: "" });
  const { formType, formName } = extractFormType(html);
  assert.strictEqual(formType, "largeball_alljapan_2026");
  assert.strictEqual(formName, "第9回全日本ラージボール卓球選手権大会 北海道予選");
});
