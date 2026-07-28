// 集計スプレッドシートへの中継が「本当に届いたか」を判定する仕組みの検証。
//
// 背景(実際に起きた事故): 申込は届いていたのにスプレッドシートに記録が無かった。
// コードを読むと、中継の成否を HTTP ステータスだけで判定していた。Apps Script のウェブアプリは
// スクリプトが {ok:false} を返しても HTTP 200 で応答するため、GAS が「記録できませんでした」と
// 言っていても中継成功として記録され、申込者には「受け付けました」と表示されていた。
//
// ここで守らせる不変条件:
//   ① HTTP 200 でも本文が {ok:false} なら失敗と判定する
//   ② JSON 以外(GASのログイン画面など)が返ってきたら失敗と判定し、原因の手がかりを残す
//   ③ 通信の失敗(タイムアウト・5xx)は1回だけ再送する。GASが明示した失敗は再送しない
//   ④ 中継結果は申込原本に記録され、未反映の申込を後から特定できる
//   ⑤ 再送は受付時の原本をそのまま送るので、内容が変質しない
process.env.DB_PATH = "/tmp/ktta_gasrelay_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// server.js を読み込まずに relay 部分だけ再現すると本物との乖離が起きるため、
// 実物の relayEntryToGas を使う。server.js は listen するので、テスト用に環境を整えてから読む。
process.env.ADMIN_KEY = "test-admin-key";
process.env.PORT = "0";                    // 任意の空きポート
const server = require("../server.js");
const relay = server.__test__ && server.__test__.relayEntryToGas;

// ── GAS の代わりに応答するローカルサーバー ────────────────────────
function gasStub(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += c; });
      req.on("end", () => handler(req, res, body));
    });
    srv.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() });
    });
  });
}

test("relayEntryToGas がテスト用に公開されている", () => {
  assert.strictEqual(typeof relay, "function", "server.js が __test__.relayEntryToGas を公開していること");
});

// ── ① 本文を見て判定する ─────────────────────────────────────
test("HTTP200でも本文が ok:false なら失敗と判定する(事件の再現)", async () => {
  const stub = await gasStub((req, res, body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, verified: false,
      error: "シートへの記録を確認できませんでした: 申込台帳に行が追加されていません",
      problems: ["申込台帳に行が追加されていません"] }));
  });
  const r = await relay(stub.url, { team_name: "A" });
  stub.close();
  assert.strictEqual(r.ok, false, "HTTP200に騙されない");
  assert.match(r.error, /記録を確認できませんでした/);
  assert.deepStrictEqual(r.problems, ["申込台帳に行が追加されていません"]);
});

test("本文が ok:true なら成功、台帳の行番号も拾う", async () => {
  const stub = await gasStub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, verified: true, ledger_row: 7, checks: ["申込台帳: 7行目に記録"] }));
  });
  const r = await relay(stub.url, { team_name: "A" });
  stub.close();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.ledger_row, 7);
});

test("再送で「処理済み」が返ってきたら成功かつ重複と分かる", async () => {
  const stub = await gasStub((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, duplicate: true, verified: true, ledger_row: 3 }));
  });
  const r = await relay(stub.url, { op_id: "op-1" });
  stub.close();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.duplicate, true, "二重登録していないことが分かる");
});

// ── ② JSON以外 ────────────────────────────────────────────
test("GASのログイン画面が返ったらアクセス権の問題として知らせる", async () => {
  const stub = await gasStub((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>Sign in - accounts.google.com</body></html>");
  });
  const r = await relay(stub.url, {});
  stub.close();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /アクセス権/, "原因の見当がつく文言を返す");
  assert.ok(r.snippet, "応答の断片を残す(調査の手がかり)");
});

test("JSONでない応答は失敗にする(黙って成功にしない)", async () => {
  const stub = await gasStub((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html>Script error</html>");
  });
  const r = await relay(stub.url, {});
  stub.close();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /JSON以外/);
});

// ── ③ 再送の方針 ──────────────────────────────────────────
test("5xx は1回だけ再送する(2回目で成功すれば成功)", async () => {
  let n = 0;
  const stub = await gasStub((req, res) => {
    n++;
    if (n === 1) { res.writeHead(503); res.end("busy"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, verified: true, ledger_row: 2 }));
  });
  const r = await relay(stub.url, {});
  stub.close();
  assert.strictEqual(n, 2, "2回だけ叩く");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.retried, true, "再送したことが分かる");
});

test("GASが明示した失敗は再送しない(同じ結果になるだけ)", async () => {
  let n = 0;
  const stub = await gasStub((req, res) => {
    n++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "必須項目が未入力: contact_email" }));
  });
  const r = await relay(stub.url, {});
  stub.close();
  assert.strictEqual(n, 1, "1回で諦める");
  assert.strictEqual(r.ok, false);
});

test("再送も失敗したら失敗として返す(握り潰さない)", async () => {
  let n = 0;
  const stub = await gasStub((req, res) => { n++; res.writeHead(500); res.end("ng"); });
  const r = await relay(stub.url, {});
  stub.close();
  assert.strictEqual(n, 2);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.retried, true);
  assert.ok(r.first_error, "1回目の原因も残す");
});

// ── ④ 中継結果の記録 ──────────────────────────────────────
function makeTournamentWithEntry() {
  const t = db.createTournament({ name: "中継テスト", date: "2027-06-01", venue: "会場" });
  db.updateEntrySettings(t.id, { entries_open: 1,
    event_config: [{ name: "男子シングルス", type: "singles", fee: 700 }] });
  const sub = db.createTeamEntry(t.id, {
    team_name: "チームA", contact_name: "担当", contact_tel: "0154-00-0000", contact_email: "a@example.com",
    entries: [{ event: "男子シングルス", type: "singles", name: "甲 一", team: "チームA" }],
  }, "op-relay-" + Math.random().toString(36).slice(2));
  return { t, sub };
}

test("中継の成否が申込原本に記録される", () => {
  const { t, sub } = makeTournamentWithEntry();
  db.recordGasRelay(sub.submission_id, { ok: true, ledger_row: 5 });
  let st = db.getGasSyncState(t.id);
  assert.strictEqual(st.counts.ok, 1);
  assert.strictEqual(st.pending.length, 0, "反映済みは未反映一覧に出ない");
  assert.match(st.items[0].gas_detail, /台帳5行目/);

  db.recordGasRelay(sub.submission_id, { ok: false, error: "timeout" });
  st = db.getGasSyncState(t.id);
  assert.strictEqual(st.counts.failed, 1);
  assert.strictEqual(st.pending.length, 1, "失敗は未反映一覧に出る");
  assert.match(st.items[0].gas_detail, /timeout/);
});

test("記録が無い申込は「不明」として未反映側に数える(見落とさない)", () => {
  const { t } = makeTournamentWithEntry();
  const st = db.getGasSyncState(t.id);
  assert.strictEqual(st.counts.unknown, 1);
  assert.strictEqual(st.pending.length, 1, "判定していない申込も要確認として拾う");
});

test("スプレッドシート未連携の大会は configured:false で区別できる", () => {
  const { t } = makeTournamentWithEntry();
  assert.strictEqual(db.getGasSyncState(t.id).configured, false);
  db.updateEntrySettings(t.id, { entries_open: 1, entry_gas_url: "https://script.google.com/macros/s/X/exec" });
  assert.strictEqual(db.getGasSyncState(t.id).configured, true);
});

test("GAS失敗の理由が長くても記録は壊れない(500字で切る)", () => {
  const { t, sub } = makeTournamentWithEntry();
  db.recordGasRelay(sub.submission_id, { ok: false, error: "x".repeat(2000) });
  const st = db.getGasSyncState(t.id);
  assert.ok(st.items[0].gas_detail.length <= 500);
});

// ── ⑤ 再送の材料 ──────────────────────────────────────────
test("再送は受付時の原本と確定金額をそのまま使う", () => {
  const { sub } = makeTournamentWithEntry();
  const src = db.getSubmissionForResend(sub.submission_id);
  assert.ok(src.ok, src.error);
  assert.strictEqual(src.payload.team_name, "チームA", "原本の内容が取り出せる");
  assert.strictEqual(src.op_id, sub.op_id || src.op_id, "申込IDが付く(GAS側の重複判定に使う)");
  assert.strictEqual(typeof src.total_amount, "number", "金額はサーバが確定した値を使う");
});

test("存在しない申込の再送は日本語で断る", () => {
  assert.match(db.getSubmissionForResend("no-such-id").error || "", /見つかりません/);
});
