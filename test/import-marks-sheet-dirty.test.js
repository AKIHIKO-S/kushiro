// 案B Phase1 回帰(2026-07-18):
//  1-3: Excel/PDF取込(旧経路 db.importBracket)は matches を直接書き換える。確定シートがある種目に
//       取り込んだら「要再確定(dirty)」に落ちること(版スタンプが古い配置を「確定」と印字するのを防ぐ)。
//       db.importBracket 内で全経路一元的に markSheetDirty するので、server側の呼び出し漏れに依存しない。
//  1-2の前提: 確定シートが無い種目(終了大会・移行対象外)は getSheetState.confirmed が falsy →
//       印刷は素の印刷(見本帯を出さない)。ここではデータ契約だけ固定する(帯の描画はadmin側)。
// 実行: node --test test/import-marks-sheet-dirty.test.js
process.env.DB_PATH = "/tmp/ktta_impdirty_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

test("1-3: 確定シートのある種目にExcel/PDF取込(db.importBracket)すると dirty=要再確定になる", () => {
  const EV = "男子シングルス";
  const t = db.createTournament({ name: "取込dirty検証", date: "2027-12-08" });
  // 割当表を確定(confirmed シートを作る)
  const rows = [1, 2, 3, 4].map(n => ({ event: EV, pos: n, name: "確定" + n, furigana: "かくてい", team: "ク" + n }));
  assert.ok(db.importSheetRows(t.id, rows, { create_missing: true }).ok);
  assert.ok(db.confirmSheet(t.id, EV, {}).ok, "初期確定");
  const before = db.getSheetState(t.id, EV);
  assert.ok(before.confirmed && !before.dirty, "確定済み・クリーン: " + JSON.stringify(before).slice(0, 120));

  // 旧経路(Excel/PDF)取込で matches を書き換える
  const players = [];
  for (let i = 1; i <= 4; i++) players.push({ name: "取込" + i, team: "R" + i, seed: i, side: i <= 2 ? "L" : "R" });
  const r = db.importBracket(t.id, { format: "tabletennis-seed-list-v1", event: EV, players, regenerate: true, placement: "as_drawn" });
  assert.ok(!r.error, "取込成功: " + JSON.stringify(r).slice(0, 150));

  const after2 = db.getSheetState(t.id, EV);
  assert.ok(after2.dirty, "確定シートが dirty(要再確定)になる=版スタンプが古い配置を確定と偽らない");
});

test("1-3: 確定シートが無い種目への取込は無害(no-op・エラーにならない)", () => {
  const EV = "女子シングルス";
  const t = db.createTournament({ name: "取込dirty無確定", date: "2027-12-09" });
  const players = [];
  for (let i = 1; i <= 4; i++) players.push({ name: "無確定" + i, team: "N" + i, seed: i, side: i <= 2 ? "L" : "R" });
  const r = db.importBracket(t.id, { format: "tabletennis-seed-list-v1", event: EV, players, regenerate: true, placement: "as_drawn" });
  assert.ok(!r.error, "確定シート無しでも取込は成功(markSheetDirtyは無害なno-op): " + JSON.stringify(r).slice(0, 120));
  const st = db.getSheetState(t.id, EV);
  assert.ok(!st.confirmed, "確定シートは無い=印刷は素の印刷(見本帯を出さない前提)");
});
