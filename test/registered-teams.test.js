// 登録団体マスタ: 取込で団体名を選手名にしない関所の回帰。
// 実行: node --test test/registered-teams.test.js
process.env.DB_PATH = "/tmp/ktta_regteams_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

test("seed: 41団体が初期投入される(冪等)", () => {
  assert.strictEqual(db.listRegisteredTeams().length, 41, "初期シード41件");
});

test("normalize/isRegisteredTeam: 全半角・異体字(俱/倶)・ラテン小文字を吸収", () => {
  assert.ok(db.isRegisteredTeam("北陽高校"), "完全一致");
  assert.ok(db.isRegisteredTeam("ＭＰＣ"), "全角→半角 MPC");
  assert.ok(db.isRegisteredTeam("Neo倶楽部"), "倶(U+5036) と俱(U+4FF1) を同一視");
  assert.ok(db.isRegisteredTeam("t-union"), "ラテン小文字 T-Union");
  assert.ok(db.isRegisteredTeam(" 北陽 高校 "), "空白除去");
  assert.ok(!db.isRegisteredTeam("山田太郎"), "実在の氏名は団体ではない");
  assert.ok(!db.isRegisteredTeam(""), "空は団体ではない");
});

test("splitTrailingTeam: 氏名セル末尾の団体を分離(最長一致)", () => {
  assert.deepStrictEqual(db.splitTrailingTeam("山田太郎北陽高校"), { name: "山田太郎", team: "北陽高校" });
  assert.deepStrictEqual(db.splitTrailingTeam("北陽高校"), { name: "", team: "北陽高校" });
  assert.deepStrictEqual(db.splitTrailingTeam("山田太郎"), { name: "山田太郎", team: "" });
});

test("guardRegisteredTeams: 相方名が団体なら所属へ回し氏名は空(選手にしない)", () => {
  const r1 = { name: "山田 太郎", team: "", partner_name: "北陽高校", partner_team: "" };
  db.guardRegisteredTeams(r1);
  assert.strictEqual(r1.partner_name, "", "相方名(団体)は空に");
  assert.strictEqual(r1.partner_team, "北陽高校", "団体名は相方所属へ");

  const r2 = { name: "工業高校", team: "", partner_name: "佐藤 二郎", partner_team: "" };
  db.guardRegisteredTeams(r2);
  assert.strictEqual(r2.name, "", "氏名(団体)は空に");
  assert.strictEqual(r2.team, "工業高校", "団体名は所属へ");

  // 所属が既に埋まっている場合、氏名側の団体は破棄(空)
  const r3 = { name: "明輝高校", team: "明輝高校", partner_name: "", partner_team: "" };
  db.guardRegisteredTeams(r3);
  assert.strictEqual(r3.name, "", "所属既存なら氏名側の団体は破棄");
  assert.strictEqual(r3.team, "明輝高校", "所属は不変");
});

test("createPlayer: 登録団体名は選手として作れない(INVALID_NAME)", () => {
  assert.throws(() => db.createPlayer({ name: "北陽高校", gender: "male" }),
    (e) => e.code === "INVALID_NAME", "団体名はマスタ選手にできない");
});

test("importFromSeedList: ダブルスで相方=団体名でも選手は作られず所属に入る", () => {
  const t = db.createTournament({ name: "取込団体" + process.pid, date: "2027-12-25" });
  const EV = "男子ダブルス";
  const r = db.importBracket(t.id, {
    event: EV, regenerate: true,
    players: [
      { seed: 1, is_doubles: 1, name: "山田 太郎", partner_name: "北陽高校", team: "北陽高校", partner_team: "" },
      { seed: 2, is_doubles: 1, name: "佐藤 二郎", partner_name: "鈴木 三郎", team: "工業高校", partner_team: "工業高校" },
    ],
  });
  assert.ok(r && !r.error, "取込成功: " + JSON.stringify(r));
  const ents = db.getEntrants(t.id, EV);
  const pair1 = ents.find(e => (e.name || "").indexOf("山田") >= 0);
  assert.ok(pair1, "山田のペアがある");
  assert.ok(!(pair1.partner_name || "").includes("北陽高校"), "団体名が相方名(選手)になっていない: " + pair1.partner_name);
  // 北陽高校という名前の player が自動作成されていないこと
  const allPlayers = db.getPlayers ? db.getPlayers() : [];
  assert.ok(!allPlayers.some(p => (p.name || "") === "北陽高校"), "団体名のマスタ選手が作られていない");
});

test("CRUD: 追加→一覧→削除、重複は弾く", () => {
  const before = db.listRegisteredTeams().length;
  const a = db.addRegisteredTeam("テスト団体X");
  assert.ok(a && a.ok, "追加成功");
  assert.strictEqual(db.listRegisteredTeams().length, before + 1, "1件増える");
  assert.ok(db.isRegisteredTeam("テスト団体X"), "追加後は団体判定される");
  const dup = db.addRegisteredTeam("テスト団体Ｘ");   // 全角Xで重複(正規化一致)
  assert.ok(dup && dup.error, "正規化重複は弾く");
  db.deleteRegisteredTeam(a.id);
  assert.strictEqual(db.listRegisteredTeams().length, before, "削除で元に戻る");
  assert.ok(!db.isRegisteredTeam("テスト団体X"), "削除後は団体判定されない");
});
