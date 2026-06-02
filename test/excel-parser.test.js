// Excel取込(JSシードリストパーサ parse_bracket_seedlist.js)の回帰テスト。
// 実ファイル不要: XLSX.utils で合成ワークシートを作り extractSheet 等を直接検証。
// (従来は Python bracket_parser の selftest のみ。JS主系統にも安全網を張る)
// 実行: node --test test/excel-parser.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const XLSX = require("xlsx");
const P = require("../tools/parse_bracket_seedlist.js"); // { parseSeedList, extractSheet, looksLikeName, isRegionToken }

const ws = (aoa) => XLSX.utils.aoa_to_sheet(aoa);
const bySeed = (players) => { const m = {}; players.forEach(p => m[p.seed] = p); return m; };

test("looksLikeName: 氏名は真 / 整数・地区・構造語・日付は偽", () => {
  ["山田 太郎", "佐藤花子", "鈴木 一", "John Smith 太郎"].forEach(n => assert.ok(P.looksLikeName(n), "名: " + n));
  ["1", "12", "釧路", "決勝", "準々決勝", "BYE", "2025年5月3日", "3-1", "(釧路クラブ)"].forEach(x =>
    assert.ok(!P.looksLikeName(x), "非名: " + x));
});

test("isRegionToken: 既知地区と複合地区を判定", () => {
  ["釧路", "十勝", "北見", "札幌"].forEach(r => assert.ok(P.isRegionToken(r), r));
  assert.ok(P.isRegionToken("釧路/北見"), "複合(ペア地区)");
  assert.ok(P.isRegionToken("十勝・根室"), "複合(中黒)");
  ["スマイルクラブ", "山田 太郎", "12", ""].forEach(x => assert.ok(!P.isRegionToken(x), "非地区: " + x));
});

test("extractSheet: 左ブロック [seed,氏名,(所属),地区] を正しく抽出", () => {
  const sheet = ws([
    ["男子シングルス", "", "", ""],
    [1, "山田 太郎", "(釧路クラブ)", "釧路"],
    [2, "佐藤 次郎", "(十勝TTC)", "十勝"],
    [3, "鈴木 三郎", "(北見クラブ)", "北見"],
    [4, "田中 四郎", "(札幌クラブ)", "札幌"],
  ]);
  const players = P.extractSheet(sheet);
  assert.strictEqual(players.length, 4, "4人抽出");
  const m = bySeed(players);
  assert.strictEqual(m[1].name, "山田 太郎");
  assert.strictEqual(m[1].team, "釧路クラブ", "所属はカッコを剥がす");
  assert.strictEqual(m[1].region, "釧路");
  assert.strictEqual(m[4].name, "田中 四郎");
});

test("extractSheet: 右ブロック(鏡像) [地区,氏名,(所属),seed] を抽出", () => {
  // 右ブロック実形: seed の 2つ左=氏名, 1つ左=所属, 3つ左=地区 (db parser の向き判定に一致)
  const sheet = ws([
    ["釧路", "山田 太郎", "(釧路クラブ)", 1],
    ["十勝", "佐藤 次郎", "(十勝TTC)", 2],
    ["北見", "鈴木 三郎", "(北見クラブ)", 3],
  ]);
  const players = P.extractSheet(sheet);
  assert.strictEqual(players.length, 3, "右ブロック3人");
  const m = bySeed(players);
  assert.strictEqual(m[2].name, "佐藤 次郎");
  assert.strictEqual(m[2].team, "十勝TTC");
});

test("extractSheet: 孤立した整数(密でない列)は誤検出しない", () => {
  const sheet = ws([
    // 主seed列(列0)に4人(密) + 列6に孤立整数9(名前は隣にあるが列単独=除外)
    [1, "山田 太郎", "(A)", "釧路", "", "", 9, "迷子 一"],
    [2, "佐藤 次郎", "(B)", "十勝", "", "", "", ""],
    [3, "鈴木 三郎", "(C)", "北見", "", "", "", ""],
    [4, "田中 四郎", "(D)", "札幌", "", "", "", ""],
  ]);
  const players = P.extractSheet(sheet);
  // 列6の孤立"9"(1件のみ)は密度<3で除外され、主列の4人のみ
  assert.strictEqual(players.length, 4, "孤立整数を除外して4人");
  assert.ok(!players.some(p => p.seed === 9), "孤立seed=9は不採用");
});

test("extractSheet: 4桁の年号(2025等)はseed扱いしない(1-3桁のみ)", () => {
  const sheet = ws([
    ["2025年度大会", "", "", ""],
    [2025, "見出し的な何か", "", ""],   // 4桁=isIntStr不成立
    [1, "山田 太郎", "(A)", "釧路"],
    [2, "佐藤 次郎", "(B)", "十勝"],
    [3, "鈴木 三郎", "(C)", "北見"],
  ]);
  const players = P.extractSheet(sheet);
  assert.strictEqual(players.length, 3, "年号を除き3人");
  assert.ok(!players.some(p => p.seed === 2025), "2025はseed扱いしない");
});

test("parseSeedList: 実xlsxファイル経由でシングルス1種目を取込(format/gender推定込み)", () => {
  const wb = XLSX.utils.book_new();
  const sheet = ws([
    [1, "山田 太郎", "(釧路クラブ)", "釧路"],
    [2, "佐藤 次郎", "(十勝TTC)", "十勝"],
    [3, "鈴木 三郎", "(北見クラブ)", "北見"],
    [4, "田中 四郎", "(札幌クラブ)", "札幌"],
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, "男子シングルス");
  const fp = "/tmp/ktta_seedlist_" + process.pid + ".xlsx";
  XLSX.writeFile(wb, fp);
  try {
    const out = P.parseSeedList(fp);
    assert.ok(out && Array.isArray(out.events) && out.events.length >= 1, "events>=1");
    const ev = out.events[0];
    assert.strictEqual(ev.players.length, 4, "4人");
    assert.ok(/singles|doubles|team/.test(ev.format || "singles"), "format推定");
  } finally {
    try { require("fs").rmSync(fp, { force: true }); } catch (e) {}
  }
});
