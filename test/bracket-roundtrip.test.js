// Excelラウンドトリップ: 両山トーナメント表を出力→(手修正)→取込で『位置だけ』正本化する。
//   ・entrant(player_id/結果/draw_seed)を消さず差分更新であること
//   ・手修正(入替)が取込でブラケットに反映されること
//   ・_importシートの往復(build→parse→import)が件数一致
// 実行: node --test test/bracket-roundtrip.test.js
process.env.DB_PATH = "/tmp/ktta_rt_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const reports = require("../reports");
const XLSX = require("xlsx");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const EV = "男子シングルス";
let _seq = 0;
function setup(n) {
  const t = db.createTournament({ name: "往復" + (++_seq), date: "2027-05-05" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= n; i++) entries.push({ event: EV, type: "singles", name: "選手" + String(i).padStart(2, "0"), team: "ク" + (i % 3) });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  db.drawSingleBracket(t.id, EV, { draw_seed: 5, drawn_by: "甲" });
  return t;
}
// build xlsx → _import シートを行配列にパース(server ルートと同等)
function parseImport(t) {
  const buf = reports.buildBracketXlsx(t, db.getMatchesByTournament(t.id), db.getEntrants(t.id), { event: EV });
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets["_import"];
  assert.ok(ws, "_import シートがある");
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  assert.strictEqual(String(aoa[0][0]), "__KTTA_BRACKET_IMPORT__", "マーカー行");
  const h = aoa[1]; const ci = (n) => h.indexOf(n);
  return aoa.slice(2).map(r => ({
    event: r[ci("event")], bracket_pos: r[ci("bracket_pos")], slot: r[ci("slot")],
    entrant_id: r[ci("entrant_id")], name: r[ci("name")], team: r[ci("team")], bye: r[ci("bye")],
  }));
}
const r1Of = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
  .sort((a, b) => a.bracket_pos - b.bracket_pos).map(m => [m.player1_name, m.player2_name]);

test("無編集の往復: ブラケットが変わらず entrant も消えない", () => {
  const t = setup(8);
  const before = r1Of(t);
  const idsBefore = db.getEntrants(t.id, EV).map(e => e.id).sort();
  const rows = parseImport(t);
  const r = db.importBracketRoundtrip(t.id, rows, {});
  assert.ok(r.ok, "取込成功: " + JSON.stringify(r.results));
  assert.deepStrictEqual(r1Of(t), before, "無編集なら配置不変");
  const idsAfter = db.getEntrants(t.id, EV).map(e => e.id).sort();
  assert.deepStrictEqual(idsAfter, idsBefore, "entrantが消えない(idが不変)");
});

test("手修正(入替)が取込で反映される", () => {
  const t = setup(8);
  const rows = parseImport(t);
  // 実選手(BYEでない)2人を見つけて位置(entrant_id/name/team)を入替える
  const real = rows.filter(r => String(r.bye) !== "1" && r.entrant_id);
  assert.ok(real.length >= 2, "実選手2人以上");
  const a = real[0], b = real[real.length - 1];
  const swap = (x, y) => { ["entrant_id", "name", "team"].forEach(k => { const tmp = x[k]; x[k] = y[k]; y[k] = tmp; }); };
  const aName = a.name, bName = b.name;
  swap(a, b);
  const r = db.importBracketRoundtrip(t.id, rows, {});
  assert.ok(r.ok, "入替取込成功: " + JSON.stringify(r.results));
  // a の位置(pos,slot)に今 bName が居る
  const posSlotName = (pos, slot) => {
    const m = db.getMatchesByTournament(t.id).find(x => x.event === EV && x.bracket_round === 1 && x.bracket_pos === pos);
    return slot === 1 ? m.player1_name : m.player2_name;
  };
  assert.strictEqual(posSlotName(a.bracket_pos, a.slot), bName, "入替先に元bが来た");
  assert.strictEqual(posSlotName(b.bracket_pos, b.slot), aName, "入替元に元aが来た");
});

test("取込先に居ない選手はエラー(勝手に作らない)", () => {
  const t = setup(8);
  const rows = parseImport(t);
  const real = rows.find(r => String(r.bye) !== "1" && r.entrant_id);
  real.entrant_id = "nonexistent-id"; real.name = "存在しない 太郎"; real.team = "謎";
  const r = db.importBracketRoundtrip(t.id, rows, {});
  assert.ok(!r.ok && r.results.some(x => x.error && /見つかりません/.test(x.error)), "未解決はエラー: " + JSON.stringify(r.results));
});

test("preview(dry_run)はDBを書かない", () => {
  const t = setup(8);
  const before = r1Of(t);
  const rows = parseImport(t);
  // 入替えてからプレビュー → DBは変わらない
  const real = rows.filter(r => String(r.bye) !== "1" && r.entrant_id);
  [["entrant_id"], ["name"], ["team"]].forEach(() => {});
  const a = real[0], b = real[1];
  ["entrant_id", "name", "team"].forEach(k => { const tmp = a[k]; a[k] = b[k]; b[k] = tmp; });
  const r = db.importBracketRoundtrip(t.id, rows, { preview: true });
  assert.ok(r.ok && r.results[0].preview, "プレビュー応答");
  assert.deepStrictEqual(r1Of(t), before, "プレビューはDBを書かない");
});
