// 大会の出場者の支部をまとめて指定する(オーナー依頼 2026-11-24)の回帰テスト。
//
// 守らせる不変条件:
//   ① プレビュー(dry_run)では何も変わらない
//   ② 既定は空欄の人だけ。別の支部の人は変えず、件数だけ数える(kept_other)
//   ③ overwrite で別の支部の人も変わる。すでに同じ支部(表記ゆれ含む)の人は変更に入れない
//   ④ 変わるのは支部だけ。所属(team)と所属履歴は変わらない
//   ⑤ その大会に出ていない選手には触れない
// 実行: node --test test/tournament-players-branch.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_tpbranch_" + process.pid + ".db");
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const EV = "男子シングルス";
const m = (pos, p1, p2) => ({ bracket_round: 1, bracket_pos: pos, player1_name: p1, player1_team: "検証中", player2_name: p2, player2_team: "検証中",
  result: { winner_name: p1, loser_name: p2, winner_sets: 3, loser_sets: 1, sets: [] } });
const byName = (n) => db.getPlayers({ search: n }).find(p => p.name === n);

function setup() {
  const mk = (name, branch) => db.createPlayer({ name, team: "検証中", branch, gender: "male", category: "middle" });
  mk("空欄 一郎", ""); mk("標茶 二郎", "標茶"); mk("釧路 三郎", "釧路"); mk("表記 四郎", "釧路市"); mk("外部 五郎", "");
  const t = db.createTournament({ name: "支部検証大会", date: "2099-12-06" });
  const r = db.importBracket(t.id, { format: "tabletennis-bracket-v1", event: EV, bracket_size: 4, matches: [
    m(0, "空欄 一郎", "標茶 二郎"), m(1, "釧路 三郎", "表記 四郎"), { bracket_round: 2, bracket_pos: 0, player1_name: "空欄 一郎", player1_team: "検証中", player2_name: "釧路 三郎", player2_team: "検証中" } ] });
  assert.ok(!r.error, r.error);
  return t;
}

test("①②④ 既定は空欄だけ。プレビューは何も変えず、所属は変わらない", () => {
  const t = setup();
  const pre = db.setTournamentPlayersBranch(t.id, "釧路", { dry_run: true });
  assert.strictEqual(pre.total, 4, "出場者は4名(出ていない外部 五郎は数えない)");
  assert.deepStrictEqual(pre.changes.map(c => c.name), ["空欄 一郎"]);
  assert.strictEqual(pre.kept_other, 1, "標茶は今回は変えない");
  assert.strictEqual(pre.already_same, 2, "釧路・釧路市(表記ゆれ)は同じ扱い");
  assert.strictEqual(byName("空欄 一郎").branch, "", "プレビューでは変わらない");
  const r = db.setTournamentPlayersBranch(t.id, "釧路", {});
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(byName("空欄 一郎").branch, "釧路");
  assert.strictEqual(byName("空欄 一郎").team, "検証中", "所属は変わらない");
  assert.strictEqual(byName("標茶 二郎").branch, "標茶", "別の支部は変えない");
});

test("③⑤ 上書きでは別の支部も変わる。大会に出ていない人には触れない", () => {
  const t = db.getTournaments().find(x => x.name === "支部検証大会");
  const pre = db.setTournamentPlayersBranch(t.id, "釧路", { dry_run: true, overwrite: true });
  assert.deepStrictEqual(pre.changes.map(c => [c.name, c.from]), [["標茶 二郎", "標茶"]]);
  const r = db.setTournamentPlayersBranch(t.id, "釧路", { overwrite: true });
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(byName("標茶 二郎").branch, "釧路");
  assert.strictEqual(byName("外部 五郎").branch, "", "出ていない人は変わらない");
  assert.ok(db.setTournamentPlayersBranch(t.id, "", {}).error, "支部が空なら拒否");
  assert.ok(db.setTournamentPlayersBranch("no-such", "釧路", {}).error, "大会が無ければ拒否");
});
