// 抽選ドロー(drawSingleBracket / computeDrawLeaves)の不変条件を検証する。
//   ① シードが標準シード位置に固定される
//   ② BYE(不戦勝)が上位シードに割り当たる
//   ③ 同一所属(team)が早期(1回戦・同ブロック)で当たりにくく分散される
//   ④ draw_seed が同じなら結果が完全再現、違えば(通常)変わる
//   ⑤ N=2..256 で枠数が2の累乗・全員が一度だけ配置・BYE数=size-N
//   ⑥ シード番号オーバー/重複は警告して非シードに格下げ
//   ⑦ DB経由(drawSingleBracket): ブラケット生成・seed(シードランク)非破壊・force ガード
// 実行: node --test test/bracket-draw.test.js
process.env.DB_PATH = "/tmp/ktta_bracketdraw_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const { mulberry32 } = require("../lib/rng");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const isPow2 = (x) => x >= 1 && (x & (x - 1)) === 0;
const pairOf = (i) => (i % 2 === 0 ? i + 1 : i - 1);

// 合成 entrant 群を作る(DB不要)。seedFn(i)→seed, teamFn(i)→所属。
function ents(n, seedFn, teamFn) {
  const a = [];
  for (let i = 1; i <= n; i++) {
    a.push({ id: "e" + i, display_name: "選手" + String(i).padStart(3, "0"),
      seed: seedFn ? (seedFn(i) || 0) : 0, team: teamFn ? teamFn(i) : "", region: "" });
  }
  return a;
}

// ─────────────────────────────────────────────────────────────
// computeDrawLeaves: 純ロジック
// ─────────────────────────────────────────────────────────────

test("シードが標準シード位置に固定される", () => {
  const size = 16;
  const positions = db.bracketPositions(size); // positions[slot]=その枠の標準ランク
  const posOfRank = {}; positions.forEach((r, i) => { posOfRank[r] = i; });
  const list = ents(16, (i) => (i <= 8 ? i : 0), (i) => "T" + i); // seed1..8
  const { leaves } = db.computeDrawLeaves(list, size, mulberry32(1), { separateBy: "none" });
  for (let rank = 1; rank <= 8; rank++) {
    const slot = posOfRank[rank];
    assert.strictEqual(leaves[slot] && leaves[slot].seed, rank,
      "シード" + rank + " は標準位置 slot" + slot);
  }
  // 第1シードは slot0、第2シードは最深(下半分)に分かれる(1位と2位が決勝まで当たらない)
  assert.strictEqual(leaves[0].seed, 1);
  const s2slot = leaves.findIndex(x => x && x.seed === 2);
  assert.ok(s2slot >= size / 2, "第2シードは下半分(" + s2slot + ")");
});

test("BYE(不戦勝)が上位シードに割り当たる(満たない枠)", () => {
  // 12人/16枠 → 4BYE。第1〜第4シードの1回戦相手が全員BYEになるはず。
  const list = ents(12, (i) => (i <= 4 ? i : 0), (i) => "T" + i);
  const { leaves } = db.computeDrawLeaves(list, 16, mulberry32(42), { separateBy: "none" });
  assert.strictEqual(leaves.filter(Boolean).length, 12, "実選手12");
  assert.strictEqual(leaves.filter(x => !x).length, 4, "BYE4");
  for (let rank = 1; rank <= 4; rank++) {
    const idx = leaves.findIndex(x => x && x.seed === rank);
    assert.strictEqual(leaves[pairOf(idx)], null, "第" + rank + "シードの1回戦相手はBYE");
  }
});

test("同一所属が1回戦で当たらない(クラブ分散)", () => {
  // 4クラブ×各4人=16人。完全分散できるので同一所属の1回戦対戦は0件のはず。
  const list = ents(16, () => 0, (i) => "クラブ" + ((i - 1) % 4));
  // seed を散らさず純抽選でも分散が効くこと
  for (const seed of [1, 7, 99, 12345]) {
    const { leaves } = db.computeDrawLeaves(list, 16, mulberry32(seed), { separateBy: "team" });
    let clubR1 = 0;
    for (let i = 0; i < 16; i += 2) if (leaves[i] && leaves[i + 1] && leaves[i].team === leaves[i + 1].team) clubR1++;
    assert.strictEqual(clubR1, 0, "seed=" + seed + ": 同一所属の1回戦対戦0件");
  }
});

test("不均衡だが分離可能な分布でもR1同所属0件(大所属先+swap修復の契約)", () => {
  // レビュー指摘の退行防止: 単純シャッフル貪欲だと「大クラブ1+多数の単独所属」で回避可能な
  // R1同所属が出ていた。most-constrained-first + swap修復で、分離可能なら必ず0件にする。
  const configs = [
    { size: 8, build: () => [...Array(4)].map((_, i) => ({ id: "A" + i, display_name: "A" + i, seed: 0, team: "A" }))
      .concat([...Array(4)].map((_, i) => ({ id: "U" + i, display_name: "U" + i, seed: 0, team: "u" + i }))) },
    { size: 32, build: () => {
      const a = []; let id = 0;
      [["P", 6], ["Q", 6], ["R", 5], ["S", 5]].forEach(([k, n]) => { for (let i = 0; i < n; i++) a.push({ id: "x" + (id++), display_name: k + i, seed: 0, team: k }); });
      for (let i = 0; i < 10; i++) a.push({ id: "u" + (id++), display_name: "U" + i, seed: 0, team: "u" + i });
      return a; } },
    { size: 16, build: () => {
      const a = []; for (let i = 1; i <= 4; i++) a.push({ id: "s" + i, display_name: "S" + i, seed: i, team: "sc" + i });
      for (let i = 0; i < 6; i++) a.push({ id: "A" + i, display_name: "A" + i, seed: 0, team: "A" });
      for (let i = 0; i < 6; i++) a.push({ id: "U" + i, display_name: "U" + i, seed: 0, team: "u" + i });
      return a; } },
  ];
  for (const cfg of configs) {
    for (let s = 1; s <= 150; s++) {
      const ents = cfg.build();
      const { leaves } = db.computeDrawLeaves(ents, cfg.size, mulberry32(s * 13 + 1), { separateBy: "team" });
      let clubR1 = 0;
      for (let i = 0; i < cfg.size; i += 2) if (leaves[i] && leaves[i + 1] && leaves[i].team === leaves[i + 1].team) clubR1++;
      assert.strictEqual(clubR1, 0, "size" + cfg.size + " seed" + s + ": 分離可能なのにR1同所属=" + clubR1);
      assert.strictEqual(leaves.filter(Boolean).length, ents.length, "全員配置");
    }
  }
});

test("分散より配置可能性を優先(所属が偏っても全員配置)", () => {
  // 1クラブに10人(残6人別)=16人。同一所属の早期対戦は避けられないが全員配置できる。
  const list = ents(16, () => 0, (i) => (i <= 10 ? "巨大クラブ" : "他" + i));
  const { leaves } = db.computeDrawLeaves(list, 16, mulberry32(5), { separateBy: "team" });
  assert.strictEqual(leaves.filter(Boolean).length, 16, "全員配置");
  assert.strictEqual(new Set(leaves.filter(Boolean).map(e => e.id)).size, 16, "重複なし");
});

test("再現性の土台: id整列すれば入力の物理順に依存せず同一配置", () => {
  // 旧バグ: listByEvent は ORDER BY seed,surname。同姓・seed=0 だと SQLite 物理順に依存し、
  // 同じ draw_seed でも並びが変わりうる(=『同種=同並び』が静かに破綻)。drawSingleBracket は
  // id で全順序化してから抽選するため物理順非依存になる。それを純関数レベルで証明する。
  const base = [];
  for (let i = 1; i <= 8; i++) base.push({ id: "e" + i, display_name: "佐藤 " + i, seed: 0, team: "ク" + (i % 3) });
  const byId = (arr) => [...arr].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const idsOf = (arr) => db.computeDrawLeaves(byId(arr), 8, mulberry32(99), { separateBy: "team" }).leaves.map(e => (e ? e.id : null));
  const order1 = idsOf(base);
  const order2 = idsOf([...base].reverse());   // 別の物理順を模す
  assert.deepStrictEqual(order2, order1, "id整列後は入力順に依存せず同一");
});

test("再現性: 同姓・seed=0だらけでも同じ draw_seed で同一配置(物理順非依存)", () => {
  const t = db.createTournament({ name: "同姓再現" + (++_seq), date: "2027-03-03" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= 8; i++) entries.push({ event: EV, type: "singles", name: "佐藤 " + i, team: "ク" + (i % 3) });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  db.drawSingleBracket(t.id, EV, { draw_seed: 99 });
  const s1 = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
    .sort((a, b) => a.bracket_pos - b.bracket_pos).map(m => [m.player1_name, m.player2_name]);
  db.drawSingleBracket(t.id, EV, { draw_seed: 99, force: true });
  const s2 = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
    .sort((a, b) => a.bracket_pos - b.bracket_pos).map(m => [m.player1_name, m.player2_name]);
  assert.deepStrictEqual(s2, s1, "同姓だらけでも同種=同配置");
});

test("draw_seed 再現性: 同じ種なら完全一致・違えば変わる", () => {
  const list = ents(24, (i) => (i <= 6 ? i : 0), (i) => "C" + (i % 5));
  const idsOf = (seed) => db.computeDrawLeaves(list, 32, mulberry32(seed), { separateBy: "team" })
    .leaves.map(e => (e ? e.id : null));
  assert.deepStrictEqual(idsOf(2024), idsOf(2024), "同一種は完全一致");
  assert.notDeepStrictEqual(idsOf(2024), idsOf(2025), "別の種は(通常)異なる");
});

test("N=2..256 の不変条件(枠数2の累乗・全員1回・BYE=size-N)", () => {
  for (const N of [2, 3, 5, 7, 8, 13, 16, 31, 32, 33, 64, 100, 128, 200, 256]) {
    const size = Math.pow(2, Math.ceil(Math.log2(N)));
    const list = ents(N, (i) => (i <= Math.min(8, N) ? i : 0), (i) => "T" + (i % 7));
    const { leaves } = db.computeDrawLeaves(list, size, mulberry32(N * 7 + 1), { separateBy: "team" });
    assert.ok(isPow2(size), "size 2の累乗");
    assert.strictEqual(leaves.length, size, "leaves長=size");
    const placed = leaves.filter(Boolean);
    assert.strictEqual(placed.length, N, "N=" + N + ": 配置数=N");
    assert.strictEqual(new Set(placed.map(e => e.id)).size, N, "N=" + N + ": 重複なし");
    assert.strictEqual(leaves.filter(x => !x).length, size - N, "N=" + N + ": BYE=size-N");
  }
});

test("シード番号オーバー/重複は警告し非シードに格下げ", () => {
  // 8枠なのに seed=20 と、seed=3 が2人。どちらも警告し抽選に回す(全員配置)。
  const list = [
    { id: "a", display_name: "A", seed: 1, team: "" },
    { id: "b", display_name: "B", seed: 20, team: "" },  // オーバー
    { id: "c", display_name: "C", seed: 3, team: "" },
    { id: "d", display_name: "D", seed: 3, team: "" },    // 重複
    { id: "e", display_name: "E", seed: 0, team: "" },
    { id: "f", display_name: "F", seed: 0, team: "" },
  ];
  const { leaves, warnings } = db.computeDrawLeaves(list, 8, mulberry32(9), { separateBy: "none" });
  assert.ok(warnings.some(w => /20/.test(w)), "オーバー警告: " + JSON.stringify(warnings));
  assert.ok(warnings.some(w => /重複/.test(w)), "重複警告");
  assert.strictEqual(leaves.filter(Boolean).length, 6, "全6人配置(格下げ含む)");
  assert.strictEqual(new Set(leaves.filter(Boolean).map(e => e.id)).size, 6, "重複配置なし");
});

// ─────────────────────────────────────────────────────────────
// drawSingleBracket: DB経由(凍結・非破壊・force)
// ─────────────────────────────────────────────────────────────

const EV = "男子シングルス";
let _seq = 0;
function setupDraw(n, seedTop) {
  const t = db.createTournament({ name: "抽選検証" + (++_seq), date: "2027-03-03" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= n; i++) entries.push({ event: EV, type: "singles", name: "選手" + String(i).padStart(3, "0"), team: "ク" + ((i - 1) % 4) });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  const es = db.getEntrants(t.id, EV);
  // 上位 seedTop 人にシードを付与
  es.slice(0, seedTop || 0).forEach((e, k) => db.setEntrantSeed(e.id, k + 1));
  return { t, es };
}
const r1Of = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
  .sort((a, b) => a.bracket_pos - b.bracket_pos);

test("drawSingleBracket: 1回戦は配置のみ(自動進行しない)・BYEは上位シードに配置・進行開始で繰り上げ", () => {
  const { t } = setupDraw(12, 4);
  const r = db.drawSingleBracket(t.id, EV, { draw_seed: 777, separate_by: "team" });
  assert.ok(r.success, "成功: " + JSON.stringify(r));
  assert.strictEqual(r.draw_seed, 777, "draw_seed返却");
  assert.strictEqual(r.bracket_size, 16);
  assert.strictEqual(r.bye_count, 4);
  // ★抽選直後: 不戦勝(vs BYE)も自動完了させない=1回戦は全て未完了の編集可能な状態
  let r1 = r1Of(t);
  assert.strictEqual(r1.filter(m => m.is_walkover).length, 0, "抽選直後は walkover 0(自動進行しない)");
  assert.strictEqual(r1.filter(m => m.status === "completed").length, 0, "抽選直後は completed 0");
  // 上位シードの1回戦相手は BYE(配置されている)
  const seedNames = db.getEntrants(t.id, EV).filter(e => e.seed >= 1).map(e => e.display_name || e.name);
  const byeForSeed = r1.some(m =>
    (m.player1_name === "BYE" && seedNames.includes(m.player2_name)) ||
    (m.player2_name === "BYE" && seedNames.includes(m.player1_name)));
  assert.ok(byeForSeed, "上位シードの1回戦相手が BYE(配置)");
  // 進行開始(不戦勝確定)で繰り上がる
  const adv = db.autoAdvanceByes(t.id, EV);
  assert.ok(adv >= 1, "進行開始で不戦勝が繰り上がる: " + adv);
  r1 = r1Of(t);
  assert.ok(r1.filter(m => m.is_walkover).length >= 1, "繰り上げ後は walkover あり");
});

test("drawSingleBracket: 編集フェーズ(結果未入力)のswapは不戦勝を自動進行しない(自由に編集できる)", () => {
  const { t } = setupDraw(12, 4);   // 16枠・4 BYE
  db.drawSingleBracket(t.id, EV, { draw_seed: 5, separate_by: "team" });
  const r = db.swapBracketSlots(t.id, EV, { pos: 0, slot: 1 }, { pos: 4, slot: 1 });
  assert.ok(r.success, "編集中のswap成功: " + JSON.stringify(r));
  const r1 = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1);
  assert.strictEqual(r1.filter(m => m.is_walkover).length, 0, "編集中のswapで不戦勝は自動進行しない");
  // 進行開始後はswapで生じたBYEを繰り上げる(従来挙動の維持)
  db.autoAdvanceByes(t.id, EV);
  assert.ok(db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1 && m.is_walkover).length >= 1, "進行開始後は繰り上げ");
});

test("再抽選: 進行開始後に再抽選しても2回戦に上げず1回戦を再シャッフル・シード位置は固定", () => {
  const { t } = setupDraw(12, 4);   // 16枠・seed1-4
  const seedPos = () => {
    const r1 = r1Of(t);
    const out = {};
    db.getEntrants(t.id, EV).filter(e => e.seed >= 1).forEach(e => {
      const nm = e.display_name || e.name;
      const m = r1.find(x => x.player1_name === nm || x.player2_name === nm);
      out[e.seed] = m ? (m.bracket_pos + ":" + (m.player1_name === nm ? 1 : 2)) : null;
    });
    return out;
  };
  db.drawSingleBracket(t.id, EV, { draw_seed: 100, drawn_by: "甲" });
  const pos1 = seedPos();
  const r1a = r1Of(t).map(m => [m.player1_name, m.player2_name]);
  db.autoAdvanceByes(t.id, EV);   // 進行開始(不戦勝を2回戦へ)
  // 再抽選(別seed)
  const r = db.drawSingleBracket(t.id, EV, { draw_seed: 200, drawn_by: "乙", force: true });
  assert.ok(r.success, "再抽選成功: " + JSON.stringify(r));
  const r1b = r1Of(t);
  // ① 2回戦に上げない(自動進行しない)
  assert.strictEqual(r1b.filter(m => m.is_walkover).length, 0, "再抽選後 walkover0(2回戦に上げない)");
  assert.strictEqual(r1b.filter(m => m.status === "completed").length, 0, "再抽選後 completed0");
  const r2filled = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 2)
    .reduce((c, m) => c + ((m.player1_name && m.player1_name !== "BYE") ? 1 : 0) + ((m.player2_name && m.player2_name !== "BYE") ? 1 : 0), 0);
  assert.strictEqual(r2filled, 0, "再抽選後 2回戦は空");
  // ② シード位置は固定(別seedでも全シードが同じ位置)
  assert.deepStrictEqual(seedPos(), pos1, "再抽選でもシード位置は固定");
  // ③ 1回戦は再シャッフルされている(非シードの並びが変わる)
  const r1bNames = r1b.map(m => [m.player1_name, m.player2_name]);
  assert.notDeepStrictEqual(r1bNames, r1a, "1回戦が再シャッフルされる");
});

test("drawSingleBracket: seed(シードランク)を上書きしない(非破壊)", () => {
  const { t } = setupDraw(8, 3);
  const before = db.getEntrants(t.id, EV).map(e => [e.display_name || e.name, e.seed]).sort();
  db.drawSingleBracket(t.id, EV, { draw_seed: 1, separate_by: "team" });
  const afterE = db.getEntrants(t.id, EV);
  const after = afterE.map(e => [e.display_name || e.name, e.seed]).sort();
  assert.deepStrictEqual(after, before, "抽選後も seed(ランク)は不変");
  // bracket_side / bracket_number は付与されている
  assert.ok(afterE.every(e => e.bracket_side === "L" || e.bracket_side === "R"), "左右が付く");
  assert.ok(afterE.some(e => e.bracket_number > 0), "選手番号が付く");
});

test("drawSingleBracket: 同じ draw_seed で引き直すと同一配置", () => {
  const { t } = setupDraw(13, 4);
  db.drawSingleBracket(t.id, EV, { draw_seed: 5050, separate_by: "team" });
  const slots1 = r1Of(t).map(m => [m.player1_name, m.player2_name]);
  db.drawSingleBracket(t.id, EV, { draw_seed: 5050, separate_by: "team", force: true });
  const slots2 = r1Of(t).map(m => [m.player1_name, m.player2_name]);
  assert.deepStrictEqual(slots2, slots1, "同一種=同一配置");
});

test("drawSingleBracket: 結果入力済みは force 無しで弾く", () => {
  const { t } = setupDraw(8, 0);
  db.drawSingleBracket(t.id, EV, { draw_seed: 1 });
  // 実選手同士の1回戦を1つ完了させる
  const m = r1Of(t).find(x => x.player1_name && x.player2_name && x.player1_name !== "BYE" && x.player2_name !== "BYE");
  assert.ok(m, "対戦可能な1回戦あり");
  db.finishMatchOp(m.id, { winner_slot: 1, sets: [[11, 5], [11, 7], [11, 9]] });
  const blocked = db.drawSingleBracket(t.id, EV, { draw_seed: 2 });
  assert.ok(blocked && blocked.needs_force, "結果ありは needs_force: " + JSON.stringify(blocked));
  const forced = db.drawSingleBracket(t.id, EV, { draw_seed: 2, force: true });
  assert.ok(forced.success, "force で再抽選成功");
});

test("drawSingleBracket: 地区(region)分散モード", () => {
  const t = db.createTournament({ name: "地区抽選" + (++_seq), date: "2027-03-03" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= 16; i++) entries.push({ event: EV, type: "singles", name: "Ｒ選手" + i, team: "所属" + i });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  // 地区を4つに振る(各4人)
  db.getEntrants(t.id, EV).forEach((e, i) => { try { db.setEntrantRegion ? db.setEntrantRegion(e.id, "地区" + (i % 4)) : null; } catch (x) {} });
  const r = db.drawSingleBracket(t.id, EV, { draw_seed: 1, separate_by: "region" });
  assert.ok(r.success, "地区分散でも成功: " + JSON.stringify(r));
  assert.strictEqual(r.separate_by, "region");
});
