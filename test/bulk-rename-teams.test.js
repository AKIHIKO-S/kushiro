// 所属名の一括統一(オーナー依頼 2026-11-24)の回帰テスト。
//
// 守らせる不変条件:
//   ① プレビュー(dry_run)では何も変わらない
//   ② 判定: rename(変更)/merge(統合)/same(同じ)/missing(見つからない)/chain(連鎖)/dup(重複)/invalid(空欄)。chain・dup・missing・same は実行しない
//   ③ 反映は選手・参加記録・パートナー・所属履歴の「表記」だけ。所属履歴の件数は変わらない(追加・削除しない)
//   ④ 途中で失敗したら全体を巻き戻す(1つの取引)
//   ⑤ 一覧(CSV/Excel)の読み取り: 見出し「変更前」「変更後」を探す・BOM・空行・他の列(Shift_JISの読み取りは実装のみで、テストは未整備)
// 実行: node --test test/bulk-rename-teams.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
process.env.DB_PATH = path.join(require("os").tmpdir(), "ktta_bulkrename_" + process.pid + ".db");
const db = require("../db");
const sheet = require("../lib/team-rename-sheet");
after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const mk = (name, team) => db.createPlayer({ name, furigana: "かくう", team, branch: "釧路", gender: "male", category: "middle" });
const teamsOf = () => new Map(db.getPlayers({}).map(p => [p.name, p.team]));
const affCount = () => db.getPlayers({}).reduce((n, p) => n + db.listAffiliations(p.id).length, 0);

test("①②③ プレビューは何も変えない。判定が分かれ、実行するのは rename/merge だけ。所属履歴は表記だけ直る", () => {
  mk("甲 一", "共栄中"); mk("甲 二", "共栄中学"); mk("甲 三", "共栄中学校");
  mk("乙 一", "景雲中学"); mk("丙 一", "春採中"); mk("丁 一", "連鎖元"); mk("丁 二", "連鎖先");
  const before = teamsOf(), affBefore = affCount();
  const pairs = [
    { from: "共栄中", to: "共栄中学校" },       // merge(共栄中学校がすでにある)
    { from: "共栄中学", to: "共栄中学校" },     // merge
    { from: "景雲中学", to: "景雲中学校" },     // rename
    { from: "春採中", to: "春採中" },           // same
    { from: "存在しない所属", to: "別の名前" },  // missing
    { from: "連鎖元", to: "連鎖先" }, { from: "連鎖先", to: "連鎖終点" },   // chain(連鎖元→連鎖先は、連鎖先が別行の変更前) + 連鎖先は実行できる
    { from: "重複", to: "A" }, { from: "重複", to: "B" },                     // dup
    { from: "", to: "空" },                                                  // invalid
  ];
  const pre = db.bulkRenameTeams(pairs, { dry_run: true });
  assert.equal(pre.dry_run, true);
  assert.deepEqual([...teamsOf()], [...before], "プレビューでは何も変わらない");
  const st = Object.fromEntries(pre.rows.map(r => [r.from + ">" + r.to, r.status]));
  assert.equal(st["共栄中>共栄中学校"], "merge"); assert.equal(st["共栄中学>共栄中学校"], "merge");
  assert.equal(st["景雲中学>景雲中学校"], "rename");
  assert.equal(st["春採中>春採中"], "same");
  assert.equal(st["存在しない所属>別の名前"], "missing");
  assert.equal(st["連鎖元>連鎖先"], "chain");
  assert.equal(st["連鎖先>連鎖終点"], "rename");
  assert.equal(st["重複>A"], "dup"); assert.equal(st["重複>B"], "dup");
  assert.equal(st[">空"], "invalid");
  assert.equal(pre.summary.apply, 4);
  const r = db.bulkRenameTeams(pairs, {});
  assert.equal(r.applied, 4);
  const after1 = teamsOf();
  assert.equal(after1.get("甲 一"), "共栄中学校"); assert.equal(after1.get("甲 二"), "共栄中学校");
  assert.equal(after1.get("乙 一"), "景雲中学校"); assert.equal(after1.get("丙 一"), "春採中", "same は変えない");
  assert.equal(after1.get("丁 一"), "連鎖元", "連鎖は実行しない"); assert.equal(after1.get("丁 二"), "連鎖終点");
  assert.equal(affCount(), affBefore, "所属履歴の件数は変わらない(追加・削除しない)");
  const p = db.getPlayers({}).find(x => x.name === "甲 一");
  assert.ok(db.listAffiliations(p.id).every(a => a.team === "共栄中学校"), "所属履歴の表記も直る");
});

test("④ 途中で失敗したら全体を巻き戻す", () => {
  mk("戊 一", "巻戻A"); mk("戊 二", "巻戻B");
  const Database = require("better-sqlite3");
  const side = new Database(process.env.DB_PATH);
  side.exec("CREATE TRIGGER IF NOT EXISTS boom BEFORE UPDATE OF team ON players WHEN NEW.team='爆発先' BEGIN SELECT RAISE(ABORT,'失敗の試験'); END;");
  side.close();
  const before = teamsOf();
  assert.throws(() => db.bulkRenameTeams([{ from: "巻戻A", to: "巻戻A済" }, { from: "巻戻B", to: "爆発先" }], {}), /失敗の試験/);
  assert.deepEqual([...teamsOf()], [...before], "1行目も戻っている(全体が1つの取引)");
});

test("入力の検査: 空の一覧・多すぎる行", () => {
  assert.ok(db.bulkRenameTeams([], {}).error);
  assert.ok(db.bulkRenameTeams(Array.from({ length: 2001 }, (_, i) => ({ from: "a" + i, to: "b" + i })), {}).error);
});

test("⑤ 一覧の読み取り: CSV(BOM・見出し・空行・他の列)・Excel(反映の順番シート)", () => {
  const csv = "﻿順,変更前,変更後,人数\n1,共栄中,共栄中学校,10\n\n2,\"A,B\",\"C\"\"D\",1\n";
  const r = sheet.parse(Buffer.from(csv, "utf8"), "x.csv");
  assert.deepEqual(r.pairs.map(p => [p.from, p.to]), [["共栄中", "共栄中学校"], ["A,B", 'C"D']]);
  const noHead = sheet.parse(Buffer.from("鳥取中学,鳥取中学校\n", "utf8"), "y.csv");
  assert.deepEqual(noHead.pairs.map(p => [p.from, p.to]), [["鳥取中学", "鳥取中学校"]], "見出しが無ければ左の2列");
  assert.ok(sheet.parse(Buffer.alloc(0), "z.csv").error);
  assert.ok(sheet.parse(Buffer.from("a,b\n", "utf8"), "z.csv").pairs, "見出しなしでも2列あれば読む");
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["要約"], ["x"]]), "要約");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["順", "変更前", "変更後", "人数(目安)"], [1, "湖陵高校", "釧路湖陵高校", 27]]), "反映の順番");
  const xr = sheet.parse(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), "list.xlsx");
  assert.deepEqual(xr.pairs.map(p => [p.from, p.to]), [["湖陵高校", "釧路湖陵高校"]], "「反映の順番」シートを読む");
});
