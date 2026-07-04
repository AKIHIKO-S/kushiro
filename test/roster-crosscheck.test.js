// 名簿クロスチェックの回帰 (WP2-1/2-2)。
//   前半: roster_reader.extractRoster が名簿系シート/ブラケット内収穫から氏名を集める。
//   後半: import_quality.crossCheck が missing/extra/variant/dup を検出し、
//         名簿完全一致なら警告ゼロ・roster空でも events を素通しする。
// 氏名はすべて合成(実在の選手名を使わない)。
// 実行: node --test test/roster-crosscheck.test.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const XLSX = require("xlsx");
const { extractRoster } = require("../tools/roster_reader");
const { crossCheck, strictKey, looseKey } = require("../tools/import_quality");

// ブラケットシート([seed,氏名,(所属)]縦並び)+【重複管理】名簿シートを持つ合成ブック。
function buildBook(p) {
  const wb = XLSX.utils.book_new();
  const bracket = XLSX.utils.aoa_to_sheet([
    [1, "甲山 一郎", "(A会)"], [2, "乙川 二郎", "(B会)"], [3, "丙田 三郎", "(C会)"],
    [4, "丁原 四郎", "(D会)"], [5, "戊野 五郎", "(E会)"],
  ]);
  XLSX.utils.book_append_sheet(wb, bracket, "男子シングルス");
  // 名簿シート: ブラケットの5名 + 取りこぼし1名(己島六郎)
  const roster = XLSX.utils.aoa_to_sheet([
    ["甲山 一郎"], ["乙川 二郎"], ["丙田 三郎"], ["丁原 四郎"], ["戊野 五郎"], ["己島 六郎"],
  ]);
  XLSX.utils.book_append_sheet(wb, roster, "【重複管理】男子シングルス");
  XLSX.writeFile(wb, p);
}

describe("roster_reader.extractRoster", () => {
  const FX = path.join(os.tmpdir(), `ktta_roster_${process.pid}.xlsx`);
  before(() => buildBook(FX));
  after(() => { try { fs.rmSync(FX, { force: true }); } catch (e) {} });

  it("名簿系シートとブラケット内収穫から氏名を集める", () => {
    const r = extractRoster(FX, {});
    assert.ok(!r.error, "エラーなし");
    const bySrc = {};
    r.entries.forEach(e => { bySrc[e.source] = (bySrc[e.source] || 0) + 1; });
    assert.ok(bySrc.roster_sheet >= 6, "名簿シートから6名以上: " + JSON.stringify(bySrc));
    assert.ok(bySrc.harvest >= 5, "ブラケット列から5名以上収穫: " + JSON.stringify(bySrc));
    // sheetBase が付く
    assert.ok(r.entries.every(e => e.sheetBase), "sheetBase が付与される");
  });

  it("PDF は pdf_unsupported を返す", () => {
    const pdf = path.join(os.tmpdir(), `ktta_roster_${process.pid}.pdf`);
    fs.writeFileSync(pdf, "%PDF-1.4\n...");
    try {
      const r = extractRoster(pdf, {});
      assert.strictEqual(r.error, "pdf_unsupported");
      assert.deepStrictEqual(r.entries, []);
    } finally { try { fs.rmSync(pdf, { force: true }); } catch (e) {} }
  });
});

describe("import_quality.crossCheck", () => {
  const scope = "男子シングルス";
  it("名簿にいるがブラケットに無い → roster_missing", () => {
    const events = [{ event: scope, format: "singles", players: [{ name: "甲山一郎" }, { name: "乙川二郎" }] }];
    const roster = [
      { name: "甲山一郎", sheetBase: scope }, { name: "乙川二郎", sheetBase: scope },
      { name: "丙田三郎", sheetBase: scope },   // missing
    ];
    crossCheck(events, roster);
    const m = (events[0].notices || []).find(n => n.type === "roster_missing");
    assert.ok(m && m.count === 1, "取りこぼし1名: " + JSON.stringify(events[0].notices));
    assert.match(m.detail, /丙田三郎/);
  });

  it("異体字違いは roster_variant (missing にしない)", () => {
    const events = [{ event: scope, format: "singles", players: [{ name: "高橋花子" }] }];
    const roster = [{ name: "髙橋花子", sheetBase: scope }];
    crossCheck(events, roster);
    const types = (events[0].notices || []).map(n => n.type);
    assert.ok(types.includes("roster_variant"), "variant を検出: " + JSON.stringify(events[0].notices));
    assert.ok(!types.includes("roster_missing"), "異体字は missing にしない");
  });

  it("ブラケットにいるが名簿に無い → roster_extra", () => {
    const events = [{ event: scope, format: "singles", players: [{ name: "甲山一郎" }, { name: "誤読 太郎" }] }];
    const roster = [{ name: "甲山一郎", sheetBase: scope }];
    crossCheck(events, roster);
    const ex = (events[0].notices || []).find(n => n.type === "roster_extra");
    assert.ok(ex && ex.count === 1, "過大1名: " + JSON.stringify(events[0].notices));
  });

  it("harvest 由来の名簿は突合に使わない(自己比較の誤警告を防ぐ)", () => {
    const events = [{ event: scope, format: "singles", players: [{ name: "甲山一郎" }] }];
    // source=harvest のみ → 独立参照にならないので警告しない
    const roster = [
      { name: "甲山一郎", sheetBase: scope, source: "harvest" },
      { name: "居ないはず", sheetBase: scope, source: "harvest" },
    ];
    crossCheck(events, roster);
    assert.ok(!(events[0].notices || []).some(n => n.type.startsWith("roster_")), "harvest だけでは警告しない");
  });

  it("名簿完全一致なら roster 系 notices はゼロ", () => {
    const events = [{ event: scope, format: "singles", players: [{ name: "甲山一郎" }, { name: "乙川二郎" }] }];
    const roster = [{ name: "甲山一郎", sheetBase: scope }, { name: "乙川二郎", sheetBase: scope }];
    crossCheck(events, roster);
    const roster類 = (events[0].notices || []).filter(n => n.type.startsWith("roster_"));
    assert.strictEqual(roster類.length, 0, "警告なし: " + JSON.stringify(events[0].notices));
  });

  it("スコープが一致しない名簿は使わない(誤警告しない)", () => {
    const events = [{ event: "女子ダブルス", format: "doubles", players: [{ name: "甲山一郎", partner_name: "乙川二郎" }] }];
    const roster = [{ name: "別種目選手", sheetBase: "男子シングルス" }];
    crossCheck(events, roster);
    assert.ok(!(events[0].notices || []).some(n => n.type.startsWith("roster_")), "無関係な名簿では警告しない");
  });

  it("roster 空でも events を素通しする", () => {
    const events = [{ event: scope, format: "singles", players: [{ name: "甲山一郎" }] }];
    const out = crossCheck(events, []);
    assert.strictEqual(out, events);
    assert.ok(!events[0].notices, "警告は付かない");
  });

  it("strictKey/looseKey: 空白除去と異体字畳み込み", () => {
    assert.strictEqual(strictKey("田中 太郎"), "田中太郎");
    assert.strictEqual(looseKey("髙橋"), looseKey("高橋"));
  });
});
