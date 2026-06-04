// 衛生: 印影未設定の領収書が、存在しない seal.png を参照せず「印」枠を直接描くこと
// (0バイト/未配置の画像への404往復を出さない)。実アップロード時は seal_url が渡れば画像を描く。
// 実行: node --test test/seal-receipt.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const reports = require("../reports");

const t = { name: "テスト大会", date: "2027-01-01" };
const ents = [{ team: "A中", name: "山田 太郎", event: "S", fee: 500, division: "general" }];

test("印影未設定: 「印」枠を直接描き seal.png を参照しない", () => {
  const html = reports.buildReceiptsHTML(t, ents, {});
  assert.match(html, /class="no-seal"/, "「印」枠がある");
  assert.ok(!/shared\/assets\/seal\.png/.test(html), "存在しない seal.png を参照しない");
  assert.ok(!/<img src=""[^>]*alt="印鑑"/.test(html), "空src の印鑑imgを出さない");
});

test("印影あり: seal_url を渡せば画像を描く(onerrorフォールバック付き)", () => {
  const html = reports.buildReceiptsHTML(t, ents, { seal_url: "/uploads/seal.png" });
  assert.match(html, /<img src="\/uploads\/seal\.png"[^>]*alt="印鑑"/, "実印影を描く");
  assert.match(html, /onerror=/, "読込失敗時の「印」フォールバックを保持");
});
