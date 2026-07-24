// GAS単体ツール(gas/blank_bracket.gs)のジオメトリ計算部の回帰テスト。
// GAS本体はGoogle上でしか動かないため、SpreadsheetApp非依存の純関数部
// (bracketPositions / computeBlankBracket)をNodeで読み込んで検証する。
// .gs は require 対象外の拡張子なので、一時ファイルに .js としてコピーして読む
// (evalや new Function による動的評価はしない)。
//   ・bracketPositions が db.js の同名関数と全サイズで一致(プラットフォームと同配置)
//   ・枠番号 1..N が漏れなく出る / BYEはレールを作らない
//   ・不戦勝の線延長・中央(決勝)太線・縦線の範囲整合
// 実行: node --test test/gas-blank-bracket.test.js
process.env.DB_PATH = "/tmp/ktta_gasblank_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../db");

const GAS_JS = path.join(os.tmpdir(), "ktta_gas_blank_bracket_" + process.pid + ".js");
fs.copyFileSync(path.join(__dirname, "..", "gas", "blank_bracket.gs"), GAS_JS);
const gas = require(GAS_JS);

after(() => {
  try { fs.rmSync(GAS_JS, { force: true }); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

test("bracketPositions が db.js と全サイズで一致(プラットフォームと同じ標準配置)", () => {
  for (const size of [2, 4, 8, 16, 32, 64, 128]) {
    assert.deepStrictEqual(gas.bracketPositions(size), db.bracketPositions(size), "size=" + size);
  }
});

test("枠番号 1..N が漏れなく出る(N=2,3,5,13,16,127,128)", () => {
  for (const N of [2, 3, 5, 13, 16, 127, 128]) {
    const g = gas.computeBlankBracket(N, { event: "検証" });
    const nums = [];
    g.values.forEach(row => row.forEach(v => { if (/^\d+$/.test(v)) nums.push(parseInt(v)); }));
    nums.sort((a, b) => a - b);
    assert.deepStrictEqual(nums, Array.from({ length: N }, (_, i) => i + 1), "N=" + N);
    // 選手レール(氏名〜シード列の下罫線)はちょうどN本
    const rails = g.hlines.filter(L => L.c2 - L.c1 >= 2);
    assert.strictEqual(rails.length, N, "N=" + N + " のレール本数");
  }
});

test("不戦勝(BYE)の線延長: 1回戦の片側BYEはBYE数ぶんの単セル横線になる", () => {
  const N = 13, S = 16;                       // BYE 3 (標準位置=ランク14,15,16の相方)
  const g = gas.computeBlankBracket(N, {});
  assert.strictEqual(g.S, S);
  // 1回戦列(LADV(1)=4 / RADV(1)=CENTER+sideR)の横線 = 対戦(山)と延長の合計 S/2 本
  const sideR = Math.log2(S) - 1;
  const r1cols = new Set([4, g.CENTER + sideR]);
  const r1h = g.hlines.filter(L => L.c1 === L.c2 && r1cols.has(L.c1));
  assert.strictEqual(r1h.length, S / 2);
  // 縦線(小さい山)は 対戦カード数 = S/2 - BYE数 = 5 本(1回戦列のみ)
  const r1v = g.vlines.filter(V => r1cols.has(V.c));
  assert.strictEqual(r1v.length, S / 2 - (S - N));
});

test("決勝の太線が中央列に1本だけあり、全罫線が表領域に収まる", () => {
  for (const N of [2, 3, 16, 128]) {
    const g = gas.computeBlankBracket(N, {});
    const thick = g.hlines.filter(L => L.thick);
    assert.strictEqual(thick.length, 1, "N=" + N);
    assert.strictEqual(thick[0].c1, g.CENTER, "N=" + N);
    g.hlines.forEach(L => { assert.ok(L.r >= 0 && L.r < g.rows && L.c1 <= L.c2 && L.c2 < g.cols, "N=" + N); });
    g.vlines.forEach(V => { assert.ok(V.r1 <= V.r2 && V.r2 < g.rows && V.c < g.cols, "N=" + N); });
    g.merges.forEach(M => { assert.ok(M.r + M.nr <= g.rows && M.c + M.nc <= g.cols, "N=" + N); });
  }
});

test("境界値: 1/129/小数/非数はエラー、2と128は成立", () => {
  assert.ok(gas.computeBlankBracket(2, {}).rows > 0);
  assert.ok(gas.computeBlankBracket(128, {}).rows > 0);
  assert.throws(() => gas.computeBlankBracket(1, {}), /2〜128/);
  assert.throws(() => gas.computeBlankBracket(129, {}), /2〜128/);
  assert.throws(() => gas.computeBlankBracket(16.5, {}), /2〜128/);
  assert.throws(() => gas.computeBlankBracket("abc", {}), /2〜128/);
});
