// 申込フロー回帰テスト。
// Phase1: 申込の正本を entrants に統一 (admin一覧/件数/承認が entrants を見る / C-1,C-2,H-3)。
// Phase2: ブラケット/抽選番号は confirmed のみ (却下/pending を除外)。
// 反スパム: 自動承認(無人運用) + いたずら自動スクリーニング。手動承認は例外時の上書きに降格。
// 実行: node --test test/entry-flow.test.js
process.env.DB_PATH = "/tmp/ktta_entryflow_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

function openTournament() {
  const t = db.createTournament({ name: "申込フロー検証", date: "2027-06-06" });
  db.updateEntrySettings(t.id, { entries_open: 1 });
  return t;
}
const singlesEntry = (name, team) => ({ event: "男子シングルス", type: "singles", name, team: team || "T" });

test("公開フォーム申込(createTeamEntry)が getEntries に出る + 自動承認 (C-1 / 自動承認)", () => {
  const t = openTournament();
  const r = db.createTeamEntry(t.id, {
    team_name: "甲高校", contact_name: "監督", contact_email: "a@b.jp",
    entries: [
      { event: "男子シングルス", type: "singles", name: "山田 太郎", team: "甲高校", fee: 500 },
      { event: "男子ダブルス", type: "doubles", name1: "佐藤 一", name2: "鈴木 二", team: "甲高校", fee: 1000 },
    ],
  });
  assert.ok(r.ok, "createTeamEntry 成功");
  const entries = db.getEntries(t.id);
  assert.strictEqual(entries.length, 2, "申込一覧に2件出る(旧実装は0だった)");
  assert.ok(entries.every(e => e.entry_status === "confirmed"), "自動承認で confirmed");
  const dbl = entries.find(e => e.entry_event === "男子ダブルス");
  assert.ok(dbl && /佐藤/.test(dbl.name) && /鈴木/.test(dbl.name), "ダブルスはペア表示");
});

test("いたずら/spam 申込は自動スクリーニングで黙って捨てる(承認待ちにも残さない)", () => {
  const t = openTournament();
  const r = db.createTeamEntry(t.id, {
    team_name: "T", contact_name: "x", contact_email: "x@y.jp",
    entries: [
      singlesEntry("正規 太郎", "正規高校"),
      singlesEntry("http://spam.example.com 安く買える", "X"),   // URL
      singlesEntry(" AAAAAAAAA", "X"),                            // 同一文字連打
      singlesEntry("死ね", "X"),                                 // 暴言
      { event: "男子シングルス", type: "singles", name: "<script>alert(1)</script>", team: "X" }, // markup
    ],
  });
  assert.ok(r.ok);
  const entries = db.getEntries(t.id);
  assert.strictEqual(entries.length, 1, "正規1件のみ残る(spam4件は捨てる)");
  assert.strictEqual(entries[0].name, "正規 太郎");
});

test("承認/却下(手動上書き)が entrants に反映される (C-2/H-3)", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "乙", contact_name: "c", contact_email: "c@d.jp",
    entries: [{ event: "女子シングルス", type: "singles", name: "田中 花子", team: "乙", fee: 500 }] });
  const e = db.getEntries(t.id)[0];
  assert.strictEqual(e.entry_status, "confirmed", "既定は自動承認");
  assert.ok(db.setEntrantStatus(e.id, "rejected").ok);
  assert.strictEqual(db.getEntries(t.id)[0].entry_status, "rejected", "却下が反映");
  assert.ok(db.setEntrantStatus(e.id, "confirmed").ok);
  assert.strictEqual(db.getEntries(t.id)[0].entry_status, "confirmed", "再承認が反映");
  assert.ok(db.setEntrantStatus(e.id, "bogus").error, "不正statusはerror");
  assert.ok(db.setEntrantStatus("no-such-id", "confirmed").error, "存在しないidはerror");
});

test("admin直接追加(createEntry)も entrants の申込一覧に出る (H-1 収束)", () => {
  const t = openTournament();
  db.createEntry(t.id, { name: "直接 太郎", team: "丙大", events: ["男子シングルス"], auto_confirm: true });
  const added = db.getEntries(t.id).find(e => e.name === "直接 太郎");
  assert.ok(added, "直接追加が申込一覧に出る");
  assert.strictEqual(added.entry_status, "confirmed");
  db.createEntry(t.id, { name: "直接 太郎", team: "丙大", events: ["男子シングルス"], auto_confirm: true });
  assert.strictEqual(db.getEntries(t.id).filter(e => e.name === "直接 太郎").length, 1, "同一申込は重複しない");
});

test("ブラケット/抽選番号は却下を除外、confirmed のみ (Phase2/C-2)", () => {
  const t = openTournament();
  const EV = "男子シングルス";
  db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp",
    entries: ["甲 一", "乙 二", "丙 三", "丁 四"].map(n => singlesEntry(n)) });
  const all = db.getEntries(t.id);
  assert.strictEqual(all.length, 4);
  assert.ok(all.every(e => e.entry_status === "confirmed"), "全件自動承認");

  // 1名を却下 → ブラケットは confirmed 3名のみ
  db.setEntrantStatus(all.find(e => e.name === "丁 四").id, "rejected");
  const r1 = db.generateBracket(t.id, EV, {});
  assert.ok(!r1.error, "生成成功: " + JSON.stringify(r1).slice(0, 80));
  assert.strictEqual(r1.player_count, 3, "却下1名を除いた3名のみ");
  const bracket = db.getBracket(t.id, EV) || { rounds: [] };
  const names = new Set();
  (bracket.rounds || []).forEach(rd => (rd.matches || rd || []).forEach(m => {
    [m.player1_name, m.player2_name].forEach(n => { if (n && n !== "BYE") names.add(n); }); }));
  assert.ok(!names.has("丁 四"), "却下の選手はブラケットに出ない");

  // 全員却下 → 承認済2人未満エラー
  all.forEach(e => db.setEntrantStatus(e.id, "rejected"));
  const r2 = db.generateBracket(t.id, EV, {});
  assert.ok(r2.error && r2.needs_approval, "承認済が居なければ needs_approval エラー");
});

test("抽選番号(autoAssignDrawNumbers)も却下を除外して付与 (Phase2)", () => {
  const t = openTournament();
  const EV = "女子シングルス";
  db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp",
    entries: ["A 子", "B 子", "C 子"].map(n => ({ event: EV, type: "singles", name: n, team: "T" })) });
  const es = db.getEntries(t.id);
  db.setEntrantStatus(es.find(e => e.name === "C 子").id, "rejected");  // C子は却下
  db.autoAssignDrawNumbers(t.id, { event: EV, mode: "surname", force: true });
  const numbered = db.getEntrants(t.id, EV).filter(e => e.bracket_number > 0).map(e => e.name);
  assert.ok(numbered.includes("A 子") && numbered.includes("B 子"), "confirmed には番号付与");
  assert.ok(!numbered.includes("C 子"), "却下には番号を振らない");
});

test("方式A: 種目名から性別・カテゴリを自動推定する", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp", entries: [
    { event: "女子シングルス", type: "singles", name: "A 子", team: "T" },
    { event: "高校男子ダブルス", type: "doubles", name1: "B 一", name2: "C 二", team: "T" },
    { event: "混合ダブルス", type: "doubles", name1: "D 男", name2: "E 女", team: "T" },
    { event: "中学女子シングルス", type: "singles", name: "F 子", team: "T" },
  ] });
  const es = db.getEntries(t.id);
  const g = (ev) => es.find((e) => e.entry_event === ev);
  assert.strictEqual(g("女子シングルス").gender, "female");
  assert.strictEqual(g("高校男子ダブルス").gender, "male");
  assert.strictEqual(g("高校男子ダブルス").category, "high");
  assert.strictEqual(g("混合ダブルス").gender, "mixed");
  assert.strictEqual(g("中学女子シングルス").gender, "female");
  assert.strictEqual(g("中学女子シングルス").category, "middle");
});

test("申込締切は JST 基準で判定 (過去=拒否/未来=許可)", () => {
  const t = db.createTournament({ name: "締切検証", date: "2027-01-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "2000-01-01" });
  const past = db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp",
    entries: [singlesEntry("甲 一")] });
  assert.ok(past.error && /締切/.test(past.error), "過去締切は拒否");
  db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "2099-12-31" });
  const future = db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp",
    entries: [singlesEntry("乙 二")] });
  assert.ok(future.ok, "未来締切は許可");
});

test("statusフィルタで絞り込める", () => {
  const t = openTournament();
  db.createTeamEntry(t.id, { team_name: "T", contact_name: "x", contact_email: "x@y.jp",
    entries: [singlesEntry("A 太郎"), singlesEntry("B 次郎")] });
  const all = db.getEntries(t.id);
  db.setEntrantStatus(all[0].id, "rejected");
  assert.strictEqual(db.getEntries(t.id, "confirmed").length, 1, "confirmed のみ1件");
  assert.strictEqual(db.getEntries(t.id, "rejected").length, 1, "rejected のみ1件");
});
