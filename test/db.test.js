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

test("findDuplicatePlayerCandidates: ふりがなと漢字氏名の両方一致のみ(オーナー要望 2026-07)", () => {
  const A = db.createPlayer({ name: "山田 太郎", furigana: "やまだ たろう", _allowAnyName: true });
  const B = db.createPlayer({ name: "山田太郎", furigana: "ヤマダタロウ", _allowAnyName: true }); // カタカナでも同一読み
  const C = db.createPlayer({ name: "山田次郎", furigana: "やまだ じろう", _allowAnyName: true });
  const D = db.createPlayer({ name: "佐藤花子", furigana: "さとう はなこ", _allowAnyName: true });
  const E = db.createPlayer({ name: "佐東花子", furigana: "さとう はなこ", _allowAnyName: true }); // 読み同・漢字違い=別人
  const F = db.createPlayer({ name: "山田太郎", team: "ふりがな無し", _allowAnyName: true });      // ふりがな未登録
  const r = db.findDuplicatePlayerCandidates();
  const together = (x, y) => r.groups.some(g => { const s = new Set(g.players.map(p => p.id)); return s.has(x) && s.has(y); });
  assert.ok(together(A.id, B.id), "漢字名一致(スペース違い)+ふりがな一致(カタカナ↔ひらがな)を検出");
  assert.ok(!together(D.id, E.id), "読みが同じでも漢字が違えば非検出(別人を出さない)");
  assert.ok(!together(A.id, C.id), "漢字1文字違いは非検出");
  assert.ok(!together(A.id, F.id), "ふりがな未登録は候補に出さない");
  assert.ok(r.groups.every(g => g.reason === "氏名・ふりがな一致"), "理由は1種のみ");
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

test("detectSchoolCategory: 略字(末尾の中/高/大/小)も判定・地名/氏名は誤爆しない(オーナー要望 2026-07)", () => {
  // 正式名称
  assert.strictEqual(db.detectSchoolCategory("釧路第一中学校", ""), "middle");
  assert.strictEqual(db.detectSchoolCategory("湖陵高等学校", ""), "high");
  assert.strictEqual(db.detectSchoolCategory("北海道教育大学", ""), "university");
  assert.strictEqual(db.detectSchoolCategory("鳥取小学校", ""), "elementary");
  // 末尾略字
  assert.strictEqual(db.detectSchoolCategory("附属中", ""), "middle");
  assert.strictEqual(db.detectSchoolCategory("湖陵高", ""), "high");
  assert.strictEqual(db.detectSchoolCategory("教育大", ""), "university");
  assert.strictEqual(db.detectSchoolCategory("鳥取小", ""), "elementary");
  assert.strictEqual(db.detectSchoolCategory("附属中(A)", ""), "middle", "末尾のチーム区分(A)を無視");
  // 高専は high
  assert.strictEqual(db.detectSchoolCategory("釧路高専", ""), "high");
  // 地名・氏名・クラブ名の誤爆なし(中間一致にしない)
  assert.strictEqual(db.detectSchoolCategory("大楽毛クラブ", ""), null, "大が先頭でも大学にしない");
  assert.strictEqual(db.detectSchoolCategory("中標津クラブ", ""), null, "中が先頭でも中学にしない");
  assert.strictEqual(db.detectSchoolCategory("暁クラブ", ""), null);
  assert.strictEqual(db.detectSchoolCategory("", ""), null);
});

test("normalizePlayerCategories/Branches: dry_run はDB不変で変更一覧を返し、本適用で反映", () => {
  // createPlayer は作成時にカテゴリを自動補完するため、正規化関数の対象=「既存の古いデータ」を
  // 生SQLで用意する(category=general のまま team=学校名 / branch=市付き の未整形状態)。
  const p1 = db.createPlayer({ name: "略字太郎", team: "T", _allowAnyName: true });
  const p2 = db.createPlayer({ name: "地名花子", team: "大楽毛クラブ", _allowAnyName: true });    // 変更なし(誤爆しない)
  const p3 = db.createPlayer({ name: "支部一郎", team: "T", _allowAnyName: true });
  const raw = new Database(process.env.DB_PATH);
  raw.prepare("UPDATE players SET team='附属中', category='general' WHERE id=?").run(p1.id);
  raw.prepare("UPDATE players SET branch='釧路市' WHERE id=?").run(p3.id);
  raw.close();
  // カテゴリ dry_run
  const catDry = db.normalizePlayerCategories({ dry_run: true });
  assert.ok(catDry.changes.some(c => c.id === p1.id && c.to === "middle"), "附属中→middle が提案される");
  assert.ok(!catDry.changes.some(c => c.id === p2.id), "大楽毛は提案されない");
  assert.strictEqual(db.getPlayer(p1.id).category, "general", "dry_run はDBを変えない");
  // 支部 dry_run
  const brDry = db.normalizePlayerBranches({ dry_run: true });
  assert.ok(brDry.changes.some(c => c.id === p3.id && c.from === "釧路市" && c.to === "釧路"), "釧路市→釧路 が提案される");
  assert.strictEqual(db.getPlayer(p3.id).branch, "釧路市", "dry_run はDBを変えない");
  // 本適用
  const catApply = db.normalizePlayerCategories({});
  assert.ok(catApply.updated >= 1);
  assert.strictEqual(db.getPlayer(p1.id).category, "middle", "本適用で反映");
  const brApply = db.normalizePlayerBranches({});
  assert.ok(brApply.updated >= 1);
  assert.strictEqual(db.getPlayer(p3.id).branch, "釧路", "本適用で支部正規化");
  // 再適用は冪等(変更なし)
  assert.strictEqual(db.normalizePlayerBranches({ dry_run: true }).changes.filter(c => c.id === p3.id).length, 0, "再実行で追加変更なし");
});
