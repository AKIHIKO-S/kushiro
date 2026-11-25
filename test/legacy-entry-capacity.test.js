// 旧申込経路の定員・冪等性・原子性。実データを参照せず、毎回専用DBを作る。
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const fixtureDir = fs.mkdtempSync(path.join(__dirname, ".legacy-entry-capacity-"));
process.env.DB_PATH = path.join(fixtureDir, "synthetic.db");
process.env.SNAPSHOT_DIR = path.join(fixtureDir, "snapshots");
const db = require("../db");
const raw = new Database(process.env.DB_PATH);
raw.pragma("busy_timeout = 0");
after(() => {
  raw.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

const MEN = "男子シングルス";
const WOMEN = "女子シングルス";
function tournament(settings = {}) {
  const t = db.createTournament({ name: "合成定員検証", date: "2099-06-01" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [
      { name: MEN, type: "singles", capacity: 1 },
      { name: WOMEN, type: "singles", capacity: 1 },
    ],
    ...settings,
  });
  return t;
}
const entry = (t, name, events = [MEN], extra = {}) => db.createEntry(t.id, {
  name, team: "合成クラブ", events, ...extra,
});
function snapshot() {
  return Object.fromEntries(["players", "affiliations", "tournament_players", "entrants"].map(table => [
    table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}
function full(r, pattern) {
  assert.match(r.error || "", pattern);
  assert.equal(r.full, true);
  assert.equal(r.validation, true);
}

test("旧申込も種目定員を守り、拒否時に選手・所属・申込を残さない", () => {
  const t = tournament();
  assert.equal(entry(t, "合成 甲").ok, true);
  const before = snapshot();
  full(entry(t, "合成 乙"), /男子シングルス.*定員/);
  assert.deepEqual(snapshot(), before);
});

test("種目に空きがあっても大会全体の定員で拒否する", () => {
  const t = tournament({ entry_capacity: 1 });
  assert.equal(entry(t, "総枠 甲").ok, true);
  const before = snapshot();
  full(entry(t, "総枠 乙", [WOMEN]), /この大会は定員/);
  assert.deepEqual(snapshot(), before);
});

test("複数種目の後ろが満員でも先の種目と新規選手を保存しない", () => {
  const t = tournament();
  assert.equal(entry(t, "複数 甲", [WOMEN]).ok, true);
  const before = snapshot();
  full(entry(t, "複数 乙", [MEN, WOMEN]), /女子シングルス.*定員/);
  assert.deepEqual(snapshot(), before);
});

test("複数種目の合計が大会の残り枠を超えたら全件拒否する", () => {
  const t = tournament({ entry_capacity: 1 });
  const before = snapshot();
  full(entry(t, "同時 甲", [MEN, WOMEN]), /この大会は残り1枠/);
  assert.deepEqual(snapshot(), before);
});

test("満員でも同一出場の冪等再送を受理し、応答の契約を保つ", () => {
  const t = tournament({ entry_capacity: 1 });
  const first = entry(t, "再送 甲");
  const id = db.getEntrants(t.id, MEN)[0].id;
  const replay = entry(t, "再送 甲");
  assert.deepEqual(replay, {
    ok: true, player_id: first.player_id, player_name: "再送 甲",
    events: [MEN], status: "confirmed", new_player: false,
  });
  assert.equal(first.new_player, true);
  assert.deepEqual(db.getEntrants(t.id, MEN).map(e => e.id), [id]);
  assert.equal(db.getEntryCapacityState(t.id).total_used, 1);
});

test("既存種目の再送と新規種目を混ぜても既存枠は加算しない", () => {
  const t = tournament({ entry_capacity: 2 });
  assert.equal(entry(t, "追加 甲").ok, true);
  assert.equal(entry(t, "追加 甲", [MEN, WOMEN]).ok, true);
  assert.equal(db.getEntryCapacityState(t.id).total_used, 2);
});

test("再送と満員種目の追加が混在したら選手の補完も残さない", () => {
  const t = tournament();
  const first = entry(t, "補完 甲");
  raw.prepare("UPDATE players SET furigana='' WHERE id=?").run(first.player_id);
  assert.equal(entry(t, "補完 乙", [WOMEN]).ok, true);
  const before = snapshot();
  full(entry(t, "補完 甲", [MEN, WOMEN], { furigana: "ほかん" }), /女子シングルス.*定員/);
  assert.deepEqual(snapshot(), before);
});

test("同じ種目の重複指定は1枠と数え、正規化後のevents応答を維持する", () => {
  const t = tournament({ entry_capacity: 1 });
  const r = entry(t, "重複 甲", [" " + MEN + " ", { name: MEN }, { event: MEN }, null, {}]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.events, [MEN, MEN, MEN]);
  assert.equal(db.getEntrants(t.id, MEN).length, 1);
  assert.equal(db.getEntryCapacityState(t.id).total_used, 1);
});

for (const status of ["rejected", "cancelled"]) {
  test(`${status}からの再登録は新規枠として満員なら拒否する`, () => {
    const t = tournament();
    assert.equal(entry(t, "復帰 " + status).ok, true);
    db.updateEntrant(db.getEntrants(t.id, MEN)[0].id, { status });
    assert.equal(entry(t, "占有 " + status).ok, true);
    const before = snapshot();
    full(entry(t, "復帰 " + status), /定員/);
    assert.deepEqual(snapshot(), before);
  });

  test(`${status}からの再登録は空きがあれば既存行を復帰させる`, () => {
    const t = tournament({ entry_capacity: 1 });
    assert.equal(entry(t, "空枠 " + status).ok, true);
    const id = db.getEntrants(t.id, MEN)[0].id;
    db.updateEntrant(id, { status });
    assert.equal(entry(t, "空枠 " + status).ok, true);
    assert.equal(db.getEntrant(id).status, "confirmed");
    assert.equal(db.getEntryCapacityState(t.id).total_used, 1);
    assert.equal(db.getEntrants(t.id, MEN).length, 1);
  });
}

test("承認待ちは枠を確保し、本人の再送では二重に数えない", () => {
  const t = tournament({ entry_capacity: 1 });
  assert.equal(entry(t, "待機 甲").ok, true);
  const id = db.getEntrants(t.id, MEN)[0].id;
  db.setEntrantStatus(id, "pending");
  full(entry(t, "待機 乙"), /定員/);
  assert.equal(entry(t, "待機 甲").ok, true);
  assert.equal(db.getEntrant(id).status, "confirmed");
});

test("選手IDが未連携の既存出場も氏名・所属一致なら冪等に扱う", () => {
  const t = tournament({ entry_capacity: 1 });
  const saved = db.createEntrant({ tournament_id: t.id, event: MEN, name: "未連携 甲", team: "合成クラブ" });
  const r = entry(t, "未連携 甲");
  assert.equal(r.ok, true);
  assert.equal(r.new_player, true);
  assert.deepEqual(db.getEntrants(t.id, MEN).map(e => e.id), [saved.id]);
  assert.equal(db.getEntryCapacityState(t.id).total_used, 1);
});

test("種目の単一文字列・オブジェクト対応と種目からの属性推定を保つ", () => {
  const t = tournament();
  assert.equal(entry(t, "文字列 甲", MEN).ok, true);
  assert.equal(entry(t, "属性 甲", { event: " 高校女子シングルス " }).ok, true);
  const e = db.getEntrants(t.id, "高校女子シングルス")[0];
  assert.equal(e.gender, "female");
  assert.equal(e.category, "high");
});

test("定員未設定の従来大会は制限しない", () => {
  const t = tournament({ event_config: [{ name: MEN, type: "singles" }] });
  for (const name of ["無制限 甲", "無制限 乙", "無制限 丙"]) {
    assert.equal(entry(t, name).ok, true);
  }
  assert.equal(db.getEntryCapacityState(t.id).total_used, 3);
});

test("auto_confirm指定によって公開申込の定員検証を回避できない", () => {
  const t = tournament();
  assert.equal(entry(t, "自動 甲").ok, true);
  full(entry(t, "自動 乙", [MEN], { auto_confirm: true }), /定員/);
});

test("2種目目の保存エラー時は1種目目・選手・所属もロールバックする", () => {
  const t = tournament();
  const before = snapshot();
  raw.exec(`CREATE TRIGGER legacy_capacity_save_failure BEFORE INSERT ON entrants
    WHEN NEW.event='${WOMEN}' BEGIN SELECT RAISE(ABORT, '合成保存エラー'); END`);
  try {
    assert.throws(() => entry(t, "障害 甲", [MEN, WOMEN]), /合成保存エラー/);
    assert.deepEqual(snapshot(), before);
  } finally {
    raw.exec("DROP TRIGGER legacy_capacity_save_failure");
  }
});

test("選手作成途中のエラーを応答へ変換しても選手だけを残さない", () => {
  const t = tournament();
  const before = snapshot();
  raw.exec(`CREATE TRIGGER legacy_capacity_player_failure BEFORE INSERT ON affiliations
    BEGIN SELECT RAISE(ABORT, '合成所属エラー'); END`);
  try {
    assert.match(entry(t, "所属障害 甲", [MEN, WOMEN]).error || "", /合成所属エラー/);
    assert.deepEqual(snapshot(), before);
  } finally {
    raw.exec("DROP TRIGGER legacy_capacity_player_failure");
  }
});

test("定員を数える前に書込ロックを取り、別接続の割込みを防ぐ", () => {
  const t = tournament();
  const competingWrite = raw.prepare("UPDATE tournaments SET name=name WHERE id=?");
  const originalPrepare = Database.prototype.prepare;
  let capacityChecked = false;
  Database.prototype.prepare = function(sql) {
    if (this !== raw && /SELECT event, COUNT\(\*\) c FROM entrants/.test(sql)) {
      capacityChecked = true;
      assert.throws(() => competingWrite.run(t.id), { code: "SQLITE_BUSY" });
    }
    return originalPrepare.call(this, sql);
  };
  try {
    assert.equal(entry(t, "排他 甲").ok, true);
    assert.equal(capacityChecked, true, "共通の定員集計が検証中に呼ばれる");
  } finally {
    Database.prototype.prepare = originalPrepare;
  }
  assert.doesNotThrow(() => competingWrite.run(t.id), "保存完了後はロックが解放される");
});
