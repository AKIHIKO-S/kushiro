// 割当表Excel往復(案B P6)の回帰: 編集する面=機械が読む面。
//  - 出力: 「割当表(編集用)」シート(メタ+注意書き+1行=1枠+版列)が管理DLにだけ載る
//  - 取込: 同一内容なら差分ゼロ / 入替を編集すると差分が出て下書きに反映(確定はしない)
//  - 同定: 同名複数はID必須エラー / 古い版のExcelはstale警告
// 実行: node --test test/sheet-excel-roundtrip.test.js
process.env.DB_PATH = "/tmp/ktta_sheetxl_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const reports = require("../reports");
const XLSX = require("xlsx");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
function setup(n) {
  const t = db.createTournament({ name: "Excel往復検証", date: "2027-08-01" });
  for (let i = 1; i <= n; i++) db.createEntrant({ tournament_id: t.id, event: EV,
    name: "往" + String(i).padStart(2, "0"), team: "ク" + (i % 3), furigana: "おう" + String(i).padStart(2, "0") });
  db.ensureDraftSheet(t.id, EV);
  const c = db.confirmSheet(t.id, EV, {});
  assert.ok(c.ok, JSON.stringify(c).slice(0, 100));
  return t;
}
// buildBracketXlsx を管理DL相当で呼び、割当表シートをAoAで返す
function exportEditSheet(t, withEdit) {
  const tour = db.getTournament(t.id);
  const matches = db.getMatchesByTournament(t.id).filter(m => m.bracket_round != null);
  const entrants = db.getEntrants(t.id) || [];
  const st = db.getSheetState(t.id, EV);
  const buf = reports.buildBracketXlsx(tour, matches, entrants, {
    event: EV, include_edit_sheet: withEdit !== false,
    sheetStates: st.confirmed ? { [EV]: { rev_no: st.confirmed.rev_no } } : {},
  });
  const wb = XLSX.read(buf, { type: "buffer" });
  return { wb, sheet: wb.Sheets["割当表(編集用)"] };
}
function rowsFromSheet(sheet) {
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  assert.strictEqual(String(aoa[0][0]), "__KTTA_SHEET__", "メタ行");
  const hi = aoa.findIndex(r => (r || [])[0] === "種目");
  return aoa.slice(hi + 1).map(r => ({ event: r[0], pos: r[1], name: r[2], team: r[3], entrant_id: r[4], entry_round: r[5], rev: r[6] }));
}

test("出力: 割当表シートは管理DLのみ・先頭タブ・版列つき。公開DLには載らない", () => {
  const t = setup(6);
  const { wb, sheet } = exportEditSheet(t, true);
  assert.ok(sheet, "割当表シートがある");
  assert.strictEqual(wb.SheetNames[0], "割当表(編集用)", "先頭タブ");
  const rows = rowsFromSheet(sheet);
  assert.strictEqual(rows.length, 8, "8枠(6名+空き2)全行");
  assert.ok(rows.every(r => r.rev === 1), "全行に版=1");
  const pub = exportEditSheet(t, false);
  assert.ok(!pub.sheet, "公開DL相当(include_edit_sheet=false)には載らない");
});

test("往復: 同一内容の取込は差分ゼロ、入替編集は差分検出+下書き反映(確定はしない)", () => {
  const t = setup(6);
  const { sheet } = exportEditSheet(t, true);
  const rows = rowsFromSheet(sheet);
  // 同一内容 → 差分ゼロ
  const same = db.importSheetRows(t.id, rows, { preview: true });
  assert.ok(same.ok, JSON.stringify(same).slice(0, 150));
  const d0 = same.results[0].diff;
  assert.strictEqual(d0.moves.length + d0.added.length + d0.removed.length, 0, "無編集なら差分ゼロ");
  // 枠1と枠3の選手を入替(名前とIDを入れ替える=シート上の自然な編集)
  const r1 = rows.find(r => r.pos === 1), r3 = rows.find(r => r.pos === 3);
  [r1.name, r3.name] = [r3.name, r1.name];
  [r1.entrant_id, r3.entrant_id] = [r3.entrant_id, r1.entrant_id];
  const prev = db.importSheetRows(t.id, rows, { preview: true });
  assert.strictEqual(prev.results[0].diff.moves.length, 2, "入替=2件の移動として見える: " + JSON.stringify(prev.results[0].diff));
  // 本適用 → 下書きに入る(確定版は第1版のまま)
  const ap = db.importSheetRows(t.id, rows, {});
  assert.ok(ap.ok && ap.results[0].to_draft, "下書きへ反映");
  const st = db.getSheetState(t.id, EV);
  assert.ok(st.draft, "下書きがある(検収待ち)");
  assert.strictEqual(st.confirmed.rev_no, 1, "確定版は変わっていない(確定は座席表で)");
});

test("同定: ID空欄の同名複数はエラー・不明選手もエラー(黙って取り込まない)", () => {
  const t = db.createTournament({ name: "同名検証", date: "2027-08-02" });
  db.createEntrant({ tournament_id: t.id, event: EV, name: "同名 太郎", team: "A", furigana: "どうめい" });
  db.createEntrant({ tournament_id: t.id, event: EV, name: "同名 太郎", team: "B", furigana: "どうめい" });
  const dup = db.importSheetRows(t.id, [
    { event: EV, pos: 1, name: "同名 太郎", entrant_id: "", entry_round: "" },
    { event: EV, pos: 2, name: "未知 花子", entrant_id: "", entry_round: "" },
  ], { preview: true });
  const r = dup.results[0];
  assert.ok(r.error && /同名が複数/.test(r.error), "同名複数はID必須: " + r.error);
  assert.ok(r.problems.some(p => /見つかりません/.test(p)), "不明選手も列挙");
});

test("stale: 古い版のExcelには警告が付く", () => {
  const t = setup(4);
  const { sheet } = exportEditSheet(t, true);   // 第1版のExcel
  const rows = rowsFromSheet(sheet);
  // 第2版に上げる
  db.ensureDraftSheet(t.id, EV);
  const c2 = db.confirmSheet(t.id, EV, { force: true });
  assert.strictEqual(c2.rev_no, 2);
  const prev = db.importSheetRows(t.id, rows, { preview: true });
  assert.ok((prev.results[0].warnings || []).some(w => /第1版から作られています/.test(w)),
    "stale警告: " + JSON.stringify(prev.results[0].warnings));
});
