// 選手の勝敗履歴: 棄権・不戦勝を載せる / 対戦相手の所属を必ず出す(補完)の回帰テスト。
//
// 守らせる不変条件:
//   ① 棄権・不戦勝は player.walkovers に出る(棄権した側 withdrew=true)。player.matches(勝敗・Elo・セット数の元)には混ざらない
//   ② BYE は履歴に出ない
//   ③ 管理の試合一覧(getPlayerMatchesForEdit)には棄権・不戦勝も日付順に並び、is_walkover で見分けられる
//   ④ 対戦相手の所属が試合に無ければ、大会時点の所属履歴で補う。どちらも無ければ空(表示側が「所属不明」)
// 実行: node --test test/player-history-walkover.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_histwo_" + process.pid + ".db");
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const EV = "男子シングルス";
const m = (round, pos, p1, t1, p2, t2, result) => ({ bracket_round: round, bracket_pos: pos, player1_name: p1 || "", player1_team: t1,
  player2_name: p2 || "", player2_team: p2 && p2 !== "BYE" ? t2 : "", result: result || undefined });
const res = (w, l, extra) => ({ winner_name: w, loser_name: l, winner_sets: 3, loser_sets: 1, sets: [], ...(extra || {}) });
const byName = (n) => db.getPlayers({ search: n }).find(p => p.name === n);

function setup() {
  const t = db.createTournament({ name: "履歴検証大会", date: "2099-12-06" });
  const r = db.importBracket(t.id, { format: "tabletennis-bracket-v1", event: EV, bracket_size: 8, matches: [
    m(1, 0, "棄権 一郎", "検証中", "勝上 二郎", "検証西", res("勝上 二郎", "棄権 一郎", { winner_sets: 0, loser_sets: 0, walkover: true })),
    m(1, 1, "実戦 三郎", "検証中", "実戦 四郎", "", res("実戦 三郎", "実戦 四郎")),
    m(1, 2, "不戦 五郎", "検証中", "BYE", "", res("不戦 五郎", "BYE", { winner_sets: 0, loser_sets: 0 })),
    m(1, 3, "実戦 六郎", "検証中", "実戦 七郎", "検証中", res("実戦 六郎", "実戦 七郎")),
    m(2, 0, "勝上 二郎", "検証西", "実戦 三郎", "検証中", res("実戦 三郎", "勝上 二郎")),
  ] });
  assert.ok(!r.error, r.error);
  return t;
}

test("①② 棄権・不戦勝は walkovers にだけ載り、勝敗の元(matches)とBYEは混ざらない", () => {
  setup();
  const quit = db.getPlayer(byName("棄権 一郎").id);
  assert.strictEqual(quit.matches.length, 0);
  assert.strictEqual(quit.walkovers.length, 1);
  assert.strictEqual(quit.walkovers[0].withdrew, true, "棄権した側");
  assert.strictEqual(quit.walkovers[0].opp_team, "検証西", "相手の所属が出る");
  const up = db.getPlayer(byName("勝上 二郎").id);
  assert.strictEqual(up.walkovers.length, 1);
  assert.strictEqual(up.walkovers[0].withdrew, false, "不戦勝の側");
  assert.strictEqual(up.matches.length, 1, "勝敗に入るのは2回戦の1試合だけ");
  const bye = db.getPlayer(byName("不戦 五郎").id);
  assert.strictEqual(bye.walkovers.length, 0, "BYEは履歴に出ない");
});

test("③ 管理の試合一覧には棄権・不戦勝も並び、is_walkover で見分けられる", () => {
  const up = byName("勝上 二郎");
  const list = db.getPlayerMatchesForEdit(up.id);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map(x => !!x.is_walkover).sort(), [false, true]);
  assert.ok(list.every(x => typeof x.opp_team === "string"));
});

test("④ 相手の所属が試合に無ければ所属履歴で補い、無ければ空", () => {
  const me = byName("実戦 三郎");
  const first = db.getPlayer(me.id).matches.find(x => x.loser_name === "実戦 四郎");
  assert.ok(first, "1回戦の試合がある");
  assert.strictEqual(first.opp_team, "", "どこにも所属が無ければ空(表示は所属不明)");
  const opp = byName("実戦 四郎");
  const a = db.addAffiliation(opp.id, { team: "補完クラブ", start_date: "" });
  assert.ok(a.ok, a.error);
  const again = db.getPlayer(me.id).matches.find(x => x.loser_name === "実戦 四郎");
  assert.strictEqual(again.opp_team, "補完クラブ", "所属履歴から補う");
});

test("⑤ 大会名には学校年度(4月始まり)を付ける。すでに年が入っていれば足さず、日付が読めなければ大会名のまま", () => {
  const L = db.tournamentLabel;
  assert.strictEqual(L("中学新人戦", "2026-11-03"), "2026年度 中学新人戦");
  assert.strictEqual(L("中学新人戦", "2027-03-31"), "2026年度 中学新人戦", "1〜3月は前年度");
  assert.strictEqual(L("中学新人戦", "2027-04-01"), "2027年度 中学新人戦");
  assert.strictEqual(L("2026年度 中学新人戦", "2026-11-03"), "2026年度 中学新人戦", "重ねない");
  assert.strictEqual(L("令和8年度 新人戦", "2026-11-03"), "令和8年度 新人戦");
  assert.strictEqual(L("第45回釧路選手権2026", "2026-05-01"), "第45回釧路選手権2026");
  assert.strictEqual(L("中学新人戦", ""), "中学新人戦", "日付なしは大会名のまま");
  assert.strictEqual(L("中学新人戦", "不明"), "中学新人戦");
  assert.strictEqual(L("", "2026-11-03"), "2026年度 大会");
});
test("⑤ 履歴の行に tournament_label が付く", () => {
  const up = db.getPlayer(byName("勝上 二郎").id);
  assert.ok(up.matches[0].tournament_label.indexOf("2099年度 ") === 0, up.matches[0].tournament_label);
  assert.ok(up.walkovers[0].tournament_label.indexOf("2099年度 ") === 0);
});
