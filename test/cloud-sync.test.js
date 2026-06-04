// クラウド公開ミラー同期(本部ローカル→クラウド)の db レベル round-trip。
//   ・exportPublicSnapshot は大会の公開フィールドと matches のみ(連絡先PII/entrants は含まない)
//   ・applyPublicSnapshot は大会を作成/更新し matches を全置換、FK(player/entrant id)は null 化
//   ・再適用で matches が重複しない(本部=正本の全置換)
// 実行: node --test test/cloud-sync.test.js
process.env.DB_PATH = "/tmp/ktta_sync_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const EV = "男子シングルス";
let _seq = 0;
function setupWithResult() {
  const t = db.createTournament({ name: "同期元" + (++_seq), date: "2027-10-10", venue: "本部体育館" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "保護者太郎", contact_email: "p@example.com",
    entries: [{ event: EV, type: "singles", name: "山田 太郎", team: "A" }, { event: EV, type: "singles", name: "鈴木 一", team: "B" }] });
  db.generateBracket(t.id, EV, { regenerate: true });
  const m = db.getMatchesByTournament(t.id).find(x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 7], [11, 9]] });
  return t;
}

test("exportPublicSnapshot: 公開フィールド+matches のみ(PII/連絡先・entrants を含まない)", () => {
  const t = setupWithResult();
  const snap = db.exportPublicSnapshot(t.id);
  assert.ok(snap && snap.tournament && snap.tournament.id === t.id, "tournament 公開フィールド");
  assert.strictEqual(snap.tournament.name, "同期元" + _seq);
  assert.ok(Array.isArray(snap.matches) && snap.matches.length >= 1, "matches を含む");
  // 連絡先PII・entrants は含まない
  const s = JSON.stringify(snap);
  assert.ok(!s.includes("保護者太郎") && !s.includes("p@example.com"), "連絡先PIIを含まない");
  assert.ok(!("entrants" in snap), "entrants を同期しない");
  // 秘匿列(referee_token 等)を含まない
  assert.ok(!("referee_token" in snap.tournament) && !("entry_gas_url" in snap.tournament), "秘匿列を含まない");
});

test("applyPublicSnapshot: 既存大会を更新し matches を全置換・FK列はnull化(同一tidの再同期)", () => {
  const t = setupWithResult();
  const snap = db.exportPublicSnapshot(t.id);
  const before = db.getMatchesByTournament(t.id).length;
  const r = db.applyPublicSnapshot(snap);   // クラウドが同一tidを受信(DELETE→再INSERT)
  assert.ok(r.ok && r.tournament_id === t.id, "適用成功");
  const cm = db.getMatchesByTournament(t.id);
  assert.strictEqual(cm.length, before, "matches 全置換(件数一致・重複なし)");
  const done = cm.find(x => x.status === "completed" && x.winner_name);
  assert.ok(done && done.winner_name, "結果(勝者名)が保持される");
  assert.strictEqual(done.winner_id, null, "winner_id(FK)はnull化");
  assert.strictEqual(done.player1_entrant_id, null, "player1_entrant_id(FK)はnull化");
  // 再適用しても重複しない
  db.applyPublicSnapshot(snap);
  assert.strictEqual(db.getMatchesByTournament(t.id).length, before, "再適用で重複しない");
});

test("applyPublicSnapshot: 受信側に無い大会は新規作成(PII/entrants は作らない)", () => {
  const t = setupWithResult();
  const snap = db.exportPublicSnapshot(t.id);
  // クラウドに無い大会を模す: 大会idとmatch idを未使用の値に振り直す(別DB相当)
  const newTid = "cloudnew-" + Date.now() + "-" + _seq;
  snap.tournament.id = newTid;
  snap.matches.forEach((m, i) => { m.id = "cm-" + newTid + "-" + i; m.tournament_id = newTid; });
  const r = db.applyPublicSnapshot(snap);
  assert.ok(r.ok && r.tournament_id === newTid, "適用成功");
  assert.ok(db.getTournament(newTid), "受信側に大会が作られた");
  assert.ok(db.getMatchesByTournament(newTid).length >= 1, "matches 反映");
  assert.strictEqual((db.getEntrants(newTid) || []).length, 0, "entrants は同期されない(PII温存)");
});
