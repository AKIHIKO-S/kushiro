// セットカウント速報(setLiveScore/clearLiveScore)のDAL回帰。
// 「表示専用の暫定値」の契約を固定する: on_tableのみ書ける / 0..9クランプ /
// rev単調増加(クリアでも+1) / call・uncall・finishで消える / fingerprintが変化を拾う。
// 実行: node --test test/live-score.test.js
process.env.DB_PATH = "/tmp/ktta_livescore_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
let _seq = 0;
function setup(n) {
  const t = db.createTournament({ name: "速報検証" + (++_seq), date: "2027-07-20" });
  for (let i = 1; i <= n; i++) {
    db.createEntrant({ tournament_id: t.id, event: EV,
      name: "速報選手" + String(i).padStart(2, "0"), team: "ク" + (i % 3), furigana: "そ" + String(i).padStart(2, "0") });
  }
  db.generateBracket(t.id, EV, {});
  db.updateTournament(t.id, { status: "ongoing" });
  return t;
}
const firstReal = (tid) => db.getMatchesByTournament(tid)
  .find(m => m.event === EV && m.player1_name && m.player2_name &&
    m.player1_name !== "BYE" && m.player2_name !== "BYE" && m.status !== "completed");
const rowOf = (id) => db.getMatch(id);

test("on_table でない試合には書けない(pending は 409相当のエラー)", () => {
  const t = setup(4);
  const m = firstReal(t.id);
  const r = db.setLiveScore(m.id, { s1: 1, s2: 0 });
  assert.ok(r.error, "pending には書けない: " + JSON.stringify(r));
});

test("書込み: クランプ(0..9)・rev単調増加・パース済み取得", () => {
  const t = setup(4);
  const m = firstReal(t.id);
  db.callMatch(m.id, 1);
  const r1 = db.setLiveScore(m.id, { s1: 1, s2: 0 });
  assert.deepStrictEqual(r1.live, { s1: 1, s2: 0 }, "1-0 が書ける");
  const rev1 = rowOf(m.id).live_score_rev;
  const r2 = db.setLiveScore(m.id, { s1: 99, s2: -5 });
  assert.deepStrictEqual(r2.live, { s1: 9, s2: 0 }, "0..9 にクランプ");
  const rev2 = rowOf(m.id).live_score_rev;
  assert.ok(rev2 > rev1, "rev は書込みごとに増加: " + rev1 + " -> " + rev2);
  assert.deepStrictEqual(db.parseLiveScore(rowOf(m.id).live_sets_json), { s1: 9, s2: 0 }, "parseLiveScore で読める");
});

test("クリア3箇所: finish / uncall / 再call で消える(revは増える)", () => {
  const t = setup(8);
  const ms = db.getMatchesByTournament(t.id)
    .filter(m => m.event === EV && m.bracket_round === 1 && m.player1_name !== "BYE" && m.player2_name !== "BYE");
  assert.ok(ms.length >= 3, "実戦3試合以上");

  // (a) finish で消える
  db.callMatch(ms[0].id, 1);
  db.setLiveScore(ms[0].id, { s1: 2, s2: 1 });
  const revA = rowOf(ms[0].id).live_score_rev;
  db.finishMatchOp(ms[0].id, { winner_slot: 1, sets: [[11, 5], [11, 7], [11, 9]] });
  assert.strictEqual(rowOf(ms[0].id).live_sets_json, "", "finish で速報が消える");
  assert.ok(rowOf(ms[0].id).live_score_rev > revA, "クリアでも rev は増える(SUM検知の単調性)");

  // (b) uncall で消える
  db.callMatch(ms[1].id, 2);
  db.setLiveScore(ms[1].id, { s1: 1, s2: 1 });
  db.uncallMatch(ms[1].id);
  assert.strictEqual(rowOf(ms[1].id).live_sets_json, "", "uncall で速報が消える");

  // (c) 再call で前回の残留が消える(残っていた場合の保険経路)
  db.callMatch(ms[2].id, 3);
  db.setLiveScore(ms[2].id, { s1: 2, s2: 0 });
  // uncall はクリアするので、残留を作るため直接 DB を汚してから callMatch し直す
  db.uncallMatch(ms[2].id);
  const sqlite = require("better-sqlite3")(process.env.DB_PATH);
  sqlite.prepare("UPDATE matches SET live_sets_json=? WHERE id=?").run('{"s1":2,"s2":0}', ms[2].id);
  sqlite.close();
  db.callMatch(ms[2].id, 3);
  assert.strictEqual(rowOf(ms[2].id).live_sets_json, "", "call で前回の速報残留が消える");
});

test("getOpsFingerprint が速報の更新・クリアで変化する(SSE/ETag の起動根拠)", () => {
  const t = setup(4);
  const m = firstReal(t.id);
  db.callMatch(m.id, 1);
  const f0 = db.getOpsFingerprint(t.id).v;
  db.setLiveScore(m.id, { s1: 1, s2: 0 });
  const f1 = db.getOpsFingerprint(t.id).v;
  assert.notStrictEqual(f1, f0, "速報書込みで fingerprint が変化");
  db.setLiveScore(m.id, { s1: 1, s2: 1 });
  const f2 = db.getOpsFingerprint(t.id).v;
  assert.notStrictEqual(f2, f1, "更新でも変化");
  db.uncallMatch(m.id);   // クリア(uncall経由)
  const f3 = db.getOpsFingerprint(t.id).v;
  assert.notStrictEqual(f3, f2, "クリアでも変化(revが+1されるため)");
});

test("getOperationState の on_table にパース済み live が乗る", () => {
  const t = setup(4);
  const m = firstReal(t.id);
  db.callMatch(m.id, 1);
  db.setLiveScore(m.id, { s1: 2, s2: 1 });
  const st = db.getOperationState(t.id);
  const ot = st.on_table.find(x => x.id === m.id);
  assert.ok(ot, "on_table に載る");
  assert.deepStrictEqual(ot.live, { s1: 2, s2: 1 }, "live がパース済みで付く");
  // 速報なしの試合は null
  db.uncallMatch(m.id);
  db.callMatch(m.id, 1);
  const st2 = db.getOperationState(t.id);
  const ot2 = st2.on_table.find(x => x.id === m.id);
  assert.strictEqual(ot2.live, null, "速報なしは null");
});

test("getOpMatchList: 進行中行に live が乗り、生JSONは出ない", () => {
  const t = setup(4);
  const m = firstReal(t.id);
  db.callMatch(m.id, 1);
  db.setLiveScore(m.id, { s1: 1, s2: 2 });
  const list = db.getOpMatchList(t.id);
  const row = list.matches.find(x => x.id === m.id);
  assert.deepStrictEqual(row.live, { s1: 1, s2: 2 }, "live が乗る");
  assert.ok(!("live_sets_json" in row), "生JSONは含まれない");
});

test("getRefereeView: on_table 行に live_sets が乗る(審判画面の初期値用)", () => {
  const t = setup(4);
  const m = firstReal(t.id);
  db.callMatch(m.id, 1);
  db.setLiveScore(m.id, { s1: 2, s2: 2 });
  db.setRefereeToken(t.id, { enable: true });
  const view = db.getRefereeView(t.id, null);
  const row = view.on_table.find(x => x.id === m.id);
  assert.deepStrictEqual(row.live_sets, { s1: 2, s2: 2 }, "live_sets が乗る");
  assert.ok(!("live_sets_json" in row), "生JSONは出ない");
});
