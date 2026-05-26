#!/usr/bin/env node
/**
 * KTTA トーナメント PDF パーサー (Node.js / pdfjs-dist)
 * ====================================================
 * テキストPDF (Excel→PDF / Word→PDF など) からトーナメント表を抽出。
 *
 * アルゴリズム:
 *   ① pdfjs で全テキスト要素 + 座標を取得
 *   ② Y座標で行をクラスタリング (Excel の row 相当)
 *   ③ X座標で列をクラスタリング (Excel の col 相当)
 *   ④ Excel と同じ KTTA パーサーロジックを適用
 *
 * 制限:
 *   ・画像PDF (スキャンしたもの) は不可。Excel→PDF などのテキストPDFが対象
 *   ・複雑な merged cell 構造は完全再現できない場合あり (近似)
 *
 * Usage:
 *   node parse_pdf_bracket.js FILE.pdf [--format singles|doubles|team]
 *                                       [--event NAME]
 *                                       [-v]
 */
'use strict';

const fs = require('fs');
const path = require('path');

// pdfjs v4+ は ESM。legacy ビルドの mjs を動的 require で読む。
let pdfjsLib = null;
async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsLib;
}

const SECTION_HEADER_RE = /^\s*[○◯◎●]\s*(.+?)\s*$/;
const TEAM_KEYWORDS = ['団体', 'チーム'];
const DOUBLES_KEYWORDS = ['ダブルス', 'ミックス', '混合', 'ペア'];
const LABELS = new Set([
  '氏名', '所属', '選手名', '団体名', 'チーム名', 'メンバー',
  '代表者', '選手', 'ペア', 'ダブルス', 'シングルス',
  '決勝', '準決勝', '準々決勝', 'ベスト16', 'ベスト32',
  'BYE', 'bye', '不戦勝', '棄権',
]);
const PARENS_RE = /^[(（]\s*(.*?)\s*[)）]$/;

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

// ─── PDF → テキスト要素配列 ─────────────────
// 戻り値: [{ str, x, y, width, page }, ...]
async function extractTextItems(pdfBuffer) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  const items = [];
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const page = await doc.getPage(pn);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    content.items.forEach(item => {
      if (!item.str || !item.str.trim()) return;
      // transform: [a, b, c, d, e, f]; e=x, f=y (PDF coordinates, origin = bottom-left)
      const tx = item.transform;
      const x = tx[4];
      const yPdf = tx[5];
      // 上下反転 (top-left origin にする)
      const y = viewport.height - yPdf;
      items.push({
        str: item.str.trim(),
        x, y,
        width: item.width || 0,
        height: item.height || (tx[3] || 10),
        page: pn,
      });
    });
  }
  return items;
}

// ─── Y座標で行 (rows) にクラスタリング ───────
// 同じ「行」とみなす Y 差は ~ フォント高の 0.5倍
function clusterToRows(items, yTolerance) {
  // ページごとにソート
  const byPage = {};
  items.forEach(it => {
    if (!byPage[it.page]) byPage[it.page] = [];
    byPage[it.page].push(it);
  });
  const allRows = [];
  Object.keys(byPage).sort((a, b) => +a - +b).forEach(pn => {
    const pageItems = byPage[pn].slice().sort((a, b) => a.y - b.y);
    let currentRow = null;
    pageItems.forEach(it => {
      const tol = yTolerance || (it.height * 0.6);
      if (currentRow && Math.abs(currentRow.y - it.y) <= tol) {
        currentRow.items.push(it);
      } else {
        currentRow = { y: it.y, page: it.page, items: [it] };
        allRows.push(currentRow);
      }
    });
  });
  // 各行内で X 順
  allRows.forEach(row => row.items.sort((a, b) => a.x - b.x));
  return allRows;
}

// ─── 列 (columns) を統一的に検出 ────────────
// 全行の全項目の X 座標を集計し、近いものを同じ列にクラスタリング
function detectColumns(rows, xTolerance) {
  const xs = [];
  rows.forEach(r => r.items.forEach(it => xs.push(it.x)));
  xs.sort((a, b) => a - b);
  if (!xs.length) return [];
  const cols = [xs[0]];
  const tol = xTolerance || 8;
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - cols[cols.length - 1] > tol) {
      cols.push(xs[i]);
    } else {
      // 同じ列とみなす — 平均値を更新
      cols[cols.length - 1] = (cols[cols.length - 1] + xs[i]) / 2;
    }
  }
  return cols;
}

// 各 row の items を列インデックスに割当てる → grid 形式に
// 戻り値: [{ y, page, cells: [str|null, str|null, ...] }, ...]
function rowsToGrid(rows, cols, xTolerance) {
  const tol = xTolerance || 12;
  return rows.map(row => {
    const cells = new Array(cols.length).fill(null);
    row.items.forEach(it => {
      // 最近接の列を探す
      let bestI = 0, bestDist = Math.abs(it.x - cols[0]);
      for (let i = 1; i < cols.length; i++) {
        const d = Math.abs(it.x - cols[i]);
        if (d < bestDist) { bestDist = d; bestI = i; }
      }
      if (bestDist > tol) {
        // 既存列にフィットしない → 新規列追加扱い (rare)
        return;
      }
      // 既に値があれば結合
      cells[bestI] = (cells[bestI] ? cells[bestI] + ' ' : '') + it.str;
    });
    return { y: row.y, page: row.page, cells };
  });
}

// ─── セクション (○種目名) を grid から検出 ───
function findSectionsInGrid(grid) {
  const sections = [];
  grid.forEach((r, i) => {
    for (const cell of r.cells) {
      if (!cell) continue;
      const m = SECTION_HEADER_RE.exec(cell);
      if (m) {
        sections.push({ start: i, event: m[1].trim() });
        break;
      }
    }
  });
  const result = [];
  for (let i = 0; i < sections.length; i++) {
    const end = i + 1 < sections.length ? sections[i + 1].start - 1 : grid.length - 1;
    result.push({ start: sections[i].start, end, event: sections[i].event });
  }
  return result;
}

// ─── grid から KTTA パーサーと同じロジックで選手抽出 ────
// PDF からは merged cell の概念は無いので、近接行をマージする発見的ロジック
function parseSinglesFromGrid(grid, section) {
  const players = [];
  const { start, end } = section;

  // grid のセル列マッピングを仮定:
  //   col 0: position 番号 (数字)
  //   col 1: 名前
  //   col 2: 所属 (parens)
  //   col 3〜: 他の列 (省略可)
  //   末尾: 右側エントリーリスト

  // (A) 左半分: col 0 が数字の行を選手として抽出
  for (let i = start + 1; i <= end; i++) {
    const r = grid[i];
    if (!r || !r.cells || r.cells.length < 2) continue;
    const posCell = r.cells[0];
    if (!posCell || !/^\d+$/.test(String(posCell).trim())) continue;
    // 名前は col 1
    const nameCell = r.cells[1];
    const teamCell = r.cells[2] || r.cells[3] || '';
    const name = normalizeName(nameCell);
    if (!name || isLabelLike(name)) continue;
    const team = stripParens(teamCell);
    players.push({
      name, team,
      seed: parseInt(posCell),
    });
  }

  // (B) 右半分: 同じ行に2セット目の数字がある場合 (右ブラケットリスト)
  // ヒューリスティック: 各行の中盤以降に数字+名前+所属パターンがあるか探す
  for (let i = start + 1; i <= end; i++) {
    const r = grid[i];
    if (!r || !r.cells) continue;
    // 後半セル群を見て、数字 + 名前 (日本語) + (所属) のパターンを探す
    for (let c = Math.floor(r.cells.length / 2); c < r.cells.length - 1; c++) {
      const cell = r.cells[c];
      if (!cell || !/^\d+$/.test(String(cell).trim())) continue;
      // 数字の次のセルが名前
      const nameC = r.cells[c + 1];
      const teamC = r.cells[c + 2] || '';
      const name = normalizeName(nameC);
      if (!name || isLabelLike(name)) continue;
      // 既に出ているかチェック
      const team = stripParens(teamC);
      const existing = players.find(p => p.name === name && p.team === team);
      if (existing) continue;
      players.push({ name, team, seed: parseInt(cell) });
      break;
    }
  }

  players.sort((a, b) =>
    (a.seed || 9999) - (b.seed || 9999) || a.name.localeCompare(b.name, 'ja'));
  return players;
}

// 団体戦: position 番号ごとにブロック化、メンバー名を集める
function parseTeamFromGrid(grid, section) {
  const teams = [];
  const { start, end } = section;
  // position 番号で区切る
  const blocks = [];
  let cur = null;
  for (let i = start + 1; i <= end; i++) {
    const r = grid[i];
    if (!r || !r.cells) continue;
    const posCell = r.cells[0];
    if (posCell && /^\d+$/.test(String(posCell).trim())) {
      if (cur) blocks.push(cur);
      cur = { pos: parseInt(posCell), name: r.cells[1] || '', rows: [r] };
    } else if (cur) {
      cur.rows.push(r);
    }
  }
  if (cur) blocks.push(cur);

  for (const block of blocks) {
    const teamName = normalizeName(block.name);
    if (!teamName || isLabelLike(teamName)) continue;
    const members = [];
    block.rows.forEach(r => {
      // 名前候補: col 2, 3 (チーム戦は複数列にメンバー名)
      for (let c = 2; c < Math.min(8, r.cells.length); c++) {
        const v = r.cells[c];
        const nm = normalizeName(v);
        if (nm && !isLabelLike(nm) && !members.includes(nm) &&
            !PARENS_RE.test(nm) && nm.length >= 2 && nm.length <= 12) {
          members.push(nm);
        }
      }
    });
    teams.push({
      name: teamName,
      team: teamName,
      seed: block.pos,
      is_team: true,
      members,
    });
  }
  teams.sort((a, b) =>
    (a.seed || 9999) - (b.seed || 9999) || a.name.localeCompare(b.name, 'ja'));
  return teams;
}

// ダブルス: 連続2行で1ペア
function parseDoublesFromGrid(grid, section) {
  const players = [];
  const { start, end } = section;
  for (let i = start + 1; i <= end; i++) {
    const r = grid[i];
    if (!r || !r.cells) continue;
    const posCell = r.cells[0];
    if (!posCell || !/^\d+$/.test(String(posCell).trim())) continue;
    const n1 = normalizeName(r.cells[1]);
    const n2 = i + 1 <= end ? normalizeName(grid[i + 1].cells[1]) : '';
    const team = stripParens(r.cells[2] || r.cells[3] || '');
    const pairName = (n1 && n2 && n1 !== n2) ? n1 + '/' + n2 : (n1 || n2);
    if (pairName && !isLabelLike(pairName)) {
      players.push({
        name: pairName,
        name1: n1, name2: n2,
        team,
        is_doubles: true,
        seed: parseInt(posCell),
      });
    }
  }
  players.sort((a, b) =>
    (a.seed || 9999) - (b.seed || 9999) || a.name.localeCompare(b.name, 'ja'));
  return players;
}

// ─── メイン ─────────────────────────────
async function parsePdfBuffer(pdfBuffer, opts) {
  opts = opts || {};
  const items = await extractTextItems(pdfBuffer);
  if (!items.length) {
    return { error: 'PDF からテキストを抽出できませんでした (画像PDFの可能性)。' +
      'Excel ファイルまたはテキスト形式の PDF をご利用ください。' };
  }
  const rows = clusterToRows(items);
  const cols = detectColumns(rows);
  const grid = rowsToGrid(rows, cols);
  if (opts.verbose) {
    process.stderr.write(`Pages: ${Math.max(...items.map(i => i.page))}\n`);
    process.stderr.write(`Items: ${items.length}, Rows: ${rows.length}, Cols: ${cols.length}\n`);
  }

  let sections = findSectionsInGrid(grid);
  if (!sections.length) {
    sections = [{ start: 0, end: grid.length - 1, event: opts.eventHint || 'PDF 取込' }];
  }
  if (opts.verbose) {
    process.stderr.write(`Sections: ${sections.map(s => s.event).join(', ')}\n`);
  }

  const brackets = [];
  for (const sec of sections) {
    const fmt = detectFormat(sec.event, opts.formatHint);
    let players;
    if (fmt === 'team') players = parseTeamFromGrid(grid, sec);
    else if (fmt === 'doubles') players = parseDoublesFromGrid(grid, sec);
    else players = parseSinglesFromGrid(grid, sec);
    if (!players.length) {
      if (opts.verbose) {
        process.stderr.write(`Section '${sec.event}' produced 0 players\n`);
      }
      continue;
    }
    brackets.push({
      format: 'tabletennis-seed-list-v1',
      event: sec.event,
      type: fmt,
      regenerate: true,
      auto_link_to_players: false,
      players,
    });
  }

  if (!brackets.length) {
    return {
      error: '認識可能なトーナメント構造が見つかりませんでした',
      hint: 'PDF が標準形式 (○種目名、位置番号+選手名+所属) か確認してください',
      detected: { rows: rows.length, cols: cols.length, sections: sections.length },
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
