// コートレイアウト変更(setCourtLayout)・大会情報編集(updateTournament)が
// 進行フィンガープリント(getOpsFingerprint)を変えることを検証する。
// 変わらないと 公開 /live のキャッシュ・ETag 304・SSE通知が発火せず、
// 「台のレイアウトを変更しても閲覧/観戦画面に何も反映されない」固着になる(実バグ)。
// 実行: node --test test/layout-fingerprint.test.js
process.env.DB_PATH = "/tmp/ktta_layoutfp_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const Database = require("better-sqlite3");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// updated_at は秒粒度のため、直前の値を過去に退避してから変更する(同一秒のフレークを排除)
function backdate(tid) {
  const sq = new Database(process.env.DB_PATH);
  sq.prepare("UPDATE tournaments SET updated_at='2000-01-01 00:00:00' WHERE id=?").run(tid);
  sq.close();
}

test("setCourtLayout がフィンガープリントを変える(公開/liveキャッシュ・SSEが更新される)", () => {
  const t = db.createTournament({ name: "FP検証", date: "2027-01-01" });
  backdate(t.id);
  const fp1 = db.getOpsFingerprint(t.id).v;
  db.setCourtLayout(t.id, { court_rows: 2, court_cols: 5, hq_position: "top", numbering_origin: "top-left" });
  const fp2 = db.getOpsFingerprint(t.id).v;
  assert.notStrictEqual(fp2, fp1, "レイアウト変更でfpが変わる: " + fp1 + " → " + fp2);
});

test("updateTournament(会場名など)もフィンガープリントを変える", () => {
  const t = db.createTournament({ name: "FP検証2", date: "2027-01-01" });
  backdate(t.id);
  const fp1 = db.getOpsFingerprint(t.id).v;
  db.updateTournament(t.id, { venue: "新会場" });
  const fp2 = db.getOpsFingerprint(t.id).v;
  assert.notStrictEqual(fp2, fp1, "大会情報編集でfpが変わる");
});

test("フィンガープリントはETag安全(空白・引用符を含まない)", () => {
  const t = db.createTournament({ name: "FP検証3", date: "2027-01-01" });
  const fp = db.getOpsFingerprint(t.id).v;
  assert.ok(!/[\s"]/.test(fp), "空白/引用符なし: " + JSON.stringify(fp));
});
