// ブラケット「書込なしプレビュー」(generateBracket の preview 分岐)の回帰テスト。
//  - 構造(matches)を返す / DBに一切書き込まない / 登場回戦(スーパーシード)を反映 /
//    本生成(regenerate)と round1 配置が一致する。
// 実行: node --test test/bracket-preview.test.js
process.env.DB_PATH = "/tmp/ktta_brprev_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const ext of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} });

const EV = "男子シングルス";
let _seq = 0;
function setup(n) {
  const t = db.createTournament({ name: "プレビュー検証" + (++_seq), date: "2027-06-06" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= n; i++) entries.push({ event: EV, type: "singles", name: "選手" + String(i).padStart(2, "0"), team: "T" + i });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  const ents = db.getEntrants(t.id, EV);
  ents.forEach((e, i) => db.setEntrantSeed(e.id, i + 1));
  return { t, ents };
}

test("preview: 構造(matches)を返し、DBには一切書き込まない", () => {
  const { t } = setup(4);
  const before = db.getMatchesByTournament(t.id).length;
  const r = db.generateBracket(t.id, EV, { preview: true });
  assert.ok(r && r.preview === true, "preview フラグ: " + JSON.stringify(r).slice(0, 140));
  assert.ok(Array.isArray(r.matches) && r.matches.length >= 1, "matches 配列を返す");
  assert.ok(Number.isInteger(Math.log2(r.bracket_size)), "bracket_size は2の累乗: " + r.bracket_size);
  assert.strictEqual(db.getMatchesByTournament(t.id).length, before, "preview はDBに書き込まない(試合数不変)");
});

test("preview: 登場回戦2(スーパーシード)で枠が増え、当人は1回戦に居ない。書込なし", () => {
  const { t, ents } = setup(4);
  const normal = db.generateBracket(t.id, EV, { preview: true });
  db.setEntrantEntryRound(ents[0].id, 2);             // 1名を「2回戦から」に
  const ss = db.generateBracket(t.id, EV, { preview: true });
  assert.ok(ss.bracket_size > normal.bracket_size, "スーパーシードで枠が増える: " + normal.bracket_size + "→" + ss.bracket_size);
  const ssName = ents[0].display_name || ents[0].name || ents[0].surname;
  // 登場回戦2 = 1回戦はBYE上がり(枠には居るが相手はBYE) → 2回戦以降に登場して実戦する。
  const ssR1 = ss.matches.find(m => m.bracket_round === 1 && (m.player1_name === ssName || m.player2_name === ssName));
  assert.ok(ssR1, "SSは1回戦の枠に居る(BYE上がりのため): " + ssName);
  const opp = ssR1.player1_name === ssName ? ssR1.player2_name : ssR1.player1_name;
  assert.strictEqual(opp, "", "SSの1回戦の相手はBYE(空)=1回戦は実際には戦わない");
  const laterNames = ss.matches.filter(m => m.bracket_round >= 2).flatMap(m => [m.player1_name, m.player2_name]);
  assert.ok(laterNames.includes(ssName), "SSは2回戦以降に登場(BYEで繰り上がり): " + ssName);
  assert.strictEqual(db.getMatchesByTournament(t.id).length, 0, "SSプレビューも書込なし");
});

test("preview: 本生成(regenerate)と round1 の配置が一致する", () => {
  const { t } = setup(6);
  const prev = db.generateBracket(t.id, EV, { preview: true });   // 先にプレビュー(未書込)
  db.generateBracket(t.id, EV, { regenerate: true });             // 本生成
  const real = db.exportBracket(t.id, EV);
  const norm = (s) => (s === "BYE" ? "" : (s || ""));
  const r1 = (data) => data.matches.filter(m => m.bracket_round === 1)
    .sort((a, b) => a.bracket_pos - b.bracket_pos).map(m => [norm(m.player1_name), norm(m.player2_name)]);
  assert.strictEqual(prev.bracket_size, real.bracket_size, "枠数一致");
  assert.deepStrictEqual(r1(prev), r1(real), "preview と本生成の round1 配置が一致");
});
