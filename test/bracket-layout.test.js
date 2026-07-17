// 共有レイアウト計算層(public/shared/bracket-layout.js)の幾何回帰。
// renderPaperBracket(admin)から抽出した座標式を「数値で」固定する: ここが通る限り、
// admin/viewer/印刷のどこから呼んでも同じ山(same-pixel)になる。座標の期待値は
// ROW_H=34/ADV_W=44/CENTER_W=150/PAD_T=10/RAIL_W下限230 の定数から手計算したもの。
// 実行: node --test test/bracket-layout.test.js
process.env.DB_PATH = "/tmp/ktta_blayout_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const { computeBracketLayout, synthesizeStandardWiring } = require("../public/shared/bracket-layout");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EV = "男子シングルス";
function mkEntrants(t, n) {
  for (let i = 1; i <= n; i++) {
    db.createEntrant({ tournament_id: t.id, event: EV,
      name: "選" + String(i).padStart(2, "0"), team: "ク" + (i % 7), furigana: "せ" + String(i).padStart(2, "0") });
  }
}
function setup(n) {
  const t = db.createTournament({ name: "layout" + n + "_" + Math.random().toString(36).slice(2, 6), date: "2027-08-01" });
  mkEntrants(t, n);
  const gen = db.generateBracket(t.id, EV, {});
  assert.ok(gen && !gen.error, "生成成功: " + JSON.stringify(gen).slice(0, 160));
  return t;
}
const exportMatches = (t) => db.exportBracket(t.id, EV).matches;

// 手組みの exportBracket 形式1試合(BYEや配線欠落のシナリオを自由に作るため)
let _mid = 0;
function mkMatch(round, pos, p1, p2) {
  return { id: "m" + (++_mid), bracket_round: round, bracket_pos: pos,
    player1_name: p1 || "", player1_team: p1 ? "T" : "", player1_entrant_id: null,
    player2_name: p2 || "", player2_team: p2 ? "T" : "", player2_entrant_id: null,
    next_match_id: null, next_slot: 1, status: "pending", match_no: pos + 1 };
}

test("S=8(BYEなし): ブロック数式・寸法・レール座標・罫線座標を数値で固定する", () => {
  const t = setup(8);
  const L = computeBracketLayout(exportMatches(t), { event: EV });
  assert.strictEqual(L.S, 8);
  assert.strictEqual(L.totalRounds, 3);
  assert.strictEqual(L.BL, 8);
  assert.strictEqual(L.nBlocks, 1);
  assert.strictEqual(L.blockRounds, 3);
  assert.strictEqual(L.sideR, 2);
  assert.strictEqual(L.isDbl, false);
  assert.strictEqual(L.ROW_H, 34);
  assert.strictEqual(L.RAIL_W, 230, "短い名前ではレール幅は下限230");
  assert.strictEqual(L.W, 230 * 2 + 2 * 44 * 2 + 150, "W=786");

  const blk = L.blocks[0];
  assert.strictEqual(L.blocks.length, 1);
  assert.strictEqual(blk.height, 10 + 4 * 34 + 10, "H=156(片側4行)");
  // レール: L側4(g=0..3)/R側4(g=4..7)、lineY=10+idx*34+25
  assert.strictEqual(blk.rails.length, 8);
  const lY = (idx) => 10 + idx * 34 + 34 - 9;
  blk.rails.filter(r => r.side === "L").forEach((r, i) => {
    assert.strictEqual(r.g, i); assert.strictEqual(r.lineY, lY(i));
  });
  blk.rails.filter(r => r.side === "R").forEach((r, i) => {
    assert.strictEqual(r.g, 4 + i); assert.strictEqual(r.lineY, lY(i));
  });
  // レール下線: L= x1:8..x2:230 / R= x1:556..x2:778
  const railSegs = blk.segments.filter(s => s.y1 === s.y2 && (s.x1 === 8 || s.x2 === 778));
  assert.strictEqual(railSegs.length, 8);
  assert.ok(railSegs.some(s => s.x1 === 8 && s.x2 === 230 && s.y1 === lY(0)));
  assert.ok(railSegs.some(s => s.x1 === 786 - 230 && s.x2 === 786 - 8 && s.y1 === lY(0)));

  // 1回戦join: L側 pos0 y=(35+69)/2=52, pos1 y=120 / R側 pos2 y=52, pos3 y=120
  const r1joins = blk.joins.filter(j => j.kind === "r1");
  assert.strictEqual(r1joins.length, 4);
  const jL0 = r1joins.find(j => (j.match.bracket_pos || 0) === 0);
  assert.deepStrictEqual({ y: jL0.y, xa: jL0.xa, xb: jL0.xb, side: jL0.anchorSide },
    { y: 52, xa: 230, xb: 274, side: "L" });
  assert.deepStrictEqual(jL0.handle, { x: 274, y: 52 });
  const jR3 = r1joins.find(j => (j.match.bracket_pos || 0) === 3);
  assert.deepStrictEqual({ y: jR3.y, xa: jR3.xa, xb: jR3.xb, side: jR3.anchorSide },
    { y: 120, xa: 786 - 274, xb: 786 - 230, side: "R" });
  // 1回戦の縦線(子2線を結ぶ): L pos0 = x=230, y 35..69
  assert.ok(blk.segments.some(s => s.x1 === 230 && s.x2 === 230 && s.y1 === 35 && s.y2 === 69));

  // 2回戦join: L x0=274..x2=318 y=(52+120)/2=86 / R x0=512..x2=468
  const midjoins = blk.joins.filter(j => j.kind === "mid");
  assert.strictEqual(midjoins.length, 2);
  const m2L = midjoins.find(j => j.anchorSide === "L");
  assert.deepStrictEqual({ y: m2L.y, xa: m2L.xa, xb: m2L.xb, hx: m2L.handle.x },
    { y: 86, xa: 274, xb: 318, hx: 318 });
  const m2R = midjoins.find(j => j.anchorSide === "R");
  assert.deepStrictEqual({ y: m2R.y, xa: m2R.xa, xb: m2R.xb, hx: m2R.handle.x },
    { y: 86, xa: 468, xb: 512, hx: 468 });

  // ブロック決勝(=決勝): xL=318..xR=468, cy=86, 太線2.5
  const bf = blk.joins.find(j => j.kind === "blockFinal");
  assert.deepStrictEqual({ y: bf.y, xa: bf.xa, xb: bf.xb, side: bf.anchorSide, ss: bf.ss },
    { y: 86, xa: 318, xb: 468, side: "C", ss: false });
  assert.ok(blk.segments.some(s => s.x1 === 318 && s.x2 === 468 && s.y1 === 86 && s.w === 2.5),
    "決勝線は太線2.5");
});

test("S=4: blockRounds=2でも1回戦join+ブロック決勝の構造が正しい", () => {
  const t = setup(4);
  const L = computeBracketLayout(exportMatches(t), { event: EV });
  assert.strictEqual(L.blockRounds, 2);
  assert.strictEqual(L.sideR, 1);
  const blk = L.blocks[0];
  // 1回戦join2つ(y=52)+ブロック決勝1つ(cy=52)
  assert.strictEqual(blk.joins.filter(j => j.kind === "r1").length, 2);
  const bf = blk.joins.find(j => j.kind === "blockFinal");
  assert.strictEqual(bf.y, 52);
  // W = 230*2 + 1*44*2 + 150 = 698, 決勝線 xL=274..xR=424
  assert.strictEqual(L.W, 698);
  assert.deepStrictEqual([bf.xa, bf.xb], [274, 424]);
});

test("BYEの長線: 片子は join を作らず延長し、deep>=2 の初joinがスーパーシード戦(ss:true)", () => {
  // 手組みS=16: リーフ0=SS選手(1回戦相手BYE→2回戦相手も両BYE→3回戦で初join=deep2)
  const ms = [];
  ms.push(mkMatch(1, 0, "SS選手", "BYE"));
  ms.push(mkMatch(1, 1, "BYE", "BYE"));
  for (let p = 2; p < 8; p++) ms.push(mkMatch(1, p, "選A" + p, "選B" + p));
  for (let p = 0; p < 4; p++) ms.push(mkMatch(2, p));
  for (let p = 0; p < 2; p++) ms.push(mkMatch(3, p));
  ms.push(mkMatch(4, 0));
  const wiring = synthesizeStandardWiring(ms);
  const L = computeBracketLayout(ms, { event: EV, wiring });
  assert.strictEqual(L.S, 16);
  const blk = L.blocks[0];
  // 通し番号はBYEを飛ばして連番(先頭リーフ=SS選手がNo.1、次の実選手はNo.2)
  assert.strictEqual(L.leaves[0].no, 1);
  assert.strictEqual(L.leaves[1], null, "BYE枠はnull");
  assert.strictEqual(L.leaves[4].no, 2, "BYEを except した連番");
  const serials = L.leaves.filter(Boolean).map(lf => lf.no);
  assert.deepStrictEqual(serials, serials.map((_, i) => i + 1), "通し番号は1..k");
  // 1回戦pos0は片子(join無し)、2回戦pos0も片子(join無し)
  assert.ok(!blk.joins.some(j => j.match.bracket_pos === 0 && j.match.bracket_round === 1));
  assert.ok(!blk.joins.some(j => j.match.bracket_pos === 0 && j.match.bracket_round === 2));
  // 3回戦pos0=初join: スーパーシード戦フラグ
  const ssJoin = blk.joins.find(j => j.match.bracket_round === 3 && j.match.bracket_pos === 0);
  assert.ok(ssJoin, "3回戦でjoinがある");
  assert.strictEqual(ssJoin.ss, true, "deep>=2の初join=スーパーシード戦");
  // 対照: 通常の2回戦join(pos1: 1回戦pos2,pos3の勝者同士)はss:false
  const normal = blk.joins.find(j => j.match.bracket_round === 2 && j.match.bracket_pos === 1);
  assert.strictEqual(normal.ss, false);
});

test("open種目S=16はＡ〜Ｄ4ブロックに割れ、各ブロックにブロック決勝joinを持つ", () => {
  const t = setup(16);
  const L = computeBracketLayout(exportMatches(t), { event: EV, open: true });
  assert.strictEqual(L.BL, 4);
  assert.strictEqual(L.nBlocks, 4);
  assert.strictEqual(L.blockRounds, 2);
  assert.strictEqual(L.blocks.length, 4);
  L.blocks.forEach((blk, b) => {
    assert.strictEqual(blk.index, b);
    assert.strictEqual(blk.rails.length, 4, "各ブロック4リーフ");
    const bf = blk.joins.find(j => j.kind === "blockFinal");
    assert.ok(bf, "ブロック" + b + "にブロック決勝join");
    assert.strictEqual(bf.match.bracket_round, 2);
    assert.strictEqual(bf.match.bracket_pos, b);
    // 複数ブロックのブロック決勝線は通常太さ1.5
    assert.ok(blk.segments.some(s => s.y1 === bf.y && s.y2 === bf.y && s.w === 1.5 && s.x1 === bf.xa && s.x2 === bf.xb));
  });
  // 対照: open=false なら1ブロック
  const L2 = computeBracketLayout(exportMatches(t), { event: EV, open: false });
  assert.strictEqual(L2.nBlocks, 1);
});

test("relink(自由配線)後: joinの縦線・中点yが実配線に追従する", () => {
  const t = setup(8);
  // 1回戦pos0の進出先を2回戦pos1のslot1へ付替(既存の1回戦pos2とswapされる)
  const all = () => db.getMatchesByTournament(t.id).filter(m => m.event === EV);
  const r1p0 = all().find(m => m.bracket_round === 1 && m.bracket_pos === 0);
  const r2p1 = all().find(m => m.bracket_round === 2 && m.bracket_pos === 1);
  const r = db.relinkBracketMatch(t.id, EV, r1p0.id, r2p1.id, 1, {});
  assert.ok(r && r.success, "relink成功: " + JSON.stringify(r));
  const L = computeBracketLayout(exportMatches(t), { event: EV });
  const blk = L.blocks[0];
  // 2回戦pos0のjoin: 元(52,120)→relink後は1回戦pos2(y=52,R側レール)と1回戦pos1(y=120,L側)
  // ※ Y座標は「そのブロックのレール行」基準なので、srcの2本のyの中点に必ず一致する
  const m2 = blk.joins.filter(j => j.kind === "mid");
  m2.forEach(j => {
    // 縦線: x0 で y1..y2 を結ぶsegmentが必ず存在し、jの中点=round((y1+y2)/2)
    const vert = blk.segments.find(s => s.x1 === s.x2 && (s.x1 === j.xa || s.x1 === j.xb) &&
      Math.round((s.y1 + s.y2) / 2) === j.y);
    assert.ok(vert, "join " + j.match.id + " の縦線が中点と整合");
  });
  // relinkは同回戦同士のswap=表全体のjoin数は不変
  assert.strictEqual(m2.length, 2);
  assert.strictEqual(blk.joins.filter(j => j.kind === "r1").length, 4);
});

test("synthesizeStandardWiring: 標準生成の実配線と同一グラフになり、レイアウトも完全一致する", () => {
  const t = setup(8);
  const real = exportMatches(t);
  // 配線を消したコピーに合成配線を当てる
  const stripped = real.map(m => ({ ...m, next_match_id: null, next_slot: 1 }));
  const wiring = synthesizeStandardWiring(stripped);
  real.forEach(m => {
    if (!m.next_match_id) return;   // 決勝は配線なし
    assert.ok(wiring[m.id], m.id + " の合成配線がある");
    assert.strictEqual(wiring[m.id].next_match_id, m.next_match_id, "同じ次戦");
    assert.strictEqual(wiring[m.id].next_slot, m.next_slot || 1, "同じslot");
  });
  const L1 = computeBracketLayout(real, { event: EV });
  const L2 = computeBracketLayout(stripped, { event: EV, wiring });
  assert.deepStrictEqual(
    L2.blocks.map(b => ({ h: b.height, segs: b.segments, joins: b.joins.map(j => ({ k: j.kind, y: j.y, xa: j.xa, xb: j.xb })) })),
    L1.blocks.map(b => ({ h: b.height, segs: b.segments, joins: b.joins.map(j => ({ k: j.kind, y: j.y, xa: j.xa, xb: j.xb })) })),
    "合成配線でも実配線と同一の幾何");
});

test("ダブルス種目: 2行レール寸法(ROW_H=42)と下限330が効く", () => {
  const EVD = "男子ダブルス";
  const t = db.createTournament({ name: "layoutD", date: "2027-08-02" });
  for (let i = 1; i <= 4; i++) {
    db.createEntrant({ tournament_id: t.id, event: EVD, name: "組" + i, team: "チーム" + i, furigana: "く" + i });
  }
  const gen = db.generateBracket(t.id, EVD, {});
  assert.ok(gen && !gen.error, JSON.stringify(gen).slice(0, 120));
  const L = computeBracketLayout(db.exportBracket(t.id, EVD).matches, { event: EVD });
  assert.strictEqual(L.isDbl, true);
  assert.strictEqual(L.ROW_H, 42);
  assert.strictEqual(L.RAIL_W, 330, "ダブルスのレール下限330");
});

test("leaf に entry_round が乗る(罫線ドラッグ=スーパーシード手動指定の土台)", () => {
  const t = setup(8);
  // 先頭選手を3回戦からのスーパーシードに(位置保持で再構築)
  const ms0 = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
    .sort((a, b) => a.bracket_pos - b.bracket_pos);
  const eid = ms0[0].player1_entrant_id;
  const r = db.setEntrantSeedRound(eid, 3, { force: true });
  assert.ok(!r.error, JSON.stringify(r).slice(0, 120));
  const bd = db.exportBracket(t.id, EV);
  // export に entry_round が乗る
  const r1 = bd.matches.filter(m => m.bracket_round === 1);
  assert.ok(r1.some(m => (m.player1_entry_round || 1) === 3 || (m.player2_entry_round || 1) === 3), "exportにentry_round=3が乗る");
  const L = computeBracketLayout(bd.matches, { event: EV });
  const ssLeaf = L.leaves.find(lf => lf && lf.entry_round === 3);
  assert.ok(ssLeaf, "leafにentry_round=3が伝播する");
  // 通常選手は entry_round=1
  assert.ok(L.leaves.filter(Boolean).every(lf => lf.entry_round >= 1), "全leafにentry_roundがある");
});

// ── linear(単一方向・1列) の幾何回帰(オーナー要望 2026-07-17: 管理画面のトーナメント表を1列化) ──
// 両山を廃し、全リーフを縦1列に積み、全ラウンドを右へ勝ち上げる。座標は
// RAIL_W=230/ADV_W=44/CENTER_W=150/ROW_H=34/PAD 10 から手計算。
test("linear S=8: 1ブロック・全リーフ縦1列・全ラウンド右方向・寸法を固定する", () => {
  const t = setup(8);
  const L = computeBracketLayout(exportMatches(t), { event: EV, linear: true });
  assert.strictEqual(L.S, 8);
  assert.strictEqual(L.totalRounds, 3);
  assert.strictEqual(L.nBlocks, 1, "linearは常に1ブロック(全員を1列)");
  assert.strictEqual(L.BL, 8);
  assert.strictEqual(L.RAIL_W, 230, "短い名前ではレール幅は下限230");
  assert.strictEqual(L.W, 230 + 3 * 44 + 150, "W=RAIL_W + totalRounds*ADV_W + CENTER_W = 512");

  assert.strictEqual(L.blocks.length, 1);
  const blk = L.blocks[0];
  assert.strictEqual(blk.height, 10 + 8 * 34 + 10, "高さ=PAD_T + 8*ROW_H + PAD_B = 292(左右分割せず実人数分)");
  assert.strictEqual(blk.rails.length, 8, "8リーフ全部");
  assert.ok(blk.rails.every(r => r.side === "L"), "全レールが左(side=L)=1列");
  // リーフは 0,1,2..7 の順に縦へ(y0が単調増加)
  const ys = blk.rails.map(r => r.y0);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], "リーフy0が縦に単調増加");
  // レール下線は全て左端(x1=8 -> x2=RAIL_W)
  const railUnders = blk.segments.filter(s => s.x1 === 8);
  assert.strictEqual(railUnders.length, 8, "レール下線8本すべて左端始まり");
  assert.ok(railUnders.every(s => s.x2 === 230), "レール下線は x=8→230");
  // 決勝(blockFinal)は右への合流=anchorSide:"L"(両山の中央"C"ではない)
  const bf = blk.joins.find(j => j.kind === "blockFinal");
  assert.ok(bf, "blockFinal join がある");
  assert.strictEqual(bf.anchorSide, "L", "linearの決勝は右合流(anchorSide=L)");
  // 決勝の右端 xb = RAIL_W + totalRounds*ADV_W = 230+132=362
  assert.strictEqual(bf.xb, 230 + 3 * 44, "決勝線の右端=362");
});

test("linear: 両山(既定)とは別物=同じデータでW/高さ/side分布が変わる", () => {
  const t = setup(8);
  const ms = exportMatches(t);
  const lin = computeBracketLayout(ms, { event: EV, linear: true });
  const two = computeBracketLayout(ms, { event: EV });
  assert.notStrictEqual(lin.W, two.W, "幅が異なる(1列は中央決勝ぶん狭い/縦長)");
  // 両山は L4本/R4本、1列は L8本
  const twoSides = new Set(two.blocks[0].rails.map(r => r.side));
  assert.strictEqual(twoSides.size, 2, "両山はL/R両方");
  const linSides = new Set(lin.blocks[0].rails.map(r => r.side));
  assert.strictEqual(linSides.size, 1, "1列はLのみ");
  assert.ok(lin.blocks[0].height > two.blocks[0].height, "1列は縦に長い(左右分割しないため)");
});

test("linear S=16: 全16リーフが1列・4ラウンドを右へ", () => {
  const t = setup(16);
  const L = computeBracketLayout(exportMatches(t), { event: EV, linear: true });
  assert.strictEqual(L.S, 16);
  assert.strictEqual(L.totalRounds, 4);
  assert.strictEqual(L.nBlocks, 1);
  assert.strictEqual(L.blocks[0].rails.length, 16, "16リーフ全部1列");
  assert.ok(L.blocks[0].rails.every(r => r.side === "L"));
  assert.strictEqual(L.blocks[0].height, 10 + 16 * 34 + 10, "高さ=PAD_T+16*ROW_H+PAD_B");
  const bf = L.blocks[0].joins.find(j => j.kind === "blockFinal");
  assert.strictEqual(bf.xb, 230 + 4 * 44, "決勝右端=RAIL_W+4*ADV_W");
});
