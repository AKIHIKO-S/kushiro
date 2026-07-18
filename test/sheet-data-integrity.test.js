// 案B Phase2 データ整合(2026-07-18):
//  2-2: 組番号(seed)=枠番号(pos+1) が「確定を通った瞬間」に全経路で成立する(座席編集swap/当日修正patch/取込)。
//       確定の共通経路 materializeSheet で同期するので、提出番号・枠・組番号が必ず一致する(番号一致保証)。
//  2-4: 結果入力済み種目で force無し確定が破壊ガードで失敗しても、entrants.entry_round を書き換えない
//       (materializeSheet は generateBracket 成功後にだけ entrants を更新する)。
// 実行: node --test test/sheet-data-integrity.test.js
process.env.DB_PATH = "/tmp/ktta_sheetdi_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

function setupConfirmed(name, date, event, n) {
  const t = db.createTournament({ name, date });
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ event, pos: i, name: "P" + i, furigana: "ぴ", team: "T" + i });
  assert.ok(db.importSheetRows(t.id, rows, { create_missing: true }).ok, "取込");
  assert.ok(db.confirmSheet(t.id, event, {}).ok, "初期確定");
  return t;
}
const entMap = (tid, ev) => new Map(db.getEntrants(tid, ev).map(e => [e.id, e]));

test("2-2: 座席編集(swap)→確定で 組番号(seed)=枠番号 が全席で一致(番号一致保証)", () => {
  const EV = "男子シングルス";
  const t = setupConfirmed("seed全経路同期", "2027-12-10", EV, 4);
  // 確定直後: 枠1..4 の seed=1..4
  const synth0 = db.synthesizeSheetFromMatches(t.id, EV);
  const pos0Before = (synth0.seats.find(s => s.pos === 0) || {}).entrant_id;
  const pos3Before = (synth0.seats.find(s => s.pos === 3) || {}).entrant_id;
  assert.ok(pos0Before && pos3Before && pos0Before !== pos3Before);

  // 枠1(pos0)と枠4(pos3)を入替 → 確定
  assert.ok(db.applySheetOps(t.id, EV, "", [{ op: "swap", a: 0, b: 3 }]).ok);
  assert.ok(db.confirmSheet(t.id, EV, {}).ok, "入替後の再確定");

  // 全席で seed=pos+1 が成立
  const synth = db.synthesizeSheetFromMatches(t.id, EV);
  const ent = entMap(t.id, EV);
  synth.seats.forEach(s => {
    if (s.entrant_id) assert.strictEqual(ent.get(s.entrant_id).seed, s.pos + 1, "枠" + (s.pos + 1) + "の組番号");
  });
  // 入替が実際に効いている(元・枠4の選手が枠1へ)
  const pos0After = (synth.seats.find(s => s.pos === 0) || {}).entrant_id;
  assert.strictEqual(pos0After, pos3Before, "元・枠4の選手が枠1に来て、その組番号は1");
  assert.strictEqual(ent.get(pos0After).seed, 1);
});

test("2-2: 当日修正(patch swap)後も 組番号=枠番号 が同期される", () => {
  const EV = "男子シングルス";
  const t = setupConfirmed("patch seed同期", "2027-12-12", EV, 4);
  // 進行前の当日入替(両枠とも未開始)。枠1と枠2を入替。
  const r = db.patchSheet(t.id, EV, { type: "swap", a_pos: 0, b_pos: 1, reason: "その他", by: "検証" });
  assert.ok(r.ok, JSON.stringify(r).slice(0, 150));
  const synth = db.synthesizeSheetFromMatches(t.id, EV);
  const ent = entMap(t.id, EV);
  synth.seats.forEach(s => {
    if (s.entrant_id) assert.strictEqual(ent.get(s.entrant_id).seed, s.pos + 1, "patch後 枠" + (s.pos + 1) + "の組番号");
  });
});

test("2-4: 結果入力済みで force無し確定が失敗しても entrants.entry_round は不変(副作用リークなし)", () => {
  const EV = "男子シングルス";
  const t = setupConfirmed("er不変", "2027-12-11", EV, 8);
  // 実対戦を1つ消化(破壊ガードの発火条件=結果入力済み)
  const real = db.getMatchesByTournament(t.id).filter(m => m.event === EV && (m.bracket_round || 1) === 1
    && m.player1_name && m.player2_name && m.player1_name !== "BYE" && m.player2_name !== "BYE");
  assert.ok(real.length, "実対戦がある");
  db.finishMatchOp(real[0].id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });

  const target = db.getEntrants(t.id, EV).find(e => e.seed === 5);
  assert.ok(target, "枠5の選手");
  const before = parseInt(target.entry_round) || 1;

  // 下書きで枠5の登場回戦を2に(自動で大罫線)→ force無し確定
  const dr = db.ensureDraftSheet(t.id, EV);
  const seat = dr.seats.find(s => s.entrant_id === target.id);
  assert.ok(seat, "枠5が下書きにある");
  db.applySheetOps(t.id, EV, "", [{ op: "set_entry_round", pos: seat.pos, entry_round: 2 }]);
  const c = db.confirmSheet(t.id, EV, {});
  assert.ok(c.needs_force || c.error, "結果ありでforce無し確定は失敗: " + JSON.stringify(c).slice(0, 120));

  const after = parseInt(db.getEntrants(t.id, EV).find(e => e.id === target.id).entry_round) || 1;
  assert.strictEqual(after, before, "確定失敗時に entry_round が書き換わらない");
});

test("2-1: 表(matches)削除で確定シートが superseded になる(空の木を確定と誤認しない)", () => {
  const EV = "男子シングルス";
  const t = setupConfirmed("削除孤児化", "2027-12-13", EV, 4);
  assert.ok(db.getSheetState(t.id, EV).confirmed, "確定シートあり");
  const r = db.deleteEventMatches(t.id, EV, { force: true });
  assert.ok(r.ok, JSON.stringify(r).slice(0, 120));
  const st = db.getSheetState(t.id, EV);
  assert.ok(!st.confirmed, "表削除後は確定シートが無い(孤児化しない)");
});

test("2-1: 名簿削除で下書きシートも無効化される(死んだ出場IDを指す下書きを残さない)", () => {
  const EV = "男子シングルス";
  const t = setupConfirmed("名簿削除孤児化", "2027-12-14", EV, 4);
  const dr = db.ensureDraftSheet(t.id, EV);
  assert.ok(dr && !dr.error && db.getSheetState(t.id, EV).draft, "下書きあり");
  db.deleteRoster(t.id, EV);
  const st = db.getSheetState(t.id, EV);
  assert.ok(!st.draft && !st.confirmed, "名簿削除後は下書き・確定とも無い(superseded)");
});

test("2-5: 決勝Tの作り直しでシートが新IDで再生成される(旧IDを指す全BYE化を防ぐ)", () => {
  const EV = "男子シングルス";
  const PEV = EV + " 決勝T";
  const t = db.createTournament({ name: "決勝T再生成", date: "2027-12-15" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  for (let i = 1; i <= 4; i++) db.createEntrant({ tournament_id: t.id, event: EV, name: "L" + i, team: "T" + i, status: "confirmed" });
  assert.ok(!db.generateTeamLeague(t.id, EV, { num_blocks: 1 }).error, "リーグ生成");
  db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.league_block)
    .forEach(m => db.finishMatchOp(m.id, { winner_slot: 1, sets: [], winner_sets: 3, loser_sets: 0 }));
  // 決勝T生成 → migrate(この大会だけ)で確定シート化
  assert.ok(!db.generateLeaguePlayoff(t.id, EV, { mode: "top", advance_n: 2 }).error, "決勝T生成");
  db.migrateBracketSheets(t.id);
  assert.ok(db.getSheetState(t.id, PEV).confirmed, "決勝Tに確定シートができる");

  // 作り直し(force)=entrantを新IDで再作成 → 旧シートは削除され migrate が新IDで作り直す
  assert.ok(!db.generateLeaguePlayoff(t.id, EV, { mode: "top", advance_n: 2, force: true }).error, "決勝T作り直し");
  db.migrateBracketSheets(t.id);
  const st2 = db.getSheetState(t.id, PEV);
  assert.ok(st2.confirmed, "作り直し後も確定シートがある");
  const liveIds = new Set(db.getEntrants(t.id, PEV).map(e => e.id));
  const seated = (st2.confirmed.seats || []).filter(s => s.entrant_id);
  assert.ok(seated.length >= 2, "席に選手がいる(全BYE化していない)");
  seated.forEach(s => assert.ok(liveIds.has(s.entrant_id), "席の選手が現存(旧IDの死んだ席でない): " + s.entrant_id));
});
