// 受付名簿の印刷組版(lib/reception-print.js)の回帰テスト。
//   ① 組合せの取込前は番号の欄が空欄(手書きの余白)。取込後は、種目ごとの枠番号が出る(試験DBで確認)
//   ② ダブルスのペアは同じ番号で、相手の氏名が出る。ペアの相手も自分の所属の表に載る
//   ③ 男子・女子・混合の見出し帯が、色に頼らず区別できる(黒ベタ/二重罫/斜線)
//   ④ 既定は「詰める」(改ページしない)。「チームごとに改ページ」にもできる。チームごとの表は割れないように指定される
//   ⑤ 種目が多くても列幅の調整で収まる。収まらないときだけ overflow を知らせる
// 実行: node --test test/reception-print.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
process.env.DB_PATH = path.join(process.env.TMPDIR || require("os").tmpdir(), "ktta_recp_" + process.pid + ".db");
process.env.ADMIN_KEY = "fixture-recp";
const db = require("../db");
const RP = require("../lib/reception-print");
after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const T = { name: "検証の大会", date: "2026-12-06", venue: "体育館" };
const nCells = (html) => (html.match(/<td class="n">(<small class="sd">[左右]<\/small>)?(<b>\d+<\/b>)?<\/td>/g) || []);
const filled = (html) => nCells(html).filter(c => c.includes("<b>"));
const nCellsAny = (html) => (html.match(/<td class="n">(<small class="sd">[左右]<\/small>)?(<b>\d+<\/b>)?<\/td>/g) || []);

test("① 組合せの取込前は番号が空欄、取込後は枠番号が出る(試験DB)", () => {
  const t = db.createTournament({ name: "検証", date: "2026-12-06", venue: "x" });
  const mk = (ev, name, team, extra) => db.createEntrant({ tournament_id: t.id, event: ev, name, furigana: "ふり がな", team, category: "middle", age_group: "中2", ...(extra || {}) });
  ["甲 一", "乙 二", "丙 三", "丁 四"].forEach((n, i) => mk("男子シングルス", n, i < 2 ? "A中学校" : "B中学校"));
  const before = RP.buildReceptionPrintHTML(T, db.getEntrants(t.id));
  assert.equal(filled(before.html).length, 0, "取込前は番号が空欄");
  assert.ok(nCells(before.html).length >= 4, "空欄の枠(手書きの余白)は確保されている");
  // 組合せ(結果入りのJSON)を取り込むと、出場者に枠番号が付く
  const m = (pos, a, ta, b, tb) => ({ bracket_round: 1, bracket_pos: pos, player1_name: a, player1_team: ta, player2_name: b, player2_team: tb });
  const r = db.importBracket(t.id, { format: "tabletennis-bracket-v1", event: "男子シングルス", auto_create_players: true, matches: [
    m(0, "甲 一", "A中学校", "乙 二", "A中学校"), m(1, "丙 三", "B中学校", "丁 四", "B中学校"), { bracket_round: 2, bracket_pos: 0 }] });
  assert.ok(!r.error, JSON.stringify(r));
  const ents = db.getEntrants(t.id);
  const nums = ents.map(e => e.bracket_number).sort((a, b) => a - b);
  assert.deepEqual(nums, [1, 1, 2, 2], "取込の枠番号は、左の山・右の山それぞれの1から");
  const after = RP.buildReceptionPrintHTML(T, ents);
  assert.equal(filled(after.html).length, 4, "取込後は番号が出る");
  ents.forEach(e => assert.ok(after.html.includes('<small class="sd">' + (e.bracket_side === "L" ? "左" : "右") + "</small><b>" + e.bracket_number + "</b>"), "左右で番号が重なるので「左」「右」つき"));
  // 通しの番号(左右で重ならない)の種目は、番号だけ
  const flat = RP.buildReceptionPrintHTML(T, [E({ event: "女子シングルス", name: "甲 一", bracket_number: 1, bracket_side: "L" }), E({ event: "女子シングルス", name: "乙 二", bracket_number: 2, bracket_side: "R" })]);
  assert.ok(!flat.html.includes('class="sd"') && flat.html.includes("<b>1</b>") && flat.html.includes("<b>2</b>"));
});

const E = (o) => ({ team: "見本中学校", furigana: "みほん たろう", category: "middle", age_group: "中2", bracket_number: 0, is_doubles: 0, partner_name: "", ...o });
test("② ダブルスのペアは同じ番号・相手の氏名つき。相手も自分の所属の表に載る", () => {
  const rows = [
    E({ event: "男子ダブルス", name: "見本 太郎", partner_name: "見本 次郎", partner_furigana: "みほん じろう", is_doubles: 1, bracket_number: 7 }),
    E({ event: "男子シングルス", name: "見本 太郎", bracket_number: 3 }),
    E({ event: "混合ダブルス", name: "見本 次郎", partner_name: "他校 花子", partner_team: "他校", partner_furigana: "たこう はなこ", is_doubles: 1, bracket_number: 5 }),
  ];
  const { html, meta } = RP.buildReceptionPrintHTML(T, rows);
  assert.equal(meta.teams, 2, "他校の花子さんは、他校の表に載る");
  assert.equal((html.match(/<b>7<\/b>/g) || []).length, 2, "ペアの2人とも同じ番号7");
  assert.ok(html.includes("◎</span> 見本 次郎") && html.includes("◎</span> 見本 太郎"), "互いが相手として出る");
  assert.ok(html.includes("<b>3</b>") && html.includes("<b>5</b>"));
  assert.equal(meta.persons, 3);
  assert.match(html, /確定出場 3件 \/ 2所属 \/ 選手 3名/, "確定出場の件数は、申込の件数(ダブルスは1組=1件)");
});

test("③ 男子=黒ベタ・女子=二重罫・混合=斜線の見出し帯(色に頼らない)", () => {
  const { html } = RP.buildReceptionPrintHTML(T, [
    E({ event: "男子シングルス", name: "甲 一" }), E({ event: "女子シングルス", name: "乙 二" }), E({ event: "混合ダブルス", name: "丙 三", partner_name: "丁 四", is_doubles: 1 })]);
  assert.match(html, /<th class="g male"[^>]*>男子<\/th>/); assert.match(html, /<th class="g female"[^>]*>女子<\/th>/); assert.match(html, /<th class="g mixed"[^>]*>混合<\/th>/);
  assert.match(html, /th\.g\.male\{background:#000;color:#fff\}/);
  assert.match(html, /th\.g\.female\{[^}]*double/);
  assert.match(html, /th\.g\.mixed\{background:repeating-linear-gradient/);
  assert.match(html, /@page\{size:A4 portrait/);
});

test("④ 既定は詰める。チームごとに改ページにもできる。小さなチームの表は割れない", () => {
  const rows = [E({ team: "A", event: "男子シングルス", name: "甲 一" }), E({ team: "B", event: "男子シングルス", name: "乙 二" })];
  const pack = RP.buildReceptionPrintHTML(T, rows).html, brk = RP.buildReceptionPrintHTML(T, rows, { pack: false }).html;
  assert.ok(!/<body class="brk"/.test(pack) && /<body class="brk"/.test(brk));
  assert.match(pack, /<table class="tt keep">/, "小さなチームの表は途中で割らない");
  assert.match(pack, /table\.tt thead\{display:table-header-group\}/, "割れるときは見出しを繰り返す");
  const many = Array.from({ length: 40 }, (_, i) => E({ team: "大", event: "男子シングルス", name: "大勢 " + i }));
  const big = RP.buildReceptionPrintHTML(T, many).html;
  assert.match(big, /<table class="tt">/, "1ページを超える大きさのチームは割ってよい(見出しを繰り返す)");
  assert.equal((pack.match(/class="blk"/g) || []).length, 2);
});

test("⑤ 種目が多くても列幅の調整で収まる。収まらないときだけ overflow", () => {
  const evs = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? "男子ダブルス" : "男子シングルス") + "区分" + i);
  const mk = (n) => evs(n).map((ev, i) => E({ event: ev, name: "甲 一", partner_name: /ダブルス/.test(ev) ? "乙 二" : "", is_doubles: /ダブルス/.test(ev) ? 1 : 0 }));
  assert.deepEqual(RP.buildReceptionPrintHTML(T, mk(5)).meta.overflowTeams, []);
  assert.deepEqual(RP.buildReceptionPrintHTML(T, mk(10)).meta.overflowTeams, [], "10種目も列幅の調整で収まる");
  assert.equal(RP.buildReceptionPrintHTML(T, mk(20)).meta.overflowTeams.length, 1, "20種目は収まらないので知らせる");
  const w = RP.widths(RP.eventColumns({ list: [{ cells: new Map(evs(10).map(e => [e, {}])) }] }));
  assert.ok(w.cols.every(c => c.num >= 6 && c.body >= 5));
});
