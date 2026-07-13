// Phase 2 回帰テスト: field_config(必須項目設定 + 自由項目) と extra_json(選手行/申込単位の回答)。
//  - DEFAULT_FIELD_CONFIG フォールバック(空 field_config の既存大会 = 現行挙動)
//  - resolveFieldConfig の浅いマージ(既定キー補完 + 大会側優先) + event_overrides
//  - createTournament / updateEntrySettings の field_config 往復(明示指定時のみ更新)
//  - createTeamEntry が entrant.extra_json(学年/自由回答) と submission.extra_json(引率者/顧問/コーチ)を保存
//  - deleteSubmissionPII が extra_json(引率者名等のPII)を匿名化する
// 実行: node --test test/field-config.test.js
process.env.DB_PATH = "/tmp/ktta_fieldcfg_" + process.pid + ".db";
process.env.SNAPSHOT_DIR = "/tmp/ktta_fieldcfg_snaps_" + process.pid;

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

const singlesCfg = [{ name: "中学男子シングルス", type: "singles", fee: 700, fee_student: 500 }];

test("resolveFieldConfig: 空 field_config は DEFAULT を返す(既存大会=現行挙動)", () => {
  const t = db.createTournament({ name: "既定", date: "2027-09-01", event_config: singlesCfg, entries_open: 1 });
  const rc = db.resolveFieldConfig(db.getTournament(t.id));
  assert.strictEqual(rc.fields.team_name, "required", "団体名は既定で必須");
  assert.strictEqual(rc.fields.furigana, "hidden", "ふりがなは既定で非表示(現行未収集)");
  assert.strictEqual(rc.fields.note, "optional", "通信欄は既定で任意");
  assert.deepStrictEqual(rc.custom, [], "自由項目は既定で空");
});

test("resolveFieldConfig: 大会側指定が既定を上書きしつつ未指定キーは既定補完", () => {
  const t = db.createTournament({
    name: "上書き", date: "2027-09-02", event_config: singlesCfg, entries_open: 1,
    field_config: { version: 1, fields: { furigana: "required", note: "hidden" } },
  });
  const rc = db.resolveFieldConfig(db.getTournament(t.id));
  assert.strictEqual(rc.fields.furigana, "required", "大会側指定で必須に");
  assert.strictEqual(rc.fields.note, "hidden", "大会側指定で非表示に");
  assert.strictEqual(rc.fields.team_name, "required", "未指定キーは既定(required)を補完");
});

test("field_config: 明示指定時のみ更新(受付フラグだけの切替では既存 field_config を壊さない)", () => {
  const t = db.createTournament({
    name: "トグル", date: "2027-09-03", event_config: singlesCfg, entries_open: 1,
    field_config: { version: 1, fields: { furigana: "required" } },
  });
  // field_config を渡さず受付だけトグル → 既存 field_config は維持される
  db.updateEntrySettings(t.id, { entries_open: 0 });
  const rc = db.resolveFieldConfig(db.getTournament(t.id));
  assert.strictEqual(rc.fields.furigana, "required", "field_config 未指定の更新で既存設定が消えない");
});

test("自由項目 custom(select/checkbox) が往復する", () => {
  const custom = [
    { key: "tshirt", label: "Tシャツ", type: "select", options: ["S", "M", "L"], required: true, scope: "player" },
    { key: "bus", label: "送迎バス", type: "checkbox", required: false, scope: "submission" },
  ];
  const t = db.createTournament({
    name: "自由項目", date: "2027-09-04", event_config: singlesCfg, entries_open: 1,
    field_config: { version: 1, fields: {}, custom },
  });
  const rc = db.resolveFieldConfig(db.getTournament(t.id));
  assert.strictEqual(rc.custom.length, 2);
  assert.strictEqual(rc.custom[0].key, "tshirt");
  assert.deepStrictEqual(rc.custom[0].options, ["S", "M", "L"]);
  assert.strictEqual(rc.custom[1].scope, "submission");
});

test("createTeamEntry: entrant.extra_json(学年/自由回答) と submission.extra_json(引率者/顧問/コーチ) を保存", () => {
  const t = db.createTournament({ name: "保存", date: "2027-09-05", event_config: singlesCfg, entries_open: 1 });
  const r = db.createTeamEntry(t.id, {
    team_name: "甲", contact_name: "監督", contact_email: "a@b.jp",
    supervisor: "引率A", advisor: "顧問B", coach: "コーチC", extra: { bus: true },
    entries: [{ event: "中学男子シングルス", type: "singles", name: "山田 太郎", team: "甲", fee: 500,
      extra_json: { grade: "中1", answers: { tshirt: "M" } } }],
  });
  assert.ok(r.ok && r.applicant_token, "申込成功+トークン発行");
  const view = db.getSubmissionByToken(r.applicant_token);
  assert.strictEqual(view.extra.supervisor, "引率A");
  assert.strictEqual(view.extra.advisor, "顧問B");
  assert.strictEqual(view.extra.coach, "コーチC");
  assert.strictEqual(view.extra.answers.bus, true);
  assert.strictEqual(view.entries[0].grade, "中1");
  assert.strictEqual(view.entries[0].answers.tshirt, "M");
});

test("deleteSubmissionPII: extra_json(引率者名等のPII)を匿名化する", () => {
  const t = db.createTournament({ name: "PII", date: "2027-09-06", event_config: singlesCfg, entries_open: 1 });
  const r = db.createTeamEntry(t.id, {
    team_name: "乙", contact_name: "監督2", contact_email: "c@d.jp",
    supervisor: "引率X", coach: "コーチY",
    entries: [{ event: "中学男子シングルス", type: "singles", name: "田中 花子", team: "乙", fee: 500,
      extra_json: { grade: "中2", birth_date: "2011-04-01" } }],
  });
  const res = db.deleteSubmissionPII(r.submission_id);
  assert.ok(res.ok, "匿名化成功");
  const view = db.getSubmissionByToken(r.applicant_token);
  // 匿名化後: 引率者/コーチ名・生年月日・学年が消えている(閲覧導線は残るが中身は空)
  assert.ok(!view.extra || (!view.extra.supervisor && !view.extra.coach), "申込単位の引率者/コーチ名が消えた");
  assert.strictEqual(view.entries[0].grade, "", "選手行の学年(申告)が消えた");
});
