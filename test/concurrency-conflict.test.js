// 同時編集の衝突対策(楽観ロック)の回帰テスト。
//  Part A: 試合結果 finish — 完了済みに別勝者を確定しようとすると衝突を返し上書きしない(dbレベル)。
//  Part B: 記録編集 — 古い版(base_updated_at)での更新は 409、正しい版は200、未指定は後方互換で200(HTTP)。
// 実行: node --test test/concurrency-conflict.test.js
process.env.DB_PATH = "/tmp/ktta_conc_" + process.pid + ".db";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const db = require("../db");

// ── Part A: 試合結果 finish の同時編集衝突 (db レベル) ──
function setupMatch() {
  const t = db.createTournament({ name: "衝突検証", date: "2027-03-03" });
  const p1 = db.createPlayer({ name: "甲 一郎", team: "A" });
  const p2 = db.createPlayer({ name: "乙 二郎", team: "B" });
  const created = db.createMatch({ tournament_id: t.id, event: "男子シングルス", round: "決勝" });
  db.editMatch(created.id, { player1_id: p1.id, player2_id: p2.id, status: "pending", event: "男子シングルス", round: "決勝" });
  return { t, p1, p2, m: db.getMatch(created.id) };
}

test("finish: 同一勝者の再送は冪等(衝突にならない)", () => {
  const { m, p1 } = setupMatch();
  const r1 = db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  assert.ok(!r1.conflict, "1回目は確定");
  const r2 = db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  assert.ok(!r2.conflict, "同一勝者の再送は冪等(衝突なし)");
  assert.strictEqual(db.getMatch(m.id).winner_id, p1.id, "勝者は P1 のまま");
});

test("finish: 完了済みに別勝者を確定しようとすると衝突を返し、上書きしない", () => {
  const { m, p1 } = setupMatch();
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });   // P1勝ち
  const conf = db.finishMatchOp(m.id, { winner_slot: 2, sets: [[5, 11], [5, 11], [5, 11]] });
  assert.ok(conf && conf.conflict, "別勝者の二重確定は衝突を返す: " + JSON.stringify(conf));
  assert.strictEqual(db.getMatch(m.id).winner_id, p1.id, "衝突時は元の勝者(P1)を保持・上書きしない");
});

test("correct: 明示的な修正は従来どおり勝者を変更できる(衝突ガードに阻まれない)", () => {
  const { m, p2 } = setupMatch();
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  const r = db.correctResult(m.id, { winner_slot: 2, sets: [[5, 11], [5, 11], [5, 11]] });
  assert.ok(!r.error && !r.conflict, "修正は成功: " + JSON.stringify(r));
  assert.strictEqual(db.getMatch(m.id).winner_id, p2.id, "修正後は P2 が勝者");
});

// ── Part B: 記録編集の楽観ロック (HTTP) ──
const PORT = 3923;
const KEY = "conc-admin";
const BASE = `http://127.0.0.1:${PORT}`;
const DB2 = "/tmp/ktta_conc2_" + process.pid + ".db";
let srv;
const hdr = { "Content-Type": "application/json", "X-Admin-Key": KEY };

before(async () => {
  srv = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, DB_PATH: DB2, NODE_ENV: "test" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + "/api/health")).ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("server 起動失敗");
});
after(() => {
  if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
    try { fs.rmSync(DB2 + ext, { force: true }); } catch (e) {}
  }
});

async function createPlayer() {
  const r = await fetch(BASE + "/api/players", { method: "POST", headers: hdr, body: JSON.stringify({ name: "丙 三郎", team: "C" }) });
  return r.json();
}

test("OCC(内容): 編集対象フィールドが変わっている(base_fields不一致)と 409 で現在値を返す", async () => {
  const p = await createPlayer();   // name "丙 三郎"
  const r = await fetch(BASE + "/api/players/" + p.id, {
    method: "PUT", headers: hdr,
    body: JSON.stringify({ name: "丙 三郎(改)", team: "C",
      base_fields: { name: "別の名前(古い)", team: "C" } }),   // name の元値が現在と食い違う
  });
  assert.strictEqual(r.status, 409, "内容不一致は409");
  const j = await r.json();
  assert.ok(j.conflict && j.current && j.current.id === p.id, "競合+現在値: " + JSON.stringify(j));
});

test("OCC(内容): base_fields が現在値と一致すれば成功(200)", async () => {
  const p = await createPlayer();
  const cur = await (await fetch(BASE + "/api/players/" + p.id, { headers: hdr })).json();
  const r = await fetch(BASE + "/api/players/" + p.id, {
    method: "PUT", headers: hdr,
    body: JSON.stringify({ name: "丙 三郎(正)", team: "C",
      base_fields: { name: cur.name, team: cur.team || "" } }),
  });
  assert.strictEqual(r.status, 200, "内容一致は200: " + r.status);
});

test("OCC(内容): 版(updated_at)が機械更新で変わっても編集内容が同じなら誤検知しない(Eloチャーン耐性)", async () => {
  const p = await createPlayer();
  const cur = await (await fetch(BASE + "/api/players/" + p.id, { headers: hdr })).json();
  // base_fields は一致、しかし base_updated_at はわざと古い値 → 内容ベースが優先され 200(版churnを無視)
  const r = await fetch(BASE + "/api/players/" + p.id, {
    method: "PUT", headers: hdr,
    body: JSON.stringify({ name: "丙 三郎", team: "C",
      base_fields: { name: cur.name, team: cur.team || "" },
      base_updated_at: "1999-01-01 00:00:00" }),
  });
  assert.strictEqual(r.status, 200, "内容一致なら版違いでも200(Eloチャーンで誤409しない): " + r.status);
});

test("OCC(版・後方互換): base_fields無しで古い base_updated_at なら 409(版ベース経路=entrant等)", async () => {
  const p = await createPlayer();
  const r = await fetch(BASE + "/api/players/" + p.id, {
    method: "PUT", headers: hdr,
    body: JSON.stringify({ name: "丙", team: "C", base_updated_at: "1999-01-01 00:00:00" }),
  });
  assert.strictEqual(r.status, 409, "版ベース・古い版は409");
});

test("OCC: 版・内容とも未指定は従来どおり成功(後方互換)", async () => {
  const p = await createPlayer();
  const r = await fetch(BASE + "/api/players/" + p.id, {
    method: "PUT", headers: hdr,
    body: JSON.stringify({ name: "丙 三郎(無版)", team: "C" }),
  });
  assert.strictEqual(r.status, 200, "未指定は200(後方互換)");
});
