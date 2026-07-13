// Phase 3 回帰テスト: entry_categories(参加区分の自己申告)。
//  - 区分ごとの料金 fee_override をサーバが権威計算(クライアント値を信用しない)
//  - fee_override 空の区分は種目の一般料金にフォールバック
//  - 選択区分の表示ラベルを entrant.age_group に保存(名簿・集計用)
//  - entry_categories が無い種目は従来の fee_student セグメントを維持(後方互換)
//  - フォーム生成: entry_categories がクライアント EVENTS に埋め込まれ divSeg を生成できる
// 実行: node --test test/entry-category.test.js
process.env.DB_PATH = "/tmp/ktta_entcat_" + process.pid + ".db";
process.env.SNAPSHOT_DIR = "/tmp/ktta_entcat_snaps_" + process.pid;

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const entryForm = require("../entry_form");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
  try { fs.rmSync(process.env.SNAPSHOT_DIR, { recursive: true, force: true }); } catch (e) {}
});

const smallCats = [{
  name: "小学生シングルス", type: "singles", fee: 500,
  entry_categories: [
    { value: "hopes", label: "ホープス(4年以下)", short: "ホープス", fee_override: 400 },
    { value: "cub", label: "カブ(2年以下)", short: "カブ", fee_override: 300 },
    { value: "bambi", label: "バンビ(1年以下)", short: "バンビ", fee_override: "" },  // override空
  ],
}];

test("entry_categories: 選択区分の fee_override を権威計算(クライアント値を無視)", () => {
  const t = db.createTournament({ name: "区分料金", date: "2028-01-01", event_config: smallCats, entries_open: 1 });
  const r = db.createTeamEntry(t.id, {
    team_name: "甲", contact_name: "監督", contact_email: "a@b.jp",
    entries: [{ event: "小学生シングルス", type: "singles", name: "子A", team: "甲",
      division: "cub", division_label: "カブ", fee: 99999 }],  // クライアント供給 fee は嘘
  });
  assert.ok(r.ok);
  assert.strictEqual(r.total_amount, 300, "カブの fee_override 300 で権威計算(99999無視)");
  const ent = db.getEntrants(t.id).find(e => /子A/.test(e.name));
  assert.strictEqual(ent.fee, 300);
  assert.strictEqual(ent.division, "cub", "区分の value を division に保存");
  assert.strictEqual(ent.age_group, "カブ", "区分の表示ラベルを age_group に保存");
});

test("entry_categories: fee_override 空の区分は種目の一般料金にフォールバック", () => {
  const t = db.createTournament({ name: "override空", date: "2028-01-02", event_config: smallCats, entries_open: 1 });
  const r = db.createTeamEntry(t.id, {
    team_name: "乙", contact_name: "監督", contact_email: "a@b.jp",
    entries: [{ event: "小学生シングルス", type: "singles", name: "子B", team: "乙",
      division: "bambi", division_label: "バンビ", fee: 0 }],
  });
  assert.strictEqual(r.total_amount, 500, "バンビ(override空)は一般料金 500");
});

test("entry_categories 無しの種目は従来の fee_student セグメントを維持(後方互換)", () => {
  const stu = [{ name: "中学男子S", type: "singles", fee: 700, fee_student: 500 }];
  const t = db.createTournament({ name: "従来", date: "2028-01-03", event_config: stu, entries_open: 1 });
  const r = db.createTeamEntry(t.id, {
    team_name: "丙", contact_name: "監督", contact_email: "a@b.jp",
    entries: [{ event: "中学男子S", type: "singles", name: "生徒C", team: "丙", division: "middle", fee: 0 }],
  });
  assert.strictEqual(r.total_amount, 500, "中学生区分は fee_student 500(従来ロジック維持)");
});

test("buildEntryFormHTML: entry_categories がクライアント EVENTS に埋め込まれる", () => {
  const t = { id: "x", name: "区分描画", entries_open: 1 };
  const html = entryForm.buildEntryFormHTML(t, smallCats, {});
  assert.ok(/entry_categories/.test(html), "EVENTS に entry_categories が乗る(divSeg 生成の材料)");
  assert.ok(/ホープス/.test(html), "区分ラベルが埋め込まれる");
  assert.ok(/flex-wrap: wrap/.test(html), "区分セグメントは flex-wrap で狭画面でも折り返す");
});
