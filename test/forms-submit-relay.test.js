// GAS Web App の 302 リダイレクト仕様(script.googleusercontent.com へ転送)を模した回帰テスト。
// /api/forms/submit が redirect:"follow" で追従し、GAS の実応答ボディをそのまま転送することを確認する。
// 実行: node --test test/forms-submit-relay.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT_OK = 3933;        // GAS_EXTERNAL_URL 設定済み(フェイクGAS経由)
const PORT_NOGAS = 3934;     // GAS_EXTERNAL_URL 未設定
const PORT_UNREACH = 3935;   // GAS_EXTERNAL_URL が到達不能ポートを指す
const UNREACHABLE_PORT = 39777; // 誰も listen していない前提のポート
const KEY = "forms-relay-admin";
const DB_OK = "/tmp/ktta_forms_ok_" + process.pid + ".db";
const DB_NOGAS = "/tmp/ktta_forms_nogas_" + process.pid + ".db";
const DB_UNREACH = "/tmp/ktta_forms_unreach_" + process.pid + ".db";

let srvOk, srvNoGas, srvUnreach;
let gasRedirect, gasFinal;
let scenario = "success"; // "success" | "slow" | "badjson"

function spawnSrv(port, db, extraEnv) {
  return spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), ADMIN_KEY: KEY, DB_PATH: db, NODE_ENV: "test", ...extraEnv },
    stdio: "ignore",
  });
}
async function waitHealth(port) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("server(" + port + ") が起動しませんでした");
}

before(async () => {
  // フェイク「script.googleusercontent.com」相当: 実ボディを返す最終ホップ
  gasFinal = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (scenario === "badjson") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html>Internal Server Error</html>"); // GAS内部エラーページを模す
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, row: 7 }));
    });
  });
  await new Promise(r => gasFinal.listen(0, r));

  // フェイク「script.google.com/exec」相当: 必ず302でgasFinalへリダイレクトする(本番仕様の再現)
  gasRedirect = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const loc = `http://127.0.0.1:${gasFinal.address().port}/final`;
      if (scenario === "slow") {
        // クライアント側タイムアウト検証用: 応答をわざと遅延させる(接続は保持したまま無応答)
        setTimeout(() => { try { res.writeHead(302, { Location: loc }); res.end(); } catch (e) {} }, 30000);
        return;
      }
      res.writeHead(302, { Location: loc });
      res.end("Moved Temporarily");
    });
  });
  await new Promise(r => gasRedirect.listen(0, r));

  const gasUrl = `http://127.0.0.1:${gasRedirect.address().port}/exec`;
  srvOk = spawnSrv(PORT_OK, DB_OK, { GAS_EXTERNAL_URL: gasUrl, GAS_FORMS_TIMEOUT_MS: "1500" });
  srvNoGas = spawnSrv(PORT_NOGAS, DB_NOGAS, {});
  srvUnreach = spawnSrv(PORT_UNREACH, DB_UNREACH, { GAS_EXTERNAL_URL: `http://127.0.0.1:${UNREACHABLE_PORT}/exec` });

  await Promise.all([waitHealth(PORT_OK), waitHealth(PORT_NOGAS), waitHealth(PORT_UNREACH)]);
});

after(() => {
  for (const s of [srvOk, srvNoGas, srvUnreach]) { if (s) try { s.kill("SIGKILL"); } catch (e) {} }
  for (const s of [gasRedirect, gasFinal]) { if (s) try { s.close(); } catch (e) {} }
  for (const db of [DB_OK, DB_NOGAS, DB_UNREACH]) {
    for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(db + ext, { force: true }); } catch (e) {}
  }
});

const payload = {
  form_type: "masters_2026", contact_name: "テスト太郎", contact_tel: "000",
  singles: [{ name: "山田太郎" }], doubles: [], total_amount: 2000,
};
const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/forms/submit`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("(a) 正常系: GASの302を追従し、実ボディ{ok:true,row:N}がそのまま返る", async () => {
  scenario = "success";
  const r = await post(PORT_OK, payload);
  assert.strictEqual(r.status, 200, "302追従後は200(旧実装は302がそのまま漏れていた)");
  const j = await r.json();
  assert.strictEqual(j.ok, true, "GASの成功ボディがそのまま転送される");
  assert.strictEqual(j.row, 7, "row値もそのまま転送される");
});

test("(b) GAS未設定: 503 + {ok:false,error} を返す(GASへ通信を試みない)", async () => {
  const r = await post(PORT_NOGAS, payload);
  assert.strictEqual(r.status, 503);
  const j = await r.json();
  assert.strictEqual(j.ok, false);
  assert.match(j.error, /GAS_EXTERNAL_URL/);
});

test("(c) GAS到達不可(接続拒否): 502 + {ok:false,error}", async () => {
  const r = await post(PORT_UNREACH, payload);
  assert.strictEqual(r.status, 502);
  const j = await r.json();
  assert.strictEqual(j.ok, false);
});

test("(d) GASタイムアウト: 504 + {ok:false,error:'GAS通信タイムアウト'}", async () => {
  scenario = "slow";
  const r = await post(PORT_OK, payload);
  assert.strictEqual(r.status, 504);
  const j = await r.json();
  assert.strictEqual(j.ok, false);
  assert.match(j.error, /タイムアウト/);
  scenario = "success"; // 後続テストへ影響させない
});

test("(e) GAS応答がJSONでない(内部エラーページ等): 502 + {ok:false,error}", async () => {
  scenario = "badjson";
  const r = await post(PORT_OK, payload);
  assert.strictEqual(r.status, 502);
  const j = await r.json();
  assert.strictEqual(j.ok, false);
  assert.match(j.error, /JSON/);
  scenario = "success";
});
