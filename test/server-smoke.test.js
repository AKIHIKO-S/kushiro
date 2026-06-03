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

test("(d) 抽選ドロー: HTTP で draw→再現性→両山Excel出力→認可", async () => {
  const EV = "一般男子シングルス";
  const t = await adminPost("/api/tournaments", { name: "抽選smoke", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const ids = [];
  for (let i = 1; i <= 8; i++) {
    const e = await adminPost(`/api/tournaments/${t.id}/entrants`, { event: EV, name: "選手" + i, team: "ク" + (i % 3), status: "confirmed" });
    if (e && (e.id || (e.entrant && e.entrant.id))) ids.push(e.id || e.entrant.id);
  }
  // 上位2人にシード(取れた id があれば)
  for (let k = 0; k < Math.min(2, ids.length); k++) await adminPut(`/api/entrants/${ids[k]}`, { seed: k + 1 });

  // 事前検査(プリフライト)
  const rdy = await fetch(BASE + `/api/tournaments/${t.id}/bracket/draw-readiness?event=${encodeURIComponent(EV)}`, { headers: akhead }).then(r => r.json());
  assert.ok(rdy.ok, "事前検査ok: " + JSON.stringify(rdy.issues));
  // プレビュー(DBを書かない)
  const pv = await adminPost(`/api/tournaments/${t.id}/bracket/draw`, { event: EV, draw_seed: 777, separate_by: "team", preview: true });
  assert.ok(pv.preview && pv.pairs && pv.pairs.length === 4, "プレビューでR1ペア返る");
  // 確定に実施者名が無いと拒否
  const noBy = await fetch(BASE + `/api/tournaments/${t.id}/bracket/draw`, { method: "POST", headers: akhead, body: JSON.stringify({ event: EV, draw_seed: 777 }) });
  assert.strictEqual(noBy.status, 400, "drawn_by 無しの確定は拒否");
  // 抽選(種固定で再現性を確認・実施者名付き)
  const d1 = await adminPost(`/api/tournaments/${t.id}/bracket/draw`, { event: EV, draw_seed: 777, separate_by: "team", drawn_by: "運営太郎" });
  assert.ok(d1.success, "抽選成功: " + JSON.stringify(d1).slice(0, 120));
  assert.strictEqual(d1.draw_seed, 777, "draw_seed 返却");
  assert.strictEqual(d1.bracket_size, 8, "枠数8");
  assert.ok(d1.draw_log_id, "draw_log に記録");
  const r1 = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const slots1 = (Array.isArray(r1) ? r1 : r1.matches || []).filter(m => m.bracket_round === 1)
    .sort((a, b) => a.bracket_pos - b.bracket_pos).map(m => [m.player1_name, m.player2_name]);
  // 同じ種で引き直すと同一配置(force 不要: 結果未入力)
  const d2 = await adminPost(`/api/tournaments/${t.id}/bracket/draw`, { event: EV, draw_seed: 777, separate_by: "team", drawn_by: "運営太郎" });
  assert.ok(d2.success, "再抽選成功");
  const r2 = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const slots2 = (Array.isArray(r2) ? r2 : r2.matches || []).filter(m => m.bracket_round === 1)
    .sort((a, b) => a.bracket_pos - b.bracket_pos).map(m => [m.player1_name, m.player2_name]);
  assert.deepStrictEqual(slots2, slots1, "同一 draw_seed は同一配置(再現性)");

  // 両山Excel出力(運営)
  const xa = await fetch(BASE + `/api/tournaments/${t.id}/bracket/export.xlsx?event=${encodeURIComponent(EV)}`, { headers: akhead });
  assert.strictEqual(xa.status, 200, "Excel 200");
  assert.match(xa.headers.get("content-type") || "", /spreadsheetml/, "xlsx content-type");
  const buf = Buffer.from(await xa.arrayBuffer());
  assert.ok(buf.length > 1000 && buf[0] === 0x50 && buf[1] === 0x4b, "xlsx本体(PKzip)が返る: " + buf.length);

  // 公開読取版も 200
  const xp = await fetch(BASE + `/api/public/tournaments/${t.id}/bracket/export.xlsx?event=${encodeURIComponent(EV)}`);
  assert.strictEqual(xp.status, 200, "公開Excel 200");

  // 認可: 管理版を鍵なしで叩くと拒否
  const noauth = await fetch(BASE + `/api/tournaments/${t.id}/bracket/export.xlsx?event=${encodeURIComponent(EV)}`);
  assert.ok(noauth.status === 401 || noauth.status === 403, "鍵なし管理Excelは拒否(" + noauth.status + ")");
});

test("(e) 静的キャッシュ: ?v=有=immutable / 無=no-cache、HTMLは版注入+no-cache(即時反映の起点)", async () => {
  const v = await fetch(BASE + "/shared/common.js?v=abc");
  assert.match(v.headers.get("cache-control") || "", /max-age=31536000.*immutable/, "?v=有は immutable");
  const nv = await fetch(BASE + "/shared/common.js");
  assert.match(nv.headers.get("cache-control") || "", /no-cache/, "?v=無は no-cache");
  const html = await fetch(BASE + "/viewer");
  assert.match(html.headers.get("cache-control") || "", /no-cache/, "HTML自体は no-cache");
  const body = await html.text();
  assert.match(body, /\/shared\/common\.js\?v=/, "common.js に版注入");
  assert.match(body, /\/shared\/[^"']+\.(?:svg|png)\?v=/, "アイコンにも版注入");
});
