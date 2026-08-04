// 申込フォーム設定モーダルの「保存」の回帰。
//
// 実際に起きた不具合(2026-08-01 オーナー報告): 自由項目を削除しても反映されない。
// 原因は「保存して閉じる」が localStorage への書込だけで、項目設定・自由項目・
// オプションをサーバーへ送っていなかったこと。それなのに「設定を保存しました」と
// 出して閉じるため、消したつもりが残る状態になっていた。
// 画面の案内文も「下の『保存して閉じる』で設定が反映されます」と、送らない側の
// ボタンを押すよう誘導していた。
//
// 守らせる不変条件:
//   ① 保存の入口は1つ(saveAll)。両方のボタンが同じ処理を通る
//   ② saveAll は field_config / entry_options / entry_payment_note を必ず送る
//   ③ 「保存して閉じる」は保存に失敗したら閉じない(消えたように見せない)
//   ④ サーバーは custom を渡されたとおりに置き換える(消したものが復活しない)
process.env.DB_PATH = "/tmp/ktta_adminsave_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const ADMIN = fs.readFileSync(path.join(__dirname, "..", "public", "admin", "index.html"), "utf8");

// ── ① 保存の入口が1つ ────────────────────────────────────────
test("保存処理は1箇所(saveAll)にまとまっている", () => {
  assert.match(ADMIN, /const saveAll = async \(\) => \{/, "保存の入口を関数にする");
  const calls = ADMIN.match(/await saveAll\(\)/g) || [];
  assert.ok(calls.length >= 2, "両方のボタンから呼ぶ (実際: " + calls.length + ")");
});

test("「保存して閉じる」がlocalStorageだけで済ませていない", () => {
  // 旧実装: localStorage.setItem → toast → モーダル除去 だけ
  assert.ok(!/localStorage\.setItem\("tt_gas_url_" \+ t\.id, gasUrl\);\s*\n\s*if \(adminEmail\) localStorage\.setItem\("tt_admin_email", adminEmail\);\s*\n\s*toast\("設定を保存しました", "ok"\);/.test(ADMIN),
    "サーバーへ送らずに「保存しました」と言う実装が残っていない");
});

// ── ② 送る中身 ──────────────────────────────────────────────
test("saveAll は項目設定・自由項目・オプション・参加料の案内を送る", () => {
  const body = ADMIN.split("const saveAll = async () => {")[1].split("};")[0];
  assert.match(body, /field_config: fieldCfg/, "必須項目設定 + 自由項目");
  assert.match(body, /entry_options: entryOptions/, "有料オプション");
  assert.match(body, /entry_payment_note: paymentNote/, "参加料の案内文");
  assert.match(body, /event_config: events/, "種目");
  assert.match(body, /entry_gas_url: gasUrl/, "GAS URL");
  assert.match(body, /entries_open/, "受付ON/OFF");
});

test("保存に失敗したらエラーを投げる(成功と誤認させない)", () => {
  const body = ADMIN.split("const saveAll = async () => {")[1].split("};")[0];
  assert.match(body, /if \(r && r\.error\) throw new Error\(r\.error\)/);
});

// ── ③ 失敗時は閉じない ───────────────────────────────────────
test("「保存して閉じる」は失敗したら閉じない", () => {
  const seg = ADMIN.split('"保存して閉じる"')[0].slice(-1200);
  assert.match(seg, /document\.querySelector\("\.modal-bg"\)\?\.remove\(\);/, "成功時は閉じる");
  assert.match(seg, /画面は閉じていません/, "失敗時は閉じずに理由を出す");
});

test("保存ボタンの名前が実態と合っている", () => {
  assert.match(ADMIN, /"▼ この画面の設定をすべてサーバーに保存"/,
    "旧名は『受付ON/OFF + 締切 + 種目 + GAS URL』で、項目設定が入っていないと読めた");
  assert.ok(!/▼ サーバーに保存 \(受付ON\/OFF \+ 締切 \+ 種目 \+ GAS URL\)/.test(ADMIN),
    "誤解を招く旧ラベルが残っていない");
});

test("案内文が「押すまで反映されない」と明示している", () => {
  assert.match(ADMIN, /押すまで反映されません/);
  assert.match(ADMIN, /種目・料金・入力項目・自由項目・オプション・締切/,
    "何が保存対象かを列挙する");
});

// ── ④ サーバー側: 渡したとおりに置き換わる ────────────────────────
test("自由項目は渡したとおりに置き換わる(消したものが復活しない)", () => {
  const t = db.createTournament({ name: "自由項目の削除", date: "2027-03-01", venue: "会場" });
  const put = (custom) => db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [{ name: "男子シングルス", type: "singles", fee: 700 }],
    field_config: { version: 2, fields: {}, event_overrides: {}, field_meta: {}, custom },
  });
  const keys = () => db.resolveFieldConfig(db.getTournament(t.id)).custom.map(c => c.key);

  put([{ key: "aaa", label: "項目A", type: "text", scope: "submission" },
       { key: "bbb", label: "項目B", type: "text", scope: "player" }]);
  assert.deepStrictEqual(keys(), ["aaa", "bbb"]);

  put([{ key: "bbb", label: "項目B", type: "text", scope: "player" }]);
  assert.deepStrictEqual(keys(), ["bbb"], "1つ消したら消えたまま");

  put([]);
  assert.deepStrictEqual(keys(), [], "全部消せる");

  // 受付フラグだけの保存では既存値を維持する(明示指定時のみ更新の流儀)
  put([{ key: "ccc", label: "項目C", type: "text", scope: "submission" }]);
  db.updateEntrySettings(t.id, { entries_open: 0 });
  assert.deepStrictEqual(keys(), ["ccc"], "field_config 未指定なら消さない");
});

test("削除した自由項目は集計シートの列定義からも消える", () => {
  const t = db.createTournament({ name: "列の追随", date: "2027-03-01", venue: "会場" });
  const ev = [{ name: "男子シングルス", type: "singles", fee: 700 }];
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: ev,
    field_config: { version: 2, fields: {}, event_overrides: {}, field_meta: {},
      custom: [{ key: "zekken", label: "ゼッケン番号", type: "text", scope: "player" }] } });
  const cols = () => JSON.stringify(db.buildFormSchema(db.getTournament(t.id)).columns);
  assert.match(cols(), /ゼッケン番号/, "追加すると列になる");

  db.updateEntrySettings(t.id, { entries_open: 1, event_config: ev,
    field_config: { version: 2, fields: {}, event_overrides: {}, field_meta: {}, custom: [] } });
  assert.ok(!/ゼッケン番号/.test(cols()), "削除したら列定義からも消える");
});

// ── 未連携が画面に出るか ──────────────────────────────────────
// 実際に起きた不具合(2026-08-04 オーナー報告): 「申込データがどこに飛んでいるか分かりません」。
// 反映状況バーは `configured` が false のとき何も出さない造りだったため、
// GAS URL 未設定のまま受付が進むと、申込がどこへも行かないまま溜まっても気づけなかった。
test("スプレッドシート未連携でも申込があれば警告を出す", () => {
  assert.match(ADMIN, /if \(!gasState\.configured\) \{/, "未連携でも早期returnせず分岐する");
  assert.match(ADMIN, /スプレッドシート未連携/, "状態を名指しする");
  assert.match(ADMIN, /本部システムに保存されていますが、スプレッドシートには送られていません/,
    "申込が消えたわけではないことも伝える");
  assert.match(ADMIN, /未反映をシートへ再送」で過去の申込もまとめて送れます/, "後から救える道を示す");
  assert.ok(!/if \(!gasState\.configured\) return;/.test(ADMIN), "黙って何も出さない実装が残っていない");
});

test("申込ゼロなら未連携でも出さない(まだ困っていない)", () => {
  const seg = ADMIN.split("const renderGas = () => {")[1].split("gasBar.appendChild")[0];
  assert.match(seg, /if \(!gasState\.total\) return;/, "申込ゼロは対象外");
  assert.ok(seg.indexOf("if (!gasState.total) return;") < seg.indexOf("if (!gasState.configured) {"),
    "件数の判定を先に置く");
});

test("GAS URL欄が空のときは欄のすぐ下でも知らせる", () => {
  assert.match(ADMIN, /\(!gasUrl \? h\("div", \{ className: "text-xs mt-1"/, "空欄のときだけ出す");
  assert.match(ADMIN, /この欄が空のあいだ、申込は本部システムにだけ保存され/);
  assert.match(ADMIN, /申込自体は失われません/, "不安を煽らない");
});
