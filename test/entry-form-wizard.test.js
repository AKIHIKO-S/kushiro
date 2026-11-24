// 申込フォームの3段化(2026-11-24 オーナー承認の見本)の回帰テスト(生成されるHTMLの構造)。
// 画面の動き(段の移動・入力の保持・必須の確認・送信)は、ブラウザで実際に操作して確認した(手順は OPERATIONS.md ではなく作業記録)。
//
// 守らせる不変条件:
//   ① 受付中のフォームは3段(連絡先 / 種目と選手 / 確認して送信)で、TT_WIZARD が有効
//   ② 受付終了のフォームは3段にしない(従来のまま・送信ボタンは無効)
//   ③ 3段のときは、従来の確認画面(showConfirmModal)を出さずに送信へ進む(3段目が確認)
//   ④ 送信の直前に全段を確かめ、隠れた段の欄で送信が止まらないよう、段ごとの確認を自前で行う(noValidate)
//   ⑤ 段を切り替えても入力欄は消さない(表示の切替だけ)。送信成功後は道しるべと操作バーを隠し、リセットで1段目へ戻る
//   ⑥ 年配の方・スマホ向けに、入力欄とボタンの高さ・文字の大きさを確保する
// 実行: node --test test/entry-form-wizard.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const ef = require("../entry_form");

const T = { id: "t1", name: "架空大会", date: "2099-12-06", venue: "市民体育館", entry_deadline: "2099-11-30 17:00", status: "upcoming" };
const EV = [{ name: "一般男子シングルス", type: "singles", fee: 700 }, { name: "男子ダブルス", type: "doubles", fee: 1000 }];
const open = ef.buildEntryFormHTML(T, EV, { submit_url: "https://example.invalid/api/forms/submit" });

test("① 受付中は3段(連絡先・種目と選手・確認して送信)", () => {
  assert.match(open, /const TT_WIZARD = true;/);
  ["連絡先", "種目と選手", "確認して送信"].forEach(n => assert.ok(open.includes('"' + n + '"'), n));
  ["ttWizBuild", "ttWizTo", "ttWizCheck", "ttWizValidateAll", "ttWizBuildCheck"].forEach(f => assert.ok(open.includes("function " + f), f));
  assert.ok(open.includes("申込内容を送信"), "従来の送信ボタンの文言も残る(3段以外の経路)");
});

test("② 受付終了のフォームは3段にしない", () => {
  const closed = ef.buildEntryFormHTML(T, EV, { submit_url: "https://example.invalid/api/forms/submit", capacity: { events: [], closed_reason: "締切を過ぎました。" } });
  assert.match(closed, /const TT_WIZARD = false;/);
});

test("③④⑤ 確認画面は3段目に任せ、全段を確かめてから送信する。入力は消さず、成功後に隠す", () => {
  assert.match(open, /const ok = TT_WIZ \? true : await showConfirmModal\(data\);/);
  assert.match(open, /if \(TT_WIZ && !ttWizValidateAll\(\)\) return false;/);
  assert.match(open, /form\.noValidate = true;/);
  assert.match(open, /body\.wz \[data-wz\]:not\(\.wz-on\) \{ display: none; \}/, "段の切替は表示だけ");
  assert.ok(!/ttWiz[A-Za-z]*\([^)]*\)\s*\{[^}]*\.reset\(\)/.test(open), "段の切替で入力をリセットしない");
  assert.match(open, /classList\.add\("wz-done"\)/);
  assert.match(open, /if \(TT_WIZ\) ttWizShow\(1\);/, "新しく申込みするで1段目へ戻る");
});

test("⑥ 文字・入力欄・ボタンの大きさ", () => {
  assert.match(open, /body\.wz \{[^}]*font-size: 17px/);
  assert.match(open, /min-height: 56px; font-size: 18px/, "入力欄");
  assert.match(open, /#ttBar button, #ttBar \.submit-btn \{ min-height: 58px/, "ボタン");
  assert.match(open, /width="64" height="64"/, "ロゴを大きく");
});
