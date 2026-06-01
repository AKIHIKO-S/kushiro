// 料金整合性の回帰テスト (#17/#26)。
// 領収書/集計(reports) と 確認メール(mailer) が、大会設定(event_config)の参加料を使い、
// クライアント供給の fee/total を信用しないことを確認する。DB 不要 (純関数)。
// 実行: node --test test/fees.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const reports = require("../reports");
const mailer = require("../mailer");

// event_config: 男子シングルス=500, 男子ダブルス=1200 (既定の 700/1000 とは別の値にして「設定が効く」ことを検証)
const tournament = {
  name: "料金検証", date: "2027-04-04",
  event_config: JSON.stringify([
    { name: "男子シングルス", fee: 500 },
    { name: "男子ダブルス", fee: 1200 },
  ]),
};

test("reports.feesFromEventConfig: event_config の料金を kind×gender バケットへ写像 (#17)", () => {
  const F = reports.feesFromEventConfig(tournament);
  assert.strictEqual(F.singles_male, 500, "男子シングルス=500 が反映");
  assert.strictEqual(F.doubles_male, 1200, "男子ダブルス=1200 が反映");
});

test("reports.buildAggregation: 既定でなく event_config 由来の単価を採用 (#17)", () => {
  const entrants = [
    { event: "男子シングルス", team: "甲", category: "general", name: "A" },
    { event: "男子ダブルス", team: "甲", category: "general", name: "B", is_doubles: true, partner_name: "C" },
  ];
  const { fees } = reports.buildAggregation(tournament, entrants, {});
  assert.strictEqual(fees.singles_male, 500, "集計単価が設定の500 (既定700でない)");
  assert.strictEqual(fees.doubles_male, 1200, "集計単価が設定の1200 (既定1000でない)");
});

test("reports.buildAggregation: 明示 fees パラメータは event_config より優先 (#17)", () => {
  const { fees } = reports.buildAggregation(tournament, [], { singles_male: 999 });
  assert.strictEqual(fees.singles_male, 999, "明示パラメータが最優先");
  assert.strictEqual(fees.doubles_male, 1200, "未指定バケットは event_config 由来");
});

test("mailer.authoritativeFees: クライアント供給の fee/total を無視し設定で再計算 (#26)", () => {
  // クライアントは fee を改ざん (singles を 0 と詐称) して total も過少申告
  const entries = [
    { event: "男子シングルス", type: "singles", name: "A", team: "甲", fee: 0 },
    { event: "男子ダブルス", type: "doubles", name1: "B", name2: "C", team: "甲", fee: 0 },
  ];
  const { entries: out, total } = mailer.authoritativeFees(tournament, entries);
  assert.strictEqual(out[0].fee, 500, "男子シングルスの fee はサーバ側で 500 に確定");
  assert.strictEqual(out[1].fee, 1200, "男子ダブルスの fee はサーバ側で 1200 に確定");
  assert.strictEqual(total, 1700, "合計はサーバ側で 1700 (クライアント0申告を無視)");
});

test("mailer.authoritativeFees: event_config に無い任意項目は申込側 fee をフォールバック (#26)", () => {
  const entries = [
    { event: "お弁当", type: "custom", name: "A", team: "甲", fee: 800 },   // 設定外 → クライアント値
    { event: "男子シングルス", type: "singles", name: "B", team: "甲", fee: 99 },  // 設定あり → 500
  ];
  const { total } = mailer.authoritativeFees(tournament, entries);
  assert.strictEqual(total, 800 + 500, "設定外はフォールバック・設定ありは設定値");
});
