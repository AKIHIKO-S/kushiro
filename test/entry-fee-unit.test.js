// 料金の単位(1申込あたり / 1人あたり)の回帰テスト。
//
// 実際の大会要項(2025年度・協会主催)を調べたところ、団体戦の料金には2つの単位がある:
//   ・まりもオープン in Akan     … 団体戦「1人 1,000円」(1チーム4人 → 4,000円)
//   ・道新杯 中学選抜 / くしろリーグ … 団体戦「1チーム 2,000円 / 3,000円 / 4,000円」
// 従来は「1申込=1料金」しか表現できず、まりもオープンの団体戦が1/4の金額になっていた。
// fee_unit:"person" を付けた種目は、申込の人数を掛けて請求する。
//
// 料金は受付時に entrant.fee へ確定するので、合計・確認メール・帳票・申込者ページは
// すべてこの1箇所の計算に従う(計算を何箇所にも書かない)。
// 実行: node --test test/entry-fee-unit.test.js
process.env.DB_PATH = "/tmp/ktta_feeunit_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const mailer = require("../mailer.js");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// まりもオープン(1人あたり)と中学選抜(1チームあたり)を1つの大会に同居させて比較する
const EVENTS = [
  { name: "団体戦 (男女混合)", type: "team", per_team: 4, fee: 1000, fee_unit: "person" },
  { name: "中学 団体戦", type: "team", per_team: 6, fee: 2000 },
  { name: "男子ダブルス", type: "doubles", fee: 1000 },
  { name: "男子シングルス", type: "singles", fee: 700 },
  { name: "ペア単価ダブルス", type: "doubles", fee: 600, fee_unit: "person" },
];
function mkTournament() {
  const t = db.createTournament({ name: "料金単位検証", date: "2027-04-05" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: EVENTS });
  return db.getTournament(t.id);
}
const submit = (t, entries) => db.createTeamEntry(t.id, {
  team_name: "阿寒A", contact_name: "担当 太郎", contact_tel: "0154", contact_email: "t@example.com", entries,
}, "op-" + Math.random().toString(36).slice(2), { enforce: true });

const team = (ev, names) => ({ event: ev, type: "team", team_name: "阿寒A", members: names });
const pair = (ev) => ({ event: ev, type: "doubles", name1: "甲 一", name2: "乙 二", team1: "阿寒", team2: "阿寒" });

test("1人あたりの団体戦は人数分を請求する(まりもオープン)", () => {
  const t = mkTournament();
  const r = submit(t, [team("団体戦 (男女混合)", ["甲 一", "乙 二", "丙 三", "丁 四"])]);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.total_amount, 4000, "1,000円 × 4人");
});

test("人数が減れば請求も減る(3人なら3人分)", () => {
  const t = mkTournament();
  const r = submit(t, [team("団体戦 (男女混合)", ["甲 一", "乙 二", "丙 三"])]);
  assert.strictEqual(r.total_amount, 3000);
});

test("1チームあたりの団体戦は人数に関係なく定額(中学選抜・くしろリーグ)", () => {
  const t = mkTournament();
  const r6 = submit(t, [team("中学 団体戦", ["a", "b", "c", "d", "e", "f"])]);
  assert.strictEqual(r6.total_amount, 2000, "6人でも2,000円");
});

test("ダブルスは1組いくらが既定(釧路選手権)", () => {
  const t = mkTournament();
  const r = submit(t, [pair("男子ダブルス")]);
  assert.strictEqual(r.total_amount, 1000, "1組1,000円");
});

test("ダブルスに1人あたりを指定すると2人分になる", () => {
  const t = mkTournament();
  const r = submit(t, [pair("ペア単価ダブルス")]);
  assert.strictEqual(r.total_amount, 1200, "600円 × 2人");
});

test("シングルスは単位指定に関係なく1人分", () => {
  const t = mkTournament();
  const r = submit(t, [{ event: "男子シングルス", type: "singles", name: "甲 一", team: "阿寒" }]);
  assert.strictEqual(r.total_amount, 700);
});

test("まりもオープンの申込一式が要項どおりの金額になる", () => {
  const t = mkTournament();
  const r = submit(t, [
    team("団体戦 (男女混合)", ["甲 一", "乙 二", "丙 三", "丁 四"]),   // 1,000 × 4
    pair("男子ダブルス"),                                              // 1,000
    { event: "男子シングルス", type: "singles", name: "甲 一", team: "阿寒" },  // 700
  ]);
  assert.strictEqual(r.total_amount, 5700, "4,000 + 1,000 + 700");
  const fees = {};
  db.getEntries(t.id).forEach(e => { fees[e.entry_event] = e.fee; });
  assert.strictEqual(fees["団体戦 (男女混合)"], 4000, "entrant.fee に確定額が入る");
});

test("確認メールの料金計算も同じ金額になる(受付側と食い違わない)", () => {
  const t = mkTournament();
  const entries = [team("団体戦 (男女混合)", ["甲 一", "乙 二", "丙 三", "丁 四"]), pair("男子ダブルス")];
  // mailer は result が無い経路(再送・管理者通知)で自前計算するため、そこでも単位を守ること
  const calc = mailer.authoritativeFees(t, entries);
  assert.strictEqual(calc.total, 5000, "4,000 + 1,000");
  assert.strictEqual(calc.entries[0].fee, 4000, "団体は人数分");
  assert.strictEqual(calc.entries[1].fee, 1000, "ダブルスは1組");
  // 実際の受付結果とも一致すること
  const r = submit(t, entries);
  assert.strictEqual(r.total_amount, calc.total, "受付とメールで同額");
});

test("料金単位を指定しない既存大会は従来どおり(後方互換)", () => {
  const t = db.createTournament({ name: "旧設定", date: "2027-04-05" });
  db.updateEntrySettings(t.id, { entries_open: 1,
    event_config: [{ name: "団体戦", type: "team", per_team: 4, fee: 3000 }] });
  const tt = db.getTournament(t.id);
  const r = db.createTeamEntry(tt.id, {
    team_name: "T", contact_name: "担", contact_tel: "1", contact_email: "a@b.c",
    entries: [{ event: "団体戦", type: "team", team_name: "T", members: ["a", "b", "c", "d"] }],
  }, "op-legacy", { enforce: true });
  assert.strictEqual(r.total_amount, 3000, "1チーム3,000円のまま");
});

test("メンバーが空の団体でも0円にならない(最低1人分)", () => {
  const t = mkTournament();
  const r = submit(t, [{ event: "団体戦 (男女混合)", type: "team", team_name: "名前だけA", members: [] }]);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.total_amount, 1000, "チーム名のみでも1人分は請求する");
});
