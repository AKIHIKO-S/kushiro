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
const fs = require('fs');

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
function extractSheet(ws, band) {
  if (!ws || !ws['!ref']) return [];
  const R = safeRange(ws);
  const rS = band ? Math.max(R.s.r, band.rStart) : R.s.r;   // セクション分割時の行帯
  const rE = band ? Math.min(R.e.r, band.rEnd) : R.e.r;
  const cand = [];
  const seenName = new Set(); // 氏名セル座標の重複防止
  for (let r = rS; r <= rE; r++) {
    for (let c = R.s.c; c <= R.e.c; c++) {
      const s = cellStr(ws, r, c);
      if (!isIntStr(s)) continue;
      const seed = parseInt(s, 10);
      if (seed < 1 || seed > 600) continue; // seed番号の妥当範囲
      // 向き判定: 右隣が氏名 → 左ブロック / 左側が氏名 → 右ブロック(鏡像)。
      // 右ブロックの氏名位置はレイアウトで c-2 と c-3 の両方があり得る(会長杯=seed@U,氏名@R=c-3)。
      // 固定オフセットだと右ブロックを丸ごと取りこぼすため、c-2→c-3 を順に探す。
      const rName = cellStr(ws, r, c + 1);
      let nameCol, name, team, region;
      if (looksLikeName(rName)) {
        nameCol = c + 1; name = rName;
        team = cleanTeam(cellStr(ws, r, c + 2));
        const reg = cellStr(ws, r, c + 3);
        region = isRegionToken(reg) ? reg : '';
      } else {
        let lc = -1;
        if (looksLikeName(cellStr(ws, r, c - 2))) lc = c - 2;
        else if (looksLikeName(cellStr(ws, r, c - 3))) lc = c - 3;
        if (lc < 0) continue; // seed番号でない(スコア/年号など)
        nameCol = lc; name = cellStr(ws, r, lc);
        team = cleanTeam(cellStr(ws, r, c - 1));
        const reg = cellStr(ws, r, lc - 1);
        region = isRegionToken(reg) ? reg : '';
      }
      const key = r + ':' + nameCol;
      if (seenName.has(key)) continue;
      seenName.add(key);
      cand.push({ seed, name, team, region, _r: r, _c: nameCol, _seedCol: c });
    }
  }
  // 1回戦(リーフ)の seed番号列は連番が密に縦に並ぶ。孤立整数(勝ち上がり位置)を除くため
  // 件数3以上の列のみ採用する。
  const byCol = {};
  cand.forEach(p => { (byCol[p._seedCol] = byCol[p._seedCol] || []).push(p); });
  const dense = Object.keys(byCol).map(Number).filter(c => byCol[c].length >= 3).sort((a, b) => a - b);
  if (!dense.length) return [];
  const picked = [];
  dense.forEach(c => picked.push(...byCol[c]));

  // --- 氏名(正規化)で distinct 統合(過大カウント=二重計上の撲滅) ---
  // 同一シートに同居する「検算名簿/クラブ別ロスター」(全選手を別順で再掲する第2系統)や、
  // 罫線都合で同名が2行に出る複製行、左右ブロックの再掲を、氏名の同一性で畳む。
  // ※seed値ベースの系統判定は「年代別など各ブロックが番号を1から振り直す」構成と区別できず
  //   ブロックを丸ごと落とすため不可。氏名同一性が唯一頑健な信号。
  // ※所属(team)はロスターとブラケットで表記が揺れる(「（ドングリ）」vs「釧友会」, 略称差)ため
  //   キーに含めない。氏名のみを「空白/全角空白を除去」して比較する。
  // 残す代表は「最も左の seed列」のもの: ロスターは常にブラケットの右側に付帯するため、
  // 最左列=ブラケット本体側の組番号(ドロー位置)・所属を保持できる。
  const nkey = (x) => String(x || '').replace(/[\s　・,，.．]/g, '');
  const byName = {};
  picked.forEach(p => {
    const k = nkey(p.name);
    const cur = byName[k];
    if (!cur || p._seedCol < cur._seedCol) byName[k] = p;
  });
  return Object.values(byName);
}

// ダブルス用抽出: seed番号アンカーから「ペア(2名)」を組み立てる。
//  男子=横並び [seed, 氏名1, 氏名2, (所属), 地区] / 女子=縦並び [seed, 氏名1, 所属1] + 次行 [氏名2, 所属2]
function extractDoubles(ws, band) {
  if (!ws || !ws['!ref']) return [];
  const R = safeRange(ws);
  const rS = band ? Math.max(R.s.r, band.rStart) : R.s.r;
  const rE = band ? Math.min(R.e.r, band.rEnd) : R.e.r;
  const cand = [];
  const seenName = new Set();
  const mkTeam = (t1, t2) => {
    t1 = cleanTeam(t1); t2 = cleanTeam(t2);
    if (t1 && t2 && t1 !== t2) return t1 + ' / ' + t2;
    return t1 || t2 || '';
  };
  for (let r = rS; r <= rE; r++) {
    for (let c = R.s.c; c <= R.e.c; c++) {
      const s = cellStr(ws, r, c);
      if (!isIntStr(s)) continue;
      const seed = parseInt(s, 10);
      if (seed < 1 || seed > 600) continue;
      // 左ブロック(seedが左): 氏名1 = c+1
      let dir = 0, n1c = -1;
      if (looksLikeName(cellStr(ws, r, c + 1))) { dir = 1; n1c = c + 1; }
      else if (looksLikeName(cellStr(ws, r, c - 2))) { dir = -1; n1c = c - 2; }
      else continue;
      const name1 = cellStr(ws, r, n1c);
      let name2 = '', team = '', region = '';
      // 判定順が重要: 所属名(スマイルクラブ等)も looksLikeName を通るため、
      //  ① 横ペア(男子): 氏名2の直後が「(所属)」カッコ → これを最優先で確定
      //  ② 縦ペア(女子): 相方が直下の行
      //  ③ カッコ無しの横ペア(保険) / ④ 単独
      const regAmong = (...vals) => { for (const v of vals) if (isRegionToken(v)) return v; return ''; };
      if (dir === 1) {                         // 左ブロック(seedが左)
        const next = cellStr(ws, r, c + 2);    // 氏名2(横) or 所属(縦)
        const next2 = cellStr(ws, r, c + 3);   // (所属)(横) or 空(縦)
        const below = cellStr(ws, r + 1, n1c); // 相方(縦)
        if (looksLikeName(next) && isParenTeam(next2)) {        // ① 横ペア
          name2 = next;
          team = mkTeam(next2, cellStr(ws, r, c + 4));
          region = regAmong(cellStr(ws, r, c + 4), cellStr(ws, r, c + 5));
        } else if (looksLikeName(below)) {                      // ② 縦ペア
          name2 = below;
          team = mkTeam(cellStr(ws, r, c + 2), cellStr(ws, r + 1, c + 2));
          region = regAmong(cellStr(ws, r, c + 3), cellStr(ws, r + 1, c + 3));
        } else if (looksLikeName(next)) {                       // ③ 横ペア(カッコ無し)
          name2 = next; team = cleanTeam(next2);
        } else {                                                // ④ 単独(保険)
          team = cleanTeam(next);
        }
      } else {                                 // 右ブロック(seedが右・鏡像)
        const prev = cellStr(ws, r, c - 3);    // 氏名2(横)
        const prevTeam = cellStr(ws, r, c - 1);// (所属)(横)
        const below = cellStr(ws, r + 1, n1c); // 相方(縦)
        if (looksLikeName(prev) && isParenTeam(prevTeam)) {     // ① 横ペア(鏡像)
          name2 = prev;
          team = mkTeam(prevTeam, cellStr(ws, r, c - 4));
          region = regAmong(cellStr(ws, r, c - 4), cellStr(ws, r, c - 5));
        } else if (looksLikeName(below)) {                      // ② 縦ペア(鏡像)
          name2 = below;
          team = mkTeam(cellStr(ws, r, c - 1), cellStr(ws, r + 1, c - 1));
        } else if (looksLikeName(prev)) {                       // ③ 横ペア(カッコ無し)
          name2 = prev; team = cleanTeam(prevTeam);
        } else {
          team = cleanTeam(prevTeam);
        }
      }
      const key = r + ':' + n1c;
      if (seenName.has(key)) continue;
      seenName.add(key);
      // ペアは name(選手1)/partner_name(選手2) を分離して保持する。"A / B" 結合だと
      // importer(buildEntrantNames)が1名扱いし、相方の脱落・氏名に "/" 混入が起きるため。
      cand.push({ seed, name: name1, partner_name: name2 || '', team, region, _r: r, _c: n1c, _seedCol: c });
    }
  }
  // リーフseed列のみ採用(孤立整数=勝ち上がり位置を除外)
  const byCol = {};
  cand.forEach(p => { (byCol[p._seedCol] = byCol[p._seedCol] || []).push(p); });
  let out = [];
  Object.keys(byCol).forEach(col => { if (byCol[col].length >= 3) out.push(...byCol[col]); });
  // ペアで重複除去: 左右ブロックで A/B と B/A の順違い、勝ち上がりの再掲を、
  // 2名を並べ替えた順序非依存キーで畳み込み、最小seedの1件を残す。
  // name と partner_name の両方から順序非依存キーを作る(A/B と B/A を畳み込む)。
  const pairKey = (p) => [p.name, p.partner_name]
    .map(x => String(x || '').replace(/[\s　]/g, '')).filter(Boolean).sort().join('|');
  const byPair = {};
  out.forEach(p => {
    const k = pairKey(p);
    if (!byPair[k] || p.seed < byPair[k].seed) byPair[k] = p;
  });
  return Object.values(byPair).sort((a, b) => a.seed - b.seed);
}

// 種目名・形式の推定
function guessFormat(sheetName, players, fmtHint) {
  if (fmtHint) return fmtHint;
  // 末尾/先頭の注記【重複管理】(重複の「複」が doubles に誤マッチする)を除去してから判定
  const sn = stripAnnot(sheetName || '');
  if (/団体|チーム.?カップ|団体戦/.test(sn)) return 'team';
  if (/ダブルス|ペア|ミックス|混合/.test(sn)) return 'doubles';
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

// 1シートに複数種目が縦積みされる場合(例「混合ダブルス・男子ダブルス」=混合D+男子D、
// 会長杯「一般女子」=一般女子団体+一般女子シングルス)を、左方の「クリーンな種目見出し」で
// 行帯に分割する。ブロック見出し(「男子シングルスＡブロック」)やラウンド見出しは除外し、
// なごやか亭の単一ブラケット(複数ブロックが連番)を誤分割しない。
const EVENT_HEADER = /^[○●◯◎\s]*((一般|中学生?|高校生?|小学生?|シニア|レディース|オープン|ジュニア|男子|女子|混合|ミックス|団体)[\s・]*)+(シングルス|ダブルス|団体|チーム戦?|戦)?\s*$/;
function isEventHeaderCell(s) {
  if (!s || s.length > 16) return false;
  if (/ブロック|予選|決勝|準決|準々|回戦|ベスト|審判|名簿|一覧|得点|主催|主管|協賛|会場|[Ａ-ＺA-Z]\s*$/.test(s)) return false;
  // 「シングルス/ダブルス/団体」で終わる、または「○男子団体」のような明確な種目見出しのみ
  if (!/(シングルス|ダブルス|団体|チーム)/.test(s)) return false;
  return EVENT_HEADER.test(s);
}
function sheetSections(ws) {
  const R = safeRange(ws);
  const heads = [];
  for (let r = R.s.r; r <= R.e.r; r++) {
    for (let c = R.s.c; c <= Math.min(R.e.c, R.s.c + 4); c++) {
      const s = cellStr(ws, r, c);
      if (!s) continue;
      if (isEventHeaderCell(s)) { heads.push({ r, name: s.replace(/^[○●◯◎\s]+/, '').trim() }); break; }
    }
  }
  if (heads.length < 2) return null; // 単一種目シートは分割しない
  return heads.map((h, i) => ({
    name: h.name,
    rStart: h.r,
    rEnd: (i + 1 < heads.length ? heads[i + 1].r - 1 : R.e.r),
  }));
}

// シート名の注記【重複管理】(検算)(控)等を除去して基底名を得る。
// 重複の「複」が doubles 誤判定を誘発するため format 判定前に剥がす。
// 注記を含む括弧グループ全体を剥がす(例「(重複管理入)」「【重複管理】」「(検算用)」)。
const ANNOT_RE = /[【［(\[（][^】］)\]）]*(重複管理|重複|検算|管理用|控|確認用|チェック|記録用)[^】］)\]）]*[】］)\]）]/g;
function stripAnnot(name) { return String(name || '').replace(ANNOT_RE, '').replace(/\s+/g, ' ').trim(); }
function baseSheetName(name) { return stripAnnot(name).replace(/\s+/g, ''); }

// シート名がブラケットでない(審判/集計/メモ)場合に弾く。
// 注意: 「重複管理」はここで一律除外しない。ニッタク杯は『男子シングルス【重複管理】』が
//       唯一の種目シート(本物)である一方、なごやか亭は『【重複管理】男子シングルス』と
//       クリーンな『男子シングルス』が併存する。後者だけを除外する判定は parseSeedList 側で
//       「同じ基底名のクリーンシートが在るか」で行う(skipDupSheet)。
function isNoiseSheet(name) {
  return /審判|集計|メモ|^Sheet\d*$|名簿管理|参加者一覧|エントリー?一覧/i.test(stripAnnot(name));
}

// メイン: ワークブック → 種目ごとの seed-list
function parseSeedList(filePath, opts = {}) {
  // PDF/非xlsx を渡されたら XLSX.readFile が不可解なエラーで落ちるため、先頭バイトで明示弾き
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(8); fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
    if (head.slice(0, 4).toString('latin1') === '%PDF') {
      throw new Error('PDF入力です。Excel(.xlsx)用パーサです。PDFは parse_pdf_bracket.js を使用してください: ' + filePath);
    }
  } catch (e) { if (/PDF入力です/.test(e.message)) throw e; /* それ以外の読み取り失敗は readFile に委ねる */ }

  const wb = XLSX.readFile(filePath, { cellText: true, cellDates: false });
  const events = [];
  const sheetNames = opts.sheet ? [opts.sheet] : wb.SheetNames;
  // 「重複管理/検算」シートは、同じ基底名のクリーンなシートが別に在る場合のみ除外する。
  const cleanBases = new Set();
  wb.SheetNames.forEach(n => { if (!/重複管理|検算|確認用|チェック/.test(n) && !isNoiseSheet(n)) cleanBases.add(baseSheetName(n)); });
  const skipDupSheet = (n) => /重複管理|検算|確認用|チェック/.test(n) && cleanBases.has(baseSheetName(n));
  // 1イベント分の seed-list を組み立てる(行帯 band 指定可)。失敗時は null。
  function buildEvent(ws, eventName, fmt, band) {
    const players = (fmt === 'doubles') ? extractDoubles(ws, band) : extractSheet(ws, band);
    if (players.length < 2) return null; // ブラケットでない
    const withSeed = players.filter(p => p.seed != null).sort((x, y) => x.seed - y.seed);
    const noSeed = players.filter(p => p.seed == null).sort((x, y) => (x._r - y._r) || (x._c - y._c));
    const ordered = withSeed.concat(noSeed); // seed順 → 取れない者は出現順で後ろ。最後に1..Nを振り直す
    const gender = guessGender(eventName);
    const playersOut = ordered.map((p, i) => {
      const rec = { name: p.name, team: p.team || '', seed: i + 1 };
      if (p.partner_name) { rec.partner_name = p.partner_name; rec.partner_team = p.team || ''; rec.is_doubles = true; }
      if (p.region) rec.region = p.region;
      if (gender) rec.gender = gender;
      rec.category = 'general';
      return rec;
    });
    return { event: eventName, format: fmt, regenerate: true, players: playersOut, _rawSeedCount: withSeed.length };
  }

  for (const sn of sheetNames) {
    if (!opts.sheet && (isNoiseSheet(sn) || skipDupSheet(sn))) continue;
    const ws = wb.Sheets[sn];
    // シート内に複数種目が縦積みなら見出しで行帯分割、なければシート全体を1種目として扱う
    const sections = opts.sheet ? null : sheetSections(ws);
    if (sections) {
      for (const sec of sections) {
        const ev = buildEvent(ws, sec.name, guessFormat(sec.name, [], opts.formatHint), { rStart: sec.rStart, rEnd: sec.rEnd });
        if (ev) events.push(ev);
      }
    } else {
      const name = (opts.eventHint && opts.sheet) ? opts.eventHint : stripAnnot(sn);
      const ev = buildEvent(ws, name, guessFormat(sn, [], opts.formatHint), null);
      if (ev) events.push(ev);
    }
  }
  return { format: 'tabletennis-seed-list-v1', source: 'bracket_excel', events };
}

module.exports = { parseSeedList, extractSheet, looksLikeName, isRegionToken };

if (require.main === module) {
  const f = process.argv[2];
  const out = parseSeedList(f, { sheet: process.argv[3] || null });
  if (!out.events.length) console.log('(イベントなし: ブラケットを検出できませんでした)');
  out.events.forEach(e =>
    console.log(`[${e.event}] fmt=${e.format} players=${e.players.length} (seeded=${e._rawSeedCount})`));
  if (process.argv[4] === '--dump' && out.events[0]) console.log(JSON.stringify(out.events[0].players.slice(0, 10), null, 1));
}
