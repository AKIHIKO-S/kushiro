// 取込パイプライン End-to-End 回帰: 合成ワークブック(PII無し)を
//   parse_bracket_seedlist.parseSeedList → db.importBracket(as_drawn) → ブラケット
// まで通し、「取込どおりの順で配置・件数一致・重複/欠落なし・ダブルスのペア整合」を固定する。
// 実ファイル(PII)は commit できないため、ここでパイプライン全体の回帰を担保する。
// 実行: node --test test/import-pipeline-e2e.test.js
process.env.DB_PATH = "/tmp/ktta_import_e2e_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");
const { parseSeedList } = require("../tools/parse_bracket_seedlist.js");
const db = require("../db");

const XLSX_PATH = path.join(os.tmpdir(), "ktta_e2e_book_" + process.pid + ".xlsx");
after(() => {
  for (const x of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} }
  try { fs.rmSync(XLSX_PATH, { force: true }); } catch (e) {}
});

// 合成ワークブック: シングルス(seed|氏名|所属) + ダブルス(seed|名1|名2|所属1|所属2 横並び・カッコ無し)
function buildWorkbook() {
  const wb = XLSX.utils.book_new();
  const singles = XLSX.utils.aoa_to_sheet([
    [1, "甲山 一郎", "A会"], [2, "乙川 二郎", "B会"], [3, "丙田 三郎", "C会"],
    [4, "丁原 四郎", "D会"], [5, "戊野 五郎", "E会"], [6, "己島 六郎", "F会"],
  ]);
  XLSX.utils.book_append_sheet(wb, singles, "一般男子シングルス");
  const doubles = XLSX.utils.aoa_to_sheet([
    [1, "佐藤 一", "鈴木 二", "X会", "X会"],
    [2, "高橋 三", "田中 四", "Y会", "Y会"],
    [3, "伊藤 五", "渡辺 六", "Z会", "W会"],   // 所属が本人/相方で別
  ]);
  XLSX.utils.book_append_sheet(wb, doubles, "一般男子ダブルス");
  // 団体(チームカップ): 1チーム=1entrant。チーム名が選手名スロットに入る。
  const team = XLSX.utils.aoa_to_sheet([
    [1, "A中学校"], [2, "B高校"], [3, "Cクラブ"], [4, "釧友会"],
  ]);
  XLSX.utils.book_append_sheet(wb, team, "チームカップ男子");
  XLSX.writeFile(wb, XLSX_PATH);
}

const r1 = (tid, ev) => db.getMatchesByTournament(tid)
  .filter(m => m.event === ev && m.bracket_round === 1)
  .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
const realNames = (matches) => {
  const out = [];
  matches.forEach(m => [m.player1_name, m.player2_name].forEach(n => { if (n && n !== "BYE") out.push(n); }));
  return out;
};

test("E2E: シングルスを as_drawn で取込→紙順(1,2,3..)どおりR1配置・件数一致・重複/欠落なし", () => {
  buildWorkbook();
  const parsed = parseSeedList(XLSX_PATH, {});
  const ev = parsed.events.find(e => e.event === "一般男子シングルス");
  assert.ok(ev, "シングルス種目が解析される");
  assert.strictEqual(ev.players.length, 6, "6名");
  const t = db.createTournament({ name: "e2e-singles", date: "2027-11-01" });
  const r = db.importBracket(t.id, { format: "tabletennis-seed-list-v1", event: ev.event,
    players: ev.players, regenerate: true, auto_create_players: true, placement: "as_drawn" });
  assert.ok(r && r.success, "取込成功: " + JSON.stringify(r));
  const ms = r1(t.id, ev.event);
  const names = realNames(ms);
  assert.strictEqual(names.length, 6, "R1実選手=6 (欠落なし): " + names.length);
  assert.strictEqual(new Set(names).size, 6, "重複なし");
  // as_drawn: 紙順 1vs2, 3vs4, 5vs6
  assert.strictEqual(ms[0].player1_name, "甲山 一郎");
  assert.strictEqual(ms[0].player2_name, "乙川 二郎", "枠1=甲vs乙(紙順): " + JSON.stringify([ms[0].player1_name, ms[0].player2_name]));
  assert.strictEqual(ms[1].player1_name, "丙田 三郎");
  assert.strictEqual(ms[1].player2_name, "丁原 四郎", "枠2=丙vs丁");
  assert.strictEqual(ms[2].player1_name, "戊野 五郎");
  assert.strictEqual(ms[2].player2_name, "己島 六郎", "枠3=戊vs己");
});

test("E2E: ダブルス(横並び・所属カッコ無し)を取込→ペア整合(相方/所属)が保たれる", () => {
  const parsed = parseSeedList(XLSX_PATH, {});
  const ev = parsed.events.find(e => e.event === "一般男子ダブルス");
  assert.ok(ev, "ダブルス種目が解析される");
  assert.strictEqual(ev.players.length, 3, "3組");
  const t = db.createTournament({ name: "e2e-doubles", date: "2027-11-02" });
  const r = db.importBracket(t.id, { format: "tabletennis-seed-list-v1", event: ev.event,
    players: ev.players, regenerate: true, auto_create_players: true, placement: "as_drawn" });
  assert.ok(r && r.success, "取込成功: " + JSON.stringify(r));
  // entrants にペアが正しく入る
  const ents = db.getEntrants(t.id, ev.event);
  assert.strictEqual(ents.length, 3, "3 entrant");
  const e1 = ents.find(e => (e.surname + e.given_name).includes("佐藤") || e.display_name?.includes("佐藤"));
  assert.ok(e1, "佐藤のペアがある: " + JSON.stringify(ents.map(e => e.display_name)));
  assert.ok((e1.partner_surname || "") + (e1.partner_given_name || "") === "鈴木二" ||
            (e1.partner_display_name || "").includes("鈴木"), "相方=鈴木 二: " + JSON.stringify([e1.partner_surname, e1.partner_given_name, e1.partner_display_name]));
  // 別所属ペア(伊藤/Z会・渡辺/W会)の所属が混ざらない
  const e3 = ents.find(e => (e.display_name || (e.surname + e.given_name)).includes("伊藤"));
  assert.ok(e3, "伊藤のペアがある");
  assert.strictEqual(e3.team, "Z会", "本人所属=Z会: " + e3.team);
  assert.strictEqual(e3.partner_team, "W会", "相方所属=W会(別): " + e3.partner_team);
  // R1 でペアが1枠に同居
  const ms = r1(t.id, ev.event);
  const slot0 = (ms[0].player1_name || "") + (ms[0].player2_name || "");
  assert.ok(/佐藤/.test(slot0) || ms.some(m => /佐藤/.test((m.player1_name || "") + (m.player2_name || ""))), "佐藤ペアがR1に登場");
});

test("E2E: 団体(チームカップ)を取込→チームをそのまま枠に配置・選手DBに漏れない", () => {
  const parsed = parseSeedList(XLSX_PATH, {});
  const ev = parsed.events.find(e => e.event === "チームカップ男子");
  assert.ok(ev, "団体種目が解析される");
  assert.strictEqual(ev.format, "team", "format=team: " + ev.format);
  assert.strictEqual(ev.players.length, 4, "4チーム");
  const t = db.createTournament({ name: "e2e-team", date: "2027-11-03" });
  const r = db.importBracket(t.id, { format: "tabletennis-seed-list-v1", event: ev.event,
    players: ev.players, regenerate: true, auto_create_players: true, auto_link_to_players: true, placement: "as_drawn" });
  assert.ok(r && r.success, "取込成功: " + JSON.stringify(r));
  // 4チームが entrant として登録される(登録団体名 釧友会 も団体entrantとして温存される)
  const ents = db.getEntrants(t.id, ev.event);
  assert.strictEqual(ents.length, 4, "4 entrant(チーム): " + JSON.stringify(ents.map(e => e.display_name)));
  // as_drawn: 紙順どおりに配置
  const ms = r1(t.id, ev.event);
  assert.strictEqual(realNames(ms).length, 4, "4チーム配置(欠落なし)");
  assert.strictEqual(ms[0].player1_name, "A中学校");
  assert.strictEqual(ms[0].player2_name, "B高校", "枠1=A中vsB高: " + JSON.stringify([ms[0].player1_name, ms[0].player2_name]));
  // チーム名は選手マスタに漏れない(団体名を選手化しない)
  assert.strictEqual(ents.filter(e => e.player_id).length, 0,
    "チームは player_id を持たない(選手化しない): " + JSON.stringify(ents.filter(e => e.player_id).map(e => e.display_name)));
});
