// トーナメント管理の自由入替＋選手DB選択の回帰。
//  - swapBracketMatches: 試合まるごと入替
//  - setBracketSlotFromPlayer: 選手マスタDBから枠へ(entrant自動解決)
//  - set-slot/swap の op_log undo
// 実行: node --test test/bracket-flex-edit.test.js
process.env.DB_PATH = "/tmp/ktta_flexedit_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const EV = "男子シングルス";
let _seq = 0;
function setup4() {
  const t = db.createTournament({ name: "flex" + (++_seq), date: "2027-12-20" });
  ["甲", "乙", "丙", "丁"].forEach((n, i) => db.createEntrant({ tournament_id: t.id, event: EV, surname: n, given_name: "一", team: "T" + i, status: "confirmed" }));
  db.generateBracket(t.id, EV, { regenerate: true });
  return t;
}
const r1 = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1).sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));

test("swapBracketMatches: 2試合の両選手を入替(配置以外は不変)", () => {
  const t = setup4();
  const before = r1(t);
  const m0 = before[0], m1 = before[1];
  const r = db.swapBracketMatches(t.id, EV, m0.bracket_pos, m1.bracket_pos);
  assert.ok(r && r.success, "入替成功: " + JSON.stringify(r));
  const after = r1(t);
  assert.strictEqual(after[0].player1_name, m1.player1_name, "pos0のp1がm1のp1に");
  assert.strictEqual(after[0].player2_name, m1.player2_name, "pos0のp2がm1のp2に");
  assert.strictEqual(after[1].player1_name, m0.player1_name, "pos1のp1がm0のp1に");
});

test("setBracketSlotFromPlayer: 未エントリーのマスタ選手を空き枠へ→entrant自動作成+紐付け", () => {
  const t = setup4();
  const p = db.createPlayer({ name: "新規 太郎", furigana: "しんき", team: "新規ク", gender: "male" });
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  const before = db.getEntrants(t.id, EV).length;
  const r = db.setBracketSlotFromPlayer(t.id, EV, 0, 2, p.id);
  assert.ok(r && r.success, "成功: " + JSON.stringify(r));
  const ents = db.getEntrants(t.id, EV);
  assert.strictEqual(ents.length, before + 1, "entrantが1件自動追加");
  const added = ents.find(e => e.player_id === p.id);
  assert.ok(added, "player_idで紐づくentrantがある");
  const m = r1(t)[0];
  assert.strictEqual(m.player2_name, added.display_name, "枠に選手名が入る: " + m.player2_name);
  assert.strictEqual(m.player2_entrant_id, added.id, "枠にentrant_idが入る");
});

test("setBracketSlotFromPlayer: 既存entrantがあるマスタ選手は再利用(増えない)・冪等", () => {
  const t = setup4();
  const p = db.createPlayer({ name: "既出 花子", furigana: "きしゅつ", team: "既出ク", gender: "female" });
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  db.setBracketSlotFromPlayer(t.id, EV, 0, 2, p.id);     // 1回目: 作成
  const n1 = db.getEntrants(t.id, EV).length;
  db.setBracketSlot(t.id, EV, 1, 2, { mode: "clear" });
  db.setBracketSlotFromPlayer(t.id, EV, 1, 2, p.id);     // 2回目: 同じ選手→再利用
  const n2 = db.getEntrants(t.id, EV).length;
  assert.strictEqual(n2, n1, "2回目は entrant を増やさない(player_idで再利用)");
});

test("undo: setBracketSlot(clear) を undoLastOp で元に戻せる", () => {
  const t = setup4();
  const before = r1(t)[0].player2_name;
  assert.ok(before, "pos0 slot2 に選手がいる");
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  assert.strictEqual(r1(t)[0].player2_name, "", "clearで空に");
  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo成功: " + JSON.stringify(u));
  assert.strictEqual(r1(t)[0].player2_name, before, "undoで選手が戻る: " + r1(t)[0].player2_name);
});

test("undo: swapBracketMatches を undoLastOp で元に戻せる", () => {
  const t = setup4();
  const before = r1(t).map(m => m.player1_name);
  db.swapBracketMatches(t.id, EV, 0, 1);
  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo成功");
  assert.deepStrictEqual(r1(t).map(m => m.player1_name), before, "undoで配置が戻る");
});

test("undo: swapBracketSlots(選手単位) を undoLastOp で元に戻せる", () => {
  const t = setup4();
  const before = r1(t).map(m => [m.player1_name, m.player2_name]);
  db.swapBracketSlots(t.id, EV, { pos: 0, slot: 1 }, { pos: 1, slot: 1 });
  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo成功");
  assert.deepStrictEqual(r1(t).map(m => [m.player1_name, m.player2_name]), before, "undoで配置が戻る");
});

test("setEntrantMemberFromPlayer: メンバーを選手マスタDBにリンク上書き(本人/相方)", () => {
  const t = db.createTournament({ name: "member" + (++_seq), date: "2027-12-30" });
  const DV = "混合ダブルス";
  const ent = db.createEntrant({ tournament_id: t.id, event: DV, is_doubles: 1,
    surname: "旧", given_name: "太", team: "旧A",
    partner_surname: "旧二", partner_given_name: "花", partner_team: "旧B", status: "confirmed" });
  db.generateBracket(t.id, DV, { regenerate: true });
  const p1 = db.createPlayer({ name: "桐山 慶次郎", furigana: "きりやま", team: "釧友会", gender: "male" });
  const p2 = db.createPlayer({ name: "難波 心愛", furigana: "なんば", team: "ワンスターTTC", gender: "female" });

  let r = db.setEntrantMemberFromPlayer(ent.id, false, p1.id);
  assert.ok(r && r.ok, "本人リンク成功: " + JSON.stringify(r));
  r = db.setEntrantMemberFromPlayer(ent.id, true, p2.id);
  assert.ok(r && r.ok, "相方リンク成功: " + JSON.stringify(r));

  const e2 = db.getEntrants(t.id, DV).find(x => x.id === ent.id);
  assert.strictEqual(e2.surname, "桐山", "本人姓=桐山");
  assert.strictEqual(e2.team, "釧友会", "本人所属=釧友会");
  assert.strictEqual(e2.furigana, "きりやま", "本人ふりがな");
  assert.strictEqual(e2.player_id, p1.id, "本人player_id 紐付け");
  assert.strictEqual(e2.partner_surname, "難波", "相方姓=難波");
  assert.strictEqual(e2.partner_team, "ワンスターTTC", "相方所属=ワンスターTTC");
  assert.strictEqual(e2.partner_player_id, p2.id, "相方player_id 紐付け");
});

test("setEntrantMemberFromPlayer: 同じ選手の他エントリー(他種目)へ伝播", () => {
  const t = db.createTournament({ name: "propa" + (++_seq), date: "2027-12-31" });
  const E1 = "混合ダブルス", E2 = "一般男子ダブルス";
  const ent1 = db.createEntrant({ tournament_id: t.id, event: E1, is_doubles: 1,
    surname: "桐山", given_name: "慶次郎", team: "旧X", partner_surname: "難波", partner_given_name: "心愛", partner_team: "旧Y", status: "confirmed" });
  const ent2 = db.createEntrant({ tournament_id: t.id, event: E2, is_doubles: 1,
    surname: "若林", given_name: "準", team: "道東", partner_surname: "桐山", partner_given_name: "慶次郎", partner_team: "旧Z", status: "confirmed" });
  db.generateBracket(t.id, E1, { regenerate: true });
  db.generateBracket(t.id, E2, { regenerate: true });
  const P = db.createPlayer({ name: "桐山 慶次郎", furigana: "きりやま", team: "釧友会", gender: "male" });

  // 1) 確認用: 同姓同名の候補(ent2の相方)が name_matches に返る
  let r = db.setEntrantMemberFromPlayer(ent1.id, false, P.id, { applyNameMatches: false });
  assert.ok(r && r.ok, "成功");
  assert.ok(r.name_matches.some(m => m.entrant_id === ent2.id && m.is_partner === true),
    "ent2の相方が同姓同名候補: " + JSON.stringify(r.name_matches));

  // 2) 反映: applyNameMatches で ent2 にも統一される
  r = db.setEntrantMemberFromPlayer(ent1.id, false, P.id, { applyNameMatches: true });
  assert.ok(r.propagated >= 1, "他1件以上に反映: " + r.propagated);
  const e2 = db.getEntrants(t.id, E2).find(x => x.id === ent2.id);
  assert.strictEqual(e2.partner_team, "釧友会", "ent2相方の所属が釧友会に: " + e2.partner_team);
  assert.strictEqual(e2.partner_player_id, P.id, "ent2相方が player_id 連携");

  // 3) 連携後は自動反映(確認不要)
  const r3 = db.setEntrantMemberFromPlayer(ent1.id, false, P.id, { applyNameMatches: false });
  assert.ok(r3.propagated >= 1, "連携済みは自動反映: " + r3.propagated);
});

test("setEntrantSeedRound: 紙順を保ったままシードを登場回戦へ(2回戦に直接・BYE上がり)", () => {
  const t = db.createTournament({ name: "seedround" + (++_seq), date: "2027-12-31" });
  const EV = "男子シングルス";
  ["甲", "乙", "丙", "丁", "戊", "己"].forEach((n, i) =>
    db.createEntrant({ tournament_id: t.id, event: EV, seed: i + 1, surname: n, given_name: "X", team: "T", status: "confirmed" }));
  // as_drawn 風に固定配置(seed=登場順)
  db.generateBracket(t.id, EV, { regenerate: true, fixedLeaves: db.getEntrants(t.id, EV).sort((a,b)=>a.seed-b.seed) });
  const kou = db.getEntrants(t.id, EV).find(e => e.surname === "甲");
  const r = db.setEntrantSeedRound(kou.id, 2);
  assert.ok(r && r.success, "シード化成功: " + JSON.stringify(r));
  // 甲は1回戦に実戦の相手がいない(vs BYE)→2回戦へ進出して登場
  const ms = db.getMatchesByTournament(t.id).filter(m => m.event === EV);
  const r1kou = ms.find(m => m.bracket_round === 1 && (m.player1_name || "").startsWith("甲"));
  assert.ok(r1kou && (r1kou.player2_name === "BYE" || r1kou.player1_name === "BYE"), "甲の1回戦はBYE(不戦勝): " + JSON.stringify(r1kou && [r1kou.player1_name, r1kou.player2_name]));
  const r2kou = ms.find(m => m.bracket_round === 2 && ((m.player1_name || "").startsWith("甲") || (m.player2_name || "").startsWith("甲")));
  assert.ok(r2kou, "甲が2回戦の枠に登場している");
  // 元のentry_round が保存されている
  const kou2 = db.getEntrants(t.id, EV).find(e => e.surname === "甲");
  assert.strictEqual(kou2.entry_round, 2, "entry_round=2 が保存");
});
