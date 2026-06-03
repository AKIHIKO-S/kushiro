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

// ── 実データ監査で見つかった失敗パターンの回帰(合成フィクスチャ=PII無し) ──

test("過大カウント撲滅: 同居する検算名簿(同名再掲)を氏名dedupで畳む", () => {
  // 左にブラケット(seed1-4, col0-2)、右方の別列(col8-10)に同じ4名を別順/別番号で再掲した名簿。
  const N = ["山田 太郎", "佐藤 次郎", "鈴木 三郎", "田中 四郎"];
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push([i + 1, N[i], "(C" + i + ")", "", "", "", "", "", i + 1, N[3 - i], "(別表記" + i + ")"]);
  }
  const players = P.extractSheet(ws(rows));
  assert.strictEqual(players.length, 4, "名簿の二重計上を畳んで4人(8でない)");
  assert.deepStrictEqual(new Set(players.map(p => p.name)), new Set(N), "4名が一意");
});

test("番号リセットするブロック(年代別型)は誤って畳まない", () => {
  // 2ブロックが各々 seed 1..3 を振り直す。別人なので6人のまま(ロスター誤判定で半減させない)。
  const rows = [
    [1, "青木 一", "(A)", "", "", "", "", "", 1, "卜部 七", "(G)"],
    [2, "石田 二", "(B)", "", "", "", "", "", 2, "江口 八", "(H)"],
    [3, "上田 三", "(C)", "", "", "", "", "", 3, "大野 九", "(I)"],
  ];
  const players = P.extractSheet(ws(rows));
  assert.strictEqual(players.length, 6, "別人6人を畳まない");
});

test("右ブロックの氏名が c-3 でも取得(会長杯型オフセット)", () => {
  // seedは col5、氏名は c-3(col2)、所属は c-1(col4)
  const sheet = ws([
    ["", "", "山田 太郎", "", "(A)", 1],
    ["", "", "佐藤 次郎", "", "(B)", 2],
    ["", "", "鈴木 三郎", "", "(C)", 3],
  ]);
  const players = P.extractSheet(sheet);
  assert.strictEqual(players.length, 3, "c-3の右ブロックを取得");
  assert.ok(players.some(p => p.name === "佐藤 次郎"), "氏名取得");
});

test("結合シート: 見出しで2種目に分割(seedはセクション内ローカル)", () => {
  const wb = XLSX.utils.book_new();
  const sheet = ws([
    ["○一般男子シングルス", "", "", ""],
    [1, "山田 太郎", "(A)", "釧路"],
    [2, "佐藤 次郎", "(B)", "十勝"],
    [3, "鈴木 三郎", "(C)", "北見"],
    ["", "", "", ""],
    ["○一般女子シングルス", "", "", ""],
    [1, "花子 一", "(D)", "釧路"],
    [2, "桃子 二", "(E)", "十勝"],
    [3, "梅子 三", "(F)", "北見"],
  ]);
  XLSX.utils.book_append_sheet(wb, sheet, "シングルス");
  const fp = "/tmp/ktta_merged_" + process.pid + ".xlsx";
  XLSX.writeFile(wb, fp);
  try {
    const out = P.parseSeedList(fp);
    assert.strictEqual(out.events.length, 2, "2種目に分割");
    assert.ok(out.events.some(e => /男子/.test(e.event)) && out.events.some(e => /女子/.test(e.event)), "男女別");
    out.events.forEach(e => assert.strictEqual(e.players.length, 3, "各3人"));
  } finally { try { require("fs").rmSync(fp, { force: true }); } catch (e) {} }
});

test("ブロック見出し(Ａブロック等)では分割しない(単一ブラケットを誤分割しない)", () => {
  assert.strictEqual(P.sheetSections(ws([
    ["男子シングルスＡブロック", "", "", ""],
    [1, "山田 太郎", "(A)", "釧路"],
    ["男子シングルスＢブロック", "", "", ""],
    [40, "佐藤 次郎", "(B)", "十勝"],
  ])), null, "ブロック見出しはセクション分割しない");
});

test("重複管理シート: 単独なら本物として残す / クリーン併存なら除外", () => {
  const fs = require("fs");
  let seq = 0;
  const mk = (sheets) => {
    const wb = XLSX.utils.book_new();
    sheets.forEach(([nm, rows]) => XLSX.utils.book_append_sheet(wb, ws(rows), nm));
    const fp = "/tmp/ktta_dup_" + process.pid + "_" + (seq++) + ".xlsx";
    XLSX.writeFile(wb, fp); return fp;
  };
  const body = [[1, "山田 太郎", "(A)", "釧路"], [2, "佐藤 次郎", "(B)", "十勝"], [3, "鈴木 三郎", "(C)", "北見"]];
  // ① ニッタク型: 【重複管理】サフィックスのみ → 残す(singles, doublesに誤判定しない)
  const fp1 = mk([["男子シングルス【重複管理】", body]]);
  // ② なごやか型: クリーン併存 → 重複管理版を除外
  const fp2 = mk([["男子シングルス", body], ["【重複管理】男子シングルス", body]]);
  try {
    const o1 = P.parseSeedList(fp1);
    assert.strictEqual(o1.events.length, 1, "単独【重複管理】は1種目として残る");
    assert.strictEqual(o1.events[0].format, "singles", "『複』を doubles 誤判定しない");
    const o2 = P.parseSeedList(fp2);
    assert.strictEqual(o2.events.length, 1, "クリーン併存時は重複管理版を除外し1種目");
  } finally { [fp1, fp2].forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) {} }); }
});

test("団体: 英数字チーム名(infinity/Rball等)も looksLikeTeamName で取得", () => {
  assert.ok(P.looksLikeTeamName("infinity") && P.looksLikeTeamName("Rball") && P.looksLikeTeamName("AMATAKUB"), "英数字チーム名は真");
  assert.ok(P.looksLikeTeamName("森の友") && P.looksLikeTeamName("湖陵高校男子１"), "和名チーム名も真");
  assert.ok(!P.looksLikeTeamName("安藤 育恵"), "『姓 名』個人名(チーム接尾辞なし)は偽=団体リーフでない");
  const players = P.extractSheet(ws([
    [1, "infinity", "", ""],
    [2, "Rball", "", ""],
    [3, "森の友", "", ""],
    [4, "AMATAKUB", "", ""],
  ]), null, P.looksLikeTeamName);
  assert.strictEqual(players.length, 4, "英数字含む4チームを取得");
});

test("PDF入力は明示エラー(無言クラッシュしない)", () => {
  const fs = require("fs");
  const fp = "/tmp/ktta_fake_" + process.pid + ".pdf";
  fs.writeFileSync(fp, "%PDF-1.4\n...");
  try {
    assert.throws(() => P.parseSeedList(fp), /PDF入力/, "PDFは明示エラー");
  } finally { try { fs.rmSync(fp, { force: true }); } catch (e) {} }
});
