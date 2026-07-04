// PDFパーサのダブルス別所属分離の回帰 (WP2-4-2)。
//   従来は partner_team = team 固定で別チームペアを取れなかった。所属が2つ見つかれば分離し、
//   1つなら partner_team を空にする(Python emit.py と同じ「単一所属は空」契約)。
// 合成 items(座標付き)で extractDoublesPlayers を直接検証(PDFフィクスチャ不要)。氏名は合成。
// 実行: node --test test/pdf-doubles-team.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { _internal } = require("../tools/parse_pdf_bracket");

// x が右へ増える座標系。左山の位置番号1つに対し、名前2つ+所属を near 領域に置く。
// midX = (leftX+rightX)/2 = 250。左側収集は x∈[posX+1, 250], y∈[pos.y±12]。
function makeItems(teamStrs) {
  const posX = 100, posY = 50;
  const items = [
    { str: "甲野 一郎", x: 140, y: 46 },
    { str: "乙田 二郎", x: 140, y: 54 },
  ];
  teamStrs.forEach((t, i) => items.push({ str: t, x: 200, y: 46 + i * 8 }));
  const classification = {
    leftX: posX, rightX: 400,
    leftPositions: [{ x: posX, y: posY, value: 1 }],
    rightPositions: [],
  };
  return { items, classification };
}

describe("PDF ダブルス: 別所属の分離", () => {
  it("所属が2つあると team / partner_team に分離する", () => {
    const { items, classification } = makeItems(["(北陽高校)", "(道東クラブ)"]);
    const players = _internal.extractDoublesPlayers(items, classification, "混合ダブルス");
    assert.strictEqual(players.length, 1, "1ペア");
    const p = players[0];
    assert.strictEqual(p.name, "甲野 一郎");
    assert.strictEqual(p.partner_name, "乙田 二郎");
    assert.strictEqual(p.team, "北陽高校");
    assert.strictEqual(p.partner_team, "道東クラブ", "別所属が分離される");
  });

  it("所属が1つなら partner_team は空(importer が team を継承)", () => {
    const { items, classification } = makeItems(["(ワンスター)"]);
    const players = _internal.extractDoublesPlayers(items, classification, "混合ダブルス");
    assert.strictEqual(players.length, 1);
    assert.strictEqual(players[0].team, "ワンスター");
    assert.strictEqual(players[0].partner_team, "", "単一所属は partner_team 空");
  });
});
