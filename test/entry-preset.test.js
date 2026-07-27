// 大会ごとの申込プリセット。
//  ・テンプレートに「この大会で聞くこと」を持たせ、大会を作った時点で申込フォームが整う
//  ・毎年ある大会は、去年の申込設定をそのまま引き写せる(締切日・受付・申込データは引き継がない)
// 実行: node --test test/entry-preset.test.js
process.env.DB_PATH = "/tmp/ktta_preset_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EVENTS = [
  { name: "男子シングルス", type: "singles", fee: 700, category: "general" },
  { name: "女子シングルス", type: "singles", fee: 700, category: "general" },
];
const OPTIONS = [{ key: "bento", label: "お弁当", price: 800, unit: "個", max: 5, note: "当日受取" }];

// 去年の大会(コピー元)を作る
function makeSource() {
  const t = db.createTournament({ name: "去年のヤサカ杯", date: "2026-06-01", venue: "アリーナ" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: EVENTS,
    entry_deadline: "2026-05-20",
    entry_deadline_time: "17:00",
    entry_capacity: 120,
    entry_max_events: 3,
    entry_options: OPTIONS,
    field_config: { version: 2, fields: { furigana: "required", grade: "optional", player_team: "required" }, custom: [], event_overrides: {} },
  });
  return db.getTournament(t.id);
}

// ── コピー ────────────────────────────────────────────────
test("申込設定を他の大会からコピーできる", () => {
  const src = makeSource();
  const dst = db.createTournament({ name: "今年のヤサカ杯", date: "2027-06-01", venue: "アリーナ" });
  const r = db.copyEntrySettings(dst.id, src.id, {});
  assert.ok(r.ok, r.error);

  const after = db.getTournament(dst.id);
  const cfg = db.resolveFieldConfig(after);
  assert.strictEqual(cfg.fields.furigana, "required", "項目設定が引き継がれる");
  assert.strictEqual(cfg.fields.grade, "optional");
  assert.strictEqual(after.entry_deadline_time, "17:00", "締切時刻は運用が同じなので引き継ぐ");
  assert.strictEqual(after.entry_capacity, 120, "定員");
  assert.strictEqual(after.entry_max_events, 3, "1人あたりの種目数上限");
  assert.strictEqual(db.resolveEntryOptions(after).length, 1, "有料オプション");
  assert.strictEqual(db.resolveEntryOptions(after)[0].label, "お弁当");
});

test("締切日・受付の開閉はコピーしない(引き写した瞬間に受付が開かない)", () => {
  const src = makeSource();
  const dst = db.createTournament({ name: "今年の大会", date: "2027-06-01", venue: "アリーナ" });
  db.updateEntrySettings(dst.id, { entries_open: 0, event_config: EVENTS, entry_deadline: "2027-05-25" });

  db.copyEntrySettings(dst.id, src.id, {});
  const after = db.getTournament(dst.id);
  assert.strictEqual(after.entries_open, 0, "受付は閉じたまま");
  assert.strictEqual(after.entry_deadline, "2027-05-25", "締切日は大会ごとに違うので現状維持");
});

test("種目は既定ではコピーしない(申込済みの種目名が変わると申込が宙に浮く)", () => {
  const src = makeSource();
  const dst = db.createTournament({ name: "別大会", date: "2027-07-01", venue: "アリーナ" });
  const own = [{ name: "混合ダブルス", type: "doubles", fee: 1000, category: "general" }];
  db.updateEntrySettings(dst.id, { entries_open: 0, event_config: own });

  db.copyEntrySettings(dst.id, src.id, {});
  const evs = JSON.parse(db.getTournament(dst.id).event_config || "[]");
  assert.deepStrictEqual(evs.map(e => e.name), ["混合ダブルス"], "種目は触らない");
});

test("種目も一緒にを選べば種目・料金ごと引き写す", () => {
  const src = makeSource();
  const dst = db.createTournament({ name: "別大会2", date: "2027-07-02", venue: "アリーナ" });
  db.updateEntrySettings(dst.id, { entries_open: 0, event_config: [{ name: "旧種目", type: "singles", fee: 100 }] });

  const r = db.copyEntrySettings(dst.id, src.id, { with_events: true });
  assert.ok(r.ok, r.error);
  const after = db.getTournament(dst.id);
  const evs = JSON.parse(after.event_config || "[]");
  assert.deepStrictEqual(evs.map(e => e.name), ["男子シングルス", "女子シングルス"]);
  assert.strictEqual(evs[0].fee, 700, "料金も引き継ぐ");
  assert.deepStrictEqual(JSON.parse(after.entry_events || "[]"), ["男子シングルス", "女子シングルス"],
    "受付種目の一覧も種目に追随する");
});

test("既に入っている申込はコピーで消えない", () => {
  const src = makeSource();
  const dst = db.createTournament({ name: "申込済み大会", date: "2027-08-01", venue: "アリーナ" });
  db.updateEntrySettings(dst.id, { entries_open: 1, event_config: EVENTS });
  const sub = db.createTeamEntry(dst.id, {
    team_name: "チームA", contact_name: "担当", contact_tel: "0154-00-0000", contact_email: "a@example.com",
    entries: [{ event: "男子シングルス", type: "singles", name: "甲 一", team: "チームA" }],
  }, "op-preset-1");
  assert.ok(!sub.error, sub.error);

  db.copyEntrySettings(dst.id, src.id, {});
  assert.strictEqual(db.getEntries(dst.id).length, 1, "申込データは無傷");

  // 申込が入った後に種目を差し替えると、その申込がどの種目にも属さなくなるので拒否する
  const r = db.copyEntrySettings(dst.id, src.id, { with_events: true });
  assert.match(r.error || "", /既に1件の申込/, "種目ごとのコピーは拒否される");
  assert.match(r.error || "", /チェックを外す/, "どうすればよいか書いてある");
  const evs = JSON.parse(db.getTournament(dst.id).event_config || "[]");
  assert.strictEqual(evs.length, 2, "拒否されたので種目は変わっていない");
});

test("取消済みの申込しか無ければ種目ごとコピーできる", () => {
  const src = makeSource();
  const dst = db.createTournament({ name: "取消のみ", date: "2027-08-05", venue: "アリーナ" });
  db.updateEntrySettings(dst.id, { entries_open: 1, event_config: [{ name: "旧種目", type: "singles", fee: 100 }] });
  const sub = db.createTeamEntry(dst.id, {
    team_name: "チームB", contact_name: "担当", contact_tel: "0154-00-0000", contact_email: "b@example.com",
    entries: [{ event: "旧種目", type: "singles", name: "乙 二", team: "チームB" }],
  }, "op-preset-2");
  assert.ok(!sub.error, sub.error);
  const ent = db.getEntries(dst.id)[0];
  const c = db.applicantCancelEntrant(sub.applicant_token, ent.id, "都合により");
  assert.ok(!c.error, c.error);

  const r = db.copyEntrySettings(dst.id, src.id, { with_events: true });
  assert.ok(r.ok, r.error);
  const evs = JSON.parse(db.getTournament(dst.id).event_config || "[]");
  assert.deepStrictEqual(evs.map(e => e.name), ["男子シングルス", "女子シングルス"]);
});

test("同じ大会・存在しない大会は拒否する", () => {
  const src = makeSource();
  assert.match(db.copyEntrySettings(src.id, src.id, {}).error || "", /同じ大会/);
  assert.match(db.copyEntrySettings(src.id, "no-such-id", {}).error || "", /コピー元/);
  assert.match(db.copyEntrySettings("no-such-id", src.id, {}).error || "", /コピー先/);
});

test("コピー元の候補一覧に自分は出ない", () => {
  const src = makeSource();
  const dst = db.createTournament({ name: "候補確認", date: "2027-09-01", venue: "アリーナ" });
  const items = db.listEntrySettingSources(dst.id, 50);
  assert.ok(!items.some(x => x.id === dst.id), "自分は候補外");
  const found = items.find(x => x.id === src.id);
  assert.ok(found, "他の大会は候補に出る");
  assert.strictEqual(found.has_field_config, true, "項目設定の有無が分かる");
  assert.strictEqual(found.events, 2, "種目数が分かる");
  assert.strictEqual(found.options, 1, "オプション数が分かる");
});

// ── テンプレートのプリセット ──────────────────────────────
test("大会作成時にテンプレートの申込プリセットが適用される", () => {
  const t = db.createTournament({
    name: "中学新人戦", date: "2027-11-24", venue: "サブアリーナ",
    event_config: [{ name: "男子シングルス", type: "singles", fee: 500, category: "middle" }],
    entries_open: false,
    entry_preset: {
      field_config: { fields: { furigana: "required", grade: "required", player_team: "required" } },
      entry_deadline_time: "17:00",
    },
  });
  const cfg = db.resolveFieldConfig(t);
  assert.strictEqual(cfg.fields.furigana, "required");
  assert.strictEqual(cfg.fields.grade, "required", "学生大会は学年を必ず聞く");
  assert.strictEqual(t.entry_deadline_time, "17:00");
});

test("個別指定はプリセットより優先される", () => {
  const t = db.createTournament({
    name: "個別指定あり", date: "2027-11-25", venue: "サブアリーナ",
    event_config: [{ name: "男子シングルス", type: "singles", fee: 500 }],
    field_config: { version: 2, fields: { furigana: "hidden", grade: "hidden" }, custom: [], event_overrides: {} },
    entry_preset: { field_config: { fields: { furigana: "required", grade: "required" } } },
  });
  const cfg = db.resolveFieldConfig(t);
  assert.strictEqual(cfg.fields.furigana, "hidden", "明示指定が勝つ");
});

test("プリセットが無い大会は既定のまま(後方互換)", () => {
  const t = db.createTournament({
    name: "プリセット無し", date: "2027-11-26", venue: "会場",
    event_config: [{ name: "男子シングルス", type: "singles", fee: 500 }],
  });
  const cfg = db.resolveFieldConfig(t);
  assert.strictEqual(cfg.fields.furigana, "hidden", "既定(未収集)のまま");
  assert.strictEqual(cfg.fields.team_name, "required");
});

// ── テンプレート定義そのもの ──────────────────────────────
function loadTemplates() {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "shared", "tournament-templates.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window;
}

test("全テンプレートに申込プリセットが付いている", () => {
  const w = loadTemplates();
  // vm サンドボックス由来の配列は host の Array と別realmなので deepStrictEqual が通らない。
  // 件数と中身を素の値で検査する。
  const ids = Array.from(w.TT_TEMPLATES).map(t => t.id);
  assert.ok(ids.length >= 17, "テンプレートは17件以上");
  const missing = ids.filter((_, i) => !w.TT_TEMPLATES[i].entry_preset);
  assert.strictEqual(missing.length, 0, "プリセット未設定のテンプレートがある: " + missing.join(", "));
});

test("プリセットの項目状態は required/optional/hidden のいずれか", () => {
  const w = loadTemplates();
  const ok = ["required", "optional", "hidden"];
  const known = ["team_name", "furigana", "player_team", "grade", "player_gender", "supervisor", "advisor", "coach", "note"];
  Array.from(w.TT_TEMPLATES).forEach(t => {
    const f = (t.entry_preset.field_config || {}).fields || {};
    Object.keys(f).forEach(k => {
      assert.ok(known.includes(k), `${t.id}: 未知の項目キー ${k}`);
      assert.ok(ok.includes(f[k]), `${t.id}: ${k} の状態が不正 (${f[k]})`);
    });
  });
});

test("学生の大会は学年を必須、年代別のラージは学年を出さない", () => {
  const w = loadTemplates();
  const byId = {};
  Array.from(w.TT_TEMPLATES).forEach(t => { byId[t.id] = t; });
  const grade = (id) => (byId[id].entry_preset.field_config.fields || {}).grade;
  assert.strictEqual(grade("chugaku_shinjin"), "required", "中学新人戦");
  assert.strictEqual(grade("hopes_cub_bambi"), "required", "小学生の大会");
  assert.strictEqual(grade("tancho_open_large"), "hidden", "ラージの年代別");
  assert.strictEqual(grade("marimo_open_akan"), "hidden", "ラージの年代別");
  // 一般・オープンは「一般の部に学生が出る」ため任意で残す
  assert.strictEqual(grade("nagoyakatei_kushiro_open"), "optional", "オープン大会");
  assert.strictEqual(grade("butterfly_doubles_cup"), "optional", "オープン大会(中3・高3は一般の部)");
});

test("プリセットはテンプレートから大会作成データへ流れる", () => {
  const w = loadTemplates();
  const built = w.TT_buildTournamentFromTemplate("chugaku_shinjin", { date: "2027-11-24" });
  assert.ok(built._entry_preset, "作成データにプリセットが乗る");
  assert.strictEqual(built._entry_preset.field_config.fields.grade, "required");
});
