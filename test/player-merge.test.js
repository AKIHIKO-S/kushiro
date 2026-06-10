// 選手マージ(リダイレクト方式)の回帰テスト。
//  - 選手IDを参照する全テーブル(下の REF_COLS)が survivor へ付け替わる(coach_players/player_requests 含む)
//  - dup は物理削除されず merged_into でリダイレクト、一覧/重複候補から除外
//  - unmerge は台帳(refs_json)に記録された行「だけ」を戻す(survivor 固有の行は不動)
//  - チェーン(C→B→A)の解決と LIFO 取り消し制約
// 実行: node --test test/player-merge.test.js
process.env.DB_PATH = "/tmp/ktta_pmerge_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const Database = require("better-sqlite3");
const db = require("../db");
const raw = new Database(process.env.DB_PATH);   // 検証用の直接続 (同一プロセス・WAL)

after(() => {
  try { raw.close(); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// 実装(db.js MERGE_REPOINT + 複合PK処理)と独立に列挙した参照リスト。
// 漏れ検知のため、ここに挙げた全列で「dup 参照ゼロ」を断定する。
const REF_COLS = [
  ["matches", "winner_id"], ["matches", "loser_id"], ["matches", "referee_id"],
  ["matches", "player1_id"], ["matches", "player2_id"],
  ["achievements", "player_id"],
  ["entrants", "player_id"], ["entrants", "partner_player_id"],
  ["push_subscriptions", "player_id"],
  ["tournament_players", "player_id"],
  ["coach_players", "player_id"],
  ["player_requests", "player_id"],
];
const countRef = (tbl, col, pid) =>
  raw.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE ${col} = ?`).get(pid).n;

let seq = 0;
const uid2 = () => "pm" + (++seq) + "_" + process.pid;
function mkPlayer(name, team) {
  return db.createPlayer({ name, team: team || "", gender: "male" });
}
function rawMatch(tid, fields) {
  const id = uid2();
  raw.prepare(`INSERT INTO matches (id, tournament_id, event, round, status, winner_name, loser_name, sets_json,
      winner_id, loser_id, referee_id, player1_id, player2_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, "単", "1回戦", "completed", "甲", "乙", "[]",
      fields.winner_id || null, fields.loser_id || null, fields.referee_id || null,
      fields.player1_id || null, fields.player2_id || null);
  return id;
}

test("マージ: 全参照テーブルが survivor へ付け替わり dup はリダイレクトとして残る", () => {
  const t = db.createTournament({ name: "マージ検証", date: "2027-01-01" });
  const sv = mkPlayer("統合正幸");                  // survivor: team 空欄(補完テスト用)
  const dp = mkPlayer("統合正幸", "凍結クラブ");     // dup: team あり
  // dup を参照する行を全テーブルに用意
  rawMatch(t.id, { winner_id: dp.id, player1_id: dp.id });
  rawMatch(t.id, { loser_id: dp.id, player2_id: dp.id, referee_id: dp.id });
  const svOwnMatch = rawMatch(t.id, { winner_id: sv.id });   // survivor 固有の行(undo 後も不動を確認)
  raw.prepare(`INSERT INTO achievements (id, player_id, event, place, year) VALUES (?,?,?,?,?)`)
    .run(uid2(), dp.id, "男子シングルス", 1, 2026);
  raw.prepare(`INSERT INTO entrants (id, tournament_id, event, name, player_id) VALUES (?,?,?,?,?)`)
    .run(uid2(), t.id, "単", "統合正幸", dp.id);
  raw.prepare(`INSERT INTO entrants (id, tournament_id, event, name, partner_player_id) VALUES (?,?,?,?,?)`)
    .run(uid2(), t.id, "複", "誰か/統合正幸", dp.id);
  raw.prepare(`INSERT INTO push_subscriptions (endpoint, player_id, subscription_json) VALUES (?,?,?)`)
    .run("https://push.example/" + uid2(), dp.id, "{}");
  // tournament_players: E1=survivor と衝突 / E2=非衝突(付け替え)
  raw.prepare(`INSERT INTO tournament_players (tournament_id, player_id, event, seed) VALUES (?,?,?,?)`)
    .run(t.id, sv.id, "E1", 1);
  raw.prepare(`INSERT INTO tournament_players (tournament_id, player_id, event, seed) VALUES (?,?,?,?)`)
    .run(t.id, dp.id, "E1", 5);
  raw.prepare(`INSERT INTO tournament_players (tournament_id, player_id, event, seed) VALUES (?,?,?,?)`)
    .run(t.id, dp.id, "E2", 2);
  // coach_players: coach1=衝突 / coach2=付け替え (旧実装は付け替え漏れで CASCADE 消失していた列)
  raw.prepare(`INSERT INTO coach_accounts (id, name, login_code) VALUES (?,?,?)`).run("co1", "監督1", "C1" + uid2());
  raw.prepare(`INSERT INTO coach_accounts (id, name, login_code) VALUES (?,?,?)`).run("co2", "監督2", "C2" + uid2());
  raw.prepare(`INSERT INTO coach_players (coach_id, player_id) VALUES (?,?)`).run("co1", sv.id);
  raw.prepare(`INSERT INTO coach_players (coach_id, player_id) VALUES (?,?)`).run("co1", dp.id);
  raw.prepare(`INSERT INTO coach_players (coach_id, player_id) VALUES (?,?)`).run("co2", dp.id);
  raw.prepare(`INSERT INTO player_requests (id, coach_id, player_id, type) VALUES (?,?,?,?)`)
    .run(uid2(), "co1", dp.id, "edit");

  const r = db.mergePlayers(sv.id, dp.id, { operator: "テスト担当" });
  assert.ok(r.ok && r.merge_id, "マージ成功: " + JSON.stringify(r.error || ""));

  // 全列で dup 参照ゼロ(漏れ検知)
  for (const [tbl, col] of REF_COLS) {
    assert.strictEqual(countRef(tbl, col, dp.id), 0, `${tbl}.${col} に dup 参照が残っていない`);
  }
  // dup 行は残存しリダイレクト
  const dupRow = raw.prepare(`SELECT * FROM players WHERE id = ?`).get(dp.id);
  assert.ok(dupRow, "dup は物理削除されない");
  assert.strictEqual(dupRow.merged_into, sv.id, "merged_into=survivor");
  // 付け替え結果の件数
  assert.strictEqual(countRef("coach_players", "player_id", sv.id), 2, "co1(衝突解消)+co2(付替)");
  assert.strictEqual(raw.prepare(`SELECT COUNT(*) AS n FROM tournament_players WHERE player_id=? AND event='E2'`).get(sv.id).n, 1);
  // 空欄補完: survivor の team が dup の値で埋まる
  assert.strictEqual(raw.prepare(`SELECT team FROM players WHERE id=?`).get(sv.id).team, "凍結クラブ");
  // 台帳
  const log = raw.prepare(`SELECT * FROM player_merges WHERE id = ?`).get(r.merge_id);
  assert.strictEqual(log.operator, "テスト担当");
  assert.ok(JSON.parse(log.refs_json)["matches.winner_id"].length === 1);

  // リダイレクト解決と一覧除外
  const viaOld = db.getPlayer(dp.id);
  assert.strictEqual(viaOld.id, sv.id, "旧IDで引くと survivor が返る");
  assert.strictEqual(viaOld.redirected_from, dp.id);
  assert.ok(!db.getPlayers().some(p => p.id === dp.id), "一覧から dup は除外");
  const cand = db.findDuplicatePlayerCandidates();
  assert.ok(!(cand.groups || cand || []).some(g => (g.players || []).some(p => p.id === dp.id)),
    "重複候補に統合済みIDは再出現しない");

  // ガード: 統合済み行は編集/削除不可、survivor もリダイレクトが残る間は削除不可
  assert.strictEqual(db.updatePlayer(dp.id, { name: "改ざん" }), null);
  assert.ok(db.deletePlayer(dp.id).error, "統合済みは削除不可");
  assert.ok(db.deletePlayer(sv.id).error, "リダイレクト先は削除不可");

  // ── undo: 台帳の行だけが戻り、survivor 固有の行は不動 ──
  const u = db.unmergePlayers(r.merge_id, { operator: "取消担当" });
  assert.ok(u.ok, "取り消し成功: " + JSON.stringify(u.error || ""));
  assert.strictEqual(countRef("matches", "winner_id", dp.id), 1, "dup の勝ち試合が戻る");
  assert.strictEqual(raw.prepare(`SELECT winner_id FROM matches WHERE id=?`).get(svOwnMatch).winner_id,
    sv.id, "survivor 固有の行は不動");
  assert.strictEqual(countRef("coach_players", "player_id", dp.id), 2, "co1(復元)+co2(戻し)");
  assert.strictEqual(raw.prepare(`SELECT COUNT(*) AS n FROM tournament_players WHERE player_id=? AND event='E1'`).get(dp.id).n,
    1, "衝突で退避した行が復元");
  assert.strictEqual(raw.prepare(`SELECT team FROM players WHERE id=?`).get(sv.id).team, "", "補完フィールドが空欄へ戻る");
  assert.strictEqual(raw.prepare(`SELECT merged_into FROM players WHERE id=?`).get(dp.id).merged_into, null);
  assert.ok(raw.prepare(`SELECT undone_at FROM player_merges WHERE id=?`).get(r.merge_id).undone_at, "undone_at 記入");
  assert.strictEqual(db.getPlayer(dp.id).id, dp.id, "旧IDが本人に戻る");
  // 二重取り消しはエラー
  assert.ok(db.unmergePlayers(r.merge_id).error, "二重取り消しは拒否");
});

test("チェーン C→B→A: 旧IDは最終先に解決され、取り消しは新しい順(LIFO)のみ", () => {
  const A = mkPlayer("連鎖一郎", "甲");
  const B = mkPlayer("連鎖一郎", "乙");
  const C = mkPlayer("連鎖一郎", "丙");
  const m1 = db.mergePlayers(B.id, C.id);   // C → B
  assert.ok(m1.ok);
  const m2 = db.mergePlayers(A.id, B.id);   // B → A
  assert.ok(m2.ok);
  assert.strictEqual(db.getPlayer(C.id).id, A.id, "C は A へチェーン解決");
  assert.strictEqual(db.resolvePlayerId(C.id), A.id);
  // 既統合の選手を再マージしようとするとエラー
  assert.ok(db.mergePlayers(A.id, C.id).error, "統合済み dup の再マージは拒否");
  // LIFO: 古い m1 から取り消そうとするとブロック
  const blocked = db.unmergePlayers(m1.merge_id);
  assert.ok(blocked.error && blocked.blocking_merge_id === m2.merge_id, "新しいマージが先");
  assert.ok(db.unmergePlayers(m2.merge_id).ok, "新しい方から取り消せる");
  assert.ok(db.unmergePlayers(m1.merge_id).ok, "続けて古い方も取り消せる");
  assert.strictEqual(db.getPlayer(C.id).id, C.id, "全取り消しで C 本人へ戻る");
});

test("マージ履歴: listPlayerMerges が新しい順に選手名付きで返す", () => {
  const X = mkPlayer("履歴花子", "X");
  const Y = mkPlayer("履歴花子", "Y");
  const r = db.mergePlayers(X.id, Y.id, { operator: "記録係" });
  const list = db.listPlayerMerges(10);
  assert.ok(list.length >= 1);
  const top = list[0];
  assert.strictEqual(top.id, r.merge_id, "最新のマージが先頭");
  assert.strictEqual(top.survivor_name, "履歴花子");
  assert.strictEqual(top.dup_name, "履歴花子");
  assert.strictEqual(top.operator, "記録係");
  assert.strictEqual(top.undone_at, "");
});

test("重複候補 slim に created_at が含まれる(既定の残存者=古いID判定用)", () => {
  // 候補抽出の対象は「正規化すると同名だが元表記が異なる」ペア(スペース表記ゆれ等)
  mkPlayer("候補次郎", "P");
  mkPlayer("候補　次郎", "Q");
  const r = db.findDuplicatePlayerCandidates();
  const g = r.groups.find(g => (g.players || []).some(p => p.name === "候補次郎"));
  assert.ok(g, "候補グループがある");
  assert.ok((g.players || []).every(p => "created_at" in p), "created_at を含む");
});
