// 両山トーナメント表(reports.buildBracketXlsx)の出力構造を検証する。
//   ・種目別シート / 左右(両山)に選手名が配置される / シード番号 / BYE は「ｂｙｅ」
//   ・選手=2行結合(merges) / 決勝が完了していれば優勝者を中央に表記
// 罫線(セルスタイル)は xlsx-js-style で書き出すが、ここでは値・結合・座標の不変条件を検証する。
// 実行: node --test test/bracket-xlsx.test.js
process.env.DB_PATH = "/tmp/ktta_brkxlsx_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const reports = require("../reports");
const XLSX = require("xlsx"); // 値・結合の読み戻しは標準xlsxで十分

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "一般男子シングルス";
let _seq = 0;
function setup(n, seedTop) {
  const t = db.createTournament({ name: "表検証" + (++_seq), date: "2027-05-05", venue: "体育館" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= n; i++) entries.push({ event: EV, type: "singles", name: "選手" + String(i).padStart(2, "0"), team: "ク" + ((i - 1) % 4) });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  db.getEntrants(t.id, EV).slice(0, seedTop || 0).forEach((e, k) => db.setEntrantSeed(e.id, k + 1));
  db.drawSingleBracket(t.id, EV, { draw_seed: 7, separate_by: "team" });
  return t;
}
// シートを {addr:value} と merges に展開
function readSheet(buf, sheetName) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const name = sheetName || wb.SheetNames[0];
  const ws = wb.Sheets[name];
  const vals = {};
  Object.keys(ws).forEach(k => { if (k[0] !== "!") vals[k] = ws[k].v; });
  return { wb, ws, vals, names: wb.SheetNames, merges: ws["!merges"] || [] };
}
const allText = (vals) => Object.values(vals).map(v => String(v)).join("");

test("両山: 種目シート・全選手名・左右配置・シード番号・2行結合", () => {
  const t = setup(8, 2);
  const buf = reports.buildBracketXlsx(t, db.getMatchesByTournament(t.id), db.getEntrants(t.id), { event: EV });
  const { vals, names, merges } = readSheet(buf, EV.slice(0, 30));
  assert.ok(names.includes(EV.slice(0, 30)), "種目名シート: " + names.join(","));
  const text = allText(vals);
  for (let i = 1; i <= 8; i++) assert.ok(text.includes("選手" + String(i).padStart(2, "0")), "選手" + i + "が表に存在");
  // シード番号 [1] [2] が表記される
  assert.ok(text.includes("[1]") && text.includes("[2]"), "シード番号表記");
  // 第1シードは左上(L_NAME=col1, TOP=row4 → B5)、第2シードは右側
  assert.strictEqual(vals["B5"], "選手01", "第1シードが左上(B5)");
  // 結合: 1選手4セル × 8選手 = 32 merge
  assert.strictEqual(merges.length, 32, "merge数=4×8: " + merges.length);
  // 各 merge は縦2行
  assert.ok(merges.every(m => m.e.r - m.s.r === 1 && m.e.c === m.s.c), "全mergeが縦2行");
});

test("両山: BYE枠は「ｂｙｅ」表記(12人/16枠=4BYE)", () => {
  const t = setup(12, 4);
  const buf = reports.buildBracketXlsx(t, db.getMatchesByTournament(t.id), db.getEntrants(t.id), { event: EV });
  const { vals } = readSheet(buf, EV.slice(0, 30));
  const byeCount = Object.values(vals).filter(v => v === "ｂｙｅ").length;
  assert.strictEqual(byeCount, 4, "BYE表記=size-N=4: " + byeCount);
  // 実選手12人ぶんの名前が存在
  const text = allText(vals);
  let found = 0; for (let i = 1; i <= 12; i++) if (text.includes("選手" + String(i).padStart(2, "0"))) found++;
  assert.strictEqual(found, 12, "実選手12人が表に存在");
});

test("両山: opts.event で1種目に絞れる", () => {
  const t = setup(4, 0);
  // 2つ目の種目も生成
  const EV2 = "一般女子シングルス";
  const cfg = [{ name: EV, type: "singles", fee: 0 }, { name: EV2, type: "singles", fee: 0 }];
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: cfg });
  db.createTeamEntry(t.id, { team_name: "Y", contact_name: "y", contact_email: "y@z.jp",
    entries: [1, 2, 3, 4].map(i => ({ event: EV2, type: "singles", name: "女子" + i, team: "G" })) });
  db.drawSingleBracket(t.id, EV2, { draw_seed: 3 });
  const buf = reports.buildBracketXlsx(t, db.getMatchesByTournament(t.id), db.getEntrants(t.id), { event: EV2 });
  const { names } = readSheet(buf);
  // _import(取込用機械可読シート)は除いて評価
  assert.deepStrictEqual(names.filter(n => n !== "_import"), [EV2.slice(0, 30)], "EV2のみのシート: " + names.join(","));
});

test("両山: 決勝完了で中央に優勝者", () => {
  const t = setup(4, 0); // 4人=2回戦(準決)+決勝
  // 全試合を順に完了させる
  for (let pass = 0; pass < 5; pass++) {
    const playable = db.getMatchesByTournament(t.id).filter(m => m.event === EV &&
      m.status !== "completed" && m.player1_name && m.player2_name &&
      m.player1_name !== "BYE" && m.player2_name !== "BYE");
    if (!playable.length) break;
    playable.forEach(m => db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 7], [11, 9]] }));
  }
  const buf = reports.buildBracketXlsx(t, db.getMatchesByTournament(t.id), db.getEntrants(t.id), { event: EV });
  const { vals } = readSheet(buf, EV.slice(0, 30));
  assert.ok(Object.values(vals).some(v => String(v).startsWith("優勝:")), "優勝表記がある: " + allText(vals).slice(0, 200));
});

test("印刷: 余白(page margins)が設定され大小どちらも有効な表を生成する", () => {
  // 列幅/フォント/スケールの規模連動は書き出すが XLSX.read では !cols 等が戻らないため、
  // ここでは round-trip する !margins と、大小いずれもクラッシュせず種目シートが出ることを確認する。
  for (const n of [8, 64]) {
    const t = setup(n, 0);
    const buf = reports.buildBracketXlsx(t, db.getMatchesByTournament(t.id), db.getEntrants(t.id), { event: EV });
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[EV.slice(0, 30)];
    assert.ok(ws, "N=" + n + ": 種目シート");
    assert.ok(ws["!margins"] && ws["!margins"].left != null, "N=" + n + ": 余白設定");
  }
});

test("両山: ブラケットが無い種目は案内シート(クラッシュしない)", () => {
  const t = db.createTournament({ name: "空", date: "2027-05-05" });
  const buf = reports.buildBracketXlsx(t, [], [], {});
  const { names } = readSheet(buf);
  assert.ok(names.length >= 1, "案内シートがある");
});

test("両山: N=2..64 でクラッシュせず種目シートを生成", () => {
  for (const n of [2, 3, 4, 7, 16, 31, 33, 64]) {
    const t = setup(n, Math.min(4, n));
    const buf = reports.buildBracketXlsx(t, db.getMatchesByTournament(t.id), db.getEntrants(t.id), { event: EV });
    const { names, vals } = readSheet(buf, EV.slice(0, 30));
    assert.ok(names.includes(EV.slice(0, 30)), "N=" + n + ": シート生成");
    // 実選手数ぶんの名前が表にある(BYEを除く)
    let found = 0; for (let i = 1; i <= n; i++) if (allText(vals).includes("選手" + String(i).padStart(2, "0"))) found++;
    assert.strictEqual(found, n, "N=" + n + ": 全選手配置");
  }
});
