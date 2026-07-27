// 申込フォームの承認デザイン(見本案2「道しるべ」・2026-07-27 オーナー承認)の回帰。
//  ・トンマナ … サイト正典の白磁(温白#fbfaf7 / 墨罫#211d18 / 丹頂は機能色 / 全面ゴシック)
//  ・道しるべ … 行程レール(連絡先・種目選手・確認事項・送信)と「必須があとN項目」
//  ・埋込(iframe自動高さ)ではページがスクロールしないため sticky/fixed が効かない。
//    その環境では貼り付けをやめ、残数を送信ボタンの手前に置く(実機で確認済み)。
//  ・学年 … 学生の種目は設定どおり / 一般の部は任意(一般に学生が出場する場合に記入)
//    / シニア・ラージの年代別は出さない
// 実行: node --test test/entry-form-rail.test.js
process.env.DB_PATH = "/tmp/ktta_rail_" + process.pid + ".db";

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
  { name: "一般男子シングルス", type: "singles", fee: 1500, category: "general" },
  { name: "中学男子シングルス", type: "singles", fee: 500, category: "middle" },
  { name: "PMシニア 男子シングルス", type: "singles", fee: 700, category: "senior" },
  { name: "混合ダブルス 120才代", type: "doubles", fee: 2000, category: "large" },
];
function mk(fieldCfg, extra) {
  const t = db.createTournament({ name: "デザイン回帰", date: "2027-09-13", venue: "会場" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: EVENTS, field_config: fieldCfg, ...extra });
  return db.getTournament(t.id);
}
const html = (t) => entryForm.buildEntryFormHTML(t, EVENTS, { field_config: db.resolveFieldConfig(t) });

// ── トンマナ ────────────────────────────────────────────────
test("承認トンマナ(白磁×墨罫×ゴシック)が適用されている", () => {
  const h = html(mk({ version: 2, fields: {}, custom: [], event_overrides: {} }));
  assert.match(h, /--paper:\s*#fbfaf7/, "地は温白");
  assert.match(h, /border-bottom:\s*2\.5px solid #211d18/, "マストヘッドは墨の太罫");
  assert.match(h, /\.form-section h2\s*\{[^}]*font-family:\s*var\(--gothic\)/, "見出しはゴシック");
  assert.match(h, /\.form-section h2::before\s*\{\s*display:\s*none/, "左の赤バー(左縁アクセント)は廃止");
  assert.match(h, /\.total-box \.amount\s*\{[^}]*color:\s*var\(--ink\)/, "金額は墨(丹頂を装飾に使わない)");
});

test("承認前の装飾(明朝見出し・紙の粒状感)が残っていない", () => {
  const h = html(mk({ version: 2, fields: {}, custom: [], event_overrides: {} }));
  assert.match(h, /body::before\s*\{\s*display:\s*none/, "粒状感オーバーレイを止めている");
  // 合計の見出し・金額がゴシックに上書きされている(明朝の定義自体は上部に残るが後勝ちで無効)
  assert.match(h, /\.total-box \.label\s*\{[^}]*font-family:\s*var\(--gothic\)/);
});

// ── 道しるべ ────────────────────────────────────────────────
test("行程レールと残り必須の仕組みが埋め込まれている", () => {
  const h = html(mk({ version: 2, fields: {}, custom: [], event_overrides: {} }));
  assert.match(h, /function ttBuildRail/, "レールを組み立てる関数");
  assert.match(h, /function ttRailUpdate/, "残数を更新する関数");
  assert.match(h, /id="ttRail"|ttRail/, "レールのID");
  assert.match(h, /IntersectionObserver/, "現在地の追従はIntersectionObserver(scrollイベントを使わない)");
  assert.ok(!/addEventListener\(["']scroll["']/.test(h), "scrollイベントを使っていない");
});

test("出場種目は件数で判定する(未選択が『任意』に見えない)", () => {
  const h = html(mk({ version: 2, fields: {}, custom: [], event_overrides: {} }));
  assert.match(h, /未選択/, "1種目も選んでいなければ未選択と出す");
  assert.match(h, /出場種目を選んでください/, "残数チップの案内");
});

test("埋込ではsticky/fixedをやめる分岐がある", () => {
  const h = html(mk({ version: 2, fields: {}, custom: [], event_overrides: {} }));
  assert.match(h, /tt-embedded/, "埋込判定のクラス");
  assert.match(h, /body\.tt-embedded #ttRail\s*\{\s*position:\s*static/, "レールの貼り付けを解除");
  assert.match(h, /body\.tt-embedded #ttRemain\s*\{[^}]*position:\s*static/, "残数の固定を解除");
  assert.match(h, /window\.self !== window\.top/, "iframe内かどうかで判定");
});

test("動きの規範を守っている(reduced-motion対応・200ms以内)", () => {
  const h = html(mk({ version: 2, fields: {}, custom: [], event_overrides: {} }));
  assert.match(h, /prefers-reduced-motion/, "動きを減らす設定に対応");
  assert.match(h, /transition:\s*transform \.18s ease-out/, "現在地の下線は180ms ease-out");
});

// ── 学年の出し分け ──────────────────────────────────────────
test("学年は学生の種目では設定どおり、一般では任意、シニア・ラージでは出さない", () => {
  const t = mk({ version: 2, fields: { grade: "required" }, custom: [], event_overrides: {} });
  const submit = (ev, type) => db.createTeamEntry(t.id, {
    team_name: "T", contact_name: "担", contact_tel: "1", contact_email: "a@example.com",
    entries: [type === "doubles"
      ? { event: ev, type: "doubles", name1: "甲", name2: "乙", team1: "T", team2: "T", extra_json: { players: [{}, {}] } }
      : { event: ev, type: "singles", name: "甲 一", team: "T", extra_json: {} }],
  }, "op-" + Math.random().toString(36).slice(2), { enforce: true });

  assert.match(submit("中学男子シングルス").error || "", /学年を入力/, "学生の種目は必須のまま");
  assert.ok(!submit("一般男子シングルス").error, "一般の部は学年なしでも通る(任意)");
  assert.ok(!submit("PMシニア 男子シングルス").error, "シニアは学年を聞かない");
  assert.ok(!submit("混合ダブルス 120才代", "doubles").error, "ラージの年代別も聞かない");
});

test("種目ごとの明示指定があれば、学年の既定より優先される", () => {
  const t = mk({
    version: 2, fields: { grade: "hidden" }, custom: [],
    event_overrides: { "一般男子シングルス": { grade: "required" } },
  });
  const r = db.createTeamEntry(t.id, {
    team_name: "T", contact_name: "担", contact_tel: "1", contact_email: "a@example.com",
    entries: [{ event: "一般男子シングルス", type: "singles", name: "甲 一", team: "T", extra_json: {} }],
  }, "op-ov", { enforce: true });
  assert.match(r.error || "", /学年を入力/, "主催者の明示指定が最優先");
});

test("種目のcategoryがフォームに渡る(学年の出し分けに使う)", () => {
  const h = html(mk({ version: 2, fields: {}, custom: [], event_overrides: {} }));
  const evs = JSON.parse(h.match(/const EVENTS = (\[[\s\S]*?\]);/)[1]);
  assert.deepStrictEqual(evs.map(e => e.category), ["general", "middle", "senior", "large"]);
  assert.match(h, /function gradeStateFor/, "出し分けの関数が埋め込まれている");
});
