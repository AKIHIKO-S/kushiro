// 一括処理の2段階(プレビュー→承認→実行)の回帰(2026-11-18 修正指示書 P2-9)。
// プレビュー(dry_run)は件数と 変更前→変更後 の見本だけを返し、何も書き換えないことを固定する。
// 氏名はすべて合成(実在の選手名を使わない)。
process.env.DB_PATH = "/tmp/ktta_bulkpreview_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

test("推定値で一括修正: dry_run は変更前→変更後を返し、書き換えない", () => {
  const t = db.createTournament({ name: "見本確認", date: "2028-03-01" });
  const ids = [];
  for (let i = 1; i <= 3; i++) ids.push(db.createEntrant({ tournament_id: t.id, event: "男子シングルス",
    name: "丙野 " + i + "郎", team: "釧路湖陵", furigana: "へいの" }).id);
  const v = db.createEntrant({ tournament_id: t.id, event: "男子シングルス", name: "丙野 四郎", team: "釧路 湖陵", furigana: "へいの" });
  const pre = db.bulkFixEntrantInference(t.id, { club: true, dry_run: true });
  assert.strictEqual(pre.dry_run, true);
  assert.strictEqual(pre.count, 1);
  assert.deepStrictEqual(pre.changes[0].fields, [{ field: "team", before: "釧路 湖陵", after: "釧路湖陵" }]);
  assert.strictEqual(db.getEntrant(v.id).team, "釧路 湖陵", "プレビューでは書き換えない");
  const done = db.bulkFixEntrantInference(t.id, { club: true });
  assert.strictEqual(done.fixed, pre.count, "プレビューの件数と実行の件数が一致する");
  assert.strictEqual(db.getEntrant(v.id).team, "釧路湖陵");
});

test("チーム名混入の削除: dry_run は件数と見本だけで消さない。統合済みの登録は対象外", () => {
  // 画面からはチーム名で登録できないので、昔の取込で入ってしまった状態を直接作る
  const raw = new (require("better-sqlite3"))(process.env.DB_PATH);
  const bad = { id: "zz9001" };
  raw.prepare("INSERT INTO players (id, name, team) VALUES (?, ?, '')").run(bad.id, "釧路市立第九中学校");
  raw.prepare("INSERT INTO players (id, name, team, merged_into) VALUES (?, ?, '', ?)").run("zz9002", "釧路市立第十中学校", bad.id);
  raw.close();
  const ok = db.createPlayer({ name: "丁田 花子", team: "釧路クラブ", furigana: "ていだ はなこ" });
  const pre = db.cleanupInvalidPlayers({ dry_run: true });
  assert.strictEqual(pre.dry_run, true);
  assert.ok(pre.count >= 1 && pre.samples.some(x => x.id === bad.id));
  assert.ok(!pre.samples.some(x => x.id === ok.id), "人名は対象にしない");
  assert.ok(!pre.samples.some(x => x.id === "zz9002"), "統合済み(リダイレクト)の登録は残す");
  assert.ok(db.getPlayers().some(p => p.id === bad.id), "プレビューでは消さない");
  const done = db.cleanupInvalidPlayers();
  assert.strictEqual(done.removed, pre.count, "プレビューの件数と実行の件数が一致する");
  assert.ok(db.getPlayers().some(p => p.id === ok.id));
});
