// 申込された選手の選手DB連携(プレビュー→適用)と、重複候補の「別人(統合しない)」の回帰テスト。
//
// 守らせる不変条件:
//   ① 連携のプレビューは書き込まない。適用は、漢字+ふりがな一致=紐づけ・登録なし=新規登録・近い候補あり/ふりがななし=人が判断(自動で触らない)
//   ② 同じ人が複数の種目に出ていても、新規登録は1人ぶん。取消済みの申込は対象外。統合(マージ)はしない
//   ③ プレビュー後に変わったら適用しない(409)。もう一度適用しても二重登録しない
//   ④ 「別人」と判断した組は重複候補に出ず、取り消すと戻る
// 実行: node --test test/player-sync.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_psync_" + process.pid + ".db");
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const M = "一般男子シングルス", D = "一般男子ダブルス";
function tournament() {
  const t = db.createTournament({ name: "選手連携検証大会", date: "2099-12-06" });
  db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "", event_config: [{ name: M, type: "singles", fee: 700 }, { name: D, type: "doubles", fee: 1000 }] });
  return t;
}
let n = 0;
const single = (t, name, furi, team) => db.createTeamEntry(t.id, { team_name: team || "連携団" + (++n), contact_name: "担当 " + n, contact_tel: "1", contact_email: "s@example.com",
  entries: [{ event: M, type: "singles", name, furigana: furi, team: team || "連携クラブ" }] }, "ps" + n, {});
const dbl = (t, n1, f1, n2, f2) => db.createTeamEntry(t.id, { team_name: "ダブ団" + (++n), contact_name: "担当 " + n, contact_tel: "1", contact_email: "s@example.com",
  entries: [{ event: D, type: "doubles", name1: n1, name2: n2, furigana1: f1, furigana2: f2, team1: "ダブ", team2: "ダブ" }] }, "pd" + n, {});
const playerCount = () => db.getPlayers().length;

test("①②③ プレビューは書かない・適用は紐づけと新規登録だけ・統合しない・二重登録しない", () => {
  const t = tournament();
  single(t, "既存 一郎", "きそん いちろう");                    // 一致 → 紐づけ
  single(t, "新規 太郎", "しんき たろう");                      // 登録なし → 新規
  single(t, "近籐 次郎", "こんどう じろう");                    // 1字違い・読み一致 → 人が判断
  single(t, "読み 無し", "");                                    // ふりがななし → 対象外
  dbl(t, "新規 太郎", "しんき たろう", "相方 二郎", "あいかた じろう");   // 同じ人(新規 太郎)がダブルスにも → 登録は1人ぶん
  // 申込のあとで選手DBに登録された(取り込み後など)ので、申込時は未照合のまま
  const exist = db.createPlayer({ name: "既存 一郎", furigana: "きそん いちろう", team: "既存クラブ", gender: "male" });
  const near = db.createPlayer({ name: "近藤 次郎", furigana: "こんどう じろう", team: "近クラブ", gender: "male" });
  const cancelled = single(t, "取消 三郎", "とりけし さぶろう");
  const view = db.getSubmissionEditView(cancelled.submission_id, { admin: true });
  db.editSubmission(cancelled.submission_id, { entries: view.entries.map(e => ({ entrant_id: e.entry_id, cancel: true })), reason: "検証" }, { actor: "admin" });

  const before = playerCount();
  const plan = db.planEntrantPlayerSync(t.id);
  assert.strictEqual(playerCount(), before, "プレビューは書き込まない");
  assert.strictEqual(plan.summary.link, 1);
  assert.deepStrictEqual(plan.create.map(g => g.name).sort(), ["新規 太郎", "相方 二郎"], "新規は人ごとに1件(同じ人の2申込は1件にまとまる)");
  assert.strictEqual(plan.create.find(g => g.name === "新規 太郎").slots.length, 2);
  assert.ok(plan.review.some(r => r.name === "近籐 次郎"), "近い候補がある人は人が判断");
  assert.ok(plan.no_furigana.some(r => r.name === "読み 無し"));
  assert.ok(![...plan.link, ...plan.review, ...plan.no_furigana].some(r => r.name === "取消 三郎") && !plan.create.some(g => g.name === "取消 三郎"), "取消は対象外");

  // ③ プレビュー後に変わったら中止
  const stale = db.applyEntrantPlayerSync(t.id, { expected: { link: 9, create: 9 } });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(playerCount(), before);

  const r = db.applyEntrantPlayerSync(t.id, { expected: { link: plan.summary.link, create: plan.summary.create }, by: "OP1" });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.linked, 1); assert.strictEqual(r.created, 2);
  assert.strictEqual(playerCount(), before + 2, "新規登録は2人だけ(統合・書き換えなし)");
  // 紐づけ
  const linked = db.getEntrants(t.id).find(e => e.name === "既存 一郎");
  assert.strictEqual(linked.player_id, exist.id);
  const taro = db.getEntrants(t.id).filter(e => e.name === "新規 太郎");
  assert.strictEqual(new Set(taro.map(e => e.player_id)).size, 1, "同じ人は同じ選手に紐づく");
  // 既存の選手の内容は変わらない
  assert.strictEqual(db.getPlayer(near.id).name, "近藤 次郎");
  // もう一度適用しても増えない
  const again = db.applyEntrantPlayerSync(t.id, {});
  assert.ok(again.ok);
  assert.strictEqual(again.created, 0); assert.strictEqual(again.linked, 0);
  assert.strictEqual(playerCount(), before + 2);
});

test("④ 「別人」の組は重複候補に出ず、取り消すと戻る", () => {
  const a = db.createPlayer({ name: "同名 花子", furigana: "どうめい はなこ", team: "甲クラブ", gender: "female" });
  const b = db.createPlayer({ name: "同名 花子", furigana: "どうめい はなこ", team: "乙クラブ", gender: "female" });
  const has = () => db.findDuplicatePlayerCandidates().groups.some(g => g.players.map(p => p.id).sort().join() === [a.id, b.id].sort().join());
  assert.ok(has(), "最初は候補に出る");
  assert.ok(db.markPlayersNotSame(a.id, b.id, "OP1").ok);
  assert.ok(!has(), "別人と判断した組は出ない");
  assert.strictEqual(db.listPlayersNotSame().items.length, 1);
  assert.ok(db.markPlayersNotSame(b.id, a.id, "OP1").ok, "同じ組を順序違いで押しても1件のまま");
  assert.strictEqual(db.listPlayersNotSame().items.length, 1);
  db.unmarkPlayersNotSame(b.id, a.id);
  assert.ok(has(), "取り消すと候補に戻る");
  assert.ok(db.markPlayersNotSame(a.id, a.id).error, "同じ人どうしは不可");
});
