// 公開APIの選手サニタイズ契約: note(内部メモ)・rating(Elo非公開方針)・内部管理列が
// 認証なしレスポンスに露出しないことを実サーバ(サブプロセス)+fetch で固定する。
// 背景: 2026-07-17 実測で GET /api/public/players/:id が note/rating/created_at を返していた。
// 実行: node --test test/public-player-sanitize.test.js
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3917;
const KEY = "sanitize-admin-key-abc";
const BASE = `http://127.0.0.1:${PORT}`;
const DB = "/tmp/ktta_sanitize_" + process.pid + ".db";
let srv;

const jhead = { "Content-Type": "application/json" };
const akhead = { ...jhead, "X-Admin-Key": KEY };
const adminPost = (p, b) => fetch(BASE + p, { method: "POST", headers: akhead, body: JSON.stringify(b) }).then(r => r.json());
const pubGet = (p) => fetch(BASE + p).then(r => r.json());

const EV = "男子シングルス";
let playerA, playerB, tour;

before(async () => {
  srv = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, DB_PATH: DB, NODE_ENV: "test", SSE_MAX: "10" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + "/api/health"); if (r.ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  // 内部メモつき選手2名 → 大会 → 2名で表生成 → 1試合確定(=公開の戦績・検索に載る)
  playerA = await adminPost("/api/players", { name: "佐藤機密", furigana: "さとうきみつ", team: "釧路ク", gender: "male", note: "MEMO-KANMOKU-A(怪我情報)" });
  playerB = await adminPost("/api/players", { name: "鈴木機密", furigana: "すずききみつ", team: "帯広ク", gender: "male", note: "MEMO-KANMOKU-B" });
  assert.ok(playerA.id && playerB.id, "選手作成");
  tour = await adminPost("/api/tournaments", { name: "sanitize検証", date: "2027-02-01" });
  assert.ok(tour.id, "大会作成");
  const e1 = await adminPost(`/api/tournaments/${tour.id}/entrants`, { event: EV, name: playerA.name, team: playerA.team, furigana: playerA.furigana, player_id: playerA.id });
  const e2 = await adminPost(`/api/tournaments/${tour.id}/entrants`, { event: EV, name: playerB.name, team: playerB.team, furigana: playerB.furigana, player_id: playerB.id });
  assert.ok(e1.id && e2.id, "entrant作成");
  const gen = await adminPost(`/api/tournaments/${tour.id}/bracket/generate`, { event: EV });
  assert.ok(gen && !gen.error, "表生成: " + JSON.stringify(gen).slice(0, 120));
  const ms = await fetch(BASE + `/api/tournaments/${tour.id}/matches`, { headers: akhead }).then(r => r.json());
  const m = (Array.isArray(ms) ? ms : ms.matches || []).find(x => x.event === EV);
  assert.ok(m, "試合が存在");
  const fin = await adminPost(`/api/matches/${m.id}/finish`, { winner_slot: 1, sets: [[11, 5], [11, 7], [11, 3]] });
  assert.ok(fin && !fin.error, "確定: " + JSON.stringify(fin).slice(0, 120));
});

after(() => {
  if (srv) try { srv.kill("SIGKILL"); } catch (e) {}
  for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(DB + ext, { force: true }); } catch (e) {}
});

const NG_PLAYER_KEYS = ["note", "rating", "merged_into", "created_at", "updated_at"];

test("公開選手一覧: 内部列が全行から消えている(表示用の集計列は残る)", async () => {
  const rows = await pubGet("/api/public/players");
  assert.ok(Array.isArray(rows) && rows.length >= 2, "一覧が返る");
  for (const r of rows) NG_PLAYER_KEYS.forEach(k => assert.ok(!(k in r), `一覧に ${k} が無い`));
  const a = rows.find(r => r.id === playerA.id);
  assert.ok(a && a.name === playerA.name && "match_wins" in a, "name/集計列は残る");
  assert.ok(!JSON.stringify(rows).includes("MEMO-KANMOKU"), "内部メモの値が一覧のどこにも出ない");
});

test("公開選手詳細: 内部列が消え、戦績(matches)からも内部列が消える。tournament_id と sets は残る", async () => {
  const p = await pubGet("/api/public/players/" + playerA.id);
  NG_PLAYER_KEYS.forEach(k => assert.ok(!(k in p), `詳細に ${k} が無い`));
  assert.ok(Array.isArray(p.achievements) && Array.isArray(p.affiliations) && p.level_stats, "公開機能の列は残る");
  assert.ok(Array.isArray(p.matches) && p.matches.length >= 1, "戦績が載る");
  for (const m of p.matches) {
    ["referee_id", "pending_result", "winner_rating_delta", "loser_rating_delta",
     "sets_json", "live_sets_json", "live_score_rev", "call_count", "called_at"].forEach(k =>
      assert.ok(!(k in m), `戦績行に ${k} が無い`));
    assert.ok("tournament_id" in m, "出場大会数の集計に使う tournament_id は残る");
    assert.ok(Array.isArray(m.sets), "パース済み sets は残る");
  }
  assert.ok(!JSON.stringify(p).includes("MEMO-KANMOKU"), "内部メモの値が詳細のどこにも出ない");
});

test("公開グローバル検索(/api/public/search): サニタイズされる", async () => {
  const rows = await pubGet("/api/public/search?q=" + encodeURIComponent("機密"));
  assert.ok(Array.isArray(rows) && rows.length >= 2, "検索が返る");
  for (const r of rows) NG_PLAYER_KEYS.forEach(k => assert.ok(!(k in r), `検索結果に ${k} が無い`));
});

test("公開試合検索(/api/public/matches): 内部列が消え sets/tournament_id は残る", async () => {
  const d = await pubGet("/api/public/matches?player_name=" + encodeURIComponent("佐藤機密"));
  assert.ok(d && Array.isArray(d.matches) && d.matches.length >= 1, "検索結果が返る");
  for (const m of d.matches) {
    ["referee_id", "pending_result", "winner_rating_delta", "loser_rating_delta", "sets_json"].forEach(k =>
      assert.ok(!(k in m), `検索行に ${k} が無い`));
    assert.ok("tournament_id" in m && Array.isArray(m.sets), "tournament_id/sets は残る");
  }
});

test("管理GET(/api/players, /api/players/:id)は認可必須になり、鍵ありでは生データ(note)が読める", async () => {
  const noKeyList = await fetch(BASE + "/api/players");
  assert.ok([401, 403].includes(noKeyList.status), "鍵なし一覧は拒否: " + noKeyList.status);
  const noKeyOne = await fetch(BASE + "/api/players/" + playerA.id);
  assert.ok([401, 403].includes(noKeyOne.status), "鍵なし詳細は拒否: " + noKeyOne.status);
  const withKey = await fetch(BASE + "/api/players/" + playerA.id, { headers: akhead }).then(r => r.json());
  assert.strictEqual(withKey.note, "MEMO-KANMOKU-A(怪我情報)", "管理側は従来どおり note が読める(契約の片側)");
});
