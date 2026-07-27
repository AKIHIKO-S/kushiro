// 有料オプション(P4): 弁当・懇親会などの回帰テスト。
//  - 単価・上限は大会の定義だけを使い、クライアントが送る金額は一切見ない
//  - 受付時に1回だけ権威計算し、確定明細を entry_submissions.options_json に保存する
//    (メール・帳票・シートはこの明細を読むだけ。同じ計算を何箇所にも書かない)
//  - 合計 = 参加料 + オプション。フォーム表示とサーバ確定値が一致すること
// 実行: node --test test/entry-options.test.js
process.env.DB_PATH = "/tmp/ktta_options_" + process.pid + ".db";

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

const OPTIONS = [
  { key: "bento", label: "お弁当", price: 800, unit: "個", max: 20, note: "当日受付でお支払い" },
  { key: "party", label: "懇親会", price: 3500, unit: "名", max: 0 },
];

function mkTournament(extra) {
  const t = db.createTournament({ name: "オプション検証", date: "2027-05-05" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [{ name: "男子シングルス", type: "singles", fee: 1500 }],
    entry_options: OPTIONS,
    ...extra,
  });
  return db.getTournament(t.id);
}
const submit = (t, options, entries) => db.createTeamEntry(t.id, {
  team_name: "検証クラブ", contact_name: "担当 太郎",
  contact_tel: "0154-00-0000", contact_email: "t@example.com",
  options,
  entries: entries || [{ event: "男子シングルス", type: "singles", name: "山田 太郎", team: "検証ク" }],
}, "op-" + Math.random().toString(36).slice(2), { enforce: true });

// ── 定義の無害化 ────────────────────────────────────────────
test("オプション定義を無害化して保存する", () => {
  const cleaned = db.sanitizeEntryOptions([
    { key: "ok", label: "正常", price: "800", unit: "個", max: "5" },
    { key: "不正なキー", label: "捨てられる", price: 100 },
    { key: "ok", label: "重複キーは捨てる", price: 100 },
    { key: "neg", label: "負の単価", price: -500, max: -3 },
    "文字列", null,
  ]);
  assert.deepStrictEqual(cleaned.map(o => o.key), ["ok", "neg"]);
  assert.strictEqual(cleaned[0].price, 800, "数値化される");
  assert.strictEqual(cleaned[0].max, 5);
  assert.strictEqual(cleaned[1].price, 0, "負の単価は0に丸める");
  assert.strictEqual(cleaned[1].max, 0);
});

test("大会に保存され、読み出せる", () => {
  const t = mkTournament();
  const opts = db.resolveEntryOptions(t);
  assert.deepStrictEqual(opts.map(o => o.key), ["bento", "party"]);
  assert.strictEqual(opts[0].price, 800);
});

// ── 権威計算 ────────────────────────────────────────────────
test("数量から金額を計算する(単価は定義側の値だけを使う)", () => {
  const t = mkTournament();
  const p = db.priceEntryOptions(t, { bento: 3, party: 2 });
  assert.strictEqual(p.total, 800 * 3 + 3500 * 2);
  assert.deepStrictEqual(p.items.map(i => [i.key, i.qty, i.amount]),
    [["bento", 3, 2400], ["party", 2, 7000]]);
});

test("0や未指定のオプションは明細に載らない", () => {
  const t = mkTournament();
  const p = db.priceEntryOptions(t, { bento: 0 });
  assert.deepStrictEqual(p.items, []);
  assert.strictEqual(p.total, 0);
});

test("上限を超える数量は申込ごと拒否する", () => {
  const t = mkTournament();
  const p = db.priceEntryOptions(t, { bento: 21 });   // max 20
  assert.ok(p.error && /20個までです/.test(p.error), "上限エラー: " + p.error);
  const r = submit(t, { bento: 21 });
  assert.ok(r.error && r.validation, "申込も拒否される: " + r.error);
});

test("定義に無いキーを送っても無視される(勝手な項目を作れない)", () => {
  const t = mkTournament();
  const p = db.priceEntryOptions(t, { bento: 1, kickback: 999 });
  assert.deepStrictEqual(p.items.map(i => i.key), ["bento"]);
  assert.strictEqual(p.total, 800);
});

// ── 合計への反映 ────────────────────────────────────────────
test("合計 = 参加料 + オプション", () => {
  const t = mkTournament();
  const r = submit(t, { bento: 2 });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.total_amount, 1500 + 800 * 2, "参加料1500 + 弁当2個");
  assert.strictEqual(r.options_total, 1600);
  assert.deepStrictEqual(r.options.map(o => [o.label, o.qty, o.amount]), [["お弁当", 2, 1600]]);
});

test("オプションなしの申込は従来どおり参加料のみ", () => {
  const t = mkTournament();
  const r = submit(t);
  assert.strictEqual(r.total_amount, 1500);
  assert.deepStrictEqual(r.options, []);
});

test("オプションを定義していない大会では何も起きない", () => {
  const t = db.createTournament({ name: "オプション無し", date: "2027-05-05" });
  db.updateEntrySettings(t.id, { entries_open: 1,
    event_config: [{ name: "男子シングルス", type: "singles", fee: 1000 }] });
  const tt = db.getTournament(t.id);
  assert.deepStrictEqual(db.resolveEntryOptions(tt), []);
  const r = db.createTeamEntry(tt.id, {
    team_name: "T", contact_name: "担", contact_tel: "1", contact_email: "a@b.c",
    options: { bento: 5 },   // 定義が無いので効かない
    entries: [{ event: "男子シングルス", type: "singles", name: "甲 一", team: "T" }],
  }, "op-none", { enforce: true });
  assert.strictEqual(r.total_amount, 1000, "オプション分は加算されない");
});

// ── 保存 ────────────────────────────────────────────────────
test("確定明細が申込原本に保存され、申込者の確認ページにも出る", () => {
  const t = mkTournament();
  const r = submit(t, { bento: 1, party: 1 });
  const view = db.getSubmissionByToken(r.applicant_token);
  assert.ok(view && view.ok, "申込番号で引ける");
  assert.deepStrictEqual(view.options.map(o => [o.key, o.qty, o.amount]),
    [["bento", 1, 800], ["party", 1, 3500]], "オプション明細が見える");
  assert.strictEqual(view.total_amount, 1500 + 800 + 3500, "合計に含まれる");
});

// ── フォーム表示 ────────────────────────────────────────────
test("フォームにオプション欄が出て、定義がそのまま埋め込まれる", () => {
  const t = mkTournament();
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1500 }],
    { field_config: db.resolveFieldConfig(t), entry_options: db.resolveEntryOptions(t) });
  assert.ok(html.includes("オプション"), "見出しが出る");
  assert.ok(html.includes("お弁当"), "項目名が出る");
  assert.ok(html.includes('name="opt_bento"'), "数量欄が出る");
  assert.ok(html.includes("当日受付でお支払い"), "補足が出る");
  assert.ok(html.includes('max="20"'), "上限が入力欄に反映される");
  const embedded = JSON.parse(html.match(/const ENTRY_OPTIONS = (\[[\s\S]*?\]);/)[1]);
  assert.deepStrictEqual(embedded.map(o => o.key), ["bento", "party"]);
  assert.strictEqual(embedded[0].price, 800, "単価が渡る(表示用)");
});

test("オプション未定義ならフォームに欄を出さない", () => {
  const t = mkTournament();
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1500 }],
    { field_config: db.resolveFieldConfig(t) });   // entry_options を渡さない
  assert.ok(!html.includes('name="opt_bento"'), "数量欄は出ない");
  const embedded = JSON.parse(html.match(/const ENTRY_OPTIONS = (\[[\s\S]*?\]);/)[1]);
  assert.deepStrictEqual(embedded, []);
});

test("フォームの合計計算にオプションが含まれる配線がある", () => {
  const t = mkTournament();
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1500 }],
    { field_config: db.resolveFieldConfig(t), entry_options: db.resolveEntryOptions(t) });
  assert.ok(html.includes("function optionsTotal"), "小計関数がある");
  assert.ok(html.includes("total += optionsTotal();"), "合計に加算される");
  assert.ok(html.includes("function gatherOptions"), "送信データに数量を載せる関数がある");
  assert.ok(html.includes("data.options = optQty"), "送信データへの配線がある");
});
