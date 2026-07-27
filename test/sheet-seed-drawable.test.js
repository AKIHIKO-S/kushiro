// 案B(割当表正本)の回帰: 確定が抽選とスーパーシードを壊さないこと。
//
// 発見された2つの回帰(いずれも実測で確認済み):
//  ① materializeSheet / patchSheet が entrants.seed に枠番号(1..N)を書いていたため、
//     一度確定した種目は「全員がシード選手」と解釈され、抽選し直しても抽選種を変えても
//     配置が変わらなくなっていた(同所属の1回戦対戦も分離できず悪化)。
//     seed は「シード順位」であり抽選・標準配置の入力。紙の通し番号は bracket_number が別に持つ。
//  ② patchSheet の当日差替が seats[pos].entry_round に「入ってくる人の値」を入れていたため、
//     3回戦から始まる大罫線の枠に補欠を入れると正本(シート)から大罫線が消えていた
//     (木は大罫線のままなので正本と現物が食い違う)。登場回戦は人ではなく枠の属性。
// 実行: node --test test/sheet-seed-drawable.test.js
process.env.DB_PATH = "/tmp/ktta_seeddraw_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

function mkEvent(names, teams) {
  const t = db.createTournament({
    name: "抽選回帰", date: "2027-09-01", status: "scheduled",
    event_config: JSON.stringify([{ name: "S" }]),
  });
  names.forEach((n, i) => db.createEntrant({
    tournament_id: t.id, event: "S", name: n, furigana: "か" + i,
    team: (teams && teams[i]) || ("T" + i), seed: 0, status: "confirmed",
  }));
  return t;
}
const drawPairs = (t, seed) => {
  const r = db.drawSingleBracket(t.id, "S", { draw_seed: seed, separate_by: "team", preview: true });
  assert.ok(!r.error, "抽選プレビュー: " + r.error);
  return r;
};
const sig = (r) => r.pairs.map(p => (p.p1 ? p.p1.name : "BYE") + "×" + (p.p2 ? p.p2.name : "BYE")).join(" ");

// ── ① 確定しても抽選が抽選のままであること ──────────────────────
test("確定した種目でも、抽選種を変えれば配置が変わる", () => {
  const t = mkEvent(["a1", "a2", "a3", "a4", "a5", "a6", "b1", "b2"],
    ["釧路ク", "釧路ク", "釧路ク", "釧路ク", "釧路ク", "釧路ク", "根室ク", "標茶ク"]);
  db.ensureDraftSheet(t.id, "S");
  const c = db.confirmSheet(t.id, "S", { reason: "検証", by: "t" });
  assert.ok(c.ok, "確定できること: " + c.error);

  const a = sig(drawPairs(t, "s1"));
  const b = sig(drawPairs(t, "s2"));
  const d = sig(drawPairs(t, "s3"));
  assert.ok(a !== b || b !== d, "抽選種ごとに配置が変わること(全て同一なら抽選が死んでいる)");
});

test("確定は entrants.seed を書き換えない(シード順位の意味を壊さない)", () => {
  const t = mkEvent(["a1", "a2", "a3", "a4"]);
  db.ensureDraftSheet(t.id, "S");
  db.confirmSheet(t.id, "S", { reason: "検証", by: "t" });
  const seeds = db.listEntrants
    ? db.listEntrants(t.id).map(e => e.seed)
    : db.getEntries(t.id).map(e => e.seed);
  assert.deepStrictEqual([...new Set(seeds)], [0], "全員 seed=0 のまま(シード指定なしの状態を保つ)");
});

test("確定後も紙の通し番号(bracket_number)は採番されている", () => {
  const t = mkEvent(["a1", "a2", "a3", "a4"]);
  db.ensureDraftSheet(t.id, "S");
  db.confirmSheet(t.id, "S", { reason: "検証", by: "t" });
  // getEntries は表示用に整形した結果で bracket_number を含まないため、名簿データ
  // (buildRosterData)を使う。紙の通し番号はここが正本で、番号一致はこちらが担う。
  const roster = db.buildRosterData(t.id);
  const ev = (roster.events || []).find(e => e.name === "S");
  assert.ok(ev, "名簿データに種目があること");
  const nums = ev.entrants.filter(e => e.no_assigned).map(e => e.no);
  assert.strictEqual(nums.length, 4, "全員に通し番号が付く");
  assert.deepStrictEqual([...nums].sort((x, y) => x - y), [1, 2, 3, 4]);
});

test("確定後の抽選でも同所属の1回戦対戦が悪化しない", () => {
  const teams = ["釧路ク", "釧路ク", "釧路ク", "釧路ク", "釧路ク", "釧路ク", "根室ク", "標茶ク"];
  const names = ["a1", "a2", "a3", "a4", "a5", "a6", "b1", "b2"];
  const before = mkEvent(names, teams);
  const beforeConflicts = drawPairs(before, "s1").r1_same_club;

  const after = mkEvent(names, teams);
  db.ensureDraftSheet(after.id, "S");
  db.confirmSheet(after.id, "S", { reason: "検証", by: "t" });
  const afterConflicts = drawPairs(after, "s1").r1_same_club;

  assert.ok(afterConflicts <= beforeConflicts,
    `確定後に同所属対戦が増えないこと(確定前 ${beforeConflicts} → 確定後 ${afterConflicts})`);
});

test("シード指定がある種目では、確定してもシードとして扱われ続ける", () => {
  const t = mkEvent(["s1", "s2", "x1", "x2", "x3", "x4", "x5", "x6"]);
  // 先頭2人に本来のシード順位を与える
  const ents = db.getEntries(t.id);
  db.setEntrantSeed(ents.find(e => e.name === "s1").id, 1, { source: "manual" });
  db.setEntrantSeed(ents.find(e => e.name === "s2").id, 2, { source: "manual" });
  db.ensureDraftSheet(t.id, "S");
  db.confirmSheet(t.id, "S", { reason: "検証", by: "t" });
  const seeded = db.getEntries(t.id).filter(e => (e.seed || 0) >= 1).map(e => e.name).sort();
  assert.deepStrictEqual(seeded, ["s1", "s2"], "指定した2人だけがシードのまま(全員シードにならない)");
});

// ── ② 当日差替でスーパーシード(大罫線)が消えないこと ──────────────
test("大罫線の枠に補欠を差し替えても、枠の登場回戦が保たれる", () => {
  const t = mkEvent(["P1", "P2", "P3", "P4", "P5", "P6"]);
  const d = db.ensureDraftSheet(t.id, "S");
  const o = db.applySheetOps(t.id, "S", d.sheet_hash, [{ op: "set_entry_round", pos: 0, entry_round: 3 }]);
  assert.ok(o.ok, "大罫線を作れること: " + o.error);
  const c = db.confirmSheet(t.id, "S", { reason: "検証", by: "t" });
  assert.ok(c.ok, "確定できること: " + c.error);

  const st = db.getSheetState(t.id, "S");
  assert.strictEqual(st.confirmed.seats.find(s => s.pos === 0).entry_round, 3, "確定時点で枠1は3回戦から");
  const sub = st.unplaced[0];
  assert.ok(sub, "未配置(押し出された選手)がいること");

  const p = db.patchSheet(t.id, "S", { type: "substitute", pos: 0, entrant_id: sub.id, reason: "体調不良", by: "t" });
  assert.ok(p.ok, "当日差替ができること: " + p.error);

  const st2 = db.getSheetState(t.id, "S");
  assert.strictEqual(st2.confirmed.seats.find(s => s.pos === 0).entry_round, 3,
    "差替後も枠1は3回戦から(正本から大罫線が消えない)");
});

test("差し替わった選手の登場回戦も枠に合わせられる", () => {
  const t = mkEvent(["P1", "P2", "P3", "P4", "P5", "P6"]);
  const d = db.ensureDraftSheet(t.id, "S");
  db.applySheetOps(t.id, "S", d.sheet_hash, [{ op: "set_entry_round", pos: 0, entry_round: 3 }]);
  db.confirmSheet(t.id, "S", { reason: "検証", by: "t" });
  const sub = db.getSheetState(t.id, "S").unplaced[0];
  db.patchSheet(t.id, "S", { type: "substitute", pos: 0, entrant_id: sub.id, reason: "体調不良", by: "t" });
  const after = db.getEntries(t.id).find(e => e.id === sub.id);
  assert.strictEqual(after.entry_round, 3, "枠の登場回戦(3)に合わせられる");
});

test("当日差替も entrants.seed を書き換えない", () => {
  const t = mkEvent(["P1", "P2", "P3", "P4"]);
  db.ensureDraftSheet(t.id, "S");
  db.confirmSheet(t.id, "S", { reason: "検証", by: "t" });
  // 1枠空けてから差し替える
  const st = db.getSheetState(t.id, "S");
  const seats = st.confirmed.seats.filter(s => s.entrant_id);
  const p = db.patchSheet(t.id, "S", {
    type: "swap", a_pos: seats[0].pos, b_pos: seats[1].pos, reason: "当日調整", by: "t",
  });
  assert.ok(p.ok, "当日入替ができること: " + p.error);
  const seeds = db.getEntries(t.id).map(e => e.seed);
  assert.deepStrictEqual([...new Set(seeds)], [0], "入替でも seed は 0 のまま");
});
