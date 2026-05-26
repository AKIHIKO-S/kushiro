#!/usr/bin/env node
/**
 * KTTA 標準 Excel 組合せ表パーサー (Node.js 版)
 * ============================================
 * 釧路卓球協会で使われている形式の Excel を読み取る専用パーサー。
 * Python の parse_ktta_bracket.py の Node 移植版。
 *
 * 利点: openpyxl 等の Python 依存が不要。
 *       Render Node 環境で xlsx (SheetJS) のみで完結。
 *
 * 形式:
 *   ・1シートに「○種目名」でセクション分割
 *   ・LEFT 半分: A=position, B=name (merged 2行), C/D=team
 *   ・MIDDLE: S=name (merged 2行), U=team   ← 右半分ブラケット
 *   ・RIGHT エントリーリスト: V=position (merged), X=team, Y=name
 *   ・団体戦: A=position, B=team_name (merged), C/D=members
 *
 * Usage:
 *   node parse_ktta_bracket.js FILE.xlsx [--format singles|doubles|team|auto]
 *                                         [--event "種目名"]
 *                                         [--sheet 名前]
 *                                         [--all-sheets]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// ─── 設定 ─────────────────────────────────
const TEAM_KEYWORDS = ['団体', 'チーム'];
const DOUBLES_KEYWORDS = ['ダブルス', 'ミックス', '混合', 'ペア'];
const SECTION_HEADER_RE = /^\s*[○◯◎●]\s*(.+?)\s*$/;
const LABELS = new Set([
  '氏名', '所属', '選手名', '団体名', 'チーム名', 'メンバー',
  '代表者', '選手', 'ペア', 'ダブルス', 'シングルス',
  '決勝', '準決勝', '準々決勝', 'ベスト16', 'ベスト32',
  'BYE', 'bye', '不戦勝', '棄権',
]);
const PARENS_RE = /^[(（]\s*(.*?)\s*[)）]$/;

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
  str = str.replace(/　/g, ' ');
  str = str.replace(/\s+/g, ' ').trim();
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

// ─── XLSX セル/merged アクセス ──────────────
function colNumToLetter(num) {
  // 1-indexed: 1 → A, 26 → Z, 27 → AA
  let s = '';
  while (num > 0) {
    const r = (num - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

function letterToColNum(letters) {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

function addrToRC(addr) {
  const m = /^([A-Z]+)(\d+)$/.exec(addr);
  if (!m) return null;
  return { col: letterToColNum(m[1]), row: parseInt(m[2]) };
}

function rcToAddr(row, col) {
  return colNumToLetter(col) + row;
}

function getCellValue(ws, row, col) {
  const cell = ws[rcToAddr(row, col)];
  return cell ? cell.v : null;
}

// 指定セルが merged 範囲のどこかに含まれていれば、その範囲の左上の値を返す
function getMergedValue(ws, row, col, mergedRanges) {
  const v = getCellValue(ws, row, col);
  if (v != null) return v;
  for (const mr of mergedRanges) {
    if (mr.s.r + 1 <= row && row <= mr.e.r + 1 &&
        mr.s.c + 1 <= col && col <= mr.e.c + 1) {
      return getCellValue(ws, mr.s.r + 1, mr.s.c + 1);
    }
  }
  return null;
}

function isTopOfMerge(ws, row, col, mergedRanges) {
  for (const mr of mergedRanges) {
    if (mr.s.r + 1 <= row && row <= mr.e.r + 1 &&
        mr.s.c + 1 <= col && col <= mr.e.c + 1) {
      return row === mr.s.r + 1;
    }
  }
  return true;
}

function getMaxRowCol(ws) {
  const ref = ws['!ref'];
  if (!ref) return { maxRow: 0, maxCol: 0 };
  const range = XLSX.utils.decode_range(ref);
  return { maxRow: range.e.r + 1, maxCol: range.e.c + 1 };
}

// ─── セクション (○種目名) を検出 ───────────
function findSections(ws) {
  const { maxRow, maxCol } = getMaxRowCol(ws);
  const sections = [];
  for (let r = 1; r <= maxRow; r++) {
    for (let c = 1; c <= Math.min(15, maxCol); c++) {
      const v = getCellValue(ws, r, c);
      if (v == null) continue;
      const m = SECTION_HEADER_RE.exec(String(v));
      if (m) {
        sections.push({ start: r, event: m[1].trim() });
        break;
      }
    }
  }
  // 末尾を補完
  const result = [];
  for (let i = 0; i < sections.length; i++) {
    const end = i + 1 < sections.length ? sections[i + 1].start - 1 : maxRow;
    result.push({ start: sections[i].start, end, event: sections[i].event });
  }
  return result;
}

// ─── シングルス: 左+中央+右リストから選手抽出 ──
function parseSinglesSection(ws, section, mergedRanges, opts) {
  const players = [];
  const { start: sr, end: er } = section;

  // LEFT (cols A=position, B=name, C=team)
  for (let r = sr + 1; r <= er; r++) {
    const aVal = getCellValue(ws, r, 1);
    if (typeof aVal !== 'number') continue;
    if (!isTopOfMerge(ws, r, 2, mergedRanges)) continue;
    const bVal = getMergedValue(ws, r, 2, mergedRanges);
    let cVal = getMergedValue(ws, r, 3, mergedRanges);
    if (cVal == null) cVal = getMergedValue(ws, r, 4, mergedRanges);
    const name = normalizeName(bVal);
    const team = stripParens(cVal);
    if (name && !isLabelLike(name)) {
      players.push({ name, team, seed: aVal });
    }
  }

  // MIDDLE (cols S=name, U=team) — 右半分ブラケット表示
  for (let r = sr + 1; r <= er; r++) {
    const vVal = getCellValue(ws, r, 22); // V
    if (typeof vVal !== 'number') continue;
    if (!isTopOfMerge(ws, r, 19, mergedRanges)) continue; // S
    const sVal = getMergedValue(ws, r, 19, mergedRanges);
    const uVal = getMergedValue(ws, r, 21, mergedRanges);
    const name = normalizeName(sVal);
    const team = stripParens(uVal);
    if (name && !isLabelLike(name)) {
      const exists = players.find(p => p.name === name && p.team === team);
      if (!exists) {
        players.push({ name, team, seed: vVal });
      }
    }
  }

  // RIGHT エントリーリスト (V=position, X=team, Y=name)
  for (let r = sr + 1; r <= er; r++) {
    const vVal = getCellValue(ws, r, 22);
    const yVal = getCellValue(ws, r, 25);
    const xVal = getCellValue(ws, r, 24);
    const name = normalizeName(yVal);
    if (!name || isLabelLike(name)) continue;
    const team = stripParens(xVal);
    const exists = players.find(p => p.name === name && p.team === team);
    if (exists) continue;
    const seed = typeof vVal === 'number' ? vVal : 0;
    players.push({ name, team, seed });
  }

  players.sort((a, b) =>
    (a.seed || 9999) - (b.seed || 9999) || a.name.localeCompare(b.name, 'ja'));
  return players;
}

// ─── ダブルス: ペア検出 ────────────────────
function parseDoublesSection(ws, section, mergedRanges, opts) {
  const players = [];
  const { start: sr, end: er } = section;

  for (let r = sr + 1; r <= er; r++) {
    const aVal = getCellValue(ws, r, 1);
    if (typeof aVal !== 'number') continue;
    const b1 = getMergedValue(ws, r, 2, mergedRanges) || '';
    const b2 = getMergedValue(ws, r + 1, 2, mergedRanges) || '';
    const cVal = getMergedValue(ws, r, 3, mergedRanges)
              || getMergedValue(ws, r, 4, mergedRanges) || '';
    const n1 = normalizeName(b1);
    const n2 = normalizeName(b2);
    const team = stripParens(cVal);
    const pairName = (n1 && n2 && n1 !== n2) ? n1 + '/' + n2 : (n1 || n2);
    if (pairName && !isLabelLike(pairName)) {
      players.push({
        name: pairName,
        name1: n1,
        name2: n2,
        team,
        is_doubles: true,
        seed: aVal,
      });
    }
  }

  // RIGHT リスト (ペア)
  let pairBuf = [];
  for (let r = sr + 1; r <= er; r++) {
    const vVal = getCellValue(ws, r, 22);
    const yVal = getCellValue(ws, r, 25);
    const xVal = getCellValue(ws, r, 24);
    const name = normalizeName(yVal);
    if (!name || isLabelLike(name)) continue;
    const team = stripParens(xVal);
    if (typeof vVal === 'number') {
      pairBuf = [{ name, team }];
    } else if (pairBuf.length === 1) {
      pairBuf.push({ name, team });
      const [p1, p2] = pairBuf;
      const pairName = p1.name + '/' + p2.name;
      if (!players.find(p => p.name === pairName)) {
        players.push({
          name: pairName,
          name1: p1.name,
          name2: p2.name,
          team: p1.team,
          is_doubles: true,
          seed: 0,
        });
      }
      pairBuf = [];
    }
  }

  players.sort((a, b) =>
    (a.seed || 9999) - (b.seed || 9999) || a.name.localeCompare(b.name, 'ja'));
  return players;
}

// ─── 団体戦: チーム単位 ────────────────────
function parseTeamSection(ws, section, mergedRanges, opts) {
  const teams = [];
  const { start: sr, end: er } = section;
  const { maxRow } = getMaxRowCol(ws);

  const teamRows = [];
  let lastStart = null, lastPos = null;
  for (let r = sr + 1; r <= er + 1; r++) {
    const aVal = r <= maxRow ? getCellValue(ws, r, 1) : null;
    if (typeof aVal === 'number') {
      if (lastStart != null) {
        teamRows.push([lastStart, r - 1, lastPos]);
      }
      lastStart = r;
      lastPos = aVal;
    }
  }
  if (lastStart != null) {
    teamRows.push([lastStart, er, lastPos]);
  }

  for (const [sr_, er_, pos] of teamRows) {
    const teamName = normalizeName(getMergedValue(ws, sr_, 2, mergedRanges));
    if (!teamName || isLabelLike(teamName)) continue;
    const memberNames = [];
    for (let r = sr_; r <= er_; r++) {
      for (const col of [3, 4]) {
        const v = getCellValue(ws, r, col);
        const nm = normalizeName(v);
        if (nm && !isLabelLike(nm) && !memberNames.includes(nm)) {
          memberNames.push(nm);
        }
      }
    }
    teams.push({
      name: teamName,
      team: teamName,
      seed: pos,
      is_team: true,
      members: memberNames,
    });
  }

  teams.sort((a, b) =>
    (a.seed || 9999) - (b.seed || 9999) || a.name.localeCompare(b.name, 'ja'));
  return teams;
}

// ─── シート1枚を解析 ─────────────────────
function parseSheet(ws, sheetName, opts) {
  const mergedRanges = ws['!merges'] || [];
  let sections = findSections(ws);
  if (opts.verbose) {
    process.stderr.write(`  Detected sections: ${sections.map(s => s.event).join(', ') || '(none)'}\n`);
  }
  if (!sections.length) {
    // セクション無しの場合、シート全体を1セクションとして
    const { maxRow } = getMaxRowCol(ws);
    sections = [{ start: 0, end: maxRow, event: opts.eventHint || sheetName }];
  }
  const brackets = [];
  for (const sec of sections) {
    const evName = sec.event;
    const fmt = detectFormat(evName, opts.formatHint);
    let players;
    if (fmt === 'team') {
      players = parseTeamSection(ws, sec, mergedRanges, opts);
    } else if (fmt === 'doubles') {
      players = parseDoublesSection(ws, sec, mergedRanges, opts);
    } else {
      players = parseSinglesSection(ws, sec, mergedRanges, opts);
    }
    if (!players.length) {
      if (opts.verbose) {
        process.stderr.write(`  Section '${evName}' produced 0 players\n`);
      }
      continue;
    }
    brackets.push({
      format: 'tabletennis-seed-list-v1',
      event: evName,
      type: fmt,
      regenerate: true,
      auto_link_to_players: false,
      players,
    });
  }
  return brackets;
}

// ─── ワークブック全体 ─────────────────────
function parseWorkbook(filePath, opts) {
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

  const allBrackets = [];
  for (const sn of sheetNames) {
    const ws = wb.Sheets[sn];
    if (opts.verbose) process.stderr.write(`=== Sheet: ${sn} ===\n`);
    const bs = parseSheet(ws, sn, opts);
    allBrackets.push(...bs);
  }

  if (!allBrackets.length) {
    return {
      error: '認識可能な種目セクションが見つかりませんでした',
      hint: 'シート内に「○種目名」のヘッダー行があるか確認してください',
      available_sheets: wb.SheetNames,
    };
  }

  if (allBrackets.length === 1) {
    return allBrackets[0];
  }

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
    process.stderr.write(
      'Usage: parse_ktta_bracket.js FILE.xlsx [--format singles|doubles|team]\n' +
      '                                       [--event NAME] [--sheet NAME]\n' +
      '                                       [--all-sheets] [-v]\n');
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
