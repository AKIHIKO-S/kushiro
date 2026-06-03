// 抽選の記録(draw_log)・確定前プレビュー(dry_run)・事前検査(checkDrawReadiness)・取消(undoDraw)。
// 実行: node --test test/draw-audit.test.js
process.env.DB_PATH = "/tmp/ktta_drawaudit_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const EV = "男子シングルス";
let _seq = 0;
function setup(n, seedTop) {
  const t = db.createTournament({ name: "監査" + (++_seq), date: "2027-04-04" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= n; i++) entries.push({ event: EV, type: "singles", name: "選手" + String(i).padStart(2, "0"), team: "ク" + (i % 3) });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  db.getEntrants(t.id, EV).slice(0, seedTop || 0).forEach((e, k) => db.setEntrantSeed(e.id, k + 1));
  return t;
}
const r1Of = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
  .sort((a, b) => a.bracket_pos - b.bracket_pos).map(m => [m.player1_name, m.player2_name]);
const evMatchCount = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV).length;

test("プレビュー(dry_run): DBを書かずに組合せを返す", () => {
  const t = setup(8, 2);
  const p = db.drawSingleBracket(t.id, EV, { draw_seed: 11, preview: true });
  assert.ok(p.preview, "preview フラグ");
  assert.strictEqual(p.bracket_size, 8);
  assert.strictEqual(p.pairs.length, 4, "R1ペア4");
  assert.ok(p.pairs.every(pr => pr.p1 && pr.p2), "各ペアにp1/p2");
  assert.strictEqual(evMatchCount(t), 0, "プレビューはDBに書かない");
});

test("プレビューの種で確定すると同一配置(プレビュー=確定の一致)", () => {
  const t = setup(13, 4);
  const p = db.drawSingleBracket(t.id, EV, { draw_seed: 7, preview: true });
  const r = db.drawSingleBracket(t.id, EV, { draw_seed: p.draw_seed, drawn_by: "運営太郎" });
  assert.ok(r.success, "確定成功");
  // プレビューのペア(BYE除く実選手の並び)と確定R1が一致
  const previewNames = p.pairs.map(pr => [pr.p1.bye ? "BYE" : pr.p1.name, pr.p2.bye ? "BYE" : pr.p2.name]);
  assert.deepStrictEqual(r1Of(t), previewNames, "プレビューと確定が一致");
});

test("draw_log: 確定で1行記録・引き直しで supersede 連鎖・実施者名保存", () => {
  const t = setup(8, 0);
  db.drawSingleBracket(t.id, EV, { draw_seed: 1, drawn_by: "甲" });
  let log = db.getDrawLog(t.id, EV);
  assert.strictEqual(log.length, 1, "1回目で1行");
  assert.strictEqual(log[0].status, "committed");
  assert.strictEqual(log[0].drawn_by, "甲", "実施者名");
  assert.strictEqual(log[0].draw_seed, 1);
  assert.ok(log[0].entrants_hash && log[0].leaves_hash, "ハッシュ封印");
  db.drawSingleBracket(t.id, EV, { draw_seed: 2, drawn_by: "乙" });
  log = db.getDrawLog(t.id, EV);
  assert.strictEqual(log.length, 2, "引き直しで2行(全試行保持)");
  assert.strictEqual(log.filter(x => x.status === "committed").length, 1, "committedは最新1件");
  assert.strictEqual(log.filter(x => x.status === "superseded").length, 1, "旧は superseded");
});

test("undoDraw: 引き直しを取り消すと前の抽選に戻る", () => {
  const t = setup(8, 0);
  db.drawSingleBracket(t.id, EV, { draw_seed: 100, drawn_by: "甲" });
  const first = r1Of(t);
  db.drawSingleBracket(t.id, EV, { draw_seed: 200, drawn_by: "乙" });
  const second = r1Of(t);
  assert.notDeepStrictEqual(second, first, "別の種で配置が変わる");
  const u = db.undoDraw(t.id, EV);
  assert.ok(u.ok, "取消成功");
  assert.deepStrictEqual(r1Of(t), first, "取消で前の抽選へ復元");
  const log = db.getDrawLog(t.id, EV);
  assert.strictEqual(log.find(x => x.draw_seed === 200).status, "undone", "取消した抽選は undone");
  assert.strictEqual(log.find(x => x.draw_seed === 100).status, "committed", "前の抽選が committed に復帰");
});

test("undoDraw: 最初の抽選を取り消すとブラケットが消える", () => {
  const t = setup(8, 0);
  db.drawSingleBracket(t.id, EV, { draw_seed: 5, drawn_by: "甲" });
  assert.ok(evMatchCount(t) > 0, "抽選後は試合あり");
  const u = db.undoDraw(t.id, EV);
  assert.ok(u.ok);
  assert.strictEqual(evMatchCount(t), 0, "最初の抽選取消でブラケット消滅");
});

test("確定封印の差分: 抽選直後は原配置のまま・手修正で差分検知", () => {
  const t = setup(8, 0);
  db.drawSingleBracket(t.id, EV, { draw_seed: 1, drawn_by: "甲" });
  let d = db.getBracketDrawDiff(t.id, EV);
  assert.ok(d.has_draw, "抽選済み");
  assert.ok(d.intact && d.modified === 0, "直後は原配置のまま");
  assert.strictEqual(d.drawn_by, "甲", "実施者");
  // 2スロットを手修正(入替) → 差分2件
  const r = db.swapBracketSlots(t.id, EV, { pos: 0, slot: 1 }, { pos: 1, slot: 1 });
  assert.ok(r.success, "入替: " + JSON.stringify(r));
  d = db.getBracketDrawDiff(t.id, EV);
  assert.ok(!d.intact && d.modified === 2, "手修正2件検知: " + d.modified);
  assert.ok(d.changes.length === 2 && d.changes[0].original_name, "差分の内訳がある");
});

test("確定封印の差分: 未抽選なら has_draw=false", () => {
  const t = setup(8, 0);
  const d = db.getBracketDrawDiff(t.id, EV);
  assert.strictEqual(d.has_draw, false);
});

test("checkDrawReadiness: ブロック(2人未満/シード重複)と警告(承認待ち)", () => {
  // 2人未満
  const t1 = db.createTournament({ name: "検査1" + (++_seq), date: "2027-04-04" });
  db.updateEntrySettings(t1.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  db.createTeamEntry(t1.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries: [{ event: EV, type: "singles", name: "一人" }] });
  const c1 = db.checkDrawReadiness(t1.id, EV);
  assert.ok(!c1.ok && c1.issues.some(i => i.code === "too_few"), "2人未満はブロック");

  // シード重複
  const t2 = setup(8, 0);
  const es = db.getEntrants(t2.id, EV);
  db.setEntrantSeed(es[0].id, 1); db.setEntrantSeed(es[1].id, 1); // 重複
  const c2 = db.checkDrawReadiness(t2.id, EV);
  assert.ok(!c2.ok && c2.issues.some(i => i.code === "seed_dup"), "シード重複はブロック");

  // 正常
  const t3 = setup(8, 2);
  const c3 = db.checkDrawReadiness(t3.id, EV);
  assert.ok(c3.ok, "正常はok: " + JSON.stringify(c3.issues));
  assert.strictEqual(c3.bracket_size, 8);
});
