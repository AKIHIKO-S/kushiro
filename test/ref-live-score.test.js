// セットカウント速報 API (/api/ref/matches/:id/live-score) のHTTP層スモーク。
// server.js を実プロセスで起動し、認可(トークン/他大会/他コート)・状態ガード(on_table)・
// op_id冪等リプレイ・公開射影(/live に live が乗り /matches には乗らない)を fetch で検証する。
// 実行: node --test test/ref-live-score.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3928;
const KEY = "livescore-admin-key";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/ktta_reflive_" + process.pid + ".db";
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

const EV = "男子シングルス";
let _seq = 0;
// 大会を作り、審判入力ON・1試合をコート1へ呼出済みにしてトークンと試合IDを返す
async function setupTournament() {
  const t = await adminPost("/api/tournaments", { name: "reflive" + (++_seq), date: "2027-07-20" });
  await adminPut(`/api/tournaments/${t.id}/entry-settings`, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  for (const nm of ["速報 一郎", "速報 二郎", "速報 三郎", "速報 四郎"])
    await adminPost(`/api/tournaments/${t.id}/entrants`, { event: EV, name: nm, status: "confirmed" });
  await adminPost(`/api/tournaments/${t.id}/bracket`, { event: EV, regenerate: true });
  await adminPut(`/api/tournaments/${t.id}`, { status: "ongoing" });
  const tok = await adminPost(`/api/admin/tournaments/${t.id}/referee-token`, { enable: true });
  assert.ok(tok.referee_token || tok.token, "トークン発行: " + JSON.stringify(tok).slice(0, 120));
  const token = tok.referee_token || tok.token;
  const matches = await fetch(BASE + `/api/tournaments/${t.id}/matches`, { headers: akhead }).then(r => r.json());
  const real = matches.filter(m => m.event === EV && m.player1_name && m.player2_name &&
    m.player1_name !== "BYE" && m.player2_name !== "BYE" && m.status !== "completed");
  const called = await adminPost(`/api/matches/${real[0].id}/call`, { table_no: 1 });
  assert.ok(!called.error, "呼出成功: " + JSON.stringify(called).slice(0, 100));
  return { tid: t.id, token, onTableId: real[0].id, pendingId: real[1] && real[1].id };
}
function sendLive(mid, body) {
  return fetch(`${BASE}/api/ref/matches/${mid}/live-score`, {
    method: "POST", headers: jhead, body: JSON.stringify(body),
  }).then(r => r.json().then(j => ({ status: r.status, replay: r.headers.get("X-Idempotent-Replay") === "1", j })));
}

test("正常系: 共有トークンで速報を書け、/live の on_table と tables[].match に live が乗る", async () => {
  const { tid, token, onTableId } = await setupTournament();
  const r = await sendLive(onTableId, { t: token, s1: 2, s2: 1 });
  assert.strictEqual(r.status, 200, "200: " + JSON.stringify(r.j));
  assert.deepStrictEqual(r.j.live, { s1: 2, s2: 1 });
  const live = await fetch(BASE + `/api/public/tournaments/${tid}/live`).then(x => x.json());
  const ot = (live.on_table || []).find(m => m.id === onTableId);
  assert.ok(ot, "/live の on_table に載る");
  assert.deepStrictEqual(ot.live, { s1: 2, s2: 1 }, "パース済み live が観戦に届く");
  assert.ok(!("live_sets_json" in ot) && !("live_score_rev" in ot), "生JSON/revは配布しない");
  const cell = (live.tables || []).find(c => c.match && c.match.id === onTableId);
  assert.ok(cell && cell.match.live && cell.match.live.s1 === 2, "コート盤面(tables[].match)にも live が乗る");
});

test("公開 /matches: 進行中はパース済み live だけ乗り、生JSON/revは乗らない(観戦ボードの前提)", async () => {
  const { tid, token, onTableId, pendingId } = await setupTournament();
  await sendLive(onTableId, { t: token, s1: 1, s2: 0 });
  const pub = await fetch(BASE + `/api/public/tournaments/${tid}/matches`).then(x => x.json());
  const m = pub.find(x => x.id === onTableId);
  assert.ok(m, "公開matchesに試合はある");
  assert.deepStrictEqual(m.live, { s1: 1, s2: 0 }, "on_table にはパース済み live が乗る(観戦ボードが「● 台N 1-0」を出す)");
  assert.ok(!("live_sets_json" in m) && !("live_score_rev" in m),
    "生JSON/revは乗らない: " + Object.keys(m).filter(k => /live/.test(k)).join(","));
  const pend = pub.find(x => x.id === pendingId);
  assert.ok(pend && !("live" in pend), "進行中でない試合に live は付かない");
});

test("認可: トークン無し=403相当 / 他大会のトークン=403 / on_tableでない試合=409", async () => {
  const a = await setupTournament();
  const b = await setupTournament();
  const noTok = await sendLive(a.onTableId, { s1: 1, s2: 0 });
  assert.ok(noTok.status === 401 || noTok.status === 403, "トークン無しは拒否: " + noTok.status);
  const wrongT = await sendLive(a.onTableId, { t: b.token, s1: 1, s2: 0 });
  assert.strictEqual(wrongT.status, 403, "他大会トークンは403: " + JSON.stringify(wrongT.j));
  const pend = await sendLive(a.pendingId, { t: a.token, s1: 1, s2: 0 });
  assert.strictEqual(pend.status, 409, "コートに居ない試合は409: " + JSON.stringify(pend.j));
});

test("コート別トークン: 自コートのみ書ける(他コートは403)", async () => {
  const { tid, token, onTableId } = await setupTournament();
  const qr = await fetch(BASE + `/api/admin/tournaments/${tid}/referee-court-qr?courts=3`, { headers: akhead }).then(r => r.json());
  const court1 = qr.courts.find(c => c.court === 1);
  const court2 = qr.courts.find(c => c.court === 2);
  const ctOf = (url) => new URL(url).searchParams.get("ct");
  const ok = await sendLive(onTableId, { tid, court: 1, ct: ctOf(court1.url), s1: 1, s2: 1 });
  assert.strictEqual(ok.status, 200, "コート1トークンでコート1の試合に書ける: " + JSON.stringify(ok.j));
  const ng = await sendLive(onTableId, { tid, court: 2, ct: ctOf(court2.url), s1: 2, s2: 1 });
  assert.strictEqual(ng.status, 403, "コート2トークンでは書けない: " + JSON.stringify(ng.j));
});

test("op_id 冪等: 同一op_id再送はリプレイ応答(revが進まない)", async () => {
  const { tid, token, onTableId } = await setupTournament();
  const body = { t: token, s1: 1, s2: 0, op_id: "live-op-1" };
  const r1 = await sendLive(onTableId, body);
  assert.strictEqual(r1.status, 200);
  const fp1 = await fetch(BASE + `/api/public/tournaments/${tid}/ops-version`).then(x => x.json()).catch(() => null);
  const r2 = await sendLive(onTableId, body);
  assert.ok(r2.replay, "2回目はX-Idempotent-Replay");
  assert.deepStrictEqual(r2.j.live, { s1: 1, s2: 0 }, "前回応答がそのまま返る");
});

test("finish(承認込み)後は /live から速報が消え確定値に置き換わる", async () => {
  const { tid, token, onTableId } = await setupTournament();
  await sendLive(onTableId, { t: token, s1: 2, s2: 1 });
  // 本部が直接確定(承認フローの終点と同じ finishMatchOp 経由)
  const fin = await adminPost(`/api/matches/${onTableId}/finish`, { winner_slot: 1, sets: [[11, 5], [11, 7], [5, 11], [11, 9]] });
  assert.ok(!fin.error, "確定成功");
  const live = await fetch(BASE + `/api/public/tournaments/${tid}/live`).then(x => x.json());
  assert.ok(!(live.on_table || []).some(m => m.id === onTableId), "on_table から消える");
  const rec = (live.recent_finished || []).find(m => m.id === onTableId);
  assert.ok(rec, "recent_finished に確定値で載る");
  assert.strictEqual(rec.winner_sets, 3, "確定セット数");
  assert.ok(!rec.live, "確定行に速報は残らない");
});
