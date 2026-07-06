// 対昨年 進捗レース(vs 昨年バー)の回帰テスト。
//  - 純ロジック _vsPrevCore: 昨年の同経過時点の完了数・差分を正しく出す
//  - _minActivity/_parseTs: 開始基準時刻の導出とタイムスタンプ解釈
//  - setCompareTournament: 比較対象リンクの設定/解除/自己参照拒否
//  - getOperationState 統合: 比較対象未指定は vs_prev=null(グレースフル)
// 実行: node --test test/vs-prev.test.js
process.env.DB_PATH = "/tmp/ktta_vsprev_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// 昨年大会の開始時刻を固定(絶対時刻)。各試合の finished_at を "開始+N分" で作る。
const START = new Date("2025-07-13T12:30:00");
function ts(minAfterStart) {
  const d = new Date(START.getTime() + minAfterStart * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function realMatch(finMin) {
  return { winner_name: "A", loser_name: "B", is_walkover: 0, status: "completed",
    called_at: ts(finMin - 5), started_at: ts(finMin - 5), finished_at: ts(finMin) };
}

test("_parseTs は空白区切りの localtime を解釈する", () => {
  assert.strictEqual(db._parseTs(""), null);
  assert.strictEqual(db._parseTs(null), null);
  const t = db._parseTs("2025-07-13 12:30:00");
  assert.strictEqual(t, new Date("2025-07-13T12:30:00").getTime());
});

test("_minActivity は最初の活動(呼出/開始/完了の最小)を返す", () => {
  const startPrev = db._minActivity([realMatch(60), realMatch(20), realMatch(90)]);
  // 最小の活動は 20分の試合の called_at(=15分)
  assert.strictEqual(startPrev, new Date(START.getTime() + 15 * 60000).getTime());
});

test("_vsPrevCore: 経過50分時点で昨年が何試合終えていたか+差分", () => {
  // 昨年: 20/40/60/80分に1試合ずつ完了(計4試合)、総数は5(未完1)
  const prev = [realMatch(20), realMatch(40), realMatch(60), realMatch(80),
    { winner_name: "A", loser_name: "B", is_walkover: 0, status: "on_table", called_at: ts(10), started_at: ts(10), finished_at: "" }];
  const startPrev = START.getTime();
  // 今年は同経過50分で3試合完了
  const r = db._vsPrevCore(prev, startPrev, 50, 3, "第51回テスト");
  assert.ok(r, "結果が返る");
  assert.strictEqual(r.total, 5, "昨年の実試合総数(BYE/不戦勝除く)");
  assert.strictEqual(r.done, 2, "経過50分時点で昨年は20分・40分の2試合完了");
  assert.strictEqual(r.delta, 1, "今年3 - 昨年2 = +1先行");
  assert.strictEqual(r.name, "第51回テスト");
  assert.ok(Math.abs(r.pct - 2 / 5) < 1e-9, "pct=昨年done/総数");
});

test("_vsPrevCore: 昨年より遅れ(delta 負)", () => {
  const prev = [realMatch(10), realMatch(20), realMatch(30), realMatch(40)];
  const r = db._vsPrevCore(prev, START.getTime(), 45, 1, "第51回");
  assert.strictEqual(r.done, 4, "45分時点で昨年は4試合完了");
  assert.strictEqual(r.delta, -3, "今年1 - 昨年4 = 3試合遅れ");
});

test("_vsPrevCore: 完了データが無ければ null(グレースフル)", () => {
  const prev = [{ winner_name: "A", loser_name: "B", is_walkover: 0, status: "on_table", finished_at: "" }];
  assert.strictEqual(db._vsPrevCore(prev, START.getTime(), 30, 1, "x"), null);
  // BYE/不戦勝のみも null
  const byeOnly = [{ winner_name: "BYE", loser_name: "B", is_walkover: 1, status: "completed", finished_at: ts(10) }];
  assert.strictEqual(db._vsPrevCore(byeOnly, START.getTime(), 30, 0, "x"), null);
});

test("setCompareTournament: 設定・解除・自己参照/不在の拒否", () => {
  const cur = db.createTournament({ name: "第52回", date: "2026-07-12" });
  const prev = db.createTournament({ name: "第51回", date: "2025-07-13" });
  // 正常設定
  const ok = db.setCompareTournament(cur.id, prev.id);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.compare_tournament_id, prev.id);
  assert.strictEqual(db.getTournament(cur.id).compare_tournament_id, prev.id);
  // 自己参照は拒否
  assert.ok(db.setCompareTournament(cur.id, cur.id).error);
  // 不在は拒否
  assert.ok(db.setCompareTournament(cur.id, "does-not-exist").error);
  // 空で解除
  const cleared = db.setCompareTournament(cur.id, "");
  assert.strictEqual(cleared.compare_tournament_id, "");
  assert.strictEqual(db.getTournament(cur.id).compare_tournament_id, "");
});

test("getOperationState: 比較対象未指定なら vs_prev は null", () => {
  const cur = db.createTournament({ name: "第52回B", date: "2026-07-12" });
  const st = db.getOperationState(cur.id);
  assert.ok(st, "state が返る");
  assert.strictEqual(st.vs_prev, null, "未指定はグレースフルに null");
});
