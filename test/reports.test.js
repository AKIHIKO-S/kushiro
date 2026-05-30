// 帳票(reports.js)の回帰テスト。ビルダーは純粋関数なのでDB不要(entrantsを直接渡す)。
// 集計の「ペア単位課金」「金額」、申込台帳、領収書の合計/内訳を固定。
// 実行: node --test test/reports.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const XLSX = require("xlsx");
const reports = require("../reports");

const T = { id: "t1", name: "テスト大会", date: "2026-12-01", venue: "V" };
// 甲中: 男子シングルス2(@700) + 男子ダブルス1(@1000, パートナーは乙中)
const entrants = [
  { team: "甲中", name: "山 一", display_name: "山 一", furigana: "やま いち", event: "男子シングルス", gender: "male", category: "middle", is_doubles: 0, status: "confirmed" },
  { team: "甲中", name: "川 二", display_name: "川 二", furigana: "かわ に", event: "男子シングルス", gender: "male", category: "middle", is_doubles: 0, status: "confirmed" },
  { team: "甲中", name: "海 三", display_name: "海 三", furigana: "うみ さん", event: "男子ダブルス", gender: "male", is_doubles: 1, partner_name: "空 四", partner_team: "乙中", status: "confirmed" },
];
const FEES = { singles_male: 700, doubles_male: 1000 };

test("buildApplicantsXlsx: フラット申込台帳(2シート・ラベル化・ダブルス相方)", () => {
  const buf = reports.buildApplicantsXlsx(T, entrants, {});
  const wb = XLSX.read(buf, { type: "buffer" });
  assert.deepStrictEqual(wb.SheetNames, ["申込一覧", "大会情報"]);
  const d = XLSX.utils.sheet_to_json(wb.Sheets["申込一覧"], { header: 1 });
  assert.strictEqual(d.length, 4); // ヘッダ + 3件
  const flat = JSON.stringify(d);
  assert.ok(flat.includes("男子"), "性別ラベル");
  assert.ok(flat.includes("中学"), "区分ラベル");
  assert.ok(flat.includes("空 四") && flat.includes("乙中"), "ダブルス相方/所属");
});

test("buildAggregationXlsx: ダブルス=ペア単位課金で甲中合計=2400 (2*700+1*1000)", () => {
  const buf = reports.buildAggregationXlsx(T, entrants, { fees: FEES });
  const wb = XLSX.read(buf, { type: "buffer" });
  const d = XLSX.utils.sheet_to_json(wb.Sheets["集計用"], { header: 1 });
  const row = d.find(r => Array.isArray(r) && r.includes("甲中"));
  assert.ok(row, "甲中の行が存在");
  assert.strictEqual(row[row.length - 1], 2400);
});

test("buildReceiptsHTML: 合計¥2,400・内訳あり・[object Object]なし", () => {
  const html = reports.buildReceiptsHTML(T, entrants, { fees: FEES });
  assert.ok(html.includes("2,400"), "合計2,400");
  assert.ok(/シングルス男子|ダブルス男子/.test(html), "内訳");
  assert.ok(!html.includes("[object Object]"), "オブジェクト混入なし");
});

test("classifyEvent/genderOf: 混合は mixed 分類", () => {
  assert.strictEqual(reports.classifyEvent("混合ダブルス"), "mixed");
  assert.strictEqual(reports.classifyEvent("男子ダブルス"), "doubles");
  assert.strictEqual(reports.classifyEvent("女子シングルス"), "singles");
  assert.strictEqual(reports.classifyEvent("団体戦"), "team");
});
