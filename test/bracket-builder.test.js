// 空トーナメント表 作成ツール(gas/bracket_builder.gs)の骨格検証。
//
// 元ソフト「トーナメント作成ソフト for_mac.xls」の出力(トーナメント表シート)を実測して
// 得た事実を、そのまま期待値にする:
//   ・参加者78名 → 128枠・不戦勝50
//   ・1回戦の試合番号は14個しか無い(不戦勝には番号を振らない)
//   ・以降の回戦は 32 / 16 / 8 / 4 / 2 / 1 で計7回戦
//   ・試合番号形式は4種(1-1形式 / 101形式 / 通し番号 / なし)
// 実行: node --test test/bracket-builder.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// GAS を Node 上で評価して純ロジックだけ取り出す(トップレベルは定数と関数定義のみ)
const SRC = fs.readFileSync(path.join(__dirname, "..", "gas", "bracket_builder.gs"), "utf8");
const sandbox = { console, JSON, String, Number, Array, Object, Math, Date, Error };
vm.createContext(sandbox);
vm.runInContext(SRC + "\n;globalThis.__api = { bbSeedOrder, bbBuildStructure, bbAssignNumbers,"
  + " bbIsFacing, bbSplitHalves };", sandbox);
const G = sandbox.__api;
const G2 = sandbox.__api;   // 対面(両山)まわり

const build = (n, style) => G.bbAssignNumbers(G.bbBuildStructure(n), style || "1-1形式");
// vm 内で作られた配列は host の Array と別realmで deepStrictEqual が通らない。
// 比較に使うものは必ず Array.from でホスト側へ写す(このセッションで何度も踏んだ罠)。
const arr = (x) => Array.from(x);
const roundSizes = (st) => arr(st.rounds).map(g => arr(g).filter(x => x.played).length);

// ── 標準シード配置 ────────────────────────────────────────────
test("シード配置は上位どうしが早く当たらない標準の並び", () => {
  assert.deepStrictEqual(Array.from(G.bbSeedOrder(4)), [1, 4, 3, 2]);
  assert.deepStrictEqual(Array.from(G.bbSeedOrder(8)), [1, 8, 5, 4, 3, 6, 7, 2]);
  const o16 = Array.from(G.bbSeedOrder(16));
  assert.strictEqual(o16.length, 16);
  assert.strictEqual(o16[0], 1, "第1シードは先頭");
  assert.strictEqual(o16[o16.length - 1], 2, "第2シードは最後(決勝まで当たらない)");
  assert.deepStrictEqual(o16.slice().sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1),
    "1..16が過不足なく1回ずつ");
});

test("どの大きさでも1位と2位は反対の山に入る", () => {
  [8, 16, 32, 64, 128].forEach(size => {
    const o = Array.from(G.bbSeedOrder(size));
    const i1 = o.indexOf(1), i2 = o.indexOf(2);
    assert.ok(i1 < size / 2 && i2 >= size / 2, size + "枠: 1位と2位が同じ山にいる");
  });
});

// ── 元ファイルの実測値と一致するか ──────────────────────────────
test("78名は128枠・不戦勝50・1回戦14試合(元ファイルの実測と一致)", () => {
  const st = build(78);
  assert.strictEqual(st.size, 128);
  assert.strictEqual(st.byes, 50);
  assert.deepStrictEqual(roundSizes(st), [14, 32, 16, 8, 4, 2, 1],
    "元ファイルの試合番号の個数(H列14/I列32/J列16/K列8/L列4/M列2/N列1)と同じ");
  assert.strictEqual(st.rounds.length, 7, "7回戦");
});

test("試合の総数は必ず 参加者数-1", () => {
  [4, 5, 7, 8, 16, 17, 33, 64, 78, 100, 128, 129, 256].forEach(n => {
    const st = build(n);
    const played = arr(st.rounds).reduce((s, g) => s + arr(g).filter(x => x.played).length, 0);
    assert.strictEqual(played, n - 1, n + "名: 1人が優勝するまでに必要な試合数");
  });
});

test("枠は2の累乗に切り上がり、不戦勝は差分ぶん", () => {
  const cases = [[4, 4, 0], [5, 8, 3], [8, 8, 0], [9, 16, 7], [78, 128, 50], [128, 128, 0], [129, 256, 127]];
  cases.forEach(([n, size, byes]) => {
    const st = build(n);
    assert.strictEqual(st.size, size, n + "名の枠数");
    assert.strictEqual(st.byes, byes, n + "名の不戦勝数");
  });
});

// ── 通し番号 ────────────────────────────────────────────────
test("通し番号は不戦勝を飛ばして上から1..参加者数", () => {
  const st = build(78);
  const nos = arr(st.slots).filter(s => !s.bye).map(s => s.no);
  assert.deepStrictEqual(nos, Array.from({ length: 78 }, (_, i) => i + 1));
  assert.ok(arr(st.slots).filter(s => s.bye).every(s => s.no === 0), "不戦勝の枠に番号は振らない");
});

test("不戦勝は上位シードに付く(標準配置)", () => {
  const st = build(5);                       // 8枠・不戦勝3 → シード1,2,3が不戦勝
  const byeRanks = arr(st.slots).filter(s => s.bye).map(s => s.rank).sort((a, b) => a - b);
  assert.deepStrictEqual(byeRanks, [1, 2, 3]);
});

// ── 試合番号の形式(元ソフトの4種) ───────────────────────────────
test("1-1形式: 回戦-試合番号", () => {
  const st = build(8, "1-1形式");
  const r1 = arr(st.rounds[0]).map(g => g.label);
  assert.deepStrictEqual(r1, ["1-1", "1-2", "1-3", "1-4"]);
  assert.deepStrictEqual(arr(st.rounds[1]).map(g => g.label), ["2-1", "2-2"]);
  assert.deepStrictEqual(arr(st.rounds[2]).map(g => g.label), ["3-1"]);
});

test("101形式: 回戦と試合番号をつなげる", () => {
  const st = build(8, "101形式");            // 8枠 → 1回戦は4試合 → 桁数は4の桁数=1
  assert.deepStrictEqual(arr(st.rounds[0]).map(g => g.label), ["11", "12", "13", "14"]);
  const big = build(128, "101形式");         // 128枠 → 1回戦64試合 → 2桁
  assert.strictEqual(big.rounds[0][0].label, "101", "1回戦第1試合");
  assert.strictEqual(big.rounds[2][3].label, "304", "3回戦第4試合(操作説明の例と同じ)");
});

test("通し番号形式: 1回戦第1試合から決勝まで連番", () => {
  const st = build(8, "通し番号");
  const all = arr(st.rounds).flatMap(g => arr(g).map(x => x.label));
  assert.deepStrictEqual(all, ["1", "2", "3", "4", "5", "6", "7"]);
});

test("なし: 試合番号を出さない", () => {
  const st = build(16, "なし");
  assert.ok(arr(st.rounds).flatMap(g => arr(g)).every(g => g.label === ""));
});

test("不戦勝の試合には番号を振らない(番号が飛ばない)", () => {
  const st = build(5, "1-1形式");            // 8枠・不戦勝3 → 1回戦は1試合だけ
  const r1 = arr(st.rounds[0]);
  assert.strictEqual(r1.filter(g => g.played).length, 1);
  assert.deepStrictEqual(r1.filter(g => g.played).map(g => g.label), ["1-1"],
    "実際に行う試合だけに1-1から順に振る");
  assert.ok(r1.filter(g => !g.played).every(g => g.label === ""));
});

// ── 入力の受け付け方 ────────────────────────────────────────
test("4人未満は理由を添えて断る", () => {
  [0, 1, 3, -5].forEach(n => {
    assert.throws(() => G.bbBuildStructure(n), /4以上/, n + " を通してはいけない");
  });
});

test("小数は切り捨てて扱う", () => {
  assert.strictEqual(G.bbBuildStructure(16.7).count, 16);
});

test("4人ちょうどでも成立する(最小の表)", () => {
  const st = build(4);
  assert.strictEqual(st.size, 4);
  assert.strictEqual(st.byes, 0);
  assert.deepStrictEqual(roundSizes(st), [2, 1]);
});

// ── 勝ち上がりの構造 ────────────────────────────────────────
test("各回戦の試合数は枠の半分ずつ減る(不戦勝を含む論理上の対戦)", () => {
  const st = build(78);
  assert.deepStrictEqual(arr(st.rounds).map(g => g.length), [64, 32, 16, 8, 4, 2, 1]);
});

test("1回戦で不戦勝どうしが当たることはない(上位シードは散らばる)", () => {
  [5, 9, 17, 33, 78].forEach(n => {
    const st = build(n);
    const bothBye = arr(st.rounds[0]).filter(g => st.slots[g.lo].bye && st.slots[g.hi].bye);
    assert.strictEqual(bothBye.length, 0, n + "名: 不戦勝どうしの枠ができている");
  });
});

// ══ 対面(両山)形式 ═══════════════════════════════════════════
// 元ソフトの既定は両山。ただし操作説明の制限どおり「4名以上7名までは片山のみ」。
// 両山は左右の山を同じ行に並べるので、紙に載る高さ(片山の半分)になる。

test("8名以上は対面(両山)、7名までは片山", () => {
  [4, 5, 6, 7].forEach(n => assert.strictEqual(G2.bbIsFacing(n), false, n + "名は片山"));
  [8, 9, 16, 78, 128].forEach(n => assert.strictEqual(G2.bbIsFacing(n), true, n + "名は両山"));
});

test("左右の山に同数ずつ分かれ、決勝が中央に1つ残る", () => {
  const st = build(78);
  const h = G2.bbSplitHalves(st);
  assert.strictEqual(h.perHalf, 6, "128枠なら各山6回戦 + 決勝で7回戦");
  assert.strictEqual(arr(h.left).length, 6);
  assert.strictEqual(arr(h.right).length, 6);
  arr(h.left).forEach((g, i) => {
    assert.strictEqual(arr(g).length, arr(h.right[i]).length, (i + 1) + "回戦の試合数が左右で同じ");
  });
  assert.ok(h.fin, "決勝がある");
});

test("左右あわせた試合数は全体と一致する(取りこぼさない)", () => {
  [8, 16, 33, 78, 128].forEach(n => {
    const st = build(n);
    const h = G2.bbSplitHalves(st);
    const half = arr(h.left).concat(arr(h.right))
      .reduce((s, g) => s + arr(g).filter(x => x.played).length, 0);
    const total = half + (h.fin.played ? 1 : 0);
    assert.strictEqual(total, n - 1, n + "名: 左右+決勝で 参加者数-1 試合");
  });
});

test("1回戦の試合は左右に振り分けられる(片方に寄らない)", () => {
  const st = build(78);
  const h = G2.bbSplitHalves(st);
  assert.strictEqual(arr(h.left[0]).length, 32, "128枠の1回戦は左右32ずつ");
  assert.strictEqual(arr(h.right[0]).length, 32);
});

test("通し番号は左の山に1..k、右の山に続きが入る", () => {
  const st = build(16);           // 16枠・不戦勝0 → 左1..8 / 右9..16
  const half = st.size / 2;
  const leftNos = arr(st.slots).slice(0, half).map(s => s.no);
  const rightNos = arr(st.slots).slice(half).map(s => s.no);
  assert.deepStrictEqual(leftNos, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual(rightNos, [9, 10, 11, 12, 13, 14, 15, 16]);
});

test("不戦勝がある場合も、左の山から順に番号が続く", () => {
  const st = build(12);           // 16枠・不戦勝4
  const nos = arr(st.slots).filter(s => !s.bye).map(s => s.no);
  assert.deepStrictEqual(nos, Array.from({ length: 12 }, (_, i) => i + 1), "上から通しで1..12");
});
