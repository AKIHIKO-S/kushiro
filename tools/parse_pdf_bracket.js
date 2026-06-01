#!/usr/bin/env node
/**
 * KTTA トーナメント PDF パーサー (Node.js / pdfjs-dist) v2
 * =======================================================
 * テキストPDF (Excel→PDF / Word→PDF など) からトーナメント表を抽出。
 *
 * v2 アルゴリズム改良:
 *   ・位置番号 (整数 1-99) の X 座標を 2 つのクラスタにわけて
 *     左/右ブラケットを特定
 *   ・各位置番号の周辺 (同じ Y バンド内) のテキストを集めて
 *     選手名 / 所属 / 地域 を判別
 *   ・ダブルス: 同じ位置番号の上下隣接行に2人目の名前があれば結合
 *   ・団体戦: 位置番号の右に大きなチーム名、その周辺行にメンバー名
 *
 * Usage:
 *   node parse_pdf_bracket.js FILE.pdf [--format singles|doubles|team]
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pdfjsLib = null;
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsLib;
}

// ─── 定数 ─────────────────────────────────
const SECTION_HEADER_RE = /^\s*[○◯◎●]?\s*(.+?(?:シングルス|ダブルス|団体|団体戦|混合).*?)\s*$/;
const SECTION_BLOCK_HEADER_RE = /^(.+?)\s*[ABCDＡＢＣＤ]ブロック\s*$/;
const TEAM_KEYWORDS = ['団体', 'チーム'];
const DOUBLES_KEYWORDS = ['ダブルス', 'ミックス', '混合', 'ペア'];
const LABELS = new Set([
  '氏名', '所属', '選手名', '団体名', 'チーム名', 'メンバー',
  '代表者', '選手', 'ペア', 'ダブルス', 'シングルス',
  '決勝', '準決勝', '準々決勝', 'ベスト16', 'ベスト32',
  '相互審判', 'BYE', 'bye', '不戦勝', '棄権',
]);
const PARENS_RE = /^[(（]\s*(.*?)\s*[)）]$/;
const KNOWN_REGIONS = new Set([
  '釧路', '十勝', '北見', '札幌', '千歳', '苫小牧', '根室', '斜里',
  '名寄', '旭川', '函館', '帯広', '石狩', '美幌', '中標津',
]);
const TEAM_SUFFIX_RE = /(中学校?|高校|高等学校|小学校?|大学|TTC|TTスタジオ|スポーツ|クラブ|協会|市役所|アスティーダ|JFY|個人)$/;

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
  let str = String(s).trim().replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
  str = str.replace(/(君|くん|さん|ちゃん|選手|様)$/, '').trim();
  return str;
}

function isLabelLike(s) {
  if (!s) return true;
  const str = String(s).trim();
  if (LABELS.has(str)) return true;
  if (/^[※★●◯○・■□]/.test(str)) return true;
  return false;
}

function isInteger(s) {
  return typeof s === 'string' && /^\d{1,3}$/.test(s.trim());
}

// 名前らしいか (日本語名 2-15 文字、ラベルでない)
function looksLikeName(s) {
  const str = String(s || '').trim();
  if (!str || str.length < 2 || str.length > 20) return false;
  if (isLabelLike(str)) return false;
  if (KNOWN_REGIONS.has(str)) return false;
  if (PARENS_RE.test(str)) return false;  // 括弧付きは所属
  if (TEAM_SUFFIX_RE.test(str)) return false;  // チーム接尾辞
  if (/^\d+$/.test(str)) return false;  // 数字のみ
  // 日本語文字を含む
  if (!/[ぁ-んァ-ヶー一-龯々]/.test(str)) return false;
  return true;
}

function looksLikeTeam(s) {
  const str = String(s || '').trim();
  if (!str) return false;
  if (PARENS_RE.test(str)) return true;  // (xxx) 形式
  if (TEAM_SUFFIX_RE.test(str)) return true;
  return false;
}

// ─── PDF → テキスト要素配列 ─────────────────
async function extractTextItems(pdfBuffer) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  const allItems = [];
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const page = await doc.getPage(pn);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    content.items.forEach(item => {
      if (!item.str || !item.str.trim()) return;
      const tx = item.transform;
      const x = tx[4];
      const y = viewport.height - tx[5];
      allItems.push({
        str: item.str.trim(),
        x, y,
        width: item.width || 0,
        height: item.height || (tx[3] || 10),
        page: pn,
        pageWidth: viewport.width,
        pageHeight: viewport.height,
      });
    });
  }
  return allItems;
}

// ─── ページごとに処理 ───────────────────────
function byPage(items) {
  const map = {};
  items.forEach(it => {
    if (!map[it.page]) map[it.page] = [];
    map[it.page].push(it);
  });
  return map;
}

// 同じ Y バンドにある items を 1 行とみなす
function yBand(items, yTolerance) {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  sorted.forEach(it => {
    const tol = yTolerance || Math.max(2, it.height * 0.5);
    if (rows.length && Math.abs(rows[rows.length - 1].y - it.y) <= tol) {
      rows[rows.length - 1].items.push(it);
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  });
  rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
  return rows;
}

// 整数だけの items を抽出して X 座標を2クラスタに分割
//   戻り値: { leftX, rightX, leftPositions, rightPositions, ... }
function classifyPositions(items, pageWidth) {
  const intItems = items.filter(it => isInteger(it.str)).map(it => ({
    ...it, value: parseInt(it.str),
  }));
  if (intItems.length < 4) return null;

  // 位置番号 (integer) の X 範囲をもとにギャップを評価
  const sorted = intItems.slice().sort((a, b) => a.x - b.x);
  const intMinX = sorted[0].x;
  const intMaxX = sorted[sorted.length - 1].x;
  const intRange = intMaxX - intMinX;
  let maxGap = 0, splitIdx = -1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - sorted[i - 1].x;
    if (gap > maxGap) { maxGap = gap; splitIdx = i; }
  }
  // ギャップは「整数の X 範囲の50%以上」が必要
  // (位置番号は左右の端にあるので、間に十分な隙間があるはず)
  const minGap = Math.max(intRange * 0.5, 15);
  if (splitIdx < 0 || maxGap < minGap) {
    return null;
  }
  const leftSet = sorted.slice(0, splitIdx);
  const rightSet = sorted.slice(splitIdx);
  if (!leftSet.length || !rightSet.length) return null;

  const leftXAvg = leftSet.reduce((a, b) => a + b.x, 0) / leftSet.length;
  const rightXAvg = rightSet.reduce((a, b) => a + b.x, 0) / rightSet.length;

  // 縦方向ソート
  leftSet.sort((a, b) => a.y - b.y);
  rightSet.sort((a, b) => a.y - b.y);

  return {
    leftX: leftXAvg,
    rightX: rightXAvg,
    leftPositions: leftSet,
    rightPositions: rightSet,
    intRange,
  };
}

// セクションヘッダー (例: "女子ダブルス Aブロック") を検出
function detectSectionHeader(items) {
  // ページ上部にある "...シングルス|ダブルス|団体..." を含む item
  for (const it of items) {
    const s = it.str.trim();
    if (s.length > 30) continue;
    if (/(シングルス|ダブルス|団体|混合)/.test(s)) {
      if (!isLabelLike(s)) return s;
    }
  }
  return null;
}

// ─── 周辺アイテム検索ヘルパー ───────────────
function findItemsInRange(items, opts) {
  return items.filter(it => {
    if (opts.minX != null && it.x < opts.minX) return false;
    if (opts.maxX != null && it.x > opts.maxX) return false;
    if (opts.minY != null && it.y < opts.minY) return false;
    if (opts.maxY != null && it.y > opts.maxY) return false;
    if (opts.excludePos && isInteger(it.str)) return false;
    return true;
  });
}

// 1つの位置番号の「周辺」(=その行+前後数行) からアイテムを集めて
// 名前/所属を判定する
function collectAroundPos(items, posItem, side, opts) {
  const yWindow = opts.yWindow || 8;
  const minY = posItem.y - yWindow;
  const maxY = posItem.y + yWindow;
  const midX = opts.midX;  // 必須
  let near;
  if (side === 'L') {
    near = findItemsInRange(items, {
      minX: posItem.x + 1,
      maxX: midX,
      minY, maxY,
      excludePos: true,
    });
  } else {
    near = findItemsInRange(items, {
      minX: midX,
      maxX: posItem.x - 1,
      minY, maxY,
      excludePos: true,
    });
  }
  near.sort((a, b) => a.y - b.y || a.x - b.x);
  return near;
}

// 文字の中央 X (片側でフィルタするのに使う)
function computeMidX(classification) {
  return (classification.leftX + classification.rightX) / 2;
}

// Y バンドサイズの推定: 位置番号間の平均Y差から
function computeYBand(classification) {
  // 左右合わせて連続する位置番号のY間隔
  const allPos = [...classification.leftPositions, ...classification.rightPositions]
    .sort((a, b) => a.y - b.y);
  const diffs = [];
  for (let i = 1; i < allPos.length; i++) {
    const d = allPos[i].y - allPos[i - 1].y;
    if (d > 0.1) diffs.push(d);
  }
  if (!diffs.length) return 8;
  diffs.sort((a, b) => a - b);
  // 中央値 × 0.5 を yWindow とする (1 行間隔の半分以下)
  const median = diffs[Math.floor(diffs.length / 2)];
  return Math.max(2, median * 0.55);
}

// ─── シングルス: 各位置 → 名前+所属 ───────────
function extractSinglesPlayers(items, classification, eventName) {
  const players = [];
  const midX = computeMidX(classification);
  const yWindow = computeYBand(classification);

  classification.leftPositions.forEach(posItem => {
    const near = collectAroundPos(items, posItem, 'L', { midX, yWindow });
    const nameCand = near.filter(it => looksLikeName(it.str));
    const teamCand = near.filter(it => looksLikeTeam(it.str));
    if (!nameCand.length) return;
    const name = normalizeName(nameCand[0].str);
    const team = teamCand.length ? stripParens(teamCand[0].str) : '';
    players.push({ name, team, seed: posItem.value });
  });

  classification.rightPositions.forEach(posItem => {
    const near = collectAroundPos(items, posItem, 'R', { midX, yWindow });
    const nameCand = near.filter(it => looksLikeName(it.str));
    const teamCand = near.filter(it => looksLikeTeam(it.str));
    if (!nameCand.length) return;
    nameCand.sort((a, b) => b.x - a.x);
    const name = normalizeName(nameCand[0].str);
    teamCand.sort((a, b) => b.x - a.x);
    const team = teamCand.length ? stripParens(teamCand[0].str) : '';
    if (!players.find(p => p.name === name && p.team === team)) {
      players.push({ name, team, seed: posItem.value });
    }
  });

  players.sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  return players;
}

// ─── ダブルス: 1ペア = 2選手 ─────────────────
function extractDoublesPlayers(items, classification, eventName) {
  const players = [];
  const midX = computeMidX(classification);
  const yWindow = computeYBand(classification) * 1.5; // ペアは少し広いウィンドウ

  const buildPair = (posItem, side) => {
    const near = collectAroundPos(items, posItem, side, { midX, yWindow });
    const names = near.filter(it => looksLikeName(it.str));
    const teams = near.filter(it => looksLikeTeam(it.str));
    names.sort((a, b) => Math.abs(a.y - posItem.y) - Math.abs(b.y - posItem.y));
    const n1 = names[0] ? normalizeName(names[0].str) : '';
    const n2 = names[1] ? normalizeName(names[1].str) : '';
    const team = teams[0] ? stripParens(teams[0].str) : '';
    // ペアは name(選手1)/partner_name(選手2) に分離 → 2名とも個別DB連携可能に。
    // importer は data.partner_name を参照する。name:"A/B" 結合だと1名扱いになり
    // パートナー分離・DB連携が壊れるため、parse_ktta_bracket.js と同じ形に揃える。
    const member1 = n1 || n2;
    const member2 = (n1 && n2 && n1 !== n2) ? n2 : '';
    if (!member1) return null;
    return {
      name: member1,
      partner_name: member2,
      team,
      partner_team: team, // 同チーム既定 (別チームは取込後に編集可)
      is_doubles: true,
      seed: posItem.value,
    };
  };

  classification.leftPositions.forEach(p => {
    const pair = buildPair(p, 'L');
    if (pair) players.push(pair);
  });
  classification.rightPositions.forEach(p => {
    const pair = buildPair(p, 'R');
    if (pair && !players.find(x => x.name === pair.name)) players.push(pair);
  });

  players.sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  return players;
}

// ─── 団体戦: 位置番号 → チーム名 + メンバー ─────
function extractTeamPlayers(items, classification, eventName) {
  const teams = [];
  const midX = computeMidX(classification);
  const yWindow = computeYBand(classification) * 3.5; // 団体戦は数行に渡る

  const buildTeam = (posItem, side) => {
    const near = collectAroundPos(items, posItem, side, { midX, yWindow });
    const teamCands = near.filter(it => looksLikeTeam(it.str) ||
                                          (it.str.length <= 12 && /TTC|クラブ|スポーツ|市役所|学校|工業|教育大|協会|アスティーダ/.test(it.str)));
    const memberCands = near.filter(it => {
      const s = it.str.trim();
      if (PARENS_RE.test(s) || isLabelLike(s)) return false;
      if (KNOWN_REGIONS.has(s)) return false;
      if (TEAM_SUFFIX_RE.test(s)) return false;
      if (/TTC|クラブ|スポーツ|市役所|学校|工業|教育大|協会|アスティーダ/.test(s)) return false;
      if (/^\d+$/.test(s)) return false;
      if (s.length < 1 || s.length > 12) return false;
      if (!/[ぁ-んァ-ヶー一-龯々]/.test(s)) return false;
      return true;
    });
    teamCands.sort((a, b) => b.str.length - a.str.length);
    const teamName = teamCands[0] ? stripParens(teamCands[0].str) : '';
    const members = [];
    memberCands.forEach(it => {
      const nm = normalizeName(it.str);
      if (nm && !members.includes(nm)) members.push(nm);
    });
    // チーム名が無くてもメンバーがあれば登録 (LEFT 側はチーム名表示が省略されている場合あり)
    if (!teamName && !members.length) return null;
    const displayName = teamName || ('チーム#' + posItem.value);
    return {
      name: displayName,
      team: displayName,
      seed: posItem.value,
      is_team: true,
      members,
    };
  };

  classification.leftPositions.forEach(p => {
    const t = buildTeam(p, 'L');
    if (t) teams.push(t);
  });
  classification.rightPositions.forEach(p => {
    const t = buildTeam(p, 'R');
    if (t && !teams.find(x => x.name === t.name)) teams.push(t);
  });

  teams.sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
  return teams;
}

// ─── ページ単位処理 ───────────────────────
function parsePage(items, formatHint, eventHint) {
  if (!items.length) return null;
  const pageWidth = items[0].pageWidth;

  // セクションヘッダー検出 (任意)
  const sectionEventName = detectSectionHeader(items);
  const eventName = sectionEventName || eventHint || '不明';

  // 位置番号を 2 クラスタに分類
  const classification = classifyPositions(items, pageWidth);
  if (!classification) {
    return { error: 'position numbers not found', eventName };
  }

  const fmt = detectFormat(eventName, formatHint);
  let players;
  if (fmt === 'team') players = extractTeamPlayers(items, classification, eventName);
  else if (fmt === 'doubles') players = extractDoublesPlayers(items, classification, eventName);
  else players = extractSinglesPlayers(items, classification, eventName);

  return { eventName, fmt, players };
}

// ─── メイン ─────────────────────────────
async function parsePdfBuffer(pdfBuffer, opts) {
  opts = opts || {};
  const items = await extractTextItems(pdfBuffer);
  if (!items.length) {
    return { error: 'PDF からテキストを抽出できませんでした (画像PDFの可能性)。' +
      'Excel ファイルまたはテキスト形式の PDF をご利用ください。' };
  }
  const pages = byPage(items);
  if (opts.verbose) {
    process.stderr.write(`Pages: ${Object.keys(pages).length}, Items total: ${items.length}\n`);
  }

  const brackets = [];
  // ページごとに解析。複数ページの場合、各ページが独立した種目セクションと仮定
  const aggregateByEvent = {};
  Object.keys(pages).sort((a, b) => +a - +b).forEach(pn => {
    const pageItems = pages[pn];
    const result = parsePage(pageItems, opts.formatHint, opts.eventHint);
    if (opts.verbose) {
      process.stderr.write(`Page ${pn}: ${result.eventName || '?'} (${result.fmt || '?'}), ` +
        `${result.players ? result.players.length : 0} players\n`);
    }
    if (!result || result.error || !result.players || !result.players.length) return;
    // 同じ event なら統合
    const key = result.eventName;
    if (!aggregateByEvent[key]) {
      aggregateByEvent[key] = { event: result.eventName, type: result.fmt, players: [] };
    }
    // 重複除外しつつ追加
    result.players.forEach(p => {
      const exists = aggregateByEvent[key].players.find(x =>
        x.name === p.name && x.team === p.team);
      if (!exists) aggregateByEvent[key].players.push(p);
    });
  });

  Object.values(aggregateByEvent).forEach(agg => {
    agg.players.sort((a, b) => (a.seed || 9999) - (b.seed || 9999));
    brackets.push({
      format: 'tabletennis-seed-list-v1',
      event: agg.event,
      type: agg.type,
      regenerate: true,
      auto_link_to_players: false,
      placement: 'as_drawn', // 通し番号(seed)通りに固定配置 (取込表通りの対戦)
      players: agg.players,
    });
  });

  if (!brackets.length) {
    return {
      error: '認識可能なトーナメント構造が見つかりませんでした',
      hint: 'PDF が標準形式 (位置番号+選手名+所属の表) か、画像PDF (スキャン) ではないか確認してください。形式を選択してから再アップロードすると改善する場合があります。',
    };
  }

  if (brackets.length === 1) return brackets[0];
  return {
    format: 'tabletennis-tournament-v1',
    tournament: { name: opts.filename || 'pdf' },
    brackets,
  };
}

async function parseWorkbook(filePath, opts) {
  opts = opts || {};
  const buf = fs.readFileSync(filePath);
  const name = path.parse(filePath).name;
  return parsePdfBuffer(buf, { ...opts, filename: name });
}

// ─── CLI ──────────────────────────────
function parseArgs(argv) {
  const opts = {
    file: null,
    formatHint: null,
    eventHint: null,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') opts.formatHint = argv[++i];
    else if (a === '--event') opts.eventHint = argv[++i];
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (!opts.file) opts.file = a;
  }
  if (opts.formatHint === 'auto') opts.formatHint = null;
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  if (!opts.file) {
    process.stderr.write('Usage: parse_pdf_bracket.js FILE.pdf [--format ...] [--event NAME] [-v]\n');
    process.exit(2);
  }
  if (!fs.existsSync(opts.file)) {
    console.log(JSON.stringify({ error: 'ファイルが見つかりません: ' + opts.file }));
    process.exit(1);
  }
  parseWorkbook(opts.file, opts).then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(e => {
    console.log(JSON.stringify({
      error: 'PDF 解析エラー: ' + e.name + ': ' + e.message,
      stack: e.stack ? e.stack.slice(0, 500) : undefined,
    }));
    process.exit(1);
  });
}

module.exports = { parseWorkbook, parsePdfBuffer };
