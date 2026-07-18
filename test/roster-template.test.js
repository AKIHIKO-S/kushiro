// 取込用テンプレ(オーナー要望 2026-07-18)の回帰:
//  - 3種(シングルス/ダブルス/団体)のテンプレ生成(割当表シート互換・記入例は別シート)
//  - 記入→取込で「枠番号=トーナメンの枠=組番号(seed)」が必ず一致(番号一致保証)
//  - 名簿に居ない選手は自動で出場登録(create_missing)。欠番=空き枠(不戦勝)
// 実行: node --test test/roster-template.test.js
process.env.DB_PATH = "/tmp/ktta_rtmpl_" + process.pid + ".db";

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

// テンプレをパースして「行記入→importSheetRows 入力形式」へ(server側のヘッダベースparseと同じ規約)
function parseTemplate(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets["割当表(編集用)"];
  assert.ok(ws, "割当表シートがある");
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  assert.strictEqual(String(aoa[0][0]), "__KTTA_SHEET__", "メタ行");
  const hi = aoa.findIndex(r => (r || [])[0] === "種目");
  const hd = aoa[hi].map(x => String(x || "").trim());
  const col = (n) => hd.indexOf(n);
  return { wb, aoa, hi, hd, col, type: String(aoa[0][4] || "") };
}
const rowsOf = (tpl, fill) => fill.map(f => {
  const r = {};
  ["種目", "枠番号", "選手名", "チーム名", "ふりがな", "所属", "支部", "選手2氏名", "選手2ふりがな", "選手2所属", "選手ID", "登場回戦", "版"].forEach(n => {
    if (tpl.col(n) >= 0 && f[n] !== undefined) r[n] = f[n];
  });
  return {
    event: r["種目"], pos: r["枠番号"],
    name: r["選手名"] || r["チーム名"], furigana: r["ふりがな"] || "",
    team: r["所属"] || "", region: r["支部"] || "",
    partner_name: r["選手2氏名"] || "", partner_furigana: r["選手2ふりがな"] || "", partner_team: r["選手2所属"] || "",
    entrant_id: r["選手ID"] || "", entry_round: r["登場回戦"] || "", rev: r["版"] || "",
  };
});

test("シングルス: テンプレ記入→取込→確定で 提出番号=枠=組番号 が一致・欠番は不戦勝", () => {
  const EV = "男子シングルス";
  const t = db.createTournament({ name: "テンプレ検証S", date: "2027-12-01" });
  const tpl = parseTemplate(reports.buildRosterTemplateXlsx(t, EV, "singles"));
  assert.strictEqual(tpl.type, "singles");
  assert.ok(tpl.wb.Sheets["記入例"], "記入例は別シート(取込対象外)");
  // 番号 1,2,3,5 を記入(4は欠番=枠5相当ではなく「枠4が空き」)
  const rows = rowsOf(tpl, [
    { "種目": EV, "枠番号": 1, "選手名": "提出 一郎", "ふりがな": "ていしゆつ", "所属": "釧路ク", "支部": "釧路" },
    { "種目": EV, "枠番号": 2, "選手名": "提出 二郎", "ふりがな": "ていしゆつ", "所属": "帯広中", "支部": "十勝" },
    { "種目": EV, "枠番号": 3, "選手名": "提出 三郎", "ふりがな": "ていしゆつ", "所属": "北見ク", "支部": "北見" },
    { "種目": EV, "枠番号": 5, "選手名": "提出 五郎", "ふりがな": "ていしゆつ", "所属": "釧路ク", "支部": "釧路" },
  ]);
  const pv = db.importSheetRows(t.id, rows, { preview: true, create_missing: true });
  assert.ok(pv.ok, JSON.stringify(pv).slice(0, 200));
  assert.strictEqual((pv.results[0].new_players || []).length, 4, "全員が新規として差分に見える");
  const ap = db.importSheetRows(t.id, rows, { create_missing: true });
  assert.ok(ap.ok && ap.results[0].to_draft, JSON.stringify(ap).slice(0, 200));
  // 下書き→確定
  const c = db.confirmSheet(t.id, EV, {});
  assert.ok(c.ok, JSON.stringify(c).slice(0, 150));
  // 番号一致保証: 枠(2*pos+slot) と 組番号(seed) が提出番号と一致
  const ents = db.getEntrants(t.id, EV);
  const byName = new Map(ents.map(e => [e.name, e]));
  assert.strictEqual(byName.get("提出 一郎").seed, 1);
  assert.strictEqual(byName.get("提出 五郎").seed, 5, "欠番があっても提出番号=組番号");
  const r1 = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
    .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
  assert.strictEqual(r1.length, 4, "8枠(番号5まで→2累乗8)");
  assert.strictEqual(r1[0].player1_entrant_id, byName.get("提出 一郎").id, "枠1");
  assert.strictEqual(r1[1].player1_entrant_id, byName.get("提出 三郎").id, "枠3");
  assert.strictEqual(r1[1].player2_name, "BYE", "枠4=欠番は空き(不戦勝)");
  assert.strictEqual(r1[2].player1_entrant_id, byName.get("提出 五郎").id, "枠5");
});

test("ダブルス: 選手2列つきテンプレ→ペアとして出場登録・表示は「A / B」", () => {
  const EV = "男子ダブルス";
  const t = db.createTournament({ name: "テンプレ検証D", date: "2027-12-02" });
  const tpl = parseTemplate(reports.buildRosterTemplateXlsx(t, EV, "doubles"));
  assert.ok(tpl.col("選手2氏名") >= 0, "選手2列がある");
  const rows = rowsOf(tpl, [
    { "種目": EV, "枠番号": 1, "選手名": "組 太郎", "ふりがな": "くみ", "所属": "釧路ク", "選手2氏名": "組 次郎", "選手2ふりがな": "くみ", "選手2所属": "帯広中" },
    { "種目": EV, "枠番号": 2, "選手名": "組 三郎", "ふりがな": "くみ", "所属": "北見ク", "選手2氏名": "組 四郎", "選手2ふりがな": "くみ", "選手2所属": "北見ク" },
  ]);
  const ap = db.importSheetRows(t.id, rows, { create_missing: true });
  assert.ok(ap.ok, JSON.stringify(ap).slice(0, 200));
  const ents = db.getEntrants(t.id, EV);
  assert.strictEqual(ents.length, 2);
  const e1 = ents.find(e => e.seed === 1);
  assert.strictEqual(e1.is_doubles, 1, "ダブルスとして登録");
  assert.ok(/組 太郎.*組 次郎|組太郎.*組次郎/.test(e1.display_name), "ペア表示: " + e1.display_name);
  assert.ok(db.confirmSheet(t.id, EV, {}).ok, "確定できる");
});

test("団体: チーム名列テンプレ→1チーム=1枠で登録", () => {
  const EV = "男子団体";
  const t = db.createTournament({ name: "テンプレ検証T", date: "2027-12-03" });
  const tpl = parseTemplate(reports.buildRosterTemplateXlsx(t, EV, "team"));
  assert.ok(tpl.col("チーム名") >= 0 && tpl.col("ふりがな") < 0, "団体はチーム名列(ふりがな列なし)");
  // 団体テンプレはふりがな列が無い=server判定では通常形式になるため、rowsOfでname=チーム名を確認
  const rows = rowsOf(tpl, [
    { "種目": EV, "枠番号": 1, "チーム名": "釧路クラブA", "支部": "釧路" },
    { "種目": EV, "枠番号": 2, "チーム名": "帯広中学校", "支部": "十勝" },
  ]);
  const ap = db.importSheetRows(t.id, rows, { create_missing: true });
  assert.ok(ap.ok, JSON.stringify(ap).slice(0, 200));
  const ents = db.getEntrants(t.id, EV);
  assert.strictEqual(ents.length, 2);
  assert.strictEqual(ents.find(e => e.seed === 1).name, "釧路クラブA");
  assert.ok(db.confirmSheet(t.id, EV, {}).ok);
});
