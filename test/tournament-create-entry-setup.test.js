// 新規大会作成と同時の申込設定保存 + よく使う種目(実績カタログ) の回帰テスト。
//  - createTournament に event_config(配列) を渡すと、作成と同時に種目・受付・締切・主催が保存される
//  - 種目ゼロで受付ON は DB 層で clamp される / entries_open は厳格 true|1 判定(文字列"false"を殺す)
//  - sync/tournament の row 形状(event_config が JSON文字列)では発火せず既存の同期挙動を変えない
//  - getUsedEventsCatalog は過去大会の event_config を集約し、中止大会を除外・使用回数順に返す
// 実行: node --test test/tournament-create-entry-setup.test.js
process.env.DB_PATH = "/tmp/ktta_create_entry_" + process.pid + ".db";
// 空の専用 SNAPSHOT_DIR を指定して自動復旧(安全網スナップからの復元)を無効化する。
// 既定は DB_PATH 隣の /tmp/snapshots で他テスト/開発DBと共有され、getUsedEventsCatalog が
// 無関係な大会の種目まで集約してしまうため(この関数は全大会横断で集計する仕様)。
process.env.SNAPSHOT_DIR = "/tmp/ktta_create_entry_snaps_" + process.pid;

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
  try { fs.rmSync(process.env.SNAPSHOT_DIR, { recursive: true, force: true }); } catch (e) {}
});

test("createTournament: event_config(配列)を渡すと作成と同時に種目・受付・締切・主催が保存される", () => {
  const t = db.createTournament({
    name: "作成同時保存検証", date: "2027-08-01", organizer: "釧路卓球協会",
    event_config: [
      { name: "男子シングルス 一般", type: "singles", fee: 700 },
      { name: "一般 団体戦", type: "team", fee: 4000, per_team: 4, tie_format: "D,S,S,S,S" },
    ],
    entry_events: ["男子シングルス 一般", "一般 団体戦"],
    entries_open: true,
    entry_deadline: "2027-07-25",
  });
  const saved = db.getTournament(t.id);
  assert.strictEqual(saved.entries_open, 1, "受付ONが保存される");
  assert.strictEqual(saved.organizer, "釧路卓球協会", "主催が作成時に保存される");
  assert.strictEqual(saved.entry_deadline, "2027-07-25", "締切が保存される");
  const ec = JSON.parse(saved.event_config);
  assert.strictEqual(ec.length, 2, "event_config の種目数");
  assert.strictEqual(ec[1].tie_format, "D,S,S,S,S", "団体戦の tie_format も保持される");
});

test("createTournament: 種目ゼロで受付ON は DB 層で clamp される", () => {
  const t = db.createTournament({
    name: "空種目受付ON検証", date: "2027-08-02",
    event_config: [], entries_open: true,
  });
  const saved = db.getTournament(t.id);
  assert.strictEqual(saved.entries_open, 0, "種目が無ければ受付ONは作られない(不変条件)");
});

test('createTournament: entries_open は厳格判定(文字列"false"は受付OFF)', () => {
  const t = db.createTournament({
    name: "文字列false検証", date: "2027-08-03",
    event_config: [{ name: "検証S", type: "singles", fee: 500 }],
    entries_open: "false",   // truthy な文字列でも受付ONにしてはいけない
  });
  const saved = db.getTournament(t.id);
  assert.strictEqual(saved.entries_open, 0, '文字列"false"は受付OFF');
});

test("createTournament: sync 形状(event_config が文字列)では発火せず同期挙動を変えない", () => {
  const t = db.createTournament({
    name: "同期形状検証", date: "2027-08-04",
    event_config: '[{"name":"同期種目","type":"singles","fee":700}]',   // row 由来の JSON文字列
    entries_open: 1, category: "general",
  });
  const saved = db.getTournament(t.id);
  assert.strictEqual(saved.entries_open, 0, "文字列 event_config では受付設定を発火させない(ミラー暴発防止)");
  // 文字列 event_config は createTournament では保存しない(従来どおり)。updateEntrySettings 経由のみ保存
  assert.ok(!saved.event_config, "文字列 event_config は作成時に保存されない(従来挙動を維持)");
});

test("updateEntrySettings: event_config を明示的に空で受付ON は clamp、フラグのみ切替は既存挙動維持", () => {
  // (a) event_config を空配列で明示 + 受付ON → clamp で 0
  const t1 = db.createTournament({ name: "編集clamp検証", date: "2027-09-01" });
  db.updateEntrySettings(t1.id, { entries_open: 1, event_config: [] });
  assert.strictEqual(db.getTournament(t1.id).entries_open, 0, "明示的な空種目+受付ONは編集経路でも clamp");

  // (b) event_config 未指定で受付フラグだけ切替 → 既存挙動維持(clampしない。種目は別途管理のケース)
  const t2 = db.createTournament({ name: "フラグ切替検証", date: "2027-09-02" });
  db.updateEntrySettings(t2.id, { entries_open: 1 });   // event_config を渡さない
  assert.strictEqual(db.getTournament(t2.id).entries_open, 1, "フラグのみ切替は clamp せず従来どおり受付ON");
});

test("getUsedEventsCatalog: 過去大会の種目を集約し、中止大会を除外・使用回数順に返す", () => {
  db.createTournament({
    name: "実績A", date: "2027-01-10",
    event_config: [
      { name: "共通シングルス", type: "singles", fee: 700 },
      { name: "実績A限定", type: "doubles", fee: 1000 },
    ],
  });
  db.createTournament({
    name: "実績B", date: "2027-02-10",
    event_config: [{ name: "共通シングルス", type: "singles", fee: 700 }],
  });
  db.createTournament({
    name: "中止大会", date: "2027-03-10", status: "cancelled",
    event_config: [{ name: "中止限定種目", type: "singles", fee: 999 }],
  });

  const cat = db.getUsedEventsCatalog();
  const byName = Object.fromEntries(cat.map(e => [e.name, e]));

  assert.ok(byName["共通シングルス"], "複数大会で使われた種目が出る");
  assert.strictEqual(byName["共通シングルス"].count, 2, "使用回数が集計される");
  assert.ok(byName["実績A限定"], "1大会だけの種目も出る");
  assert.strictEqual(byName["中止限定種目"], undefined, "中止大会の種目は実績から除外される");
  // 使用回数の多い順で共通シングルスが先頭側
  assert.strictEqual(cat[0].name, "共通シングルス", "使用回数が最多の種目が先頭");
});
