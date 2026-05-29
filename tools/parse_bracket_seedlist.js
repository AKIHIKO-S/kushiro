/*
 * parse_bracket_seedlist.js — 実トーナメント表(組合せExcel)から「シード順の選手リスト」を抽出する。
 *
 * 出力は platform の取込形式 tabletennis-seed-list-v1 に合わせる:
 *   { events: [ { event, format, players: [{ name, team, region, seed }], regenerate:true } ] }
 *
 * 設計方針 (実データ駆動):
 *  - VICTAS杯/なごやか亭杯/会長杯 等の「組合せ」Excel は、ブロックごとに
 *    [seed#, 氏名, (所属), 地区]  (左ブロック)  /  [地区, 氏名, (所属), seed#]  (右ブロック)
 *    という4列セットが横に多数並ぶ。氏名は必ず「(所属)」セルの左隣にある。
 *  - そこで「(所属)」のカッコ書きセルをアンカーにし、左隣=氏名、両脇の整数=seed#、
 *    残りの地区トークン=地区、として抽出する。
 *  - カッコ無し所属にも備え、seed# 列(連番整数が縦に並ぶ列)をアンカーにする副系統も持つ。
 *  - 罫線/結合は使わず「内容」で判定するため、表のレイアウト差異に強い。
 */
'use strict';
const XLSX = require('xlsx');

// 北海道の地区(支部)トークン。組合せ表で氏名脇に出る「地区」列の判定に使う。
const REGION_TOKENS = [
  '釧路', '十勝', '札幌', '北見', '根室', '名寄', '斜里', '千歳', '苫小牧', '帯広',
  '旭川', '函館', '室蘭', '小樽', '岩見沢', '網走', '稚内', '留萌', '空知', '日高',
  '後志', '檜山', '宗谷', '上川', '十勝支部', '釧路支部', '帯広卓球協会',
];
// ブロック見出し・構造語(氏名と誤認しないよう除外)
// 注意: 年/月/日 のような単漢字は氏名(朝日・美月 等)に頻出するため入れない。
//       日付は looksLikeName 内で「数字+年月日」のパターンとして別途除外する。
const STRUCT_WORDS = /(ブロック|決勝|準決|準々|回戦|ベスト|シングルス|ダブルス|団体|男子|女子|混合|ミックス|オープン|VICTAS|大会|会場|予選|本戦|本選|トーナメント|組合せ|組み合わせ|シード|審判|相互|初戦|以後|得点|主催|主管|協賛|後援|km|TEL|FAX)/;

function colLetter(c) { return XLSX.utils.encode_col(c); }

// セル値を文字列で取得(表示テキスト優先)
function cellStr(ws, r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return '';
  const v = (cell.w != null ? cell.w : cell.v);
  return v == null ? '' : String(v).replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
}

function isIntStr(s) { return /^\d{1,3}$/.test(s); }
function isParenTeam(s) { return /^[（(].*[)）]$/.test(s) && s.length >= 3; }
function stripParen(s) { return s.replace(/^[（(]\s*/, '').replace(/\s*[)）]$/, '').trim(); }
function isRegionToken(s) {
  if (!s) return false;
  if (REGION_TOKENS.includes(s)) return true;
  // "釧路/北見" "十勝・根室" のような複合地区(ダブルスのペア地区)も地区扱い
  if (/^[一-鿿]{2,4}([\/・･][一-鿿]{2,4})+$/.test(s)) {
    return s.split(/[\/・･]/).every(p => REGION_TOKENS.includes(p));
  }
  return false;
}
// 氏名らしさ: 日本語を含み、構造語/地区/数字/カッコ単独でなく、適度な長さ
function looksLikeName(s) {
  if (!s) return false;
  if (s.length < 2 || s.length > 24) return false;
  if (isIntStr(s) || isParenTeam(s)) return false;
  if (isRegionToken(s)) return false;
  if (STRUCT_WORDS.test(s)) return false;
  // 日付/スコア/記号のみは除外
  if (/^[\d\/\-:.\s]+$/.test(s)) return false;
  // 日付文字列(数字+年月日)は氏名でない。例: 2025年5月3日
  if (/\d/.test(s) && /[年月日時]/.test(s)) return false;
  // 日本語(漢字/かな)を含む。ダブルスは "姓 名 / 姓 名" の形もある
  if (!/[぀-ヿ一-鿿]/.test(s)) return false;
  return true;
}

// チーム名らしさ(氏名/数字/地区/構造語でない短文字列。カッコは剥がして判定)
function cleanTeam(s) {
  const t = stripParen(s);
  if (!t) return '';
  if (isIntStr(t) || isRegionToken(t)) return '';
  return t;
}

// 1シートから選手候補を抽出。
// 戦略: seed番号(整数)セルをアンカーにし、左ブロックは [seed, 氏名, 所属, 地区]、
//       右ブロックは [地区, 氏名, 所属, seed] という並びを「向き判定」で読む。
//       これにより (所属)カッコ有り(男子)・無し(女子)・地区列の有無 を統一的に扱える。
function extractSheet(ws) {
  if (!ws || !ws['!ref']) return [];
  const R = XLSX.utils.decode_range(ws['!ref']);
  const cand = [];
  const seenName = new Set(); // 氏名セル座標の重複防止
  for (let r = R.s.r; r <= R.e.r; r++) {
    for (let c = R.s.c; c <= R.e.c; c++) {
      const s = cellStr(ws, r, c);
      if (!isIntStr(s)) continue;
      const seed = parseInt(s, 10);
      if (seed < 1 || seed > 600) continue; // seed番号の妥当範囲
      // 向き判定: 右隣が氏名 → 左ブロック / そうでなく2つ左が氏名 → 右ブロック
      const rName = cellStr(ws, r, c + 1);
      const lName = cellStr(ws, r, c - 2);
      let nameCol, name, team, region;
      if (looksLikeName(rName)) {
        nameCol = c + 1; name = rName;
        team = cleanTeam(cellStr(ws, r, c + 2));
        const reg = cellStr(ws, r, c + 3);
        region = isRegionToken(reg) ? reg : '';
      } else if (looksLikeName(lName)) {
        nameCol = c - 2; name = lName;
        team = cleanTeam(cellStr(ws, r, c - 1));
        const reg = cellStr(ws, r, c - 3);
        region = isRegionToken(reg) ? reg : '';
      } else {
        continue; // seed番号でない(スコア/年号など)
      }
      const key = r + ':' + nameCol;
      if (seenName.has(key)) continue;
      seenName.add(key);
      cand.push({ seed, name, team, region, _r: r, _c: nameCol, _seedCol: c });
    }
  }
  // 1回戦(リーフ)の seed番号列は連番が密に縦に並ぶ。勝ち上がりの位置番号など
  // 孤立した整数は誤検出になるため、seed番号列ごとに件数を数え、密な列のみ採用する。
  const byCol = {};
  cand.forEach(p => { (byCol[p._seedCol] = byCol[p._seedCol] || []).push(p); });
  const out = [];
  Object.keys(byCol).forEach(col => {
    const arr = byCol[col];
    if (arr.length >= 3) out.push(...arr); // リーフ seed 列のみ(孤立整数を除外)
  });
  return out;
}

// 種目名・形式の推定
function guessFormat(sheetName, players, fmtHint) {
  if (fmtHint) return fmtHint;
  const sn = sheetName || '';
  if (/団体/.test(sn)) return 'team';
  if (/ダブルス|複|ペア|ミックス/.test(sn)) return 'doubles';
  // 氏名に "/" "・" が多ければダブルス
  const pair = players.filter(p => /[\/・]/.test(p.name)).length;
  if (players.length && pair / players.length > 0.5) return 'doubles';
  return 'singles';
}
function guessGender(sheetName) {
  const sn = sheetName || '';
  if (/女子|女/.test(sn)) return 'female';
  if (/男子|男/.test(sn)) return 'male';
  return '';
}

// シート名がブラケットでない(審判/集計/メモ)場合に弾く
function isNoiseSheet(name) {
  return /審判|集計|メモ|Sheet\d*|データ|一覧表|名簿管理|重複管理/i.test(name || '');
}

// メイン: ワークブック → 種目ごとの seed-list
function parseSeedList(filePath, opts = {}) {
  const wb = XLSX.readFile(filePath, { cellText: true, cellDates: false });
  const events = [];
  const sheetNames = opts.sheet ? [opts.sheet] : wb.SheetNames;
  for (const sn of sheetNames) {
    if (!opts.sheet && isNoiseSheet(sn)) continue;
    const ws = wb.Sheets[sn];
    let players = extractSheet(ws);
    if (players.length < 2) continue; // ブラケットでない
    // seed が取れた選手は seed 順、取れない選手は出現順(行→列)で後ろに
    const withSeed = players.filter(p => p.seed != null).sort((x, y) => x.seed - y.seed);
    const noSeed = players.filter(p => p.seed == null)
      .sort((x, y) => (x._r - y._r) || (x._c - y._c));
    // seed の重複/欠落をならし、最終的に 1..N の連番を振り直す(取込形式に合わせる)
    const ordered = withSeed.concat(noSeed);
    const fmt = guessFormat(sn, ordered, opts.formatHint);
    const gender = guessGender(sn);
    const playersOut = ordered.map((p, i) => {
      const rec = { name: p.name, team: p.team || '', seed: i + 1 };
      if (p.region) rec.region = p.region;
      if (gender) rec.gender = gender;
      rec.category = 'general';
      return rec;
    });
    events.push({
      event: (opts.eventHint && opts.sheet) ? opts.eventHint : sn.trim(),
      format: fmt,
      regenerate: true,
      players: playersOut,
      _rawSeedCount: withSeed.length,
    });
  }
  return { format: 'tabletennis-seed-list-v1', source: 'bracket_excel', events };
}

module.exports = { parseSeedList, extractSheet, looksLikeName, isRegionToken };

if (require.main === module) {
  const f = process.argv[2];
  const out = parseSeedList(f, { sheet: process.argv[3] || null });
  out.events.forEach(e =>
    console.log(`[${e.event}] fmt=${e.format} players=${e.players.length} (seeded=${e._rawSeedCount})`));
  if (process.argv[4] === '--dump') console.log(JSON.stringify(out.events[0].players.slice(0, 10), null, 1));
}
