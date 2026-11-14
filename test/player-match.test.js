// 申込の選手照合(案A・2026-11-14)の回帰テスト。
//
// 守らせる不変条件:
//   ① 漢字(旧字・空白は畳む)とふりがなの両方が一致した1人だけ、自動で選手IDを付ける
//   ② 統合済みの書き間違い(別名)で申し込まれても同じ人に付く
//   ③ 漢字だけ・読みだけ・1字違い・登録側に読みが無い場合は自動で付けず「要確認」にする
//   ④ 該当なしで「初めて出場する」と答えた人は新規登録の候補になる
//   ⑤ 推定のふりがな(苗字辞書の補完)では一致と判定しない
//   ⑥ 人の判断(既存に付ける・新規登録・照合しない)は再照合で上書きされない
//   ⑦ 新規登録には6桁の選手番号が付く。別表記で付けた名前は別名として残り、次から自動一致する
// 実行: NODE_OPTIONS='--require ./test/_setup.js' node --test test/player-match.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_playermatch_" + process.pid + ".db");

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EVENTS = [
  { name: "一般男子シングルス", type: "singles", fee: 700 },
  { name: "男子ダブルス", type: "doubles", fee: 1000 },
];

// 架空の選手(実在の人物ではない)
const P = {};
function seed() {
  if (P.ready) return;
  P.a = db.createPlayer({ name: "架空 太郎", furigana: "かくう たろう", team: "試験クラブ" });
  P.b = db.createPlayer({ name: "髙試 一", furigana: "たかし はじめ", team: "試験クラブ" });
  P.d = db.createPlayer({ name: "別名 三郎", furigana: "べつめい さぶろう", team: "試験クラブ" });
  P.ready = true;
}
let n = 0;
function submit(entries) {
  seed();
  const t = db.createTournament({ name: "照合検証大会" + (++n), date: "2027-10-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: EVENTS });
  const r = db.createTeamEntry(t.id, {
    team_name: "試験クラブ", contact_name: "担当 一郎", contact_tel: "0154-00-0000", contact_email: "t@example.com",
    entries,
  }, "op-pm-" + n, {});
  assert.ok(!r.error, r.error);
  return { tid: t.id, ids: r.entrant_ids };
}
const matchOf = (id) => JSON.parse(db.getEntrant(id).player_match || "{}");

test("① 漢字+ふりがな一致は自動で選手IDが付く(空白・カタカナの違いは畳む)", () => {
  const { ids } = submit([{ event: "一般男子シングルス", type: "singles", name: "架空太郎", furigana: "カクウ タロウ", team: "試験クラブ" }]);
  const m = matchOf(ids[0]);
  assert.strictEqual(m.p1.status, "matched");
  assert.strictEqual(db.getEntrant(ids[0]).player_id, P.a.id);
});

test("① 旧字(髙)で申し込んでも新字の登録と一致する", () => {
  const { ids } = submit([{ event: "一般男子シングルス", type: "singles", name: "高試 一", furigana: "たかし はじめ", team: "試験クラブ" }]);
  assert.strictEqual(matchOf(ids[0]).p1.status, "matched");
  assert.strictEqual(db.getEntrant(ids[0]).player_id, P.b.id);
});

test("③ 読みが違えば自動で付けず要確認(候補に出す)", () => {
  const { ids } = submit([{ event: "一般男子シングルス", type: "singles", name: "架空 太郎", furigana: "かそら たろう", team: "試験クラブ" }]);
  const m = matchOf(ids[0]);
  assert.strictEqual(m.p1.status, "review");
  assert.ok(m.p1.candidates.some(c => c.player_id === P.a.id));
  assert.strictEqual(db.getEntrant(ids[0]).player_id, null);
});

test("③ 1字違いは要確認。⑤ ふりがな無しの申込は推定の読みで一致させない", () => {
  const { ids } = submit([
    { event: "一般男子シングルス", type: "singles", name: "架空 大郎", furigana: "かくう だいろう", team: "試験クラブ" },
    { event: "男子ダブルス", type: "doubles", name1: "架空 太郎", name2: "別名 三郎", furigana1: "", furigana2: "べつめい さぶろう", team1: "試験クラブ", team2: "試験クラブ" },
  ]);
  const s = matchOf(ids[0]);
  assert.strictEqual(s.p1.status, "review");
  assert.ok(s.p1.candidates.some(c => c.player_id === P.a.id && c.reason === "1字違い"));
  const d = matchOf(ids[1]);
  assert.strictEqual(d.p1.status, "review", "ふりがな無しは要確認");
  assert.strictEqual(d.p2.status, "matched");
  const e = db.getEntrant(ids[1]);
  assert.strictEqual(e.player_id, null);
  assert.strictEqual(e.partner_player_id, P.d.id);
});

test("④ 該当なし+初めて出場=新規候補 / 出場歴ありと回答=要確認", () => {
  const { tid, ids } = submit([
    { event: "一般男子シングルス", type: "singles", name: "新人 花男", furigana: "しんじん はなお", team: "試験クラブ", extra_json: { first_time: "yes" } },
    { event: "男子ダブルス", type: "doubles", name1: "未登 一", name2: "未登 二", furigana1: "みと はじめ", furigana2: "みと じろう", team1: "試験クラブ", team2: "試験クラブ",
      extra_json: { players: [{ first_time: "no" }, { first_time: "yes" }] } },
  ]);
  assert.strictEqual(matchOf(ids[0]).p1.status, "new");
  const d = matchOf(ids[1]);
  assert.strictEqual(d.p1.status, "review");
  assert.match(d.p1.reason, /出場歴あり/);
  assert.strictEqual(d.p2.status, "new");
  const rv = db.getPlayerMatchReview(tid);
  assert.strictEqual(rv.summary.new, 2);
  assert.strictEqual(rv.summary.review, 1);
});

test("⑦ 新規登録で6桁番号が付き、⑥ 再照合しても人の判断は変わらない", () => {
  const { tid, ids } = submit([{ event: "一般男子シングルス", type: "singles", name: "新規 登録", furigana: "しんき とうろく", team: "試験クラブ", region: "釧路", extra_json: { first_time: "yes" } }]);
  const r = db.resolveEntrantPlayerMatch(ids[0], "p1", "create", { by: "本部" });
  assert.ok(r.ok, r.error);
  assert.match(r.player.player_no, /^\d{6}$/);
  assert.strictEqual(r.player.furigana, "しんき とうろく");
  assert.strictEqual(r.player.branch, "釧路");
  db.rematchTournamentPlayers(tid);
  const m = matchOf(ids[0]);
  assert.strictEqual(m.p1.status, "created");
  assert.strictEqual(db.getEntrant(ids[0]).player_id, r.player.id);
});

test("⑦ 別表記を既存選手に付けると別名が残り、次の申込で自動一致する", () => {
  const first = submit([{ event: "一般男子シングルス", type: "singles", name: "別明 三郎", furigana: "べつめい さぶろう", team: "試験クラブ" }]);
  assert.strictEqual(matchOf(first.ids[0]).p1.status, "review");
  const r = db.resolveEntrantPlayerMatch(first.ids[0], "p1", "link", { player_id: P.d.id });
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(JSON.parse(db.getPlayer(P.d.id).name_aliases), ["別明 三郎"]);
  const second = submit([{ event: "一般男子シングルス", type: "singles", name: "別明 三郎", furigana: "べつめい さぶろう", team: "試験クラブ" }]);
  assert.strictEqual(matchOf(second.ids[0]).p1.status, "matched");
  assert.strictEqual(db.getEntrant(second.ids[0]).player_id, P.d.id);
});

test("照合しない・やり直し・不正な指定", () => {
  const { ids } = submit([{ event: "一般男子シングルス", type: "singles", name: "架空 太郎", furigana: "", team: "試験クラブ" }]);
  assert.ok(db.resolveEntrantPlayerMatch(ids[0], "p1", "dismiss").ok);
  assert.strictEqual(matchOf(ids[0]).p1.status, "dismissed");
  assert.ok(db.resolveEntrantPlayerMatch(ids[0], "p1", "reopen").ok);
  assert.strictEqual(matchOf(ids[0]).p1.status, "review");
  assert.ok(db.resolveEntrantPlayerMatch(ids[0], "p2", "dismiss").error, "シングルスに p2 は無い");
  assert.strictEqual(db.resolveEntrantPlayerMatch(ids[0], "p1", "link", { player_id: "nope" }).status, 404);
  assert.ok(db.resolveEntrantPlayerMatch(ids[0], "p1", "zzz").error);
});

test("団体戦は照合の対象外(申込は通常どおり保存される)", () => {
  seed();
  const t = db.createTournament({ name: "団体照合なし", date: "2027-10-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: "団体戦", type: "team", fee: 0, per_team: 6, per_team_min: 3 }] });
  const r = db.createTeamEntry(t.id, { team_name: "試験A", contact_name: "担当", contact_tel: "0154-00-0000",
    entries: [{ event: "団体戦", type: "team", team_name: "試験A", members: ["架空 太郎", "乙 二", "丙 三"] }] }, "op-team-pm", {});
  assert.ok(!r.error, r.error);
  assert.strictEqual(db.getEntrant(r.entrant_ids[0]).player_match, "");
});

test("選手登録用の項目: 必須チェック・支部の保存・集計シートの列", () => {
  seed();
  const t = db.createTournament({ name: "登録項目検証", date: "2027-10-01" });
  const F = { team_name: "required", name_split: "required", furigana: "required", player_team: "required",
    grade: "required", player_gender: "required", player_region: "required", first_time: "required" };
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: EVENTS, field_config: { version: 2, fields: F } });
  const base = { team_name: "試験クラブ", contact_name: "担当 一郎", contact_tel: "0154-00-0000", contact_email: "t@example.com" };
  const ok = { event: "一般男子シングルス", type: "singles", name: "登録 太郎", furigana: "とうろく たろう", team: "試験クラブ",
    extra_json: { grade: "一般", player_region: "釧路", first_time: "初めて" } };
  const send = (e, op) => db.createTeamEntry(t.id, { ...base, entries: [e] }, op, { enforce: true });
  assert.match(send({ ...ok, name: "登録太郎" }, "op-f1").error, /姓と名/);
  assert.match(send({ ...ok, furigana: "とうろくたろう" }, "op-f2").error, /せい/);
  assert.match(send({ ...ok, extra_json: { grade: "一般", first_time: "初めて" } }, "op-f3").error, /支部/);
  assert.match(send({ ...ok, extra_json: { grade: "一般", player_region: "釧路" } }, "op-f4").error, /初めて出場/);
  const r = send({ ...ok, region: "釧路" }, "op-f5");
  assert.ok(!r.error, r.error);
  const e = db.getEntrant(r.entrant_ids[0]);
  assert.strictEqual(e.region, "釧路");
  assert.strictEqual(JSON.parse(e.player_match).p1.status, "new");
  const cols = db.buildFormSchema(db.getTournament(t.id)).columns.player.map(c => c.key);
  assert.ok(cols.includes("player_region") && cols.includes("first_time"));
});

test("選手の統合で消える側の氏名が別名に残り、自動照合で一致する。取り消すと戻る", () => {
  seed();
  const keep = db.createPlayer({ name: "統合 残夫", furigana: "とうごう のこお", team: "試験クラブ" });
  const dup = db.createPlayer({ name: "統合 遺夫", furigana: "とうごう のこお", team: "試験クラブ" });
  const m = db.mergePlayers(keep.id, dup.id, { operator: "試験" });
  assert.ok(m.ok || m.merge_id, m.error);
  assert.deepStrictEqual(JSON.parse(db.getPlayer(keep.id).name_aliases), ["統合 遺夫"]);
  const { ids } = submit([{ event: "一般男子シングルス", type: "singles", name: "統合 遺夫", furigana: "とうごう のこお", team: "試験クラブ" }]);
  assert.strictEqual(db.getEntrant(ids[0]).player_id, keep.id);
  const u = db.unmergePlayers(m.merge_id, { operator: "試験" });
  assert.ok(u.ok, u.error);
  assert.strictEqual(db.getPlayer(keep.id).name_aliases, "");
});

// ── 選手登録台帳と既存DBの統合(2026-11-15) ──
// 台帳を優先し、旧表記は別名・旧所属は履歴に残す。読み違いは保留。削除しない。
test("台帳統合: 漢字一致は更新、重複は統合、読み違いは保留、本番のみは番号だけ振る", () => {
  const mk = (name, furigana, team) => {
    return db.createPlayer({ name, furigana, team, _allowAnyName: true });
  };
  const sq = new (require("better-sqlite3"))(process.env.DB_PATH);
  const A = mk("統合 一郎", "", "旧架空中学");
  const B1 = mk("統合 二郎", "", "架空クラブ");
  const B2 = mk("統合　二郎", "", "架空クラブB");
  const C = mk("統合 三郎", "とうごう さぶろ", "架空クラブ");
  const D = mk("統合 四郎", "", "架空クラブ");
  [A, B1, B2, D].forEach(p => sq.prepare("UPDATE players SET furigana='' WHERE id=?").run(p.id));
  sq.close();
  const reg = { players: {
    "900001": { name: "統合 一郎", keys: [], furigana: "とうごう いちろう", main_team: "架空高校", gender: "男子", category: "高校生" },
    "900002": { name: "統合 二郎", keys: [], furigana: "", main_team: "架空クラブ", gender: "男子", category: "一般" },
    "900003": { name: "統合 三郎", keys: [], furigana: "とうごう さぶろう", main_team: "架空クラブ", gender: "男子", category: "一般" },
    "900005": { name: "統合 五郎", keys: [], furigana: "とうごう ごろう", main_team: "架空クラブ", gender: "女子", category: "" },
  } };
  const dry = db.syncPlayerRegistry(reg);
  assert.strictEqual(dry.applied, false);
  assert.strictEqual(db.getPlayer(A.id).team, "旧架空中学", "dry run は書き込まない");
  const hold = dry.plan.hold.find(h => h.no === "900003");
  assert.ok(hold && hold.candidates[0].id === C.id, "読み違いは保留");
  assert.ok(dry.plan.merge.some(m => m.no === "900002" && m.dups.length === 1), "同じ漢字の重複は統合");

  db.syncPlayerRegistry(reg, { apply: true });
  const a = db.getPlayer(A.id);
  assert.strictEqual(a.team, "架空高校", "台帳の所属へ更新");
  assert.strictEqual(a.furigana, "とうごう いちろう");
  assert.strictEqual(a.category, "high");
  const hist = db.listAffiliations(A.id).map(x => x.team + "|" + (x.end_date ? "end" : "now"));
  assert.ok(hist.includes("旧架空中学|end") && hist.includes("架空高校|now"), "旧所属は履歴に残る: " + hist);
  // 同じ秒に登録された2人なので、どちらか一方へリダイレクトされていればよい(削除しない)
  assert.strictEqual(db.getPlayer(B1.id).id, db.getPlayer(B2.id).id, "重複は1人に統合され、旧IDも引ける");
  assert.strictEqual(db.getPlayer(C.id).furigana, "とうごう さぶろ", "保留は触らない");
  const nos = [db.getPlayer(A.id), db.getPlayer(B2.id), db.getPlayer(D.id)].map(p => p.player_no);
  assert.deepStrictEqual(nos.slice(0, 2), ["900001", "900002"]);
  assert.match(nos[2], /^\d{6}$/, "本番にしかいない選手にも番号");
  const again = db.syncPlayerRegistry(reg);
  assert.strictEqual(again.created + again.merge_groups, 0, "2回目は新規も統合も出ない");
});
