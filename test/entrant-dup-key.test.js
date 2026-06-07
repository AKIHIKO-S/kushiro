// 重複エントリー検出の正準キー(entrantDupKey)回帰。サーバ validateEntrants と
// クライアント TMgmt._dupKey が同一規則: ダブルスは A/B と B/A を同一視、空白は畳む、氏名空は対象外。
// 実行: node --test test/entrant-dup-key.test.js
process.env.DB_PATH = "/tmp/ktta_dupkey_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

let _seq = 0;
const dupErrors = (t, ev) => db.validateEntrants(t.id, ev).errors.filter(e => e.type === "duplicate");

test("validateEntrants: ダブルスは選手1/2 の順序が逆でも重複として1グループに集約", () => {
  const t = db.createTournament({ name: "重複DB" + (++_seq), date: "2027-12-01" });
  const EV = "男子ダブルス";
  db.createEntrant({ tournament_id: t.id, event: EV, is_doubles: 1,
    surname: "前", given_name: "太", team: "工業", partner_surname: "今野", partner_given_name: "健", partner_team: "北陽", status: "confirmed" });
  // 上下逆(今野/前)で再登録 → 同一ペア扱い
  db.createEntrant({ tournament_id: t.id, event: EV, is_doubles: 1,
    surname: "今野", given_name: "健", team: "北陽", partner_surname: "前", partner_given_name: "太", partner_team: "工業", status: "confirmed" });

  const dups = dupErrors(t, EV);
  assert.strictEqual(dups.length, 1, "A/B と B/A が1つの重複グループに: " + JSON.stringify(dups));
  assert.strictEqual(dups[0].entrant_ids.length, 2, "2件が重複: " + JSON.stringify(dups[0]));
});

test("validateEntrants: シングルスは氏名/所属の前後・中間スペース差を無視して重複検出", () => {
  const t = db.createTournament({ name: "重複空白" + (++_seq), date: "2027-12-02" });
  const EV = "男子シングルス";
  db.createEntrant({ tournament_id: t.id, event: EV, surname: "山田", given_name: "太郎", team: "A", status: "confirmed" });
  db.createEntrant({ tournament_id: t.id, event: EV, name: "山田 太郎", team: " A ", status: "confirmed" });

  const dups = dupErrors(t, EV);
  assert.strictEqual(dups.length, 1, "空白差を無視して重複1件: " + JSON.stringify(dups));
});

test("validateEntrants: 別種目の同名は重複にしない(種目を正準キーに含む)", () => {
  const t = db.createTournament({ name: "重複種目" + (++_seq), date: "2027-12-03" });
  db.createEntrant({ tournament_id: t.id, event: "男子シングルス", surname: "鈴木", given_name: "一", team: "A", status: "confirmed" });
  db.createEntrant({ tournament_id: t.id, event: "壮年シングルス", surname: "鈴木", given_name: "一", team: "A", status: "confirmed" });

  const dups = db.validateEntrants(t.id).errors.filter(e => e.type === "duplicate");
  assert.strictEqual(dups.length, 0, "別種目の同名は重複扱いしない: " + JSON.stringify(dups));
});
