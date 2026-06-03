// ダブルスの所属分散(team+partner_teamの集合で衝突判定)と Excel 2人併記。
//   ・別クラブ混成ペアでも、共有クラブが1つでもあれば1回戦で当てない(単一キーでは見逃していた穴)
//   ・両山Excelでペアを上下2段(各自の所属併記)で出力
// 実行: node --test test/draw-doubles.test.js
process.env.DB_PATH = "/tmp/ktta_dbl_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const reports = require("../reports");
const XLSX = require("xlsx");
const { mulberry32 } = require("../lib/rng");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

// テスト内でのクラブ集合(実装と同じ規約: ダブルスは team+partner_team)
const clubsOf = (e) => {
  const a = String(e.team || "").trim();
  const b = (e.is_doubles ? String(e.partner_team || "").trim() : "");
  const out = []; if (a) out.push(a); if (b && b !== a) out.push(b); return out;
};
const overlap = (xs, ys) => xs.some(x => ys.indexOf(x) >= 0);

test("ダブルス: 共有クラブのあるペアは1回戦で当たらない(集合分散)", () => {
  // 「釧路卓友」を team か partner_team に含むペアが4組(別クラブ混成)。残り4組はユニーク。
  // 8枠=4試合=各試合に釧路卓友を1組ずつ=分離可能。単一キー(team)では team が異なるため
  // 見逃して同枠に来ていたが、集合判定なら必ず別試合に散る。
  const base = [
    { id: "d1", team: "釧路卓友", partner_team: "X1" },
    { id: "d2", team: "Y2", partner_team: "釧路卓友" },
    { id: "d3", team: "釧路卓友", partner_team: "X3" },
    { id: "d4", team: "Z4", partner_team: "釧路卓友" },
    { id: "d5", team: "U5", partner_team: "V5" },
    { id: "d6", team: "U6", partner_team: "V6" },
    { id: "d7", team: "U7", partner_team: "V7" },
    { id: "d8", team: "U8", partner_team: "V8" },
  ].map(p => ({ ...p, display_name: p.id, seed: 0, is_doubles: 1 }));
  for (let s = 1; s <= 200; s++) {
    const { leaves, r1_same_club } = db.computeDrawLeaves(base, 8, mulberry32(s * 7 + 1), { separateBy: "team" });
    let overlapR1 = 0;
    for (let i = 0; i < 8; i += 2) if (leaves[i] && leaves[i + 1] && overlap(clubsOf(leaves[i]), clubsOf(leaves[i + 1]))) overlapR1++;
    assert.strictEqual(overlapR1, 0, "seed" + s + ": 共有クラブのR1対戦0件");
    assert.strictEqual(r1_same_club, 0, "seed" + s + ": r1_same_club=0");
    assert.strictEqual(leaves.filter(Boolean).length, 8, "全員配置");
  }
});

test("ダブルス: 単打の挙動は不変(team単一要素=従来の等価)", () => {
  // is_doubles 無し・partner_team 無しなら clubsOf=[team] で従来どおり。
  const singles = [];
  for (let i = 0; i < 16; i++) singles.push({ id: "s" + i, display_name: "S" + i, seed: 0, team: "クラブ" + (i % 4) });
  const { leaves } = db.computeDrawLeaves(singles, 16, mulberry32(99), { separateBy: "team" });
  let clubR1 = 0;
  for (let i = 0; i < 16; i += 2) if (leaves[i] && leaves[i + 1] && leaves[i].team === leaves[i + 1].team) clubR1++;
  assert.strictEqual(clubR1, 0, "単打は従来どおり同所属R1=0");
});

test("ダブルス: 両山Excelでペアを上下2段+各自の所属併記で出力", () => {
  // 2ペアの最小ブラケット(size2・1試合)を合成して buildBracketXlsx を検証。
  const entrants = [
    { id: "e1", is_doubles: 1, name: "山田 太郎", team: "A卓球", partner_name: "鈴木 一郎", partner_team: "B卓球", display_name: "山田 太郎 / 鈴木 一郎", bracket_number: 1, bracket_side: "L" },
    { id: "e2", is_doubles: 1, name: "佐藤 次郎", team: "C卓球", partner_name: "田中 三郎", partner_team: "D卓球", display_name: "佐藤 次郎 / 田中 三郎", bracket_number: 1, bracket_side: "R" },
  ];
  const matches = [{
    event: "男子ダブルス", bracket_round: 1, bracket_pos: 0, round: "決勝", match_no: 1, status: "pending",
    player1_name: entrants[0].display_name, player1_team: entrants[0].team, player1_entrant_id: "e1",
    player2_name: entrants[1].display_name, player2_team: entrants[1].team, player2_entrant_id: "e2",
  }];
  const buf = reports.buildBracketXlsx({ name: "ダブルス大会", date: "2027-08-08" }, matches, entrants, { event: "男子ダブルス" });
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets["男子ダブルス"];
  const text = Object.keys(ws).filter(k => k[0] !== "!").map(k => String(ws[k].v)).join("|");
  // 申込者・パートナー・各自の所属がすべて表に載る
  ["山田 太郎", "鈴木 一郎", "佐藤 次郎", "田中 三郎", "A卓球", "B卓球", "C卓球", "D卓球"].forEach(s =>
    assert.ok(text.includes(s), s + " が表にある: " + text.slice(0, 200)));
});
