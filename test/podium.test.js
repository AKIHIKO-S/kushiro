// 大会入賞者(表彰)の自動集計 computeTournamentPodium / registerPodiumAchievements の回帰。
// KTTAドメイン規則を固定する: 1位=決勝勝者/2位=決勝敗者/3位=準決勝敗者2名(3位決定戦なし)、
// 準決勝の特定は実配線(next_match_id)の逆引き=罫線の自由配線編集後も正しい。
// リーグ(1ブロック)は computeLeagueStandings の1..3位、全消化+同率抽選確定済みのときのみ確定。
// 選手DB登録は冪等(再実行は skipped)・未連携は unlinked。氏名はすべて合成。
// 実行: node --test test/podium.test.js
process.env.DB_PATH = "/tmp/ktta_podium_" + process.pid + ".db";

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
let _seq = 0;
function setupKnock(n, { linkPlayers } = {}) {
  const t = db.createTournament({ name: "表彰検証" + (++_seq), date: "2027-11-0" + ((_seq % 8) + 1) });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entrants = [];
  for (let i = 1; i <= n; i++) {
    let player_id = null;
    if (linkPlayers) {
      const p = db.createPlayer({ name: "選" + _seq + "_" + i, team: "T" + i });
      player_id = p.id;
    }
    entrants.push(db.createEntrant({ tournament_id: t.id, event: EV,
      name: "選" + _seq + "_" + i, team: "T" + i, furigana: "せ" + String(i).padStart(2, "0"),
      seed: i <= 2 ? i : 0, player_id }));
  }
  const gen = db.generateBracket(t.id, EV, {});
  assert.ok(gen && !gen.error, JSON.stringify(gen).slice(0, 120));
  return { t, entrants };
}
const byRound = (tid, r, ev) => db.getMatchesByTournament(tid)
  .filter(m => m.event === (ev || EV) && m.bracket_round === r && m.status !== "completed")
  .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
function playAll(tid, ev) {
  // 回戦順に slot1 勝ちで全消化(回戦ごとに再取得=進出処理後の対戦カードで判定する)
  for (let r = 1; r <= 10; r++) {
    const ms = byRound(tid, r, ev);
    if (!ms.length && r > 3) break;
    ms.forEach(m => {
      if (!m.player1_name || !m.player2_name || m.player1_name === "BYE" || m.player2_name === "BYE") return;
      const res = db.finishMatchOp(m.id, { winner_slot: 1, sets: [], winner_sets: 3, loser_sets: 1 });
      assert.ok(!res.error, JSON.stringify(res).slice(0, 120));
    });
  }
}

test("ノックアウト8名全消化: 1位=決勝勝者/2位=決勝敗者/3位=準決勝敗者2名", () => {
  const { t } = setupKnock(8);
  playAll(t.id);
  const pod = db.computeTournamentPodium(t.id);
  assert.ok(!pod.error);
  const evb = pod.events.find(e => e.event === EV);
  assert.strictEqual(evb.status, "final");
  const places = evb.items.map(i => i.place);
  assert.deepStrictEqual(places, [1, 2, 3, 3], "1/2/3/3の4名");
  // 決勝の勝者・敗者と一致するか(実データで検算)
  const fin = db.getMatchesByTournament(t.id).find(m => m.event === EV && m.bracket_round === 3);
  assert.strictEqual(evb.items[0].name, fin.winner_name, "1位=決勝勝者");
  assert.strictEqual(evb.items[1].name, fin.loser_name, "2位=決勝敗者");
  const semiLosers = db.getMatchesByTournament(t.id)
    .filter(m => m.event === EV && m.next_match_id === fin.id).map(m => m.loser_name).sort();
  assert.deepStrictEqual(evb.items.filter(i => i.place === 3).map(i => i.name).sort(), semiLosers, "3位=準決勝敗者");
});

test("決勝未消化は pending、種目にデータが無ければ events に出ない", () => {
  const { t } = setupKnock(8);
  // 1回戦だけ消化
  byRound(t.id, 1).forEach(m => {
    if (m.player1_name && m.player2_name && m.player1_name !== "BYE" && m.player2_name !== "BYE")
      db.finishMatchOp(m.id, { winner_slot: 1, sets: [] });
  });
  const pod = db.computeTournamentPodium(t.id);
  const evb = pod.events.find(e => e.event === EV);
  assert.strictEqual(evb.status, "pending");
  assert.strictEqual(evb.items.length, 0);
});

test("BYEあり(6名/8枠): 3位の枠にBYE敗者は入らない", () => {
  const { t } = setupKnock(6);
  playAll(t.id);
  const pod = db.computeTournamentPodium(t.id);
  const evb = pod.events.find(e => e.event === EV);
  assert.strictEqual(evb.status, "final");
  evb.items.forEach(it => assert.ok(it.name && it.name !== "BYE", "BYEは入賞に出ない"));
  assert.ok(evb.items.filter(i => i.place === 3).length >= 1, "3位が少なくとも1名");
});

test("relink(自由配線)後: 3位=決勝への実配線の供給元の敗者(位置演算ではない)", () => {
  const { t } = setupKnock(8);
  // 準決勝の進出先を入替(2回戦pos0の勝者を決勝slot1のままswap相手だけ変える運用は
  // relinkBracketMatch が保証するので、ここでは2回戦2試合のnext_slotをswapするだけでも
  // incoming の対応が変わる)。1回戦を消化してから2回戦(準決勝)の配線を入替→全消化。
  byRound(t.id, 1).forEach(m => db.finishMatchOp(m.id, { winner_slot: 1, sets: [] }));
  const semis = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 2)
    .sort((a, b) => a.bracket_pos - b.bracket_pos);
  const r = db.relinkBracketMatch(t.id, EV, semis[0].id, semis[1].next_match_id, semis[1].next_slot, {});
  assert.ok(r && r.success, JSON.stringify(r).slice(0, 120));
  playAll(t.id);
  const fin = db.getMatchesByTournament(t.id).find(m => m.event === EV && m.bracket_round === 3);
  const feeders = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.next_match_id === fin.id);
  assert.strictEqual(feeders.length, 2, "決勝への供給元は常に2試合(swapで木は保たれる)");
  const pod = db.computeTournamentPodium(t.id);
  const evb = pod.events.find(e => e.event === EV);
  assert.deepStrictEqual(
    evb.items.filter(i => i.place === 3).map(i => i.name).sort(),
    feeders.map(m => m.loser_name).sort(),
    "relink後も3位=実配線の準決勝敗者");
});

test("リーグ1ブロック(個人3名): 全消化で1..3位、未消化はpending", () => {
  const EVL = "女子シングルス";
  const t = db.createTournament({ name: "表彰リーグ", date: "2027-11-20" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EVL, type: "singles", fee: 0 }] });
  for (let i = 1; i <= 3; i++) db.createEntrant({ tournament_id: t.id, event: EVL,
    name: "リ" + i, team: "LT" + i, furigana: "り" + i, seed: i });
  const gen = db.generateTeamLeague(t.id, EVL, { num_blocks: 1 });
  assert.ok(gen && !gen.error, JSON.stringify(gen).slice(0, 120));
  const lm = () => db.getMatchesByTournament(t.id).filter(m => m.event === EVL && m.league_block);
  // 1試合だけ消化→pending
  db.finishMatchOp(lm()[0].id, { winner_slot: 1, sets: [], winner_sets: 3, loser_sets: 0 });
  let pod = db.computeTournamentPodium(t.id);
  assert.strictEqual(pod.events.find(e => e.event === EVL).status, "pending");
  // 全消化→final(standingsの順)
  lm().filter(m => m.status !== "completed").forEach(m =>
    db.finishMatchOp(m.id, { winner_slot: 1, sets: [], winner_sets: 3, loser_sets: 1 }));
  pod = db.computeTournamentPodium(t.id);
  const evb = pod.events.find(e => e.event === EVL);
  assert.strictEqual(evb.status, "final");
  const st = db.computeLeagueStandings(t.id, EVL);
  const rows = st[Object.keys(st)[0]];
  assert.deepStrictEqual(evb.items.map(i => i.name), rows.slice(0, 3).map(r => r.team_name), "standingsの1..3位と一致");
});

test("registerPodiumAchievements: 連携済みのみ登録・冪等(再実行はskipped)・未連携はunlinked", () => {
  const { t, entrants } = setupKnock(8, { linkPlayers: true });
  // 1名だけ未連携にする(決勝勝者=seed1=リーフ先頭の選手が優勝する想定だが、
  // 誰が優勝でも動くように「2位の選手」を後で特定して検証する)
  db.updateEntrant(entrants[5].id, { player_id: null });
  playAll(t.id);
  const pod = db.computeTournamentPodium(t.id);
  const evb = pod.events.find(e => e.event === EV);
  const expected = evb.items.reduce((n, it) => n + (it.player_ids ? it.player_ids.length : 0), 0);
  const r1 = db.registerPodiumAchievements(t.id);
  assert.ok(r1.ok);
  assert.strictEqual(r1.registered, expected, "連携済み入賞者の数だけ登録");
  const r2 = db.registerPodiumAchievements(t.id);
  assert.strictEqual(r2.registered, 0, "再実行は登録0");
  assert.strictEqual(r2.skipped, expected, "全件skipped=冪等");
  // achievements の中身検証(1位の選手に place=1 が入っている)
  const winner = evb.items.find(i => i.place === 1);
  if (winner.player_ids.length) {
    const ach = db.getPlayer(winner.player_ids[0]);
    const rows = (ach.achievements || []).filter(a => a.tournament === pod.tournament.name && a.event === EV);
    assert.ok(rows.some(a => a.place === 1), "優勝がachievementsに記録: " + JSON.stringify(rows).slice(0, 160));
  }
  // 未連携が items にいた場合は unlinked に列挙される(いなければ空)
  const unlinkedItems = evb.items.filter(i => !i.player_ids || !i.player_ids.length);
  assert.strictEqual(r1.unlinked.length, unlinkedItems.length, "未連携の件数一致");
});

test("ダブルス入賞: ペア両名の player_id が登録対象になる", () => {
  const EVD = "男子ダブルス";
  const t = db.createTournament({ name: "表彰ダブルス", date: "2027-11-25" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EVD, type: "doubles", fee: 0 }] });
  for (let i = 1; i <= 4; i++) {
    const pa = db.createPlayer({ name: "ペアA" + i, team: "DT" + i });
    const pb = db.createPlayer({ name: "ペアB" + i, team: "DT" + i });
    db.createEntrant({ tournament_id: t.id, event: EVD, name: "ペアA" + i, team: "DT" + i,
      partner_name: "ペアB" + i, furigana: "ぺ" + i, player_id: pa.id, partner_player_id: pb.id, seed: i });
  }
  const gen = db.generateBracket(t.id, EVD, {});
  assert.ok(gen && !gen.error, JSON.stringify(gen).slice(0, 120));
  playAll(t.id, EVD);
  const pod = db.computeTournamentPodium(t.id);
  const evb = pod.events.find(e => e.event === EVD);
  assert.strictEqual(evb.status, "final");
  const w = evb.items.find(i => i.place === 1);
  assert.strictEqual(w.player_ids.length, 2, "優勝ペアは2名分のplayer_id");
  assert.ok(w.name.includes("・"), "ペア名表記: " + w.name);
  const r = db.registerPodiumAchievements(t.id);
  assert.ok(r.registered >= 2, "ペア両名に登録: " + r.registered);
});

test("buildPodiumXlsx: 読み戻して入賞者と未確定注記が書かれている", () => {
  const { t } = setupKnock(8);
  playAll(t.id);
  const XLSX = require("xlsx");
  const reports = require("../reports");
  const pod = db.computeTournamentPodium(t.id);
  const buf = reports.buildPodiumXlsx(db.getTournament(t.id), pod);
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const vals = Object.keys(ws).filter(k => k[0] !== "!").map(k => String(ws[k].v));
  assert.ok(vals.some(v => v.includes("入賞者一覧")), "タイトル");
  assert.ok(vals.includes("優勝") && vals.includes("準優勝"), "順位ラベル");
  const evb = pod.events.find(e => e.event === EV);
  assert.ok(vals.includes(evb.items[0].name), "優勝者名が書かれる");
  assert.strictEqual(vals.filter(v => v === "3位").length, 2, "3位が2行");
});
