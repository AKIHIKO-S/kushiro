// 名簿(エントリー表)Excel取込の回帰テスト。データは全て合成(実名・実データ不使用)。
//   ・シングルス: 氏名空白スキップ / チーム名優先(空欄は申込チーム) / 区分→性別・年代
//   ・支部正規化: 支部/市/県の接尾辞除去・根室管内卓球連盟→根室・根釧→釧根・括弧除去
//   ・ダブルス: 1行=1ペア(氏名1/氏名2) / 支部連記(・区切り)は両者に対応 / ペア不成立はスキップ+警告
//   ・DB照合: 支部空欄は過去 entrants から補完、無ければ保留
//   ・importRoster: 冪等(重複スキップ) / event_config へ種目追加 / オープン=男女別S/D
// 実行: node --test test/roster-import.test.js
process.env.DB_PATH = "/tmp/ktta_roster_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const H_S = ["申込チーム", "No,", "区分", "氏名", "チーム名", "支部", "備考"];
const H_D = ["申込チーム", "No,", "区分", "氏名1", "氏名2", "チーム名1", "チーム名2", "支部", "備考"];

test("支部名の正規化", () => {
  const cases = [
    ["釧路市", "釧路"], ["釧路支部", "釧路"], ["釧路", "釧路"],
    ["札幌市", "札幌"], ["札幌支部", "札幌"],
    ["根室管内卓球連盟", "根室"], ["根室管内", "根室"], ["根室)", "根室"],
    ["根釧支部", "釧根"], ["釧根支部", "釧根"], ["根釧", "釧根"], ["釧根", "釧根"],
    ["秋田県", "秋田"], ["東京", "東京"], ["十勝支部", "十勝"], ["", ""],
  ];
  cases.forEach(([i, exp]) => assert.strictEqual(db.normalizeShibuName(i), exp, i + " → " + exp));
});

test("シングルス: ヘッダ/空白行スキップ・チーム名優先・区分の分解・支部正規化", () => {
  const singles = [
    H_S,
    ["星クラブ", 1, "一般男子", "北野 一", "星クラブ", "釧路市", ""],
    ["星クラブ", 2, "一般女子", "南田 二子", "月クラブ", "札幌支部", ""],
    ["", "", "", "", "", "", "重複のため削除"],             // 氏名空白=スキップ
    ["空クラブ", 1, "中学男子", "東山 三", "", "根室管内卓球連盟", ""],   // チーム名空欄→申込チーム
    ["空クラブ", 2, "小学女子", "西川 四美", "空クラブ", "", ""],        // 支部空欄
  ];
  const { entries, issues, stats } = db.parseRosterRows({ singles, doubles: [] });
  assert.strictEqual(entries.length, 4, "実データ4行");
  assert.strictEqual(stats.skipped, 1, "空白行1スキップ");
  const [a, b, c, d] = entries;
  assert.deepStrictEqual([a.name, a.team, a.region, a.gender, a.division], ["北野 一", "星クラブ", "釧路", "male", "一般"]);
  assert.deepStrictEqual([b.team, b.region, b.gender], ["月クラブ", "札幌", "female"]);
  assert.deepStrictEqual([c.team, c.region, c.division], ["空クラブ", "根室", "中学生"], "チーム名空欄は申込チーム・連盟→根室");
  assert.deepStrictEqual([d.region, d.division, d.gender], ["", "小学生", "female"]);
  assert.ok(issues.some(x => x.level === "warn" && /支部が空欄/.test(x.msg)), "支部空欄warn");
});

test("ダブルス: 1行=1ペア・支部連記・ペア不成立・チーム名2空欄", () => {
  const doubles = [
    H_D,
    ["星クラブ", 1, "一般男子", "北野 一", "東山 三", "星高校", "空中学校", "釧路市", ""],
    ["星クラブ", 2, "一般男子", "青木 五", "赤井 六", "星クラブ", "星クラブ", "深川支部・札幌支部", ""],   // 連記
    ["月クラブ", 1, "一般女子", "南田 二子", "", "月クラブ", "", "釧路", ""],                          // ペア不成立
    ["月クラブ", 2, "高校女子", "白鳥 七海", "黒田 八重", "月クラブ", "", "北見", ""],                  // チーム名2空欄
  ];
  const { entries, issues, stats } = db.parseRosterRows({ singles: [], doubles });
  assert.strictEqual(entries.length, 3, "有効ペア3(不成立1除外)");
  assert.strictEqual(stats.skipped, 1, "不成立1スキップ");
  const [p1, p2, p3] = entries;
  assert.deepStrictEqual([p1.name, p1.partner_name, p1.team, p1.partner_team], ["北野 一", "東山 三", "星高校", "空中学校"]);
  assert.deepStrictEqual([p1.region, p1.partner_region], ["釧路", "釧路"], "支部1つ=両者共通");
  assert.deepStrictEqual([p2.region, p2.partner_region], ["深川", "札幌"], "連記は氏名1/氏名2に対応");
  assert.strictEqual(p3.partner_team, "", "チーム名2空欄はそのまま(警告)");
  assert.ok(issues.some(x => /ペア不成立/.test(x.msg)), "不成立warn");
  assert.ok(issues.some(x => /パートナーのチーム名が空欄/.test(x.msg)), "チーム名2空欄warn");
});

test("種目マッピング: オープン=男女別S/D・カテゴリ=区分ごと", () => {
  const s = { type: "singles", kubun: "中学男子", gender: "male" };
  const d = { type: "doubles", kubun: "一般女子", gender: "female" };
  assert.strictEqual(db.rosterEventName(s, "open"), "男子シングルス");
  assert.strictEqual(db.rosterEventName(d, "open"), "女子ダブルス");
  assert.strictEqual(db.rosterEventName(s, "category"), "中学男子シングルス");
  assert.strictEqual(db.rosterEventName(d, "category"), "一般女子ダブルス");
});

test("DB照合: 支部空欄は過去の登録から補完・無ければ保留", () => {
  // 過去大会に「北野 一」を支部=釧路で登録しておく
  const past = db.createTournament({ name: "過去大会", date: "2025-06-01" });
  db.createEntrant({ tournament_id: past.id, event: "男子シングルス", name: "北野 一", team: "星クラブ", region: "釧路", status: "confirmed" });
  const entries = [
    { type: "singles", name: "北野一", team: "星クラブ", region: "", sheet: "S", srcRow: 2 },   // 空白違いでも一致
    { type: "singles", name: "居内 無人", team: "幻クラブ", region: "", sheet: "S", srcRow: 3 },
  ];
  const issues = db.enrichRosterRegions(entries);
  assert.strictEqual(entries[0].region, "釧路", "DBから補完");
  assert.strictEqual(entries[1].region, "", "未登録は保留(空のまま)");
  assert.ok(issues.some(x => /補完/.test(x.msg)) && issues.some(x => /保留/.test(x.msg)));
});

test("importRoster: 冪等・event_config追加・ダブルスのpartner格納", () => {
  const t = db.createTournament({ name: "取込先大会", date: "2027-08-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [] });
  const parsed = db.parseRosterRows({
    singles: [H_S,
      ["星クラブ", 1, "一般男子", "北野 一", "星クラブ", "釧路", ""],
      ["月クラブ", 1, "中学女子", "南田 二子", "月クラブ", "北見", ""]],
    doubles: [H_D,
      ["星クラブ", 1, "一般男子", "北野 一", "東山 三", "星高校", "空中学校", "釧路・札幌", ""]],
  });
  const r1 = db.importRoster(t.id, { mode: "open", entries: parsed.entries });
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.strictEqual(r1.created, 3, "3件作成");
  assert.deepStrictEqual(r1.events.sort(), ["女子シングルス", "男子シングルス", "男子ダブルス"], "オープン種目");
  // 冪等: 再実行は全スキップ
  const r2 = db.importRoster(t.id, { mode: "open", entries: parsed.entries });
  assert.strictEqual(r2.created, 0, "再実行は作成0");
  assert.strictEqual(r2.skipped_duplicate, 3, "重複3スキップ");
  // event_config に追加されている
  const tt = db.getTournament(t.id);
  const cfg = typeof tt.event_config === "string" ? JSON.parse(tt.event_config) : tt.event_config;
  assert.ok(cfg.some(c => c.name === "男子ダブルス" && c.type === "doubles"), "event_configにダブルス種目");
  // ダブルスの partner 格納
  const dbl = db.getEntrants(t.id, "男子ダブルス")[0];
  assert.strictEqual(parseInt(dbl.is_doubles) || 0, 1, "is_doubles=1");
  assert.deepStrictEqual([dbl.partner_name, dbl.partner_team, dbl.region, dbl.partner_region],
    ["東山 三", "空中学校", "釧路", "札幌"], "パートナー/支部が正しく格納");
  // カテゴリ別モードでは区分ごとの種目名
  const t2 = db.createTournament({ name: "カテゴリ大会", date: "2027-08-02" });
  const r3 = db.importRoster(t2.id, { mode: "category", entries: parsed.entries });
  assert.ok(r3.events.includes("中学女子シングルス"), "カテゴリ別種目: " + r3.events.join(","));
});
