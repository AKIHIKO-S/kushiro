// 割当表正本(案B) P2 の回帰: 既存の表からのシート移行。
//  - 標準配線 → 第1版(confirmed)として正本化・tree_hash が現物と一致
//  - relink(自由配線)痕跡 → legacy_review(勝手に木を書き換えない)
//  - 終了済み大会 → 対象外 / 冪等(再実行で増えない) / 進行中 → 対象
// 実行: node --test test/sheet-migration.test.js
process.env.DB_PATH = "/tmp/ktta_sheetmig_" + process.pid + ".db";

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

const EV = "男子シングルス";
let seq = 0;
function setup(n) {
  const t = db.createTournament({ name: "移行検証" + (++seq), date: "2027-06-01" });
  for (let i = 1; i <= n; i++) db.createEntrant({ tournament_id: t.id, event: EV,
    name: "移" + String(i).padStart(2, "0"), team: "ク" + (i % 3), furigana: "い" + String(i).padStart(2, "0") });
  const gen = db.generateBracket(t.id, EV, {});
  assert.ok(gen && !gen.error);
  return t;
}
const sheetOf = (tid) => {
  const raw = new Database(process.env.DB_PATH, { readonly: true });
  const row = raw.prepare("SELECT * FROM bracket_sheets WHERE tournament_id=? AND event=?").all(tid, EV);
  raw.close();
  return row;
};

test("標準配線の種目は第1版(confirmed)として移行され、tree_hashが現物と一致する", () => {
  const t = setup(8);
  const r = db.migrateBracketSheets();
  assert.ok(r.migrated >= 1, "移行された: " + JSON.stringify(r));
  const rows = sheetOf(t.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, "confirmed");
  assert.strictEqual(rows[0].rev_no, 1);
  assert.strictEqual(rows[0].tree_hash, db.canonicalStructHash(t.id, EV), "突合ハッシュが現物と一致");
  assert.strictEqual(rows[0].sheet_hash,
    db.sheetHashOf(rows[0].size, JSON.parse(rows[0].seats_json)), "sheet_hashが正準計算と一致");
});

test("relink痕跡(非標準配線)の種目は legacy_review になる", () => {
  const t = setup(8);
  // R1試合0の進出先をR1試合3の進出先とswap(自由配線)
  const r1 = db.getMatchesByTournament(t.id).filter(m => m.bracket_round === 1)
    .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
  const rr = db.relinkBracketMatch(t.id, EV, r1[0].id, r1[3].next_match_id, r1[3].next_slot, {});
  assert.ok(rr && rr.success, JSON.stringify(rr));
  const r = db.migrateBracketSheets();
  assert.ok(r.legacy_review >= 1, "要確認が出た: " + JSON.stringify(r));
  const rows = sheetOf(t.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, "legacy_review");
  assert.strictEqual(rows[0].rev_no, 0, "確定版ではない");
});

test("終了済み大会は移行対象外・冪等で再実行しても増えない・進行中は対象", () => {
  const done = setup(4);
  db.updateTournament(done.id, { status: "completed" });
  const live = setup(4);
  db.updateTournament(live.id, { status: "ongoing" });
  const r1 = db.migrateBracketSheets();
  assert.strictEqual(sheetOf(done.id).length, 0, "終了済みはシートを作らない");
  assert.strictEqual(sheetOf(live.id).length, 1, "進行中は正本化される");
  const r2 = db.migrateBracketSheets();
  assert.strictEqual(r2.scanned, 0, "冪等: 2回目は対象ゼロ");
  assert.strictEqual(sheetOf(live.id).length, 1, "行が増えない");
});
