// 種目の性別の判定と色の回帰テスト。
// 守らせる不変条件:
//   ① 種目名・区分名から 男子/女子/混合 を判定し、判定できないものは ""(白)
//   ② Excel用の色(event-gender.js)と CSS のトークン(site-tokens.css)が同じ値
//   ③ 色は文字と地のコントラストが 4.5:1 以上(WCAG AA)
// 実行: node --test test/event-gender.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const G = require("../public/shared/event-gender.js");

test("① 判定", () => {
  const cases = [
    ["男子シングルス", "male"], ["一般女子シングルス", "female"], ["混合ダブルス", "mixed"], ["ミックスダブルス", "mixed"],
    ["男D", "male"], ["女D", "female"], ["PMシニア男", "male"], ["PMシニア女", "female"], ["男女ダブルス", "mixed"],
    ["ミックスD", "mixed"], ["ＭＩＸ混合", "mixed"], ["メンズシングルス", "male"], ["レディースダブルス", "female"],
    ["ラージボール", ""], ["団体戦", ""], ["小学生の部", ""], ["", ""], [null, ""],
  ];
  cases.forEach(([n, want]) => assert.strictEqual(G.of(n), want, String(n)));
  assert.strictEqual(G.of("ホープス", "男子"), "male", "区分名でも判定");
});

const lum = h => { const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("②③ 色はCSSトークンと同じ値で、文字は地に対して4.5:1以上", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "shared", "site-tokens.css"), "utf8");
  for (const k of ["male", "female", "mixed"]) {
    const ink = new RegExp("--st-gx-" + k + "-ink:#([0-9a-f]{6})").exec(css)[1].toUpperCase();
    const tint = new RegExp("--st-gx-" + k + "-tint:#([0-9a-f]{6})").exec(css)[1].toUpperCase();
    assert.strictEqual(ink, G.COLORS[k].ink, k + " ink");
    assert.strictEqual(tint, G.COLORS[k].tint, k + " tint");
    assert.ok(ratio(ink, tint) >= 4.5, k + " 文字/淡い地 " + ratio(ink, tint).toFixed(2));
    assert.ok(ratio(ink, "FFFFFF") >= 4.5, k + " 文字/白 " + ratio(ink, "FFFFFF").toFixed(2));
  }
});
