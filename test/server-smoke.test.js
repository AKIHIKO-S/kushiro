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
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, DB_PATH: DB, NODE_ENV: "test", SSE_MAX: "10", SYNC_KEY: "smoke-sync-key", SYNC_CLOUD_URL: "http://127.0.0.1:9", OWNER_KEY: "smoke-owner-key-2468" },
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

test("(a2) 公開 /matches の射影契約: next_match_id/next_slot は公開・内部列は落ちる", async () => {
  // #10 観戦のSVG罫線化: 観戦側が実配線どおりの山を描くため next_match_id/next_slot を公開する。
  // 一方で内部列(承認待ち・Elo差分・速報生JSON・呼出回数)は引き続き落ちることを同時に固定する。
  const t = await adminPost("/api/tournaments", { name: "smokeProj", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1,
    event_config: [{ name: "男子シングルス", type: "singles", fee: 0 }] });
  for (let i = 1; i <= 4; i++) await adminPost(`/api/tournaments/${t.id}/entrants`,
    { event: "男子シングルス", name: "射影" + i, team: "T" + i });
  await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "男子シングルス" });
  const ms = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  assert.ok(Array.isArray(ms) && ms.length >= 3, "公開matchesが返る");
  const r1 = ms.find(m => (m.bracket_round || 1) === 1);
  assert.ok(r1.next_match_id, "next_match_id が公開に含まれる(SVG罫線ボードの前提)");
  assert.ok(r1.next_slot === 1 || r1.next_slot === 2, "next_slot が公開に含まれる");
  ["pending_result", "winner_rating_delta", "live_sets_json", "live_score_rev",
   "call_count", "sets_json", "referee_id"].forEach(k =>
    assert.ok(!(k in r1), `内部列 ${k} は公開に含まれない`));
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

test("(c2) op_id 冪等: 同一 op_id の recall 二重送信で call_count が +1 のまま(オフライン再送対策)", async () => {
  const t = await adminPost("/api/tournaments", { name: "smoke-recall", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 0 }] });
  for (const nm of ["呼出 一郎", "呼出 二郎"]) await adminPost(`/api/tournaments/${t.id}/entrants`, { event: "男子シングルス", name: nm, status: "confirmed" });
  const gen = await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "男子シングルス", regenerate: true });
  assert.ok(gen.success, "ブラケット生成");
  await adminPut(`/api/tournaments/${t.id}`, { status: "ongoing" });   // 呼出は ongoing のみ可(#9)
  const matches = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const list = Array.isArray(matches) ? matches : (matches.matches || []);
  const m = list.find(x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  const called = await adminPost(`/api/matches/${m.id}/call`, { table_no: 1 });
  assert.ok(!called.error, "呼出成功: " + JSON.stringify(called).slice(0, 80));
  // 呼出(call)自体が call_count=1 を立てるため、再コール1回目後は 2 が正
  const body = { op_id: "smoke-recall-op-1" };
  const r1res = await fetch(BASE + `/api/matches/${m.id}/recall`, { method: "POST", headers: akhead, body: JSON.stringify(body) });
  const r1 = await r1res.json();
  const r2res = await fetch(BASE + `/api/matches/${m.id}/recall`, { method: "POST", headers: akhead, body: JSON.stringify(body) });
  const r2 = await r2res.json();
  assert.strictEqual(parseInt(r1.call_count) || 0, 2, "再コール1回目で call_count=2(呼出1+再コール1): " + JSON.stringify(r1).slice(0, 80));
  assert.strictEqual(r2res.headers.get("X-Idempotent-Replay"), "1", "2回目はリプレイ応答");
  assert.strictEqual(parseInt(r2.call_count) || 0, 2, "同一op_id再送でも call_count=2 のまま(+2しない)");
  // 別 op_id なら +1 される(対照=通常の再コールは機能する)
  const r3 = await adminPost(`/api/matches/${m.id}/recall`, { op_id: "smoke-recall-op-2" });
  assert.strictEqual(parseInt(r3.call_count) || 0, 3, "別op_idの再コールは +1 されて3");
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
  // 内部列は消えている(next_match_id/next_slot は #10 で公開に変更=下の維持リストへ移動)
  ["referee_id", "pending_result", "winner_rating_delta", "loser_rating_delta", "sets_json", "tournament_id", "created_at", "call_count"]
    .forEach(k => assert.ok(!(k in row), `内部列 ${k} が公開 /matches から除去`));
  // 表示に要る列は残っている(referee_name は viewer が「審判: X」で表示=公開意図)
  // referee_name は viewer が「審判: X」で表示する公開意図の列なので射影で残す(値は審判割当で入る)。
  // next_match_id/next_slot は観戦のSVG罫線ボードが実配線どおりの山を描くための公開列(#10)。
  ["referee_name", "sets", "winner_name", "player1_name", "status", "bracket_round", "next_match_id", "next_slot"]
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

test("(g2) /live callable: 待機理由(blocks/is_blocked)を射影し内部ID(locked_by_match)は除去", async () => {
  const t = await adminPost("/api/tournaments", { name: "live-blocks", date: "2027-01-02" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: "S", type: "singles", fee: 0 }] });
  for (const nm of ["甲 一", "乙 二", "丙 三", "丁 四"]) await adminPost(`/api/tournaments/${t.id}/entrants`, { event: "S", name: nm, status: "confirmed" });
  await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "S", regenerate: true });
  const live = await fetch(BASE + `/api/public/tournaments/${t.id}/live`).then(r => r.json());
  assert.ok((live.callable || []).length >= 1, "呼べる試合が射影される");
  const cb = live.callable[0];
  assert.ok("is_blocked" in cb && Array.isArray(cb.blocks), "callable に blocks/is_blocked を射影(待機理由表示用)");
  // 公開 live の block には内部の試合ID(locked_by_match)を含めない(観戦に不要・内部メタ最小化)。
  (live.callable || []).forEach(c => (c.blocks || []).forEach(b =>
    assert.ok(!("locked_by_match" in b), "公開liveのblockから locked_by_match を除去")));
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

test("(j) /api/sync/now: 進行中(ongoing)と準備中(preparation)の両方を同期対象に含む(綴り回帰)", async () => {
  // レビュー指摘: フィルタが "preparing"(誤) だと準備中大会が同期されなかった。正規値は "preparation"。
  const ong = await adminPost("/api/tournaments", { name: "進行中大会", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${ong.id}`, { status: "ongoing" });
  const prep = await adminPost("/api/tournaments", { name: "準備中大会", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${prep.id}`, { status: "preparation" });
  const sched = await adminPost("/api/tournaments", { name: "予定大会", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${sched.id}`, { status: "scheduled" });
  // SYNC_CLOUD_URL は到達不能なdummyなので各pushは失敗するが、対象(results)に含まれること自体を検証。
  const r = await adminPost("/api/sync/now", {});
  const ids = (r.results || []).map(x => x.id);
  assert.ok(ids.includes(ong.id), "進行中が同期対象");
  assert.ok(ids.includes(prep.id), "準備中(preparation)が同期対象=綴り修正の確認");
  assert.ok(!ids.includes(sched.id), "予定(scheduled)は対象外");
});

test("(k) /api/qr.svg: 公開ローカルQR(外部QR非依存)。SVGを返し長さ上限/空textを拒否", async () => {
  // 観戦ビュー共有などの非機密QRをローカル生成(api.qrserver.com 撤去の回帰)。
  const ok = await fetch(BASE + "/api/qr.svg?text=" + encodeURIComponent("http://example.com/live"));
  assert.strictEqual(ok.status, 200, "200で返る");
  assert.match(ok.headers.get("content-type") || "", /image\/svg\+xml/, "image/svg+xml");
  const body = await ok.text();
  assert.match(body, /<svg/, "SVGを返す");
  assert.ok(!body.includes("<script"), "SVGにscript無(安全)");
  // 空text/超長textは拒否
  assert.strictEqual((await fetch(BASE + "/api/qr.svg?text=")).status, 400, "空textは400");
  const long = "x".repeat(600);
  assert.strictEqual((await fetch(BASE + "/api/qr.svg?text=" + long)).status, 400, "512超は400");
});

test("(l) /api/admin/qr: 機密URL用QRは管理キー必須・SVGをJSONで返す", async () => {
  // 審判トークンを含むQRは公開エンドポイントのアクセスログに残さないため管理側で生成。
  const noKey = await fetch(BASE + "/api/admin/qr?text=" + encodeURIComponent("http://x/ref?t=SECRET"));
  assert.ok(noKey.status === 401 || noKey.status === 403, "キー無は拒否: " + noKey.status);
  const ok = await fetch(BASE + "/api/admin/qr?text=" + encodeURIComponent("http://x/ref?t=SECRET"), { headers: akhead }).then(r => r.json());
  assert.match(ok.svg || "", /<svg/, "管理キーでSVGを返す");
});

test("(m) コート別 審判QR: 審判入力ON時に各コートのローカルQR+到達可能なURL(localhost→LAN置換)を返す", async () => {
  const t = await adminPost("/api/tournaments", { name: "QR大会", date: "2027-01-01" });
  // 審判入力OFFのうちは400(先に有効化が必要)
  const off = await fetch(BASE + `/api/admin/tournaments/${t.id}/referee-court-qr`, { headers: akhead });
  assert.strictEqual(off.status, 400, "審判入力OFFは400");
  // 有効化(トークン自動発行)
  await adminPut(`/api/admin/tournaments/${t.id}/referee-input`, { enabled: true });
  const r = await fetch(BASE + `/api/admin/tournaments/${t.id}/referee-court-qr?courts=3`, { headers: akhead }).then(r => r.json());
  assert.strictEqual(r.count, 3, "指定枚数=3");
  assert.strictEqual((r.courts || []).length, 3, "3コート分");
  assert.match(r.courts[0].qr || "", /<svg/, "コートQRはローカルSVG");
  assert.ok(r.courts[0].url.includes("/ref?tid=") && r.courts[0].url.includes("&court=1") && r.courts[0].url.includes("&ct="),
    "URLは /ref?tid&court&ct 形式: " + r.courts[0].url);
  // localhost(127.0.0.1)アクセスは他端末から到達不能なため base を localhost のままにしない
  assert.ok(!/127\.0\.0\.1|localhost/.test(r.base), "baseはlocalhostでない(LAN IP置換): " + r.base);
  // コート別キーは別コートのキーでは通らない(自分のコート限定の契約)。?base= 明示も尊重
  const r2 = await fetch(BASE + `/api/admin/tournaments/${t.id}/referee-court-qr?courts=2&base=http://192.168.50.9:3000`, { headers: akhead }).then(r => r.json());
  assert.ok(r2.courts[0].url.startsWith("http://192.168.50.9:3000/ref?tid="), "?base=明示が反映");
});

test("(n) gas-stats プロキシは requireAdmin(未認証拒否)・URL未設定は400 (#5 踏み台化対策)", async () => {
  const t = await adminPost("/api/tournaments", { name: "GAS大会", date: "2027-01-01" });
  // 管理キー無しは拒否(出口プロキシ踏み台化の遮断)
  const noKey = await fetch(BASE + `/api/tournaments/${t.id}/gas-stats?gas_url=https://script.google.com/x`);
  assert.ok(noKey.status === 401 || noKey.status === 503, "未認証は拒否: " + noKey.status);
  // 認証あり・entry_gas_url 未設定・client gas_url も無し → 400(URL必須)
  const noUrl = await fetch(BASE + `/api/tournaments/${t.id}/gas-stats`, { headers: akhead });
  assert.strictEqual(noUrl.status, 400, "URL未設定は400");
  // 非 script.google.com ホストは拒否(SSRF固定の回帰)
  const bad = await fetch(BASE + `/api/tournaments/${t.id}/gas-stats?gas_url=` + encodeURIComponent("https://evil.example.com/x"), { headers: akhead });
  assert.strictEqual(bad.status, 400, "別ホストは400");
});

test("(o) push subscribe は endpoint を検証(http/生IP/内部は拒否・既知プッシュhostのみ許可 / #8 SSRF)", async () => {
  const sub = (ep) => fetch(BASE + "/api/push/subscribe", { method: "POST", headers: jhead,
    body: JSON.stringify({ player_id: 1, subscription: { endpoint: ep, keys: { p256dh: "x", auth: "y" } } }) }).then(r => r.json().then(j => ({ status: r.status, j })));
  const http = await sub("http://fcm.googleapis.com/x");
  assert.ok(/不正/.test(http.j.error || ""), "httpは拒否: " + JSON.stringify(http.j));
  const ip = await sub("https://10.0.0.5/x");
  assert.ok(/不正/.test(ip.j.error || ""), "生IPは拒否");
  const localhost = await sub("https://localhost/x");
  assert.ok(/不正/.test(localhost.j.error || ""), "localhostは拒否");
  const evil = await sub("https://evil.example.com/x");
  assert.ok(/不正/.test(evil.j.error || ""), "未知hostは拒否");
  // 既知プッシュhostは endpoint 検証を通過する(=エンドポイント不正エラーにはならない)
  const fcm = await sub("https://fcm.googleapis.com/fcm/send/abc123");
  assert.ok(!/エンドポイントが不正/.test(fcm.j.error || ""), "FCM host は通過: " + JSON.stringify(fcm.j));
});

// (p) 同期の鍵総当たりロックアウト試験は test/sync-lock.test.js に隔離(127.0.0.1 の失敗カウンタを
// ロックし、同一サーバを共有する (i)/(j) を 429 で汚染するため。独立プロセスで実行する)。

// ── オーナー(上級管理者)権限: 危険操作を ADMIN_KEY の上の OWNER_KEY へ隔離 ──
const OKEY = "smoke-owner-key-2468";
// 実施者名(日本語)はヘッダ(latin1)に直接入れられない。POST はボディ operator で運ぶ。
const ohead = { ...jhead, "X-Owner-Key": OKEY };

test("(q) オーナー権限: 危険操作は管理キーでは拒否され、オーナーキーで通る (隔離の契約)", async () => {
  // export/all は requireOwner へ昇格 → 管理キーだけでは 401
  const withAdmin = await fetch(BASE + "/api/export/all", { headers: akhead });
  assert.strictEqual(withAdmin.status, 401, "管理キーのみの export/all は拒否(オーナーへ昇格): " + withAdmin.status);
  // 誤ったオーナーキーは 401
  const wrong = await fetch(BASE + "/api/export/all", { headers: { "X-Owner-Key": "WRONG" } });
  assert.strictEqual(wrong.status, 401, "誤オーナーキーは401");
  // 正しいオーナーキーで通る
  const ok = await fetch(BASE + "/api/export/all", { headers: { "X-Owner-Key": OKEY } });
  assert.strictEqual(ok.status, 200, "正オーナーキーで export/all 200");
  // verify エンドポイント
  const v = await fetch(BASE + "/api/owner/verify", { headers: { "X-Owner-Key": OKEY } }).then(r => r.json());
  assert.ok(v.ok, "owner/verify ok");
});

test("(r) オーナー DB保存: .db を一貫スナップショットで返す(SQLiteヘッダ)", async () => {
  const res = await fetch(BASE + "/api/owner/db-download", { headers: { "X-Owner-Key": OKEY, "X-Owner-Operator": encodeURIComponent("保存太郎") } });
  assert.strictEqual(res.status, 200, "200で返る");
  const buf = Buffer.from(await res.arrayBuffer());
  assert.strictEqual(buf.slice(0, 15).toString("latin1"), "SQLite format 3", "SQLiteファイルを返す");
  assert.ok(buf.length > 1000, "中身がある");
});

test("(s) オーナー 全選手削除: 実施者名と件数の打鍵確認が必須・実行で自動バックアップ＋監査記録", async () => {
  // 選手を2人作る
  await adminPost("/api/players", { name: "削除対象A", team: "X" });
  await adminPost("/api/players", { name: "削除対象B", team: "X" });
  const before = await fetch(BASE + "/api/players").then(r => r.json());
  const total = before.length;
  assert.ok(total >= 2, "選手が居る: " + total);
  // 実施者名なし → 400
  const noOp = await fetch(BASE + "/api/owner/players/delete-all", { method: "POST",
    headers: { ...jhead, "X-Owner-Key": OKEY }, body: JSON.stringify({ confirm: total }) }).then(r => ({ s: r.status }));
  assert.strictEqual(noOp.s, 400, "実施者名なしは400");
  // 件数間違い → 400 (実施者名はボディで渡し、件数チェックを単独で検証)
  const badCount = await fetch(BASE + "/api/owner/players/delete-all", { method: "POST",
    headers: ohead, body: JSON.stringify({ confirm: total + 99, operator: "テスト実施者" }) }).then(r => ({ s: r.status }));
  assert.strictEqual(badCount.s, 400, "件数不一致は400");
  // 正しく削除 → ok + backup名 + 監査
  const ok = await fetch(BASE + "/api/owner/players/delete-all", { method: "POST",
    headers: ohead, body: JSON.stringify({ confirm: total, operator: "テスト実施者" }) }).then(r => r.json());
  assert.ok(ok.ok && ok.deleted === total && ok.backup, "削除成功+自動バックアップ: " + JSON.stringify(ok));
  const after = await fetch(BASE + "/api/players").then(r => r.json());
  assert.strictEqual(after.length, 0, "全選手が消えた");
  // 監査ログに players_delete_all + 実施者名
  const audit = await fetch(BASE + "/api/owner/audit", { headers: { "X-Owner-Key": OKEY } }).then(r => r.json());
  const ev = (audit.log || []).find(e => e.action === "players_delete_all");
  assert.ok(ev && ev.operator === "テスト実施者", "監査に削除と実施者が記録: " + JSON.stringify(ev));
});

test("(t) 機密.dbの送出は共有キャッシュ禁止(no-store)で硬化されている", async () => {
  // 全PIIを含む .db が中間キャッシュに残らないこと(snapshots/download と owner/db-download 両経路)。
  const mk = await fetch(BASE + "/api/admin/snapshots", { method: "POST", headers: { ...jhead, "X-Owner-Key": OKEY }, body: "{}" }).then(r => r.json());
  assert.ok(mk && mk.name, "スナップショット作成: " + JSON.stringify(mk));
  const dl = await fetch(BASE + "/api/admin/snapshots/download", { method: "POST",
    headers: { ...jhead, "X-Owner-Key": OKEY }, body: JSON.stringify({ name: mk.name }) });
  assert.strictEqual(dl.status, 200, "DL 200");
  assert.match(dl.headers.get("cache-control") || "", /no-store/, "snapshots/download は no-store");
  const dl2 = await fetch(BASE + "/api/owner/db-download", { headers: { "X-Owner-Key": OKEY } });
  assert.match(dl2.headers.get("cache-control") || "", /no-store/, "owner/db-download は no-store");
});

test("(u) 対戦の呼出は大会が ongoing のときだけ許可される(#9)", async () => {
  const t = await adminPost("/api/tournaments", { name: "呼出ガード", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 0 }] });
  for (const nm of ["呼出 太郎", "呼出 次郎"]) await adminPost(`/api/tournaments/${t.id}/entrants`, { event: "男子シングルス", name: nm, status: "confirmed" });
  await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "男子シングルス", regenerate: true });
  const list = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const arr = Array.isArray(list) ? list : (list.matches || []);
  const m = arr.find(x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE" && x.status === "pending");
  assert.ok(m, "pendingの実戦がある");
  // 既定は scheduled(進行中でない) → 呼出は拒否
  const denied = await adminPost(`/api/matches/${m.id}/call`, { table_no: 1 });
  assert.ok(denied.error && /進行中/.test(denied.error), "進行中でないと呼出拒否: " + JSON.stringify(denied).slice(0, 100));
  // 進行中にすると呼べる
  await adminPut(`/api/tournaments/${t.id}`, { status: "ongoing" });
  const ok = await adminPost(`/api/matches/${m.id}/call`, { table_no: 1 });
  assert.ok(!ok.error, "ongoing なら呼出成功: " + JSON.stringify(ok).slice(0, 100));
  const after = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const aarr = Array.isArray(after) ? after : (after.matches || []);
  assert.strictEqual(aarr.find(x => x.id === m.id).status, "on_table", "呼出後は on_table");
});

test("(v) プッシュ/マイ選手 管理: 一覧(名前付き)・個別/一括送信・強制削除 (#7/#10)", async () => {
  // 選手を作成 → その選手番号でプッシュ購読(マイ選手登録)
  const p = await adminPost("/api/players", { name: "通知 花子", team: "Z中" });
  const pid = p.id || (p.player && p.player.id);
  assert.ok(pid, "選手作成: " + JSON.stringify(p).slice(0, 80));
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/smoke-" + pid, keys: { p256dh: "BTestKeyNotReal0000000000000000000000000000000000000000000000000000000000000000000000000", auth: "authtest0000000000000000" } };
  const subRes = await fetch(BASE + "/api/push/subscribe", { method: "POST", headers: jhead, body: JSON.stringify({ player_id: pid, subscription: sub }) }).then(r => r.json());
  assert.ok(subRes.ok, "購読登録: " + JSON.stringify(subRes));
  // 一覧に名前付きで出る
  const listed = await fetch(BASE + "/api/admin/push/players", { headers: akhead }).then(r => r.json());
  const row = (listed.players || []).find(x => x.id === pid);
  assert.ok(row && row.name === "通知 花子" && row.devices >= 1, "名前付き一覧: " + JSON.stringify(row));
  // 個別送信(本文必須) — 実配信は失敗してもエンドポイントはok+端末数を返す
  const noBody = await adminPost(`/api/admin/push/players/${pid}/send`, { title: "x" });
  assert.ok(noBody.error, "本文なしは拒否");
  const sent = await adminPost(`/api/admin/push/players/${pid}/send`, { title: "招集", body: "至急本部へ" });
  // devices は実配信成功数(fakeエンドポイントは配信失敗するため0でも正)。エンドポイントの成否のみ検証。
  assert.ok(sent.ok && typeof sent.devices === "number", "個別送信ok: " + JSON.stringify(sent));
  // 一括送信
  const bc = await adminPost("/api/admin/push/broadcast", { title: "全体連絡", body: "雨天のため順延" });
  assert.ok(bc.ok && bc.players >= 1, "一括送信ok: " + JSON.stringify(bc));
  // 強制削除
  const del = await fetch(BASE + `/api/admin/push/players/${pid}`, { method: "DELETE", headers: akhead }).then(r => r.json());
  assert.ok(del.ok && del.removed >= 1, "強制削除ok: " + JSON.stringify(del));
  const after = await fetch(BASE + "/api/admin/push/players", { headers: akhead }).then(r => r.json());
  assert.ok(!(after.players || []).find(x => x.id === pid), "削除後は一覧から消える");
});

test("(w) 審判の割当/解放で ops フィンガープリントが変化する(他端末へSSE反映 #1/#9レビュー)", async () => {
  const t = await adminPost("/api/tournaments", { name: "審判FP", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 0 }] });
  for (const nm of ["甲 太郎", "乙 次郎"]) await adminPost(`/api/tournaments/${t.id}/entrants`, { event: "男子シングルス", name: nm, status: "confirmed" });
  await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "男子シングルス", regenerate: true });
  const list = await fetch(BASE + `/api/public/tournaments/${t.id}/matches`).then(r => r.json());
  const arr = Array.isArray(list) ? list : (list.matches || []);
  const m = arr.find(x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  assert.ok(m, "実戦の試合がある");
  const v1 = (await fetch(BASE + `/api/public/tournaments/${t.id}/ops-version`).then(r => r.json())).v;
  // 審判を割当 → フィンガープリント変化
  await adminPost(`/api/matches/${m.id}/referee`, { referee_name: "テスト審判" });
  const v2 = (await fetch(BASE + `/api/public/tournaments/${t.id}/ops-version`).then(r => r.json())).v;
  assert.notStrictEqual(v2, v1, "審判割当でフィンガープリント変化(SSE差分検知される)");
  // 解放 → さらに変化
  await adminPost(`/api/matches/${m.id}/referee`, { referee_id: null });
  const v3 = (await fetch(BASE + `/api/public/tournaments/${t.id}/ops-version`).then(r => r.json())).v;
  assert.notStrictEqual(v3, v2, "審判解放でもフィンガープリント変化");
});

test("(x) 公開 entrant 一覧は連絡先PII(contact_*/note/submission_id)を除去する (stripEntrantPII契約)", async () => {
  const t = await adminPost("/api/tournaments", { name: "entrantPII", date: "2027-01-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 0 }] });
  // 連絡先PII付きの出場者を作成(申込原本相当の構造化列)。
  const PII = { contact_name: "保護者ハナコ", contact_email: "guardian@example.com", contact_tel: "090-1234-5678", note: "内部メモ:アレルギー有" };
  const e = await adminPost(`/api/tournaments/${t.id}/entrants`, { event: "男子シングルス", name: "選手 太郎", status: "confirmed", ...PII });
  assert.ok(e && e.id, "entrant 作成: " + JSON.stringify(e).slice(0, 80));

  // 公開(未認証)一覧 → PII の値もキーも出ない
  const pubList = await fetch(BASE + `/api/public/tournaments/${t.id}/entrants`).then(r => r.json());
  const ps = JSON.stringify(pubList);
  ["保護者ハナコ", "guardian@example.com", "090-1234-5678", "アレルギー"].forEach(v =>
    assert.ok(!ps.includes(v), `公開一覧に PII "${v}" が漏れない`));
  const row = (Array.isArray(pubList) ? pubList : []).find(x => x.name === "選手 太郎") || {};
  assert.ok(row.name === "選手 太郎", "出場者自体は公開一覧に出る(名前はブラケット公開情報)");
  ["contact_name", "contact_email", "contact_tel", "note", "submission_id"].forEach(k =>
    assert.ok(!(k in row), `公開 entrant に秘匿キー ${k} が存在しない`));

  // 認証(admin)側の生 entrant には連絡先が含まれる = 除去は公開側だけ(契約の片側)。
  const adminRaw = await fetch(BASE + `/api/entrants/${e.id}`, { headers: akhead }).then(r => r.json());
  assert.strictEqual(adminRaw.contact_email, "guardian@example.com", "管理(認証)側では連絡先が見える=公開側だけ除去");
});

test("(t) 名簿取込 /roster/commit が open フラグを転送する(エントリーリスト=オープン大会のSS必須が効く)", async () => {
  const t = await adminPost("/api/tournaments", { name: "roster-http", date: "2027-11-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [] });
  const entries = [
    { type: "singles", event: "男子シングルス", name: "甲 太郎", team: "遠征ク", region: "帯広", gender: "male", division: "一般" },
    { type: "singles", event: "男子シングルス", name: "乙 次郎", team: "月ク", region: "北見", gender: "male", division: "一般" },
    { type: "singles", event: "男子シングルス", name: "丙 三郎", team: "空ク", region: "根室", gender: "male", division: "一般" },
    { type: "singles", event: "男子シングルス", name: "丁 四郎", team: "海ク", region: "札幌", gender: "male", division: "一般" },
  ];
  // open:true を HTTP で送る → event_config に open が付き、SS必須の readiness block が出る
  const r = await adminPost(`/api/tournaments/${t.id}/roster/commit`, { mode: "direct", open: true, entries });
  assert.ok(r.ok && r.created === 4, "取込成功: " + JSON.stringify(r));
  const rdy = await fetch(BASE + `/api/tournaments/${t.id}/bracket/draw-readiness?event=${encodeURIComponent("男子シングルス")}`, { headers: akhead }).then(x => x.json());
  assert.ok((rdy.issues || []).some(i => i.code === "open_needs_super_seed"), "open転送でSS必須blockが発火(critical回帰防止): " + JSON.stringify(rdy.issues));
  // open:false(未指定)なら SS必須は付かない
  const t2 = await adminPost("/api/tournaments", { name: "roster-http2", date: "2027-11-02" });
  await adminPut(`/api/tournaments/${t2.id}/entry-settings`, { entries_open: 1, event_config: [] });
  await adminPost(`/api/tournaments/${t2.id}/roster/commit`, { mode: "direct", entries });
  const rdy2 = await fetch(BASE + `/api/tournaments/${t2.id}/bracket/draw-readiness?event=${encodeURIComponent("男子シングルス")}`, { headers: akhead }).then(x => x.json());
  assert.ok(!(rdy2.issues || []).some(i => i.code === "open_needs_super_seed"), "open未指定はSS必須なし");
});

test("(u) 名簿取込→POST /bracket が entrant_ids で生成でき、DELETE /bracket は表だけ削除(名簿は残す)", async () => {
  const t = await adminPost("/api/tournaments", { name: "gen-http", date: "2027-12-01" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [] });
  const entries = [];
  for (let i = 1; i <= 6; i++) entries.push({ type: "singles", event: "男子シングルス", name: "選手" + i, team: "ク" + i, gender: "male", division: "一般" });
  const imp = await adminPost(`/api/tournaments/${t.id}/roster/commit`, { mode: "direct", entries });
  assert.ok(imp.ok && imp.created === 6, "取込6: " + JSON.stringify(imp));
  // entrant_ids を取得して POST /bracket(旧player_ids不要=バグ修正)
  const ents = await fetch(BASE + `/api/tournaments/${t.id}/entrants`, { headers: akhead }).then(r => r.json());
  const ids = ents.filter(e => e.event === "男子シングルス").map(e => e.id);
  assert.strictEqual(ids.length, 6, "出場者6名");
  const g = await adminPost(`/api/tournaments/${t.id}/bracket`, { event: "男子シングルス", entrant_ids: ids, regenerate: true });
  assert.ok(!g.error && g.total_matches > 0, "entrant_idsで生成: " + JSON.stringify(g));
  // DELETE /bracket: 表だけ削除→matches 0・entrants 残存
  const del = await fetch(BASE + `/api/tournaments/${t.id}/bracket?event=${encodeURIComponent("男子シングルス")}`, { method: "DELETE", headers: akhead }).then(r => r.json());
  assert.ok(del.ok, "表削除: " + JSON.stringify(del));
  const after = await fetch(BASE + `/api/tournaments/${t.id}/bracket?event=${encodeURIComponent("男子シングルス")}`, { headers: akhead }).then(r => r.json());
  const matchCount = (after.matches || after.rounds || []).length;
  assert.ok(!matchCount || matchCount === 0, "表は削除された");
  const entsAfter = await fetch(BASE + `/api/tournaments/${t.id}/entrants`, { headers: akhead }).then(r => r.json());
  assert.strictEqual(entsAfter.filter(e => e.event === "男子シングルス").length, 6, "名簿は残る(6名)");
});
