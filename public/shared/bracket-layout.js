// 両山トーナメント表のレイアウト計算層 — admin(編集SVG) / viewer(読み取りSVG) 共用。
// renderPaperBracket(admin)の幾何計算部を機械的に抽出したもの(2026-07-16・座標式は不変)。
// 罫線は next_match_id/next_slot という実配線(データ)を辿って組み立てる=位置演算ではないため、
// 自由配線編集(relinkBracketMatch)後もこの計算だけで正しい山になる。
// 純関数のみ(window/document 非参照)。Node からは require、ブラウザは global.TTBracketLayout。
// ※ ここを変える場合は test/bracket-layout.test.js の幾何回帰を必ず通すこと。
(function (global) {
  "use strict";

  // 全角=フォントpx・半角=0.55px換算の簡易テキスト幅(レール幅の自動算出用)
  function estW(s, px) {
    let w = 0;
    for (const ch of String(s || "")) w += ch.charCodeAt(0) > 0xFF ? px : px * 0.55;
    return w;
  }

  // 標準シングルエリミの配線を bracket_pos から合成する(next_match_id 欠落データの縮退経路)。
  // matches を書き換えず、{ "matchId": {next_match_id, next_slot} } の上書きマップを返す。
  // generateBracket の機械生成配線(位置式: pos p の次戦 = 次回戦の floor(p/2)、slot = p%2+1)と同一。
  function synthesizeStandardWiring(matches) {
    const byRP = {};
    let maxRound = 1;
    (matches || []).forEach(m => {
      const r = m.bracket_round || 1;
      byRP[r + "_" + (m.bracket_pos || 0)] = m;
      if (r > maxRound) maxRound = r;
    });
    const out = {};
    (matches || []).forEach(m => {
      const r = m.bracket_round || 1;
      if (r >= maxRound) return;
      const pos = m.bracket_pos || 0;
      const nx = byRP[(r + 1) + "_" + Math.floor(pos / 2)];
      if (nx) out[m.id] = { next_match_id: nx.id, next_slot: (pos % 2) + 1 };
    });
    return out;
  }

  // メイン: 試合配列(exportBracket形式: bracket_round/bracket_pos/next_match_id/next_slot/
  // player1_name...)から、描画非依存の幾何データを返す。
  // opts: { open:bool(SS大会=Ａ〜Ｄ4ブロック), event:string(ダブルス/団体判定),
  //         wiring: synthesizeStandardWiring の戻り値(欠落補完・省略可) }
  // 戻り値の座標系は admin/viewer 共通(px)。呼び出し側はこの segments/joins/rails を描くだけ。
  function computeBracketLayout(matches, opts) {
    opts = opts || {};
    matches = matches || [];
    const event = opts.event || "";
    const wiring = opts.wiring || null;
    const nextOf = (m) => {
      if (wiring && wiring[m.id]) return wiring[m.id];
      return { next_match_id: m.next_match_id, next_slot: m.next_slot };
    };

    const round1 = matches.filter(m => (m.bracket_round || 1) === 1)
      .sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
    const S = round1.length * 2;
    if (!S) return null;
    const totalRounds = Math.max(1, Math.round(Math.log2(S)));
    // SS大会(open種目)はＡ〜Ｄ4ブロック固定(抽選と同じ)。それ以外は128リーフ=1ブロック。
    const BL = (opts.open && S >= 16) ? S / 4 : (S >= 256 ? 128 : S);
    const nBlocks = S / BL;
    const blockRounds = Math.max(1, Math.round(Math.log2(BL)));
    const sideR = Math.max(0, blockRounds - 1);

    // 「試合Xのslot(1|2)へ進出してくるのはどの試合か」の逆引き(自由配線編集後も正しい)
    const incoming = new Map();
    matches.forEach(m => {
      const nx = nextOf(m);
      if (nx.next_match_id) incoming.set(nx.next_match_id + ":" + (nx.next_slot || 1), m);
    });

    // リーフ配列(BYE=null)と通し番号(BYEを除く連番=紙・Excelと同じ定義)
    const leaves = new Array(S).fill(null);
    round1.forEach(m => {
      const p = m.bracket_pos || 0;
      [[1, m.player1_name, m.player1_team, m.player1_entrant_id],
       [2, m.player2_name, m.player2_team, m.player2_entrant_id]].forEach(([sk, nm, tm, eid]) => {
        if (nm && nm !== "BYE") leaves[2 * p + (sk - 1)] = { name: nm, team: tm || "", eid, pos: p, slot: sk };
      });
    });
    { let serial = 0; leaves.forEach(lf => { if (lf) lf.no = ++serial; }); }

    // 寸法(px): レール幅は最長の氏名/所属から自動算出(見切れゼロ)。式は admin 実装と同一。
    const isDbl = /ダブルス|団体/.test(event);
    let railNeed = 0;
    leaves.forEach(lf => {
      if (!lf) return;
      const w = isDbl ? Math.max(estW(lf.name, 12.5) + 40, estW(lf.team, 10.5) + 46)
                      : estW(lf.name, 13) + estW(lf.team, 10.5) + 56;
      if (w > railNeed) railNeed = w;
    });
    const ROW_H = isDbl ? 42 : 34, ADV_W = 44, CENTER_W = 150, PAD_T = 10, PAD_B = 10;
    const RAIL_W = Math.min(480, Math.max(isDbl ? 330 : 230, Math.ceil(railNeed)));
    const W = RAIL_W * 2 + sideR * ADV_W * 2 + CENTER_W;

    // ブロックごとの幾何(rails / segments / joins)
    const blocks = [];
    for (let b = 0; b < nBlocks; b++) {
      const rails = [];
      const segments = [];   // { x1, y1, x2, y2, w } 罫線(レール下線含む)
      const joins = [];      // { match, kind:'r1'|'mid'|'blockFinal', x?, y, xa, xb, anchorSide, ss, handle? }
      let li = 0, ri = 0;
      for (let g = b * BL; g < b * BL + BL / 2; g++) {
        if (leaves[g]) rails.push({ g, side: "L", y0: PAD_T + li * ROW_H, lineY: PAD_T + li * ROW_H + ROW_H - 9, leaf: leaves[g] }), li++;
      }
      for (let g = b * BL + BL / 2; g < (b + 1) * BL; g++) {
        if (leaves[g]) rails.push({ g, side: "R", y0: PAD_T + ri * ROW_H, lineY: PAD_T + ri * ROW_H + ROW_H - 9, leaf: leaves[g] }), ri++;
      }
      const height = PAD_T + Math.max(li, ri, 1) * ROW_H + PAD_B;
      // レール下線
      rails.forEach(r => {
        const isL = r.side === "L";
        segments.push({ x1: isL ? 8 : W - RAIL_W, y1: r.lineY, x2: isL ? RAIL_W : W - 8, y2: r.lineY, w: 1.5 });
      });

      const railY = new Map();
      rails.forEach(rr => railY.set(rr.g, rr.lineY));
      const matchState = new Map();   // matchId -> {y, deep} | null
      const r1lo = b * BL / 2, r1hi = (b + 1) * BL / 2;
      // 1回戦(LADV(1)/RADV(1)列)。blockRounds===1 はこの列自体が無い(中央joinの特別扱いへ)。
      matches.forEach(m => {
        if ((m.bracket_round || 1) !== 1) return;
        const p = m.bracket_pos || 0;
        if (p < r1lo || p >= r1hi) return;
        const y1 = railY.has(2 * p) ? railY.get(2 * p) : null;
        const y2 = railY.has(2 * p + 1) ? railY.get(2 * p + 1) : null;
        let state = null;
        if (y1 != null && y2 != null) state = { y: Math.round((y1 + y2) / 2), deep: 0 };
        else if (y1 != null || y2 != null) state = { y: y1 != null ? y1 : y2, deep: 1 };
        matchState.set(m.id, state);
        if (!state || sideR < 1) return;
        const side = (p - r1lo) < BL / 4 ? "L" : "R";
        const x0 = side === "L" ? RAIL_W : W - RAIL_W, x2 = side === "L" ? x0 + ADV_W : x0 - ADV_W;
        if (y1 != null && y2 != null) {
          segments.push({ x1: x0, y1: y1, x2: x0, y2: y2, w: 1.5 });
          segments.push({ x1: Math.min(x0, x2), y1: state.y, x2: Math.max(x0, x2), y2: state.y, w: 1.5 });
          joins.push({ match: m, kind: "r1", y: state.y, xa: Math.min(x0, x2), xb: Math.max(x0, x2),
            anchorSide: side, ss: false, handle: { x: x2, y: state.y } });
        } else {
          segments.push({ x1: Math.min(x0, x2), y1: state.y, x2: Math.max(x0, x2), y2: state.y, w: 1.5 });
        }
      });
      // 2回戦〜ブロック準決勝: 回戦昇順に incoming を逆引き(「回戦前進」不変条件で入力が必ず揃う)
      for (let r = 2; r < blockRounds; r++) {
        const perBlock = BL / Math.pow(2, r), half = perBlock / 2, base = b * perBlock;
        const colOf = (side) => side === "L" ? RAIL_W + (r - 1) * ADV_W : W - RAIL_W - (r - 1) * ADV_W;
        matches.filter(m => (m.bracket_round || 1) === r && (m.bracket_pos || 0) >= base && (m.bracket_pos || 0) < base + perBlock)
          .forEach(m => {
            const pos = m.bracket_pos || 0;
            const side = (pos - base) < half ? "L" : "R";
            const x0 = colOf(side), x2 = side === "L" ? x0 + ADV_W : x0 - ADV_W;
            const src1 = incoming.get(m.id + ":1"), src2 = incoming.get(m.id + ":2");
            const a = src1 ? matchState.get(src1.id) : null, bb = src2 ? matchState.get(src2.id) : null;
            if (a != null && bb != null) {
              const y = Math.round((a.y + bb.y) / 2);
              segments.push({ x1: x0, y1: a.y, x2: x0, y2: bb.y, w: 1.5 });
              segments.push({ x1: Math.min(x0, x2), y1: y, x2: Math.max(x0, x2), y2: y, w: 1.5 });
              joins.push({ match: m, kind: "mid", y, xa: Math.min(x0, x2), xb: Math.max(x0, x2),
                anchorSide: side, ss: (a.deep >= 2 || bb.deep >= 2), handle: { x: x2, y } });
              matchState.set(m.id, { y, deep: 0 });
            } else if (a != null || bb != null) {
              const v = a != null ? a : bb;
              segments.push({ x1: Math.min(x0, x2), y1: v.y, x2: Math.max(x0, x2), y2: v.y, w: 1.5 });
              matchState.set(m.id, { y: v.y, deep: v.deep + 1 });
            } else matchState.set(m.id, null);
          });
      }
      // ブロック決勝(1ブロック時=決勝線・複数ブロック時=ブロック勝者線)。中央 xL〜xR。
      const xL = RAIL_W + sideR * ADV_W, xR = W - RAIL_W - sideR * ADV_W;
      const blockFinalM = matches.find(m => (m.bracket_round || 1) === blockRounds && (m.bracket_pos || 0) === b);
      if (blockFinalM) {
        let aL, aR;
        if (blockRounds === 1) {
          // 1回戦の唯一の試合=ブロック決勝そのもの。V字合流のため生のリーフY座標を使う。
          const p = blockFinalM.bracket_pos || 0;
          const y1 = railY.has(2 * p) ? railY.get(2 * p) : null;
          const y2 = railY.has(2 * p + 1) ? railY.get(2 * p + 1) : null;
          aL = y1 != null ? { y: y1, deep: 0 } : null;
          aR = y2 != null ? { y: y2, deep: 0 } : null;
        } else {
          const src1 = incoming.get(blockFinalM.id + ":1"), src2 = incoming.get(blockFinalM.id + ":2");
          aL = src1 ? matchState.get(src1.id) : null;
          aR = src2 ? matchState.get(src2.id) : null;
        }
        if (aL != null || aR != null) {
          const cy = (aL != null && aR != null) ? Math.round((aL.y + aR.y) / 2) : (aL != null ? aL.y : aR.y);
          segments.push({ x1: xL, y1: cy, x2: xR, y2: cy, w: nBlocks === 1 ? 2.5 : 1.5 });
          if (aL != null && aL.y !== cy) segments.push({ x1: xL, y1: Math.min(aL.y, cy), x2: xL, y2: Math.max(aL.y, cy), w: 1.5 });
          if (aR != null && aR.y !== cy) segments.push({ x1: xR, y1: Math.min(aR.y, cy), x2: xR, y2: Math.max(aR.y, cy), w: 1.5 });
          joins.push({ match: blockFinalM, kind: "blockFinal", y: cy, xa: xL, xb: xR, anchorSide: "C",
            ss: (aL != null && aL.deep >= 2) || (aR != null && aR.deep >= 2) });
        }
      }
      blocks.push({ index: b, height, rails, segments, joins });
    }

    return {
      S, totalRounds, BL, nBlocks, blockRounds, sideR,
      isDbl, ROW_H, ADV_W, CENTER_W, PAD_T, PAD_B, RAIL_W, W,
      leaves, incoming, blocks,
    };
  }

  const API = { computeBracketLayout, synthesizeStandardWiring, estW };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else global.TTBracketLayout = API;
})(typeof window !== "undefined" ? window : globalThis);
