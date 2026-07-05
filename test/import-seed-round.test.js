// 取込プレビューで指定した登場回戦(シード)が entrants → ブラケットに反映される回帰 (WP2-5)。
// シード数=必要BYE数のとき、タイトなブラケットで各シードが1回戦BYE→登場回戦から始まる。
// 実行: node --test test/import-seed-round.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const Database = require("better-sqlite3");

function freshDb() {
  const p = path.join(os.tmpdir(), `ktta_seedround_${process.pid}_${Math.floor(process.hrtime()[1])}.db`);
  for (const x of ["", "-wal", "-shm"]) { try { fs.rmSync(p + x, { force: true }); } catch (e) {} }
  return p;
}

test("登場回戦2のシードは1回戦BYEで2回戦から登場する", () => {
  const dbPath = freshDb();
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve("../db.js")];
  const db = require("../db.js");
  const t = db.createTournament({ name: "seed-test", date: "2027-12-01" });
  // 6名で8枠(2BYE)。組番号1(上端)と6(下端)を登場2回戦(シード)に。
  const players = [];
  for (let i = 1; i <= 6; i++) players.push({ name: "選手" + i, team: "T" + i, seed: i, side: i <= 3 ? "L" : "R", entry_round: (i === 1 || i === 6) ? 2 : 1 });
  const r = db.importBracket(t.id, { format: "tabletennis-seed-list-v1", event: "S", players, regenerate: true, placement: "as_drawn" });
  assert.ok(!r.error, "取込成功: " + JSON.stringify(r));
  assert.strictEqual(r.bracket_size, 8, "6名+2シード→8枠(タイト)");

  const raw = new Database(dbPath);
  const r1 = raw.prepare("SELECT player1_name, player2_name FROM matches WHERE tournament_id=? AND event=? AND round LIKE '%準々決勝%'").all(t.id, "S");
  raw.close();
  // シード(選手1,選手6)は 準々決勝(=1回戦相当)で BYE と当たる=不戦勝で2回戦へ
  const seedByes = r1.filter(m => (m.player2_name === "BYE" || m.player1_name === "BYE"));
  const seedNames = seedByes.flatMap(m => [m.player1_name, m.player2_name]).filter(n => n && n !== "BYE");
  assert.ok(seedNames.includes("選手1"), "選手1がBYE(シード): " + JSON.stringify(r1));
  assert.ok(seedNames.includes("選手6"), "選手6がBYE(シード): " + JSON.stringify(r1));
});

test("登場回戦の指定が無ければ全員1回戦(従来どおり)", () => {
  const dbPath = freshDb();
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve("../db.js")];
  const db = require("../db.js");
  const t = db.createTournament({ name: "no-seed", date: "2027-12-01" });
  const players = [];
  for (let i = 1; i <= 8; i++) players.push({ name: "P" + i, team: "T" + i, seed: i, side: i <= 4 ? "L" : "R" });
  const r = db.importBracket(t.id, { format: "tabletennis-seed-list-v1", event: "S", players, regenerate: true, placement: "as_drawn" });
  assert.ok(!r.error, "取込成功");
  assert.strictEqual(r.bracket_size, 8, "8名→8枠");
});
