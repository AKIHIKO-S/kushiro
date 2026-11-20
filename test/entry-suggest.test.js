// 申込フォームの入力補助(チーム名・選手名の候補)の回帰テスト。
//
// 守らせる不変条件:
//   ① チーム名の候補は、登録チームと選手DBの所属から前方一致→部分一致の順で返る
//   ② 選手名の候補は氏名・ふりがな・所属だけ(学年・生年月日などを返さない)。2文字未満は返さない。最大5件
//   ③ 所属は並べ替えのヒントにだけ使い、絞り込まない(別のチームで出場する人も候補に出る)
//   ④ 統合済みの選手は出ない。同じ氏名・ふりがな・所属は1件にまとめる(所属が違う同姓同名は別々に出る)
//   ⑤ チケットは大会ごと・期限つき・回数つき。改ざん・別の大会・使い切りは通らない
//   ⑥ 大会のスイッチは標準OFFで、保存できる
//   ⑦ 申込フォームのHTMLが、候補の部品を含み、全スクリプトが構文として読める
// 実行: node --test test/entry-suggest.test.js
process.env.DB_PATH = "/tmp/ktta_suggest_" + process.pid + ".db";
process.env.ADMIN_KEY = "suggest-test-fixture";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { Script } = require("node:vm");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} }
});

function seed() {
  db.createPlayer({ name: "釧路 太郎", furigana: "くしろ たろう", team: "釧路中学校" });
  db.createPlayer({ name: "釧路 次郎", furigana: "くしろ じろう", team: "釧路高校" });
  db.createPlayer({ name: "釧路 花子", furigana: "くしろ はなこ", team: "根室中学校" });
  db.createPlayer({ name: "鶴居 一", furigana: "つるい はじめ", team: "鶴居クラブ" });
  db.createPlayer({ name: "同名 太郎", furigana: "どうめい たろう", team: "A卓球クラブ" });
  db.createPlayer({ name: "同名 太郎", furigana: "どうめい たろう", team: "B卓球クラブ" });
}

test("① チーム名の候補: 前方一致が先、部分一致が後。空入力は返さない", () => {
  seed();
  assert.deepStrictEqual(db.suggestTeams(""), []);
  const r = db.suggestTeams("釧路");
  assert.ok(r.includes("釧路中学校") && r.includes("釧路高校"), JSON.stringify(r));
  assert.ok(!r.includes("鶴居クラブ"));
  const inc = db.suggestTeams("居ク");
  assert.ok(inc.includes("鶴居クラブ"), "部分一致も出る: " + JSON.stringify(inc));
});

test("② 選手名の候補は氏名・ふりがな・所属だけ。2文字未満は返さない", () => {
  _flush();
  assert.deepStrictEqual(db.suggestPlayers("釧", ""), [], "1文字は返さない");
  const r = db.suggestPlayers("釧路", "");
  assert.ok(r.length >= 3, JSON.stringify(r));
  r.forEach(x => assert.deepStrictEqual(Object.keys(x).sort(), ["furigana", "name", "team"], "氏名・ふりがな・所属以外は返さない"));
  const byKana = db.suggestPlayers("くしろ", "");
  assert.ok(byKana.some(x => x.name === "釧路 太郎"), "ふりがなでも探せる");
  const kata = db.suggestPlayers("クシロ", "");
  assert.ok(kata.some(x => x.name === "釧路 太郎"), "カタカナ入力でも探せる");
  assert.ok(db.suggestPlayers("釧路", "").length <= 5, "最大5件");
});

test("③ 所属は並べ替えのヒントだけ。絞り込まない", () => {
  _flush();
  const r = db.suggestPlayers("釧路", "根室中学校");
  assert.strictEqual(r[0].name, "釧路 花子", "所属が合う人が先頭");
  assert.ok(r.some(x => x.name === "釧路 太郎") && r.some(x => x.name === "釧路 次郎"), "別のチームの人も出る");
});

test("④ 統合済みは出ない。同じ氏名・ふりがな・所属は1件にまとめ、所属が違う同姓同名は別々に出る", () => {
  _flush();
  const same = db.suggestPlayers("同名", "");
  assert.deepStrictEqual(same.map(x => x.team).sort(), ["A卓球クラブ", "B卓球クラブ"], "所属が違えば2件: " + JSON.stringify(same));
  db.createPlayer({ name: "同名 太郎", furigana: "どうめい たろう", team: "A卓球クラブ" });
  _flush();
  assert.strictEqual(db.suggestPlayers("同名", "").length, 2, "同じ所属の重複は1件にまとめる");
  const p = db.createPlayer({ name: "統合 済", furigana: "とうごう すみ", team: "X" });
  db.mergePlayers ? null : null;
  require("better-sqlite3")(process.env.DB_PATH).prepare("UPDATE players SET merged_into=? WHERE id=?").run("someone", p.id);
  _flush();
  assert.deepStrictEqual(db.suggestPlayers("統合", ""), [], "統合済みは候補に出ない");
});

test("⑤ チケット: 大会ごと・期限つき・回数つき。改ざんは通らない", () => {
  const { makeSuggestTicket, useSuggestTicket } = require("../server").__test__;
  const t = makeSuggestTicket("t-1");
  assert.strictEqual(useSuggestTicket(t, "t-1"), true);
  assert.strictEqual(useSuggestTicket(t, "t-2"), false, "別の大会では使えない");
  assert.strictEqual(useSuggestTicket("x" + t, "t-1"), false, "改ざんは通らない");
  assert.strictEqual(useSuggestTicket("", "t-1"), false);
  const u = makeSuggestTicket("t-3");
  for (let i = 0; i < 200; i++) assert.strictEqual(useSuggestTicket(u, "t-3"), true);
  assert.strictEqual(useSuggestTicket(u, "t-3"), false, "200回で使い切り");
  const realNow = Date.now;
  try {
    const v = makeSuggestTicket("t-4");
    Date.now = () => realNow() + 31 * 60 * 1000;
    assert.strictEqual(useSuggestTicket(v, "t-4"), false, "30分たつと使えない");
  } finally { Date.now = realNow; }
});

test("⑥ 大会のスイッチは標準OFFで、保存できる。未指定の保存では変わらない", () => {
  const t = db.createTournament({ name: "候補スイッチ", date: "2099-01-01" });
  assert.ok(!db.getTournament(t.id).entry_suggest_players, "標準はOFF");
  db.updateEntrySettings(t.id, { entries_open: 1, entry_suggest_players: true });
  assert.strictEqual(db.getTournament(t.id).entry_suggest_players, 1);
  db.updateEntrySettings(t.id, { entries_open: 1 });
  assert.strictEqual(db.getTournament(t.id).entry_suggest_players, 1, "未指定なら変えない");
  db.updateEntrySettings(t.id, { entries_open: 1, entry_suggest_players: false });
  assert.strictEqual(db.getTournament(t.id).entry_suggest_players, 0);
});

test("⑦ 申込フォームに候補の部品が入り、全スクリプトが構文として読める", () => {
  const entryForm = require("../entry_form");
  const t = db.createTournament({ name: "候補フォーム", date: "2099-01-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [
    { name: "男子シングルス", type: "singles", fee: 500 }, { name: "男子ダブルス", type: "doubles", fee: 800 },
    { name: "男子団体", type: "team", per_team: 4, per_team_min: 3, fee: 2000 }] });
  const html = entryForm.buildEntryFormHTML(db.getTournament(t.id), JSON.parse(db.getTournament(t.id).event_config),
    { submit_url: "https://example.invalid/api/public/tournaments/" + t.id + "/submit-team-entry" });
  assert.match(html, /suggest-ticket/);
  assert.match(html, /X-Suggest-Ticket/);
  assert.match(html, /\.tt-suggest__item/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 2);
  for (const [, src] of scripts) assert.doesNotThrow(() => new Script(src));
});

// 候補の元データは60秒キャッシュなので、テストでは入れ替えのたびに読み直させる
function _flush() { db.__resetSuggestCache && db.__resetSuggestCache(); }

test("⑧ 候補の部品の動き: 入力欄の種類の判定と、選んだときの氏名・ふりがなの入り方", () => {
  const vm = require("node:vm");
  const entryForm = require("../entry_form");
  const t = db.createTournament({ name: "候補の動き", date: "2099-01-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: "男子シングルス", type: "singles", fee: 500 }] });
  const html = entryForm.buildEntryFormHTML(db.getTournament(t.id), JSON.parse(db.getTournament(t.id).event_config),
    { submit_url: "https://example.invalid/api/public/tournaments/" + t.id + "/submit-team-entry" });
  const code = html.split("// ══ 入力補助: チーム名・選手名の候補(任意) ══")[1].split("// 初期化 (失敗しても安全網が案内を表示)")[0];

  // 最小限の偽DOM(要素・行・文書)
  class El {
    constructor(name, o = {}) { this.name = name; this.type = "text"; this.tagName = "INPUT"; this.value = ""; this.o = o; this.fired = 0; }
    getAttribute(k) { return this.o[k] == null ? null : this.o[k]; }
    setAttribute(k, v) { this.o[k] = v; }
    closest() { return this.row || null; }
    dispatchEvent() { this.fired++; }
  }
  const all = [];
  const mk = (name, o) => { const e = new El(name, o); all.push(e); return e; };
  const lookup = (sel) => {
    let m = /^input\[name="(.+)"\]$/.exec(sel); if (m) return all.filter(e => e.name === m[1] && e.tagName === "INPUT");
    m = /^\[data-join="(.+)"\]$/.exec(sel); if (m) return all.filter(e => e.o["data-join"] === m[1]);
    return [];
  };
  const doc = { querySelector: (s) => lookup(s)[0] || null, querySelectorAll: (s) => lookup(s), getElementById: () => ({ addEventListener() {} }),
    body: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, getBoundingClientRect: () => ({}) }), activeElement: null };
  const sandbox = { document: doc, window: { addEventListener() {}, scrollX: 0, scrollY: 0 }, fetch: () => Promise.resolve({ ok: false, status: 500 }),
    SUBMIT_URL: "https://example.invalid/api/public/tournaments/T/submit-team-entry", Event: function () {}, setTimeout, clearTimeout,
    ttJoin: (el) => { const target = el.getAttribute("data-join"); const hid = all.find(e => e.name === target);
      if (hid) hid.value = all.filter(e => e.o["data-join"] === target).map(e => e.value).filter(Boolean).join(" "); } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // 種類の判定
  const kind = (name, o) => sandbox.ttSugKind(mk(name, o));
  assert.strictEqual(kind("team_name"), "team");
  assert.strictEqual(kind("ev0_p0_team"), "team");
  assert.strictEqual(kind("ev1_pair2_t1"), "team");
  assert.strictEqual(kind("ev2_team0_name"), "team");
  assert.strictEqual(kind("ev0_p0_name"), "player");
  assert.strictEqual(kind("ev1_pair0_n2"), "player");
  assert.strictEqual(kind("ev2_team0_m3"), "player");
  assert.strictEqual(kind("ev0_p0_nsei", { "data-join": "ev0_p0_name" }), "player", "姓名を分けた欄の姓");
  assert.strictEqual(kind("ev0_p0_fsei", { "data-join": "ev0_p0_furi" }), "", "ふりがなの欄は対象外");
  assert.strictEqual(kind("ev0_p0_furi"), "");
  assert.strictEqual(kind("contact_email"), "");

  all.length = 0;   // 種類の判定で作った要素を片付けてから、実際の1行を作る
  // 姓名を分けた氏名: 選ぶと姓・名とふりがな(せい・めい)が入る
  const row = { querySelector: (s) => lookup(s)[0] || null, querySelectorAll: (s) => lookup(s) };
  const hidName = mk("ev0_p0_name"); hidName.type = "hidden";
  const sei = mk("ev0_p0_nsei", { "data-join": "ev0_p0_name" }), mei = mk("ev0_p0_nmei", { "data-join": "ev0_p0_name" });
  const hidFuri = mk("ev0_p0_furi"); hidFuri.type = "hidden";
  const fsei = mk("ev0_p0_fsei", { "data-join": "ev0_p0_furi" }), fmei = mk("ev0_p0_fmei", { "data-join": "ev0_p0_furi" });
  [hidName, sei, mei, hidFuri, fsei, fmei].forEach(e => { e.row = row; });
  sandbox.TT_SUG.cur = { inp: sei, kind: "player" };
  sandbox.TT_SUG.items = [{ name: "釧路 太郎", furigana: "くしろ たろう" }];
  sandbox.ttSugPick(0);
  assert.deepStrictEqual([sei.value, mei.value, fsei.value, fmei.value], ["釧路", "太郎", "くしろ", "たろう"]);
  assert.strictEqual(hidName.value, "釧路 太郎");
  assert.strictEqual(hidFuri.value, "くしろ たろう");

  // 分けない氏名・ダブルスの選手2: 氏名とふりがなが入る。所属は触らない
  const name1 = mk("ev1_pair0_n2"), furi1 = mk("ev1_pair0_2_furi"), team1 = mk("ev1_pair0_t2");
  [name1, furi1, team1].forEach(e => { e.row = row; });
  team1.value = "自分で書いた所属";
  sandbox.TT_SUG.cur = { inp: name1, kind: "player" };
  sandbox.TT_SUG.items = [{ name: "釧路 次郎", furigana: "くしろ じろう", team: "釧路高校" }];
  sandbox.ttSugPick(0);
  assert.strictEqual(name1.value, "釧路 次郎");
  assert.strictEqual(furi1.value, "くしろ じろう");
  assert.strictEqual(team1.value, "自分で書いた所属", "自分で書いた所属は上書きしない");
  // 所属が空欄なら入る。候補から入れた所属は、別の候補を選ぶと入れ替わる。書き換えた所属は、そのまま残る
  team1.value = "";
  sandbox.TT_SUG.items = [{ name: "釧路 次郎", furigana: "くしろ じろう", team: "釧路高校" }];   // 選ぶと候補は閉じて空になるので、毎回入れ直す
  sandbox.TT_SUG.cur = { inp: name1, kind: "player" };
  sandbox.ttSugPick(0);
  assert.strictEqual(team1.value, "釧路高校", "空欄の所属には入る");
  sandbox.TT_SUG.items = [{ name: "根室 三郎", furigana: "ねむろ さぶろう", team: "根室中学校" }];
  sandbox.TT_SUG.cur = { inp: name1, kind: "player" };
  sandbox.ttSugPick(0);
  assert.strictEqual(team1.value, "根室中学校", "候補から入れた所属は、別の候補で入れ替わる");
  team1.value = "根室中学校(A)";
  sandbox.TT_SUG.items = [{ name: "釧路 太郎", furigana: "くしろ たろう", team: "釧路中学校" }];
  sandbox.TT_SUG.cur = { inp: name1, kind: "player" };
  sandbox.ttSugPick(0);
  assert.strictEqual(team1.value, "根室中学校(A)", "自分で直した所属は残る");

  // チーム名: 選ぶとその欄に入る
  const tm = mk("team_name");
  sandbox.TT_SUG.cur = { inp: tm, kind: "team" };
  sandbox.TT_SUG.items = ["釧路中学校"];
  sandbox.ttSugPick(0);
  assert.strictEqual(tm.value, "釧路中学校");
});
