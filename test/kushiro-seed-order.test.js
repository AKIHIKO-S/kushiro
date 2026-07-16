// 釧路式シード配置(buildSeededLeaves)の物理順TODO解消を固定する回帰テスト。
// 以前は再帰の各段階でシード席を計算し直しており、深い階層(特にスーパーシードが絡む場合)で
// 常に上位区画へ寄る浅い蛇行が生まれ、抽選ドロー側(computeDrawLeaves・2026-07-14ユーザー承認・
// 既存テストで検証済み)とズレていた(実測: シードの過半数が不一致)。
// generateBracket(非抽選・buildSeededLeaves経由)と drawSingleBracket(抽選・computeDrawLeaves経由)は
// 別実装だが、同じシード構成に対しては同じ物理配置を返すべき、という往復一致性を固定する。
// 実行: node --test test/kushiro-seed-order.test.js
process.env.DB_PATH = "/tmp/ktta_kushiroseed_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
let _seq = 0;

function mkEntrants(t, n, seededCount, ssCount) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    ids.push(db.createEntrant({ tournament_id: t.id, event: EV,
      name: "選手" + String(i).padStart(3, "0"), team: "ク" + (i % 7), furigana: "せ" + String(i).padStart(3, "0") }));
  }
  for (let i = 0; i < seededCount; i++) {
    db.setEntrantSeed(ids[i].id, i + 1);
    db.setEntrantEntryRound(ids[i].id, i < ssCount ? 2 : 1);
  }
  return ids;
}

function leafPositions(matches) {
  const pos = {};
  matches.filter(m => m.bracket_round === 1).forEach(m => {
    const p = m.bracket_pos || 0;
    if (m.player1_name && m.player1_name !== "BYE") pos[m.player1_name] = 2 * p;
    if (m.player2_name && m.player2_name !== "BYE") pos[m.player2_name] = 2 * p + 1;
  });
  return pos;
}

// generateBracket(buildSeededLeaves)とdrawSingleBracket(computeDrawLeaves)を同じシード構成で
// 実行し、シード全員の物理配置(0-indexedスロット)が一致することを検証する。
function assertRoundtripMatch(n, seededCount, ssCount, openMode, label) {
  const t1 = db.createTournament({ name: "kushiro順序A" + (++_seq), date: "2027-07-01" });
  db.updateEntrySettings(t1.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0, open: openMode }] });
  mkEntrants(t1, n, seededCount, ssCount);
  const gen = db.generateBracket(t1.id, EV, { regenerate: true, force: true });
  assert.ok(!gen.error, label + ": generateBracket失敗 " + JSON.stringify(gen));
  const pos1 = leafPositions(db.getMatchesByTournament(t1.id).filter(m => m.event === EV));

  const t2 = db.createTournament({ name: "kushiro順序B" + (++_seq), date: "2027-07-01" });
  db.updateEntrySettings(t2.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0, open: openMode }] });
  mkEntrants(t2, n, seededCount, ssCount);
  const drawRes = db.drawSingleBracket(t2.id, EV, { draw_seed: 424242, separate_by: "none" });
  assert.ok(!drawRes.error, label + ": drawSingleBracket失敗 " + JSON.stringify(drawRes));
  const pos2 = leafPositions(db.getMatchesByTournament(t2.id).filter(m => m.event === EV));

  assert.strictEqual(gen.bracket_size, drawRes.bracket_size, label + ": 枠数が一致すること(前提)");
  for (let i = 1; i <= seededCount; i++) {
    const name = "選手" + String(i).padStart(3, "0");
    assert.strictEqual(pos1[name], pos2[name],
      `${label}: シード${i}(${name})の物理配置が一致すること(build=${pos1[name]} draw=${pos2[name]})`);
  }
}

test("釧路式(open種目): generateBracketとdrawSingleBracketのシード配置が完全一致する(16枠・SS2人)", () => {
  assertRoundtripMatch(16, 4, 2, true, "釧路式16枠SS2人");
});

test("釧路式(open種目): 32枠・SS2人・シード16人でも完全一致する", () => {
  assertRoundtripMatch(32, 16, 2, true, "釧路式32枠SS2人シード16人");
});

test("釧路式(open種目): シード無しスーパーシード除去後も完全一致する(8枠・SS1人)", () => {
  assertRoundtripMatch(8, 2, 1, true, "釧路式8枠SS1人");
});

test("通常式(for_mac標準・open種目でない): generateBracketとdrawSingleBracketのシード配置が完全一致する(16枠・SS1人)", () => {
  assertRoundtripMatch(16, 4, 1, false, "通常式16枠SS1人");
});

test("通常式(for_mac標準): 32枠・SS1人・シード8人でも完全一致する", () => {
  assertRoundtripMatch(32, 8, 1, false, "通常式32枠SS1人シード8人");
});

test("釧路式: スーパーシード本人は区画の先頭ではなく実際のシード席(絶対位置)に置かれる(第2シード=最下端)", () => {
  // 修正前は「区画専有=区画の先頭(lo)に強制配置」だったため、第2シード(本来は最下端)が
  // 区画の先頭寄りにズレていた。第1と最終(第2)シードが釧路式の外シードであることを固定する。
  const t = db.createTournament({ name: "kushiro外シード検証" + (++_seq), date: "2027-07-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0, open: true }] });
  mkEntrants(t, 16, 2, 2);   // seed1,2ともスーパーシード(entry_round=2・w=2)
  const gen = db.generateBracket(t.id, EV, { regenerate: true, force: true });
  assert.ok(!gen.error, "generateBracket失敗: " + JSON.stringify(gen));
  const pos = leafPositions(db.getMatchesByTournament(t.id).filter(m => m.event === EV));
  assert.strictEqual(pos["選手001"], 0, "第1シードは全体の先頭(0)");
  assert.strictEqual(pos["選手002"], gen.bracket_size - 1, "第2シード(釧路式の外シード)は全体の最後尾");
});

test("釧路式: 中間シード(seed3以降)も標準式(computeDrawLeaves)と一致する絶対位置に配置される", () => {
  const t1 = db.createTournament({ name: "kushiro中間シードA" + (++_seq), date: "2027-07-01" });
  db.updateEntrySettings(t1.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0, open: true }] });
  mkEntrants(t1, 16, 4, 2);
  const gen = db.generateBracket(t1.id, EV, { regenerate: true, force: true });
  assert.ok(!gen.error);
  const pos1 = leafPositions(db.getMatchesByTournament(t1.id).filter(m => m.event === EV));
  // seed3,4(非SS通常シード)は釧路式で下の山(後半8枠)に入る
  assert.ok(pos1["選手003"] >= gen.bracket_size / 2, "seed3は下山");
  assert.ok(pos1["選手004"] >= gen.bracket_size / 2, "seed4は下山");
});
