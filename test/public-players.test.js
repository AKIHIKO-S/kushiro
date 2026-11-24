// 選手DBの一般公開(/players)の回帰テスト。未成年を含む名簿を出すので、出す項目の限定を重点的に守らせる。
//
// 守らせる不変条件:
//   ① 一覧は固定のページ分け(1ページ50人)。1回の要求で全員は返さない。全員をページでたどれる
//   ② 一覧・学校・選手ページの項目は許可リストだけ。ふりがな・内部ID・メモ・性別・Eloなどが応答のどこにも出ない
//   ③ 統合済みの選手は出ない
//   ④ 選手ページ: 棄権・不戦勝の別表示、相手の所属(不明は「所属不明」)、年度つきの大会名、年度別成績
//   ⑤ pid は内部IDに戻せない不透明な値
//   ⑥ HTTP: noindex(ヘッダー・メタタグ)、回数制限、申込集計モードでも読める、/players が申込案内へ飛ばない
// 実行: node --test test/public-players.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("fs");
const path = require("path");

process.env.DB_PATH = path.join(require("os").tmpdir(), "ktta_pubpl_" + process.pid + ".db");
process.env.KTTA_APP_MODE = "entry";
process.env.ADMIN_KEY = "fixture-pubpl";
process.env.PUBLIC_PLAYERS_MAX = "30";

const db = require("../db");
const PP = require("../lib/public-players");
const pp = PP.create(db);
after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const SECRET_KANA = "ひみつふりがな";
const SECRET_NOTE = "内部メモ秘密";
const EV = "男子シングルス";
const m = (pos, p1, t1, p2, t2, result) => ({ bracket_round: 1, bracket_pos: pos, player1_name: p1, player1_team: t1,
  player2_name: p2, player2_team: p2 === "BYE" ? "" : t2, result });
const res = (w, l, extra) => ({ winner_name: w, loser_name: l, winner_sets: 3, loser_sets: 1, sets: [[11, 5], [11, 7], [7, 11], [11, 9]], ...(extra || {}) });

let T, A, ids = {};
test("下ごしらえ: 130人の登録+1大会", () => {
  for (let i = 0; i < 130; i++) {
    db.createPlayer({ name: "公開 " + String(i).padStart(3, "0"), furigana: SECRET_KANA + i, team: i < 60 ? "検証中学校" : "検証クラブ", branch: "釧路",
      gender: "female", category: i < 60 ? "middle" : "general", note: SECRET_NOTE });
  }
  const mk = (name, team) => db.createPlayer({ name, furigana: SECRET_KANA, team, branch: "釧路", gender: "male", category: "middle", note: SECRET_NOTE });
  A = mk("本人 太郎", "検証中学校"); mk("相手 一郎", "検証中学校"); mk("棄権 二郎", "検証中学校"); mk("不明 三郎", "");
  const dup = db.createPlayer({ name: "統合 元", team: "検証中学校", branch: "釧路", gender: "male", category: "middle" });
  const keep = db.createPlayer({ name: "統合 先", team: "検証中学校", branch: "釧路", gender: "male", category: "middle" });
  const mg = db.mergePlayers(keep.id, dup.id, {}); assert.ok(mg.ok, mg.error);
  T = db.createTournament({ name: "検証新人戦", date: "2026-11-22" });
  const r = db.importBracket(T.id, { format: "tabletennis-bracket-v1", event: EV, bracket_size: 4, matches: [
    m(0, "本人 太郎", "検証中学校", "相手 一郎", "検証中学校", res("本人 太郎", "相手 一郎")),
    m(1, "棄権 二郎", "検証中学校", "不明 三郎", "", res("不明 三郎", "棄権 二郎", { winner_sets: 0, loser_sets: 0, sets: [], walkover: true })),
    { bracket_round: 2, bracket_pos: 0, player1_name: "本人 太郎", player1_team: "検証中学校", player2_name: "不明 三郎", player2_team: "",
      result: res("不明 三郎", "本人 太郎", { winner_sets: 3, loser_sets: 0, sets: [] }) } ] });
  assert.ok(!r.error, r.error);
  pp._reset();
});

test("① 一覧は固定の50人ずつ。全員をページでたどれる。範囲外のページは端に寄せる", () => {
  const p1 = pp.listPlayers({});
  assert.equal(p1.per_page, 50);
  assert.equal(p1.items.length, 50, "1回で返すのは50人まで");
  assert.ok(p1.total >= 134 && p1.pages >= 3);
  const seen = new Set();
  for (let pg = 1; pg <= p1.pages; pg++) pp.listPlayers({ page: pg, sort: "kana" }).items.forEach(x => seen.add(x.pid));
  assert.equal(seen.size, p1.total, "全ページをたどると全員になる(重複なし)");
  assert.equal(pp.listPlayers({ page: 9999 }).page, p1.pages);
  assert.equal(pp.listPlayers({ page: -5 }).page, 1);
  assert.ok(pp.listPlayers({ limit: 100000, per_page: 100000 }).items.length <= 50, "件数の指定では増やせない");
  assert.equal(pp.listPlayers({ q: "公開 07" }).total, 10);
  assert.equal(pp.listPlayers({ category: "middle", school: "検証クラブ" }).total, 0);
});

test("② 許可リスト以外の項目が、どの応答にも出ない", () => {
  const lists = [pp.listPlayers({}), pp.listPlayers({ sort: "kana", page: 2 }), pp.listPlayers({ q: "本人" }), pp.listSchools({ group: "middle" }), pp.listSchools({})];
  const top = new Set(PP.LIST_TOP_KEYS);
  lists.slice(0, 3).forEach(d => {
    Object.keys(d).forEach(k => assert.ok(top.has(k), "一覧の上位項目: " + k));
    d.items.forEach(x => assert.deepEqual(Object.keys(x).sort(), PP.LIST_KEYS.slice().sort()));
  });
  const me = pp.listPlayers({ q: "本人 太郎" }).items[0];
  const page = pp.playerPage(me.pid);
  assert.deepEqual(Object.keys(page).sort(), PP.DETAIL_KEYS.slice().sort());
  page.tournaments.forEach(t => t.rows.forEach(r => assert.deepEqual(Object.keys(r).sort(), PP.ROW_KEYS.slice().sort())));
  const dumps = JSON.stringify([lists, page, pp.listTournaments(() => true)]);
  [SECRET_KANA, SECRET_NOTE, "furigana", "rating", "gender", "player_no", "note", "merged", "email", "tel", "birth"].forEach(w =>
    assert.ok(!dumps.includes(w), "応答に含まれてはいけない: " + w));
  // 内部ID(選手・大会・試合)が出ない
  const internal = [A.id, T.id, ...db.getPlayers({}).slice(0, 20).map(p => p.id), ...db.getTournament(T.id).matches.map(x => x.id)];
  internal.forEach(id => assert.ok(!dumps.includes(id), "内部IDが出ている: " + id));
});

test("③ 統合済みの選手は出ない", () => {
  assert.equal(pp.listPlayers({ q: "統合 元" }).total, 0);
  assert.equal(pp.listPlayers({ q: "統合 先" }).total, 1);
});

test("④⑤ 選手ページ: 棄権・不戦勝・相手の所属・年度つき大会名・年度別成績。pid は内部IDに戻せない", () => {
  const me = pp.listPlayers({ q: "本人 太郎" }).items[0];
  assert.notEqual(me.pid, A.id);
  assert.match(me.pid, /^[0-9a-f]{20}$/);
  assert.equal(pp.pidOf(A.id), me.pid, "同じ選手は同じpid");
  assert.equal(pp.playerPage("0".repeat(20)), null);
  assert.equal(pp.playerPage("../etc/passwd"), null);
  const d = pp.playerPage(me.pid);
  assert.equal(d.name, "本人 太郎"); assert.equal(d.category_label, "中学生");
  assert.deepEqual(d.years, [{ year: "2026年度", tournaments: 1, wins: 1, losses: 1 }]);
  assert.equal(d.tournaments[0].label, "2026年度 検証新人戦");
  const rows = d.tournaments[0].rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].result, "win"); assert.equal(rows[0].score, "3-1"); assert.deepEqual(rows[0].sets, ["11-5", "11-7", "7-11", "11-9"]);
  assert.equal(rows[0].opp_team, "検証中学校");
  assert.equal(rows[1].result, "loss"); assert.equal(rows[1].score, "0-3"); assert.equal(rows[1].opp_team, "所属不明", "相手の所属が分からなければ「所属不明」");
  assert.ok(d.same_school.length > 0 && d.same_school.every(s => Object.keys(s).sort().join() === "name,pid"));
  // 棄権した選手: 勝敗に入れず「棄権」、相手は「不戦勝」
  const q = pp.playerPage(pp.listPlayers({ q: "棄権 二郎" }).items[0].pid);
  assert.equal(q.tournaments[0].rows[0].result, "withdrew"); assert.equal(q.tournaments[0].rows[0].score, null);
  assert.deepEqual([q.wins, q.losses], [0, 0]);
  assert.deepEqual(q.years[0].tournaments, 1, "棄権の大会も出場に数える");
  const w = pp.playerPage(pp.listPlayers({ q: "不明 三郎" }).items[0].pid);
  assert.equal(w.tournaments[0].rows.find(r => r.result === "walkover_win").opp_name, "棄権 二郎");
});

test("⑦ 「個人」「○○個人」は所属なしの人。クラブとして一覧に出さず、同じ学校の選手にも並べない", () => {
  const mk = (name, team) => db.createPlayer({ name, furigana: SECRET_KANA, team, branch: "釧路", gender: "male", category: "general", note: SECRET_NOTE });
  mk("個人 甲", "個人"); mk("個人 乙", "個人"); mk("個人 丙", "苫小牧個人");
  pp._reset();
  const teams = pp.listSchools({}).items.map(x => x.team);
  assert.ok(!teams.includes("個人") && !teams.includes("苫小牧個人"), "学校・クラブ一覧に出さない");
  assert.equal(pp.listPlayers({ school: "個人" }).total, 0, "「個人」を学校として指定しても出ない");
  const kou = pp.listPlayers({ q: "個人 甲" }).items[0];
  assert.equal(kou.team, PP.INDIVIDUAL_LABEL, "所属は「所属なし(個人)」と表示");
  assert.equal(pp.playerPage(kou.pid).team, PP.INDIVIDUAL_LABEL);
  assert.deepEqual(pp.playerPage(kou.pid).same_school, [], "同じ学校の選手は出さない");
  assert.equal(pp.listPlayers({ q: "個人 丙" }).items[0].team, PP.INDIVIDUAL_LABEL, "苫小牧個人も同じ");
  assert.ok(pp.listPlayers({ sort: "kana" }).total >= 137, "全員の一覧には残る");
  assert.ok(!JSON.stringify(pp.listPlayers({ q: "個人" })).includes('"team":"個人"'), "「個人」の文字列を所属として返さない");
});

// ── HTTP(サーバーを起動するので、待ち受けできる環境=CIで動く) ──
test("⑥ HTTP: noindex・申込集計モードで読める・回数制限・一括取得できない", async t => {
  const { app } = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(r => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const get = (p) => fetch(base + p, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  const page = await get("/players");
  assert.equal(page.status, 200, "/players は申込案内へ飛ばさない");
  assert.match(page.headers.get("x-robots-tag") || "", /noindex/);
  assert.match(await page.text(), /<meta name="robots" content="noindex/);
  const rb = await (await get("/robots.txt")).text();
  assert.match(rb, /Disallow: \//);
  const list = await get("/api/pub/players");
  assert.equal(list.status, 200, "申込集計モードでも読める");
  assert.match(list.headers.get("x-robots-tag") || "", /noindex/);
  const body = await list.json();
  assert.equal(body.items.length, 50);
  assert.equal((await get("/api/pub/players/" + "f".repeat(20))).status, 404);
  assert.ok([401, 403].includes((await get("/api/players")).status), "管理用の選手API(氏名・ふりがな入り)は、認証なしでは読めない");
  assert.ok([401, 403].includes((await get("/api/players/" + "f".repeat(20))).status));
  assert.equal((await fetch(base + "/api/pub/players", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 404, "読み取りだけ");
  let limited = 0;
  for (let i = 0; i < 40; i++) if ((await get("/api/pub/schools")).status === 429) limited++;
  assert.ok(limited > 0, "回数制限がかかる");
});
