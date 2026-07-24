// 白紙トーナメント表(reports.buildBlankBracketXlsx)の出力構造を検証する。
//   ・人数 N を入れるだけで xlsx が生成される(大会・DB 非依存、positionsFn だけ注入)
//   ・枠番号は物理順(上から) 1..N で全て現れる / 氏名セルは空欄(全角スペース)のみ
//   ・BYE(rank > N)は行を作らない=枠番号セルの個数が N 個ちょうど
//   ・境界値: 2 / 1024 は成立、1 / 1025 / 非数はエラー
// 罫線スタイル自体は xlsx-js-style 側の責務のため、ここでは値・構造の不変条件を検証する。
// 実行: node --test test/blank-bracket.test.js
process.env.DB_PATH = "/tmp/ktta_blankbr_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});
const reports = require("../reports");
const XLSX = require("xlsx");

function build(opts) {
  return reports.buildBlankBracketXlsx(Object.assign({ positionsFn: db.bracketPositions }, opts));
}

// シート全セルから「1..N の数字だけのセル」(枠番号)と「氏名相当セル」を数える
function readSheet(buf, sheetName) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const name = sheetName || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  const cells = [];
  Object.keys(ws).forEach(k => {
    if (k[0] === "!") return;
    cells.push({ addr: k, v: String(ws[k].v == null ? "" : ws[k].v) });
  });
  return { wb, ws, cells, name };
}

test("N=13: 枠番号1..13が全て現れ、BYEの行は作られない", () => {
  const buf = build({ size: 13, event: "男子シングルス" });
  const { wb, cells } = readSheet(buf);
  assert.ok(wb.SheetNames.includes("男子シングルス"));
  const nums = cells.filter(c => /^\d+$/.test(c.v)).map(c => parseInt(c.v)).sort((a, b) => a - b);
  assert.deepStrictEqual(nums, Array.from({ length: 13 }, (_, i) => i + 1));
  // 氏名は空欄(全角スペース)のみ=手書き用。実名やbye表記が混入しない
  assert.ok(!cells.some(c => /bye|ｂｙｅ/i.test(c.v)));
});

test("N=16(ちょうど2の累乗): BYEなしで16枠", () => {
  const { cells } = readSheet(build({ size: 16 }));
  const nums = cells.filter(c => /^\d+$/.test(c.v)).map(c => parseInt(c.v));
  assert.strictEqual(nums.length, 16);
  assert.strictEqual(Math.max(...nums), 16);
});

test("ヘッダ: 大会名・種目名・会場が刻印される", () => {
  const buf = build({ size: 8, event: "女子シングルス", title: "白紙検証大会", date: "2027-04-01", venue: "検証体育館" });
  const { cells } = readSheet(buf, "女子シングルス");
  const joined = cells.map(c => c.v).join("|");
  assert.ok(joined.includes("白紙検証大会"));
  assert.ok(joined.includes("女子シングルス  トーナメント表"));
  assert.ok(joined.includes("検証体育館"));
});

test("種目名なし: 既定ラベル「白紙」でシートが立つ", () => {
  const { wb } = readSheet(build({ size: 4 }));
  assert.ok(wb.SheetNames.includes("白紙"));
});

test("取込用シートは付かない(_import/割当表なし=白紙は取込対象外)", () => {
  const { wb } = readSheet(build({ size: 8, event: "男子シングルス" }));
  assert.ok(!wb.SheetNames.includes("_import"));
  assert.ok(!wb.SheetNames.some(n => n.includes("割当表")));
});

test("境界値: 2と1024は成立、1/1025/非数/小数はエラー", () => {
  assert.ok(Buffer.isBuffer(build({ size: 2 })));
  assert.ok(Buffer.isBuffer(build({ size: 1024 })));
  assert.throws(() => build({ size: 1 }), /2〜1024/);
  assert.throws(() => build({ size: 1025 }), /2〜1024/);
  assert.throws(() => build({ size: "abc" }), /2〜1024/);
  assert.throws(() => build({ size: 16.5 }), /2〜1024/);   // parseIntの黙った丸め禁止
  assert.throws(() => reports.buildBlankBracketXlsx({ size: 8 }), /positionsFn/);
});

test("N=2(S=2退化パス): 枠番号[1,2]が構造として出る", () => {
  const { cells } = readSheet(build({ size: 2 }));
  const nums = cells.filter(c => /^\d+$/.test(c.v)).map(c => parseInt(c.v)).sort();
  assert.deepStrictEqual(nums, [1, 2]);
});

test("種目名のExcel禁止文字(: \\ / ? * [ ])はシート名で無害化され破損xlsxを出さない", () => {
  // コロンは xlsx-js-style の検査をすり抜けて破損ファイルになる実績があるため特に固定する
  const buf = build({ size: 4, event: "男子S[一般]/小:中*?" });
  const { wb } = readSheet(buf);
  assert.strictEqual(wb.SheetNames.length, 1);
  assert.ok(!/[:\\/?*[\]]/.test(wb.SheetNames[0]), "シート名に禁止文字が残っている: " + wb.SheetNames[0]);
  // ヘッダ刻印(セル内)は原文のまま
  const { cells } = readSheet(buf);
  assert.ok(cells.some(c => c.v.includes("男子S[一般]/小:中*?  トーナメント表")));
});

test("大規模(N=129, 2ブロック分割)でも枠番号1..129が欠けない", () => {
  const { cells } = readSheet(build({ size: 129 }));
  const nums = cells.filter(c => /^\d+$/.test(c.v)).map(c => parseInt(c.v)).sort((a, b) => a - b);
  assert.strictEqual(nums.length, 129);
  assert.strictEqual(nums[0], 1);
  assert.strictEqual(nums[128], 129);
});
