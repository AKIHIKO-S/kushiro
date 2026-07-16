// エントリー品質検出の追加4種(2026-07-16)の回帰。
//   duplicate_entry / club_variant / age_mismatch+birth_missing / player_link_mismatch
// 「候補提示まで・確定は人」の掟を固定する: bulkFix が club(オプトイン)以外を触らないこと。
// 氏名はすべて合成(実在の選手名を使わない)。
// 実行: node --test test/entry-issues-extra.test.js
process.env.DB_PATH = "/tmp/ktta_entryissues_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
let _seq = 0;
const mkT = (extra) => db.createTournament(Object.assign({ name: "品質検証" + (++_seq), date: "2028-02-11" }, extra || {}));
const issuesOf = (tid, id) => {
  const r = db.findEntrantDataIssues(tid);
  const it = r.items.find(x => x.id === id);
  return it ? it.issues.map(i => i.code) : [];
};

test("duplicate_entry: 同種目の同名+同所属(表記ゆれ込み)を検出し、rejected と別所属は対象外", () => {
  const t = mkT();
  const a = db.createEntrant({ tournament_id: t.id, event: EV, name: "甲山 一郎", team: "釧路クラブ", furigana: "こうやま" });
  const b = db.createEntrant({ tournament_id: t.id, event: EV, name: "甲山　一郎", team: "釧路 クラブ", furigana: "こうやま" }); // 空白ゆれ
  const c = db.createEntrant({ tournament_id: t.id, event: EV, name: "甲山 一郎", team: "別海クラブ", furigana: "こうやま" });  // 別所属=同姓同名の別人あり得る
  assert.ok(issuesOf(t.id, a.id).includes("duplicate_entry"), "1件目に付く");
  assert.ok(issuesOf(t.id, b.id).includes("duplicate_entry"), "2件目(表記ゆれ)にも付く");
  assert.ok(!issuesOf(t.id, c.id).includes("duplicate_entry"), "別所属は重複扱いしない");
  // 片方を却下すると解消
  db.setEntrantStatus(b.id, "rejected");
  assert.ok(!issuesOf(t.id, a.id).includes("duplicate_entry"), "rejected を除くと1件になり検出が消える");
});

test("club_variant: 表記ゆれの少数派に多数派表記を提案し、bulkFix は opts.club のときだけ直す", () => {
  const t = mkT();
  const ids = [];
  for (let i = 1; i <= 3; i++) ids.push(db.createEntrant({ tournament_id: t.id, event: EV,
    name: "乙川 " + i + "郎", team: "釧路湖陵", furigana: "おとかわ" }).id);
  const v = db.createEntrant({ tournament_id: t.id, event: EV, name: "乙川 四郎", team: "釧路 湖陵", furigana: "おとかわ" });
  const codes = issuesOf(t.id, v.id);
  assert.ok(codes.includes("club_variant"), "少数派(空白入り)に表記ゆれ検出: " + JSON.stringify(codes));
  const it = db.findEntrantDataIssues(t.id).items.find(x => x.id === v.id);
  const cv = it.issues.find(i => i.code === "club_variant");
  assert.strictEqual(cv.suggested, "釧路湖陵", "多数派表記を提案");
  ids.forEach(id => assert.ok(!issuesOf(t.id, id).includes("club_variant"), "多数派側には付かない"));
  // bulkFix: 既定(club未指定)では直らない
  db.bulkFixEntrantInference(t.id, {});
  assert.strictEqual(db.getEntrant(v.id).team, "釧路 湖陵", "既定では所属を触らない");
  // opts.club=true で多数派に統一
  db.bulkFixEntrantInference(t.id, { club: true });
  assert.strictEqual(db.getEntrant(v.id).team, "釧路湖陵", "オプトインで統一される");
});

test("age_mismatch/birth_missing: age_check=birthdate の種目のみ、区分の年齢範囲で検出", () => {
  // 大会日 2028-02-11 → 年度2027 → 基準日 2027-04-01
  const t = mkT();
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{
    name: EV, type: "singles", fee: 0,
    age_check: { mode: "birthdate" },
    entry_categories: [
      { value: "cadet", label: "カデット(14歳以下)", max_age: 14 },
      { value: "senior", label: "シニア(40歳以上)", min_age: 40 },
    ],
  }] });
  // 基準日2027-04-01時点: 2012-05-01生まれ=14歳(カデットOK) / 2010-04-01生まれ=17歳(カデットNG)
  const ok = db.createEntrant({ tournament_id: t.id, event: EV, name: "丙田 太郎", team: "A中",
    division: "cadet", extra_json: JSON.stringify({ birth_date: "2012-05-01" }) });
  const ng = db.createEntrant({ tournament_id: t.id, event: EV, name: "丁原 次郎", team: "B中",
    division: "cadet", extra_json: JSON.stringify({ birth_date: "2010-04-01" }) });
  const noBd = db.createEntrant({ tournament_id: t.id, event: EV, name: "戊野 三郎", team: "C中",
    division: "cadet" });
  const noDiv = db.createEntrant({ tournament_id: t.id, event: EV, name: "己島 四郎", team: "D中",
    extra_json: JSON.stringify({ birth_date: "2010-04-01" }) });   // 区分なし=対象外
  assert.ok(!issuesOf(t.id, ok.id).includes("age_mismatch"), "範囲内は検出しない");
  assert.ok(issuesOf(t.id, ng.id).includes("age_mismatch"), "範囲外(17歳のカデット)を検出");
  assert.ok(issuesOf(t.id, noBd.id).includes("birth_missing"), "生年月日欠落を検出");
  assert.ok(!issuesOf(t.id, noDiv.id).includes("age_mismatch") && !issuesOf(t.id, noDiv.id).includes("birth_missing"),
    "区分未指定の行は年齢検査の対象外");
  // bulkFix はこれらを一切触らない
  const before = db.getEntrant(ng.id).division;
  db.bulkFixEntrantInference(t.id, { club: true, furigana: true });
  assert.strictEqual(db.getEntrant(ng.id).division, before, "age_mismatch は一括修正されない");
});

test("age_check の無い大会/種目では年齢系の検出が一切走らない(誤検知ゼロ)", () => {
  const t = mkT();
  const e = db.createEntrant({ tournament_id: t.id, event: EV, name: "庚村 五郎", team: "E会",
    division: "cadet", extra_json: JSON.stringify({ birth_date: "1990-01-01" }) });
  const codes = issuesOf(t.id, e.id);
  assert.ok(!codes.includes("age_mismatch") && !codes.includes("birth_missing"),
    "age_check未設定は無反応: " + JSON.stringify(codes));
});

test("player_link_mismatch: 連携先の選手名と不一致で検出、一致(空白差のみ)は無反応", () => {
  const t = mkT();
  const p1 = db.createPlayer({ name: "辛田 六郎", team: "F会", furigana: "からた" });
  const p2 = db.createPlayer({ name: "壬井 七郎", team: "G会", furigana: "みずい" });
  const okE = db.createEntrant({ tournament_id: t.id, event: EV, name: "辛田　六郎", team: "F会", furigana: "からた" });
  db.linkEntrantToPlayer(okE.id, p1.id);
  const ngE = db.createEntrant({ tournament_id: t.id, event: EV, name: "癸本 八郎", team: "H会", furigana: "きもと" });
  db.linkEntrantToPlayer(ngE.id, p2.id);   // 別人にリンク(取り違え)
  assert.ok(!issuesOf(t.id, okE.id).includes("player_link_mismatch"), "空白差だけなら一致扱い");
  assert.ok(issuesOf(t.id, ngE.id).includes("player_link_mismatch"), "氏名不一致のリンクを検出");
});

test("counts/by_event に新コードが集計される", () => {
  const t = mkT();
  db.createEntrant({ tournament_id: t.id, event: EV, name: "集計 一", team: "同会", furigana: "しゅうけい" });
  db.createEntrant({ tournament_id: t.id, event: EV, name: "集計 一", team: "同会", furigana: "しゅうけい" });
  const r = db.findEntrantDataIssues(t.id);
  assert.ok(r.counts.duplicate_entry >= 2, "counts に duplicate_entry: " + JSON.stringify(r.counts));
  const ev = r.by_event.find(x => x.event === EV);
  assert.ok(ev && ev.codes.duplicate_entry >= 2, "by_event にも集計される");
});
