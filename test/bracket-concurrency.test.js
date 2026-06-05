// 抽選・組合せ編集の同時作業対策(ブラケット楽観ロック)の回帰テスト。
//  Part A: db.bracketRev — 変化が無ければ安定、generate で変わる(版フィンガープリントの核)。
//  Part B: ルート — 古い base_rev での生成/抽選は 409(同時作業ガード)、正しい版なら200、未指定は後方互換。
// 実行: node --test test/bracket-concurrency.test.js
process.env.DB_PATH = "/tmp/ktta_brrev_" + process.pid + ".db";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const db = require("../db");

const EV = "男子シングルス";

// ── Part A: db.bracketRev の挙動 ──
test("bracketRev: 変化が無ければ安定し、generate で変わる", () => {
  const t = db.createTournament({ name: "版検証", date: "2027-05-05" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= 4; i++) entries.push({ event: EV, type: "singles", name: "選手" + i, team: "T" + i });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  const ents = db.getEntrants(t.id, EV);
  ents.forEach((e, i) => db.setEntrantSeed(e.id, i + 1));

  const rev0 = db.bracketRev(t.id, EV);
  assert.strictEqual(db.bracketRev(t.id, EV), rev0, "変化無しなら同じ版");
  assert.match(rev0, /^0:/, "未生成は件数0: " + rev0);

  db.generateBracket(t.id, EV, { regenerate: true });
  const rev1 = db.bracketRev(t.id, EV);
  assert.notStrictEqual(rev1, rev0, "generate で版が変わる(" + rev0 + " → " + rev1 + ")");
});

test("bracketRev: 進出を伴わない結果入力では版が変わらない(構造のみ=結果/台呼出で偽409しない)", () => {
  const t = db.createTournament({ name: "版・結果不変", date: "2027-05-07" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp",
    entries: [{ event: EV, type: "singles", name: "甲", team: "A" }, { event: EV, type: "singles", name: "乙", team: "B" }] });
  const ents = db.getEntrants(t.id, EV);
  ents.forEach((e, i) => db.setEntrantSeed(e.id, i + 1));
  db.generateBracket(t.id, EV, { regenerate: true });
  const ms = db.getMatchesByTournament(t.id).filter(m => m.event === EV);
  assert.strictEqual(ms.length, 1, "2人は1試合(決勝・次戦なし)");
  const revBefore = db.bracketRev(t.id, EV);
  db.finishMatchOp(ms[0].id, { winner_slot: 1, sets: [[11, 5], [11, 5], [11, 5]] });
  const revAfter = db.bracketRev(t.id, EV);
  assert.strictEqual(revAfter, revBefore, "進出なしの結果入力では組合せ版は不変(winner/status除外): " + revBefore + " vs " + revAfter);
});

// ── Part B: ルートの同時作業ガード(409) ──
const PORT = 3924;
const KEY = "brrev-admin";
const BASE = `http://127.0.0.1:${PORT}`;
const DB2 = "/tmp/ktta_brrev2_" + process.pid + ".db";
let srv;
const hdr = { "Content-Type": "application/json", "X-Admin-Key": KEY };
const jpost = (url, body) => fetch(BASE + url, { method: "POST", headers: hdr, body: JSON.stringify(body || {}) });

before(async () => {
  srv = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, DB_PATH: DB2, NODE_ENV: "test" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/api/health")).ok) return; } catch (e) {} await new Promise(r => setTimeout(r, 150)); }
  throw new Error("server 起動失敗");
});
after(() => {
  if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
    try { fs.rmSync(DB2 + ext, { force: true }); } catch (e) {}
  }
});

test("ルート: 古い base_rev での生成は 409(同時作業ガード)、正しい版なら200、未指定は後方互換", async () => {
  const t = await (await jpost("/api/tournaments", { name: "版ガード", date: "2027-05-06" })).json();
  for (let i = 1; i <= 4; i++) {
    await jpost(`/api/tournaments/${t.id}/entrants`, { event: EV, type: "singles", name: "選手" + i, team: "T" + i, seed: i, status: "confirmed" });
  }
  // 初回生成(空=「0:」から)
  const g1 = await jpost(`/api/tournaments/${t.id}/bracket/generate`, { event: EV });
  assert.strictEqual(g1.status, 200, "初回生成200: " + g1.status);
  const j1 = await g1.json();
  assert.ok(j1.bracket_rev, "応答に bracket_rev: " + JSON.stringify(j1).slice(0, 140));

  // 現在版を取得
  const rev = (await (await fetch(BASE + `/api/tournaments/${t.id}/bracket/rev?event=${encodeURIComponent(EV)}`, { headers: hdr })).json()).bracket_rev;
  assert.ok(rev && rev !== "0:", "rev取得: " + rev);

  // 古い版(0:)で再生成 → 409
  const stale = await jpost(`/api/tournaments/${t.id}/bracket/generate`, { event: EV, regenerate: true, force: true, base_rev: "0:" });
  assert.strictEqual(stale.status, 409, "古い版は409: " + stale.status);
  assert.ok((await stale.json()).conflict, "conflictフラグ");

  // 正しい版で再生成 → 200
  const ok = await jpost(`/api/tournaments/${t.id}/bracket/generate`, { event: EV, regenerate: true, force: true, base_rev: rev });
  assert.strictEqual(ok.status, 200, "正しい版は200: " + ok.status);

  // base_rev 未指定は従来どおり 200(後方互換)
  const compat = await jpost(`/api/tournaments/${t.id}/bracket/generate`, { event: EV, regenerate: true, force: true });
  assert.strictEqual(compat.status, 200, "版未指定は200(後方互換)");

  // 旧 POST /bracket(生成・"/generate"無し)も同時作業ガード対象
  const legacyStale = await jpost(`/api/tournaments/${t.id}/bracket`, { event: EV, base_rev: "0:" });
  assert.strictEqual(legacyStale.status, 409, "旧 /bracket 生成も古い版は409: " + legacyStale.status);
  const legacyCompat = await jpost(`/api/tournaments/${t.id}/bracket`, { event: EV, regenerate: true, force: true });
  assert.notStrictEqual(legacyCompat.status, 409, "旧 /bracket 版未指定は409にしない(後方互換): " + legacyCompat.status);
});
