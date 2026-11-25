// 大会ごとの申込バックアップ/復元の回帰テスト。
//   ① バックアップ → その大会の申込を空にする → 復元 で、元の内容と一致する(申込・出場者・番号・履歴・削除控え)
//   ② 同じファイルを2回読んでも二重にならない(冪等)。申込IDが違っても同じ op_id なら同じ申込として飛ばす
//   ③ 既存の申込は上書きしない。内容が違うものは一覧に出て、既定は飛ばす
//   ④ 別の大会のファイルは既定で止まる。確認すれば、読み込み先の大会として入る
//   ⑤ 壊れたファイル・書き換えられたファイル・形式違いは断る。失敗したら何も入らない
//   ⑥ 選手DBや他の大会は含まれない。大会の申込設定は、選んだときだけ戻す
// 実行: node --test test/entry-backup-restore.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
process.env.DB_PATH = path.join(process.env.TMPDIR || require("os").tmpdir(), "ktta_ebk_" + process.pid + ".db");
const db = require("../db");
const Raw = require("better-sqlite3");
after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });
const raw = () => new Raw(process.env.DB_PATH);

const EVENTS = [{ name: "一般男子シングルス", type: "singles", fee: 700 }, { name: "一般男子ダブルス", type: "doubles", fee: 1200 }];
let T, T2, S = {};
const apply = (t, team, names) => {
  const r = db.createTeamEntry(t.id, { team_name: team, contact_name: "連絡 担当", contact_tel: "0154-00-0000", contact_email: "bk@example.com",
    entries: names.map((n, i) => ({ event: EVENTS[0].name, type: "singles", name: n, furigana: "かくう " + i, team })) }, "op-bk-" + team + "-" + names.length, { enforce: true });
  assert.ok(!r.error, r.error); return r.submission_id;
};
const rehash = (d) => { d.checksum = require("crypto").createHash("sha256").update(JSON.stringify({ tournament: d.tournament, tables: d.tables })).digest("hex"); return d; };
// 別の大会へ読み込むための写し(申込IDなどを付け替える)
const remap = (src, tag) => {
  const d = JSON.parse(JSON.stringify(src)), m = {};
  d.tables.entry_submissions.forEach((s, i) => { m[s.id] = tag + "-s" + i; s.id = m[s.id]; s.op_id = tag + "-op" + i; s.token_hash = ""; });
  d.tables.entrants.forEach(e => { e.submission_id = m[e.submission_id] || e.submission_id; e.id = tag + "-e-" + e.id; });
  d.tables.submission_tokens = []; d.tables.entry_changes = []; d.tables.deleted_submissions = [];
  return rehash(d);
};
const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); delete c.exported_at; delete c.checksum; return c; };

test("下ごしらえ: 2つの申込・取消・削除済みの申込・別の大会", () => {
  T = db.createTournament({ name: "バックアップ検証大会", date: "2099-12-06", venue: "体育館" });
  db.updateEntrySettings(T.id, { entries_open: 1, entry_deadline: "", event_config: EVENTS });
  S.a = apply(T, "架空クラブ", ["架空 太郎", "架空 次郎"]);
  S.b = apply(T, "見本中学校", ["見本 花子"]);
  S.c = apply(T, "削除予定団", ["仮名 三郎"]);
  const row = db.getEntryDesk(T.id).rows.find(x => x.submission_id === S.a);
  db.updateEntrant(row.players[0].entrant_id, { status: "cancelled" });   // 変更履歴にも載る取消
  const cc = db.getEntryDesk(T.id).rows.find(x => x.submission_id === S.c);
  cc.players.forEach(p => db.updateEntrant(p.entrant_id, { status: "cancelled" }));
  assert.ok(db.deleteSubmission(S.c, { reason: "検証", operator: "OP1" }).ok);
  T2 = db.createTournament({ name: "別の大会", date: "2099-12-07" });
  db.updateEntrySettings(T2.id, { entries_open: 1, entry_deadline: "", event_config: EVENTS });
  S.other = apply(T2, "他大会の団体", ["他大 一郎"]);
});

let BK;
test("① バックアップの中身: 申込原本・出場者・番号の対応・履歴・削除済みの控え・申込設定。他の大会や選手DBは含まない", () => {
  BK = db.exportEntryBackup(T.id);
  assert.equal(BK.format, "ktta-entry-backup-v1");
  assert.equal(BK.tournament.id, T.id);
  assert.equal(BK.counts.entry_submissions, 2); assert.equal(BK.counts.entrants, 3); assert.ok(BK.counts.submission_tokens >= 2);
  assert.ok(BK.counts.entry_changes >= 1); assert.equal(BK.counts.deleted_submissions, 1);
  assert.ok(BK.tournament.settings.event_config.includes("一般男子シングルス"));
  const js = JSON.stringify(BK);
  assert.ok(!js.includes("他大 一郎") && !js.includes("他大会の団体"), "他の大会は含まない");
  assert.ok(!("players" in BK.tables) && !("matches" in BK.tables), "選手DB・試合は含まない");
  BK.tables.entry_submissions.forEach(s => assert.ok(!("token" in s) && (s.token_hash === "" || /^[0-9a-f]{32,}$/.test(s.token_hash)), "申込番号の平文は無く、ハッシュのまま"));
  assert.ok(BK.note.includes("個人情報"));
});

test("① 申込を空にして復元すると、元と一致する", () => {
  const db2 = raw();
  db2.prepare("DELETE FROM entry_changes WHERE tournament_id=?").run(T.id);
  db2.prepare("DELETE FROM deleted_submissions WHERE tournament_id=?").run(T.id);
  db2.prepare("DELETE FROM submission_tokens WHERE submission_id IN (SELECT id FROM entry_submissions WHERE tournament_id=?)").run(T.id);
  db2.prepare("DELETE FROM entrants WHERE tournament_id=?").run(T.id);
  db2.prepare("DELETE FROM entry_submissions WHERE tournament_id=?").run(T.id);
  db2.close();
  assert.equal(db.exportEntryBackup(T.id).counts.entry_submissions, 0);
  const pv = db.previewEntryRestore(T.id, JSON.parse(JSON.stringify(BK)));
  assert.ok(pv.ok); assert.equal(pv.counts.entry_submissions.new, 2); assert.equal(pv.counts.entrants.new, 3); assert.equal(pv.other_tournament, false);
  assert.equal(db.exportEntryBackup(T.id).counts.entry_submissions, 0, "プレビューでは何も入らない");
  const r = db.applyEntryRestore(T.id, JSON.parse(JSON.stringify(BK)));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(strip(db.exportEntryBackup(T.id)), strip(BK), "復元後の内容が、元のバックアップと完全に一致する");
  assert.equal(db.getEntryDesk(T.id).rows.length, 2, "台帳にも出る");
});

test("② 同じファイルを2回読んでも二重にならない", () => {
  const before = JSON.stringify(strip(db.exportEntryBackup(T.id)));
  const pv = db.previewEntryRestore(T.id, JSON.parse(JSON.stringify(BK)));
  assert.equal(pv.counts.entry_submissions.new, 0); assert.equal(pv.counts.entry_submissions.same, 2); assert.equal(pv.counts.entrants.new, 0);
  const r = db.applyEntryRestore(T.id, JSON.parse(JSON.stringify(BK)));
  assert.ok(r.ok); assert.equal(r.inserted, 0);
  assert.equal(JSON.stringify(strip(db.exportEntryBackup(T.id))), before);
  // 申込IDが違っても、同じ申込ID(op_id)なら同じ申込として飛ばす
  const d = JSON.parse(JSON.stringify(BK));
  d.tables.entry_submissions[0].id = "other-id-0001"; d.tables.entrants.forEach(e => { if (e.submission_id === BK.tables.entry_submissions[0].id) e.submission_id = "other-id-0001"; });
  d.checksum = require("crypto").createHash("sha256").update(JSON.stringify({ tournament: d.tournament, tables: d.tables })).digest("hex");
  const pv2 = db.previewEntryRestore(T.id, d);
  assert.equal(pv2.counts.entry_submissions.new, 0, "op_id が同じ申込は新規にしない");
  assert.equal(db.exportEntryBackup(T.id).counts.entry_submissions, 2);
});

test("③ 既存の申込は上書きしない。違いは一覧に出る", () => {
  const db2 = raw(); db2.prepare("UPDATE entry_submissions SET team_name='名前を変えた団体' WHERE id=?").run(S.b); db2.close();
  const pv = db.previewEntryRestore(T.id, JSON.parse(JSON.stringify(BK)));
  assert.equal(pv.counts.entry_submissions.differs, 1);
  const d = pv.differs.find(x => x.id === S.b);
  assert.ok(d && d.fields.includes("team_name"));
  const r = db.applyEntryRestore(T.id, JSON.parse(JSON.stringify(BK)));
  assert.ok(r.ok && r.inserted === 0);
  assert.equal(db.exportEntryBackup(T.id).tables.entry_submissions.find(x => x.id === S.b).team_name, "名前を変えた団体", "上書きされない");
  const db3 = raw(); db3.prepare("UPDATE entry_submissions SET team_name='見本中学校' WHERE id=?").run(S.b); db3.close();
});

test("④ 別の大会のファイルは止まる。確認すれば、この大会の申込として入る", () => {
  const pv = db.previewEntryRestore(T2.id, JSON.parse(JSON.stringify(BK)));
  assert.equal(pv.other_tournament, true);
  const stop = db.applyEntryRestore(T2.id, JSON.parse(JSON.stringify(BK)));
  assert.equal(stop.code, "other_tournament"); assert.match(stop.error, /別の大会/);
  assert.equal(db.exportEntryBackup(T2.id).counts.entry_submissions, 1, "止まったときは何も入らない");
  // 同じ申込IDが別の大会にあるものは入れない(警告が出る)
  assert.ok(pv.warnings.some(w => w.includes("別の大会にすでにある")));
  const d = remap(BK, "mv");
  const ok = db.applyEntryRestore(T2.id, d, { allow_other: true });
  assert.ok(ok.ok, JSON.stringify(ok)); assert.equal(ok.other_tournament, true);
  const after = db.exportEntryBackup(T2.id);
  assert.equal(after.counts.entry_submissions, 3); assert.ok(after.tables.entry_submissions.every(s => s.tournament_id === T2.id), "読み込み先の大会として入る");
  assert.equal(db.exportEntryBackup(T.id).counts.entry_submissions, 2, "元の大会は変わらない");
});

test("⑤ 壊れたファイル・書き換え・形式違いは断る。失敗したら何も入らない", () => {
  const fresh = () => JSON.parse(JSON.stringify(BK));
  const bad = (d, re) => { const p = db.previewEntryRestore(T.id, d); assert.ok(p.error && re.test(p.error), JSON.stringify(p).slice(0, 120)); const r = db.applyEntryRestore(T.id, d); assert.ok(r.error); };
  const t1 = fresh(); t1.tables.entrants[0].name = "書き換え"; bad(t1, /壊れて|書き換え/);
  const t2 = fresh(); delete t2.checksum; bad(t2, /壊れて|書き換え/);
  const t3 = fresh(); t3.format = "other"; bad(t3, /バックアップではありません/);
  const t4 = fresh(); delete t4.tables.entrants; bad(t4, /読めません/);
  const t5 = fresh(); t5.tables.entry_submissions[0].id = ""; bad(t5, /IDのない行/);
  bad(null, /形式/); bad([], /形式/); bad("x", /形式/);
  const t6 = fresh(); t6.tables.entrants[0].tournament_id = "zzz"; t6.checksum = require("crypto").createHash("sha256").update(JSON.stringify({ tournament: t6.tournament, tables: t6.tables })).digest("hex"); bad(t6, /別の大会の行/);
  assert.equal(db.previewEntryRestore("no-such", fresh()).error, "読み込み先の大会が見つかりません");
});

test("⑥ 大会の申込設定は、選んだときだけ戻る。選手DBとのリンク切れは紐づけなしで入る", () => {
  const T3 = db.createTournament({ name: "設定検証", date: "2099-12-08" });
  const pv = db.previewEntryRestore(T3.id, remap(BK, "s3"));
  assert.ok(pv.settings_differ.includes("event_config"));
  let r = db.applyEntryRestore(T3.id, remap(BK, "s3"), { allow_other: true });
  assert.ok(r.ok && r.settings_applied.length === 0);
  assert.ok(!(db.getTournament(T3.id).event_config || "").includes("一般男子シングルス"), "既定では設定を変えない");
  const T4 = db.createTournament({ name: "設定検証2", date: "2099-12-09" });
  r = db.applyEntryRestore(T4.id, remap(BK, "s4"), { allow_other: true, apply_settings: true });
  assert.ok(r.ok && r.settings_applied.includes("event_config"));
  assert.ok(db.getTournament(T4.id).event_config.includes("一般男子シングルス"));
  // 選手DBに無い選手IDへの紐づけは外して入る(外部キーで失敗しない)
  const d = remap(BK, "s5"); d.tables.entrants[0].player_id = "no-such-player"; rehash(d);
  const T5 = db.createTournament({ name: "リンク切れ検証", date: "2099-12-10" });
  const p5 = db.previewEntryRestore(T5.id, d);
  assert.ok(p5.warnings.some(w => w.includes("紐づけなし")));
  assert.ok(db.applyEntryRestore(T5.id, d, { allow_other: true }).ok);
});

test("⑦ 途中で失敗したら、全部戻る(何も入らない)", () => {
  const T6 = db.createTournament({ name: "失敗検証", date: "2099-12-11" });
  const d = remap(BK, "s6"); d.tables.entrants[d.tables.entrants.length - 1].name = null; rehash(d);   // 最後の出場者だけ、必須の氏名が無い
  const r = db.applyEntryRestore(T6.id, d, { allow_other: true });
  assert.equal(r.code, "rolled_back"); assert.match(r.error, /何も入っていません/);
  const after = db.exportEntryBackup(T6.id);
  assert.equal(after.counts.entry_submissions, 0); assert.equal(after.counts.entrants, 0, "先に入れた申込・出場者も戻っている");
});
