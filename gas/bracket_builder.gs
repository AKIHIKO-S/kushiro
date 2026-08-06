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

  // 枠は「シード順位の高い順に埋まる」。参加者数を超える順位の枠が空く。
  // 空いた枠の相手(=上位シード)が1回戦を戦わずに勝ち上がる、というのが不戦勝の実体。
  // ここを逆にすると第1シードの枠が空欄になり、最下位ランクの枠に選手が入ってしまう。
  const slots = order.map(function (rank) { return { rank: rank, bye: rank > count }; });
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

// 対面(両山)にするか。元ソフトの制約に合わせ、7名までは片山のみ。
//   「４人以上７名までは、片山形式のみで作成されます。両山では作成できません。」(操作説明)
function bbIsFacing(count) { return count >= 8; }

// 表の骨格を「左右どちらの山か」で振り分ける。
// rounds[ri] の前半が左山・後半が右山、最後の1試合が中央の決勝。
// これは組み合わせの木が「隣どうしを合わせる」形だから成り立つ(bbBuildStructure と対)。
function bbSplitHalves(st) {
  const perHalf = st.rounds.length - 1;          // 各山の回戦数(決勝を除く)
  const left = [], right = [];
  for (let ri = 0; ri < perHalf; ri++) {
    const g = st.rounds[ri], h = g.length / 2;
    left.push(g.slice(0, h));
    right.push(g.slice(h));
  }
  return { perHalf: perHalf, left: left, right: right, fin: st.rounds[st.rounds.length - 1][0] };
}

function bbBuild() {
  const cfg = bbReadSettings();
  const st = bbAssignNumbers(bbBuildStructure(cfg["参加者数"]), String(cfg["試合番号形式"] || "1-1形式").trim());
  const facing = bbIsFacing(st.count);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(BB_OUTPUT);
  if (sh) ss.deleteSheet(sh);          // 作り直し(前回の罫線を残さない)
  sh = ss.insertSheet(BB_OUTPUT);

  const geo = facing ? bbLayoutFacing(st) : bbLayoutSingle(st);
  bbEnsureSize(sh, geo.lastRow + 2, geo.lastCol + 1);

  // 見出し(中央寄りに置く。両山では表の真ん中が決勝なので上部が空く)
  const hcol = facing ? Math.max(2, geo.centerCol - 3) : 2;
  sh.getRange(1, hcol).setValue(cfg["大会名"] || "").setFontWeight("bold").setFontSize(14);
  sh.getRange(2, hcol).setValue(
    [cfg["開催日"], cfg["会場"]].filter(function (x) { return String(x || "").trim(); }).join("　").trim()
  ).setFontSize(11);
  sh.getRange(3, hcol).setValue(cfg["種目"] || "").setFontWeight("bold").setFontSize(12);
  sh.getRange(4, hcol).setValue(
    st.count + "名 / " + st.size + "枠" + (st.byes ? " (不戦勝 " + st.byes + ")" : "") +
    (facing ? " / 対面(両山)" : " / 片山")
  ).setFontSize(10).setFontColor("#777777");

  bbRender(sh, st, geo);

  // 体裁
  sh.setColumnWidth(1, 20);
  geo.numCols.forEach(function (c) { sh.setColumnWidth(c, 36); });
  for (let c = 2; c <= geo.lastCol; c++) {
    if (geo.numCols.indexOf(c) < 0) sh.setColumnWidth(c, 44);
  }
  for (let r = BB_ROW0; r <= geo.lastRow; r++) sh.setRowHeight(r, 18);
  sh.getRange(1, 1, geo.lastRow + 2, geo.lastCol + 1).setVerticalAlignment("middle");
  ss.setActiveSheet(sh);

  SpreadsheetApp.getUi().alert(
    "トーナメント表を作りました。\n\n" +
    "参加者数: " + st.count + "名\n" +
    "形式: " + (facing ? "対面(両山)" : "片山 ※7名までは片山のみ") + "\n" +
    "枠: " + st.size + "  不戦勝: " + st.byes + "\n" +
    "回戦数: " + st.rounds.length + "  試合数: " + bbCountPlayed(st));
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

// ── 配置の計算 ──────────────────────────────────────────────
// 対面(両山): 左端に番号 → 右へ勝ち上がる / 右端に番号 → 左へ勝ち上がる / 中央が決勝。
// 行は左右で共通なので、片山の半分の高さに収まる(紙に載るのが両山の利点)。
function bbLayoutFacing(st) {
  const h = bbSplitHalves(st);
  const half = st.size / 2;
  const leftNo = 2, leftR0 = 3;
  const centerCol = leftR0 + h.perHalf;             // 決勝
  const rightNo = centerCol + h.perHalf + 1;
  return {
    facing: true, halves: h, perHalf: h.perHalf,
    leftNoCol: leftNo, rightNoCol: rightNo, centerCol: centerCol,
    leftCol: function (ri) { return leftR0 + ri; },
    rightCol: function (ri) { return centerCol + (h.perHalf - ri); },
    half: half,
    numCols: [leftNo, rightNo],
    // 空き枠に行を割り当てない(下の bbLeafRows 参照)ので、高さは実人数で決まる。
    lastRow: BB_ROW0 + (Math.max(bbCountFilled(st, 0, half), bbCountFilled(st, half, half)) - 1) * BB_ROWSTEP,
    lastCol: rightNo,
  };
}

// 山の中の「実際に人がいる枠」の数
function bbCountFilled(st, from, len) {
  let n = 0;
  for (let i = 0; i < len; i++) if (!st.slots[from + i].bye) n++;
  return n;
}

// 枠ごとの行を決める。**人がいる枠にだけ**上から等間隔で行を割り当てる。
// 空き枠に行を与えると、その隣(不戦勝で上がるシード)の行間だけが広く見える
// ——「シードだけ行が大きい」という見え方の正体はこれ。
// 不戦勝の線は行を余分に使わず、まっすぐ右(左)へ伸ばして登場回戦につなぐ。
function bbLeafRows(st, from, len) {
  const rows = [];
  let k = 0;
  for (let i = 0; i < len; i++) {
    rows.push(st.slots[from + i].bye ? null : (BB_ROW0 + (k++) * BB_ROWSTEP));
  }
  return rows;
}

// 片山(7名まで): すべて左端に並べ、右へ勝ち上がる。
function bbLayoutSingle(st) {
  const noCol = 2, r0 = 3;
  return {
    facing: false, perHalf: st.rounds.length,
    leftNoCol: noCol, centerCol: r0 + st.rounds.length - 1,
    leftCol: function (ri) { return r0 + ri; },
    numCols: [noCol],
    lastRow: BB_ROW0 + (bbCountFilled(st, 0, st.size) - 1) * BB_ROWSTEP,
    lastCol: r0 + st.rounds.length,
  };
}

// ── 描画 ────────────────────────────────────────────────────
function bbRender(sh, st, geo) {
  if (!geo.facing) { bbRenderHalf(sh, st, geo, 0, st.size, geo.leftNoCol, geo.leftCol, 1, st.rounds); return; }
  const h = geo.halves;
  // 左山: 枠0..half-1 / 右山: 枠half..size-1(行は山の中での位置で共通)
  const L = bbRenderHalf(sh, st, geo, 0, geo.half, geo.leftNoCol, geo.leftCol, 1, h.left);
  const R = bbRenderHalf(sh, st, geo, geo.half, geo.half, geo.rightNoCol, geo.rightCol, -1, h.right);
  // 決勝: 両山の勝者を中央でつなぐ
  if (L && R) {
    // 決勝の縦線は中央列の「左辺」1本。左の横線はその手前まで、右の横線はその列から
    // 引くことで、1本の縦線に左右がぴったり合流する。
    bbHLine(sh, L.row, L.col, geo.centerCol - 1, 1);
    bbHLine(sh, R.row, R.col, geo.centerCol, -1);
    bbVLine(sh, L.row, R.row, geo.centerCol, -1);
    const mid = Math.round((L.row + R.row) / 2);
    if (h.fin && h.fin.label) {
      sh.getRange(mid, geo.centerCol).setValue(h.fin.label)
        .setFontSize(9).setFontColor("#777777").setHorizontalAlignment("center");
    }
  }
}

// 片方の山を描く。dir=1 なら右へ、-1 なら左へ勝ち上がる。
// 返り値はその山の勝者の位置(決勝でつなぐため)。
function bbRenderHalf(sh, st, geo, slotFrom, slotCount, noCol, colOf, dir, roundGames) {
  // 人がいる枠にだけ行を割り当てる(空き枠は行を取らない=行間が一定になる)
  const leafRows = bbLeafRows(st, slotFrom, slotCount);
  let filled = 0;
  for (let i = 0; i < slotCount; i++) {
    const s = st.slots[slotFrom + i];
    if (s.bye) continue;
    sh.getRange(leafRows[i], noCol).setValue(s.no);
    filled++;
  }
  if (filled) {
    sh.getRange(BB_ROW0, noCol, filled * BB_ROWSTEP, 1)
      .setHorizontalAlignment(dir > 0 ? "right" : "left")
      .setFontSize(10).setFontColor("#555555");
  }

  // 勝ち上がりの線
  let pos = [];
  for (let i = 0; i < slotCount; i++) {
    const s = st.slots[slotFrom + i];
    pos.push({ row: leafRows[i], alive: !s.bye, col: noCol });
  }
  for (let ri = 0; ri < roundGames.length; ri++) {
    const col = colOf(ri), games = roundGames[ri], next = [];
    for (let gi = 0; gi < games.length; gi++) {
      const g = games[gi], a = pos[gi * 2], b = pos[gi * 2 + 1];
      if (g.played) {
        bbHLine(sh, a.row, a.col, col, dir);
        bbHLine(sh, b.row, b.col, col, dir);
        bbVLine(sh, a.row, b.row, col, dir);
        const mid = Math.round((a.row + b.row) / 2);
        next.push({ row: mid, alive: true, col: col });
        if (g.label) {
          sh.getRange(mid, col + (dir > 0 ? 1 : -1)).setValue(g.label)
            .setFontSize(9).setFontColor("#777777")
            .setHorizontalAlignment(dir > 0 ? "left" : "right");
        }
      } else {
        // 不戦勝。線だけを次の回戦へまっすぐ伸ばす(試合はしないので縦線を引かない)
        const live = a.alive ? a : (b.alive ? b : null);
        if (live) {
          bbHLine(sh, live.row, live.col, col, dir);
          next.push({ row: live.row, alive: true, col: col });
        } else {
          // どちらにも人がいない枠。行は持たない(この先も線を引かない)
          next.push({ row: null, alive: false, col: col });
        }
      }
    }
    pos = next;
  }
  return pos[0] && pos[0].alive ? pos[0] : null;
}

// 横線。dir=1 は fromCol→toCol(右向き)、dir=-1 は fromCol→toCol(左向き)。
// セルの下罫線で引く(図形を使わないので印刷・再計算で崩れない)。
function bbHLine(sh, row, fromCol, toCol, dir) {
  const a = Math.min(fromCol, toCol), b = Math.max(fromCol, toCol);
  if (b <= a) return;
  const start = (dir > 0) ? a + 1 : a;
  const width = (dir > 0) ? (b - a) : (b - a);
  sh.getRange(row, start, 1, width)
    .setBorder(null, null, true, null, null, null, "#333333", SpreadsheetApp.BorderStyle.SOLID);
}

// 縦線。横線とぴったり繋げるために、罫線の「どの辺か」を厳密に合わせる。
//
//   セル(r,c)の下罫線 = 行r と 行r+1 の境界
//   セル(r,c)の右罫線 = 列c と 列c+1 の境界
//
// 横線は「その行の下辺」に引いてあるので、縦線は
//   ・上端 = rowA の下辺 → 行 rowA+1 から始める(rowA から引くと1行上にはみ出す)
//   ・左右 = 進む向き側の辺(左山は右辺・右山は左辺)。逆にすると横線の端と繋がらない
// この2点がずれていたため、線が食い違って見えていた。
function bbVLine(sh, rowA, rowB, col, dir) {
  const top = Math.min(rowA, rowB), bottom = Math.max(rowA, rowB);
  if (bottom <= top) return;
  const right = (dir >= 0), left = !right;
  sh.getRange(top + 1, col, bottom - top, 1)
    .setBorder(null, left || null, null, right || null, null, null,
      "#333333", SpreadsheetApp.BorderStyle.SOLID);
}
