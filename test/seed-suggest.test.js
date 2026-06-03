// シード自動提案(Elo rating + 過去成績 achievements → 客観スコア順)と根拠の記録。
// 実行: node --test test/seed-suggest.test.js
process.env.DB_PATH = "/tmp/ktta_seedsg_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

const EV = "一般男子シングルス";
let _seq = 0;
function setup() {
  // 選手DB: rating と成績を仕込む
  const mk = (name, team, rating, achs) => {
    const p = db.createPlayer({ name, team, gender: "male", _allowAnyName: true });
    db.updatePlayer(p.id, { rating });
    (achs || []).forEach(a => db.addAchievement(p.id, { event: EV, place: a.place, year: a.year }));
    return p;
  };
  mk("山田 太郎", "A", 1900, []);                          // 最高R
  mk("鈴木 一郎", "B", 1700, [{ place: 1, year: new Date().getFullYear() }]); // 中R＋直近優勝
  mk("佐藤 次郎", "C", 1750, []);                          // 中R(成績なし)
  mk("田中 三郎", "D", 1550, []);                          // 低R
  // 大会＋entrants(選手名で照合)
  const t = db.createTournament({ name: "シード提案" + (++_seq), date: "2027-09-09" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = ["山田 太郎", "鈴木 一郎", "佐藤 次郎", "田中 三郎", "無名 四郎"]
    .map((nm, i) => ({ event: EV, type: "singles", name: nm, team: ["A", "B", "C", "D", "Z"][i] }));
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  return t;
}

test("by=elo: rating 降順でシード提案", () => {
  const t = setup();
  const r = db.suggestSeeds(t.id, EV, { by: "elo" });
  assert.strictEqual(r.matched, 4, "照合4名(無名は未照合)");
  const top = r.suggestions.filter(s => s.suggested_seed >= 1);
  assert.strictEqual(top[0].name, "山田 太郎", "第1=最高R");
  assert.deepStrictEqual(top.map(s => s.name), ["山田 太郎", "佐藤 次郎", "鈴木 一郎", "田中 三郎"], "rating降順");
  // 未照合は seed0・根拠は未照合
  const unmatched = r.suggestions.find(s => s.name === "無名 四郎");
  assert.strictEqual(unmatched.suggested_seed, 0);
  assert.ok(/未照合/.test(unmatched.basis));
});

test("by=blend: Elo＋成績で直近優勝者が繰り上がる", () => {
  const t = setup();
  const elo = db.suggestSeeds(t.id, EV, { by: "elo" }).suggestions;
  const blend = db.suggestSeeds(t.id, EV, { by: "blend" }).suggestions;
  // elo では 佐藤(1750) > 鈴木(1700)。blend では鈴木に直近優勝(+150)が乗り順位が上がる。
  const eloRank = (n) => elo.findIndex(s => s.name === n);
  const blendRank = (n) => blend.findIndex(s => s.name === n);
  assert.ok(eloRank("佐藤 次郎") < eloRank("鈴木 一郎"), "elo: 佐藤>鈴木");
  assert.ok(blendRank("鈴木 一郎") < blendRank("佐藤 次郎"), "blend: 鈴木>佐藤(成績で逆転)");
});

test("シード根拠の記録: source/reason/by/at が残る", () => {
  const t = setup();
  const e = db.getEntrants(t.id, EV).find(x => (x.name || x.display_name).includes("山田"));
  db.setEntrantSeed(e.id, 1, { source: "auto:blend", reason: "R1900", by: "運営太郎" });
  const after = db.getEntrants(t.id, EV).find(x => x.id === e.id);
  assert.strictEqual(after.seed, 1);
  assert.strictEqual(after.seed_source, "auto:blend");
  assert.strictEqual(after.seed_reason, "R1900");
  assert.strictEqual(after.seed_set_by, "運営太郎");
  assert.ok(after.seed_set_at, "設定日時が残る");
});

test("opts無しの setEntrantSeed は根拠を上書きしない(後方互換)", () => {
  const t = setup();
  const e = db.getEntrants(t.id, EV)[0];
  const r = db.setEntrantSeed(e.id, 3);
  assert.ok(r.ok && r.seed === 3, "従来どおり seed 設定");
});
