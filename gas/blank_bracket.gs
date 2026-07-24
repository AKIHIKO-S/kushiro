// ═══════════════════════════════════════════════════════════════
// 白紙トーナメント表(罫線のみ) 自動作成 - Google Apps Script 単体ツール
// ═══════════════════════════════════════════════════════════════
//
// 旧「トーナメント作成ソフトfor_mac.xls」の罫線自動描画(HYOUGUMI)の後継。
// 人数を入れるだけで、標準シード配置のBYE(長い罫線)込みの空トーナメント表を
// スプレッドシートに描く。氏名・所属は空欄=手書き/直接入力用。
// 配置アルゴリズムは KTTA-Platform (db.js bracketPositions / reports.js
// buildBlankBracketXlsx) と同一。大きな大会(129名以上)はプラットフォーム側の
// 「白紙トーナメント表」を使うこと(こちらは1シート1山の128名まで)。
//
// 【セットアップ手順】
// 1. Google スプレッドシートを新規作成
// 2. 拡張機能 > Apps Script を開く
// 3. このコード全体をコピーして Code.gs に貼り付け
// 4. 保存(Ctrl+S)後、関数選択で「onOpen」を選んで ▶実行(初回のみ権限承認)
// 5. スプレッドシートに戻ると「トーナメント表」メニューが出る
//    → 「罫線を作成」→ 人数と種目名を入力 → 新しいシートに表が描かれる
//
// 大会名・日付・会場はシート左上の空きセルに直接入力すればよい。
// ═══════════════════════════════════════════════════════════════

/* ────────────────────────────────────────────────
 * 純関数部 (Node側の回帰テスト test/gas-blank-bracket.test.js と共有。
 *           SpreadsheetApp に依存しないこと)
 * ──────────────────────────────────────────────── */

// 卓球/テニスの紙トーナメント表の標準配置(KTTA-Platform db.js と同一アルゴリズム)。
// 戻り値: positions[物理スロット] = 標準シードランク。隣接ペアが1回戦の対戦カード。
function bracketPositions(size) {
  if (size <= 1) return [1];
  var arr = [1, 2];
  while (arr.length < size) {
    var next = [];
    var sum = arr.length * 2 + 1;   // このラウンドの上下ペア和(外側=上位・内側=下位)
    for (var i = 0; i < arr.length; i++) {
      if (i % 2 === 0) { next.push(arr[i]); next.push(sum - arr[i]); }
      else { next.push(sum - arr[i]); next.push(arr[i]); }   // 蛇行: 外側に上位を残す
    }
    arr = next;
  }
  return arr;
}

// 白紙トーナメント表のジオメトリ計算。描画APIに依存しない中間表現を返す。
//   values : rows×cols の2次元配列(文字列)
//   merges : [{r,c,nr,nc}] 0始まり
//   hlines : [{r,c1,c2,thick}] セル(r,c1..c2)の「下罫線」
//   vlines : [{c,r1,r2,side}] セル(r1..r2,c)の左("L")/右("R")罫線
//   colWidths : ピクセル幅(index=列)
function computeBlankBracket(N, opts) {
  opts = opts || {};
  N = Number(N);
  if (!(Number.isInteger ? Number.isInteger(N) : (typeof N === "number" && isFinite(N) && Math.floor(N) === N)) || N < 2 || N > 128) {
    throw new Error("人数は 2〜128 の整数で指定してください(129名以上はプラットフォーム側を使用)");
  }
  var S = Math.pow(2, Math.ceil(Math.log(N) / Math.LN2));
  var totalR = Math.max(1, Math.round(Math.log(S) / Math.LN2));   // ブロック内ラウンド数
  var sideR = totalR - 1;                                          // 片山の横線ラウンド数
  var TOP = 4;                                                     // ヘッダ行ぶんのオフセット

  // 列レイアウト(KTTA-Platform reports.js と同じ両山構成)
  var L_NUM = 0, L_NAME = 1, L_TEAM = 2, L_SEED = 3;
  var CENTER = 4 + sideR;
  var R_SEED = CENTER + sideR + 1, R_TEAM = R_SEED + 1, R_NAME = R_SEED + 2, R_NUM = R_SEED + 3;
  var LADV = function (r) { return 3 + r; };                 // 左 round r の横線列
  var RADV = function (r) { return CENTER + (sideR - r + 1); }; // 右(中央寄りが大きいr)
  var cols = R_NUM + 1;

  var positions = bracketPositions(S);
  var leafReal = [];
  for (var g = 0; g < S; g++) leafReal.push(positions[g] <= N);

  // レール行割当(実選手のみ連番・2行ずつ)。railLine[g] = 選手レール(下罫線)の行
  var railLine = new Array(S).fill ? new Array(S).fill(null) : [];
  for (var z = 0; z < S; z++) railLine[z] = null;
  var maxLeafBottom = TOP + 1;
  function assignRails(from, to) {
    var row = TOP;
    for (var g2 = from; g2 < to; g2++) {
      if (!leafReal[g2]) continue;
      railLine[g2] = row + 1;
      if (row + 1 > maxLeafBottom) maxLeafBottom = row + 1;
      row += 2;
    }
  }
  if (S === 2) assignRails(0, S);
  else { assignRails(0, S / 2); assignRails(S / 2, S); }

  var rows = maxLeafBottom + 3;
  var values = [];
  for (var rr = 0; rr < rows; rr++) { var line = []; for (var cc = 0; cc < cols; cc++) line.push(""); values.push(line); }
  var merges = [], hlines = [], vlines = [];

  // ヘッダ(大会名・日付・会場は空欄=あとで直接入力)
  var ev = String(opts.event || "").replace(/^\s+|\s+$/g, "");
  values[1][L_NAME] = (ev ? ev + "  " : "") + "トーナメント表";
  values[2][CENTER] = "決勝";

  // 選手リーフ(枠番号は紙の作法どおり上から 1..N。氏名・所属は空欄)
  var num = 0;
  for (var g3 = 0; g3 < S; g3++) {
    if (!leafReal[g3]) continue;
    num += 1;
    var top = railLine[g3] - 1;
    var side = (S === 2 || g3 < S / 2) ? "L" : "R";
    var NUM = side === "L" ? L_NUM : R_NUM;
    values[top][NUM] = String(num);
    merges.push({ r: top, c: NUM, nr: 2, nc: 1 });
    // 選手レール(下罫線): 氏名〜シード列(山により左右)
    var c1 = side === "L" ? L_NAME : R_SEED, c2 = side === "L" ? L_SEED : R_NAME;
    hlines.push({ r: railLine[g3], c1: c1, c2: c2, thick: false });
  }

  // 1回戦(小さい山 or 不戦勝の線延長)
  var matchState = [];
  for (var p = 0; p < S / 2; p++) {
    var y1 = railLine[2 * p], y2 = railLine[2 * p + 1];
    var row2 = null;
    if (y1 != null && y2 != null) row2 = Math.round((y1 + y2) / 2);
    else if (y1 != null || y2 != null) row2 = (y1 != null ? y1 : y2);
    matchState.push(row2);
    if (row2 == null || totalR < 2) continue;
    var side1 = p < S / 4 ? "L" : "R";
    var col1 = side1 === "L" ? LADV(1) : RADV(1);
    if (y1 != null && y2 != null) {
      vlines.push({ c: col1, r1: Math.min(y1, y2) + 1, r2: Math.max(y1, y2), side: side1 });
      hlines.push({ r: row2, c1: col1, c2: col1, thick: false });
    } else {
      hlines.push({ r: row2, c1: col1, c2: col1, thick: false });   // 不戦勝の長い罫線
    }
  }

  // 2回戦〜準決勝
  var prev = matchState;
  for (var r3 = 2; r3 <= totalR - 1; r3++) {
    var cnt = S / Math.pow(2, r3);
    var cur = [];
    for (var p2 = 0; p2 < cnt; p2++) {
      var a = prev[2 * p2], b = prev[2 * p2 + 1];
      var side2 = p2 < cnt / 2 ? "L" : "R";
      var col2 = side2 === "L" ? LADV(r3) : RADV(r3);
      var row3 = null;
      if (a != null && b != null) {
        row3 = Math.round((a + b) / 2);
        vlines.push({ c: col2, r1: Math.min(a, b) + 1, r2: Math.max(a, b), side: side2 });
        hlines.push({ r: row3, c1: col2, c2: col2, thick: false });
      } else if (a != null || b != null) {
        row3 = (a != null ? a : b);
        hlines.push({ r: row3, c1: col2, c2: col2, thick: false });
      }
      cur.push(row3);
    }
    prev = cur;
  }

  // 決勝(中央線)。左右の山の高さが違えば縦線で中央へ接続する
  if (S > 2) {
    var aL = prev[0], aR = prev[1];
    var rowF = null;
    if (aL != null && aR != null) rowF = Math.round((aL + aR) / 2);
    else if (aL != null || aR != null) rowF = (aL != null ? aL : aR);
    if (rowF != null) {
      hlines.push({ r: rowF, c1: CENTER, c2: CENTER, thick: true });
      if (aL != null && aL !== rowF) vlines.push({ c: CENTER, r1: Math.min(aL, rowF) + 1, r2: Math.max(aL, rowF), side: "L" });
      if (aR != null && aR !== rowF) vlines.push({ c: CENTER, r1: Math.min(aR, rowF) + 1, r2: Math.max(aR, rowF), side: "R" });
    }
  } else {
    // S=2 退化: レール行から直接決勝線の高さを決める(プラットフォームと同じ)
    var rl = [];
    for (var g4 = 0; g4 < S; g4++) if (railLine[g4] != null) rl.push(railLine[g4]);
    var anchor = rl.length >= 2 ? Math.round((rl[0] + rl[rl.length - 1]) / 2) : TOP + 1;
    hlines.push({ r: anchor, c1: CENTER, c2: CENTER, thick: true });
  }

  // 列幅(px)
  var colWidths = [];
  for (var c3 = 0; c3 < cols; c3++) colWidths.push(70);   // 横線列の既定
  colWidths[L_NUM] = 28; colWidths[L_NAME] = 110; colWidths[L_TEAM] = 80; colWidths[L_SEED] = 28;
  colWidths[CENTER] = 110;
  colWidths[R_SEED] = 28; colWidths[R_TEAM] = 80; colWidths[R_NAME] = 110; colWidths[R_NUM] = 28;

  return { rows: rows, cols: cols, values: values, merges: merges, hlines: hlines, vlines: vlines,
    colWidths: colWidths, S: S, N: N, CENTER: CENTER };
}

/* ────────────────────────────────────────────────
 * Google Apps Script 部 (スプレッドシートへの描画)
 * ──────────────────────────────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu("トーナメント表")
    .addItem("罫線を作成", "drawBlankBracket")
    .addToUi();
}

function drawBlankBracket() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt("白紙トーナメント表", "人数(2〜128)を入力してください", ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var n = Number(String(res.getResponseText()).replace(/^\s+|\s+$/g, ""));
  if (!(isFinite(n) && Math.floor(n) === n) || n < 2 || n > 128) {
    ui.alert("人数は 2〜128 の整数で指定してください(129名以上はプラットフォームの「白紙トーナメント表」を使用)");
    return;
  }
  var res2 = ui.prompt("種目名(任意・空欄可)", "例: 男子シングルス", ui.ButtonSet.OK_CANCEL);
  if (res2.getSelectedButton() !== ui.Button.OK) return;
  var ev = String(res2.getResponseText()).replace(/^\s+|\s+$/g, "");

  var g = computeBlankBracket(n, { event: ev });
  renderBlankBracket(g, (ev || "白紙") + " " + n + "名");
}

function renderBlankBracket(g, baseName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = baseName, i = 2;
  while (ss.getSheetByName(name)) name = baseName + "(" + (i++) + ")";
  var sh = ss.insertSheet(name);

  sh.getRange(1, 1, g.rows, g.cols).setValues(g.values)
    .setFontSize(9).setVerticalAlignment("middle");
  for (var m = 0; m < g.merges.length; m++) {
    var mg = g.merges[m];
    sh.getRange(mg.r + 1, mg.c + 1, mg.nr, mg.nc).merge();
  }
  for (var hh = 0; hh < g.hlines.length; hh++) {
    var L = g.hlines[hh];
    sh.getRange(L.r + 1, L.c1 + 1, 1, L.c2 - L.c1 + 1).setBorder(null, null, true, null, null, null,
      "black", L.thick ? SpreadsheetApp.BorderStyle.SOLID_MEDIUM : SpreadsheetApp.BorderStyle.SOLID);
  }
  for (var vv = 0; vv < g.vlines.length; vv++) {
    var V = g.vlines[vv];
    sh.getRange(V.r1 + 1, V.c + 1, V.r2 - V.r1 + 1, 1).setBorder(null, V.side === "L", null, V.side === "R", null, null,
      "black", SpreadsheetApp.BorderStyle.SOLID);
  }
  for (var c = 0; c < g.colWidths.length; c++) sh.setColumnWidth(c + 1, g.colWidths[c]);
  // 枠番号列は中央寄せ・ヘッダは太字
  sh.getRange(1, 1, g.rows, 1).setHorizontalAlignment("center");
  sh.getRange(1, g.cols, g.rows, 1).setHorizontalAlignment("center");
  sh.getRange(2, 2).setFontWeight("bold").setFontSize(12);
  sh.getRange(3, g.CENTER + 1).setFontWeight("bold");
  sh.setHiddenGridlines(true);
  ss.setActiveSheet(sh);
}

/* Node回帰テスト用(GAS実行時は module が無いので素通り) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { bracketPositions: bracketPositions, computeBlankBracket: computeBlankBracket };
}
