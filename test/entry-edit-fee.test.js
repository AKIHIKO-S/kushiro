// 申込の後日修正(申込者・本部)と、参加料の集計・入金記録・料金改定の回帰テスト。
//
// 守らせる不変条件:
//   ① 申込用紙にある項目(連絡先・選手・区分/種目・団体メンバー・オプション)は後から直せる
//   ② 申込者は締切前・組合せ作成前だけ。本部は締切後も直せるが、組合せ作成後は表の側で直す
//   ③ 料金は「申込時の金額で固定」。種目・区分・人数が変わった行だけ、その時点の料金で付け直す
//   ④ 料金を後から変えても既存の申込は変わらず、差額として見え、本部の一括適用で初めて変わる
//   ⑤ 履歴には誰が・何を変えたかが残り、連絡先の値そのものは残さない
//   ⑥ シートへ送る形は古い GAS に新規申込として二重登録されない形(最上位に team_name を置かない)
// 実行: node --test test/entry-edit-fee.test.js
process.env.DB_PATH = "/tmp/ktta_entryedit_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EVENTS = [
  { name: "一般男子シングルス", type: "singles", fee: 700 },
  { name: "一般女子シングルス", type: "singles", fee: 700 },
  { name: "高校男子シングルス", type: "singles", fee: 500, capacity: 1 },
  { name: "男子ダブルス", type: "doubles", fee: 1000 },
  { name: "団体戦", type: "team", fee: 1000, fee_unit: "person", per_team: 6, per_team_min: 3 },
];
const OPTIONS = [{ key: "bento", label: "お弁当", unit: "個", price: 800, max: 20 }];

function setup(extra) {
  const t = db.createTournament({ name: "修正検証大会", date: "2027-09-01" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: EVENTS,
    entry_options: OPTIONS,
    field_config: { version: 2, fields: { team_name: "required", grade: "optional", supervisor: "optional" }, custom: [], event_overrides: {} },
    ...(extra || {}),
  });
  const tt = db.getTournament(t.id);
  const r = db.createTeamEntry(tt.id, {
    team_name: "試験クラブ", contact_name: "担当 一郎", contact_tel: "0154-11-2233", contact_email: "tanto@example.com",
    supervisor: "引率 花子",
    options: { bento: 2 },
    entries: [
      { event: "一般男子シングルス", type: "singles", name: "架空 太郎", team: "試験クラブ" },
      { event: "男子ダブルス", type: "doubles", name1: "架空 次郎", name2: "架空 三郎", team1: "試験クラブ", team2: "別クラブ" },
      { event: "団体戦", type: "team", team_name: "試験A", members: ["甲 一", "乙 二", "丙 三"] },
    ],
  }, "op-" + Math.random().toString(36).slice(2), { enforce: true });
  assert.ok(!r.error, "前提の申込が通ること: " + r.error);
  const view = db.getSubmissionEditView(r.submission_id, { admin: true });
  const byEv = (ev) => view.entries.find(e => e.event === ev);
  return { t: tt, sid: r.submission_id, total: r.total_amount, byEv };
}

test("受付時の金額: 700 + 1000 + 1000円×3人 + 弁当800×2 = 6300", () => {
  const { total } = setup();
  assert.strictEqual(total, 6300);
});

test("申込者は連絡先を直せる。電話・メールは伏せ字で見え、空欄は「変えない」", () => {
  const { sid } = setup();
  const v = db.getSubmissionEditView(sid);
  assert.strictEqual(v.submission.contact_tel, undefined, "申込者には素の電話番号を返さない");
  assert.match(v.submission.contact_tel_masked, /2233$/);
  assert.match(v.submission.contact_email_masked, /^t\*\*\*@example\.com$/);
  const r = db.editSubmission(sid, { contact: { contact_name: "担当 二郎", contact_tel: "", contact_email: "", supervisor: "引率 次子" } });
  assert.ok(!r.error, r.error);
  const a = db.getSubmissionEditView(sid, { admin: true });
  assert.strictEqual(a.submission.contact_name, "担当 二郎");
  assert.strictEqual(a.submission.contact_tel, "0154-11-2233", "空欄で送っても消えない");
  assert.strictEqual(a.submission.supervisor, "引率 次子");
  // 履歴は「どの項目を変えたか」だけ。値は残さない
  const ch = db.listEntryChanges(a.tournament.id).find(c => c.kind === "contact");
  assert.ok(ch && ch.after.fields.includes("申込責任者"));
  assert.ok(!JSON.stringify(ch).includes("担当 二郎"), "連絡先の値は履歴に残さない");
});

test("選手の氏名・所属を直しても参加料は変わらない", () => {
  const { sid, byEv } = setup();
  const s = byEv("一般男子シングルス");
  const r = db.editSubmission(sid, { entries: [{ entrant_id: s.entry_id, name: "架空 四郎", team: "別クラブ" }], reason: "記入ミス" });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.total_amount, 6300);
  const v = db.getSubmissionEditView(sid, { admin: true });
  const e = v.entries.find(x => x.entry_id === s.entry_id);
  assert.strictEqual(e.name, "架空 四郎");
  assert.strictEqual(e.team, "別クラブ");
  const ch = db.listEntryChanges(v.tournament.id).find(c => c.kind === "edit");
  assert.ok(ch.change_group, "保存単位の鍵が付く");
  assert.strictEqual(ch.reason, "記入ミス");
});

test("区分(種目)の付け替えは同じ形式の中だけ。料金は付け替え先で付け直す", () => {
  const { sid, byEv } = setup();
  const s = byEv("一般男子シングルス");
  const ng = db.editSubmission(sid, { entries: [{ entrant_id: s.entry_id, event: "男子ダブルス" }] });
  assert.match(ng.error, /形式が違う/);
  const ok = db.editSubmission(sid, { entries: [{ entrant_id: s.entry_id, event: "高校男子シングルス" }] });
  assert.ok(!ok.error, ok.error);
  assert.strictEqual(ok.total_amount, 6300 - 700 + 500);
  const e = db.getSubmissionEditView(sid, { admin: true }).entries.find(x => x.entry_id === s.entry_id);
  assert.strictEqual(e.event, "高校男子シングルス");
  assert.strictEqual(e.fee, 500);
});

test("付け替え先が定員に達していれば申込者は変更できない", () => {
  const a = setup();
  const b = setup();
  // a の大会とは別大会なので、同じ大会で2件目を作る
  const r2 = db.createTeamEntry(a.t.id, {
    team_name: "別団", contact_name: "担当 三郎", contact_tel: "0154", contact_email: "b@example.com",
    entries: [{ event: "高校男子シングルス", type: "singles", name: "架空 五郎", team: "別団" }],
  }, "op-cap-" + Math.random(), { enforce: true });
  assert.ok(!r2.error, r2.error);
  const s = a.byEv("一般男子シングルス");
  const ng = db.editSubmission(a.sid, { entries: [{ entrant_id: s.entry_id, event: "高校男子シングルス" }] });
  assert.match(ng.error, /定員/);
  assert.ok(b.sid);
});

test("団体メンバーを増やすと1人あたり料金の分だけ増える。最少人数を割る変更は拒否", () => {
  const { sid, byEv } = setup();
  const tm = byEv("団体戦");
  const ng = db.editSubmission(sid, { entries: [{ entrant_id: tm.entry_id, members: ["甲 一", "乙 二"] }] });
  assert.match(ng.error, /3人以上/);
  const ok = db.editSubmission(sid, { entries: [{ entrant_id: tm.entry_id, members: ["甲 一", "乙 二", "丙 三", "丁 四"] }] });
  assert.ok(!ok.error, ok.error);
  assert.strictEqual(ok.total_amount, 6300 + 1000);
  const e = db.getSubmissionEditView(sid, { admin: true }).entries.find(x => x.entry_id === tm.entry_id);
  assert.deepStrictEqual(e.members, ["甲 一", "乙 二", "丙 三", "丁 四"]);
});

test("お弁当の数を直せる(締切後の申込者は不可・本部は可)", () => {
  const { t, sid } = setup();
  const r = db.editSubmission(sid, { options: { bento: 3 } });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.total_amount, 6300 + 800);
  db.updateEntrySettings(t.id, { entries_open: 0 });
  const ng = db.editSubmission(sid, { options: { bento: 1 } });
  assert.match(ng.error, /受け付けていません/);
  const adm = db.editSubmission(sid, { options: { bento: 1 } }, { actor: "admin" });
  assert.ok(!adm.error, adm.error);
  assert.strictEqual(adm.total_amount, 6300 - 800);
});

test("締切後: 申込者は選手を直せないが連絡先は直せる。本部は選手も直せる", () => {
  const { t, sid, byEv } = setup();
  db.updateEntrySettings(t.id, { entries_open: 0 });
  const s = byEv("一般男子シングルス");
  const ng = db.editSubmission(sid, { entries: [{ entrant_id: s.entry_id, name: "架空 六郎" }] });
  assert.match(ng.error, /大会本部/);
  const c = db.editSubmission(sid, { contact: { contact_name: "担当 四郎" } });
  assert.ok(!c.error, c.error);
  const adm = db.editSubmission(sid, { entries: [{ entrant_id: s.entry_id, name: "架空 六郎" }] }, { actor: "admin" });
  assert.ok(!adm.error, adm.error);
});

test("本部でも組合せ作成後は選手変更を拒否する(表の側で直す)", () => {
  const { t, sid, byEv } = setup();
  const r2 = db.createTeamEntry(t.id, {
    team_name: "別団", contact_name: "担当 三郎", contact_tel: "0154", contact_email: "b@example.com",
    entries: [{ event: "一般男子シングルス", type: "singles", name: "架空 九郎", team: "別団" }],
  }, "op-br-" + Math.random(), { enforce: true });
  assert.ok(!r2.error, r2.error);
  db.updateEntrySettings(t.id, { entries_open: 0 });
  const g = db.generateBracket(t.id, "一般男子シングルス", {});
  assert.ok(!(g && g.error), g && g.error);
  const s = byEv("一般男子シングルス");
  const ng = db.editSubmission(sid, { entries: [{ entrant_id: s.entry_id, name: "架空 七郎" }] }, { actor: "admin" });
  assert.match(ng.error, /表を編集/);
});

test("取消は請求から外れ、本部は取消を戻せる(申込者は戻せない)", () => {
  const { sid, byEv } = setup();
  const d = byEv("男子ダブルス");
  const c = db.editSubmission(sid, { entries: [{ entrant_id: d.entry_id, cancel: true }] });
  assert.ok(!c.error, c.error);
  assert.strictEqual(c.total_amount, 6300 - 1000);
  const ng = db.editSubmission(sid, { entries: [{ entrant_id: d.entry_id, restore: true }] });
  assert.match(ng.error, /大会本部/);
  const ok = db.editSubmission(sid, { entries: [{ entrant_id: d.entry_id, restore: true }] }, { actor: "admin" });
  assert.ok(!ok.error, ok.error);
  assert.strictEqual(ok.total_amount, 6300);
});

test("他人の申込の出場は指定できない", () => {
  const a = setup();
  const b = setup();
  const s = b.byEv("一般男子シングルス");
  const ng = db.editSubmission(a.sid, { entries: [{ entrant_id: s.entry_id, name: "乗っ取り" }] });
  assert.match(ng.error, /含まれない/);
});

test("参加料の集計: 請求額・取消・入金・未収", () => {
  const { t, sid, byEv } = setup();
  db.editSubmission(sid, { entries: [{ entrant_id: byEv("男子ダブルス").entry_id, cancel: true }] });
  let f = db.getFeeSummary(t.id);
  assert.strictEqual(f.totals.submissions, 1);
  assert.strictEqual(f.totals.billed, 5300);
  assert.strictEqual(f.totals.cancelled, 1);
  assert.strictEqual(f.totals.cancelled_amount, 1000);
  assert.strictEqual(f.totals.outstanding, 5300);
  const p = db.setSubmissionPayment(sid, { status: "partial", amount: 3000, note: "当日受付" });
  assert.ok(!p.error, p.error);
  f = db.getFeeSummary(t.id);
  assert.strictEqual(f.totals.paid, 3000);
  assert.strictEqual(f.totals.outstanding, 2300);
  assert.strictEqual(f.rows[0].pay_status_label, "一部入金");
  const full = db.setSubmissionPayment(sid, { status: "paid" });
  assert.strictEqual(full.paid_amount, 5300, "入金済で額を省けば請求額で記録");
  assert.strictEqual(db.getFeeSummary(t.id).totals.outstanding, 0);
  assert.match(db.setSubmissionPayment(sid, { status: "x" }).error, /入金状況/);
  const ev = f.by_event.find(r => r.event === "団体戦");
  assert.strictEqual(ev.amount, 3000);
});

test("料金改定: 既存の申込は変わらず差額として見え、一括適用で初めて変わる", () => {
  const { t, sid } = setup();
  const evs = EVENTS.map(e => e.name === "一般男子シングルス" ? { ...e, fee: 900 } : e);
  db.updateEntrySettings(t.id, { event_config: evs });
  let f = db.getFeeSummary(t.id);
  assert.strictEqual(f.totals.billed, 6300, "既存は申込時の額のまま");
  assert.strictEqual(f.totals.reprice_submissions, 1);
  assert.strictEqual(f.totals.reprice_diff, 200);
  const dry = db.repriceSubmissions(t.id, { dry_run: true });
  assert.strictEqual(dry.items.length, 1);
  assert.strictEqual(db.getFeeSummary(t.id).totals.billed, 6300, "試算では変わらない");
  const ap = db.repriceSubmissions(t.id, {});
  assert.strictEqual(ap.applied, 1);
  f = db.getFeeSummary(t.id);
  assert.strictEqual(f.totals.billed, 6500);
  assert.strictEqual(f.totals.reprice_submissions, 0);
  assert.ok(db.listEntryChanges(t.id).some(c => c.kind === "reprice" && c.submission_id === sid));
});

test("シートへ送る形: 古いGASに新規申込として拾われない形で、申込の全行を持つ", () => {
  const { sid, byEv } = setup();
  const r = db.editSubmission(sid, { entries: [{ entrant_id: byEv("一般男子シングルス").entry_id, name: "架空 八郎" }] });
  const p = db.buildSheetUpdatePayload(sid, r.group);
  assert.strictEqual(p.action, "update");
  assert.strictEqual(p.team_name, undefined);
  assert.strictEqual(p.entries, undefined);
  assert.strictEqual(p.update_entries.length, 3);
  assert.ok(p.update_entries.every(e => e.entry_id));
  assert.strictEqual(p.changes.length, 1);
  assert.match(p.changes[0].summary, /架空 八郎/);
  assert.strictEqual(p.submission.total_amount, 6300);
  assert.ok(p.submission.ledger_key, "台帳の申込IDを持つ");
});

test("変化が無い保存は何も記録しない", () => {
  const { t, sid, byEv } = setup();
  const s = byEv("一般男子シングルス");
  const r = db.editSubmission(sid, { entries: [{ entrant_id: s.entry_id, name: s.name }] });
  assert.ok(r.unchanged);
  assert.strictEqual(db.listEntryChanges(t.id).length, 0);
});
