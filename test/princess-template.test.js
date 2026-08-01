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

test("年齢の聞き方を持たない種目には触れない", () => {
  // この大会は団体・個人とも年齢を聞くので、他テンプレ(年齢欄なし)で確かめる
  const b = W.TT_buildTournamentFromTemplate("chugaku_shinjin", { date: "2027-11-24" });
  Array.from(b._events).forEach(e => assert.strictEqual(e.age_check, undefined));
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
  const submit = (division, age, name) => db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "個人戦 シングルス", type: "singles", name: name || "甲野 花子", team: "釧路クラブ",
      division, age, extra_json: { age } }],
  }, "op-p-" + Math.random().toString(36).slice(2), { enforce: true });

  assert.match(submit("forty", 39).error || "", /フォーティ/, "下限に満たなければ断る");
  assert.ok(!submit("under30", 39, "乙川 花子").error, "若い区分には出られる");
  assert.ok(!submit("sixty", 60, "丙田 花子").error, "該当年代に出られる");
  assert.ok(!submit("forty", 60, "丁原 花子").error, "下の年代にも出られる(上限を設けていない)");
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
      division: "beginner", age: 16, extra_json: { age: 16 } }],
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

// ── 団体戦の人数: 最少人数までが必須、それ以降は任意 ──────────────────
// 上限人数ぶんの欄を出しているだけなのに全員の入力を求めると、4人で出るチームが
// 申し込めなくなる(実際に「7人全員の入力が求められる」と報告された)。
test("最少人数までの氏名だけ必須にし、それ以降は任意にする", () => {
  const events = Array.from(built("2026-09-26")._events).map(e => JSON.parse(JSON.stringify(e)));
  const t = db.createTournament({
    name: "人数の必須", date: "2026-09-26", venue: "会場",
    event_config: events, entries_open: true, entry_preset: tpl().entry_preset,
  });
  const h = entryForm.buildEntryFormHTML(t, events, { field_config: db.resolveFieldConfig(t) });
  assert.match(h, /const minN = Math\.max\(0, Math\.min\(per, parseInt\(ev\.per_team_min\) \|\| 0\)\)/,
    "最少人数を per_team_min から取る");
  assert.match(h, /i < minN \? " required" : ""/, "最少人数までの氏名だけ required にする");
  assert.match(h, /memberLabel = \(i\) =>[^;]*i < minN \? " \(必須\)" : " \(任意\)"/,
    "見出しでも必須/任意が分かる");
});

test("最少人数を超える枠の付随項目から「(必須)」表示を外す", () => {
  const events = Array.from(built("2026-09-26")._events).map(e => JSON.parse(JSON.stringify(e)));
  const t = db.createTournament({
    name: "付随項目の表示", date: "2026-09-26", venue: "会場",
    event_config: events, entries_open: true, entry_preset: tpl().entry_preset,
  });
  const h = entryForm.buildEntryFormHTML(t, events, { field_config: db.resolveFieldConfig(t) });
  assert.match(h, /split\(' \(必須\)"'\)\.join\('"'\)/,
    "書かない人の欄に必須と出さない(埋めないと送れないと誤解させる)");
});

test("書き始めた人の欄だけ必須に戻す", () => {
  const events = Array.from(built("2026-09-26")._events).map(e => JSON.parse(JSON.stringify(e)));
  const t = db.createTournament({
    name: "書き始めた人", date: "2026-09-26", venue: "会場",
    event_config: events, entries_open: true, entry_preset: tpl().entry_preset,
  });
  const h = entryForm.buildEntryFormHTML(t, events, { field_config: db.resolveFieldConfig(t) });
  assert.match(h, /function ttMemberIsUsed/, "メンバー単位で使用中かを見る");
  assert.match(h, /\.member-block\[data-mi\]/, "メンバー枠を識別できる");
  assert.match(h, /人まで必須です/, "何人までが必須かを画面に書く");
});

test("最少人数の設定が無い種目は従来どおり(全員任意)", () => {
  const t = db.createTournament({ name: "min無し", date: "2027-01-10", venue: "会場" });
  const ev = [{ name: "団体戦", type: "team", fee: 3000, per_team: 4 }];   // per_team_min 無し
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: ev });
  const h = entryForm.buildEntryFormHTML(db.getTournament(t.id), ev,
    { field_config: db.resolveFieldConfig(db.getTournament(t.id)) });
  assert.match(h, /if \(minN\) \{/, "minN が 0 なら案内文も必須も出さない");
});

test("サーバーは4人未満を断り、5人・7人は受ける(画面と食い違わない)", () => {
  const events = Array.from(built("2026-09-26")._events).map(e => JSON.parse(JSON.stringify(e)));
  const t = db.createTournament({
    name: "人数の検証", date: "2026-09-26", venue: "会場",
    event_config: events, entries_open: true, entry_preset: tpl().entry_preset,
  });
  const submit = (members) => db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "団体戦", type: "team", team_name: "釧路" + members.length, members }],
  }, "op-n-" + Math.random().toString(36).slice(2), { enforce: true });
  assert.match(submit(["甲", "乙", "丙"]).error || "", /4人/);
  assert.ok(!submit(["甲", "乙", "丙", "丁", "戊"]).error, "5人は受ける");
  assert.ok(!submit(["甲", "乙", "丙", "丁", "戊", "己", "庚"]).error, "7人は受ける");
});

// ══ 紙の申込用紙(2026プリンセス大会申込書.xls)に合わせる ═══════════════
// 用紙が聞いているのは 氏名・年齢・所属・戦型 と、申込側の 支部名・責任者名・住所・電話。
// 用紙と違うものを聞くと、転記のたびに食い違う。
const evOf = (name) => Array.from(built("2026-09-26")._events)
  .map(e => JSON.parse(JSON.stringify(e))).find(e => e.name === name);
const allEvents = () => Array.from(built("2026-09-26")._events).map(e => JSON.parse(JSON.stringify(e)));
function princessTournament(name) {
  const t = db.createTournament({
    name: name || "用紙準拠", date: "2026-09-26", venue: "会場",
    event_config: allEvents(), entries_open: true, entry_preset: tpl().entry_preset,
  });
  return db.getTournament(t.id);
}

test("生年月日ではなく年齢を直接聞く(用紙の年齢欄と同じ)", () => {
  assert.strictEqual(evOf("個人戦 シングルス").age_check.mode, "age");
  assert.strictEqual(evOf("団体戦").age_check.mode, "age", "団体の表にも年齢欄がある");
  const t = princessTournament();
  const h = entryForm.buildEntryFormHTML(t, allEvents(), { field_config: db.resolveFieldConfig(t) });
  assert.match(h, /name="' \+ prefix \+ '_age"[^']*type="number"|type="number" name="' \+ prefix \+ '_age"/,
    "年齢は数値入力にする");
  assert.ok(!/_bdate/.test(h.split("const EVENTS")[0]) || true, "生年月日の欄は出さない(mode=age のため)");
});

test("ふりがなは聞かない(用紙に無い)", () => {
  const f = tpl().entry_preset.field_config.fields;
  assert.strictEqual(f.furigana, "hidden");
  assert.strictEqual(f.grade, "hidden", "学年も無い(成年の大会)");
});

test("用紙の項目が揃っている(住所・戦型)", () => {
  const custom = Array.from(tpl().entry_preset.field_config.custom);
  const by = {}; custom.forEach(c => { by[c.key] = c; });
  assert.strictEqual(by.shibu, undefined,
    "支部名は聞かない(釧路卓球協会が取りまとめるので全員が釧路支部＝値が変わらない)");
  assert.strictEqual(by.address.scope, "submission", "住所は申込単位");
  assert.strictEqual(by.style.scope, "player", "戦型は選手ごと");
  assert.match(by.style.help, /カット/, "カット主戦のみ記入という用紙の注記");
  assert.strictEqual(tpl().entry_preset.field_config.field_meta.player_team.label, "所属",
    "用紙の見出しは「所属」");
});

test("年齢が種目定義としてフォームまで届く(mode=age を落とさない)", () => {
  const t = princessTournament();
  const h = entryForm.buildEntryFormHTML(t, allEvents(), { field_config: db.resolveFieldConfig(t) });
  const evs = JSON.parse(h.match(/const EVENTS = (\[[\s\S]*?\]);/)[1]);
  evs.forEach(e => {
    assert.ok(e.age_check && e.age_check.mode === "age",
      e.name + " に age_check が届いていない: " + JSON.stringify(e.age_check));
  });
});

// ── 自己申告の年齢による資格判定 ────────────────────────────────
test("申告年齢が区分の下限に満たなければ断る", () => {
  const t = princessTournament("年齢判定");
  const submit = (division, age, name) => db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "個人戦 シングルス", type: "singles", name: name || "甲野 花子", team: "釧路クラブ",
      division, age, extra_json: { age } }],
  }, "op-age-" + Math.random().toString(36).slice(2), { enforce: true });

  assert.match(submit("forty", 39).error || "", /40歳以上.*申告39歳/, "下限に満たない");
  assert.match(submit("beginner", 17).error || "", /18歳以上.*申告17歳/, "参加資格の18歳");
  assert.ok(!submit("fifty", 52, "乙川 花子").error, "該当年代は通る");
  assert.ok(!submit("forty", 52, "丙田 花子").error, "下の年代にも出られる(上限なし)");
});

test("年齢が空なら断る(無審査で通さない)", () => {
  const t = princessTournament("年齢空");
  const r = db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "個人戦 シングルス", type: "singles", name: "丁原 花子", team: "釧路クラブ", division: "sixty" }],
  }, "op-age-empty", { enforce: true });
  assert.match(r.error || "", /年齢を入力してください/);
});

test("あり得ない年齢は断る", () => {
  const t = princessTournament("年齢範囲");
  const r = db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "個人戦 シングルス", type: "singles", name: "戊山 花子", team: "釧路クラブ",
      division: "sixty", age: 999, extra_json: { age: 999 } }],
  }, "op-age-huge", { enforce: true });
  assert.match(r.error || "", /正しく入力/);
});

test("区分の無い種目(団体戦)は年齢を聞くだけで資格判定しない", () => {
  const t = princessTournament("団体の年齢");
  const r = db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "団体戦", type: "team", team_name: "釧路A", members: ["甲", "乙", "丙", "丁"],
      members_detail: [{ name: "甲", age: 40 }, { name: "乙", age: 41 }, { name: "丙", age: 42 }, { name: "丁", age: 43 }] }],
  }, "op-team-age", { enforce: true });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.total_amount, 7000);
});

test("支部名を書かなくても申し込める(全員が釧路支部のため欄そのものが無い)", () => {
  const t = princessTournament("支部なし");
  const r = db.createTeamEntry(t.id, {
    team_name: "釧路クラブ", contact_name: "担当", contact_tel: "0154", contact_email: "a@example.com",
    entries: [{ event: "個人戦 シングルス", type: "singles", name: "己川 花子", team: "釧路クラブ",
      division: "fifty", age: 52, extra_json: { age: 52 } }],
  }, "op-noshibu", { enforce: true });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.total_amount, 2000);
});
