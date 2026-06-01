#!/usr/bin/env node
/**
 * KTTA 標準 Excel 組合せ表パーサー (Node.js / SheetJS) v3
 * =====================================================
 * 複数のパターンに対応:
 *   1. 会長杯型 (○種目 + 単一ブラケット)
 *   2. VICTAS杯型 (1シートに A/B/C/D ブロック parallel 配置)
 *   3. チームカップ型 (4 parallel team brackets + 選手名簿)
 *   4. 重複管理型 (二重 position 列)
 *   5. 年代別型 (シート内に複数カテゴリ)
 *
 * v3 アルゴリズム:
 *   ① シート内の全テキストセルを取得
 *   ② セクションヘッダー候補を検出 (○種目, Xブロック, 男子/女子+シングルス等)
 *   ③ 各ヘッダーから「BOUNDING REGION」(rows, cols) を推定
 *   ④ Region 内の整数セル (位置番号) を X 座標でクラスタリング
 *   ⑤ 各クラスタ (LEFT/RIGHT/middle) から選手を抽出
 *   ⑥ 種目名+ブロック名でユニーク event 名を構築
 *
 * Usage:
 *   node parse_ktta_bracket.js FILE.xlsx [--format singles|doubles|team]
 *                                         [--sheet NAME]
 *                                         [--all-sheets]
 *                                         [-v]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// 宣言上の !ref はアップロード側が巨大値(A1:XFD1048576 等)を仕込め、そのまま二重ループすると
// 数百億セルの空走査でイベントループが固まる (#8 DoS)。実際に値を持つセルの範囲にクランプして走査する。
function safeRange(ws) {
  const declared = (ws && ws['!ref']) ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
  let maxR = -1, maxC = -1;
  for (const k in ws) {
    if (k[0] === '!') continue;
    const cell = XLSX.utils.decode_cell(k);
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c > maxC) maxC = cell.c;
  }
  const HARD_R = 20000, HARD_C = 512;   // 実データ範囲が異常に大きい場合の保険上限
  return {
    s: declared.s,
    e: {
      r: Math.min(declared.e.r, maxR, declared.s.r + HARD_R),
      c: Math.min(declared.e.c, maxC, declared.s.c + HARD_C),
    },
  };
}

// ─── 設定 ─────────────────────────────────
const TEAM_KEYWORDS = ['団体', 'チーム', 'チームカップ', 'ダブルスチーム'];
const DOUBLES_KEYWORDS = ['ダブルス', 'ミックス', '混合', 'ペア'];
// セクションヘッダー検出パターン (複数対応)
//   - "○種目名"
//   - "種目 Aブロック"
//   - "種目（30歳代）"
//   - "男子シングルス" のようなキーワード単独 (フォールバック)
const SECTION_REGEXES = [
  /^\s*[○◯◎●]\s*(.+?)\s*$/,                                   // ○種目
  /^(.+?(?:シングルス|ダブルス|団体|団体戦|混合|チームカップ|ペア).*?)\s*$/,  // 種目キーワード含む
];
const BLOCK_RE = /\s*([ＡＢＣＤＥＦＧＨＩＪＫABCDEFGHIJK])\s*ブロック\s*$/;
const LABELS = new Set([
  '氏名', '所属', '選手名', '団体名', 'チーム名', 'メンバー',
  '代表者', '選手', 'ペア', 'ダブルス', 'シングルス',
  '決勝', '準決勝', '準々決勝', 'ベスト16', 'ベスト32',
  '相互審判', '審判', '初戦', '勝敗', '順位',
  'BYE', 'bye', '不戦勝', '棄権', '①', '②', '③', '④', '⑤',
  '【選手名簿】', '名簿', '①勝', '②勝', '③勝',
]);
const PARENS_RE = /^[(（]\s*(.*?)\s*[)）]$/;
const KNOWN_REGIONS = new Set([
  '釧路', '十勝', '北見', '札幌', '千歳', '苫小牧', '根室', '斜里',
  '名寄', '旭川', '函館', '帯広', '石狩', '美幌', '中標津',
  '釧路支部', '札幌支部', '十勝支部', '根室支部',
]);
const TEAM_SUFFIX_RE = /(中学校?|高校|高等学校|小学校?|大学|TTC|TTスタジオ|スポーツ|クラブ|協会|市役所|アスティーダ|JFY|団|サークル|連盟|個人|TTA\.C|TTA|T-Union|連)$/;

// ─── ユーティリティ ────────────────────────
function detectFormat(eventName, hint) {
  if (['singles', 'doubles', 'team'].includes(hint)) return hint;
  if (eventName) {
    if (TEAM_KEYWORDS.some(k => eventName.includes(k))) return 'team';
    if (DOUBLES_KEYWORDS.some(k => eventName.includes(k))) return 'doubles';
  }
  return 'singles';
}

function stripParens(s) {
  if (s == null) return '';
  const str = String(s).trim();
  const m = PARENS_RE.exec(str);
  return m ? m[1] : str;
}

function normalizeName(s) {
  if (s == null) return '';
  let str = String(s).trim();
  str = str.replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
  str = str.replace(/(君|くん|さん|ちゃん|選手|様)$/, '').trim();
  return str;
}

function isLabelLike(s) {
  if (!s) return true;
  const str = String(s).trim();
  if (LABELS.has(str)) return true;
  if (/^[※★●◯○・■□]/.test(str)) return true;
  if (/^(①|②|③|④|⑤|⑥)$/.test(str)) return true;
  return false;
}

function isPositionNumber(v) {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= 999;
  const s = String(v).trim();
  return /^\d{1,3}$/.test(s);
}

function looksLikeName(s) {
  const str = String(s || '').trim();
  if (!str || str.length < 2 || str.length > 20) return false;
  if (isLabelLike(str)) return false;
  if (KNOWN_REGIONS.has(str)) return false;
  if (PARENS_RE.test(str)) return false;
  if (TEAM_SUFFIX_RE.test(str)) return false;
  if (/^\d+$/.test(str)) return false;
  if (!/[ぁ-んァ-ヶー一-龯々]/.test(str)) return false;
  return true;
}

function looksLikeTeam(s) {
  const str = String(s || '').trim();
  if (!str) return false;
  if (PARENS_RE.test(str)) return true;
  if (TEAM_SUFFIX_RE.test(str)) return true;
  return false;
}

// ─── セル/merged アクセス ───────────────────
function getMergedValue(ws, row, col, merges) {
  const addr = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = ws[addr];
  if (cell && cell.v != null && cell.v !== '') return cell.v;
  for (const mr of merges) {
    if (mr.s.r <= row && row <= mr.e.r && mr.s.c <= col && col <= mr.e.c) {
      const topAddr = XLSX.utils.encode_cell({ r: mr.s.r, c: mr.s.c });
      const top = ws[topAddr];
      return top && top.v != null ? top.v : null;
    }
  }
  return null;
}

function isTopOfMerge(row, col, merges) {
  for (const mr of merges) {
    if (mr.s.r <= row && row <= mr.e.r && mr.s.c <= col && col <= mr.e.c) {
      return row === mr.s.r;
    }
  }
  return true;
}

// ─── セクションヘッダー検出 ─────────────────
// 1 シート内の全 ○ / ブロック / 種目キーワードを含むセルを抽出
function findHeaderCandidates(ws) {
  const range = safeRange(ws);
  const headers = [];
  for (let r = 0; r <= range.e.r; r++) {
    for (let c = 0; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell || cell.v == null) continue;
      const s = String(cell.v).trim();
      if (s.length < 3 || s.length > 50) continue;
      // ヘッダー判定
      let matched = false;
      let cleanName = s;
      // ○ で始まる
      let m = SECTION_REGEXES[0].exec(s);
      if (m) { matched = true; cleanName = m[1].trim(); }
      // 種目キーワード含む (シングルス/ダブルス/団体/混合 等)
      if (!matched && /(シングルス|ダブルス|団体戦|団体|混合ダブルス|混合|ミックスダブルス|ミックス|チームカップ|ペア)/.test(s)) {
        // 除外: ラベルや指示文
        if (s.includes('入力') || s.includes('注意') || s.includes('説明') || s.includes('連続')) continue;
        // 除外: 列ヘッダー ("ダブルスNo," 等)
        if (/No[,.、]/.test(s) || /^.{1,10}No[,.、]?$/.test(s)) continue;
        // 「【...】」は重複管理ラベル → 中身を取り出す
        cleanName = s.replace(/【.*?】/g, '').trim();
        if (!cleanName) cleanName = s;
        matched = true;
      }
      if (matched) {
        // ブロック判定
        const bm = BLOCK_RE.exec(cleanName);
        const block = bm ? bm[1].normalize('NFKC').toUpperCase() : null;
        headers.push({ r, c, raw: s, event: cleanName, block });
      }
    }
  }
  return headers;
}

// ─── 位置番号クラスタ検出 (1 つの BOUNDING REGION 内) ───
// region: { rMin, rMax, cMin, cMax }
// 戻り値: [{ x, positions: [{r, c, value}] }, ...]
function findPositionClusters(ws, region, merges) {
  const intCells = [];
  for (let r = region.rMin; r <= region.rMax; r++) {
    for (let c = region.cMin; c <= region.cMax; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v == null) continue;
      if (!isPositionNumber(cell.v)) continue;
      // merged の最上行のみ拾う (重複防止)
      if (!isTopOfMerge(r, c, merges)) continue;
      intCells.push({ r, c, value: parseInt(cell.v) });
    }
  }
  if (intCells.length < 4) return [];

  // X 座標 (col) でクラスタリング
  const byCol = {};
  intCells.forEach(it => {
    byCol[it.c] = (byCol[it.c] || []).concat([it]);
  });
  // 各列に何個 int があるかで「位置番号列」を判定
  // ※ 名簿列 (1..N の連番) と区別するため: 位置番号列は VERTICAL ALIGNMENT を持つ
  const cols = Object.keys(byCol).map(Number).sort((a, b) => a - b);
  // 「最低 4 個の int が同じ列に並んでいる」かつ「行間隔が一定」
  // 名簿リスト (毎行 1, 2, 3, ...) を除外するため median >= 2 を要求
  // 但し、ダブルス2段表示などは row gap=1 の場合あり → 値が小さいほうの「セパレーションスタイル」で判定
  const validCols = cols.filter(c => {
    const arr = byCol[c];
    if (arr.length < 4) return false;
    arr.sort((a, b) => a.r - b.r);
    const gaps = [];
    for (let i = 1; i < arr.length; i++) gaps.push(arr[i].r - arr[i - 1].r);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    // median 1: 名簿の可能性 → 値が連番 (1,2,3,...) で開始するなら除外
    if (median === 1) {
      // 値の差を見て連番か判定
      const vals = arr.map(it => it.value);
      let consecutive = true;
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] - vals[i - 1] !== 1) { consecutive = false; break; }
      }
      if (consecutive && vals.length >= 5) return false; // 連番リスト
    }
    return median >= 1 && median <= 8;
  });

  // 各「位置番号列」を 1 クラスタとする
  return validCols.map(c => ({
    x: c,
    positions: byCol[c],
  }));
}

// ─── 1 位置番号の周辺から名前+所属を取得 ─────
// side: 'L' = posCell の右側を取得, 'R' = posCell の左側を取得
// (バウンディング region 内で隣接列を探索)
function collectPlayerNear(ws, posItem, side, region, merges, opts) {
  opts = opts || {};
  const yWindow = opts.yWindow || 4;
  const xWindow = opts.xWindow || 10;
  const minY = Math.max(region.rMin, posItem.r - yWindow);
  const maxY = Math.min(region.rMax, posItem.r + yWindow);
  let minX, maxX;
  if (side === 'L') {
    minX = posItem.c + 1;
    maxX = Math.min(region.cMax, posItem.c + xWindow);
  } else {
    minX = Math.max(region.cMin, posItem.c - xWindow);
    maxX = posItem.c - 1;
  }
  const items = [];
  for (let r = minY; r <= maxY; r++) {
    for (let c = minX; c <= maxX; c++) {
      const v = getMergedValue(ws, r, c, merges);
      if (v == null || v === '') continue;
      const s = String(v).trim();
      if (!s) continue;
      // merged の最上行のみ
      if (!isTopOfMerge(r, c, merges)) continue;
      items.push({ r, c, v: s });
    }
  }
  return items;
}

// ─── BOUNDING REGION 推定 ────────────────
// ヘッダー行から次のセクションヘッダー or シート末まで
function inferRegion(ws, header, allHeaders) {
  const range = safeRange(ws);
  const sameRowHeaders = allHeaders.filter(h => h.r === header.r);
  sameRowHeaders.sort((a, b) => a.c - b.c);
  const idxInRow = sameRowHeaders.findIndex(h => h === header);

  // 行範囲: このヘッダーの次の (より大きい行の) ヘッダー or シート末まで
  const nextRowHeader = allHeaders.find(h => h.r > header.r);
  const rMax = nextRowHeader ? nextRowHeader.r - 1 : range.e.r;

  // 列範囲: 同じ行に複数ヘッダーあれば隣接ヘッダーまで
  //   末尾ヘッダーの場合: 平均ブロック幅で推定 (= 他ブロックの col 間隔)
  let cMax;
  if (idxInRow >= 0 && idxInRow < sameRowHeaders.length - 1) {
    cMax = sameRowHeaders[idxInRow + 1].c - 1;
  } else if (sameRowHeaders.length >= 2) {
    // 他に同行ヘッダーあり → 平均幅を使用
    const gaps = [];
    for (let i = 1; i < sameRowHeaders.length; i++) {
      gaps.push(sameRowHeaders[i].c - sameRowHeaders[i - 1].c);
    }
    const avgWidth = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    cMax = Math.min(range.e.c, header.c + avgWidth - 1);
  } else {
    cMax = range.e.c;
  }
  return { rMin: header.r + 1, rMax, cMin: header.c, cMax };
}

// ─── シングルス選手抽出 (1 クラスタから) ─────
function extractSinglesFromCluster(ws, cluster, region, merges, opts) {
  opts = opts || {};
  const players = [];
  cluster.positions.forEach(pos => {
    // どちら側に名前があるか? まず右側を試す。なければ左側。
    let near = collectPlayerNear(ws, pos, 'L', region, merges, { yWindow: 2, xWindow: 6 });
    let nameCand = near.filter(it => looksLikeName(it.v));
    let teamCand = near.filter(it => looksLikeTeam(it.v));
    if (!nameCand.length) {
      // 左側を試す (右端寄りの位置番号)
      near = collectPlayerNear(ws, pos, 'R', region, merges, { yWindow: 2, xWindow: 6 });
      nameCand = near.filter(it => looksLikeName(it.v));
      teamCand = near.filter(it => looksLikeTeam(it.v));
    }
    if (!nameCand.length) return;
    // 位置番号と同じ Y バンドに近いものを優先
    nameCand.sort((a, b) => Math.abs(a.r - pos.r) - Math.abs(b.r - pos.r));
    teamCand.sort((a, b) => Math.abs(a.r - pos.r) - Math.abs(b.r - pos.r));
    const name = normalizeName(nameCand[0].v);
    const team = teamCand.length ? stripParens(teamCand[0].v) : '';
    players.push({ name, team, seed: pos.value });
  });
  return players;
}

// ─── ダブルス選手抽出 (1 クラスタから) ─────
function extractDoublesFromCluster(ws, cluster, region, merges, opts) {
  opts = opts || {};
  const players = [];
  cluster.positions.forEach(pos => {
    // 周辺で 2 名 + 1 チーム取る
    let near = collectPlayerNear(ws, pos, 'L', region, merges, { yWindow: 3, xWindow: 8 });
    let nameCand = near.filter(it => looksLikeName(it.v));
    let teamCand = near.filter(it => looksLikeTeam(it.v));
    if (nameCand.length < 1) {
      near = collectPlayerNear(ws, pos, 'R', region, merges, { yWindow: 3, xWindow: 8 });
      nameCand = near.filter(it => looksLikeName(it.v));
      teamCand = near.filter(it => looksLikeTeam(it.v));
    }
    if (!nameCand.length) return;
    nameCand.sort((a, b) => Math.abs(a.r - pos.r) - Math.abs(b.r - pos.r));
    teamCand.sort((a, b) => Math.abs(a.r - pos.r) - Math.abs(b.r - pos.r));
    const n1 = normalizeName(nameCand[0].v);
    const n2 = nameCand[1] ? normalizeName(nameCand[1].v) : '';
    const team = teamCand.length ? stripParens(teamCand[0].v) : '';
    // ペアは name(選手1) と partner_name(選手2) を分離 → 2名とも個別DB連携可能に
    const member1 = n1 || n2;
    const member2 = (n1 && n2 && n1 !== n2) ? n2 : '';
    if (member1 && !isLabelLike(member1)) {
      players.push({
        name: member1,
        partner_name: member2,
        team,
        partner_team: team, // 同チーム既定 (別チームは取込後に編集可)
        is_doubles: true, seed: pos.value,
      });
    }
  });
  return players;
}

// ─── 団体戦選手抽出 (1 クラスタから = 1 ブラケット内のチーム群) ─────
function extractTeamFromCluster(ws, cluster, region, merges, opts) {
  opts = opts || {};
  const teams = [];
  cluster.positions.forEach(pos => {
    // チーム名 (右側 or 左側) を取得
    let near = collectPlayerNear(ws, pos, 'L', region, merges, { yWindow: 5, xWindow: 6 });
    let teamCand = near.filter(it => looksLikeTeam(it.v) ||
      (it.v.length <= 16 && /学校|クラブ|TTC|チーム|協会|スポーツ|市役所|高校|大学|工業|教育|個人|TTA/.test(it.v)));
    if (!teamCand.length) {
      near = collectPlayerNear(ws, pos, 'R', region, merges, { yWindow: 5, xWindow: 6 });
      teamCand = near.filter(it => looksLikeTeam(it.v));
    }
    teamCand.sort((a, b) => Math.abs(a.r - pos.r) - Math.abs(b.r - pos.r));
    const teamName = teamCand.length ? stripParens(teamCand[0].v) : null;
    // 名前 (= メンバー) 候補
    const memberCands = near.filter(it => looksLikeName(it.v));
    const members = [];
    memberCands.forEach(it => {
      const nm = normalizeName(it.v);
      if (nm && !members.includes(nm)) members.push(nm);
    });
    const displayName = teamName || ('チーム#' + pos.value);
    if (!teamName && !members.length) return;
    teams.push({
      name: displayName, team: displayName, seed: pos.value,
      is_team: true, members,
    });
  });
  return teams;
}

// ─── 1 ヘッダー (= 1 セクション/ブロック) を処理 ─────
function processHeader(ws, header, allHeaders, formatHint, merges, verbose) {
  let region = inferRegion(ws, header, allHeaders);
  let clusters = findPositionClusters(ws, region, merges);
  // クラスタの実際の rMax から region を絞り込む (下方の noise を除外)
  if (clusters.length) {
    let actualRMax = 0;
    clusters.forEach(cl => {
      cl.positions.forEach(p => { if (p.r > actualRMax) actualRMax = p.r; });
    });
    // 位置番号の最下行 + 4 行 (バッファ) でカット
    actualRMax = Math.min(region.rMax, actualRMax + 4);
    // 連番が小さい数 (1-2-3...) の中で、急に大きな数 (50+) が出る場合は noise → 切る
    const allInts = [];
    clusters.forEach(cl => allInts.push(...cl.positions));
    allInts.sort((a, b) => a.r - b.r);
    // 連続的に増えていく中で、間隔が極端に空く点を見つけて切る
    for (let i = 1; i < allInts.length; i++) {
      const rowGap = allInts[i].r - allInts[i - 1].r;
      // 30 行以上の gap = ブラケット終了 (別 section)
      if (rowGap > 30) {
        actualRMax = Math.min(actualRMax, allInts[i - 1].r + 4);
        break;
      }
    }
    region = { ...region, rMax: actualRMax };
    // 再度クラスタリング (絞り込んだ region で)
    clusters = findPositionClusters(ws, region, merges);
  }
  if (verbose) {
    process.stderr.write(`  Header [${header.r},${XLSX.utils.encode_col(header.c)}] '${header.event}' → ` +
      `region r=${region.rMin}..${region.rMax} c=${region.cMin}..${region.cMax}, ` +
      `clusters=${clusters.length}\n`);
  }
  if (!clusters.length) return null;

  const fmt = detectFormat(header.event, formatHint);
  // 番号列(クラスタ)の水平位置で左右(L/R)を判定。中央より左=L、右=R。
  // 両側トーナメントで左右の人数が異なっても境界を取り違えないために使用。
  const regCenter = (region.cMin + region.cMax) / 2;
  const sideOfCluster = (cl) => (cl.x < regCenter ? 'L' : 'R');
  let players = [];
  if (fmt === 'team') {
    // 団体戦: 各クラスタからチーム抽出 → 統合 (重複除外)
    clusters.forEach(cl => {
      const side = sideOfCluster(cl);
      const ts = extractTeamFromCluster(ws, cl, region, merges);
      ts.forEach(t => {
        if (!players.find(p => p.name === t.name && p.seed === t.seed)) {
          t.side = side; players.push(t);
        }
      });
    });
  } else if (fmt === 'doubles') {
    clusters.forEach(cl => {
      const side = sideOfCluster(cl);
      const ps = extractDoublesFromCluster(ws, cl, region, merges);
      ps.forEach(p => {
        if (!players.find(x => x.name === p.name && x.seed === p.seed)) {
          p.side = side; players.push(p);
        }
      });
    });
  } else {
    clusters.forEach(cl => {
      const side = sideOfCluster(cl);
      const ps = extractSinglesFromCluster(ws, cl, region, merges);
      ps.forEach(p => {
        if (!players.find(x => x.name === p.name && x.team === p.team)) {
          p.side = side; players.push(p);
        }
      });
    });
  }
  if (!players.length) return null;

  players.sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  return {
    format: 'tabletennis-seed-list-v1',
    event: header.event,
    type: fmt,
    block: header.block,
    regenerate: true,
    auto_link_to_players: false,
    placement: 'as_drawn', // 通し番号(seed)通りに固定配置 (取込表通りの対戦)
    players,
  };
}

// ─── シート1枚を解析 ─────────────────────
function parseSheet(ws, sheetName, opts) {
  const merges = ws['!merges'] || [];
  const headers = findHeaderCandidates(ws);
  if (opts.verbose) {
    process.stderr.write(`=== Sheet: ${sheetName} (headers: ${headers.length}) ===\n`);
    headers.forEach(h => process.stderr.write(`  [${h.r},${XLSX.utils.encode_col(h.c)}] '${h.raw}' → event='${h.event}' block='${h.block || '-'}'\n`));
  }

  const brackets = [];
  if (!headers.length) {
    // ヘッダー無しの場合: シート全体を 1 セクションとして処理
    const range = safeRange(ws);
    const fakeHeader = {
      r: 0, c: 0,
      event: opts.eventHint || sheetName,
      block: null,
    };
    const result = processHeader(ws, fakeHeader, [fakeHeader], opts.formatHint, merges, opts.verbose);
    if (result) brackets.push(result);
    return brackets;
  }

  headers.forEach(h => {
    const result = processHeader(ws, h, headers, opts.formatHint, merges, opts.verbose);
    if (!result) return;
    brackets.push(result);
  });
  return brackets;
}

// ─── ワークブック全体 ─────────────────────
function parseWorkbook(filePath, opts) {
  opts = opts || {};
  let wb;
  try {
    wb = XLSX.readFile(filePath, { cellStyles: false });
  } catch (e) {
    return { error: 'Excel 読み込み失敗: ' + e.message };
  }
  let sheetNames;
  if (opts.sheet) {
    if (!wb.SheetNames.includes(opts.sheet)) {
      return { error: `シート '${opts.sheet}' が見つかりません`,
               available_sheets: wb.SheetNames };
    }
    sheetNames = [opts.sheet];
  } else if (opts.allSheets) {
    sheetNames = wb.SheetNames;
  } else {
    sheetNames = [wb.SheetNames[0]];
  }

  // 「審判員」「操作説明」など、参加者リストでないシートは除外
  const skipSheets = /^(審判|操作説明|名簿入力|入力|名簿|シート1|sheet|template|テンプレ|ひな形)/i;
  sheetNames = sheetNames.filter(s => !skipSheets.test(s));

  const allBrackets = [];
  for (const sn of sheetNames) {
    const ws = wb.Sheets[sn];
    const bs = parseSheet(ws, sn, opts);
    allBrackets.push(...bs);
  }

  if (!allBrackets.length) {
    return {
      error: '認識可能な種目セクションが見つかりませんでした',
      hint: 'シート内に「○種目名」や「Xブロック」のヘッダー行があるか確認してください',
      available_sheets: wb.SheetNames,
    };
  }

  // ブロックは「別々のトーナメント表」として保持する。
  //   例: "男子シングルス Ａブロック" / "Bブロック" … をそれぞれ独立した event として取込み、
  //   運営ビューでタブ切替する。各ブロックは側(L/R)+最小番号正規化で正しく両側配置される。
  //   (※以前は1つの512に統合していたが、実際の組合せ表とのズレが出るため統合を解除)

  if (allBrackets.length === 1) return allBrackets[0];
  return {
    format: 'tabletennis-tournament-v1',
    tournament: { name: path.parse(filePath).name },
    brackets: allBrackets,
  };
}

// ─── CLI ──────────────────────────────
function parseArgs(argv) {
  const opts = {
    file: null,
    formatHint: null,
    eventHint: null,
    sheet: null,
    allSheets: false,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') opts.formatHint = argv[++i];
    else if (a === '--event') opts.eventHint = argv[++i];
    else if (a === '--sheet') opts.sheet = argv[++i];
    else if (a === '--all-sheets') opts.allSheets = true;
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (!opts.file) opts.file = a;
  }
  if (opts.formatHint === 'auto') opts.formatHint = null;
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  if (!opts.file) {
    process.stderr.write('Usage: parse_ktta_bracket.js FILE.xlsx [--format ...] [-v]\n');
    process.exit(2);
  }
  if (!fs.existsSync(opts.file)) {
    console.log(JSON.stringify({ error: 'ファイルが見つかりません: ' + opts.file }));
    process.exit(1);
  }
  try {
    const result = parseWorkbook(opts.file, opts);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log(JSON.stringify({
      error: '解析エラー: ' + e.name + ': ' + e.message,
      stack: e.stack ? e.stack.slice(0, 500) : undefined,
    }));
    process.exit(1);
  }
}

module.exports = { parseWorkbook };
