// tools/import_quality.js の単体テスト。
// 品質警告(notices)計算を全取込経路で共有するための共通モジュール。
// 氏名はすべて合成(実在の選手名を使わない)。
// 実行: node --test test/import-quality.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { computeNotices, annotateEvents, nameKey, isMergedEventName } = require("../tools/import_quality");

describe("computeNotices: seed_gap", () => {
  it("rawSeeds の欠番を列挙する", () => {
    const players = [{ name: "甲", seed: 1 }, { name: "乙", seed: 2 }, { name: "丙", seed: 5 }];
    const n = computeNotices(players, { format: "singles", rawSeeds: [1, 2, 5] });
    const gap = n.find(x => x.type === "seed_gap");
    assert.ok(gap, "seed_gap がある");
    assert.strictEqual(gap.count, 2, "3,4 の2件");
    assert.match(gap.detail, /3,4/);
  });

  it("rawSeeds 未指定なら players[].seed から算出する", () => {
    const players = [{ name: "甲", seed: 1 }, { name: "乙", seed: 3 }];
    const n = computeNotices(players, { format: "singles" });
    const gap = n.find(x => x.type === "seed_gap");
    assert.ok(gap && gap.count === 1, "2 が欠番");
  });

  it("連番で欠番なしなら seed_gap は出ない", () => {
    const players = [{ name: "甲", seed: 1 }, { name: "乙", seed: 2 }, { name: "丙", seed: 3 }];
    const n = computeNotices(players, { format: "singles", rawSeeds: [1, 2, 3] });
    assert.ok(!n.find(x => x.type === "seed_gap"));
  });

  it("欠番が20件超なら detail 末尾に … が付く", () => {
    const seeds = [1]; for (let s = 23; s <= 40; s++) seeds.push(s); // 2..22 が欠番 → 21件
    const players = seeds.map((s, i) => ({ name: "選手" + i, seed: s }));
    const gap = computeNotices(players, { format: "singles", rawSeeds: seeds }).find(x => x.type === "seed_gap");
    assert.ok(gap.count > 20);
    assert.match(gap.detail, /…$/);
  });
});

describe("computeNotices: dup_name", () => {
  it("同一氏名の重複を検出する(空白は無視)", () => {
    const players = [{ name: "田中 太郎" }, { name: "田中太郎" }, { name: "佐藤 花子" }];
    const dup = computeNotices(players, { format: "singles" }).find(x => x.type === "dup_name");
    assert.ok(dup, "dup_name がある");
    assert.strictEqual(dup.count, 1, "田中太郎 の1種");
    assert.match(dup.detail, /田中太郎×2/);
  });

  it("重複が無ければ dup_name は出ない", () => {
    const players = [{ name: "甲" }, { name: "乙" }];
    assert.ok(!computeNotices(players, { format: "singles" }).find(x => x.type === "dup_name"));
  });
});

describe("computeNotices: pair_missing", () => {
  it("doubles で相方欠落を数える", () => {
    const players = [{ name: "A", partner_name: "B" }, { name: "C" }, { name: "D" }];
    const pm = computeNotices(players, { format: "doubles" }).find(x => x.type === "pair_missing");
    assert.ok(pm && pm.count === 2, "相方欠落2組");
  });

  it("doubles 以外では pair_missing を出さない", () => {
    const players = [{ name: "A" }, { name: "C" }];
    assert.ok(!computeNotices(players, { format: "singles" }).find(x => x.type === "pair_missing"));
  });
});

describe("annotateEvents", () => {
  it("notices が無い event に計算結果を付ける", () => {
    const events = [{ event: "男子シングルス", format: "singles", players: [{ name: "甲", seed: 1 }, { name: "乙", seed: 3 }] }];
    annotateEvents(events);
    assert.ok(Array.isArray(events[0].notices), "notices が付く");
    assert.ok(events[0].notices.find(n => n.type === "seed_gap"));
  });

  it("計算結果も既存 notices も空なら notices プロパティを作らない", () => {
    const events = [{ event: "e", format: "singles", players: [{ name: "甲", seed: 1 }, { name: "乙", seed: 2 }] }];
    annotateEvents(events);
    assert.strictEqual(events[0].notices, undefined, "空なら未定義のまま");
  });

  it("既存 type は上書きせず保全する(二重計上しない)", () => {
    const events = [{
      event: "e", format: "singles",
      players: [{ name: "甲", seed: 1 }, { name: "甲", seed: 3 }], // dup_name + seed_gap の両方が計算対象
      notices: [{ type: "dup_name", count: 99, detail: "パーサ提供の元 notice" }],
    }];
    annotateEvents(events);
    const dup = events[0].notices.filter(n => n.type === "dup_name");
    assert.strictEqual(dup.length, 1, "dup_name は1件のまま(二重計上しない)");
    assert.strictEqual(dup[0].count, 99, "既存 notice を優先し上書きしない");
    assert.ok(events[0].notices.find(n => n.type === "seed_gap"), "無かった type(seed_gap)は追加される");
  });
});

describe("nameKey", () => {
  it("半角/全角スペースを除去する", () => {
    assert.strictEqual(nameKey("田中 太郎"), "田中太郎");
    assert.strictEqual(nameKey("田中　太郎"), "田中太郎");
  });
});

describe("isMergedEventName (複数種目シート名の検出)", () => {
  it("2種目を結合したシート名は true", () => {
    assert.ok(isMergedEventName("混合ダブルス・男子ダブルス"));
    assert.ok(isMergedEventName("一般女子シングルス・女子ダブルス"));
    assert.ok(isMergedEventName("男子シングルス／女子シングルス"));
  });
  it("単一種目・区切りなしは false", () => {
    assert.ok(!isMergedEventName("混合ダブルス"));
    assert.ok(!isMergedEventName("一般男子シングルス"));
    assert.ok(!isMergedEventName("男子団体"));
    assert.ok(!isMergedEventName(""));
  });
  it("区切りがあっても種目語が片側だけなら false", () => {
    assert.ok(!isMergedEventName("一般・男子シングルス")); // 種目語は1つ(シングルス)のみ
  });
});
