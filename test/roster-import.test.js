// 名簿(エントリー表)Excel取込の回帰テスト。データは全て合成(実名・実データ不使用)。
//   ・シングルス: 氏名空白スキップ / チーム名優先(空欄は申込チーム) / 区分→性別・年代
//   ・支部正規化: 支部/市/県の接尾辞除去・根室管内卓球連盟→根室・根釧→釧根・括弧除去
//   ・ダブルス: 1行=1ペア(氏名1/氏名2) / 支部連記(・区切り)は両者に対応 / ペア不成立はスキップ+警告
//   ・DB照合: 支部空欄は過去 entrants から補完、無ければ保留
//   ・importRoster: 冪等(重複スキップ) / event_config へ種目追加 / オープン=男女別S/D
// 実行: node --test test/roster-import.test.js
process.env.DB_PATH = "/tmp/ktta_roster_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const H_S = ["申込チーム", "No,", "区分", "氏名", "チーム名", "支部", "備考"];
const H_D = ["申込チーム", "No,", "区分", "氏名1", "氏名2", "チーム名1", "チーム名2", "支部", "備考"];

test("支部名の正規化", () => {
  const cases = [
    ["釧路市", "釧路"], ["釧路支部", "釧路"], ["釧路", "釧路"],
    ["札幌市", "札幌"], ["札幌支部", "札幌"],
    ["根室管内卓球連盟", "根室"], ["根室管内", "根室"], ["根室)", "根室"],
    ["根釧支部", "釧根"], ["釧根支部", "釧根"], ["根釧", "釧根"], ["釧根", "釧根"],
    ["秋田県", "秋田"], ["東京", "東京"], ["十勝支部", "十勝"], ["", ""],
  ];
  cases.forEach(([i, exp]) => assert.strictEqual(db.normalizeShibuName(i), exp, i + " → " + exp));
});

test("シングルス: ヘッダ/空白行スキップ・チーム名優先・区分の分解・支部正規化", () => {
  const singles = [
    H_S,
    ["星クラブ", 1, "一般男子", "北野 一", "星クラブ", "釧路市", ""],
    ["星クラブ", 2, "一般女子", "南田 二子", "月クラブ", "札幌支部", ""],
    ["", "", "", "", "", "", "重複のため削除"],             // 氏名空白=スキップ
    ["空クラブ", 1, "中学男子", "東山 三", "", "根室管内卓球連盟", ""],   // チーム名空欄→申込チーム
    ["空クラブ", 2, "小学女子", "西川 四美", "空クラブ", "", ""],        // 支部空欄
  ];
  const { entries, issues, stats } = db.parseRosterRows({ singles, doubles: [] });
  assert.strictEqual(entries.length, 4, "実データ4行");
  assert.strictEqual(stats.skipped, 1, "空白行1スキップ");
  const [a, b, c, d] = entries;
  assert.deepStrictEqual([a.name, a.team, a.region, a.gender, a.division], ["北野 一", "星クラブ", "釧路", "male", "一般"]);
  assert.deepStrictEqual([b.team, b.region, b.gender], ["月クラブ", "札幌", "female"]);
  assert.deepStrictEqual([c.team, c.region, c.division], ["空クラブ", "根室", "中学生"], "チーム名空欄は申込チーム・連盟→根室");
  assert.deepStrictEqual([d.region, d.division, d.gender], ["", "小学生", "female"]);
  assert.ok(issues.some(x => x.level === "warn" && /支部が空欄/.test(x.msg)), "支部空欄warn");
});

test("ダブルス: 1行=1ペア・支部連記・ペア不成立・チーム名2空欄", () => {
  const doubles = [
    H_D,
    ["星クラブ", 1, "一般男子", "北野 一", "東山 三", "星高校", "空中学校", "釧路市", ""],
    ["星クラブ", 2, "一般男子", "青木 五", "赤井 六", "星クラブ", "星クラブ", "深川支部・札幌支部", ""],   // 連記
    ["月クラブ", 1, "一般女子", "南田 二子", "", "月クラブ", "", "釧路", ""],                          // ペア不成立
    ["月クラブ", 2, "高校女子", "白鳥 七海", "黒田 八重", "月クラブ", "", "北見", ""],                  // チーム名2空欄
  ];
  const { entries, issues, stats } = db.parseRosterRows({ singles: [], doubles });
  assert.strictEqual(entries.length, 3, "有効ペア3(不成立1除外)");
  assert.strictEqual(stats.skipped, 1, "不成立1スキップ");
  const [p1, p2, p3] = entries;
  assert.deepStrictEqual([p1.name, p1.partner_name, p1.team, p1.partner_team], ["北野 一", "東山 三", "星高校", "空中学校"]);
  assert.deepStrictEqual([p1.region, p1.partner_region], ["釧路", "釧路"], "支部1つ=両者共通");
  assert.deepStrictEqual([p2.region, p2.partner_region], ["深川", "札幌"], "連記は氏名1/氏名2に対応");
  assert.strictEqual(p3.partner_team, "", "チーム名2空欄はそのまま(警告)");
  assert.ok(issues.some(x => /ペア不成立/.test(x.msg)), "不成立warn");
  assert.ok(issues.some(x => /パートナーのチーム名が空欄/.test(x.msg)), "チーム名2空欄warn");
});

test("種目マッピング: オープン=男女別S/D・カテゴリ=区分ごと", () => {
  const s = { type: "singles", kubun: "中学男子", gender: "male" };
  const d = { type: "doubles", kubun: "一般女子", gender: "female" };
  assert.strictEqual(db.rosterEventName(s, "open"), "男子シングルス");
  assert.strictEqual(db.rosterEventName(d, "open"), "女子ダブルス");
  assert.strictEqual(db.rosterEventName(s, "category"), "中学男子シングルス");
  assert.strictEqual(db.rosterEventName(d, "category"), "一般女子ダブルス");
});

test("DB照合: 支部空欄は過去の登録から補完・無ければ保留", () => {
  // 過去大会に「北野 一」を支部=釧路で登録しておく
  const past = db.createTournament({ name: "過去大会", date: "2025-06-01" });
  db.createEntrant({ tournament_id: past.id, event: "男子シングルス", name: "北野 一", team: "星クラブ", region: "釧路", status: "confirmed" });
  const entries = [
    { type: "singles", name: "北野一", team: "星クラブ", region: "", sheet: "S", srcRow: 2 },   // 空白違いでも一致
    { type: "singles", name: "居内 無人", team: "幻クラブ", region: "", sheet: "S", srcRow: 3 },
  ];
  const issues = db.enrichRosterRegions(entries);
  assert.strictEqual(entries[0].region, "釧路", "DBから補完");
  assert.strictEqual(entries[1].region, "", "未登録は保留(空のまま)");
  assert.ok(issues.some(x => /補完/.test(x.msg)) && issues.some(x => /保留/.test(x.msg)));
});

test("importRoster: 冪等・event_config追加・ダブルスのpartner格納", () => {
  const t = db.createTournament({ name: "取込先大会", date: "2027-08-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [] });
  const parsed = db.parseRosterRows({
    singles: [H_S,
      ["星クラブ", 1, "一般男子", "北野 一", "星クラブ", "釧路", ""],
      ["月クラブ", 1, "中学女子", "南田 二子", "月クラブ", "北見", ""]],
    doubles: [H_D,
      ["星クラブ", 1, "一般男子", "北野 一", "東山 三", "星高校", "空中学校", "釧路・札幌", ""]],
  });
  const r1 = db.importRoster(t.id, { mode: "open", entries: parsed.entries });
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.strictEqual(r1.created, 3, "3件作成");
  assert.deepStrictEqual(r1.events.sort(), ["女子シングルス", "男子シングルス", "男子ダブルス"], "オープン種目");
  // 冪等: 再実行は全スキップ
  const r2 = db.importRoster(t.id, { mode: "open", entries: parsed.entries });
  assert.strictEqual(r2.created, 0, "再実行は作成0");
  assert.strictEqual(r2.skipped_duplicate, 3, "重複3スキップ");
  // event_config に追加されている
  const tt = db.getTournament(t.id);
  const cfg = typeof tt.event_config === "string" ? JSON.parse(tt.event_config) : tt.event_config;
  assert.ok(cfg.some(c => c.name === "男子ダブルス" && c.type === "doubles"), "event_configにダブルス種目");
  // ダブルスの partner 格納
  const dbl = db.getEntrants(t.id, "男子ダブルス")[0];
  assert.strictEqual(parseInt(dbl.is_doubles) || 0, 1, "is_doubles=1");
  assert.deepStrictEqual([dbl.partner_name, dbl.partner_team, dbl.region, dbl.partner_region],
    ["東山 三", "空中学校", "釧路", "札幌"], "パートナー/支部が正しく格納");
  // カテゴリ別モードでは区分ごとの種目名
  const t2 = db.createTournament({ name: "カテゴリ大会", date: "2027-08-02" });
  const r3 = db.importRoster(t2.id, { mode: "category", entries: parsed.entries });
  assert.ok(r3.events.includes("中学女子シングルス"), "カテゴリ別種目: " + r3.events.join(","));
});

// ── P2: トーナメント作成プラン(近接警告+オープン種目のスーパーシード必須) ──

test("近接警告: 同チーム/同支部が10番以内で警告・釧路支部同士は除外", () => {
  // 6人(全番号が互いに5以内)で構成: 同チーム遠征組=警告 / 同支部(北見)=警告 / 釧路同士の同チーム=除外
  const mk = (name, team, region) => ({ display_name: name, name, team, partner_team: "", region, partner_region: "" });
  const leaves = [
    mk("旅人A", "遠征クラブ", "帯広"), mk("旅人B", "遠征クラブ", "帯広"),   // 同チーム(非釧路)→警告
    mk("北見X", "氷クラブ", "北見"), mk("北見Y", "雪クラブ", "北見"),       // 別チーム同支部(北見)→警告
    mk("地元P", "港クラブ", "釧路"), mk("地元Q", "港クラブ", "釧路"),       // 同チームだが釧路同士→除外
  ];
  const warns = db.proximityFromLeaves(leaves);
  assert.ok(warns.some(w => w.reason === "同チーム" && /旅人A/.test(w.msg) && /旅人B/.test(w.msg)), "遠征同チーム警告");
  assert.ok(warns.some(w => /同支部/.test(w.reason) && /北見X/.test(w.msg) && /北見Y/.test(w.msg)), "同支部(北見)警告");
  assert.ok(!warns.some(w => /地元P/.test(w.msg) && /地元Q/.test(w.msg)), "釧路支部同士は警告なし");
});

test("近接警告: 10番より離れていれば警告なし・BYEは番号に数えない", () => {
  const mk = (name, team, region) => ({ display_name: name, name, team, partner_team: "", region, partner_region: "" });
  // 同チーム2人の間に BYE(null) を挟んでも「番号」は実選手のみで数える
  const leaves = [mk("甲", "遠征ク", "帯広"), null, null, mk("乙", "遠征ク", "帯広")];
  const w1 = db.proximityFromLeaves(leaves);
  assert.ok(w1.some(w => w.reason === "同チーム"), "BYE挟みでも番号距離1=警告");
  // 12人離せば警告なし
  const far = [mk("甲", "遠征ク", "帯広")];
  for (let i = 0; i < 11; i++) far.push(mk("他" + i, "チーム" + i, "支部" + i));
  far.push(mk("乙", "遠征ク", "帯広"));
  const w2 = db.proximityFromLeaves(far);
  assert.ok(!w2.some(w => /甲/.test(w.msg) && /乙/.test(w.msg)), "距離12は警告なし");
});

test("オープン種目のスーパーシード必須: 未指定は確定ブロック(needs_force)・指定/強制で通る", () => {
  const t = db.createTournament({ name: "オープン大会", date: "2027-09-01" });
  const parsed = db.parseRosterRows({
    singles: [H_S,
      ["星", 1, "一般男子", "北野 一", "星クラブ", "釧路", ""],
      ["星", 2, "一般男子", "青木 五", "月クラブ", "帯広", ""],
      ["星", 3, "中学男子", "東山 三", "空クラブ", "北見", ""],
      ["星", 4, "高校男子", "西川 四", "海クラブ", "根室", ""]],
    doubles: [],
  });
  db.importRoster(t.id, { mode: "open", entries: parsed.entries });
  const EVO = "男子シングルス";
  // readiness が block を出す
  const rdy = db.checkDrawReadiness(t.id, EVO);
  assert.ok(rdy.issues.some(i => i.code === "open_needs_super_seed" && i.level === "block"), "readinessにSS必須block");
  // プレビューは通る(プラン確認可能)・確定は needs_force
  const es = db.getEntrants(t.id, EVO);
  db.setEntrantSeed(es[0].id, 1); db.setEntrantSeed(es[1].id, 2);
  const pv = db.drawSingleBracket(t.id, EVO, { draw_seed: 5, preview: true });
  assert.ok(pv.preview, "プレビューは通る");
  assert.ok(Array.isArray(pv.proximity_warnings), "プレビューに近接警告フィールド");
  const ng = db.drawSingleBracket(t.id, EVO, { draw_seed: 5, drawn_by: "検証" });
  assert.ok(ng.error && ng.needs_force, "SS未指定の確定はブロック: " + JSON.stringify(ng.error));
  // SS指定で通る
  db.setEntrantEntryRound(es[0].id, 2);
  const ok = db.drawSingleBracket(t.id, EVO, { draw_seed: 5, drawn_by: "検証" });
  assert.ok(ok.success, "SS指定後は確定できる: " + JSON.stringify(ok.error || ""));
  // 確定後の再チェックAPI相当
  const px = db.computeBracketProximity(t.id, EVO);
  assert.ok(px.ok && typeof px.count === "number", "確定後の近接再チェックが動く");
  // カテゴリ別種目(openフラグなし)はSS無しでも確定できる
  const t2 = db.createTournament({ name: "カテゴリ大会2", date: "2027-09-02" });
  db.importRoster(t2.id, { mode: "category", entries: parsed.entries });
  const es2 = db.getEntrants(t2.id, "一般男子シングルス");
  assert.ok(es2.length >= 2, "カテゴリ種目に2名");
  const ok2 = db.drawSingleBracket(t2.id, "一般男子シングルス", { draw_seed: 5, drawn_by: "検証" });
  assert.ok(ok2.success, "カテゴリ種目はSS不要: " + JSON.stringify(ok2.error || ""));
});

// ── エントリーリスト形式(タブ=種目)の直接取込 ──

test("エントリーリスト: タブ=種目・S/D列判定・支部連記・ユーティリティシート除外", () => {
  const sheets = [
    { name: "男子シングルス", rows: [
      ["氏名", "チーム名", "支部", "備考"],
      ["北野 一", "星クラブ", "釧路市", ""],
      ["青木 五", "月クラブ", "帯広", "何かメモ"],
      ["", "", "", ""],
    ]},
    { name: "男子ダブルス", rows: [
      ["氏名1", "氏名2", "チーム名1", "チーム名2", "支部"],
      ["北野 一", "東山 三", "星高校", "空中学校", "深川支部・札幌支部"],
      ["白鳥 七", "", "月クラブ", "", "釧路"],
    ]},
    // 罠: 参加人数シートはヘッダが「氏名」で始まるがチーム名ヘッダが無い→対象外
    { name: "参加人数", rows: [["氏名", "申込チーム", "一般男子", "高校男子"], ["誰か", "", "", ""]] },
    { name: "重複チェック", rows: [["シングルス", "", "ダブルス"], ["名前名前", "", "組"]] },
  ];
  const { entries, issues, stats } = db.parseEntryListSheets(sheets);
  assert.deepStrictEqual(stats.sheets, ["男子シングルス", "男子ダブルス"], "種目シートのみ対象");
  assert.strictEqual(stats.singles, 2, "S2名");
  assert.strictEqual(stats.doubles, 1, "D1組(不成立1除外)");
  const s1 = entries.find(e => e.name === "北野 一" && e.type === "singles");
  assert.deepStrictEqual([s1.event, s1.region, s1.gender], ["男子シングルス", "釧路", "male"]);
  const d1 = entries.find(e => e.type === "doubles");
  assert.deepStrictEqual([d1.event, d1.region, d1.partner_region], ["男子ダブルス", "深川", "札幌"], "連記対応");
  assert.ok(issues.some(i => /ペア不成立/.test(i.msg)), "不成立warn");
  assert.ok(!entries.some(e => e.name === "誰か"), "参加人数シートは取り込まない");
});

test("エントリーリスト: 支部列なし(小規模大会)は行ごとの警告を出さずシート単位のinfo", () => {
  const sheets = [
    { name: "一般男子シングルス", rows: [
      ["氏名", "チーム名"],
      ["北野 一", "星クラブ"],
      ["青木 五", "月クラブ"],
    ]},
  ];
  const { entries, issues } = db.parseEntryListSheets(sheets);
  assert.strictEqual(entries.length, 2);
  assert.ok(entries.every(e => e.region === ""), "支部は空(保留)");
  assert.ok(issues.some(i => i.level === "info" && /支部列がありません/.test(i.msg)), "シート単位のinfo");
  assert.ok(!issues.some(i => i.level === "warn" && /支部が空欄/.test(i.msg)), "行ごとの空欄warnは出さない");
  // 種目名から区分も取れている(一般男子シングルス→一般/male)
  assert.deepStrictEqual([entries[0].division, entries[0].gender], ["一般", "male"]);
});

test("エントリーリスト: direct取込は種目=タブ名・open指定でSS必須が有効化", () => {
  const t = db.createTournament({ name: "直接取込大会", date: "2027-10-01" });
  const sheets = [
    { name: "男子シングルス", rows: [
      ["氏名", "チーム名", "支部"],
      ["北野 一", "星クラブ", "釧路"], ["青木 五", "月クラブ", "帯広"],
      ["東山 三", "空クラブ", "北見"], ["西川 四", "海クラブ", "根室"],
    ]},
  ];
  const { entries } = db.parseEntryListSheets(sheets);
  const r = db.importRoster(t.id, { mode: "direct", open: true, entries });
  assert.ok(r.ok && r.created === 4, "4件作成: " + JSON.stringify(r));
  assert.deepStrictEqual(r.events, ["男子シングルス"], "種目=タブ名");
  // openフラグ→SS必須のreadiness block
  const es = db.getEntrants(t.id, "男子シングルス");
  db.setEntrantSeed(es[0].id, 1);
  const rdy = db.checkDrawReadiness(t.id, "男子シングルス");
  assert.ok(rdy.issues.some(i => i.code === "open_needs_super_seed"), "open指定でSS必須が効く");
  // 冪等
  const r2 = db.importRoster(t.id, { mode: "direct", open: true, entries });
  assert.strictEqual(r2.created, 0, "再実行は作成0");
  // open未指定なら SS必須は付かない
  const t2 = db.createTournament({ name: "直接取込小規模", date: "2027-10-02" });
  db.importRoster(t2.id, { mode: "direct", entries });
  const es2 = db.getEntrants(t2.id, "男子シングルス");
  db.setEntrantSeed(es2[0].id, 1);
  const rdy2 = db.checkDrawReadiness(t2.id, "男子シングルス");
  assert.ok(!rdy2.issues.some(i => i.code === "open_needs_super_seed"), "open未指定はSS必須なし");
});

// ── 反証で挙がった辺縁の修正(UTIL緩和/type不整合/列黙殺/支部連記の位置/event検証) ──

test("エントリーリスト: マスターズ等の実在種目を除外しない・列不足シートは警告を出す(黙殺しない)", () => {
  const sheets = [
    { name: "マスターズ男子シングルス", rows: [["氏名", "チーム名", "支部"], ["北野 一", "星クラブ", "釧路"]] },
    { name: "男子ダブルス", rows: [["氏名1", "氏名2", "所属"], ["甲", "乙", "共通クラブ"]] },
    { name: "女子ダブルス", rows: [["氏名", "チーム名", "支部"], ["丙 花", "港クラブ", "釧路"]] },
    { name: "重複チェック", rows: [["シングルス", "", "ダブルス"], ["x", "", "y"]] },
  ];
  const { entries, issues, stats } = db.parseEntryListSheets(sheets);
  assert.ok(entries.some(e => e.name === "北野 一"), "マスターズ種目を取り込む");
  assert.deepStrictEqual(stats.sheets, ["マスターズ男子シングルス"], "有効シートはマスターズのみ");
  assert.ok(issues.some(i => i.level === "warn" && /男子ダブルス.*見つからない/.test(i.msg)), "ダブルス列不足の警告");
  assert.ok(issues.some(i => i.level === "warn" && /女子ダブルス.*個人戦の列/.test(i.msg)), "type不整合の警告");
  assert.ok(!entries.some(e => e.name === "丙 花"), "type不整合シートは取り込まない");
});

test("支部連記: 先頭区切りは氏名1側を空欄(DB補完へ)・末尾区切りは氏名2側を空欄", () => {
  const sheets = [{ name: "男子ダブルス", rows: [
    ["氏名1", "氏名2", "チーム名1", "チーム名2", "支部"],
    ["甲", "乙", "A", "B", "・札幌"],
    ["丙", "丁", "C", "D", "釧路・"],
    ["戊", "己", "E", "F", "釧路・札幌・帯広"],
  ]}];
  const { entries, issues } = db.parseEntryListSheets(sheets);
  assert.deepStrictEqual([entries[0].region, entries[0].partner_region], ["", "札幌"], "先頭空=氏名1側は保留");
  assert.deepStrictEqual([entries[1].region, entries[1].partner_region], ["釧路", ""], "末尾空=氏名2側は保留");
  assert.deepStrictEqual([entries[2].region, entries[2].partner_region], ["釧路", "札幌"], "3つ以上は先頭2つ");
  assert.ok(issues.some(i => /連記が3つ以上/.test(i.msg)), "3連記の警告");
});

test("direct取込: e.event の制御文字・巨大文字列はサニタイズ(60字上限)", () => {
  const t = db.createTournament({ name: "サニタイズ検証", date: "2027-11-03" });
  const CTRL = String.fromCharCode(10), TAB = String.fromCharCode(9);
  const entries = [
    { type: "singles", event: "男子" + CTRL + "シングルス" + TAB, name: "甲 太郎", team: "A", gender: "male" },
    { type: "singles", event: "Z".repeat(200), name: "乙 次郎", team: "B", gender: "male" },
  ];
  const r = db.importRoster(t.id, { mode: "direct", entries });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.events.includes("男子 シングルス"), "改行/タブは空白1つに圧縮: " + JSON.stringify(r.events));
  assert.ok(r.events.every(ev => ev.length <= 60), "60字上限");
  const ctrlRe = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + "]");
  assert.ok(!r.events.some(ev => ctrlRe.test(ev)), "制御文字が残らない");
});

test("format判定用: meibo(区分列あり)連記も位置保持後に既存挙動を維持", () => {
  const { entries } = db.parseRosterRows({
    singles: [], doubles: [H_D, ["星", 1, "一般男子", "甲", "乙", "星高", "空中", "深川支部・札幌支部", ""]],
  });
  assert.deepStrictEqual([entries[0].region, entries[0].partner_region], ["深川", "札幌"], "meibo連記も位置保持で正しい");
});

// ── 名簿取込の選手DB連携(初参加登録)と一括修正のフリガナ伝播 ──

test("取込時に初参加を選手DBへ登録・entrantにplayer_idを張る(既存はリンク)", () => {
  const t = db.createTournament({ name: "選手連携", date: "2027-12-01" });
  const entries = db.parseEntryListSheets([
    { name: "男子シングルス", rows: [["氏名", "チーム名", "支部"], ["高橋 太郎", "星ク", "釧路"], ["佐藤 次郎", "月ク", "帯広"]] },
    { name: "男子ダブルス", rows: [["氏名1", "氏名2", "チーム名1", "チーム名2", "支部"], ["高橋 太郎", "田中 三郎", "星ク", "空ク", "釧路"]] },
  ]).entries;
  const r = db.importRoster(t.id, { mode: "direct", register_players: true, entries });
  assert.ok(r.ok, JSON.stringify(r));
  // 男子S(高橋・佐藤)=新規2、男子D本人=高橋(既存リンク)+相方田中(新規)。新規3・連携1。
  assert.strictEqual(r.players_new, 3, "新規3人: " + JSON.stringify(r));
  assert.strictEqual(r.players_linked, 1, "既存リンク1(高橋がSとDで重複)");
  // 全 entrant に player_id
  const s = db.getEntrants(t.id, "男子シングルス");
  assert.ok(s.every(e => e.player_id), "男子S全員に player_id");
  const d = db.getEntrants(t.id, "男子ダブルス");
  assert.ok(d[0].player_id && d[0].partner_player_id, "ダブルスは本人+相方にplayer_id");
  // 選手DBに登録されている(高橋は1人に集約=名寄せ)
  const takahashi = db.getPlayers().filter(p => (p.name || "").includes("高橋"));
  assert.strictEqual(takahashi.length, 1, "高橋は1レコード(SとDで同一player)");
});

test("register_players:false なら選手DB登録しない(従来どおり entrant のみ)", () => {
  const t = db.createTournament({ name: "連携なし", date: "2027-12-02" });
  const entries = db.parseEntryListSheets([
    { name: "男子シングルス", rows: [["氏名", "チーム名"], ["渡辺 花", "港ク"]] },
  ]).entries;
  const r = db.importRoster(t.id, { mode: "direct", register_players: false, entries });
  assert.strictEqual(r.players_new, 0, "登録なし");
  assert.ok(db.getEntrants(t.id, "男子シングルス").every(e => !e.player_id), "player_id 無し");
});

test("フリガナ推定: 拡充辞書で一般的な苗字が引ける・苗字のみでも推定", () => {
  const t = db.createTournament({ name: "フリガナ推定", date: "2027-12-03" });
  // 拡充辞書にある苗字(西村・松田)+苗字のみ(given空)
  const entries = db.parseEntryListSheets([
    { name: "男子シングルス", rows: [["氏名", "チーム名"], ["西村 一", "A"], ["松田", "B"]] },
  ]).entries;
  db.importRoster(t.id, { mode: "direct", register_players: true, entries });
  const es = db.getEntrants(t.id, "男子シングルス");
  const nishimura = es.find(e => e.name.includes("西村"));
  const matsuda = es.find(e => e.name.includes("松田"));
  assert.strictEqual(nishimura.furigana, "にしむら", "西村→にしむら(拡充辞書)");
  assert.strictEqual(matsuda.furigana, "まつだ", "苗字のみ 松田→まつだ");
});

test("一括修正: 連携選手のフリガナを直すと entrant に伝播する(辞書に無い苗字でも)", () => {
  const t = db.createTournament({ name: "フリガナ伝播", date: "2027-12-04" });
  // 辞書に無い架空の苗字(推定不能)
  const entries = db.parseEntryListSheets([
    { name: "男子シングルス", rows: [["氏名", "チーム名"], ["珍名 一郎", "A"]] },
  ]).entries;
  db.importRoster(t.id, { mode: "direct", register_players: true, entries });
  const e = db.getEntrants(t.id, "男子シングルス")[0];
  assert.ok(!e.furigana, "推定不能なのでフリガナ空");
  assert.ok(e.player_id, "選手DBには登録済み(後で修正できる)");
  // 選手DBでフリガナを手修正 → 一括修正で entrant に反映
  db.updatePlayer(e.player_id, { furigana: "ちんめい" });
  const iss = db.findEntrantDataIssues(t.id);
  const it = iss.items.find(x => x.id === e.id);
  const fi = it.issues.find(z => z.code === "missing_furigana");
  assert.strictEqual(fi.suggested, "ちんめい", "提案は連携選手のフリガナ");
  const bf = db.bulkFixEntrantInference(t.id, { furigana: true, gender: false, category: false });
  assert.ok(bf.fixed >= 1, "一括修正で反映: " + JSON.stringify(bf));
  assert.strictEqual(db.getEntrants(t.id, "男子シングルス")[0].furigana, "ちんめい", "entrantに伝播");
});

// ── 敵対的検証で検出した2 critical の回帰防止 ──

test("誤リンク防止: 一括取込は同姓同名・別所属を既存選手に束ねず新規作成する", () => {
  const t = db.createTournament({ name: "誤リンク防止", date: "2028-01-01" });
  db.createPlayer({ name: "山田 太郎", team: "湖陵高校", gender: "male" });
  const entries = db.parseEntryListSheets([
    { name: "男子シングルス", rows: [["氏名", "チーム名", "支部"], ["山田 太郎", "江南高校", "釧路"]] },
  ]).entries;
  const r = db.importRoster(t.id, { mode: "direct", register_players: true, entries });
  assert.strictEqual(r.players_new, 1, "別所属は新規作成(誤結合しない)");
  assert.strictEqual(r.players_linked, 0, "既存(湖陵)にはリンクしない");
  const ent = db.getEntrants(t.id, "男子シングルス")[0];
  assert.strictEqual(db.getPlayer(ent.player_id).team, "江南高校", "リンク先は江南(表示と実体が一致)");
  assert.strictEqual(db.getPlayers().filter(p => p.name.includes("山田")).length, 2, "別人として2レコード");
});

test("正リンク: 同姓同名・同所属は既存選手に正しくリンク(重複作成しない)", () => {
  const t = db.createTournament({ name: "正リンク", date: "2028-01-02" });
  db.createPlayer({ name: "鈴木 花", team: "港ク", gender: "female" });
  const entries = db.parseEntryListSheets([
    { name: "女子シングルス", rows: [["氏名", "チーム名"], ["鈴木 花", "港ク"]] },
  ]).entries;
  const r = db.importRoster(t.id, { mode: "direct", register_players: true, entries });
  assert.strictEqual(r.players_new, 0, "新規作成なし");
  assert.strictEqual(r.players_linked, 1, "同所属は既存にリンク");
});

test("フリガナ推定: 単漢字姓へのprefix誤爆を起こさない(2文字以上のみ)", () => {
  const t = db.createTournament({ name: "prefix誤爆防止", date: "2028-01-03" });
  const entries = db.parseEntryListSheets([
    { name: "男子シングルス", rows: [["氏名", "チーム名"],
      ["西野 太郎", "A"], ["関口 花", "B"], ["堀江 剛", "C"], ["西村 一", "D"], ["原", "E"]] },
  ]).entries;
  db.importRoster(t.id, { mode: "direct", register_players: false, entries });
  const es = db.getEntrants(t.id, "男子シングルス");
  const f = (nm) => (es.find(x => x.name.includes(nm)) || {}).furigana || "";
  assert.strictEqual(f("西野"), "", "西野は単漢字'西'に誤マッチしない(空=後で修正/検出可)");
  assert.strictEqual(f("堀江"), "", "堀江も誤マッチしない(2字prefixが辞書に無い)");
  assert.strictEqual(f("関口"), "せきぐち", "辞書に追加した2字姓は正しく引ける(単漢字'関'への誤爆ではない)");
  assert.strictEqual(f("西村"), "にしむら", "辞書にある2字姓は引ける");
  assert.strictEqual(f("原"), "はら", "単漢字姓の完全一致は維持");
});

// ── 名簿取込の精度強化(列ズレ/タイトル行/合計行/区分マージ/区分拡充)の回帰 ──
const R = (...c) => c;

test("精度: 列がずれてもヘッダで氏名を正しく特定する", () => {
  const p = db.parseRosterRows({ singles: [
    R("行", "申込チーム", "No", "区分", "氏名", "チーム名", "支部", "備考"),
    R("1", "A校", "1", "一般男子", "青葉 光", "A校", "釧路市", ""),
  ] });
  assert.strictEqual(p.entries.length, 1);
  assert.strictEqual(p.entries[0].name, "青葉 光");
  assert.strictEqual(p.entries[0].team, "A校");
  assert.strictEqual(p.entries[0].region, "釧路");
});

test("精度: タイトル行が先頭にあってもヘッダ行を検出する", () => {
  const p = db.parseRosterRows({ singles: [
    R("第20回大会 申込集計", ""),
    R("申込チーム", "No", "区分", "氏名", "チーム名", "支部", "備考"),
    R("A校", "1", "一般男子", "青葉 光", "A校", "釧路市", ""),
  ] });
  assert.strictEqual(p.entries.length, 1, "ヘッダ行自体は取り込まない");
  assert.strictEqual(p.entries[0].name, "青葉 光");
});

test("精度: 合計/人数ラベル行は選手として取り込まない", () => {
  const p = db.parseRosterRows({ singles: [
    R("申込チーム", "No", "区分", "氏名", "チーム名", "支部", "備考"),
    R("A校", "1", "一般男子", "青葉 光", "A校", "釧路市", ""),
    R("", "", "", "合計", "", "", ""),
    R("", "", "", "2名", "", "", ""),
  ] });
  assert.deepStrictEqual(p.entries.map(e => e.name), ["青葉 光"]);
  assert.ok(p.stats.skipped >= 2, "合計・2名 はスキップ");
});

test("精度: 結合セルの区分は直前の行から前方補完する", () => {
  const p = db.parseRosterRows({ singles: [
    R("申込チーム", "No", "区分", "氏名", "チーム名", "支部", "備考"),
    R("A校", "1", "高校男子", "青葉 光", "A校", "釧路市", ""),
    R("A校", "2", "", "桜木 蓮", "A校", "釧路市", ""),
  ] });
  assert.strictEqual(p.entries[0].division, "高校生");
  assert.strictEqual(p.entries[1].division, "高校生", "空欄区分は上のセルを継承");
});

test("精度: 区分の拡充(マスターズ/大学/混合)", () => {
  const one = (k) => db.parseRosterRows({ singles: [R("区分", "氏名", "チーム名"), R(k, "試 太", "A")] }).entries[0];
  assert.strictEqual(one("マスターズ男子").age_label, "マスターズ");
  assert.strictEqual(one("大学女子").division, "大学生");
  assert.strictEqual(one("大学女子").gender, "female");
  assert.strictEqual(one("混合ダブルス").gender, "mixed");
});

test("精度: entrylist もタイトル行検出+合計行スキップ", () => {
  const p = db.parseEntryListSheets([{ name: "男子シングルス", rows: [
    R("釧路卓球選手権 出場者名簿"),
    R("氏名", "チーム名", "支部"),
    R("青葉 光", "A", "釧路"),
    R("合計", "", ""),
  ] }]);
  assert.deepStrictEqual(p.entries.map(e => e.name), ["青葉 光"]);
});

test("精度: 支部の団体接尾(振興局/連盟)を正規化", () => {
  const reg = (shibu) => db.parseRosterRows({ singles: [
    R("区分", "氏名", "チーム名", "支部"), R("一般男子", "試 太", "A", shibu),
  ] }).entries[0].region;
  assert.strictEqual(reg("釧路総合振興局"), "釧路");
  assert.strictEqual(reg("十勝支部"), "十勝");
  assert.strictEqual(reg("札幌卓球連盟"), "札幌");
});

test("精度: 変種見出し(選手氏名/氏名(かな))でも氏名列を正しく検出する", () => {
  const p = db.parseRosterRows({ singles: [
    R("No", "選手氏名", "所属", "支部"),
    R("1", "北野 一", "本ク", "釧路"),
    R("2", "南 二", "南ク", "札幌"),
  ] });
  assert.deepStrictEqual(p.entries.map(e => e.name), ["北野 一", "南 二"]);
  assert.strictEqual(p.entries[0].team, "本ク");
  assert.strictEqual(p.entries[0].region, "釧路");
  // 見出し「選手氏名」自体は取り込まない
  assert.ok(!p.entries.some(e => /氏名/.test(e.name)));
});

test("精度: 氏名(かな)とフリガナ列が同居しても氏名列を取り違えない", () => {
  const p = db.parseEntryListSheets([{ name: "男子シングルス", rows: [
    R("氏名", "ふりがな", "チーム名", "支部"),
    R("東 三", "あずま", "東ク", "釧路"),
  ] }]);
  assert.strictEqual(p.entries[0].name, "東 三", "氏名列(ふりがな列でなく)");
  assert.strictEqual(p.entries[0].team, "東ク");
});
