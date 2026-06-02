// トーナメント表「作成(generateBracket)」の精度を不変条件で網羅検証する。
// 崩れた条件は実バグ。標準シード配置 / as_drawn / 再生成 / BYE自動進行 / next_match鎖 /
// 選手番号一意 / シード対角(1位と2位が決勝まで当たらない) を確認。
// 実行: node --test test/bracket-generation.test.js
process.env.DB_PATH = "/tmp/ktta_bracketgen_" + process.pid + ".db";

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
function setup() {
  const t = db.createTournament({ name: "ブラケット検証" + (++_seq), date: "2027-01-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  return t;
}
// N人を seed=1..N で登録(seed=出場順位/通し番号)
function addSeeded(t, n) {
  const entries = [];
  for (let i = 1; i <= n; i++) entries.push({ event: EV, type: "singles", name: "選手" + String(i).padStart(3, "0"), team: "T" + i });
  const r = db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  assert.strictEqual(r.entry_count, n, "N人登録: " + r.entry_count + "/" + n);
  const ents = db.getEntrants(t.id, EV);
  ents.forEach(e => { const m = /選手(\d+)/.exec(e.name || e.display_name || ""); if (m) db.setEntrantSeed(e.id, parseInt(m[1])); });
  return ents;
}
const evMatches = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV);
const isPow2 = (x) => x >= 1 && (x & (x - 1)) === 0;

// 標準配置ブラケットの不変条件をすべて検証
function assertBracket(t, N, { asDrawn = false } = {}) {
  const ms = evMatches(t);
  const r1 = ms.filter(m => m.bracket_round === 1).sort((a, b) => a.bracket_pos - b.bracket_pos);
  const size = r1.length * 2;
  assert.ok(isPow2(size), `bracketSize=${size} は2の累乗`);
  if (!asDrawn) assert.ok(size >= N && size < 2 * N, `size=${size} は N=${N} の次の2の累乗`);
  assert.strictEqual(ms.length, size - 1, `総試合数 = size-1 (${ms.length} vs ${size - 1})`);

  // 実選手がちょうど N 人、round1 に重複なく配置
  const realNames = [];
  r1.forEach(m => {
    [m.player1_name, m.player2_name].forEach(nm => { if (nm && nm !== "BYE") realNames.push(nm); });
  });
  assert.strictEqual(realNames.length, N, `round1 の実選手数 = N (${realNames.length} vs ${N})`);
  assert.strictEqual(new Set(realNames).size, N, "round1 に選手の重複なし");

  // BYE 数 = size - N
  const byeSlots = r1.reduce((c, m) => c + (m.player1_name === "BYE" ? 1 : 0) + (m.player2_name === "BYE" ? 1 : 0), 0);
  assert.strictEqual(byeSlots, size - N, `BYE数 = size-N (${byeSlots} vs ${size - N})`);

  // next_match_id 鎖: 決勝以外は前進先が存在、決勝は無し
  const totalRounds = Math.log2(size);
  const byId = {}; ms.forEach(m => byId[m.id] = m);
  ms.forEach(m => {
    if (m.bracket_round < totalRounds) assert.ok(m.next_match_id && byId[m.next_match_id], `R${m.bracket_round} は次戦へリンク`);
    else assert.ok(!m.next_match_id, "決勝に次戦リンクなし");
  });

  // BYE試合は不戦勝として完了し、勝者が次戦へ進出している
  r1.forEach(m => {
    const hasBye = m.player1_name === "BYE" || m.player2_name === "BYE";
    if (hasBye && (m.player1_name || m.player2_name)) {
      assert.strictEqual(m.is_walkover, 1, "BYE試合は is_walkover=1");
      assert.strictEqual(m.status, "completed", "BYE試合は完了");
      const winnerName = m.player1_name === "BYE" ? m.player2_name : m.player1_name;
      if (winnerName && winnerName !== "BYE" && m.next_match_id) {
        const nx = byId[m.next_match_id];
        assert.ok([nx.player1_name, nx.player2_name].includes(winnerName), `BYE勝者 ${winnerName} が次戦に進出`);
      }
    }
  });

  // 選手番号(bracket_number) が左右サイド内で一意
  const ents = db.getEntrants(t.id, EV).filter(e => e.bracket_number > 0);
  const bySide = {};
  ents.forEach(e => { const k = e.bracket_side || "?"; (bySide[k] = bySide[k] || []).push(e.bracket_number); });
  Object.entries(bySide).forEach(([side, nums]) => {
    assert.strictEqual(new Set(nums).size, nums.length, `サイド${side} の選手番号が一意`);
  });
}

// ── 標準シード配置: N=2..64 の網羅 ──
for (const N of [2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 48, 64]) {
  test(`標準配置 N=${N}: 不変条件をすべて満たす`, () => {
    const t = setup();
    addSeeded(t, N);
    const r = db.generateBracket(t.id, EV, {});
    assert.ok(r.success, "生成成功: " + JSON.stringify(r).slice(0, 100));
    assertBracket(t, N);
  });
}

test("標準配置: 第1シードと第2シードは決勝まで当たらない(対角配置)", () => {
  for (const N of [4, 8, 16, 32]) {
    const t = setup();
    addSeeded(t, N);
    db.generateBracket(t.id, EV, {});
    const r1 = evMatches(t).filter(m => m.bracket_round === 1).sort((a, b) => a.bracket_pos - b.bracket_pos);
    const idxOf = (nm) => r1.findIndex(m => m.player1_name === nm || m.player2_name === nm);
    const i1 = idxOf("選手001"), i2 = idxOf("選手002");
    const half = r1.length / 2;
    assert.ok(i1 >= 0 && i2 >= 0, "両シードがround1に居る");
    assert.notStrictEqual(i1 < half, i2 < half, `N=${N}: 第1(${i1})と第2(${i2})は別の山(half=${half})`);
  }
});

test("標準配置: 人数<サイズ時、上位シードにBYEが付く(下位シードでなく)", () => {
  const t = setup();
  addSeeded(t, 5);   // size=8, BYE=3 → 第1〜3シードがBYE
  db.generateBracket(t.id, EV, {});
  const r1 = evMatches(t).filter(m => m.bracket_round === 1);
  const byeOpp = (nm) => r1.some(m =>
    (m.player1_name === nm && m.player2_name === "BYE") || (m.player2_name === nm && m.player1_name === "BYE"));
  assert.ok(byeOpp("選手001"), "第1シードはBYE");
  assert.ok(!byeOpp("選手005"), "最下位シードはBYEでない(実戦)");
});

// ── as_drawn(取込どおり配置) ──
test("as_drawn: 通し番号どおりに配置され、不変条件を満たす", () => {
  for (const N of [4, 6, 8, 16]) {
    const t = setup();
    addSeeded(t, N);
    const r = db.generateBracket(t.id, EV, { placement: "as_drawn" });
    assert.ok(r.success, `as_drawn N=${N} 成功: ` + JSON.stringify(r).slice(0, 80));
    assertBracket(t, N, { asDrawn: true });
    // 番号1の選手は round1 の先頭スロット(match0 の player1)
    const r1 = evMatches(t).filter(m => m.bracket_round === 1).sort((a, b) => a.bracket_pos - b.bracket_pos);
    assert.strictEqual(r1[0].player1_name, "選手001", `N=${N}: 番号1は先頭スロット`);
  }
});

test("as_drawn: 組番号の重複はエラーで停止(選手消失を防ぐ)", () => {
  const t = setup();
  const ents = addSeeded(t, 4);
  db.setEntrantSeed(ents.find(e => /002/.test(e.name)).id, 1);  // 番号1を重複させる
  const r = db.generateBracket(t.id, EV, { placement: "as_drawn" });
  assert.ok(r.error && /重複/.test(r.error), "重複でエラー: " + JSON.stringify(r).slice(0, 80));
});

test("as_drawn: 番号未設定(seed<1)があればエラー", () => {
  const t = setup();
  const ents = addSeeded(t, 4);
  db.setEntrantSeed(ents[0].id, 0);  // 1人だけ番号なし
  const r = db.generateBracket(t.id, EV, { placement: "as_drawn" });
  assert.ok(r.error && /組番号/.test(r.error), "番号未設定でエラー: " + JSON.stringify(r).slice(0, 80));
});

// ── 再生成の原子性・整合 ──
test("再生成: 2回生成しても試合数=size-1のまま(孤児/重複なし)", () => {
  const t = setup();
  addSeeded(t, 12);   // size=16 → 15試合
  db.generateBracket(t.id, EV, {});
  assert.strictEqual(evMatches(t).length, 15, "1回目 15試合");
  db.generateBracket(t.id, EV, { regenerate: true });
  assert.strictEqual(evMatches(t).length, 15, "再生成後も 15試合(孤児なし)");
  assertBracket(t, 12);
});

test("生成は confirmed のみ対象(却下/承認待ちは除外)", () => {
  const t = setup();
  const ents = addSeeded(t, 8);
  db.setEntrantStatus(ents.find(e => /001/.test(e.name)).id, "rejected");
  db.generateBracket(t.id, EV, {});
  const names = [];
  evMatches(t).filter(m => m.bracket_round === 1).forEach(m => [m.player1_name, m.player2_name].forEach(n => { if (n && n !== "BYE") names.push(n); }));
  assert.ok(!names.includes("選手001"), "却下選手はブラケットに出ない");
  assert.strictEqual(names.length, 7, "残り7人");
});

test("2人ちょうど: 1試合(決勝のみ)・BYEなし", () => {
  const t = setup();
  addSeeded(t, 2);
  const r = db.generateBracket(t.id, EV, {});
  assert.ok(r.success);
  const ms = evMatches(t);
  assert.strictEqual(ms.length, 1, "1試合");
  assert.strictEqual(ms[0].player1_name !== "BYE" && ms[0].player2_name !== "BYE", true, "両者実選手");
});
