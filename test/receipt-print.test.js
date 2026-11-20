// 領収書の印刷(申込集計モード)の回帰テスト。
//
// 守らせる不変条件:
//   ① 金額は申込の保存額の合計。取り消しは対象外、承認待ちは金額に含めず注意を出す
//   ② 金額が保存されていない/0円の団体は amount=null(空欄)にして、誤った金額を出さない
//   ③ 取り消しだけの団体は印刷対象から外れる
//   ④ 既定の文面は元データ(会長杯の領収書)どおり、日付は令和表記
//   ⑤ ページに埋め込むデータに </script> が混ざってもページが壊れない
// 実行: node --test test/receipt-print.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const rp = require("../lib/receipt-print");
const { savedEntryFee } = require("../lib/entry-summary");

test("令和の日付", () => {
  assert.strictEqual(rp.reiwaDate("2026-05-02"), "令和8年5月2日");
  assert.strictEqual(rp.reiwaDate("2019-05-01"), "令和元年5月1日");
  assert.strictEqual(rp.reiwaDate("2019-04-30"), "");
  assert.strictEqual(rp.reiwaDate(""), "");
});

test("既定の文面は元データどおり(但し書き=大会名入り・発行者)", () => {
  const d = rp.defaultsFor({ name: "会長杯兼高校釧根支部オープン", date: "2026-05-02" }, {});
  assert.strictEqual(d.proviso, "大会参加費（会長杯兼高校釧根支部オープン）として、上記のとおり領収いたしました。");
  assert.strictEqual(d.date, "令和8年5月2日");
  assert.strictEqual(d.issuer, "釧路卓球協会　会長　山本　満");
  assert.strictEqual(rp.defaultsFor({ name: "x" }, { RECEIPT_ISSUER: "A会　会長　B" }).issuer, "A会　会長　B");
});

test("団体ごとの金額: 取消は除外・承認待ちは含めず注意・金額なしと0円は空欄", () => {
  const subs = [{ id: "s1", team_name: "架空クラブ" }, { id: "s2", team_name: "見本中" }, { id: "s3", team_name: "全取消高" }, { id: "s4", team_name: "金額なし校" }, { id: "s5", team_name: "架空クラブ" }, { id: "s6", team_name: "ゼロ円会" }];
  const e = (id, sub, status, fee) => ({ id, submission_id: sub, status, fee });
  const ents = [
    e("a", "s1", "confirmed", 700), e("b", "s1", "confirmed", 700), e("c", "s1", "cancelled", 700), e("d", "s1", "pending", 700),
    e("e", "s5", "confirmed", 1000),
    e("f", "s2", "confirmed", 2000),
    e("g", "s3", "cancelled", 700),
    e("h", "s4", "confirmed", null),
    e("i", "s6", "confirmed", 0),
  ];
  const r = rp.receiptTeams(subs, ents, savedEntryFee);
  const by = Object.fromEntries(r.teams.map(t => [t.name, t]));
  assert.strictEqual(by["架空クラブ"].amount, 2400, "同じ団体名の2申込は合算(700x2+1000)。取消と承認待ちは含めない");
  assert.strictEqual(by["架空クラブ"].entries, 3);
  assert.ok(by["架空クラブ"].warnings.some(w => w.includes("承認待ち 1 件")));
  assert.strictEqual(by["見本中"].amount, 2000);
  assert.strictEqual(by["金額なし校"].amount, null);
  assert.ok(by["金額なし校"].warnings.length);
  assert.strictEqual(by["ゼロ円会"].amount, null);
  assert.ok(!by["全取消高"]);
  assert.deepStrictEqual(r.excluded.map(x => x.name), ["全取消高"]);
});

test("埋め込みデータの </script> でページが壊れない", () => {
  const html = rp.buildReceiptPrintHTML({ id: "t", name: "大会</script><b>" }, {
    teams: [{ name: "</script><img src=x>", entries: 1, amount: 700, warnings: [] }], excluded: [],
    defaults: rp.defaultsFor({ name: "大会", date: "2026-05-02" }, {}), sealUrl: "", pick: "",
  });
  assert.strictEqual((html.match(/<\/script>/g) || []).length, 1, "閉じタグは本来の1か所だけ");
  assert.ok(!html.includes("<img src=x>"));
});
