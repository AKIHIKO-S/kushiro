// 抽選のブロック別人数の手動設定(必須・256枠以上)を検証する。
// 実行: node --test test/block-sizes.test.js
process.env.DB_PATH = "/tmp/ktta_blocksize_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
function setup(n) {
  const t = db.createTournament({ name: "ブロック人数" + n, date: "2027-03-01" });
  for (let i = 1; i <= n; i++) db.createEntrant({ tournament_id: t.id, event: EV,
    name: "選手" + String(i).padStart(3, "0"), team: "ク" + (i % 17), furigana: "せ" + i });
  return t;
}
// ブロック別の実選手リーフ数を matches(R1) から数える
function countPerBlock(tid, size) {
  const ms = db.getMatchesByTournament(tid).filter(m => m.event === EV && m.bracket_round === 1);
  const BLK = 128;
  const counts = new Array(size / BLK).fill(0);
  ms.forEach(m => {
    [[1, m.player1_name], [2, m.player2_name]].forEach(([sk, nm]) => {
      if (nm && nm !== "BYE") counts[Math.floor((2 * (m.bracket_pos || 0) + (sk - 1)) / BLK)]++;
    });
  });
  return counts;
}

test("256枠以上はブロック人数未指定だと needs_block_sizes(推奨割りつき)", () => {
  const t = setup(300);
  const r = db.drawSingleBracket(t.id, EV, { drawn_by: "検証" });
  assert.strictEqual(r.needs_block_sizes, true, JSON.stringify(r).slice(0, 120));
  assert.strictEqual(r.blocks, 4);
  assert.deepStrictEqual(r.suggested, [75, 75, 75, 75]);
});

test("合計不一致は拒否・一致すれば指定どおりにブロックへ配分", () => {
  const t = setup(300);
  const bad = db.drawSingleBracket(t.id, EV, { drawn_by: "検証", block_sizes: [80, 80, 80, 80] });
  assert.strictEqual(bad.needs_block_sizes, true, "合計320≠300は拒否");
  const r = db.drawSingleBracket(t.id, EV, { drawn_by: "検証", block_sizes: [80, 70, 76, 74] });
  assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 120));
  assert.deepStrictEqual(r.block_sizes, [80, 70, 76, 74]);
  assert.deepStrictEqual(countPerBlock(t.id, r.bracket_size), [80, 70, 76, 74], "実リーフ配分が指定どおり");
});

test("128枠以下(1ブロック)は指定不要で従来どおり", () => {
  const t = setup(60);
  const r = db.drawSingleBracket(t.id, EV, { drawn_by: "検証" });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.block_sizes, undefined);
});

test("SS大会(open種目): ブロック人数は指定不要で4ブロック均等自動", () => {
  const t = db.createTournament({ name: "SS大会均等", date: "2027-03-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0, open: true }] });
  for (let i = 1; i <= 306; i++) db.createEntrant({ tournament_id: t.id, event: EV,
    name: "選手" + String(i).padStart(3, "0"), team: "ク" + (i % 19), furigana: "せ" + String(i).padStart(3, "0") });
  const es = db.getEntrants(t.id, EV);
  db.setEntrantSeed(es[0].id, 1); db.setEntrantEntryRound(es[0].id, 4);   // SS必須要件
  const r = db.drawSingleBracket(t.id, EV, { drawn_by: "検証" });   // block_sizes指定なし
  assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 160));
  assert.deepStrictEqual(r.block_sizes, [77, 77, 76, 76], "均等自動割り: " + JSON.stringify(r.block_sizes));
  assert.deepStrictEqual(countPerBlock(t.id, r.bracket_size), [77, 77, 76, 76], "実リーフも均等");
});
