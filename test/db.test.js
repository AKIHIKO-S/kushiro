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

test("inferPlayerBranches: 入力済みの選手から所属→支部の多数決で空欄を補完(オーナー要望 2026-07)", () => {
  // 同じ所属「北陽高」: 支部「釧路」が2名・空欄1名 → 空欄に釧路を提案
  const a = db.createPlayer({ name: "在籍太郎", team: "北陽高", branch: "釧路", _allowAnyName: true });
  const b = db.createPlayer({ name: "在籍次郎", team: "北陽高", branch: "釧路市", _allowAnyName: true }); // 正規化で釧路に一致
  const c = db.createPlayer({ name: "空欄三郎", team: "北陽高", _allowAnyName: true });                  // 空欄→補完対象
  // 割れる所属「割込中」: 帯広1・釧路1 → 同数なので埋めない
  db.createPlayer({ name: "割A", team: "割込中", branch: "帯広", _allowAnyName: true });
  db.createPlayer({ name: "割B", team: "割込中", branch: "釧路", _allowAnyName: true });
  const cSplit = db.createPlayer({ name: "割空欄", team: "割込中", _allowAnyName: true });
  // 手がかりの無い所属「無縁ク」: 補完しない
  const cNone = db.createPlayer({ name: "無縁", team: "無縁ク", _allowAnyName: true });

  const dry = db.inferPlayerBranches({ dry_run: true });
  const toOf = (id) => (dry.changes.find(x => x.id === id) || {}).to;
  assert.strictEqual(toOf(c.id), "釧路", "同一所属の多数決(釧路市も正規化で釧路)で空欄を補完");
  assert.ok(!dry.changes.some(x => x.id === cSplit.id), "同数で割れる所属は補完しない");
  assert.ok(!dry.changes.some(x => x.id === cNone.id), "手がかりの無い所属は補完しない");
  assert.strictEqual(db.getPlayer(c.id).branch || "", "", "dry_run はDBを変えない");
  // 本適用
  const ap = db.inferPlayerBranches({});
  assert.ok(ap.updated >= 1);
  assert.strictEqual(db.getPlayer(c.id).branch, "釧路", "本適用で補完");
  // 冪等(再実行で追加なし)
  assert.strictEqual(db.inferPlayerBranches({ dry_run: true }).changes.filter(x => x.id === c.id).length, 0);
  // 入力済み(a,b)は不変
  assert.strictEqual(db.getPlayer(a.id).branch, "釧路");
});

test("inferPlayerFurigana: 空欄のふりがなを名字辞書の姓読みで補完・既存は上書きしない", () => {
  // createPlayer は作成時に lookupFurigana で自動補完するため、既存の空欄状態を生SQLで用意する。
  const p1 = db.createPlayer({ name: "山田 太郎", _allowAnyName: true });   // FDに「山田」→やまだ
  const p2 = db.createPlayer({ name: "田中花子", _allowAnyName: true });     // FDに「田中」→たなか
  const p3 = db.createPlayer({ name: "山田 三郎", furigana: "やまだ さぶろう", _allowAnyName: true }); // 既存→不変
  const p4 = db.createPlayer({ name: "架空珍名", _allowAnyName: true });     // 辞書外→補完なし
  const raw = new Database(process.env.DB_PATH);
  raw.prepare("UPDATE players SET furigana='' WHERE id IN (?,?,?)").run(p1.id, p2.id, p4.id); // p3 は既存のまま残す
  raw.close();
  const dry = db.inferPlayerFurigana({ dry_run: true });
  const toOf = (id) => (dry.changes.find(x => x.id === id) || {}).to;
  assert.strictEqual(toOf(p1.id), "やまだ", "姓の読みを補完");
  assert.strictEqual(toOf(p2.id), "たなか");
  assert.ok(!dry.changes.some(x => x.id === p3.id), "既存ふりがなは上書きしない");
  assert.ok(!dry.changes.some(x => x.id === p4.id), "辞書に無い姓は補完しない");
  // 本適用
  db.inferPlayerFurigana({});
  assert.strictEqual(db.getPlayer(p1.id).furigana, "やまだ", "本適用で補完");
  assert.strictEqual(db.getPlayer(p3.id).furigana, "やまだ さぶろう", "既存は不変");
  assert.strictEqual(db.inferPlayerFurigana({ dry_run: true }).changes.filter(x => x.id === p1.id).length, 0, "冪等");
});

test("applyInferredFill: 選んだ行だけ空欄に書き込む・field はホワイトリスト・空欄以外は上書きしない", () => {
  const raw = new Database(process.env.DB_PATH);
  const p1 = db.createPlayer({ name: "適用一郎", team: "T", _allowAnyName: true });
  const p2 = db.createPlayer({ name: "適用二郎", team: "T", _allowAnyName: true });
  raw.prepare("UPDATE players SET furigana='', branch='' WHERE id IN (?,?)").run(p1.id, p2.id);
  raw.prepare("UPDATE players SET branch='帯広' WHERE id=?").run(p2.id); // p2は支部入力済み
  raw.close();
  // ふりがな: p1だけ適用(p2は選ばない)
  const rf = db.applyInferredFill("furigana", [{ id: p1.id, to: "てきよう" }]);
  assert.strictEqual(rf.updated, 1);
  assert.strictEqual(db.getPlayer(p1.id).furigana, "てきよう");
  assert.strictEqual(db.getPlayer(p2.id).furigana || "", "", "選ばれていない行は不変");
  // 支部: p2は入力済み(帯広)なので空欄条件で弾かれ上書きされない
  const rb = db.applyInferredFill("branch", [{ id: p1.id, to: "釧路" }, { id: p2.id, to: "釧路" }]);
  assert.strictEqual(rb.updated, 1, "空欄のp1のみ更新(p2は入力済みで不変)");
  assert.strictEqual(db.getPlayer(p1.id).branch, "釧路");
  assert.strictEqual(db.getPlayer(p2.id).branch, "帯広", "入力済みは上書きしない");
  // 不正field
  assert.ok(db.applyInferredFill("name", [{ id: p1.id, to: "x" }]).error, "対象外fieldはerror");
  assert.ok(db.applyInferredFill("category", [{ id: p1.id, to: "middle" }]).error, "categoryも対象外(誤用防止)");
});

test("lookupFurigana 旧字畳み: 髙橋/渡邊/齋藤/田澤 等が新字辞書で読める(名寄せ精度向上)", () => {
  // createPlayer 経由(作成時に lookupFurigana が走る)で旧字→新字の畳み込みを確認
  const cases = [["髙橋 拓", "たかはし"], ["渡邊 花", "わたなべ"], ["渡邉 実", "わたなべ"],
    ["齋藤 一", "さいとう"], ["田澤 二", "たざわ"], ["中澤 三", "なかざわ"], ["髙山 六", "たかやま"],
    ["熊谷 四", "くまがい"], ["長嶋 九", "ながしま"]];
  cases.forEach(([nm, exp]) => {
    const p = db.createPlayer({ name: nm, _allowAnyName: true });
    assert.strictEqual(db.getPlayer(p.id).furigana, exp, nm + " → " + exp);
  });
  // 表示名は旧字のまま保持される(照合キーだけ新字化)
  const q = db.createPlayer({ name: "髙橋 保持", _allowAnyName: true });
  assert.strictEqual(db.getPlayer(q.id).name, "髙橋 保持", "表示名は旧字のまま");
});

test("renameTeam: 所属名の統一(鳥取中学→鳥取中学校)。完全一致のみ・dry_run不変・冪等", () => {
  const t = db.createTournament({ name: "所属統一", date: "2028-02-01" });
  const p1 = db.createPlayer({ name: "統一A", team: "鳥取中学", _allowAnyName: true });
  const p2 = db.createPlayer({ name: "統一B", team: "鳥取中学", _allowAnyName: true });
  const p3 = db.createPlayer({ name: "無関係", team: "鳥取中学校前クラブ", _allowAnyName: true }); // 部分一致=巻き込まない
  db.createEntrant({ tournament_id: t.id, event: "男子シングルス", name: "参加X", team: "鳥取中学" });
  // dry_run: 件数を返しDBは不変
  const dry = db.renameTeam("鳥取中学", "鳥取中学校", { dry_run: true });
  assert.ok(dry.ok && dry.counts.players === 2, "選手2名が対象: " + JSON.stringify(dry.counts));
  assert.ok(dry.counts.entrants >= 1, "参加記録も対象");
  assert.strictEqual(db.getPlayer(p1.id).team, "鳥取中学", "dry_run はDBを変えない");
  // 本適用
  const r = db.renameTeam("鳥取中学", "鳥取中学校");
  assert.ok(r.ok);
  assert.strictEqual(db.getPlayer(p1.id).team, "鳥取中学校", "p1が統一先へ");
  assert.strictEqual(db.getPlayer(p2.id).team, "鳥取中学校", "p2も統一先へ");
  assert.strictEqual(db.getPlayer(p3.id).team, "鳥取中学校前クラブ", "部分一致の別チームは不変");
  // 冪等(再適用で対象0)
  assert.strictEqual(db.renameTeam("鳥取中学", "鳥取中学校", { dry_run: true }).total, 0, "統一後は対象0");
  // ガード
  assert.ok(db.renameTeam("", "x").error, "空はerror");
  assert.ok(db.renameTeam("同じ", "同じ").error, "同名はerror");
});

test("placeEntrantInSlot: 参加者を枠へ移動(元位置=空欄・元占有者=未配置・entrantは残る)", () => {
  const t = db.createTournament({ name: "枠移動検証", date: "2028-08-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 0 }] });
  const ids = [];
  for (let i = 1; i <= 8; i++) ids.push(db.createEntrant({ tournament_id: t.id, event: "男子シングルス",
    name: "枠" + i, team: "T" + i, furigana: "わ" + i, seed: i, status: "confirmed" }).id);
  db.generateBracket(t.id, "男子シングルス", {});
  const r1 = () => db.getMatchesByTournament(t.id).filter(m => m.event === "男子シングルス" && m.bracket_round === 1)
    .sort((a, b) => a.bracket_pos - b.bracket_pos);
  // 枠3(pos1,slot1)にいる選手Xと、pos0,slot2にいる選手Yを把握
  const before = r1();
  const targetPos = 0, targetSlot = 1;             // ここへ移動先(元占有者=Y)
  const Y_eid = before.find(m => m.bracket_pos === 0).player1_entrant_id;
  const X_match = before.find(m => m.bracket_pos === 1);
  const X_eid = X_match.player1_entrant_id;         // Xは pos1,slot1 にいる
  assert.ok(X_eid && Y_eid && X_eid !== Y_eid);
  // X を pos0,slot1 へ移動
  const res = db.placeEntrantInSlot(t.id, "男子シングルス", targetPos, targetSlot, X_eid);
  assert.ok(res && (res.success || !res.error), JSON.stringify(res).slice(0, 120));
  const after = r1();
  const at = (pos, slot) => { const m = after.find(x => x.bracket_pos === pos); return slot === 1 ? m.player1_entrant_id : m.player2_entrant_id; };
  // 対象枠は X に
  assert.strictEqual(at(0, 1), X_eid, "対象枠は選んだ選手Xに");
  // X の元位置(pos1,slot1)は空欄
  assert.ok(!at(1, 1), "選んだ選手の元位置は空欄");
  // Y はどの1回戦枠にもいない=未配置
  const placedEids = new Set();
  after.forEach(m => { if (m.player1_entrant_id) placedEids.add(m.player1_entrant_id); if (m.player2_entrant_id) placedEids.add(m.player2_entrant_id); });
  assert.ok(!placedEids.has(Y_eid), "元占有者Yは未配置(トーナメントから落ちる)");
  // Y は entrant としては残っている
  assert.ok(db.getEntrant(Y_eid), "Yはentrantとして残る(削除されない)");
  // 既にその枠にいる選手を同じ枠へ=何もしない(noop)
  const noop = db.placeEntrantInSlot(t.id, "男子シングルス", 0, 1, X_eid);
  assert.ok(noop && noop.success, "同じ枠への移動はnoop");
});
