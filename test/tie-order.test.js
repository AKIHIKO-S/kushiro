// 団体戦オーダー(連続マッチ禁止)の回帰テスト。
//  - 純関数(public/shared/tie-order.js): ダブルス位置(1試合目/3試合目)ごとの隣接判定・サイド独立・紙運用スキップ
//  - DB経路(finish/correct): 違反は needs_force 付きで reject、force で強制可、選手名なしは従来どおり
// 実行: node --test test/tie-order.test.js
process.env.DB_PATH = "/tmp/ktta_tieorder_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const TTTieOrder = require("../public/shared/tie-order.js");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// ── 純関数(共有バリデータ) ──────────────────────────────

test("slotKeysFor は parseTieFormat と同じキー列を返す", () => {
  assert.deepStrictEqual(TTTieOrder.slotKeysFor("S,S,D,S,S"), ["S1", "S2", "D1", "S3", "S4"]);
  assert.deepStrictEqual(TTTieOrder.slotKeysFor("D,S,S,S,S"), ["D1", "S1", "S2", "S3", "S4"]);
  assert.deepStrictEqual(TTTieOrder.slotKeysFor("単 複 単"), ["S1", "D1", "S2"]);
  assert.deepStrictEqual(TTTieOrder.slotKeysFor("3"), ["M1", "M2", "M3"]);
  assert.deepStrictEqual(TTTieOrder.slotKeysFor(""), []);
});

// エントリ生成ヘルパ: slots = {slot: {home:[名…], away:[名…]}}
function tr(slots) {
  return Object.keys(slots).map(k => {
    const e = { slot: k, winner: "home" };
    if (slots[k].home) e.home_players = slots[k].home;
    if (slots[k].away) e.away_players = slots[k].away;
    return e;
  });
}

test("ダブルスが1試合目: ペア選手はM2がNG・M3以降はOK", () => {
  const fmt = "D,S,S,S,S";   // D1=M1, S1=M2, S2=M3, S3=M4, S4=M5
  // 山田がD(M1)と直後のS1(M2) → NG
  let v = TTTieOrder.validateTieOrder(fmt, tr({ D1: { home: ["山田", "佐藤"] }, S1: { home: ["山田"] } }));
  assert.strictEqual(v.length, 1);
  assert.deepStrictEqual([v[0].type, v[0].player, v[0].matches], ["adjacent", "山田", [1, 2]]);
  // 山田がD(M1)とS2(M3)=1つ飛ばし → OK。S4(M5)もOK
  v = TTTieOrder.validateTieOrder(fmt, tr({ D1: { home: ["山田", "佐藤"] }, S2: { home: ["山田"] }, S4: { home: ["佐藤"] } }));
  assert.strictEqual(v.length, 0);
});

test("ダブルスが3試合目: M2/M4がNG・M1/M5はOK(ペア両選手とも対象)", () => {
  const fmt = "S,S,D,S,S";   // S1=M1, S2=M2, D1=M3, S3=M4, S4=M5
  // 佐藤(Dペアの2人目)がS2(M2) → NG / 山田がS3(M4) → NG
  let v = TTTieOrder.validateTieOrder(fmt, tr({
    S2: { home: ["佐藤"] }, D1: { home: ["山田", "佐藤"] }, S3: { home: ["山田"] } }));
  const sig = v.map(x => x.player + ":" + x.matches.join("-")).sort();
  assert.deepStrictEqual(sig, ["佐藤:2-3", "山田:3-4"]);
  // M1とM5なら両選手ともOK
  v = TTTieOrder.validateTieOrder(fmt, tr({
    S1: { home: ["山田"] }, D1: { home: ["山田", "佐藤"] }, S4: { home: ["佐藤"] } }));
  assert.strictEqual(v.length, 0);
});

test("サイド独立: 両チームに同姓同名がいても誤検出しない", () => {
  const fmt = "S,S,D,S,S";
  // home の山田が M1、away の山田が M2 → 別人なので違反なし
  const v = TTTieOrder.validateTieOrder(fmt, tr({ S1: { home: ["山田"] }, S2: { away: ["山田"] } }));
  assert.strictEqual(v.length, 0);
});

test("同一ダブルスに同じ選手を2回入れると same_pair", () => {
  const v = TTTieOrder.validateTieOrder("S,S,D,S,S", tr({ D1: { home: ["山田", "山 田"] } }));
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].type, "same_pair");   // 空白の表記ゆれも同一視
});

test("選手名なし(紙運用)・フォーマット空・フォーマット外slotは違反ゼロ", () => {
  assert.strictEqual(TTTieOrder.validateTieOrder("S,S,D,S,S",
    [{ slot: "S1", winner: "home" }, { slot: "D1", winner: "away" }]).length, 0);
  assert.strictEqual(TTTieOrder.validateTieOrder("",
    tr({ S1: { home: ["山田"] }, S2: { home: ["山田"] } })).length, 0);
  // 旧データ等でフォーマットに無い slot は位置不明=対象外
  assert.strictEqual(TTTieOrder.validateTieOrder("S,S",
    tr({ S1: { home: ["山田"] }, D9: { home: ["山田"] } })).length, 0);
});

test("describeViolation は日本語の説明文を返す", () => {
  const msg = TTTieOrder.describeViolation({ type: "adjacent", side: "home", player: "山田", matches: [1, 2] });
  assert.ok(msg.includes("山田") && msg.includes("第1試合") && msg.includes("第2試合") && msg.includes("連続マッチ禁止"));
});

test("window 非参照: Node から副作用なく require できる(グローバル汚染なし)", () => {
  assert.strictEqual(typeof TTTieOrder.validateTieOrder, "function");
  assert.strictEqual(globalThis.TTTieOrder, undefined);   // module.exports 経路ではグローバルに生やさない
});

// ── DB経路(finish/correct がオーダー違反を needs_force 付きで弾く) ──────────

const EV = "男子団体戦";
function teamTournament(tieFormat) {
  const t = db.createTournament({ name: "オーダー検証", date: "2027-12-01" });
  db.updateEntrySettings(t.id, { entries_open: 1,
    event_config: [{ name: EV, type: "team", fee: 4000, per_team: 6, tie_format: tieFormat }] });
  return t;
}
function firstRealMatch(tid) {
  return db.getOpMatchList(tid).matches.find(
    m => m.player1_name && m.player2_name && m.player1_name !== "BYE" && m.player2_name !== "BYE");
}
function setup(tieFormat) {
  const t = teamTournament(tieFormat);
  ["甲", "乙"].forEach(n => db.createTeamEntry(t.id, { team_name: n, contact_name: "x",
    contact_email: "x@y.jp", entries: [{ event: EV, type: "team", team_name: n,
      members: [n + "1", n + "2", n + "3", n + "4", n + "5", n + "6"] }] }));
  db.generateBracket(t.id, EV, {});
  return firstRealMatch(t.id);
}
// home 3-0 勝ちの内訳(S1,S2,D1)に任意の選手割当を載せる
function tieWith(players) {
  const base = [
    { slot: "S1", type: "S", winner: "home" },
    { slot: "S2", type: "S", winner: "home" },
    { slot: "D1", type: "D", winner: "home" },
  ];
  return base.map(e => Object.assign({}, e, players[e.slot] || {}));
}

test("finish: 連続マッチ禁止違反は needs_force 付きで reject される", () => {
  const m = setup("S,S,D,S,S");   // S2=M2, D1=M3 が隣接
  const res = db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0,
    tie_results: tieWith({ S2: { home_players: ["甲1"] }, D1: { home_players: ["甲1", "甲2"] } }) });
  assert.ok(res && res.error, "reject される");
  assert.strictEqual(res.needs_force, true);
  assert.ok(res.error.includes("甲1") && res.error.includes("連続マッチ禁止"), res.error);
  assert.strictEqual(db.getMatch(m.id).status !== "completed", true, "書込みされていない");
});

test("finish: 隣接しないオーダーは成功し選手名が tie_results に保存される", () => {
  const m = setup("S,S,D,S,S");   // S1=M1, D1=M3 → 差2でOK
  const res = db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0,
    tie_results: tieWith({ S1: { home_players: ["甲1"], away_players: ["乙1"] },
                           D1: { home_players: ["甲1", "甲2"] } }) });
  assert.ok(res && !res.error, "成功: " + JSON.stringify(res && res.error));
  const saved = db.getMatch(m.id);
  assert.deepStrictEqual(saved.tie_results.find(e => e.slot === "S1").home_players, ["甲1"]);
  assert.deepStrictEqual(saved.tie_results.find(e => e.slot === "S1").away_players, ["乙1"]);
});

test("finish: force:true なら違反オーダーでも強制保存できる", () => {
  const m = setup("S,S,D,S,S");
  const res = db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0, force: true,
    tie_results: tieWith({ S2: { home_players: ["甲1"] }, D1: { home_players: ["甲1", "甲2"] } }) });
  assert.ok(res && !res.error, "force で成功");
  assert.strictEqual(db.getMatch(m.id).status, "completed");
});

test("finish: 選手名なし(紙運用)は従来どおり検証なしで成功する", () => {
  const m = setup("S,S,D,S,S");
  const res = db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0,
    tie_results: tieWith({}) });
  assert.ok(res && !res.error, "紙運用は無影響");
});

test("correct: 違反オーダーへの訂正も reset 前に reject される", () => {
  const m = setup("S,S,D,S,S");
  db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0, tie_results: tieWith({}) });
  const c = db.correctResult(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0,
    tie_results: tieWith({ S2: { home_players: ["甲1"] }, D1: { home_players: ["甲1", "甲2"] } }) });
  assert.ok(c && c.error && c.needs_force === true, "correct でも reject");
  const saved = db.getMatch(m.id);
  assert.strictEqual(saved.status, "completed", "元の結果が温存されている(部分適用なし)");
  assert.strictEqual(saved.tie_results.some(e => e.home_players), false, "違反オーダーは保存されない");
});

test("tie_format 未設定(チームスコア直接)の種目は選手名があっても検証スキップ", () => {
  const m = setup("");   // フォーマット空
  const res = db.finishMatchOp(m.id, { winner_slot: 1, winner_sets: 3, loser_sets: 0,
    tie_results: [{ slot: "S1", winner: "home", home_players: ["甲1"] },
                  { slot: "S2", winner: "home", home_players: ["甲1"] }] });
  assert.ok(res && !res.error, "判定不能(フォーマット無し)は素通し");
});
