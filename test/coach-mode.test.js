// 監督モードの認証・権限分離の回帰テスト(#285〜/#292)。
//   ・コード認証: 有効コード→アカウント / 無効・無効化→拒否
//   ・チーム間分離: 監督は自チームのロスター/修正申請のみ見える(他チームに漏れない)
//   ・共同監督メンバーコード(#292): 親アカに解決・メンバー情報付き / 親無効化で連鎖拒否
//   ・登録上限(player_cap)
// セキュリティ関連(チームデータ分離・認証)だが専用テストが無かったため固定する。
// 実行: node --test test/coach-mode.test.js
process.env.DB_PATH = "/tmp/ktta_coach_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

test("コード認証: 有効→アカウント / 無効・無効化→拒否", () => {
  const A = db.createCoachAccount({ name: "監督A", team: "A高校" });
  assert.ok(A.login_code, "ログインコード発行");
  assert.strictEqual(db.coachByCode(A.login_code).id, A.id, "有効コードでアカウント解決");
  assert.strictEqual(db.coachByCode("zzzznope"), null, "無効コードは拒否");
  assert.strictEqual(db.coachByCode(""), null, "空コードは拒否");
  db.updateCoachAccount(A.id, { name: "監督A", team: "A高校", active: 0 });
  assert.strictEqual(db.coachByCode(A.login_code), null, "無効化したアカウントは拒否");
});

test("チーム間分離: 監督は自チームのロスター/修正申請のみ見える", () => {
  const A = db.createCoachAccount({ name: "監A", team: "A" });
  const B = db.createCoachAccount({ name: "監B", team: "B" });
  const pA = db.createPlayer({ name: "甲 一", team: "A" });
  const pB = db.createPlayer({ name: "乙 二", team: "B" });
  db.addCoachPlayer(A.id, pA.id);
  db.addCoachPlayer(B.id, pB.id);
  // ロスター分離
  assert.deepStrictEqual(db.getCoachRoster(A.id).map(p => p.name), ["甲 一"], "Aは甲のみ");
  assert.deepStrictEqual(db.getCoachRoster(B.id).map(p => p.name), ["乙 二"], "Bは乙のみ(Aの選手は見えない)");
  // 修正申請の分離
  db.createPlayerRequest(A.id, { player_id: pA.id, type: "edit", payload: { team: "A改" }, reason: "改名" });
  assert.strictEqual(db.getCoachRequests(A.id).length, 1, "Aの申請は1件");
  assert.strictEqual(db.getCoachRequests(B.id).length, 0, "BにはAの申請が見えない");
});

test("共同監督メンバーコード(#292): 親アカに解決・メンバー情報付き / 親無効化で連鎖拒否", () => {
  const A = db.createCoachAccount({ name: "監A2", team: "A2" });
  const r = db.addCoachMember(A.id, { name: "顧問X", role: "顧問" });
  assert.ok(r.member && r.member.login_code, "メンバーコード発行");
  const via = db.coachByCode(r.member.login_code);
  assert.ok(via && via.id === A.id, "メンバーコードは親アカ(A)に解決");
  assert.strictEqual(via.member_name, "顧問X", "メンバー情報が付与される");
  // 親アカ無効化 → メンバーコードも連鎖拒否
  db.updateCoachAccount(A.id, { name: "監A2", team: "A2", active: 0 });
  assert.strictEqual(db.coachByCode(r.member.login_code), null, "親無効化でメンバーコードも拒否");
});

test("登録上限(player_cap)を超えてロスター追加できない", () => {
  const A = db.createCoachAccount({ name: "監A3", team: "A3", player_cap: 2 });
  const p1 = db.createPlayer({ name: "選 一", team: "A3" });
  const p2 = db.createPlayer({ name: "選 二", team: "A3" });
  const p3 = db.createPlayer({ name: "選 三", team: "A3" });
  assert.ok(db.addCoachPlayer(A.id, p1.id).ok, "1人目OK");
  assert.ok(db.addCoachPlayer(A.id, p2.id).ok, "2人目OK");
  const r = db.addCoachPlayer(A.id, p3.id);
  assert.ok(r.error && /上限/.test(r.error), "上限超過は拒否: " + JSON.stringify(r));
  assert.strictEqual(db.getCoachRoster(A.id).length, 2, "ロスターは2人のまま");
});
