// db.js のロジック回帰テスト。隔離した一時DBを使う(本番DBには触れない)。
// このファイルは node --test が独立プロセスで実行するため、先頭で DB_PATH を固定する。
// 実行: node --test test/db.test.js
process.env.DB_PATH = "/tmp/ktta_dbtest_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const Database = require("better-sqlite3");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

test("createEntry: 不正氏名は throw せず error を返し、正常はok。team/note はクリップ", () => {
  const t = db.createTournament({ name: "申込検証", date: "2027-01-01" });
  db.updateEntrySettings(t.id, { entries_open: 1 });
  // 長すぎ氏名(多様な文字)→ createPlayer のバリデーションで graceful に error(例外でない)
  const bad = db.createEntry(t.id, { name: "山田太郎ペア".repeat(600), events: ["男子シングルス"], team: "A" });
  assert.ok(bad && (bad.error || bad.screened), "長すぎ氏名 -> error/screened(例外でない)");
  const num = db.createEntry(t.id, { name: "12345", events: ["男子シングルス"], team: "A" });
  assert.ok(num && (num.error || num.screened), "数値のみ氏名 -> error/screened");
  // team は多様な長文字列(スクリーニング非該当)で200字クリップを検証。note は screen 対象外。
  const ok = db.createEntry(t.id, { name: "山田 太郎", events: ["男子シングルス"], team: "釧路卓球協会支部".repeat(40), note: "ね".repeat(900) });
  assert.ok(ok && ok.ok, "正常 -> ok");
  const p = db.getPlayer(ok.player_id);
  assert.ok(p.team.length <= 200, "team が200字以内にクリップ");
});

test("createTeamEntry: 混合ダブルス(type:mixed)が欠落せず登録される (#269)", () => {
  const t = db.createTournament({ name: "混合検証", date: "2027-01-01" });
  db.updateEntrySettings(t.id, { entries_open: 1 });
  db.createTeamEntry(t.id, {
    team_name: "甲中",
    entries: [
      { event: "男子シングルス", type: "singles", fee: 700, name: "単 太郎", team: "甲中" },
      { event: "混合ダブルス", type: "mixed", fee: 1000, name1: "混 男", name2: "混 女", team1: "甲中", team2: "乙中" },
    ],
  });
  const ents = db.getEntrants(t.id);
  assert.ok(ents.some(e => e.event === "混合ダブルス"), "混合ダブルスが登録されている");
  assert.ok(ents.some(e => e.event === "男子シングルス"), "シングルスも登録");
});

test("findDuplicatePlayerCandidates: 漢字名/ふりがな一致のみ。漢字1文字違いは非検出", () => {
  const A = db.createPlayer({ name: "山田 太郎", furigana: "やまだ たろう", _allowAnyName: true });
  const B = db.createPlayer({ name: "山田太郎", furigana: "やまだ たろう", _allowAnyName: true });
  const C = db.createPlayer({ name: "山田次郎", furigana: "やまだ じろう", _allowAnyName: true });
  const D = db.createPlayer({ name: "佐藤花子", furigana: "さとう はなこ", _allowAnyName: true });
  const E = db.createPlayer({ name: "佐東花子", furigana: "さとう はなこ", _allowAnyName: true });
  const r = db.findDuplicatePlayerCandidates();
  const together = (x, y) => r.groups.some(g => { const s = new Set(g.players.map(p => p.id)); return s.has(x) && s.has(y); });
  assert.ok(together(A.id, B.id), "漢字名一致(スペース違い)を検出");
  assert.ok(together(D.id, E.id), "ふりがな一致(漢字違い)を検出");
  assert.ok(!together(A.id, C.id), "漢字1文字違いは非検出");
  assert.ok(r.groups.every(g => g.reason === "氏名一致(スペース/表記ゆれ)" || g.reason === "ふりがな一致"), "理由は2種のみ");
});

test("監督モード: 発行→ロスター→修正申請→本部承認でDB反映 (#285)", () => {
  const c = db.createCoachAccount({ name: "顧問", player_cap: 5 });
  assert.ok(db.coachByCode(c.login_code), "coachByCode で引ける");
  const p = db.createPlayer({ name: "選手 一", team: "T中", _allowAnyName: true });
  assert.ok(db.addCoachPlayer(c.id, p.id).ok, "マイ選手に追加");
  const req = db.createPlayerRequest(c.id, { player_id: p.id, type: "edit", payload: { team: "新T中" }, reason: "所属変更" });
  assert.ok(req.ok && req.id, "修正申請作成");
  const res = db.resolvePlayerRequest(req.id, "approve");
  assert.ok(res.ok && res.applied, "承認 applied");
  assert.strictEqual(db.getPlayer(p.id).team, "新T中", "選手DBに反映");
  // 却下はDB不変
  const req2 = db.createPlayerRequest(c.id, { player_id: p.id, type: "edit", payload: { team: "却下" }, reason: "x" });
  db.resolvePlayerRequest(req2.id, "reject");
  assert.strictEqual(db.getPlayer(p.id).team, "新T中", "却下ではDB不変");
});

test("勝敗集計(MATCH_WL_SUBQ): BYE・不戦勝は勝敗に数えない", () => {
  const t = db.createTournament({ name: "勝敗検証", date: "2027-01-01" });
  const A = db.createPlayer({ name: "勝 太郎", _allowAnyName: true });
  const B = db.createPlayer({ name: "敗 次郎", _allowAnyName: true });
  const C = db.createPlayer({ name: "不戦 三郎", _allowAnyName: true });
  const raw = new Database(process.env.DB_PATH);
  const ins = raw.prepare("INSERT INTO matches (id,tournament_id,event,round,winner_id,loser_id,winner_name,loser_name,is_walkover) VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run("m1", t.id, "男子S", "1回戦", A.id, B.id, "勝 太郎", "敗 次郎", 0); // 実戦
  ins.run("m2", t.id, "男子S", "1回戦", A.id, null, "勝 太郎", "BYE", 0);     // BYE
  ins.run("m3", t.id, "男子S", "2回戦", A.id, C.id, "勝 太郎", "不戦 三郎", 1); // 不戦勝
  raw.close();
  const ps = db.getPlayers();
  const g = (id) => ps.find((p) => p.id === id);
  assert.strictEqual(g(A.id).match_wins, 1, "A勝数=1(BYE/不戦勝除外)");
  assert.strictEqual(g(A.id).match_losses, 0, "A敗数=0");
  assert.strictEqual(g(B.id).match_losses, 1, "B敗数=1");
  assert.strictEqual(g(C.id).match_losses, 0, "C(不戦勝の敗者)は数えない");
});
