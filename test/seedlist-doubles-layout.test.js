// ダブルスのレイアウト判定回帰: 「横並び・所属カッコ無し(seed|名1|名2|所属1|所属2)」と
// 「縦並び(seed|名1|所属1 / 次行 名2|所属2)」を取り違えないことを保証する。
//  - 横並び(なごやか亭/ヤサカ杯男子ミックスの clean seed-list)は ① 所属がカッコ無しのため
//    旧実装では②縦ペアに誤落ちし、相方を所属に取違え+連続行を誤結合していた。
//  - 「直下のseed列に番号があるか」で横/縦を確実に分離する。
// 実行: node --test test/seedlist-doubles-layout.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const XLSX = require("xlsx");
const { extractDoubles, looksLikeName } = require("../tools/parse_bracket_seedlist.js");

test("カッコを含む文字列は氏名と判定しない(複数行所属カッコの断片を弾く)", () => {
  // Nittaku杯/なごやか亭の罫線表は所属カッコが複数行に折返し、閉じ括弧の断片がセルに残る。
  assert.strictEqual(looksLikeName("Neo倶楽部）"), false, "閉じ括弧つきの所属断片は氏名でない");
  assert.strictEqual(looksLikeName("（釧路市役所・"), false, "開き括弧つきの所属断片は氏名でない");
  assert.strictEqual(looksLikeName("ワンスターTTC）"), false, "団体名＋）は氏名でない");
  // 通常の氏名は従来どおり氏名と判定される
  assert.strictEqual(looksLikeName("桐山 慶次郎"), true, "通常の氏名は氏名");
  assert.strictEqual(looksLikeName("難波 心愛"), true);
});

function sheetFromAoa(aoa) {
  return XLSX.utils.aoa_to_sheet(aoa, { cellDates: false });
}
const byName = (arr) => { const m = {}; arr.forEach(p => m[p.name] = p); return m; };

test("横並び・所属カッコ無し(seed|名1|名2|所属1|所属2)を正しいペアに分解", () => {
  // なごやか亭 col46-50 / ヤサカ杯男子ミックス col23-27 と同型
  const ws = sheetFromAoa([
    ["男子ダブルス", "", "", "", ""],
    ["", "", "", "", ""],
    [1, "佐々木 憲継", "藤井 星輝", "infinity", "infinity"],
    [2, "有岡 稔史", "佐藤 彰朗", "ＭＰＣ", "ＭＰＣ"],
    [3, "藤田 修司", "佐藤 太志", "ＭＰＣ", "ＭＰＣ"],
    [4, "河合 馨", "山本 満", "Ｔ-union", "ＭＰＣ"],
  ]);
  const out = extractDoubles(ws, null);
  assert.strictEqual(out.length, 4, "4ペア抽出: " + JSON.stringify(out.map(p => [p.name, p.partner_name])));
  const m = byName(out);
  const p1 = m["佐々木 憲継"];
  assert.ok(p1, "佐々木憲継のペアがある");
  assert.strictEqual(p1.partner_name, "藤井 星輝", "相方=藤井星輝(所属に取違えない): " + JSON.stringify([p1.name, p1.team, p1.partner_name, p1.partner_team]));
  assert.strictEqual(p1.team, "infinity", "本人所属=infinity");
  assert.strictEqual(p1.partner_team, "infinity", "相方所属=infinity");
  // 所属の違うペア(本人/相方で別所属)も分離して持つ
  const p4 = m["河合 馨"];
  assert.strictEqual(p4.partner_name, "山本 満");
  assert.strictEqual(p4.team, "Ｔ-union", "本人所属");
  assert.strictEqual(p4.partner_team, "ＭＰＣ", "相方所属(本人と別)");
});

test("縦並び(seed|名1|所属1 / 次行 名2|所属2)は従来どおり正しく読む(回帰)", () => {
  // ヤサカ一般 女子ダブルスと同型。partner 行には seed が無い。
  const ws = sheetFromAoa([
    ["女子ダブルス", "", ""],
    ["", "", ""],
    [1, "難波 心愛", "ワンスターTTC"],
    ["", "速水 唯夏", "ワンスターTTC"],
    [2, "本間 冨士子", "クラブ柏"],
    ["", "市橋 良子", "クラブ柏"],
    [3, "盛田 真菜", "釧路高専"],
    ["", "曽我 佳加", "釧路高専"],
  ]);
  const out = extractDoubles(ws, null);
  assert.strictEqual(out.length, 3, "3ペア: " + JSON.stringify(out.map(p => [p.name, p.partner_name])));
  const m = byName(out);
  const p1 = m["難波 心愛"];
  assert.ok(p1, "難波のペアがある");
  assert.strictEqual(p1.partner_name, "速水 唯夏", "相方=速水唯夏(直下行)");
  assert.strictEqual(p1.team, "ワンスターTTC", "本人所属");
  assert.strictEqual(p1.partner_team, "ワンスターTTC", "相方所属");
});

test("結合単独セル(『A・B』を1セル)は、分割ペアが併存するとき冗長として除去", () => {
  // ブラケット配置セル(結合表記)とクリーンなシードリスト(分割)が同一シートに併存する旧式。
  // seed列を2系統置く(左=結合配置, 右=分割リスト)。分割側を正本に、結合側は落とす。
  const ws = sheetFromAoa([
    ["男子ダブルス", "", "", "",  "", "", "", "", ""],
    ["", "", "", "",  "", "", "", "", ""],
    // 左: 結合配置セル [seed, 'A・B', '(所属)'] / 右: 分割リスト [seed, 名1, 名2, 所属1, 所属2]
    [1, "大野・馬場", "（市役所）", "",  1, "大野 浩", "馬場 慶子", "市役所", "ファイターズ"],
    [2, "佐々木・藤井", "（infinity）", "",  2, "佐々木 憲継", "藤井 星輝", "infinity", "infinity"],
    [3, "菊池・菊池", "（ワンスター）", "",  3, "菊池 真澄", "菊池 敬子", "ワンスター", "NEO倶楽部"],
  ]);
  const out = extractDoubles(ws, null);
  // 結合セル(大野・馬場 等)は落ち、分割ペア3件のみ残る
  assert.strictEqual(out.length, 3, "分割3ペアのみ: " + JSON.stringify(out.map(p => [p.name, p.partner_name])));
  assert.ok(out.every(p => !/[・／/]/.test(p.name)), "結合表記の氏名が残っていない");
  const m = byName(out);
  assert.ok(m["大野 浩"], "分割側(大野浩)が残る");
  assert.strictEqual(m["大野 浩"].partner_name, "馬場 慶子");
  assert.strictEqual(m["大野 浩"].partner_team, "ファイターズ");
});

test("結合表記しか無い場合は正本として温存(分割が皆無なら落とさない)", () => {
  const ws = sheetFromAoa([
    ["男子ダブルス", "", ""],
    ["", "", ""],
    [1, "大野・馬場", "（市役所）"],
    [2, "佐々木・藤井", "（infinity）"],
    [3, "菊池・菊池", "（ワンスター）"],
  ]);
  const out = extractDoubles(ws, null);
  assert.strictEqual(out.length, 3, "結合のみ=3件温存: " + JSON.stringify(out.map(p => p.name)));
});

test("縦並び・共通所属が2行目のみに記載の場合でも選手1に所属が伝播する", () => {
  // 3ペア以上ないとリーフ列フィルタに弾かれるため4ペア用意
  const ws = sheetFromAoa([
    [1, "粥川 一郎"],                         // 所属なし(共通所属は2行目)
    ["", "野村 次郎", "ワンスターTTC"],       // 所属は2行目のみ
    [2, "前 三郎"],
    ["", "小山内 四郎", "ワンスターTTC"],
    [3, "田中 一朗"],
    ["", "鈴木 次朗", "釧路クラブ"],
    [4, "佐藤 三朗"],
    ["", "高橋 四朗", "釧路クラブ"],
  ]);
  const out = extractDoubles(ws, null);
  assert.strictEqual(out.length, 4, "4ペア");
  const m = byName(out);
  assert.ok(m["粥川 一郎"], "粥川が取得できる");
  assert.strictEqual(m["粥川 一郎"].team, "ワンスターTTC", "2行目の所属が選手1に伝播");
  assert.strictEqual(m["粥川 一郎"].partner_name, "野村 次郎", "相方=野村");
});

test("横並び・所属カッコ付き(男子: seed|名1|名2|(所属))は従来どおり読む(回帰)", () => {
  const ws = sheetFromAoa([
    ["男子ダブルス", "", "", "", ""],
    ["", "", "", "", ""],
    [1, "桐山 慶次郎", "難波 心愛", "（釧友会）", ""],
    [2, "飯島 悦孝", "元井 重子", "（シニアクラブ）", ""],
    [3, "若林 準", "桐山 慶次郎", "（道東）", ""],
  ]);
  const out = extractDoubles(ws, null);
  assert.strictEqual(out.length, 3, "3ペア");
  const m = byName(out);
  assert.strictEqual(m["桐山 慶次郎"].partner_name, "難波 心愛", "相方=難波");
  assert.strictEqual(m["桐山 慶次郎"].team, "釧友会", "所属(カッコ剥がし)");
});
