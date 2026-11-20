// 「全道大会に出場する意思」(選手ごと・フォーム設定でON)の回帰テスト。
// 守らせる不変条件:
//   ① 既定はOFF(既存の大会・申込の形は変わらない): フォームに欄が出ず、Excelにも列が出ない
//   ② ONにするとフォームに「あり/なし」の選択が出て、必須なら未回答は受け付けない。「あり」「なし」以外も受け付けない
//   ③ 回答は申込データ(extra_json)に保存され、受付台帳の詳細と集計Excelに出る
// 実行: node --test test/zendo-intent.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_zendo_" + process.pid + ".db");
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const XLSX = require("xlsx-js-style");
const db = require("../db");
const entryForm = require("../entry_form");
const { buildEntryWorkbook } = require("../lib/entry-workbook");

after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const EV = "一般男子シングルス";
const mk = (name, zendo) => { const t = db.createTournament({ name, date: "2099-12-06" }); db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "", event_config: [{ name: EV, type: "singles", fee: 700 }], ...(zendo ? { field_config: { fields: { zendo_intent: zendo } } } : {}) }); return t; };
let n = 0;
const apply = (t, extra, opts, who) => db.createTeamEntry(t.id, { team_name: "全道クラブ" + (++n), contact_name: "担当 " + n, contact_tel: "1", contact_email: "z@example.com",
  entries: [{ event: EV, type: "singles", name: who || "全道 太郎", furigana: "ぜんどう たろう", team: "x", extra_json: extra }] }, "zd" + n, { enforce: true, ...(opts || {}) });
const formHtml = (t) => { const tt = db.getTournament(t.id); return entryForm.buildEntryFormHTML(tt, [{ name: EV, type: "singles", fee: 700 }], { submit_url: "http://x/submit-team-entry", field_config: db.resolveFieldConfig(tt) }); };

test("① 既定はOFF: フォームにも台帳にもExcelにも出ない。回答なしでも申込できる", () => {
  const t = mk("全道OFF大会");
  assert.ok(formHtml(t).includes('"zendo_intent":"hidden"'), "フォームの設定はOFF");
  const r = apply(t, null);
  assert.ok(!r.error, r.error);
  const desk = db.getEntryDesk(t.id);
  assert.strictEqual(desk.tournament.zendo_enabled, false);
  const wb = XLSX.read(buildEntryWorkbook(db.getEntryExport(t.id)), { type: "buffer" });
  const heads = Object.values(wb.Sheets["選手名簿"]).map(c => c && c.v).filter(Boolean);
  assert.ok(!heads.includes("全道出場意思"));
});

test("②③ ON(必須): 欄が出る・未回答と不正値は拒否・回答は保存されて台帳とExcelに出る", () => {
  const t = mk("全道ON大会", "required");
  const html = formHtml(t);
  assert.ok(html.includes('"zendo_intent":"required"') && html.includes("全道大会に出場する意思"));
  assert.ok(apply(t, null).error, "未回答は受け付けない");
  assert.ok(apply(t, { zendo_intent: "たぶん" }).error, "あり/なし以外は受け付けない");
  const ok = apply(t, { zendo_intent: "あり" });
  assert.ok(!ok.error, ok.error);
  const ng = apply(t, { zendo_intent: "なし" }, {}, "全道 次郎");
  assert.ok(!ng.error, ng.error);
  const desk = db.getEntryDesk(t.id);
  assert.strictEqual(desk.tournament.zendo_enabled, true);
  const zs = desk.rows.flatMap(r => r.players.map(p => p.zendo)).sort();
  assert.deepStrictEqual(zs, ["あり", "なし"]);
  const wb = XLSX.read(buildEntryWorkbook(db.getEntryExport(t.id)), { type: "buffer" });
  const ros = wb.Sheets["選手名簿"];
  const cells = Object.keys(ros).filter(k => k[0] !== "!").map(k => String(ros[k].v));
  assert.ok(cells.includes("全道出場意思") && cells.includes("あり") && cells.includes("なし"));
});

test("③' 任意に切り替えた大会では未回答でも通り、台帳には未回答と出る", () => {
  const t = mk("全道任意大会", "optional");
  assert.ok(!apply(t, null).error);
  assert.strictEqual(db.getEntryDesk(t.id).rows[0].players[0].zendo, "");
});

test("④ 申込後の修正で全道出場意思を変えられる。「あり/なし」以外は受け付けない", () => {
  const t = mk("全道修正大会", "required");
  const a = apply(t, { zendo_intent: "あり" });
  assert.ok(!a.error, a.error);
  const view = db.getSubmissionEditView(a.submission_id, { admin: false });
  assert.strictEqual(view.form.fields.zendo_intent, "required", "修正画面にも項目が渡る");
  const id = view.entries[0].entry_id;
  const bad = db.editSubmission(a.submission_id, { entries: [{ entrant_id: id, extra: { zendo_intent: "たぶん" } }] }, { actor: "applicant" });
  assert.ok(bad.error, "不正な値は拒否");
  const ok = db.editSubmission(a.submission_id, { entries: [{ entrant_id: id, extra: { zendo_intent: "なし" } }] }, { actor: "applicant" });
  assert.ok(!ok.error, ok.error);
  assert.strictEqual(db.getEntryDesk(t.id).rows[0].players[0].zendo, "なし");
});
