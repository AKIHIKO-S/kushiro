// 選手DB表示改善(2026-07-17)の回帰:
//  1. H2H(対戦相手別)・種目別統計の集計母集団が通算と同一(地区のみ・全道/全国除外)
//  2. 検索の正規化(カナ/かな・全半角・空白・支部)
//  3. 統合(マージ)の旧登録名が選手詳細に載る(former_names)
// 実行: node --test test/player-display.test.js
process.env.DB_PATH = "/tmp/ktta_pdisp_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
// 2選手を大会(level指定)で1試合対戦させて確定する
function playMatch(pA, pB, level, name) {
  const t = db.createTournament({ name, date: "2027-04-01" });
  // createTournament は level を受けないため作成後に設定(既定は district)
  if (level && level !== "district") db.updateTournament(t.id, { level });
  const eA = db.createEntrant({ tournament_id: t.id, event: EV, name: pA.name, team: pA.team, player_id: pA.id, furigana: pA.furigana });
  const eB = db.createEntrant({ tournament_id: t.id, event: EV, name: pB.name, team: pB.team, player_id: pB.id, furigana: pB.furigana });
  const gen = db.generateBracket(t.id, EV, {});
  assert.ok(gen && !gen.error, JSON.stringify(gen).slice(0, 120));
  const m = db.getMatchesByTournament(t.id).find(x => x.event === EV);
  // winner_slot はAが player1 とは限らないので実スロットで指定
  const slot = (m.player1_entrant_id === eA.id) ? 1 : 2;
  const r = db.finishMatchOp(m.id, { winner_slot: slot, sets: [] });
  assert.ok(!r.error, JSON.stringify(r));
}

test("H2H・種目別統計は地区のみ(全道/全国を除外)=通算と同じ母集団", () => {
  const A = db.createPlayer({ name: "母集団太郎", furigana: "ぼしゆうだん", team: "釧路ク", gender: "male" });
  const B = db.createPlayer({ name: "母集団次郎", furigana: "ぼしゆうだんじ", team: "帯広ク", gender: "male" });
  playMatch(A, B, "district", "地区大会1");     // 地区: 数える
  playMatch(A, B, "district", "地区大会2");     // 地区: 数える
  playMatch(A, B, "hokkaido", "全道大会");      // 全道: 数えない
  const p = db.getPlayer(A.id);
  const totalWins = p.matches.filter(m => m.winner_id === A.id).length;
  assert.strictEqual(totalWins, 2, "通算(埋込matches)は地区2勝のみ");
  const h2h = db.getPlayerOpponents(A.id).find(o => o.opp_id === B.id);
  assert.ok(h2h, "H2Hに相手が載る");
  assert.strictEqual(h2h.wins + h2h.losses, 2, "H2Hも地区2試合のみ(従来は全道込み3で通算と食い違った)");
  const es = db.getPlayerEventStats(A.id).find(s => s.event === EV);
  assert.strictEqual((es.wins || 0) + (es.losses || 0), 2, "種目別統計も地区2試合のみ");
});

test("検索の正規化: カナ/かな・全半角・空白ゆらぎ・支部名で同じ選手に当たる", () => {
  const p = db.createPlayer({ name: "佐藤 検索", furigana: "さとうけんさく", team: "釧路クラブ", gender: "male", branch: "釧路" });
  const hit = (q) => db.getPlayers({ search: q }).some(r => r.id === p.id);
  assert.ok(hit("さとうけん"), "ひらがな");
  assert.ok(hit("サトウケン"), "カタカナ(かな変換)");
  assert.ok(hit("ｻﾄｳｹﾝ"), "半角カナ(NFKC+かな変換)");
  assert.ok(hit("佐藤検索"), "空白ゆらぎ(氏名の空白を無視)");
  assert.ok(hit("釧路クラブ"), "所属");
  assert.ok(hit("釧路"), "支部(2026-07-17追加)");
});

test("統合の旧登録名: former_names に吸収された別表記が載る(チェーン対応)", () => {
  const oldA = db.createPlayer({ name: "髙橋 旧字", furigana: "たかはし", team: "X", gender: "male" });
  const oldB = db.createPlayer({ name: "高橋 旧字", furigana: "たかはし", team: "X", gender: "male" });
  const cur = db.createPlayer({ name: "高橋 新字", furigana: "たかはし", team: "X", gender: "male" });
  // oldA → oldB → cur のチェーン統合(mergePlayers(survivorId, dupId)=dup を survivor へ吸収)
  const m1 = db.mergePlayers(oldB.id, oldA.id, {});
  assert.ok(m1 && !m1.error, "統合1: " + JSON.stringify(m1).slice(0, 100));
  const m2 = db.mergePlayers(cur.id, oldB.id, {});
  assert.ok(m2 && !m2.error, "統合2: " + JSON.stringify(m2).slice(0, 100));
  const p = db.getPlayer(cur.id);
  assert.ok(Array.isArray(p.former_names), "former_names が配列で載る");
  assert.ok(p.former_names.includes("髙橋 旧字"), "チェーン先の旧名も含む: " + JSON.stringify(p.former_names));
  assert.ok(p.former_names.includes("高橋 旧字"), "直接統合の旧名も含む");
  assert.ok(!p.former_names.includes("高橋 新字"), "現在名は含まない");
});
