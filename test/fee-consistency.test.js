// 会計突合の回帰: 集計表Excel・領収書・確認メールの合計が一致すること(区分=中高生の学割を反映)。
// 旧実装は集計表が cnt×バケット単価F(学割無視)で算出し、領収書(per-member m.fee)・メール(fee_student)と
// 食い違っていた(同一バケットに一般/中高生混在で過大計上)。
// 実行: node --test test/fee-consistency.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const XLSX = require("xlsx");
const reports = require("../reports");
const mailer = require("../mailer");

const tournament = {
  name: "突合テスト大会", date: "2027-01-01",
  event_config: JSON.stringify([
    { name: "一般男子ダブルス", fee: 2000 },
    { name: "中学生男子ダブルス", fee: 2000, fee_student: 800 },
    { name: "中学生男子シングルス", fee: 1000, fee_student: 500 },
  ]),
};
// 同一バケット(doubles_male)に一般(2000)と中学生(学割800)が混在するケース。
const entrants = [
  { event: "一般男子ダブルス", team: "X高", name: "山田 太郎", partner_name: "鈴木 一", is_doubles: true, division: "general", category: "general", fee: 2000 },
  { event: "中学生男子ダブルス", team: "X高", name: "田中 二", partner_name: "佐藤 三", is_doubles: true, division: "middle", category: "middle", fee: 800 },
  { event: "中学生男子シングルス", team: "X高", name: "高橋 四", is_doubles: false, division: "middle", category: "middle", fee: 500 },
];
const EXPECTED = 2000 + 800 + 500; // = 3300 (per-member の確定額を合算)

function aggregationTotal(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets["集計用"], { header: 1 });
  let total = 0;
  // データ行(No.列=col0が数値)の合計列(最終列)のみ合算。価格行(col0=null)やヘッダ・性別行は除外。
  rows.forEach(r => { if (typeof r[0] === "number" && typeof r[r.length - 1] === "number") total += r[r.length - 1]; });
  return total;
}

test("会計突合: 領収書・集計表・確認メールの合計が一致(学割反映)", () => {
  const rl = reports.buildReceiptsList(tournament, entrants);
  assert.strictEqual(rl.grand_total, EXPECTED, "領収書合計が学割反映の per-member 合算");

  const aggTotal = aggregationTotal(reports.buildAggregationXlsx(tournament, entrants));
  assert.strictEqual(aggTotal, EXPECTED, "集計表Excelの合計が領収書と一致(cnt×F でない)");

  const entries = entrants.map(e => ({ event: e.event, division: e.division }));
  assert.strictEqual(mailer.authoritativeFees(tournament, entries).total, EXPECTED, "確認メールの合計も一致");

  assert.strictEqual(rl.grand_total, aggTotal, "領収書合計 == 集計表合計(突合)");
});

test("会計突合: 差し込み用(印刷領収書データ)の各団体合計も per-member 基準", () => {
  // 領収書リストの各団体 total(=差し込み用シートの基)が学割反映であること
  const rl = reports.buildReceiptsList(tournament, entrants);
  const x = rl.items.find(i => i.team === "X高");
  assert.ok(x, "X高 の領収書項目");
  assert.strictEqual(x.total, EXPECTED, "団体合計が 3300(学割反映)");
});
