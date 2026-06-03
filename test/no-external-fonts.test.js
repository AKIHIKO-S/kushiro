// オフライン縮退の不変条件: 配信物・生成帳票・CSP に外部フォント(Google Fonts)依存が無いこと。
// standalone単機オフラインで viewer/admin/帳票がネット不通でも崩れないことを構造的に保証する。
// 実行: node --test test/no-external-fonts.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const files = [
  "public/shared/common.css",
  "public/viewer/index.html",
  "public/admin/index.html",
  "server.js",
  "reports.js",
  "entry_form.js",
];

test("外部フォント(fonts.googleapis/gstatic)への参照がどこにも無い", () => {
  const hits = [];
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, "utf8");
    s.split("\n").forEach((line, i) => {
      if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(hits, [], "外部フォント参照が残っている: " + hits.join(", "));
});

test("CSP に外部フォント許可(googleapis/gstatic)が残っていない(攻撃面縮小)", () => {
  const s = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(!/font-src[^\n;]*gstatic/.test(s), "font-src に gstatic が残存");
  assert.ok(!/style-src[^\n;]*googleapis/.test(s), "style-src に googleapis が残存");
});
