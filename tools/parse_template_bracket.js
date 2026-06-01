#!/usr/bin/env node
/**
 * KTTA 取込テンプレ Excel 専用パーサー
 * ============================================
 * tools/build_bracket_template.js で生成したフォーマット
 * (「設定」「組合せ」「シード表」「記入例」シート構造) を厳密に読み取る。
 *
 * 出力: db.importBracket 用の {format: 'tabletennis-bracket-v1'} 形式
 * → bracket_round + match_no が確定しているので、positions を保持してインポート可能
 *
 * Usage:
 *   node parse_template_bracket.js FILE.xlsx
 */
'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// 宣言上の !ref はアップロード側が巨大値(A1:XFD1048576 等)を仕込め、そのまま二重ループすると
// 数百億セルの空走査でイベントループが固まる (#8 DoS)。実際に値を持つセルの範囲にクランプする。
function safeRange(ws) {
  const declared = (ws && ws['!ref']) ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
  let maxR = -1, maxC = -1;
  for (const k in ws) {
    if (k[0] === '!') continue;
    const cell = XLSX.utils.decode_cell(k);
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c > maxC) maxC = cell.c;
  }
  const HARD_R = 20000, HARD_C = 512;
  return {
    s: declared.s,
    e: {
      r: Math.min(declared.e.r, maxR, declared.s.r + HARD_R),
      c: Math.min(declared.e.c, maxC, declared.s.c + HARD_C),
    },
  };
}

// ─── ヘルパー ───────────────────────────
function cellValue(ws, r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell || cell.v == null) return null;
  return cell.v;
}

function isPlaceholder(s) {
  if (!s) return true;
  const str = String(s).trim();
  if (!str) return true;
  // (BYE) / (1回戦勝者) / (試合1勝者) などプレースホルダー
  if (/^[(（].*[)）]$/.test(str)) return true;
  if (str.toLowerCase() === 'bye') return true;
  if (str === '-' || str === '—') return true;
  return false;
}

function normalizeRound(s) {
  if (!s) return 0;
  const str = String(s).trim();
  if (str === '決勝') return 999;       // ラウンド最大 (後で置換)
  if (str === '準決勝') return 998;
  if (str === '準々決勝') return 997;
  if (str === 'ベスト16') return 996;
  const m = /^(\d+)\s*回戦$/.exec(str);
  if (m) return parseInt(m[1]);
  // 数字単体
  if (/^\d+$/.test(str)) return parseInt(str);
  return 0;
}

// ─── メイン解析 ────────────────────────
function parseTemplate(filePath) {
  let wb;
  try {
    wb = XLSX.readFile(filePath, { cellStyles: false });
  } catch (e) {
    return { error: 'Excel 読込失敗: ' + e.message };
  }

  // 「設定」シートから 種目名 + ブラケットサイズ
  let event = 'インポート種目';
  let bracketSize = 0;
  let format = 'singles';
  let tournamentName = '';
  const wsSet = wb.Sheets['設定'];
  if (wsSet) {
    const r = safeRange(wsSet);
    for (let row = 0; row <= r.e.r; row++) {
      const key = cellValue(wsSet, row, 0);
      const val = cellValue(wsSet, row, 1);
      if (!key || val == null) continue;
      const k = String(key).trim();
      if (k === '大会名') tournamentName = String(val);
      else if (k === '種目') event = String(val);
      else if (k === 'ブラケットサイズ') bracketSize = parseInt(val) || 0;
      else if (k === '形式') {
        const v = String(val).trim().toLowerCase();
        if (v.startsWith('doubles') || v.includes('ダブルス')) format = 'doubles';
        else if (v.startsWith('team') || v.includes('団体') || v.includes('チーム')) format = 'team';
      }
    }
  }

  // 「組合せ」シートから 試合一覧
  const wsM = wb.Sheets['組合せ'];
  if (!wsM) {
    return { error: '「組合せ」シートが見つかりません。テンプレートをご利用ください。' };
  }
  const range = safeRange(wsM);
  // ヘッダー行を探す (「ラウンド」「試合番号」が並ぶ行)
  let headerRow = -1;
  for (let row = 0; row <= range.e.r; row++) {
    const v0 = cellValue(wsM, row, 0);
    const v1 = cellValue(wsM, row, 1);
    if (String(v0).trim() === 'ラウンド' && String(v1).trim() === '試合番号') {
      headerRow = row;
      break;
    }
  }
  if (headerRow < 0) {
    return { error: '「組合せ」シート: ヘッダー行 (ラウンド/試合番号) が見つかりません' };
  }

  // 試合データを読む
  const matchesByRound = {};  // {round: [{match_no, p1, p2, ...}]}
  for (let row = headerRow + 1; row <= range.e.r; row++) {
    const roundCell = cellValue(wsM, row, 0);
    const matchNoCell = cellValue(wsM, row, 1);
    if (!roundCell || matchNoCell == null) continue;
    // 注意書き行 (◆) はスキップ
    if (String(roundCell).startsWith('◆') || String(roundCell).startsWith('※')) continue;
    const round = normalizeRound(roundCell);
    if (!round) continue;
    const matchNo = parseInt(matchNoCell);
    if (!matchNo) continue;
    const p1Name = cellValue(wsM, row, 2);
    const p1Team = cellValue(wsM, row, 3);
    const p2Name = cellValue(wsM, row, 4);
    const p2Team = cellValue(wsM, row, 5);

    if (!matchesByRound[round]) matchesByRound[round] = [];
    matchesByRound[round].push({
      match_no: matchNo,
      player1_name: isPlaceholder(p1Name) ? '' : String(p1Name).trim(),
      player1_team: p1Team ? String(p1Team).trim() : '',
      player2_name: isPlaceholder(p2Name) ? '' : String(p2Name).trim(),
      player2_team: p2Team ? String(p2Team).trim() : '',
    });
  }

  // round の番号を 1, 2, 3, ... totalRounds に正規化
  // (決勝 = totalRounds, 準決勝 = totalRounds-1, ...)
  const roundKeys = Object.keys(matchesByRound).map(Number).sort((a, b) => a - b);
  if (!roundKeys.length) {
    return { error: '試合データが「組合せ」シートに見つかりません' };
  }

  // 通常: 1回戦, 2回戦, ..., (準々決勝, 準決勝, 決勝)
  // round 999/998/997/996 を末尾に並べ替え
  const ordinalRounds = roundKeys.filter(r => r < 900).sort((a, b) => a - b);
  const labelRounds = roundKeys.filter(r => r >= 900).sort((a, b) => a - b);
  const orderedRounds = [...ordinalRounds, ...labelRounds];

  // bracket_size の確定
  if (!bracketSize) {
    // 1回戦試合数 × 2 = bracketSize
    const firstRoundCount = matchesByRound[orderedRounds[0]].length;
    bracketSize = firstRoundCount * 2;
  }
  // 2 のべき乗にする
  bracketSize = Math.pow(2, Math.ceil(Math.log2(bracketSize)));

  // matches リストを構築 (bracket_round + bracket_pos)
  const matchesOut = [];
  orderedRounds.forEach((origRound, ri) => {
    const round = ri + 1;  // 1 から開始
    const ms = matchesByRound[origRound].sort((a, b) => a.match_no - b.match_no);
    ms.forEach(m => {
      matchesOut.push({
        bracket_round: round,
        bracket_pos: m.match_no - 1,  // 0-indexed
        match_no: m.match_no,
        round: round === orderedRounds.length ? '決勝'
             : round === orderedRounds.length - 1 ? '準決勝'
             : round === orderedRounds.length - 2 ? '準々決勝'
             : round + '回戦',
        player1_name: m.player1_name,
        player1_team: m.player1_team,
        player2_name: m.player2_name,
        player2_team: m.player2_team,
      });
    });
  });

  return {
    format: 'tabletennis-bracket-v1',
    event,
    bracket_size: bracketSize,
    total_rounds: orderedRounds.length,
    matches: matchesOut,
    tournament_name: tournamentName,
    type: format,
  };
}

// ─── CLI ──────────────────────────────
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('Usage: parse_template_bracket.js FILE.xlsx\n');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.log(JSON.stringify({ error: 'ファイルが見つかりません: ' + file }));
    process.exit(1);
  }
  try {
    const result = parseTemplate(file);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

module.exports = { parseTemplate };
