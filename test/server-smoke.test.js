// server.js を実プロセスで起動し、横断的関心事(PII sanitize / 認可 / op_id冪等)を fetch で最小スモーク。
// 既存テストは DAL(db) のみ検証し server.js の209ルートは0件だった(認証/PII漏洩のリグレッションが緑のまま
// デプロイ到達し得る)。supertest 等の依存は足さず、サブプロセス + 組込fetch で in-process相当を担保する。
// 実行: node --test test/server-smoke.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3912;
const KEY = "smoke-admin-key-xyz";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/ktta_smoke_" + process.pid + ".db";
let srv;

const jhead = { "Content-Type": "application/json" };
const akhead = { ...jhead, "X-Admin-Key": KEY };
const adminPost = (p, b) => fetch(BASE + p, { method: "POST", headers: akhead, body: JSON.stringify(b) }).then(r => r.json());
const adminPut = (p, b) => fetch(BASE + p, { method: "PUT", headers: akhead, body: JSON.stringify(b) }).then(r => r.json());

before(async () => {
  srv = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, DB_PATH: DB, NODE_ENV: "test", SSE_MAX: "10" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + "/api/health"); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("server が起動しませんでした");
});

after(() => {
  if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(DB + ext, { force: true }); } catch (e) {}
});

test("(a) 公開レスポンスに秘密フィールド(referee_token/passcode/entry_gas_url)が露出しない (sanitize契約)", async () => {
  const t = await adminPost("/api/tournaments", { name: "smoke", date: "2027-01-01" });
  assert.ok(t.id, "大会作成");
  // 秘密値を設定(entry_gas_url は entry-settings, referee_token は tournament PUT 経由を試す)
  const SECRET_GAS = "https://script.google.com/SECRETGAS";
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, entry_gas_url: SECRET_GAS, event_config: [] });
  await adminPut(`/api/tournaments/${t.id}`, { referee_token: "SECRET_TOKEN_ZZZ", referee_passcode: "778899", referee_passcode_required: 1 });
  // 公開 GET (認証なし)
  const pub = await fetch(BASE + `/api/public/tournaments/${t.id}`).then(r => r.json());
  const s = JSON.stringify(pub);
  assert.ok(!s.includes("SECRET_TOKEN_ZZZ"), "referee_token の値が公開に漏れない");
  assert.ok(!s.includes("778899"), "referee_passcode の値が公開に漏れない");
  assert.ok(!s.includes("SECRETGAS"), "entry_gas_url の値が公開に漏れない");
  ["referee_token", "referee_passcode", "referee_passcode_required", "entry_gas_url"].forEach(k =>
    assert.ok(!(k in pub), `秘密キー ${k} 自体が公開レスポンスに存在しない`));
  // 認証ありの管理GETには秘密が含まれる(=sanitizeは公開側だけ)=契約の片側。設定が確実な entry_gas_url で確認。
  const adminView = await fetch(BASE + `/api/tournaments/${t.id}`, { headers: akhead }).then(r => r.json());
  assert.strictEqual(adminView.entry_gas_url, SECRET_GAS, "管理GETには秘密(entry_gas_url)が含まれる=公開側だけ除去");
});

test("(b) admin限定ルートは X-Admin-Key 無しで拒否(401/503)", async () => {
  const t = await adminPost("/api/tournaments", { name: "smoke2", date: "2027-01-01" });
  const cases = [
    ["GET", `/api/tournaments/${t.id}/roster.json`, null],          // 名簿(PII)
    ["GET", `/api/tournaments/${t.id}/receipts.json`, null],        // 領収書(PII/金額)
    ["POST", `/api/tournaments/${t.id}/bracket`, { event: "x" }],   // ブラケット生成
    ["POST", `/api/tournaments`, { name: "x", date: "2027-01-01" }],// 大会作成
  ];
  for (const [m, p, b] of cases) {
    const r = await fetch(BASE + p, { method: m, headers: b ? jhead : {}, body: b ? JSON.stringify(b) : undefined });
    assert.ok(r.status === 401 || r.status === 503, `${m} ${p} は無認証で拒否(実際 ${r.status})`);
  }
  // 正しいキーなら通る(対照)
  const ok = await fetch(BASE + `/api/tournaments/${t.id}/roster.json`, { headers: akhead });
  assert.ok(ok.ok, "正しいキーなら roster.json は200: " + ok.status);
});

test("(c) op_id 冪等: 同一 op_id の finish 二重送信で二重適用されない", async () => {
  const t = await adminPost("/api/tournaments", { name: "smoke3", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 0 }] });
  for (const nm of ["山田 太郎", "鈴木 一"]) await adminPost(`/api/tournaments/${t.id}/entrants`, { event: "男子シングルス", name: nm, status: "confirmed" });
  const gen = await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "男子シングルス", regenerate: true });
  assert.ok(gen.success, "ブラケット生成: " + JSON.stringify(gen).slice(0, 80));
  // 唯一の試合(決勝)を取得
  const matches = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const list = Array.isArray(matches) ? matches : (matches.matches || []);
  const m = list.find(x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  assert.ok(m, "実戦の試合がある");
  const body = { winner_slot: 1, sets: [[11, 5], [11, 7], [11, 9]], op_id: "smoke-op-123" };
  const r1 = await adminPost(`/api/matches/${m.id}/finish`, body);
  const r2 = await adminPost(`/api/matches/${m.id}/finish`, body); // 同一 op_id 再送
  assert.ok(!r1.error, "1回目 finish 成功: " + JSON.stringify(r1).slice(0, 80));
  assert.deepStrictEqual({ w: r2.winner_name, s: r2.winner_sets }, { w: r1.winner_name, s: r1.winner_sets },
    "同一op_id再送は同一結果(冪等)で二重適用されない");
  // 試合は1回だけ完了している
  const after = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const alist = Array.isArray(after) ? after : (after.matches || []);
  const done = alist.find(x => x.id === m.id);
  assert.strictEqual(done.status, "completed", "試合は completed");
});
