// 申込フロー回帰テスト (Phase1: 申込の正本を entrants に統一)。
// 旧実装は admin の申込一覧/件数が tournament_players を読み、公開フォーム申込(entrants)が
// 一覧に出ず「申込なし」になっていた(C-1)。承認/却下も entrants に反映されなかった(C-2/H-3)。
// 実行: node --test test/entry-flow.test.js
process.env.DB_PATH = "/tmp/ktta_entryflow_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

function openTournament() {
  const t = db.createTournament({ name: "申込フロー検証", date: "2027-06-06" });
  db.updateEntrySettings(t.id, { entries_open: 1 });
  return t;
}

test("公開フォーム申込(createTeamEntry)が getEntries に出る (C-1)", () => {
  const t = openTournament();
  const r = db.createTeamEntry(t.id, {
    team_name: "甲高校", contact_name: "監督", contact_email: "a@b.jp",
    entries: [
      { event: "男子シングルス", type: "singles", name: "山田 太郎", team: "甲高校", fee: 500 },
      { event: "男子ダブルス", type: "doubles", name1: "佐藤 一", name2: "鈴木 二", team: "甲高校", fee: 1000 },
    ],
  });
  assert.ok(r.ok, "createTeamEntry 成功");
  const entries = db.getEntries(t.id);
  assert.strictEqual(entries.length, 2, "申込一覧に2件出る(旧実装は0だった)");
  // 公開フォーム申込は pending(承認待ち)で入る
  assert.ok(entries.every(e => e.entry_status === "pending"), "初期状態は pending");
  const singles = entries.find(e => e.entry_event === "男子シングルス");
  assert.ok(singles && singles.name === "山田 太郎", "氏名が出る");
  const dbl = entries.find(e => e.entry_event === "男子ダブルス");
  assert.ok(dbl && /佐藤/.test(dbl.name) && /鈴木/.test(dbl.name), "ダブルスはペア表示");
});

test("承認/却下が entrants に反映される (C-2/H-3)", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "乙", contact_name: "c", contact_email: "c@d.jp",
    entries: [{ event: "女子シングルス", type: "singles", name: "田中 花子", team: "乙", fee: 500 }] });
  const e = db.getEntries(t.id)[0];
  assert.strictEqual(e.entry_status, "pending");
  assert.ok(db.setEntrantStatus(e.id, "confirmed").ok);
  assert.strictEqual(db.getEntries(t.id)[0].entry_status, "confirmed", "承認が反映");
  assert.ok(db.setEntrantStatus(e.id, "rejected").ok);
  assert.strictEqual(db.getEntries(t.id)[0].entry_status, "rejected", "却下が反映");
  // 不正statusは拒否
  assert.ok(db.setEntrantStatus(e.id, "bogus").error, "不正statusはerror");
  assert.ok(db.setEntrantStatus("no-such-id", "confirmed").error, "存在しないidはerror");
});

test("admin直接追加(createEntry)も entrants の申込一覧に出る (H-1 収束)", () => {
  const t = openTournament();
  db.createEntry(t.id, { name: "直接 太郎", team: "丙大", events: ["男子シングルス"], auto_confirm: true });
  const entries = db.getEntries(t.id);
  const added = entries.find(e => e.name === "直接 太郎");
  assert.ok(added, "直接追加が申込一覧に出る");
  assert.strictEqual(added.entry_status, "confirmed", "auto_confirm=true は confirmed");
  // 二重に作らない(冪等): 同じ内容を再度追加しても件数は増えない
  db.createEntry(t.id, { name: "直接 太郎", team: "丙大", events: ["男子シングルス"], auto_confirm: true });
  assert.strictEqual(db.getEntries(t.id).filter(e => e.name === "直接 太郎").length, 1, "同一申込は重複しない");
});

test("statusフィルタで絞り込める", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp",
    entries: [
      { event: "男子シングルス", type: "singles", name: "A 太郎", team: "T" },
      { event: "男子シングルス", type: "singles", name: "B 次郎", team: "T" },
    ] });
  const all = db.getEntries(t.id);
  db.setEntrantStatus(all[0].id, "confirmed");
  assert.strictEqual(db.getEntries(t.id, "confirmed").length, 1, "confirmed のみ1件");
  assert.strictEqual(db.getEntries(t.id, "pending").length, 1, "pending のみ1件");
});
