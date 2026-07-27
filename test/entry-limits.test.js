// 要項の人数・種目数の決まりを守らせる回帰テスト。
//
// 2025年度の要項から:
//  ・団体の人数には幅がある … 中学選抜「登録選手6〜8名」/ くしろリーグ「1チームメンバー4人以上」
//    / ホープス「1チーム3〜4人」/ バタフライ「1チーム4〜6人」
//    per_team が入力欄の数(=最大)、per_team_min が成立に必要な最少人数。
//  ・1人が出られる種目数の上限 … タンチョウオープン「一人最大3種目にエントリーできます」
// 実行: node --test test/entry-limits.test.js
process.env.DB_PATH = "/tmp/ktta_limits_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("node:path");
const db = require("../db");
const entryForm = require("../entry_form.js");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EVENTS = [
  { name: "中学団体", type: "team", fee: 2000, per_team: 8, per_team_min: 6 },
  { name: "上限なし団体", type: "team", fee: 2000, per_team: 6 },
  { name: "男子S", type: "singles", fee: 700 },
  { name: "男子D", type: "doubles", fee: 1000 },
  { name: "混合D", type: "doubles", fee: 1000 },
  { name: "ラージS", type: "singles", fee: 1000 },
];
function setup(extra) {
  const t = db.createTournament({ name: "人数種目数検証", date: "2027-11-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: EVENTS, ...extra });
  return db.getTournament(t.id);
}
const submit = (t, entries) => db.createTeamEntry(t.id, {
  team_name: "T", contact_name: "担当", contact_tel: "1", contact_email: "a@example.com", entries,
}, "op-" + Math.random().toString(36).slice(2), { enforce: true });
const team = (ev, n) => ({ event: ev, type: "team", team_name: "A中",
  members: Array.from({ length: n }, (_, i) => "選手" + (i + 1)) });

// ── 団体の人数 ──────────────────────────────────────────────
test("最少人数に満たない団体は受け付けない(何人足りないか示す)", () => {
  const t = setup();
  const r = submit(t, [team("中学団体", 5)]);
  assert.ok(r.error && r.validation, "拒否されること: " + r.error);
  assert.match(r.error, /6人以上/);
  assert.match(r.error, /現在5人/, "今の人数も示す");
});

test("最少人数ちょうどは通る", () => {
  const t = setup();
  assert.ok(!submit(t, [team("中学団体", 6)]).error);
});

test("最大人数を超える団体は受け付けない", () => {
  const t = setup();
  const r = submit(t, [team("中学団体", 9)]);
  assert.match(r.error, /8人までです/);
});

test("最少人数を設定していない団体は従来どおり人数を問わない", () => {
  const t = setup();
  assert.ok(!submit(t, [team("上限なし団体", 1)]).error, "1人でも通る(後方互換)");
});

test("チーム名も人数も空の行は人数エラーにしない(空行を弾かない)", () => {
  const t = setup();
  const r = submit(t, [{ event: "中学団体", type: "team", team_name: "", members: [] }]);
  assert.ok(!r.error || !/人以上/.test(r.error), "人数エラーにはしない: " + r.error);
});

// ── 1人あたりの種目数 ───────────────────────────────────────
const pairWith = (ev, n1) => ({ event: ev, type: "doubles", name1: n1, name2: "相方", team1: "T", team2: "T" });

test("1人が上限を超えて申し込むと拒否される", () => {
  const t = setup({ entry_max_events: 3 });
  const r = submit(t, [
    { event: "男子S", type: "singles", name: "鈴木 次郎", team: "T" },
    pairWith("男子D", "鈴木 次郎"),
    pairWith("混合D", "鈴木 次郎"),
    { event: "ラージS", type: "singles", name: "鈴木 次郎", team: "T" },
  ]);
  assert.ok(r.error && r.validation, "拒否されること: " + r.error);
  assert.match(r.error, /3種目までです/);
  assert.match(r.error, /4種目/, "実際の申込数も示す");
});

test("上限ちょうどは通る", () => {
  const t = setup({ entry_max_events: 3 });
  const r = submit(t, [
    { event: "男子S", type: "singles", name: "山田 太郎", team: "T" },
    pairWith("男子D", "山田 太郎"),
    pairWith("混合D", "山田 太郎"),
  ]);
  assert.ok(!r.error, r.error);
});

test("ダブルスは相方も1種目として数える", () => {
  const t = setup({ entry_max_events: 1 });
  const r = submit(t, [pairWith("男子D", "甲 一"), pairWith("混合D", "乙 二")]);
  assert.ok(r.error && /1種目までです/.test(r.error), "相方も数える: " + r.error);
});

test("別人なら何人いても上限に触れない", () => {
  const t = setup({ entry_max_events: 1 });
  const r = submit(t, [
    { event: "男子S", type: "singles", name: "甲 一", team: "T" },
    { event: "ラージS", type: "singles", name: "乙 二", team: "T" },
  ]);
  assert.ok(!r.error, r.error);
});

test("団体のメンバーも種目数に数える", () => {
  const t = setup({ entry_max_events: 1 });
  const r = submit(t, [
    team("上限なし団体", 2),   // 選手1, 選手2
    { event: "男子S", type: "singles", name: "選手1", team: "T" },
  ]);
  assert.ok(r.error && /1種目までです/.test(r.error), "団体+個人で2種目: " + r.error);
});

test("上限を設定しなければ何種目でも申し込める(後方互換)", () => {
  const t = setup();
  const r = submit(t, [
    { event: "男子S", type: "singles", name: "多 種目", team: "T" },
    pairWith("男子D", "多 種目"),
    pairWith("混合D", "多 種目"),
    { event: "ラージS", type: "singles", name: "多 種目", team: "T" },
  ]);
  assert.ok(!r.error, r.error);
});

// ── フォーム表示 ────────────────────────────────────────────
test("団体の人数の決まりがフォームに渡る", () => {
  const t = setup();
  const html = entryForm.buildEntryFormHTML(t, EVENTS, { field_config: db.resolveFieldConfig(t) });
  const evs = JSON.parse(html.match(/const EVENTS = (\[[\s\S]*?\]);/)[1]);
  const chu = evs.find(e => e.name === "中学団体");
  assert.strictEqual(chu.per_team_min, 6, "最少人数が渡る");
  assert.strictEqual(chu.per_team, 8, "入力欄は最大人数分");
  const free = evs.find(e => e.name === "上限なし団体");
  assert.strictEqual(free.per_team_min, 0, "未設定は0(下限なし)");
});

// ── テンプレートが要項どおりであること ───────────────────────
// テンプレートは UMD (window に生やす) なので Node からは評価せず、定義本文を読んで確かめる。
test("公式テンプレートに要項の人数規定が入っている", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "shared", "tournament-templates.js"), "utf8");
  const blockOf = (id) => {
    const s = src.indexOf(`id: "${id}"`);
    assert.ok(s > 0, `${id} が見つかること`);
    const e = src.indexOf("\n    {\n      id:", s + 10);
    return src.slice(s, e > 0 ? e : src.length);
  };
  // 中学選抜「登録選手6〜8名」
  assert.match(blockOf("chugaku_senbatsu_dantai"), /per_team: 8, per_team_min: 6/, "中学選抜は6〜8人");
  // くしろリーグ「1チームメンバー4人以上」
  assert.match(blockOf("kushiro_league_summer"), /per_team: 4, per_team_min: 4/, "くしろリーグは4人以上");
  // ホープス「1チーム3〜4人」
  assert.match(blockOf("hopes_cub_bambi"), /per_team: 4, per_team_min: 3/, "ホープスは3〜4人");
  // バタフライ「1チーム4〜6人」
  assert.match(blockOf("butterfly_doubles_cup"), /per_team: 6, per_team_min: 4/, "バタフライは4〜6人");
  // タンチョウオープン「一人最大3種目」
  assert.match(blockOf("tancho_open_large"), /entry_max_events: 3/, "タンチョウは3種目まで");
  // 会長杯 中学「6〜8人」
  assert.match(blockOf("kaicho_hai"), /中学 団体戦[^}]*per_team: 8, per_team_min: 6/, "会長杯 中学は6〜8人");
});
