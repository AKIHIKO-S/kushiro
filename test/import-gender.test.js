// 取込時のマスタDB自動登録の性別ポリシー(#混合は自動作成しない/性別記載種目は種目名から)。
//  - 混合ダブルス: 新規選手をマスタDBに自動作成しない(性別が一意でない=手動)。
//  - 女子/男子など性別が明記された種目: その性別でマスタ登録する。
// 実行: node --test test/import-gender.test.js
process.env.DB_PATH = "/tmp/ktta_impgender_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} });

function importEvent(event, p1, p2) {
  const t = db.createTournament({ name: event + "検証", date: "2027-09-09" });
  return db.importBracket(t.id, {
    format: "tabletennis-bracket-v1", event,
    matches: [{ bracket_round: 1, bracket_pos: 0, player1_name: p1, player2_name: p2, status: "pending" }],
    auto_create_players: true,
  });
}

test("混合ダブルスの取込は新規選手をマスタDBに自動作成しない(手動)", () => {
  const before = db.getPlayers().length;
  importEvent("混合ダブルス", "甲野混太郎", "乙野混花子");
  assert.strictEqual(db.getPlayers().length, before, "混合は新規選手を作らない");
  assert.ok(!db.getPlayers().some(p => p.name === "甲野混太郎" || p.name === "乙野混花子"), "混合の選手はマスタDBに居ない");
});

test("女子種目の取込は新規選手を『女子』としてマスタ登録する", () => {
  importEvent("女子シングルス", "丙野女一子", "丁野女二子");
  const p = db.getPlayers().find(x => x.name === "丙野女一子");
  assert.ok(p, "女子選手がマスタに作られる");
  assert.strictEqual(p.gender, "female", "性別=female(種目名『女子』から)");
});

test("男子種目の取込は新規選手を『男子』としてマスタ登録する", () => {
  importEvent("男子シングルス", "戊野男一郎", "己野男二郎");
  const p = db.getPlayers().find(x => x.name === "戊野男一郎");
  assert.ok(p, "男子選手がマスタに作られる");
  assert.strictEqual(p.gender, "male", "性別=male(種目名『男子』から)");
});

test("高校女子など『女子』を含む種目も female になる", () => {
  importEvent("高校女子シングルス", "庚野高女子", "辛野高女子2");
  const p = db.getPlayers().find(x => x.name === "庚野高女子");
  assert.ok(p && p.gender === "female", "高校女子=female");
});
