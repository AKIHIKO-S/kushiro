// 所属履歴 (#298) の回帰。players.team は現所属キャッシュ、正本は affiliations(期間つき履歴)。
//   - createPlayer が team から初期所属1件を作る / kind 自動判定
//   - 複数の現所属(部活+クラブ) / 締め / affiliationAt による当時所属の復元
//   - マージで dup の所属が survivor へ付替・unmerge で dup へ復元 (MERGE_REPOINT)
//   - resolveBranchChange が転校を履歴として積む / backfill の冪等
// 実行: node --test test/affiliation.test.js
process.env.DB_PATH = "/tmp/ktta_affiliation_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const x of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} } });

test("createPlayer: team から所属履歴の初期1件が作られ kind が自動判定される", () => {
  const p = db.createPlayer({ name: "所属 一郎", team: "釧路第一中学校" });
  const affs = db.listAffiliations(p.id);
  assert.strictEqual(affs.length, 1, "初期1件");
  assert.strictEqual(affs[0].team, "釧路第一中学校");
  assert.strictEqual(affs[0].kind, "middle", "中学校→middle 自動判定");
  assert.strictEqual(affs[0].end_date, "", "現所属(end_date 空)");
  // getPlayer 詳細にも所属が含まれる
  assert.ok(Array.isArray(db.getPlayer(p.id).affiliations), "getPlayer に affiliations が含まれる");
});

test("addAffiliation/currentAffiliations: 複数の現所属を併存できる(部活+クラブ)", () => {
  const p = db.createPlayer({ name: "所属 二郎", team: "A中学校" });
  const r = db.addAffiliation(p.id, { team: "湿原クラブ", kind: "club" });
  assert.ok(r.ok, JSON.stringify(r));
  const cur = db.currentAffiliations(p.id);
  assert.strictEqual(cur.length, 2, "現所属が2つ併存");
  assert.deepStrictEqual(cur.map((a) => a.team).sort(), ["A中学校", "湿原クラブ"]);
});

test("endAffiliation/affiliationAt: 締めた所属も当時日付では当時所属として復元される", () => {
  const p = db.createPlayer({ name: "所属 三郎", team: "B中学校" });
  const aff = db.currentAffiliations(p.id)[0];
  assert.ok(db.endAffiliation(aff.id, "2026-03-31").ok, "締め成功");
  assert.strictEqual(db.currentAffiliations(p.id).length, 0, "締め後は現所属なし");
  assert.strictEqual(db.affiliationAt(p.id, "2026-01-01").length, 1, "締め前の日付では当時所属1件");
  assert.strictEqual(db.affiliationAt(p.id, "2026-01-01")[0].team, "B中学校");
  assert.strictEqual(db.affiliationAt(p.id, "2026-06-01").length, 0, "締め後の日付では該当なし");
  // 既に締めた所属は二重に締められない
  assert.ok(db.endAffiliation(aff.id, "2026-12-31").error, "締め済みは error");
});

test("addAffiliation: 空 team は拒否", () => {
  const p = db.createPlayer({ name: "所属 四郎", team: "C中学校" });
  assert.ok(db.addAffiliation(p.id, { team: "" }).error, "空teamはerror");
});

test("マージ: dup の所属履歴が survivor へ付替・unmerge で dup へ戻る (#298 MERGE_REPOINT)", () => {
  const a = db.createPlayer({ name: "統合 太郎", team: "甲中学校" });   // 先登録=survivor
  const b = db.createPlayer({ name: "統合 太郎", team: "乙高校" });     // 後登録=dup
  db.addAffiliation(b.id, { team: "丙クラブ", kind: "club" });
  assert.strictEqual(db.listAffiliations(a.id).length, 1, "survivor 元1件");
  assert.strictEqual(db.listAffiliations(b.id).length, 2, "dup 2件");
  const m = db.mergePlayers(a.id, b.id, { operator: "test" });
  assert.ok(m.ok, "merge ok: " + JSON.stringify(m));
  assert.strictEqual(db.listAffiliations(a.id).length, 3, "survivor に dup の所属が集約(1+2)");
  const u = db.unmergePlayers(m.merge_id, { operator: "test" });
  assert.ok(u.ok, "unmerge ok: " + JSON.stringify(u));
  assert.strictEqual(db.listAffiliations(a.id).length, 1, "survivor は元の1件に戻る");
  assert.strictEqual(db.listAffiliations(b.id).length, 2, "dup に2件復元される");
});

test("resolveBranchChange: 転校で旧所属を締め新所属を現所属として追加する(履歴を残す)", () => {
  const p = db.createPlayer({ name: "転校 太郎", team: "旧中学校" });
  const t = db.createTournament({ name: "aff-branch", date: "2027-09-01" });
  db.importBracket(t.id, {
    format: "tabletennis-seed-list-v1", event: "一般男子シングルス",
    players: [{ seed: 1, name: "甲 一", team: "X" }, { seed: 2, name: "乙 二", team: "Y" }],
    regenerate: true, auto_create_players: true, placement: "as_drawn",
  });
  const ent = db.getEntrants(t.id, "一般男子シングルス")[0];
  const r = db.resolveBranchChange(ent.id, p.id, "新高校");
  assert.ok(r.ok, JSON.stringify(r));
  const affs = db.listAffiliations(p.id);
  const oldA = affs.find((a) => a.team === "旧中学校");
  const newA = affs.find((a) => a.team === "新高校");
  assert.ok(oldA && oldA.end_date !== "", "旧所属が締められる");
  assert.ok(newA && newA.end_date === "", "新所属が現所属(end_date空)で追加される");
  assert.strictEqual(db.getPlayer(p.id).team, "新高校", "現所属キャッシュ(players.team)も更新");
});

test("backfillAffiliations: team はあるが履歴の無い選手にだけ初期1件を作る(冪等)", () => {
  const p = db.createPlayer({ name: "移行 太郎", team: "移行中学校" });
  db.listAffiliations(p.id).forEach((a) => db.deleteAffiliation(a.id));   // 「team あり・履歴なし」を作る
  assert.strictEqual(db.listAffiliations(p.id).length, 0);
  const r1 = db.backfillAffiliations();
  assert.ok(r1.created >= 1, "未移行分を生成: " + JSON.stringify(r1));
  assert.strictEqual(db.listAffiliations(p.id).length, 1, "移行で1件");
  const r2 = db.backfillAffiliations();
  assert.strictEqual(r2.created, 0, "2回目は0件(冪等)");
  assert.strictEqual(db.listAffiliations(p.id).length, 1, "重複生成しない");
});
