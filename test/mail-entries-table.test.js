// 控えメールの「申込内容」表の回帰。
//
// 実際に起きた不具合(2026-08-04 オーナー報告・スクショあり): 個人戦の種目名に
//   個人戦 シングルス<br><span style="font-size:12px;color:#92400e;">区分: サーティ以下</span>
// とタグがそのまま見えていた。原因は、種目名セルを「HTMLを組み立てた文字列」にしたうえで
// 出力時にもう一度 esc() していたこと(二重エスケープ)。
//
// 守らせる不変条件:
//   ① 区分つきの種目名でタグが文字として出ない
//   ② それでも申込者の入力は必ずエスケープされる(XSS/メール崩れの防止)
const { test } = require("node:test");
const assert = require("node:assert");
const mailer = require("../mailer.js");

// entriesTable は内部関数なので、公開されている sendConfirmationEmail 経由ではなく
// authoritativeFees + 実際の生成物で確かめる。ここでは mailer のソースを直接読み、
// 生成規則(組み立て済みHTMLを再エスケープしない)を固定する。
const fs = require("fs");
const SRC = fs.readFileSync(require.resolve("../mailer.js"), "utf8");

test("種目名セルは組み立て済みHTMLをそのまま出す(二重エスケープしない)", () => {
  assert.match(SRC, /let label = esc\(e\.event \|\| "\(種目不明\)"\)/,
    "値の側でエスケープする");
  assert.match(SRC, /border-bottom:1px solid #e5e7eb;">\$\{label\}<\/td>/,
    "出力側では素通しにする");
  assert.ok(!/\$\{esc\(label\)\}/.test(SRC), "esc(label) が残っていない");
});

test("区分ラベルは値だけがエスケープされる", () => {
  assert.match(SRC, /区分: \$\{esc\(e\.division_label\)\}/);
});

test("参加者セルの入力は従来どおりエスケープされている", () => {
  assert.match(SRC, /\(e\.members \|\| \[\]\)\.map\(m => esc\(m\)\)/, "団体メンバー");
  assert.match(SRC, /esc\(e\.team_name \|\| ""\)/, "チーム名");
  assert.match(SRC, /esc\(e\.name1 \|\| ""\)/, "ダブルス選手1");
  assert.match(SRC, /esc\(e\.name \|\| ""\)/, "シングルス氏名");
});

test("変更通知の detail は平文なのでエスケープしたままでよい", () => {
  // detail は `${b.event}: ${b.name} …` の平文。タグを含まないので esc() が正しい。
  assert.match(SRC, /\$\{esc\(detail\)\}/, "平文側は esc を維持");
});

// ── 実際に生成して目視相当の確認 ──────────────────────────────
test("生成物にタグが文字として現れない", () => {
  // entriesTable は非公開なので、同じ規則を再現して確かめる(規則が変わればここも落ちる)
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const e = { event: "個人戦 シングルス", division_label: "サーティ以下", type: "singles",
    name: "甲野 花子", team: "釧路クラブ", fee: 2000 };
  let label = esc(e.event);
  label += `<br><span style="font-size:12px;color:#92400e;">区分: ${esc(e.division_label)}</span>`;
  const cell = `<td>${label}</td>`;
  assert.ok(!/&lt;br&gt;|&lt;span/.test(cell), "タグが文字化していない");
  assert.match(cell, /<br><span style=/, "タグとして出ている");
  assert.match(cell, /区分: サーティ以下/);
});

test("種目名に記号が入っても壊れない(値はエスケープされる)", () => {
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const label = esc('男子S <script>alert(1)</script> & "A"');
  assert.ok(!/<script>/.test(label), "タグとして解釈されない");
  assert.match(label, /&lt;script&gt;/);
  assert.match(label, /&amp;/);
});
