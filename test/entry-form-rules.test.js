// 申込フォームの「項目の作り込み」(P2) 回帰テスト。
//  - sanitizeFieldConfig v2: 説明文(help)/入力制限(input/maxlen)/表示条件(when)の受け入れと無害化
//  - サーバ側検証(enforce): 表示条件の評価(非表示なら必須にしない+送り込まれた値を捨てる)、
//    文字数上限・数字のみ・電話番号・選択肢の実在チェック
//  - フォームHTML: maxlength/inputmode/説明文/data-wk 条件属性/ttWhenSync の出力
//  - 既存バグ修正: ふりがな必須のダブルス種目が「記入済みでも常にエラー」だった件
// 実行: node --test test/entry-form-rules.test.js
process.env.DB_PATH = "/tmp/ktta_formrules_" + process.pid + ".db";

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

// 検証用の大会: 宿泊チェック(申込単位)→宿泊日数(条件つき・数字のみ・必須) / 弁当個数(数字・上限2桁) /
// 学割区分(選択式) / 選手ごとのゼッケン(数字のみ・条件=申込単位の「レンタル希望」)
const FC = {
  version: 2,
  fields: { furigana: "required" },
  custom: [
    { key: "stay", label: "宿泊が必要", type: "checkbox", scope: "submission" },
    { key: "stay_nights", label: "宿泊日数", type: "text", input: "number", required: true,
      scope: "submission", when: { key: "stay" }, help: "泊数を半角数字で" },
    { key: "bento", label: "弁当個数", type: "text", input: "number", maxlen: 2, scope: "submission" },
    { key: "rank", label: "参加区分", type: "select", options: ["一般", "学生"], scope: "submission" },
    { key: "rental", label: "ラケットレンタル希望", type: "checkbox", scope: "submission" },
    { key: "racket_size", label: "レンタルサイズ", type: "text", scope: "player",
      when: { key: "rental" } , required: true },
  ],
  event_overrides: {},
};

function openTournament() {
  const t = db.createTournament({ name: "項目検証大会", date: "2027-10-10" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [
      { name: "男子シングルス", type: "singles", fee: 1000 },
      { name: "男子ダブルス", type: "doubles", fee: 1200 },
    ],
    field_config: FC,
  });
  return db.getTournament(t.id);
}

const BASE = {
  team_name: "検証クラブ", contact_name: "担当 太郎",
  contact_tel: "0154-00-0000", contact_email: "t@example.com",
};
const singles = (over) => ({
  event: "男子シングルス", type: "singles", name: "山田 太郎", team: "検証ク",
  furigana: "やまだ たろう", ...over,
});
const submit = (t, formData) =>
  db.createTeamEntry(t.id, { ...BASE, ...formData }, "op-" + Math.random().toString(36).slice(2), { enforce: true });

// ── sanitize ────────────────────────────────────────────────
test("sanitize: help/input/maxlen/when を受け入れ、壊れた指定は捨てる", () => {
  const s = db.sanitizeFieldConfig({
    version: 2, fields: {},
    custom: [
      { key: "a", label: "A", type: "text", input: "number", maxlen: 9999, help: "説明", scope: "submission" },
      { key: "b", label: "B", type: "text", input: "毒", scope: "submission", when: { key: "a", equals: "x" } },
      { key: "c", label: "C", type: "text", scope: "submission", when: { key: "zzz_missing" } },
      { key: "d", label: "D", type: "checkbox", scope: "submission", when: { key: "d" } },
    ],
  });
  const byKey = Object.fromEntries(s.custom.map(c => [c.key, c]));
  assert.strictEqual(byKey.a.input, "number");
  assert.strictEqual(byKey.a.maxlen, 300, "上限は300でクランプ");
  assert.strictEqual(byKey.a.help, "説明");
  assert.strictEqual(byKey.b.input, undefined, "未知のinput種別は捨てる");
  assert.deepStrictEqual(byKey.b.when, { key: "a", equals: "x" });
  assert.strictEqual(byKey.c.when, undefined, "実在しない参照先の条件は外す(=いつも表示)");
  assert.strictEqual(byKey.d.when, undefined, "自分自身を参照する条件は外す");
});

// ── サーバ側検証: 表示条件 ──────────────────────────────────
test("条件つき必須: 参照元が空なら必須にせず、送り込まれた値も捨てる", () => {
  const t = openTournament();
  const r = submit(t, {
    entries: [singles({})],
    extra: { stay_nights: "3" },   // 宿泊チェックなしで日数だけ送る(改造クライアント想定)
  });
  assert.ok(!r.error, "宿泊なしなら日数必須は発動しない: " + r.error);
  // スクラブ確認: enforce 後の formData から非表示項目の値が消えている
  const fd = { ...BASE, entries: [singles({})], extra: { stay_nights: "3" } };
  db.createTeamEntry(t.id, fd, "op-scrub-" + process.pid, { enforce: true });
  assert.ok(!("stay_nights" in fd.extra), "非表示中の値は記録前に捨てられる");
});

test("条件つき必須: 参照元が入力されたら必須が発動する", () => {
  const t = openTournament();
  const r = submit(t, {
    entries: [singles({})],
    extra: { stay: true },   // 宿泊ありなのに日数なし
  });
  assert.ok(r.error && r.validation, "必須エラーになること");
  assert.match(r.error, /宿泊日数/);
});

test("条件が満たされ値もあれば通る", () => {
  const t = openTournament();
  const r = submit(t, {
    entries: [singles({})],
    extra: { stay: true, stay_nights: "2" },
  });
  assert.ok(!r.error, "正しい入力は通る: " + r.error);
});

// ── サーバ側検証: 書式 ─────────────────────────────────────
test("数字のみ項目に数字以外はエラー", () => {
  const t = openTournament();
  const r = submit(t, {
    entries: [singles({})],
    extra: { stay: true, stay_nights: "三泊" },
  });
  assert.ok(r.error && /数字で入力/.test(r.error), "数字検証: " + r.error);
});

test("文字数上限を超えるとエラー", () => {
  const t = openTournament();
  const r = submit(t, {
    entries: [singles({})],
    extra: { bento: "100" },   // maxlen 2
  });
  assert.ok(r.error && /2文字以内/.test(r.error), "上限検証: " + r.error);
});

test("選択式に定義外の値はエラー", () => {
  const t = openTournament();
  const r = submit(t, {
    entries: [singles({})],
    extra: { rank: "無料枠" },
  });
  assert.ok(r.error && /選択肢が正しくありません/.test(r.error), "選択肢検証: " + r.error);
});

// ── 選手スコープの条件(参照元は申込単位) ─────────────────────
test("選手ごとの条件つき必須: 申込単位のチェックで発動する", () => {
  const t = openTournament();
  const ng = submit(t, {
    entries: [singles({ extra_json: { answers: {} } })],
    extra: { rental: true },
  });
  assert.ok(ng.error && /レンタルサイズ/.test(ng.error), "発動: " + ng.error);
  const ok = submit(t, {
    entries: [singles({ extra_json: { answers: { racket_size: "L" } } })],
    extra: { rental: true },
  });
  assert.ok(!ok.error, "入力済みなら通る: " + ok.error);
  const off = submit(t, {
    entries: [singles({ extra_json: { answers: {} } })],
    extra: {},
  });
  assert.ok(!off.error, "参照元が空なら要求しない: " + off.error);
});

// ── ダブルスのふりがな必須(既存バグ修正) ─────────────────────
test("ふりがな必須のダブルス: 記入済みなら通り、選手2欠落は選手2としてエラー", () => {
  const t = openTournament();
  const pair = (over) => ({
    event: "男子ダブルス", type: "doubles",
    name1: "甲野 一", name2: "乙川 二", team1: "A", team2: "B", ...over,
  });
  const ok = submit(t, { entries: [pair({ furigana1: "こうの はじめ", furigana2: "おつかわ じ" })] });
  assert.ok(!ok.error, "記入済みペアが通ること(修正前は常にエラー): " + ok.error);
  const ng = submit(t, { entries: [pair({ furigana1: "こうの はじめ" })] });
  assert.ok(ng.error && /選手2/.test(ng.error) && /ふりがな/.test(ng.error), "選手2の欠落を指摘: " + ng.error);
});

// ── フォームHTML ───────────────────────────────────────────
test("フォームHTML: 入力制限・説明文・条件属性・連動スクリプトが出力される", () => {
  const t = openTournament();
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(t) });
  assert.ok(html.includes('maxlength="2"'), "文字数上限がmaxlengthに");
  assert.ok(html.includes('inputmode="numeric"'), "数字のみがinputmodeに");
  assert.ok(html.includes("泊数を半角数字で"), "説明文が出る");
  assert.ok(html.includes('data-wk="stay"'), "表示条件が data-wk に");
  assert.ok(html.includes("function ttWhenSync"), "条件連動スクリプトが埋め込まれる");
  assert.ok(html.includes("fld-help"), "説明文のスタイルが定義される");
});

// ── 埋め込みJSのエスケープ健全性(テンプレートリテラルで \ が食われる事故の再発防止) ──
// 事故の内容: entry_form.js のクライアントJSはテンプレートリテラル内にあるため、\d と書くと
// テンプレート評価時にバックスラッシュが食われて /^(d{4})…/ (リテラルの文字d)になる。
// 生年月日が永遠にマッチせず「満N歳」ヒントが本番で一度も出ていなかった(2026-07-27 発見)。
test("年齢ヒント(ttAgeAt)の正規表現が生成後も壊れていない", () => {
  const t = openTournament();
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "シニア", type: "singles", fee: 0, age_check: { mode: "birthdate" } }],
    { field_config: db.resolveFieldConfig(t) });
  const src = html.match(/function ttAgeAt[\s\S]*?\n\}/);
  assert.ok(src, "ttAgeAt が埋め込まれていること");
  assert.ok(src[0].includes("\\d{4}") && src[0].includes("\\d{2}"),
    "数字クラス \\d が生成後も保たれていること: " + (src[0].match(/match\([^)]*\)/) || [""])[0]);
});

test("埋め込みJSにバックスラッシュ落ちの正規表現が無い", () => {
  const t = openTournament();
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(t) });
  // /^(d{4})/ のような「\ が食われた」パターンを機械的に検出する
  const broken = html.match(/\/\^?\([a-z]\{\d+\}\)/g);
  assert.strictEqual(broken, null, "壊れた正規表現が埋め込まれていない: " + JSON.stringify(broken));
});

// ── 未記入行の必須解除(送信ボタンが無反応になる事故の再発防止) ──────────
// 事故の内容: ふりがな等を必須にした大会では、使わなかった予備行や申し込まない種目の初期行の
// 必須欄がHTML5検証に引っかかり、送信を押しても何も起きない(閉じた種目の行はブラウザが
// フォーカスできずエラー表示すら出ない)。実測で 記入1行・送信対象1件でも invalid 5件だった。
test("未記入行の必須を外す仕組みがフォームに組み込まれている", () => {
  const t = openTournament();
  const html = entryForm.buildEntryFormHTML(t,
    [{ name: "男子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(t) });
  assert.ok(html.includes("function ttSyncRowRequired"), "必須同期関数が埋め込まれている");
  assert.ok(html.includes("function ttRowIsUsed"), "行の使用判定が埋め込まれている");
  assert.ok(html.includes("data-req-orig"), "本来必須だった欄を記録する印がある");
  // 入力・行追加・行削除の3経路すべてから同期が呼ばれること
  assert.ok(/addEventListener\("input", ttFormSync\)/.test(html), "入力時に同期");
  assert.ok(/addEventListener\("change", ttFormSync\)/.test(html), "変更時に同期");
  // 関数本体は「次の関数定義まで」で切り出す(最短マッチだと内側のブロックで切れる)
  const bodyOf = (name, next) => {
    const s = html.indexOf("function " + name), e = html.indexOf("function " + next);
    assert.ok(s >= 0 && e > s, name + " が見つかる");
    return html.slice(s, e);
  };
  assert.ok(bodyOf("addEntry", "removeEntry").includes("ttFormSync()"), "行追加時に同期");
  assert.ok(bodyOf("removeEntry", "rowDivision").includes("ttFormSync()"), "行削除時に同期");
});

// ── 列スキーマとの整合 ─────────────────────────────────────
test("条件つき項目も集計シートの列になる(未回答は空欄で埋まるだけ)", () => {
  const t = openTournament();
  const s = db.buildFormSchema(t);
  const keys = s.columns.ledger.map(c => c.key);
  assert.ok(keys.includes("cust:stay_nights"), "条件つき項目の列が作られる: " + JSON.stringify(keys));
});
