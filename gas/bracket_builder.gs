/**
 * 空トーナメント表 作成ツール (Google スプレッドシート版)
 * ── 「トーナメント作成ソフト for_mac.xls」の表作成機能をスプレッドシートで再現したもの
 *
 * 使い方:
 *   ① このスクリプトをスプレッドシートの Apps Script に貼り付けて保存
 *   ② シートを開き直すとメニュー「トーナメント表」が出る
 *   ③ 「設定シートを作る」を一度だけ実行
 *   ④ 「設定」シートの参加者数に人数を入れて「トーナメント表を作成」
 *
 * 元ソフトの出力(トーナメント表シート C1:Z160)を読み解いた仕様:
 *   ・縦型。左端に通し番号を上から順に並べ、右へ向かって勝ち上がる
 *   ・不戦勝(BYE)には試合番号を振らない
 *     例) 78名 → 128枠・BYE 50 → 1回戦は実試合14のみ番号あり(元ファイルと一致)
 *   ・試合番号は回戦ごとに採番し、4つの形式から選べる
 *   ・線はセルの罫線で引く(図形ではない)ので、印刷しても崩れない
 *
 * このファイルが持たない機能(元ソフトにはある):
 *   ドロー(組み合わせ抽選)・選手名簿・シード配置・同士討ち回避・印刷レイアウト調整。
 *   名前の入った表が要るときは KTTA Platform 側の抽選とExcel出力を使う。
 */

const BB_SETTINGS = "設定";
const BB_OUTPUT = "トーナメント表";

// 設定シートの行(ラベル, 既定値, 補足)
const BB_FIELDS = [
  ["大会名", "", "表の左上に出ます"],
  ["開催日", "", "例: 2026年9月26日"],
  ["会場", "", ""],
  ["種目", "", "例: 一般男子シングルス"],
  ["参加者数", 16, "4以上。この数だけ枠が作られます"],
  ["試合番号形式", "1-1形式", "1-1形式 / 101形式 / 通し番号 / なし"],
  ["番号の向き", "左", "左 = 左端に通し番号（元ソフトと同じ）"],
];

function onOpen() {
  SpreadsheetApp.getUi().createMenu("トーナメント表")
    .addItem("設定シートを作る", "bbCreateSettings")
    .addItem("トーナメント表を作成", "bbBuild")
    .addSeparator()
    .addItem("使い方", "bbHelp")
    .addToUi();
}

function bbCreateSettings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(BB_SETTINGS);
  if (!sh) sh = ss.insertSheet(BB_SETTINGS, 0);
  sh.clear();
  sh.getRange(1, 1).setValue("トーナメント表 設定").setFontWeight("bold").setFontSize(14);
  sh.getRange(2, 1).setValue("値を入れて、メニュー「トーナメント表」→「トーナメント表を作成」を押してください。")
    .setFontSize(11).setFontColor("#666666");
  BB_FIELDS.forEach(function (f, i) {
    const r = i + 4;
    sh.getRange(r, 1).setValue(f[0]).setFontWeight("bold");
    sh.getRange(r, 2).setValue(f[1]);
    sh.getRange(r, 3).setValue(f[2]).setFontSize(10).setFontColor("#888888");
  });
  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidth(3, 320);
  SpreadsheetApp.getUi().alert("「設定」シートを作りました。参加者数を入れて「トーナメント表を作成」を押してください。");
}

function bbReadSettings() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BB_SETTINGS);
  if (!sh) throw new Error("「設定」シートがありません。先に「設定シートを作る」を実行してください。");
  const out = {};
  BB_FIELDS.forEach(function (f, i) {
    out[f[0]] = sh.getRange(i + 4, 2).getValue();
  });
  return out;
}

function bbHelp() {
  SpreadsheetApp.getUi().alert("トーナメント表の作り方",
    "① メニュー「トーナメント表」→「設定シートを作る」\n" +
    "② 「設定」シートの参加者数に人数を入れる(4以上)\n" +
    "③ メニュー「トーナメント表」→「トーナメント表を作成」\n\n" +
    "・不戦勝(BYE)の位置には試合番号を振りません。\n" +
    "・試合番号形式は4つから選べます。\n" +
    "    1-1形式 … 回戦-試合番号 (1回戦第1試合 = 1-1)\n" +
    "    101形式 … 回戦と試合番号をつなげる (3回戦第4試合 = 304)\n" +
    "    通し番号 … 1回戦第1試合から決勝まで連番\n" +
    "    なし     … 試合番号を出さない\n\n" +
    "・線はセルの罫線です。印刷は「ファイル→印刷」から。",
    SpreadsheetApp.getUi().ButtonSet.OK);
}

// ══════════════════════════════════════════
// 組み合わせの骨格(名前を入れない空の表)
// ══════════════════════════════════════════

// 標準のシード配置順。1回戦で1位と2位が当たらないよう、山を再帰的に割る。
// order(1)=[1] / order(2n) は order(n) の各要素 x を x と (2n+1-x) に展開する。
// 例: 1,2 → 1,4,3,2 → 1,8,5,4,3,6,7,2
function bbSeedOrder(size) {
  let cur = [1];
  while (cur.length < size) {
    const n = cur.length, next = [];
    for (let i = 0; i < n; i++) {
      const x = cur[i], y = 2 * n + 1 - x;
      // 1つおきに上下を入れ替える。こうしないと 1,4,2,3 のような並びになり、
      // 対戦の組み合わせは同じでも、紙の表で見慣れた順(1,4,3,2 / 1,8,5,4,3,6,7,2)にならない。
      if (i % 2 === 0) { next.push(x); next.push(y); }
      else { next.push(y); next.push(x); }
    }
    cur = next;
  }
  return cur;
}

// 参加者数から表の骨格を組む。
//   size   … 2の累乗に切り上げた枠数
//   byes   … 不戦勝の数(上位シードから順に付く)
//   slots  … 枠ごとの { bye, no }  no=通し番号(不戦勝でない枠に上から1,2,3…)
//   rounds … 回戦ごとの試合。played=false は不戦勝で実際には行われない試合
function bbBuildStructure(n) {
  const count = Math.floor(n);
  if (!(count >= 4)) throw new Error("参加者数は4以上で入力してください（現在: " + n + "）。");
  let size = 4;
  while (size < count) size *= 2;
  const byes = size - count;
  const order = bbSeedOrder(size);

  // 上位シードから不戦勝を割り当てる(標準配置)
  const slots = order.map(function (rank) { return { rank: rank, bye: rank <= byes }; });
  let no = 0;
  slots.forEach(function (s) { s.no = s.bye ? 0 : (++no); });

  // 回戦ごとの試合を組む。alive[i] = その位置に「勝ち上がる可能性のある人」がいるか
  const rounds = [];
  let alive = slots.map(function (s) { return !s.bye; });
  let width = size;
  while (width > 1) {
    const games = [];
    for (let i = 0; i < width; i += 2) {
      const a = alive[i], b = alive[i + 1];
      games.push({ lo: i, hi: i + 1, played: a && b });   // 片方だけなら不戦勝=試合ではない
      alive[i / 2] = a || b;
    }
    alive.length = width / 2;
    rounds.push(games);
    width /= 2;
  }
  return { count: count, size: size, byes: byes, slots: slots, rounds: rounds };
}

// 試合番号。形式は元ソフトの4種に合わせる。
// 不戦勝には番号を振らない(元ファイルでも1回戦は実試合の数しか番号が無い)。
function bbAssignNumbers(structure, style) {
  let serial = 0;
  structure.rounds.forEach(function (games, ri) {
    let inRound = 0;
    games.forEach(function (g) {
      if (!g.played) { g.label = ""; return; }
      inRound++; serial++;
      const r = ri + 1;
      if (style === "なし") g.label = "";
      else if (style === "通し番号") g.label = String(serial);
      else if (style === "101形式") {
        // 回戦 + 試合番号。試合番号の桁数は1回戦の試合数に合わせる(元ソフトの「227名までは3桁」の考え方)
        const w = String(structure.size / 2).length;
        g.label = String(r) + String(inRound).replace(/^/, "").padStart(w, "0");
      } else g.label = r + "-" + inRound;    // 既定: 1-1形式
    });
  });
  return structure;
}

// ══════════════════════════════════════════
// シートへ描く
// ══════════════════════════════════════════

const BB_ROW0 = 6;        // 1枠目の行
const BB_ROWSTEP = 2;     // 枠と枠の間隔(1行あける)
const BB_COL_NO = 2;      // 通し番号の列(B)
const BB_COL0 = 3;        // 1回戦の縦線を引く列(C)

function bbBuild() {
  const cfg = bbReadSettings();
  const st = bbAssignNumbers(bbBuildStructure(cfg["参加者数"]), String(cfg["試合番号形式"] || "1-1形式").trim());

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(BB_OUTPUT);
  if (sh) ss.deleteSheet(sh);          // 作り直し(前回の罫線を残さない)
  sh = ss.insertSheet(BB_OUTPUT);

  const rounds = st.rounds.length;
  const lastRow = BB_ROW0 + (st.size - 1) * BB_ROWSTEP + 2;
  const lastCol = BB_COL0 + rounds + 1;
  bbEnsureSize(sh, lastRow, lastCol);

  // 見出し
  sh.getRange(1, BB_COL_NO).setValue(cfg["大会名"] || "").setFontWeight("bold").setFontSize(14);
  sh.getRange(2, BB_COL_NO).setValue(
    [cfg["開催日"], cfg["会場"]].filter(function (x) { return String(x || "").trim(); }).join("　").trim()
  ).setFontSize(11);
  sh.getRange(3, BB_COL_NO).setValue(cfg["種目"] || "").setFontWeight("bold").setFontSize(12);
  sh.getRange(4, BB_COL_NO).setValue(
    st.count + "名 / " + st.size + "枠" + (st.byes ? " (不戦勝 " + st.byes + ")" : "")
  ).setFontSize(10).setFontColor("#777777");

  // 枠(通し番号 + 名前を書く欄)
  const noVals = [], nameRows = [];
  for (let i = 0; i < st.size; i++) {
    const r = BB_ROW0 + i * BB_ROWSTEP;
    const s = st.slots[i];
    noVals.push([s.bye ? "" : s.no]);
    if (!s.bye) nameRows.push(r);
  }
  sh.getRange(BB_ROW0, BB_COL_NO, st.size * BB_ROWSTEP - 1, 1).clearContent();
  for (let i = 0; i < st.size; i++) {
    const r = BB_ROW0 + i * BB_ROWSTEP;
    sh.getRange(r, BB_COL_NO).setValue(noVals[i][0]);
  }
  sh.getRange(BB_ROW0, BB_COL_NO, st.size * BB_ROWSTEP, 1)
    .setHorizontalAlignment("right").setFontSize(10).setFontColor("#555555");

  // 罫線を引く
  bbDrawLines(sh, st);

  // 体裁
  sh.setColumnWidth(1, 24);
  sh.setColumnWidth(BB_COL_NO, 34);
  for (let c = BB_COL0; c <= lastCol; c++) sh.setColumnWidth(c, 46);
  for (let r = BB_ROW0; r <= lastRow; r++) sh.setRowHeight(r, 18);
  sh.setFrozenRows(4);
  sh.getRange(1, 1, lastRow, lastCol).setVerticalAlignment("middle");
  ss.setActiveSheet(sh);

  SpreadsheetApp.getUi().alert(
    "トーナメント表を作りました。\n\n" +
    "参加者数: " + st.count + "名\n枠: " + st.size + "\n不戦勝: " + st.byes + "\n" +
    "回戦数: " + rounds + "\n試合数: " + bbCountPlayed(st) + "");
}

function bbCountPlayed(st) {
  let n = 0;
  st.rounds.forEach(function (g) { g.forEach(function (x) { if (x.played) n++; }); });
  return n;
}

function bbEnsureSize(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}

// 罫線でトーナメントの線を引く。
// ・各枠から右へ1本(下線)= 選手の線
// ・回戦ごとに、勝ち上がる2つを縦線でつなぐ
// ・不戦勝は「試合をしない」ので、その枠の線を次の回戦までまっすぐ伸ばす
function bbDrawLines(sh, st) {
  const rowOf = function (slot) { return BB_ROW0 + slot * BB_ROWSTEP; };
  // 各位置の「現在の代表行」。勝ち上がると2つの中点へ移る
  let pos = [];
  for (let i = 0; i < st.size; i++) pos.push({ row: rowOf(i), alive: !st.slots[i].bye, col: BB_COL_NO });

  st.rounds.forEach(function (games, ri) {
    const col = BB_COL0 + ri;
    games.forEach(function (g) {
      const a = pos[g.lo], b = pos[g.hi];
      if (g.played) {
        // 2人とも居る = 実際の試合。両方の線を col まで伸ばし、縦線でつなぐ
        bbHLine(sh, a.row, a.col, col);
        bbHLine(sh, b.row, b.col, col);
        bbVLine(sh, a.row, b.row, col);
        const mid = Math.round((a.row + b.row) / 2);
        pos[g.lo / 2] = { row: mid, alive: true, col: col };
        if (g.label) {
          sh.getRange(mid, col + 1).setValue(g.label)
            .setFontSize(9).setFontColor("#777777").setHorizontalAlignment("left");
        }
      } else {
        // 不戦勝(または両方不在)。線だけを次の回戦へまっすぐ伸ばす
        const live = a.alive ? a : (b.alive ? b : null);
        if (live) {
          bbHLine(sh, live.row, live.col, col);
          pos[g.lo / 2] = { row: live.row, alive: true, col: col };
        } else {
          pos[g.lo / 2] = { row: a.row, alive: false, col: col };
        }
      }
    });
    pos.length = games.length;
  });

  // 優勝者の線を1マス伸ばす
  const champ = pos[0];
  if (champ && champ.alive) bbHLine(sh, champ.row, champ.col, champ.col + 1);
}

// 横線: (row, fromCol) から (row, toCol) まで。セルの下罫線で引く
function bbHLine(sh, row, fromCol, toCol) {
  if (toCol <= fromCol) return;
  sh.getRange(row, fromCol + 1, 1, toCol - fromCol)
    .setBorder(null, null, true, null, null, null, "#333333", SpreadsheetApp.BorderStyle.SOLID);
}

// 縦線: 列 col の rowA〜rowB。セルの右罫線で引く
function bbVLine(sh, rowA, rowB, col) {
  const top = Math.min(rowA, rowB), bottom = Math.max(rowA, rowB);
  sh.getRange(top, col, bottom - top + 1, 1)
    .setBorder(null, null, null, true, null, null, "#333333", SpreadsheetApp.BorderStyle.SOLID);
}
