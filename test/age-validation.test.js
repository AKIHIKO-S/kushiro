// Phase 4 回帰テスト: 生年月日/年齢の自動判定(age_check)。
//  - 基準日 = 大会年度の4/1(fiscalAprilFirst)。生年月日→満年齢(ageAtDate)。
//  - entry_categories の min_age/max_age で単独年齢を検証、combined で合計年齢(ダブルス)を検証。
//  - consent_age 以上の選手がいれば同意チェック(_consent)必須。
//  - age_check.mode==="off"/未設定は全既存大会に無影響。生年月日欠落はエラー。
//  - 検証は enforce(公開フォーム経路)のみ。基準日の算出は 4月境界で年度が切り替わる。
// 実行: node --test test/age-validation.test.js
process.env.DB_PATH = "/tmp/ktta_age_" + process.pid + ".db";
process.env.SNAPSHOT_DIR = "/tmp/ktta_age_snaps_" + process.pid;

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
  try { fs.rmSync(process.env.SNAPSHOT_DIR, { recursive: true, force: true }); } catch (e) {}
});

const base = { team_name: "甲", contact_name: "監督", contact_tel: "090", contact_email: "a@b.jp" };

// 大会 2028-02-11 → 年度2027 → 基準日 2027-04-01
const mastersCfg = [{
  name: "マスターズS", type: "singles", fee: 2000,
  age_check: { mode: "birthdate", consent_age: 90 },
  entry_categories: [
    { value: "fifty", label: "フィフティ(50歳以上)", short: "フィフティ", min_age: 50 },
    { value: "ninety", label: "ナインティ(90歳以上)", short: "ナインティ", min_age: 90 },
  ],
}];

test("単独年齢: 対象年齢未満はエラー、満たせば受付(基準日=年度4/1)", () => {
  const t = db.createTournament({ name: "年齢単", date: "2028-02-11", event_config: mastersCfg, entries_open: 1 });
  // 2027-04-01 時点で 47歳(1980-01-01生) → フィフティ(50以上)NG
  const ng = db.createTeamEntry(t.id, { ...base,
    entries: [{ event: "マスターズS", type: "singles", name: "A", division: "fifty", division_label: "フィフティ",
      extra_json: { birth_date: "1980-01-01" } }] }, "", { enforce: true });
  assert.ok(ng.error && /対象年齢/.test(ng.error), "47歳はフィフティ不可");
  // 57歳(1970-01-01生) → OK
  const ok = db.createTeamEntry(t.id, { ...base,
    entries: [{ event: "マスターズS", type: "singles", name: "B", division: "fifty", division_label: "フィフティ",
      extra_json: { birth_date: "1970-01-01" } }] }, "", { enforce: true });
  assert.ok(ok.ok, "57歳はフィフティ可");
});

test("同意書年齢: consent_age 以上は _consent 必須", () => {
  const t = db.createTournament({ name: "同意", date: "2028-02-11", event_config: mastersCfg, entries_open: 1 });
  const noC = db.createTeamEntry(t.id, { ...base,
    entries: [{ event: "マスターズS", type: "singles", name: "C", division: "ninety", division_label: "ナインティ",
      extra_json: { birth_date: "1930-01-01" } }] }, "", { enforce: true });
  assert.ok(noC.error && /同意書/.test(noC.error), "90歳以上で同意なしはエラー");
  const withC = db.createTeamEntry(t.id, { ...base, _consent: true,
    entries: [{ event: "マスターズS", type: "singles", name: "D", division: "ninety", division_label: "ナインティ",
      extra_json: { birth_date: "1930-01-01" } }] }, "", { enforce: true });
  assert.ok(withC.ok, "同意ありなら受付");
});

test("生年月日欠落はエラー(age_check 有効種目)", () => {
  const t = db.createTournament({ name: "欠落", date: "2028-02-11", event_config: mastersCfg, entries_open: 1 });
  const r = db.createTeamEntry(t.id, { ...base,
    entries: [{ event: "マスターズS", type: "singles", name: "E", division: "fifty", division_label: "フィフティ" }] }, "", { enforce: true });
  assert.ok(r.error && /生年月日/.test(r.error), "生年月日未入力を弾く");
});

test("合計年齢: combined 区分は2人の合計で判定(ダブルス)", () => {
  const cfg = [{ name: "混合D", type: "doubles", fee: 1200, age_check: { mode: "birthdate" },
    entry_categories: [{ value: "over130", label: "合計130歳以上", short: "130+", min_age: 130, combined: true }] }];
  const t = db.createTournament({ name: "合計", date: "2028-02-11", event_config: cfg, entries_open: 1 });
  // 57+47=104 <130 NG
  const ng = db.createTeamEntry(t.id, { ...base,
    entries: [{ event: "混合D", type: "doubles", name1: "P", name2: "Q", team1: "甲", team2: "甲", division: "over130", division_label: "130+",
      extra_json: { players: [{ birth_date: "1970-01-01" }, { birth_date: "1980-01-01" }] } }] }, "", { enforce: true });
  assert.ok(ng.error && /合計年齢/.test(ng.error), "合計104歳はNG");
  // 77+72=149 ≥130 OK
  const ok = db.createTeamEntry(t.id, { ...base,
    entries: [{ event: "混合D", type: "doubles", name1: "R", name2: "S", team1: "甲", team2: "甲", division: "over130", division_label: "130+",
      extra_json: { players: [{ birth_date: "1950-01-01" }, { birth_date: "1955-01-01" }] } }] }, "", { enforce: true });
  assert.ok(ok.ok, "合計149歳はOK");
});

test("age_check 無しの大会は年齢検証をかけない(後方互換)", () => {
  const t = db.createTournament({ name: "無検証", date: "2028-02-11",
    event_config: [{ name: "一般S", type: "singles", fee: 1000 }], entries_open: 1 });
  const r = db.createTeamEntry(t.id, { ...base,
    entries: [{ event: "一般S", type: "singles", name: "T", team: "甲", fee: 1000 }] }, "", { enforce: true });
  assert.ok(r.ok, "生年月日なしでも通る(age_check 未設定)");
});

test("基準日算出: 4月境界で年度が切り替わる", () => {
  // 3月開催 → 前年度4/1 / 4月開催 → 当年度4/1
  const march = db.createTournament({ name: "3月", date: "2028-03-20", event_config: mastersCfg, entries_open: 1 });
  const april = db.createTournament({ name: "4月", date: "2028-04-05", event_config: mastersCfg, entries_open: 1 });
  // 1978-04-03 生: 2027-04-01時点=48歳(3月大会=年度2027) → フィフティNG / 2028-04-01時点=49歳(4月大会=年度2028) → まだNG。
  // 境界確認は「年度が2027 vs 2028 に分かれる」ことを別の生年月日で: 1977-04-01 生
  //   3月(基準2027-04-01)=50歳ちょうど→OK / 4月(基準2028-04-01)=51歳→OK。両方OKでは境界差が出ない。
  // 生年月日 1978-04-01: 2027-04-01=49歳→NG(フィフティ) / 2028-04-01=50歳→OK。ここで境界差が出る。
  const bd = "1978-04-01";
  const rMar = db.createTeamEntry(march.id, { ...base,
    entries: [{ event: "マスターズS", type: "singles", name: "境界M", division: "fifty", division_label: "フィフティ", extra_json: { birth_date: bd } }] }, "", { enforce: true });
  const rApr = db.createTeamEntry(april.id, { ...base,
    entries: [{ event: "マスターズS", type: "singles", name: "境界A", division: "fifty", division_label: "フィフティ", extra_json: { birth_date: bd } }] }, "", { enforce: true });
  assert.ok(rMar.error, "3月大会(年度2027・基準2027-04-01)は49歳でNG");
  assert.ok(rApr.ok, "4月大会(年度2028・基準2028-04-01)は50歳でOK");
});
