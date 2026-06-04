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
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, DB_PATH: DB, NODE_ENV: "test", SSE_MAX: "10", SYNC_KEY: "smoke-sync-key" },
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

test("(f) 公開 /matches: 内部列を射影で除去・表示列は維持・ETagで304", async () => {
  const t = await adminPost("/api/tournaments", { name: "proj", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: "S", type: "singles", fee: 0 }] });
  for (const nm of ["山田 太郎", "鈴木 一"]) await adminPost(`/api/tournaments/${t.id}/entrants`, { event: "S", name: nm, status: "confirmed" });
  await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "S", regenerate: true });
  const list0 = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const m = list0.find(x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  await adminPost(`/api/matches/${m.id}/finish`, { winner_slot: 1, sets: [[11, 5], [11, 7], [11, 9]], referee_name: "審判花子" });
  const list = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const row = list.find(x => x.id === m.id);
  // 内部列は消えている
  ["referee_id", "pending_result", "winner_rating_delta", "loser_rating_delta", "next_match_id", "sets_json", "tournament_id", "created_at", "call_count"]
    .forEach(k => assert.ok(!(k in row), `内部列 ${k} が公開 /matches から除去`));
  // 表示に要る列は残っている(referee_name は viewer が「審判: X」で表示=公開意図)
  // referee_name は viewer が「審判: X」で表示する公開意図の列なので射影で残す(値は審判割当で入る)。
  ["referee_name", "sets", "winner_name", "player1_name", "status", "bracket_round"]
    .forEach(k => assert.ok(k in row, `表示列 ${k} は維持`));
  // ETag/304: 未変化の再取得は本体0
  const r1 = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`);
  const etag = r1.headers.get("etag");
  assert.ok(etag, "ETag が付く");
  const r2 = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`, { headers: { "If-None-Match": etag } });
  assert.strictEqual(r2.status, 304, "未変化は304");
});

test("(g) /live 射影: 再コール系(call_count*/recall/called_at)を保持し内部列のみ除去(P4回帰)", async () => {
  const t = await adminPost("/api/tournaments", { name: "live-proj", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: "S", type: "singles", fee: 0 }] });
  for (const nm of ["山田 太郎", "鈴木 一"]) await adminPost(`/api/tournaments/${t.id}/entrants`, { event: "S", name: nm, status: "confirmed" });
  await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "S", regenerate: true });
  const list = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const m = list.find(x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  await adminPost(`/api/matches/${m.id}/finish`, { winner_slot: 1, sets: [[11, 5], [11, 7], [11, 9]] });
  const live = await fetch(BASE + `/api/public/tournaments/${t.id}/live`).then(r => r.json());
  const rf = (live.recent_finished || []).find(x => x.id === m.id);
  assert.ok(rf, "直近結果に終了試合がある");
  // 再コール系は /viewer/live がバッジ/呼出時刻に使う=保持(キーが存在すること。値0でも可)。
  // 実在カラムは call_count/call_count_p1/call_count_p2/called_at(recall_count列は存在しない)。
  ["call_count", "call_count_p1", "call_count_p2", "called_at"].forEach(k =>
    assert.ok(k in rf, `再コール列 ${k} は /live で保持`));
  // 表示列は維持
  ["winner_name", "player1_name", "sets", "status"].forEach(k => assert.ok(k in rf, `表示列 ${k} 維持`));
  // 内部列は除去
  ["referee_id", "winner_rating_delta", "loser_rating_delta", "next_match_id", "sets_json", "tournament_id"].forEach(k =>
    assert.ok(!(k in rf), `内部列 ${k} は /live から除去`));
});

test("(h) /api/lan-info: 端末接続用のURLとローカル生成QR(外部QR非依存)を返す", async () => {
  const info = await fetch(BASE + "/api/lan-info").then(r => r.json());
  assert.ok(typeof info.port === "number", "port を返す");
  assert.ok(Array.isArray(info.ips), "ips 配列");
  assert.ok(Array.isArray(info.urls), "urls 配列");
  if (info.ips.length) {
    const admin = info.urls.find(u => u.path === "admin");
    assert.ok(admin && /^http:\/\/[\d.]+:\d+\/admin$/.test(admin.url), "admin の LAN URL: " + (admin && admin.url));
    assert.ok(admin.qr && admin.qr.startsWith("<svg"), "ローカル生成のQR(SVG)が付く=外部QRサービス不要");
  }
});

test("(i) /api/sync/push: X-Sync-Key 認証で受信し公開ミラーを作る(誤キーは401)", async () => {
  const snap = {
    v: 1, tournament: { id: "synct-1", name: "同期テスト", date: "2027-01-01", venue: "本部", status: "ongoing" },
    matches: [{ id: "sm-1", tournament_id: "synct-1", event: "S", round: "決勝", round_order: 1, match_no: 1,
      bracket_round: 1, bracket_pos: 0, player1_name: "Ａ", player2_name: "Ｂ", winner_name: "Ａ", status: "completed",
      winner_id: "should-be-nulled", player1_entrant_id: "should-be-nulled" }],
  };
  // 鍵なし → 401
  const noKey = await fetch(BASE + "/api/sync/push", { method: "POST", headers: jhead, body: JSON.stringify(snap) });
  assert.strictEqual(noKey.status, 401, "鍵なしは401");
  // 誤キー → 401
  const badKey = await fetch(BASE + "/api/sync/push", { method: "POST", headers: { ...jhead, "X-Sync-Key": "wrong" }, body: JSON.stringify(snap) });
  assert.strictEqual(badKey.status, 401, "誤キーは401");
  // 正キー → 適用
  const ok = await fetch(BASE + "/api/sync/push", { method: "POST", headers: { ...jhead, "X-Sync-Key": "smoke-sync-key" }, body: JSON.stringify(snap) }).then(r => r.json());
  assert.ok(ok.ok && ok.tournament_id === "synct-1", "正キーで適用: " + JSON.stringify(ok));
  // 公開ミラーに反映され、FK(player id)は null 化されている
  const ms = await fetch(BASE + "/api/public/tournaments/synct-1/matches").then(r => r.json());
  const m = ms.find(x => x.id === "sm-1");
  assert.ok(m && m.winner_name === "Ａ", "勝者名が反映");
  // public /matches は内部FK列(winner_id/player1_entrant_id)を射影で出さないので、別途 admin で確認
  const am = await fetch(BASE + "/api/tournaments/synct-1/matches", { headers: akhead }).then(r => r.json());
  const am1 = (Array.isArray(am) ? am : am.matches || []).find(x => x.id === "sm-1");
  assert.strictEqual(am1.winner_id, null, "winner_id(FK)はnull化");
  assert.strictEqual(am1.player1_entrant_id, null, "player1_entrant_id(FK)はnull化");
});
