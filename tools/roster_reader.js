'use strict';
// roster_reader.js — 組合せExcel内の「名簿(ロスター)」情報を集めて、氏名の集合を作る。
//
// 目的: ブラケット抽出結果(seed-list パーサの出力)を、同じブック内に併載される
//   検算名簿・クラブ別ロスター・重複管理シート等と突合し、取りこぼし/過大/表記揺れを検出する
//   (突合本体は import_quality.crossCheck)。ここは「名簿側の氏名を集める」役だけを担う。
//
// 2ソース構成:
//   source='roster_sheet' … 名簿系シート(【重複管理】/検算/参加者 等)の全セルから氏名を収穫
//   source='harvest'      … ブラケットシート内で「氏名が縦に3件以上並ぶ列」から氏名を収穫
//                           (シート右側に併載される検算名簿・クラブ別ロスターを確実に拾う)
//
// 方針: 警告のための材料集めであり、取込は一切変更しない。読み取り失敗は呼び元で握りつぶす。

const fs = require('fs');
const XLSX = require('xlsx');
const {
  looksLikeName, isRegionToken, baseSheetName, isNoiseSheet,
  safeRange, cellStr, cleanTeam, isParenTeam, stripParen,
} = require('./parse_bracket_seedlist');

// 名簿系シートの判定(検算/重複管理/参加者名簿 等)。stripAnnot 前の生シート名で見る。
const ROSTER_SHEET_RE = /重複管理|検算|確認用|チェック|名簿|参加者|エントリー|一覧|人数/;

// 氏名の隣接セル(左右)から所属らしき文字列を拾う。カッコ書き所属 or cleanTeam 非空を採用。
function nearbyTeam(ws, r, c) {
  for (const dc of [1, -1, 2]) {
    const s = cellStr(ws, r, c + dc);
    if (!s) continue;
    if (isParenTeam(s)) return stripParen(s);
    const t = cleanTeam(s);
    if (t && !isRegionToken(t) && !looksLikeName(t)) return t;
  }
  return '';
}
function nearbyRegion(ws, r, c) {
  for (const dc of [1, 2, -1, 3]) {
    const s = cellStr(ws, r, c + dc);
    if (s && isRegionToken(s)) return s;
  }
  return '';
}

// ソース2: ブラケットシート内で「氏名が縦に3件以上並ぶ列」だけを対象に氏名を収穫する。
// 主催者名・会長名など散在ノイズを排除しつつ、右側併載の検算名簿・ロスターを拾う。
function harvestSheet(ws, sheetName, out) {
  const range = safeRange(ws);
  const base = baseSheetName(sheetName);
  // まず列ごとに氏名らしいセルを集める(行番号も保持=縦積みシートの帯対応)。
  const byCol = new Map();
  for (let c = range.s.c; c <= range.e.c; c++) {
    for (let r = range.s.r; r <= range.e.r; r++) {
      const s = cellStr(ws, r, c);
      if (s && looksLikeName(s)) {
        if (!byCol.has(c)) byCol.set(c, []);
        byCol.get(c).push({ r, name: s });
      }
    }
  }
  for (const [c, cells] of byCol) {
    if (cells.length < 3) continue;   // 密度の低い列(散在ノイズ)は捨てる
    for (const { r, name } of cells) {
      out.push({
        name, team: nearbyTeam(ws, r, c), region: nearbyRegion(ws, r, c),
        sheet: sheetName, sheetBase: base, row: r, source: 'harvest',
      });
    }
  }
}

// ソース1: 名簿系シートの全セルから氏名を収穫(密度条件なし=名簿はほぼ氏名だけの列)。
function readRosterSheet(ws, sheetName, out) {
  const range = safeRange(ws);
  const base = baseSheetName(sheetName);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const s = cellStr(ws, r, c);
      if (s && looksLikeName(s)) {
        out.push({
          name: s, team: nearbyTeam(ws, r, c), region: nearbyRegion(ws, r, c),
          sheet: sheetName, sheetBase: base, row: r, source: 'roster_sheet',
        });
      }
    }
  }
}

// メイン: ブックから名簿エントリ(氏名+付帯情報)を集める。
//   戻り値: { entries: [{ name, team, region, sheet, sheetBase, row, source }], error? }
function extractRoster(filePath, opts = {}) {
  // PDF は名簿突合の対象外(v1)。先頭バイトで明示的に弾く。
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (head.toString('latin1') === '%PDF') return { entries: [], error: 'pdf_unsupported' };
  } catch (e) { /* 読み取り失敗は下の readFile に委ねる */ }

  // 登録団体マスタを seed-list パーサの内部状態へ注入(団体名を氏名に誤収穫しない=発生源で抑止)。
  // parseSeedList を軽く呼ぶと _regTeamsSet が張られるが、副作用に依存せず looksLikeName が
  // 見るのは同モジュールのモジュール変数。ここでは registeredTeams を使う経路が無いと弱くなるため、
  // parse_bracket_seedlist の判定関数をそのまま使う(team 混入は crossCheck 側の集合比較で無害化)。
  const wb = XLSX.readFile(filePath, { cellText: true, cellDates: false });
  const entries = [];
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    if (!ws) continue;
    if (ROSTER_SHEET_RE.test(sn)) {
      readRosterSheet(ws, sn, entries);
    } else if (!isNoiseSheet(sn)) {
      harvestSheet(ws, sn, entries);
    }
  }
  return { entries };
}

module.exports = { extractRoster, ROSTER_SHEET_RE };
