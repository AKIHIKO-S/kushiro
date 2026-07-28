// 申込フォームの実機レビュー(2026-07-29)で出た指摘の回帰。
//  1. 残数の数字が実際と合わない … 未入力の欄は4つなのに「必須があと5項目」と出ていた
//     (種目未選択を「項目」として足していたため。5つ目の欄を探させてしまう)
//  2. 種目が多い大会で全種目が最初から開き、ページが十数画面ぶんに膨らむ
//  3. カード左縁の色付きアクセント線(KTTAでは上端帯に統一する規範に反する)
//  4. 締切だけISO表記(開催日は和文なのに「締切 2027-02-01」)
//  5. 削除ボタンのタップ領域が44px未満(押し間違えると入力済みの選手が消える)
//  6〜8. 助数詞「0 選手」・「5選手を一括追加」・学年欄の用途不明
// 実行: node --test test/entry-form-review-fixes.test.js
process.env.DB_PATH = "/tmp/ktta_review_" + process.pid + ".db";

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

const mk = (events, extra) => {
  const t = db.createTournament({ name: "レビュー回帰", date: "2027-02-14", venue: "会場" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: events, ...extra });
  return db.getTournament(t.id);
};
const html = (t, events, opts) =>
  entryForm.buildEntryFormHTML(t, events, { field_config: db.resolveFieldConfig(t), ...(opts || {}) });

const EV5 = [
  { name: "男子シングルス 一般", type: "singles", fee: 700, category: "general" },
  { name: "女子シングルス 一般", type: "singles", fee: 700, category: "general" },
  { name: "男子ダブルス", type: "doubles", fee: 1000, category: "general" },
  { name: "混合ダブルス", type: "doubles", fee: 1000, category: "general" },
  { name: "一般 団体戦", type: "team", fee: 3000, category: "general", per_team: 4, per_team_min: 4 },
];
const EV3 = EV5.slice(0, 3);

// ── 1. 残数の数字 ───────────────────────────────────────────
test("残数は入力欄の数と種目の選択を分けて言う(数を水増ししない)", () => {
  const h = html(mk(EV5), EV5);
  // 種目未選択を left に足し込んでいないこと
  assert.ok(!/left \+= 1;/.test(h), "種目未選択を必須欄の数に足していない");
  assert.match(h, /needEvent/, "種目の選択は別の条件として持つ");
  assert.match(h, /必須があと" \+ left \+ "項目 ・ 出場種目 未選択/,
    "欄が残っていて種目も未選択なら、両方を分けて言う");
  assert.match(h, /出場種目を選んでください/, "欄が全部埋まっていれば種目の選択だけを促す");
});

test("送信できる条件は「欄が全部埋まっている」かつ「種目を選んでいる」", () => {
  const h = html(mk(EV5), EV5);
  assert.match(h, /var ready = left === 0 && !needEvent;/);
  assert.match(h, /ready \? "送信できます"/);
});

// ── 2. 種目の折りたたみ ─────────────────────────────────────
test("種目が4つ以上ある大会は既定でたたむ", () => {
  const h = html(mk(EV5), EV5);
  assert.match(h, /det\.open = EVENTS\.length <= 3;/, "3種目までは開く、4種目以上はたたむ");
  assert.ok(!/det\.open = true;/.test(h), "無条件で開く実装が残っていない");
});

test("たたむ大会には「開いて記入する」案内を出す", () => {
  const h5 = html(mk(EV5), EV5);
  assert.match(h5, /出場する種目をタップして開き/, "4種目以上では案内を出す");
  assert.match(h5, /出ない種目はそのままで構いません/, "全部埋める必要が無いと明示する");
  const h3 = html(mk(EV3), EV3);
  assert.ok(!/出場する種目をタップして開き/.test(h3), "3種目以下では案内を出さない(全部開くため)");
});

// ── 3. 左縁アクセント線 ─────────────────────────────────────
test("選手カードの区別は上端帯で作る(左縁の色付き線を使わない)", () => {
  const h = html(mk(EV5), EV5);
  assert.ok(!/\.entry-row\s*\{[^}]*border-left:\s*4px/.test(h), "左縁の太線が無い");
  assert.ok(!/\.entry-row:hover\s*\{[^}]*border-left-color/.test(h), "ホバーで左縁が赤くならない");
  assert.match(h, /\.entry-row\s*\{[^}]*border-top:\s*3px solid/, "上端帯で区別する");
});

test("丹頂赤を装飾に使っていない(ホバーは墨)", () => {
  const h = html(mk(EV5), EV5);
  assert.match(h, /\.entry-row:hover\s*\{\s*border-top-color:\s*#211d18/, "ホバーの色は墨");
});

// ── 4. 締切の表記 ──────────────────────────────────────────
test("締切は開催日と同じ和文表記にする", () => {
  const t = mk(EV3, { entry_deadline: "2027-02-01" });
  const h = html(t, EV3, { deadline: "2027-02-01 17:00" });
  assert.match(h, /締切 2027年2月1日\(月\) 17:00/, "日付は和文・時刻はそのまま");
  assert.ok(!/締切 2027-02-01/.test(h), "ISO表記が残っていない");
});

test("日付でない締切(「未定」等)はそのまま出す", () => {
  const t = mk(EV3);
  const h = html(t, EV3, { deadline: "別途連絡" });
  assert.match(h, /締切 別途連絡/);
});

test("締切が空なら締切の表示自体を出さない", () => {
  const h = html(mk(EV3), EV3, { deadline: "" });
  assert.ok(!/締切 /.test(h.split("</header>")[0] || h.slice(0, 4000)), "見出し部に締切が出ない");
});

// ── 5. タップ領域 ──────────────────────────────────────────
test("削除ボタンは指で押せる大きさを確保する", () => {
  const h = html(mk(EV5), EV5);
  assert.match(h, /\.btn-del\s*\{[^}]*min-height:\s*44px/, "高さ44px以上");
  assert.match(h, /\.btn-del\s*\{[^}]*min-width:\s*56px/);
});

// ── 6〜8. 文言 ────────────────────────────────────────────
test("件数は0のとき出さず、1件以上で日本語の助数詞にする", () => {
  // 種目カードはブラウザ側で組み立てられるので、生成後HTMLには「実行結果」ではなく
  // 「組み立てるコード」が入っている。ここでは助数詞の決め方そのものを検査する。
  const h = html(mk(EV5), EV5);
  assert.ok(!/>0 選手</.test(h), "「0 選手」を初期表示しない");
  assert.match(h, /badge\.hidden = filled === 0;/, "0件はバッジごと隠す");
  assert.match(h, /countUnit = isTeam \? "チーム" : \(isDoubles \? "組" : "名"\)/,
    "個人戦=名 / ダブルス=組 / 団体=チーム");
  assert.match(h, /data-unit="' \+ countUnit \+ '"/, "助数詞をバッジに持たせる");
  assert.match(h, /filled === 0 \? "" : filled \+ unit/, "0件は空、1件以上で助数詞つき");
});

test("一括追加の文言を平易にする", () => {
  const h = html(mk(EV5), EV5);
  assert.match(h, /ぶんまとめて追加/, "「5選手を一括追加」をやめる");
  assert.ok(!/5' \+ unit \+ 'を一括追加/.test(h));
});

test("一般の部の学年欄は「学生の方のみ」と用途を書く", () => {
  const t = mk(EV5, { field_config: { version: 2, fields: { grade: "optional" }, custom: [], event_overrides: {} } });
  const h = html(t, EV5);
  assert.match(h, /学生の方のみ/, "なぜ聞かれるかが分かる");
  assert.match(h, /isStudentEvent\(ev\) \? lb : lb \+ " \(学生の方のみ\)"/,
    "学生の種目では余計な補足を付けない");
});

// ── 既存の不変条件が壊れていないこと ───────────────────────────
test("テンプレートリテラル内の正規表現が壊れていない(\\d の二重エスケープ)", () => {
  const src = fs.readFileSync(require.resolve("../entry_form.js"), "utf8");
  // 生成後のHTMLに、文字クラスのつもりで書いた「d{4}」等が現れていないこと
  const h = html(mk(EV3), EV3);
  assert.ok(!/\/\^\(d\{4\}\)/.test(h), "生成後に \\d が文字 d に化けていない");
  assert.ok(!/_md\+\$/.test(h), "メンバー収集の正規表現が壊れていない");
  assert.ok(src.length > 0);
});

test("375px向けの土台(横スクロールを生む固定幅)が入っていない", () => {
  const h = html(mk(EV5), EV5);
  assert.ok(!/min-width:\s*[6-9]\d\dpx/.test(h), "600px以上の最小幅を持つ要素が無い");
});
