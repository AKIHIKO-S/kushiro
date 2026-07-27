// 選手情報の粒度(P5): 種目ごとの項目設定と、団体戦のメンバーごとの項目収集。
//  - event_overrides で種目ごとに 必須/任意/非表示 を変えられる(管理画面から設定可能に)
//  - 団体戦もメンバーごとにふりがな・学年・性別・自由項目を集められる
//    (従来は氏名だけ。項目を出していない種目では形が変わらない=後方互換)
//  - サーバ側の必須検証もメンバー単位で効く
// 実行: node --test test/entry-per-event-fields.test.js
process.env.DB_PATH = "/tmp/ktta_perevent_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const entryForm = require("../entry_form.js");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EVENTS = [
  { name: "中学男子団体", type: "team", fee: 5000, per_team: 4 },
  { name: "一般男子シングルス", type: "singles", fee: 1500 },
];
function mkTournament(fieldConfig) {
  const t = db.createTournament({ name: "粒度検証", date: "2027-06-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: EVENTS, field_config: fieldConfig });
  return db.getTournament(t.id);
}
const html = (t) => entryForm.buildEntryFormHTML(t, EVENTS, { field_config: db.resolveFieldConfig(t) });
const submit = (t, entries, enforce) => db.createTeamEntry(t.id, {
  team_name: "検証中", contact_name: "担当 太郎", contact_tel: "0154", contact_email: "t@example.com", entries,
}, "op-" + Math.random().toString(36).slice(2), { enforce: enforce !== false });

// ── 種目ごとの上書き ────────────────────────────────────────
test("種目ごとに項目の必須/非表示を変えられる", () => {
  const t = mkTournament({
    version: 2,
    fields: { furigana: "hidden", grade: "hidden" },
    event_overrides: { "中学男子団体": { furigana: "required", grade: "required" } },
    custom: [],
  });
  // 選手行のDOMは addEntry がブラウザで組み立てるため、ここでは
  // 「種目別の解決結果がフォームに正しく渡っているか」を埋め込みデータで検証する
  // (実DOMの見え方は Playwright で別途確認済み)。
  const cfg = JSON.parse(html(t).match(/const FIELD_CFG = (\{[\s\S]*?\});/)[1]);
  assert.strictEqual(cfg.fields.furigana, "hidden", "大会レベルは非表示");
  assert.deepStrictEqual(cfg.event_overrides["中学男子団体"], { furigana: "required", grade: "required" },
    "団体種目だけ必須に上書きされている");
});

test("種目別に1つでも表示される項目は集計シートの列になる(union)", () => {
  const t = mkTournament({
    version: 2, fields: { grade: "hidden" },
    event_overrides: { "中学男子団体": { grade: "required" } }, custom: [],
  });
  assert.deepStrictEqual(db.buildFormSchema(t).columns.player.map(c => c.key), ["grade"]);
});

test("上書きが無ければ大会レベルの設定に従う", () => {
  const t = mkTournament({ version: 2, fields: { furigana: "required" }, event_overrides: {}, custom: [] });
  const cfg = JSON.parse(html(t).match(/const FIELD_CFG = (\{[\s\S]*?\});/)[1]);
  assert.strictEqual(cfg.fields.furigana, "required");
  assert.deepStrictEqual(cfg.event_overrides, {}, "上書きが無い");
});

// ── 団体戦のメンバー項目 ────────────────────────────────────
test("団体戦のメンバー欄は項目の有無で組み方を切り替える(コードの分岐が存在する)", () => {
  const h = html(mkTournament({ version: 2, fields: {}, event_overrides: {}, custom: [] }));
  const addFn = h.slice(h.indexOf("function addEntry"), h.indexOf("function removeEntry"));
  assert.ok(addFn.includes("const memberFields = playerFieldsHtml("), "メンバー項目の有無を先に調べる");
  assert.ok(addFn.includes("member-block"), "項目があるときはメンバーを枠で囲む");
  assert.ok(/_m' \+ i \+ '"/.test(addFn) || addFn.includes("_m' + i"), "氏名欄の名前は従来と同じ規則");
});

test("メンバーごとの申告が保存され、名簿から読める", () => {
  const t = mkTournament({
    version: 2, fields: { furigana: "required", grade: "optional" }, event_overrides: {}, custom: [],
  });
  const r = submit(t, [{
    event: "中学男子団体", type: "team", team_name: "湖陵中A", members: ["甲 一", "乙 二"],
    members_detail: [
      { name: "甲 一", furigana: "こう はじめ", grade: "中2" },
      { name: "乙 二", furigana: "おつ じ", grade: "中3" },
    ],
  }]);
  assert.ok(!r.error, r.error);
  const roster = db.getTeamRosters(t.id).find(x => x.team_name === "湖陵中A");
  assert.ok(roster, "名簿に出る");
  assert.deepStrictEqual(roster.members, ["甲 一", "乙 二"], "氏名の配列は従来どおり");
  assert.deepStrictEqual(roster.members_detail.map(m => [m.name, m.furigana, m.grade]),
    [["甲 一", "こう はじめ", "中2"], ["乙 二", "おつ じ", "中3"]]);
});

test("従来の団体申込(詳細なし)は members_detail が null で従来どおり読める", () => {
  const t = mkTournament({ version: 2, fields: {}, event_overrides: {}, custom: [] });
  submit(t, [{ event: "中学男子団体", type: "team", team_name: "旧式中", members: ["丙 三"] }], false);
  const roster = db.getTeamRosters(t.id).find(x => x.team_name === "旧式中");
  assert.deepStrictEqual(roster.members, ["丙 三"]);
  assert.strictEqual(roster.members_detail, null);
});

// ── サーバ側検証 ────────────────────────────────────────────
test("団体のメンバー必須がサーバ側で効く(誰が足りないか分かる)", () => {
  const t = mkTournament({
    version: 2, fields: { furigana: "required" }, event_overrides: {}, custom: [],
  });
  const r = submit(t, [{
    event: "中学男子団体", type: "team", team_name: "欠落中", members: ["甲 一", "乙 二"],
    members_detail: [{ name: "甲 一", furigana: "こう はじめ" }, { name: "乙 二" }],
  }]);
  assert.ok(r.error && r.validation, "拒否される: " + r.error);
  assert.match(r.error, /メンバー2/, "何人目かを示す");
  assert.match(r.error, /ふりがな/);
});

test("記入のないメンバー行は必須にならない", () => {
  const t = mkTournament({
    version: 2, fields: { furigana: "required" }, event_overrides: {}, custom: [],
  });
  const r = submit(t, [{
    event: "中学男子団体", type: "team", team_name: "一人中", members: ["甲 一"],
    members_detail: [{ name: "甲 一", furigana: "こう はじめ" }, { name: "" }, { name: "  " }],
  }]);
  assert.ok(!r.error, "空メンバーは無視される: " + r.error);
});

test("項目を出していない団体種目では従来どおり検証しない", () => {
  const t = mkTournament({
    version: 2, fields: { furigana: "required" },
    event_overrides: { "中学男子団体": { furigana: "hidden" } }, custom: [],
  });
  const r = submit(t, [{
    event: "中学男子団体", type: "team", team_name: "非表示中", members: ["甲 一"],
  }]);
  assert.ok(!r.error, "ふりがな無しでも通る: " + r.error);
});

// ── 年齢制限種目の生年月日 ──────────────────────────────────
test("年齢自動判定の種目では生年月日が必須で出る", () => {
  const t = db.createTournament({ name: "年齢種目", date: "2027-06-01" });
  const evs = [{ name: "シニア", type: "singles", fee: 1000, age_check: { mode: "birthdate" } }];
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: evs });
  const tt = db.getTournament(t.id);
  const h = entryForm.buildEntryFormHTML(tt, evs, { field_config: db.resolveFieldConfig(tt) });
  assert.ok(h.includes("_bdate"), "生年月日欄が出る");
  assert.ok(/_bdate"[^>]*required/.test(h), "必須になっている");
});
