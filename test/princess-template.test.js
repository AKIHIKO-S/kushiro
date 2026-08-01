// 北海道プリンセス卓球大会テンプレートと、それを成立させる仕組みの回帰。
//
// この大会は KTTA が主催者ではなく「釧路支部として支部内の申込を取りまとめる」立場になる。
// 要項(第55回・2026年)から機械的に守るべき条件:
//   ・団体戦は 監督1名 + 選手4〜7人、複・単・複(D,S,D)の2点先取、1チーム7,000円
//   ・個人戦シングルスは年代別7部門で「この内1種目のみ出場可」→ 種目を割らず区分にする
//   ・年齢は大会年度の翌4月1日現在で判定(第55回なら2027-04-01)
//   ・③〜⑦は下の年代にも出場できる → 上限は設けず下限だけ効かせる
//   ・参加料は支部が取りまとめて送金。個人・チームから直接送金しない
//     (既定の「当日受付でお支払い」は誤案内になるので大会ごとに案内文を持たせる)
process.env.DB_PATH = "/tmp/ktta_princess_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const db = require("../db");
const entryForm = require("../entry_form.js");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

function loadTemplates() {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "shared", "tournament-templates.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window;
}
const W = loadTemplates();
const tpl = () => Array.from(W.TT_TEMPLATES).find(t => t.id === "princess_hokkaido");
const built = (date) => W.TT_buildTournamentFromTemplate("princess_hokkaido", { date: date || "2026-09-26" });

// ── テンプレートの中身が要項どおりか ──────────────────────────────
test("大会の基本情報が要項どおり", () => {
  const t = tpl();
  assert.ok(t, "テンプレートが存在する");
  assert.strictEqual(t.organizer, "北海道卓球連盟", "主催は道連(KTTAではない)");
  assert.match(t.venue, /よつ葉アリーナ十勝/);
  assert.match(t.description, /釧路支部/, "KTTAの立場が書いてある");
  assert.match(t.eligibility, /成年女性/);
  assert.match(t.eligibility, /日学連登録者は不可/);
});

test("団体戦は監督+4〜7人・複単複・1チーム7,000円", () => {
  const ev = Array.from(tpl().events).find(e => e.type === "team");
  assert.ok(ev, "団体戦がある");
  assert.strictEqual(ev.fee, 7000, "1チーム7,000円");
  assert.strictEqual(ev.per_team_min, 4, "最少4人");
  assert.strictEqual(ev.per_team, 7, "最多7人");
  assert.strictEqual(ev.tie_format, "D,S,D", "複・単・複");
  assert.strictEqual(ev.gender, "female");
});

test("個人戦は1種目に7部門を持たせる(種目を割らない=1部門しか選べない)", () => {
  const evs = Array.from(tpl().events).filter(e => e.type === "singles");
  assert.strictEqual(evs.length, 1, "シングルスの種目は1つだけ(7つに割らない)");
  const cats = Array.from(evs[0].entry_categories);
  assert.strictEqual(cats.length, 7, "7部門");
  assert.deepStrictEqual(cats.map(c => c.short),
    ["ビギナー", "サーティ以下", "フォーティ", "フィフティ", "シックスティ", "セブンティ", "エイティ"]);
  assert.strictEqual(evs[0].fee, 2000, "1人2,000円");
});

test("年代の下限だけを効かせる(下の年代へ出場できるので上限は設けない)", () => {
  const ev = Array.from(tpl().events).find(e => e.type === "singles");
  const by = {};
  Array.from(ev.entry_categories).forEach(c => { by[c.value] = c; });
  assert.strictEqual(by.forty.min_age, 40);
  assert.strictEqual(by.fifty.min_age, 50);
  assert.strictEqual(by.sixty.min_age, 60);
  assert.strictEqual(by.seventy.min_age, 70);
  assert.strictEqual(by.eighty.min_age, 80);
  Array.from(ev.entry_categories).forEach(c => {
    assert.strictEqual(c.max_age, undefined, `${c.short} に上限を設けない(下の年代へ出場できるため)`);
  });
  assert.strictEqual(by.beginner.min_age, 18, "参加資格の満18歳以上");
  assert.strictEqual(by.under30.min_age, 18);
});

test("ビギナーの部には過去優勝者の除外が明記されている", () => {
  const ev = Array.from(tpl().events).find(e => e.type === "singles");
  const b = Array.from(ev.entry_categories).find(c => c.value === "beginner");
  assert.match(b.note, /優勝/, "過去優勝者は出場できない旨");
});

// ── 年齢の基準日が大会日付から解決されるか ────────────────────────
test("年齢の基準日は大会年度の翌4月1日になる", () => {
  const b = built("2026-09-26");
  const ev = Array.from(b._events).find(e => e.type === "singles");
  assert.strictEqual(ev.age_check.as_of, "2027-04-01", "第55回(2026年9月)なら2027-04-01");
});

test("1〜3月開催なら前年度扱いになる(年度の境目を間違えない)", () => {
  const b = built("2027-02-14");
  const ev = Array.from(b._events).find(e => e.type === "singles");
  assert.strictEqual(ev.age_check.as_of, "2027-04-01", "2027年2月は2026年度 → 2027-04-01");
});

test("日付を渡さなくても、テンプレの開催時期から基準日が決まる", () => {
  // 日付未指定でも reference_date(09-26)から今年/来年の日付が決まるので、基準日も決まる。
  // 「年度の翌4月1日」という形は保たれる。
  const b = W.TT_buildTournamentFromTemplate("princess_hokkaido", { date: "" });
  const ev = Array.from(b._events).find(e => e.type === "singles");
  assert.match(ev.age_check.as_of, /^\d{4}-04-01$/, "4月1日基準になる: " + ev.age_check.as_of);
  const y = parseInt(String(b.date).slice(0, 4), 10);
  assert.strictEqual(ev.age_check.as_of, (y + 1) + "-04-01", "開催年(9月)の翌年4月1日");
});

test("年齢判定を持たない種目には触れない", () => {
  const b = built("2026-09-26");
  const team = Array.from(b._events).find(e => e.type === "team");
  assert.strictEqual(team.age_check, undefined);
});

// ── 参加料の案内文 ────────────────────────────────────────────
test("参加料の案内文が「支部が取りまとめる」になっている", () => {
  const p = tpl().entry_preset;
  assert.match(p.payment_note, /取りまとめ/);
  assert.match(p.payment_note, /直接お振込み/, "個人から直接送金しない旨");
  assert.ok(!/当日.*受付でお支払い/.test(p.payment_note), "当日払いの既定文が残っていない");
});

test("案内文が大会に保存され、フォームに出る", () => {
  const t = db.createTournament({
    name: "北海道プリンセス卓球大会", date: "2026-09-26", venue: "よつ葉アリーナ十勝",
    event_config: [{ name: "個人戦 シングルス", type: "singles", fee: 2000 }],
    entry_preset: tpl().entry_preset,
  });
  assert.match(t.entry_payment_note, /取りまとめ/, "作成時にプリセットから保存される");
  const html = entryForm.buildEntryFormHTML(t, [{ name: "個人戦 シングルス", type: "singles", fee: 2000 }],
    { field_config: db.resolveFieldConfig(t), payment_note: t.entry_payment_note });
  assert.match(html, /取りまとめて主催団体へ送金/, "フォーム本文に出る");
  assert.ok(!/大会当日の開会式前に受付でお支払い/.test(html), "既定の当日払い文が出ない");
});

test("案内文は明示指定時のみ更新される(受付フラグだけの保存で消えない)", () => {
  const t = db.createTournament({
    name: "案内文の保持", date: "2026-09-26", venue: "会場",
    event_config: [{ name: "個人戦", type: "singles", fee: 2000 }],
    entry_preset: { payment_note: "支部で取りまとめます" },
  });
  db.updateEntrySettings(t.id, { entries_open: 1 });   // 案内文を渡さない
  assert.strictEqual(db.getTournament(t.id).entry_payment_note, "支部で取りまとめます", "消えない");
  db.updateEntrySettings(t.id, { entries_open: 1, entry_payment_note: "当日払いに変更" });
  assert.strictEqual(db.getTournament(t.id).entry_payment_note, "当日払いに変更", "明示指定で変わる");
});

test("案内文は他の大会からのコピーで引き継がれる", () => {
  const src = db.createTournament({
    name: "去年のプリンセス", date: "2025-09-27", venue: "会場",
    event_config: [{ name: "個人戦", type: "singles", fee: 2000 }],
    entry_preset: tpl().entry_preset,
  });
  const dst = db.createTournament({ name: "今年のプリンセス", date: "2026-09-26", venue: "会場" });
  const r = db.copyEntrySettings(dst.id, src.id, {});
  assert.ok(r.ok, r.error);
  assert.match(db.getTournament(dst.id).entry_payment_note, /取りまとめ/);
});

// ── 年齢の資格判定が実際に効くか ──────────────────────────────
test("年代の下限に満たない申込は断る", () => {
  const events = Array.from(built("2026-09-26")._events).map(e => JSON.parse(JSON.stringify(e)));
  const t = db.createTournament({
    name: "資格判定", date: "2026-09-26", venue: "会場",
    event_config: events, entries_open: true, entry_preset: tpl().entry_preset,
  });
  const submit = (division, birth) => db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "個人戦 シングルス", type: "singles", name: "甲野 花子", team: "釧路クラブ",
      division, furigana: "こうの はなこ", extra_json: { birth_date: birth } }],
  }, "op-p-" + Math.random().toString(36).slice(2), { enforce: true });

  // 2027-04-01 時点で 39歳(1988-01-01生) → フォーティ(40歳以上)には出られない
  assert.match(submit("forty", "1988-01-01").error || "", /フォーティ/,
    "下限に満たなければ断る");
  // 同じ人がサーティ以下には出られる
  assert.ok(!submit("under30", "1988-01-01").error, "若い区分には出られる");
  // 60歳(1960-01-01生)はシックスティにも、下の年代のフォーティにも出られる
  assert.ok(!submit("sixty", "1960-01-01").error, "該当年代に出られる");
  assert.ok(!submit("forty", "1960-01-01").error, "下の年代にも出られる(上限を設けていない)");
});

test("参加資格の満18歳未満は断る", () => {
  const events = Array.from(built("2026-09-26")._events).map(e => JSON.parse(JSON.stringify(e)));
  const t = db.createTournament({
    name: "18歳判定", date: "2026-09-26", venue: "会場",
    event_config: events, entries_open: true, entry_preset: tpl().entry_preset,
  });
  const r = db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "個人戦 シングルス", type: "singles", name: "乙川 花子", team: "釧路クラブ",
      division: "beginner", furigana: "おつかわ はなこ", extra_json: { birth_date: "2010-05-01" } }],
  }, "op-p18", { enforce: true });
  assert.match(r.error || "", /ビギナー/, "18歳未満は断る: " + (r.error || "(通ってしまった)"));
});

// ── 団体の人数制限 ──────────────────────────────────────────
test("団体戦は4人未満で断り、7人まで受ける", () => {
  const events = Array.from(built("2026-09-26")._events).map(e => JSON.parse(JSON.stringify(e)));
  const t = db.createTournament({
    name: "団体人数", date: "2026-09-26", venue: "会場",
    event_config: events, entries_open: true, entry_preset: tpl().entry_preset,
  });
  const submit = (members) => db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "団体戦", type: "team", team_name: "釧路A", members }],
  }, "op-t-" + Math.random().toString(36).slice(2), { enforce: true });

  assert.match(submit(["甲", "乙", "丙"]).error || "", /4人/, "3人は断る");
  assert.ok(!submit(["甲", "乙", "丙", "丁"]).error, "4人は通る");
  assert.ok(!submit(["甲", "乙", "丙", "丁", "戊", "己", "庚"]).error, "7人は通る");
});

// ── テンプレート全体の不変条件を壊していないこと ────────────────────
test("既存テンプレートの数と申込プリセットの網羅は保たれている", () => {
  const ids = Array.from(W.TT_TEMPLATES).map(t => t.id);
  assert.ok(ids.length >= 18, "プリンセスを足して18件以上");
  assert.ok(ids.includes("princess_hokkaido"));
  const missing = ids.filter((_, i) => !W.TT_TEMPLATES[i].entry_preset);
  assert.strictEqual(missing.length, 0, "プリセット未設定: " + missing.join(", "));
});

// ── 申込締切(支部内)の解決 ────────────────────────────────────
// 道連事務局への必着日より前に支部で締める必要がある(取りまとめの時間)。
// テンプレは月日だけを持ち、確定した大会日付から年を決める。
test("支部内の申込締切が大会日付と同じ年で入る", () => {
  const b = built("2026-09-26");
  assert.strictEqual(b.entry_deadline, "2026-08-25", "第55回は2026-08-25(道連必着8/28の前)");
  assert.ok(b.entry_deadline < b.date, "締切は開催日より前");
});

test("翌年の大会でも締切が追随する", () => {
  const b = built("2027-09-25");
  assert.strictEqual(b.entry_deadline, "2027-08-25");
});

test("締切の月日が開催日を過ぎる組み合わせでは前年に送る", () => {
  // 1月開催の大会に「8月25日締切」を当てると同年では締切が後になってしまう
  const W2 = loadTemplates();
  const orig = Array.from(W2.TT_TEMPLATES).find(t => t.id === "princess_hokkaido");
  const b = W2.TT_buildTournamentFromTemplate("princess_hokkaido", { date: "2027-01-10" });
  assert.strictEqual(b.entry_deadline, "2026-08-25", "前年の8/25になる(締切が開催日より後にならない)");
  assert.ok(orig, "テンプレは存在する");
});

test("締切の理由(道連必着日)が運用者に見える", () => {
  const b = built("2026-09-26");
  assert.match(b._deadline_note, /道連事務局への必着日より前/);
  assert.match(b._deadline_note, /8月28日/, "第55回の必着日が書いてある");
});

test("締切を持たないテンプレートは空のまま(既存の挙動を変えない)", () => {
  const b = W.TT_buildTournamentFromTemplate("chugaku_shinjin", { date: "2027-11-24" });
  assert.strictEqual(b.entry_deadline, "", "reference_deadline が無ければ空");
});
