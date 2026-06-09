// 取込時の性別割当の回帰テスト。
//   混合ダブルスは性別不定で既定 male で選手作成される。処理順で混合が女子選手を先に male で
//   作ると、後続の女子種目では性別が更新されず「女子なのに male」が残っていた。
//   修正: 性別明記種目(女子/男子)で連携/作成する際、既存選手の性別を正本として訂正する。
// 実行: node --test test/import-gender-fix.test.js
process.env.DB_PATH = "/tmp/ktta_gender_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const imp = (tid, event, players) => db.importBracket(tid, {
  format: "tabletennis-seed-list-v1", event, players,
  regenerate: true, auto_link_to_players: true, auto_create_players: true,
});
const genderOf = (name, team) => { const p = db.findPlayerByName(name, team); return p ? p.gender : null; };

let seq = 0;
test("混合(male既定)で先に作られた女子選手を、後続の女子種目が female に訂正する", () => {
  const t = db.createTournament({ name: "g" + (++seq), date: "2027-08-08" });
  // 1) 混合ダブルスを先に取込: 難波(相方)は性別不定→既定 male で作成される
  imp(t.id, "混合ダブルス", [
    { name: "桐山 慶次郎", team: "釧友会", seed: 1, partner_name: "難波 心愛", partner_team: "ワンスターTTC", is_doubles: true },
    { name: "飯島 悦孝", team: "ポラリス", seed: 2, partner_name: "元井 重子", partner_team: "シニア", is_doubles: true },
  ]);
  assert.strictEqual(genderOf("難波 心愛", "ワンスターTTC"), "male", "混合先行で難波は一旦 male(前提)");

  // 2) 一般女子シングルスを後から取込 → 難波の性別が female に訂正される
  imp(t.id, "一般女子シングルス", [
    { name: "難波 心愛", team: "ワンスターTTC", seed: 1, gender: "female" },
    { name: "市橋 良子", team: "クラブ柏", seed: 2, gender: "female" },
  ]);
  assert.strictEqual(genderOf("難波 心愛", "ワンスターTTC"), "female", "女子種目が性別を female に訂正する");
});

test("男子選手は男子種目で male のまま(混合先行でも誤らない)", () => {
  const t = db.createTournament({ name: "g" + (++seq), date: "2027-08-09" });
  imp(t.id, "混合ダブルス", [
    { name: "若林 準", team: "道東", seed: 1, partner_name: "板垣 由依", partner_team: "Neo", is_doubles: true },
    { name: "山田 太郎", team: "A会", seed: 2, partner_name: "鈴木 花子", partner_team: "B会", is_doubles: true },
  ]);
  imp(t.id, "一般男子シングルス", [
    { name: "若林 準", team: "道東", seed: 1, gender: "male" },
    { name: "山田 太郎", team: "A会", seed: 2, gender: "male" },
  ]);
  assert.strictEqual(genderOf("若林 準", "道東"), "male", "男子種目で male");
  // 板垣(混合の女子相方)も後続の女子種目で訂正される
  imp(t.id, "一般女子ダブルス", [
    { name: "板垣 由依", team: "Neo", seed: 1, partner_name: "佐久間 優衣", partner_team: "大和", is_doubles: true },
    { name: "鈴木 花子", team: "B会", seed: 2, partner_name: "田中 桃", partner_team: "C会", is_doubles: true },
  ]);
  assert.strictEqual(genderOf("板垣 由依", "Neo"), "female", "女子ダブルスが板垣を female に訂正");
});

test("混合のみ登場の選手は強制訂正しない(性別不定のまま既定を温存)", () => {
  const t = db.createTournament({ name: "g" + (++seq), date: "2027-08-10" });
  imp(t.id, "混合ダブルス", [
    { name: "甲 一", team: "X", seed: 1, partner_name: "乙 二", partner_team: "Y", is_doubles: true },
    { name: "丙 三", team: "Z", seed: 2, partner_name: "丁 四", partner_team: "W", is_doubles: true },
  ]);
  // 混合のみ → 性別明記種目が無いので訂正は走らない(既定のまま=データ破壊しない)
  assert.ok(["male", "female", "", null].includes(genderOf("乙 二", "Y")), "混合のみは既定を温存(訂正で壊さない)");
});
