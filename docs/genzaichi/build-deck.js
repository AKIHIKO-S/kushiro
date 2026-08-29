const pptxgen = require("pptxgenjs");

/* ---------- palette : ink / frost / ember ---------- */
const INK   = "12161C";
const INK_C = "1E2630";
const GHOST_D = "1A202A";
const PAPER = "F4F5F6";
const PAPER_C = "E7E9EB";
const GHOST_L = "E4E7E9";
const FROST = "C9D2D9";
const SLATE = "7E8B96";
const CARDTX= "465059";
const EMBER = "E2542C";
const EMBER_L = "B8431F";

const FJ = "Yu Gothic";
const FM = "Yu Mincho";
const FE = "Arial";

const W = 13.333, H = 7.5, M = 0.7, CW = W - M * 2;

const pres = new pptxgen();
pres.defineLayout({ name: "W16x9", width: W, height: H });
pres.layout = "W16x9";
pres.author = "GENZAICHI";
pres.title = "GENZAICHI 企画書";

const sh = () => ({ type: "outer", color: "000000", blur: 12, offset: 3, angle: 90, opacity: 0.18 });
const BUL = { code: "2013" };

function base(dark) {
  const s = pres.addSlide();
  s.background = { color: dark ? INK : PAPER };
  return s;
}
function ghost(s, n, dark) {
  s.addText(n, {
    x: 10.85, y: 0.3, w: 1.8, h: 1.35, isTextBox: true, margin: 0,
    fontFace: FE, fontSize: 88, bold: true, align: "right", valign: "top",
    color: dark ? GHOST_D : GHOST_L,
  });
}
function eyebrow(s, t, dark) {
  s.addText(t, {
    x: M, y: 0.72, w: 9.5, h: 0.3, isTextBox: true, margin: 0, valign: "top",
    fontFace: FE, fontSize: 11, bold: true, charSpacing: 3,
    color: dark ? EMBER : EMBER_L,
  });
}
function title(s, t, dark, sub) {
  const n = t.length;
  const fs = n >= 22 ? 27 : n >= 19 ? 30 : 33;
  s.addText(t, {
    x: M, y: 1.2, w: 10.0, h: 0.78, isTextBox: true, margin: 0, valign: "top",
    fontFace: FM, fontSize: fs, bold: true, color: dark ? "FFFFFF" : INK,
  });
  if (sub) {
    s.addText(sub, {
      x: M, y: 2.02, w: 10.9, h: 0.42, isTextBox: true, margin: 0, valign: "top",
      fontFace: FJ, fontSize: 13.5, color: dark ? SLATE : "5C6771",
    });
  }
}
function foot(s, dark) {
  s.addText("GENZAICHI ／ 現在地", {
    x: M, y: 6.92, w: 4, h: 0.28, isTextBox: true, margin: 0, valign: "top",
    fontFace: FE, fontSize: 8.5, charSpacing: 2, color: dark ? "3D4854" : "AEB6BC",
  });
}
function head(s, o) {
  const d = !!o.dark;
  ghost(s, o.n, d); eyebrow(s, o.eye, d); title(s, o.t, d, o.sub); foot(s, d);
}
function card(s, x, y, w, h, fill, shadowOn) {
  const o = { x, y, w, h, fill: { color: fill }, line: { color: fill }, rectRadius: 0.06 };
  if (shadowOn) o.shadow = sh();
  s.addShape(pres.ShapeType.roundRect, o);
}
function numDisc(s, x, y, n) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: 0.42, h: 0.42, fill: { color: EMBER }, line: { color: EMBER } });
  s.addText(n, { x, y, w: 0.42, h: 0.42, isTextBox: true, margin: 0, align: "center", valign: "middle", fontFace: FE, fontSize: 13, bold: true, color: "FFFFFF" });
}
// 箇条書き: bullet は段落プロパティなので各項目に付ける(top-level だけだと1行目にしか出ない)
function bullets(s, items, opt) {
  const runs = items.map((t, i) => ({
    text: t,
    options: { bullet: BUL, breakLine: i < items.length - 1 },
  }));
  s.addText(runs, Object.assign({
    isTextBox: true, margin: 0, valign: "top", fontFace: FJ,
    paraSpaceAfter: 10, lineSpacingMultiple: 1.2,
  }, opt));
}

/* =========================================================
   01  表紙
========================================================= */
{
  const s = base(true);
  s.addText("DOCUMENTARY SHORT FILM MEDIA", {
    x: M, y: 0.85, w: 8, h: 0.3, isTextBox: true, margin: 0, valign: "top",
    fontFace: FE, fontSize: 11, bold: true, charSpacing: 4, color: EMBER,
  });
  s.addText("GENZAICHI", {
    x: M, y: 2.2, w: 11.9, h: 1.15, isTextBox: true, margin: 0, valign: "middle",
    fontFace: FE, fontSize: 68, bold: true, charSpacing: 14, color: "FFFFFF",
  });
  s.addText("現 在 地", {
    x: M + 0.05, y: 3.5, w: 8, h: 0.5, isTextBox: true, margin: 0, valign: "top",
    fontFace: FM, fontSize: 26, bold: true, charSpacing: 6, color: EMBER,
  });
  s.addText("ゴールじゃなくて、いまいる場所を撮ります。", {
    x: M + 0.05, y: 4.4, w: 10.5, h: 0.5, isTextBox: true, margin: 0, valign: "top",
    fontFace: FM, fontSize: 21, color: FROST,
  });
  s.addText("経営者も、名前の出ない人も。綺麗事を抜きにしたショートフィルムで、いまの現在地を記録していきます。", {
    x: M + 0.05, y: 5.05, w: 10.9, h: 0.42, isTextBox: true, margin: 0, valign: "top",
    fontFace: FJ, fontSize: 13, color: SLATE, lineSpacingMultiple: 1.2,
  });
  s.addText("企画書 ／ 北海道・道東発 ／ 2026", {
    x: M + 0.05, y: 6.35, w: 8, h: 0.35, isTextBox: true, margin: 0, valign: "top",
    fontFace: FE, fontSize: 12, charSpacing: 2, color: "56626D",
  });
  s.addNotes("挨拶は短く。成功譚じゃないですと先に言ってから2枚目へ。");
}

/* =========================================================
   02  なぜ今か
========================================================= */
{
  const s = base(false);
  head(s, { n: "01", dark: false, eye: "WHY NOW ／ 背景",
    t: "うまくいった話は、もう足りてる",
    sub: "世に出ている人の物語って、だいたい成功という結論から逆算して作られていると思うんです。" });
  const w = (CW - 0.8) / 3;
  const items = [
    ["磨かれすぎてる", "企業のPVも、SNSの自己紹介もそうです。失敗や挫折は、成功の前振りとしてしか出てきません。"],
    ["多数派が写らない", "記録されるのは、たどり着いた人だけです。肩書きも売上もない人が何に夢中なのかは、どこにも残りません。"],
    ["撮る人がいない", "北海道には、その土地でしか成り立たない生き方があります。でも語る人も撮る人も、足りていないと感じています。"],
  ];
  items.forEach((it, i) => {
    const x = M + i * (w + 0.4);
    card(s, x, 2.85, w, 2.75, PAPER_C, true);
    s.addText(String(i + 1).padStart(2, "0"), { x: x + 0.35, y: 3.05, w: 1, h: 0.32, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 13, bold: true, charSpacing: 2, color: EMBER_L });
    s.addText(it[0], { x: x + 0.35, y: 3.48, w: w - 0.7, h: 0.36, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 17, bold: true, color: INK });
    s.addText(it[1], { x: x + 0.35, y: 3.94, w: w - 0.7, h: 1.5, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 12.5, color: CARDTX, lineSpacingMultiple: 1.28 });
  });
  s.addText("うまくいった話ばかりが残って、いま迷っている最中の人は、誰も撮っていません。", {
    x: M, y: 6.0, w: CW, h: 0.4, isTextBox: true, margin: 0, valign: "top",
    fontFace: FM, fontSize: 15, bold: true, color: INK,
  });
  s.addNotes("3つ目の「撮る人がいない」が、北海道でやる理由になる。");
}

/* =========================================================
   03  コンセプト
========================================================= */
{
  const s = base(true);
  head(s, { n: "02", dark: true, eye: "CONCEPT ／ 定義",
    t: "現在地は、途中経過のことです",
    sub: "人生の結論は撮りません。いまどこで立ち止まっていて、何に夢中で、何を悔いているか。そこを撮ります。" });
  const defs = [
    ["まだ途中の人を撮ります", "結末が出ていない人がいいです。答えは本人にも出ていなくて構いません。むしろ出ていない方がいいと思っています。"],
    ["何年か後に、また撮ります", "同じ人をもう一度撮ります。1本で終わらせないで、続編がある前提で作ります。"],
    ["本人にも見えていません", "だから聞き出すというより、思い出してもらいます。家族や従業員、仲間にも同じことを聞きます。"],
  ];
  defs.forEach((d, i) => {
    const y = 2.75 + i * 1.12;
    s.addText(String(i + 1).padStart(2, "0"), { x: M, y: y + 0.04, w: 0.75, h: 0.5, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 24, bold: true, color: EMBER });
    s.addText(d[0], { x: M + 0.85, y, w: 4.2, h: 0.42, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 17, bold: true, color: "FFFFFF" });
    s.addText(d[1], { x: M + 5.2, y: y + 0.02, w: 6.7, h: 0.85, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 12.5, color: FROST, lineSpacingMultiple: 1.25 });
  });
  card(s, M, 6.12, CW, 0.72, INK_C, false);
  s.addText("タグライン ： 「まだ、途中です。」", {
    x: M + 0.4, y: 6.12, w: CW - 0.8, h: 0.72, isTextBox: true, margin: 0, valign: "middle",
    fontFace: FM, fontSize: 19, bold: true, color: EMBER,
  });
  s.addNotes("「また撮ります」が他の人物ドキュメンタリーとの一番の違い。続編前提だからアーカイブが資産になる。");
}

/* =========================================================
   04  何を撮らないか
========================================================= */
{
  const s = base(false);
  head(s, { n: "03", dark: false, eye: "EDITORIAL POLICY ／ 編集方針",
    t: "撮らないものを、先に決めます",
    sub: "出演をお願いするときに、必ず最初に見せます。良く見せませんという合意が取れないと、本音は出てきません。" });
  const cw = (CW - 0.4) / 2;
  card(s, M, 2.8, cw, 3.05, INK, true);
  s.addText("撮らないもの", { x: M + 0.45, y: 3.05, w: cw - 0.9, h: 0.4, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 19, bold: true, color: "FFFFFF" });
  bullets(s, [
    "成功から逆算したストーリー",
    "音楽と編集で泣かせにいく作り",
    "商品やサービスの宣伝カット",
    "最後に一言でまとめさせる締め",
  ], { x: M + 0.45, y: 3.65, w: cw - 0.9, h: 1.95, fontSize: 13, color: FROST });

  const x2 = M + cw + 0.4;
  card(s, x2, 2.8, cw, 3.05, PAPER_C, true);
  s.addText("撮るもの", { x: x2 + 0.45, y: 3.05, w: cw - 0.9, h: 0.4, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 19, bold: true, color: EMBER_L });
  bullets(s, [
    "言い淀み、言い直し、長い沈黙",
    "まだ片付いていない後悔",
    "何度も繰り返される手の動き",
    "家族や従業員から見たその人",
  ], { x: x2 + 0.45, y: 3.65, w: cw - 0.9, h: 1.95, fontSize: 13, color: CARDTX });

  s.addText("泥臭さは演出で足しません。足りないなら、その人はまだ撮る時期じゃないんだと思います。", {
    x: M, y: 6.2, w: CW, h: 0.4, isTextBox: true, margin: 0, valign: "top",
    fontFace: FM, fontSize: 15, bold: true, color: INK,
  });
  s.addNotes("交渉で一番効く。宣伝はしませんと先に言うほど本音が出る。");
}

/* =========================================================
   05  被写体
========================================================= */
{
  const s = base(false);
  head(s, { n: "04", dark: false, eye: "CASTING ／ 被写体",
    t: "誰を撮るか",
    sub: "肩書きでは選びません。まだ終わっていない人、というのが唯一の条件です。" });
  const w = (CW - 0.7) / 3, hgt = 1.40;
  const cells = [
    ["経営者・二代目", "継いだ会社、継がせる会社。数字と人のあいだで割り切れずにいる人です。"],
    ["一次産業", "漁師、酪農、農家。天候と相場が、そのまま生活に直結する現場です。"],
    ["職人・技術者", "同じ作業を何千回も繰り返してきた手。言葉より先に手が動く人です。"],
    ["廃業と再起", "畳んだ人、辞めた人、病気で止まった人。いま何をしているのかを聞きたいです。"],
    ["名もなき夢中", "収入にならないことに何年も注ぎ込んでいる人。地域活動でも趣味でも構いません。"],
    ["戻ってきた人", "都市で働いて、北海道に戻ってきた人。戻ったことを正解だとは言わない人です。"],
  ];
  cells.forEach((c, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = M + col * (w + 0.35), y = 2.68 + row * (hgt + 0.24);
    card(s, x, y, w, hgt, PAPER_C, false);
    s.addText(c[0], { x: x + 0.32, y: y + 0.2, w: w - 0.64, h: 0.32, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 15.5, bold: true, color: INK });
    s.addText(c[1], { x: x + 0.32, y: y + 0.58, w: w - 0.64, h: 0.62, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11.5, color: CARDTX, lineSpacingMultiple: 1.22 });
  });
  s.addText("共通条件", { x: M, y: 6.00, w: 1.5, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 11, bold: true, charSpacing: 2, color: EMBER_L });
  s.addText("① いまも続けている　　② 語りたくない部分がある　　③ 手が動く現場がある", {
    x: M, y: 6.32, w: CW, h: 0.38, isTextBox: true, margin: 0, valign: "top",
    fontFace: FM, fontSize: 15, bold: true, color: INK,
  });
  s.addNotes("③の現場があるは必須。喋るだけの人は画が持たない。");
}

/* =========================================================
   06  フォーマット
========================================================= */
{
  const s = base(true);
  head(s, { n: "05", dark: true, eye: "FORMAT ／ 映像構成",
    t: "1本12〜18分。章立ては固定します",
    sub: "尺よりも章の順番を固定します。どの回も同じ流れで進むことが、シリーズの信用になると思っています。" });
  const sw = (CW - 0.8) / 3;
  const stats = [["12–18", "分", "本編（YouTube・公式サイト）"], ["60", "秒", "予告編（横型・告知用）"], ["30–60", "秒 ×3", "縦型ショート（SNS導線）"]];
  stats.forEach((st, i) => {
    const x = M + i * (sw + 0.4);
    card(s, x, 2.75, sw, 1.0, INK_C, false);
    s.addText([{ text: st[0], options: { fontSize: 30, bold: true, color: EMBER, fontFace: FE } }, { text: "  " + st[1], options: { fontSize: 14, color: FROST, fontFace: FJ } }],
      { x: x + 0.3, y: 2.83, w: sw - 0.6, h: 0.5, isTextBox: true, margin: 0, valign: "middle" });
    s.addText(st[2], { x: x + 0.3, y: 3.32, w: sw - 0.6, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11, color: SLATE });
  });
  s.addText("本編の5章構成", { x: M, y: 4.02, w: 4, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 11, bold: true, charSpacing: 2, color: EMBER });
  const cw = (CW - 4 * 0.28) / 5;
  const ch = [
    ["01", "現在地", "00:00", "いまの日常と手の動き。まだ名乗らせません。"],
    ["02", "来歴", "02:00", "どこから来たのか。事実だけを淡々と置きます。"],
    ["03", "亀裂", "05:00", "転換点。うまくいかなかった時期を扱います。"],
    ["04", "反省", "09:00", "いまも消えていない後悔。答えは出させません。"],
    ["05", "明日", "13:00", "決意ではなく、明日の予定を話してもらいます。"],
  ];
  ch.forEach((c, i) => {
    const x = M + i * (cw + 0.28);
    card(s, x, 4.42, cw, 1.95, INK_C, false);
    s.addText(c[0], { x: x + 0.24, y: 4.6, w: cw - 0.48, h: 0.26, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 12, bold: true, color: EMBER });
    s.addText(c[1], { x: x + 0.24, y: 4.9, w: cw - 0.48, h: 0.35, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 17, bold: true, color: "FFFFFF" });
    s.addText(c[2], { x: x + 0.24, y: 5.28, w: cw - 0.48, h: 0.26, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 10, color: SLATE });
    s.addText(c[3], { x: x + 0.24, y: 5.56, w: cw - 0.48, h: 0.74, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 10.5, color: FROST, lineSpacingMultiple: 1.2 });
  });
  s.addNotes("章立てを固定すると編集時間が読める。だから月1本が現実的になる。");
}

/* =========================================================
   07  インタビュー設計
========================================================= */
{
  const s = base(false);
  head(s, { n: "06", dark: false, eye: "INTERVIEW ／ 取材設計",
    t: "聞き出さないで、思い出してもらう",
    sub: "情報を集める時間ではなくて、本人が自分の現在地に気づく時間だと思って設計します。" });
  const lw = 6.4;
  const rules = [
    ["事前面談は必ず1回、カメラなしで", "ここで撮らない範囲を本人と決めます。撮影日には、もう話がついている状態にしておきます。"],
    ["時系列では聞きません", "作業してもらいながら、手が動いている状態で聞きます。座って正面から聞くのは最後だけです。"],
    ["沈黙は切りません", "最低5秒待ちます。言い淀みも編集で消しません。そこが一番現在地に近いと思っています。"],
    ["「一言でいうと?」は聞きません", "まとめさせた瞬間に、その人は用意していた答えに戻ってしまいます。"],
  ];
  rules.forEach((r, i) => {
    const y = 2.85 + i * 0.96;
    numDisc(s, M, y, String(i + 1));
    s.addText(r[0], { x: M + 0.6, y: y - 0.02, w: lw - 0.6, h: 0.32, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 15.5, bold: true, color: INK });
    s.addText(r[1], { x: M + 0.6, y: y + 0.32, w: lw - 0.6, h: 0.58, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11.5, color: CARDTX, lineSpacingMultiple: 1.2 });
  });
  const x2 = M + lw + 0.45, rw = CW - lw - 0.45;
  card(s, x2, 2.75, rw, 3.85, INK, true);
  s.addText("実際に聞くこと（抜粋）", { x: x2 + 0.45, y: 3.0, w: rw - 0.9, h: 0.34, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 11, bold: true, charSpacing: 2, color: EMBER });
  bullets(s, [
    "今日、何時に起きて、最初に何をしましたか。",
    "いま、一番うまくいっていないことは何ですか。",
    "あの頃に戻れるなら、誰に何と言いますか。",
    "あなたを一番誤解しているのは、誰だと思いますか。",
    "明日、何をしますか。",
  ], { x: x2 + 0.45, y: 3.5, w: rw - 0.9, h: 2.85, fontFace: FM, fontSize: 14, color: "FFFFFF", paraSpaceAfter: 14, lineSpacingMultiple: 1.15 });
  s.addNotes("最後の「明日、何をしますか」が締めの定番。決意じゃなく予定を聞くと嘘が混ざらない。");
}

/* =========================================================
   08  撮影方針
========================================================= */
{
  const s = base(true);
  head(s, { n: "07", dark: true, eye: "CINEMATOGRAPHY ／ 撮影方針",
    t: "画のつくり方と、現場での振る舞い",
    sub: "撮り方そのものが編集方針の続きだと思っています。作り込むほど、現在地から遠ざかります。" });
  const rows = [
    ["ルック", "手持ちが基本です。演出照明は最小限にして、現場の光をそのまま使います。彩度は低めで、ハイライトは飛ばしません。"],
    ["カメラ", "2カメで寄りと引き。インタビューは目線をレンズから少し外してもらって、正面すぎる画を避けます。"],
    ["音", "現場音は積極的に残します。音楽は最小限で、無音のまま終わる回があってもいいと思っています。"],
    ["北海道の風土", "天候や季節を、きれいな背景として使いません。冬に撮るなら、冬の不便さごと画に入れます。"],
    ["撮影日数", "1本2〜3日です。現場1日、インタビュー1日、予備1日。撮らずに同行するだけの日を必ず1日つくります。"],
  ];
  rows.forEach((r, i) => {
    const y = 2.72 + i * 0.82;
    numDisc(s, M, y, String(i + 1));
    s.addText(r[0], { x: M + 0.62, y: y + 0.02, w: 1.85, h: 0.36, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 16, bold: true, color: "FFFFFF" });
    s.addText(r[1], { x: M + 2.5, y: y + 0.03, w: CW - 2.5, h: 0.62, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 12.5, color: FROST, lineSpacingMultiple: 1.2 });
  });
  s.addNotes("撮らずに同行する日を作るのがポイント。そこで信用ができると3日目の話が変わる。");
}

/* =========================================================
   09  制作フロー
========================================================= */
{
  const s = base(false);
  head(s, { n: "08", dark: false, eye: "WORKFLOW ／ 制作フロー",
    t: "公開までの7ステップ",
    sub: "1本におよそ6週間かけます。撮影は2〜3日で、残りはほとんど信用をつくる時間と編集です。" });
  const steps = ["リサーチ・推薦", "事前面談", "同意書", "撮影 2〜3日", "編集", "本人試写", "公開"];
  const n = steps.length, gap = 0.16, sw = (CW - gap * (n - 1)) / n;
  steps.forEach((st, i) => {
    const x = M + i * (sw + gap);
    const last = i === n - 1;
    card(s, x, 2.85, sw, 1.35, last ? INK : PAPER_C, false);
    s.addText("STEP " + (i + 1), { x: x + 0.16, y: 3.0, w: sw - 0.32, h: 0.26, isTextBox: true, margin: 0, valign: "top", align: "center", fontFace: FE, fontSize: 9, bold: true, color: last ? EMBER : EMBER_L });
    s.addText(st, { x: x + 0.1, y: 3.3, w: sw - 0.2, h: 0.75, isTextBox: true, margin: 0, align: "center", valign: "top", fontFace: FM, fontSize: 13, bold: true, color: last ? "FFFFFF" : INK, lineSpacingMultiple: 1.1 });
  });
  card(s, M, 4.55, CW, 1.75, PAPER_C, true);
  s.addText("本人試写は必ずやります。ただし直すのは2つだけです。", {
    x: M + 0.5, y: 4.82, w: CW - 1.0, h: 0.4, isTextBox: true, margin: 0, valign: "top",
    fontFace: FM, fontSize: 17, bold: true, color: INK,
  });
  s.addText([
    { text: "①  事実の間違い（年号・数字・固有名詞）　　②  本人以外への配慮（家族・従業員・取引先）", options: { breakLine: true } },
    { text: "自分を良く見せるための修正は受けません。これを同意書に書いて、事前面談のときに説明します。", options: {} },
  ], { x: M + 0.5, y: 5.3, w: CW - 1.0, h: 0.88, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 12.5, color: CARDTX, lineSpacingMultiple: 1.35 });
  s.addNotes("試写ルールを先に固めないと、公開直前に全部ひっくり返される。運営上の最大リスク。");
}

/* =========================================================
   10  配信・展開
========================================================= */
{
  const s = base(true);
  head(s, { n: "09", dark: true, eye: "DISTRIBUTION ／ 配信",
    t: "どこで出して、どう広げるか",
    sub: "本編の置き場所はYouTubeです。SNSは入口、サイトはアーカイブ、上映会は地域との接点として使い分けます。" });
  const w = (CW - 3 * 0.35) / 4;
  const chs = [
    ["YouTube", "本編の置き場所です。12〜18分をそのまま置いて、章ごとのチャプターと書き起こしを付けます。"],
    ["Instagram / TikTok", "縦型を1本につき3本。台詞の切り抜きではなく、手の動きを切り出します。"],
    ["公式サイト", "全話のアーカイブと書き起こし。人物名や地域名で、あとから検索に残る資産にします。"],
    ["上映会", "年2回、地域の小屋やカフェ、公民館で。出演者とその周りが集まる場をつくります。"],
  ];
  chs.forEach((c, i) => {
    const x = M + i * (w + 0.35);
    card(s, x, 2.85, w, 2.5, INK_C, false);
    s.addText(c[0], { x: x + 0.3, y: 3.1, w: w - 0.6, h: 0.6, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 16, bold: true, color: EMBER, lineSpacingMultiple: 1.1 });
    s.addText(c[1], { x: x + 0.3, y: 3.78, w: w - 0.6, h: 1.45, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11.5, color: FROST, lineSpacingMultiple: 1.28 });
  });
  card(s, M, 5.62, CW, 0.85, INK_C, false);
  s.addText([
    { text: "更新頻度 ： ", options: { fontSize: 13, color: SLATE, fontFace: FJ } },
    { text: "月1本 ／ シーズン制（6本＝1シーズン）", options: { fontSize: 17, bold: true, color: "FFFFFF", fontFace: FM } },
    { text: "　　シーズンごとに上映会と総括をやって、次の6人を決めます。", options: { fontSize: 12, color: FROST, fontFace: FJ } },
  ], { x: M + 0.45, y: 5.62, w: CW - 0.9, h: 0.85, isTextBox: true, margin: 0, valign: "middle" });
  s.addNotes("縦型は台詞じゃなく手の動きを切る。喋りの切り抜きは他と埋もれる。");
}

/* =========================================================
   11  シーズン1 ラインナップ案
========================================================= */
{
  const s = base(false);
  head(s, { n: "10", dark: false, eye: "SEASON 1 ／ 企画案",
    t: "シーズン1の企画案（仮）",
    sub: "被写体はまだ決まっていません。どういう並びになるのかを見てもらうための仮案です。" });
  const w = (CW - 0.7) / 3, hgt = 1.5;
  const line = [
    ["二代目の朝", "釧路・水産加工", "父の会社を継いだ40代。従業員の半分が、親の代からの職人です。"],
    ["冬の牛舎", "根室管内・酪農", "離農が続く地域で規模を広げた夫婦。増えた借入と、減った休日の話です。"],
    ["店を閉めた日", "帯広・元飲食店主", "20年やった店を畳んで、いま何をしているのかを聞きます。"],
    ["海に出ない日", "羅臼・漁師", "時化で出られない日の過ごし方から、一年を逆算します。"],
    ["まだ売れない", "札幌・ものづくり", "10年続けて、生活はまだ成り立っていません。それでも続ける理由を聞きます。"],
    ["戻ってきた人", "道東・Uターン", "都市で働いて戻ってきた人。戻ったことを正解だとは言いません。"],
  ];
  line.forEach((l, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = M + col * (w + 0.35), y = 2.78 + row * (hgt + 0.28);
    card(s, x, y, w, hgt, PAPER_C, false);
    s.addText("EP." + String(i + 1).padStart(2, "0") + "　" + l[1], { x: x + 0.32, y: y + 0.2, w: w - 0.64, h: 0.26, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 9.5, bold: true, color: EMBER_L });
    s.addText("「" + l[0] + "」", { x: x + 0.32, y: y + 0.46, w: w - 0.64, h: 0.36, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 17, bold: true, color: INK });
    s.addText(l[2], { x: x + 0.32, y: y + 0.86, w: w - 0.64, h: 0.58, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11.5, color: CARDTX, lineSpacingMultiple: 1.22 });
  });
  s.addText("※ 仮のタイトルと設定です。実際の人選は事前面談を経て決めます。道東を軸にしつつ、1本だけ札幌圏を入れて対比をつくるつもりです。", {
    x: M, y: 6.2, w: CW, h: 0.35, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11, color: "6B767F",
  });
  s.addNotes("あくまで型の提示。相手に「自分もこの並びに入るのか」を想像させるのが目的。");
}

/* =========================================================
   12  収益モデル
========================================================= */
{
  const s = base(true);
  head(s, { n: "11", dark: true, eye: "BUSINESS MODEL ／ 収益",
    t: "作品は無料。お金は別で立てます",
    sub: "本編に課金はしません。取材と撮影の力を見せるための作品なので、収益は受注と協賛で回収します。" });
  const w = (CW - 3 * 0.35) / 4;
  const pil = [
    ["企業ドキュメント受注", "主収益", "本編と同じやり方を、企業の採用・事業承継・周年映像に応用します。作品そのものが営業資料になります。"],
    ["シリーズ協賛", "年間契約", "冠協賛です。ただし出演者選びと編集への口出しは、契約で外してもらいます。"],
    ["自治体・DMO連携", "事業連動", "移住や事業承継、担い手不足の文脈で、地域の記録事業として受託します。"],
    ["上映会・二次利用", "副次", "有料上映、素材の二次利用、将来的には書籍や展示も考えています。"],
  ];
  pil.forEach((p, i) => {
    const x = M + i * (w + 0.35);
    card(s, x, 2.8, w, 2.65, INK_C, false);
    s.addText(String(i + 1).padStart(2, "0"), { x: x + 0.3, y: 3.0, w: 1, h: 0.28, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 12, bold: true, color: EMBER });
    s.addText(p[0], { x: x + 0.3, y: 3.3, w: w - 0.6, h: 0.62, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 15.5, bold: true, color: "FFFFFF", lineSpacingMultiple: 1.1 });
    s.addText(p[1], { x: x + 0.3, y: 3.98, w: w - 0.6, h: 0.26, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 10.5, color: EMBER });
    s.addText(p[2], { x: x + 0.3, y: 4.3, w: w - 0.6, h: 1.08, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11, color: FROST, lineSpacingMultiple: 1.25 });
  });
  card(s, M, 5.72, CW, 0.78, INK_C, false);
  s.addText("協賛でも受託でも、編集権はこちらに置かせてもらいます。ここを外すと、この企画自体が成立しません。", {
    x: M + 0.45, y: 5.72, w: CW - 0.9, h: 0.78, isTextBox: true, margin: 0, valign: "middle",
    fontFace: FM, fontSize: 15, bold: true, color: EMBER,
  });
  s.addNotes("協賛契約に「出演者選定と編集内容に関与しない」条項を必ず入れる。");
}

/* =========================================================
   13  制作体制
========================================================= */
{
  const s = base(false);
  head(s, { n: "12", dark: false, eye: "TEAM ／ 制作体制",
    t: "2〜3人で回します",
    sub: "人が増えるほど現場の空気が固くなります。被写体との距離を保てる最小の人数でやります。" });
  const w = (CW - 0.8) / 3;
  const team = [
    ["監督 ／ 撮影", "企画、人選、インタビュー、メインカメラ、編集まで兼ねます。被写体から見た窓口を一人にします。"],
    ["録音 ／ 撮影補助", "同録とサブカメラです。現場ではなるべく喋りません。機材も最小限で持ち込みます。"],
    ["リサーチ ／ 渉外", "人を紹介してもらうルートの開拓と、事前面談の調整、同意書まわりです。外部の協力でも構いません。"],
  ];
  team.forEach((t, i) => {
    const x = M + i * (w + 0.4);
    card(s, x, 2.85, w, 2.0, PAPER_C, true);
    s.addText(t[0], { x: x + 0.35, y: 3.1, w: w - 0.7, h: 0.36, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 17, bold: true, color: INK });
    s.addText(t[1], { x: x + 0.35, y: 3.55, w: w - 0.7, h: 1.2, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 12, color: CARDTX, lineSpacingMultiple: 1.28 });
  });
  s.addText("外注する領域", { x: M, y: 5.15, w: 3, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 11, bold: true, charSpacing: 2, color: EMBER_L });
  bullets(s, [
    "カラーグレーディング（シリーズのルックを揃える初回だけ、設計をお願いします）",
    "MA・整音（現場音を残す方針なので、必要な回だけお願いします）",
    "字幕・翻訳（道外や海外に出すときに追加します）",
  ], { x: M, y: 5.5, w: CW, h: 1.15, fontSize: 12.5, color: CARDTX, paraSpaceAfter: 8 });
  s.addNotes("窓口の一本化が重要。被写体から見て話す相手が一人でないと本音が出ない。");
}

/* =========================================================
   14  スケジュール
========================================================= */
{
  const s = base(true);
  head(s, { n: "13", dark: true, eye: "SCHEDULE ／ 進行",
    t: "まず1本撮ります。営業はその後です",
    sub: "企画書だけでは伝わりません。1本目は自己資金と知人の被写体で撮り切って、それを持って営業に行きます。" });
  const w = (CW - 3 * 0.35) / 4;
  const ph = [
    ["MONTH 0", "パイロット制作", "被写体は知人から1名。自己資金で撮り切ります。同意書と試写ルールも、ここで実際に試します。"],
    ["MONTH 1–2", "公開・検証・営業", "パイロットを出して反応を見ます。同時に、この1本を持って協賛と受託の営業を始めます。"],
    ["MONTH 3–8", "シーズン1（6本）", "月1本で6本。3本目までに、人を紹介してもらうルートを固めます。"],
    ["MONTH 9", "上映会・次期座組", "地域で上映会をやって、シーズン2の被写体と協賛を決めます。"],
  ];
  ph.forEach((p, i) => {
    const x = M + i * (w + 0.35);
    card(s, x, 2.8, w, 2.35, INK_C, false);
    s.addText(p[0], { x: x + 0.3, y: 3.0, w: w - 0.6, h: 0.28, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 11, bold: true, charSpacing: 1.5, color: EMBER });
    s.addText(p[1], { x: x + 0.3, y: 3.32, w: w - 0.6, h: 0.4, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 16, bold: true, color: "FFFFFF" });
    s.addText(p[2], { x: x + 0.3, y: 3.8, w: w - 0.6, h: 1.22, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11.5, color: FROST, lineSpacingMultiple: 1.25 });
  });
  s.addText("初年度の目標（たたき台）", { x: M, y: 5.42, w: 4, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 11, bold: true, charSpacing: 2, color: EMBER });
  const kw = (CW - 3 * 0.35) / 4;
  const kpi = [["6", "本", "シーズン1の公開本数"], ["30", "％", "本編の平均視聴完了率"], ["12", "件", "映像制作の問い合わせ"], ["1–2", "社", "年間協賛の獲得"]];
  kpi.forEach((k, i) => {
    const x = M + i * (kw + 0.35);
    s.addText([{ text: k[0], options: { fontSize: 30, bold: true, color: "FFFFFF", fontFace: FE } }, { text: " " + k[1], options: { fontSize: 13, color: EMBER, fontFace: FJ } }],
      { x, y: 5.72, w: kw, h: 0.5, isTextBox: true, margin: 0, valign: "middle" });
    s.addText(k[2], { x, y: 6.24, w: kw, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11, color: SLATE });
  });
  s.addNotes("数字は仮置き。パイロット1本の実績が出た時点で全部引き直す前提で話す。");
}

/* =========================================================
   15  予算
========================================================= */
{
  const s = base(false);
  head(s, { n: "14", dark: false, eye: "BUDGET ／ 予算感",
    t: "1本あたり、だいたい14万円です",
    sub: "道東で2〜3日のロケを想定した、自主制作のときの実費です。自分の人件費は入れていない、たたき台の数字です。" });
  s.addChart(pres.ChartType.bar, [{
    name: "1本あたり実費",
    labels: ["交通・宿泊", "外注（カラー・MA）", "機材・消耗品", "予備費"],
    values: [60000, 50000, 15000, 15000],
  }], {
    x: 0.55, y: 2.75, w: 7.0, h: 3.5,
    barDir: "bar", barGapWidthPct: 55,
    showTitle: true, title: "1本あたり実費の内訳（円）", titleColor: INK, titleFontSize: 13, titleFontFace: FJ,
    showValue: true, dataLabelPosition: "outEnd", dataLabelColor: "46505A", dataLabelFontSize: 10, dataLabelFontFace: FE, dataLabelFormatCode: "#,##0",
    chartColors: [EMBER],
    showLegend: false,
    catAxisLabelColor: "46505A", catAxisLabelFontSize: 11, catAxisLabelFontFace: FJ,
    valAxisLabelColor: "8A949B", valAxisLabelFontSize: 9, valAxisLabelFormatCode: "#,##0",
    valAxisMaxVal: 80000,
    valGridLine: { color: "DDE1E4", size: 1 }, catGridLine: { style: "none" },
  });
  const x2 = 8.0, rw = W - x2 - M;
  card(s, x2, 2.75, rw, 1.5, INK, true);
  s.addText("シーズン1（6本）の実費", { x: x2 + 0.45, y: 2.98, w: rw - 0.9, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 12, color: FROST });
  s.addText([
    { text: "約 ", options: { fontSize: 18, bold: true, color: FROST, fontFace: FM } },
    { text: "84", options: { fontSize: 40, bold: true, color: EMBER, fontFace: FE } },
    { text: " 万円", options: { fontSize: 17, bold: true, color: "FFFFFF", fontFace: FM } },
  ], { x: x2 + 0.45, y: 3.32, w: rw - 0.9, h: 0.75, isTextBox: true, margin: 0, valign: "middle" });
  card(s, x2, 4.4, rw, 1.85, PAPER_C, true);
  bullets(s, [
    "自分の人件費は入れていない実費です。",
    "羅臼や根室など遠方のロケは、交通宿泊費が上振れします。",
    "受注1件で、シーズン1本分の実費は回収できる水準を目安にします。",
  ], { x: x2 + 0.45, y: 4.65, w: rw - 0.9, h: 1.45, fontSize: 12, color: CARDTX, paraSpaceAfter: 9 });
  s.addText("※ 数字は全部想定です。パイロットを1本撮った時点で、実績に置き換えます。", {
    x: M, y: 6.42, w: CW, h: 0.32, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11, color: "6B767F",
  });
  s.addNotes("金額は仮。パイロットで実績に差し替えますと必ず添える。");
}

/* =========================================================
   16  倫理とリスク
========================================================= */
{
  const s = base(true);
  head(s, { n: "15", dark: true, eye: "ETHICS & RISK ／ 倫理",
    t: "出てくれた人を守れないなら、撮りません",
    sub: "綺麗事を撮らないことと、人を傷つけることは違います。その線引きだけは、撮る前に仕組みとして決めておきます。" });
  const cw = (CW - 0.45) / 2;
  const left = [
    ["同意と、取り下げ", "書面での同意と、公開前の試写は必ずやります。公開した後も、期限なしで取り下げの申し出を受けます。"],
    ["本人以外への配慮", "本人以外が特定される話は、本人の許可があっても慎重に扱います。家族、従業員、取引先です。"],
    ["途中でやめるとき", "撮影の途中で本人が降りたら、それまでの素材は一切使いません。そう約束してから撮り始めます。"],
  ];
  const right = [
    ["見世物にはしません", "貧しさや失敗や病気を、画の強さのために使いません。演出で不幸を足すことは絶対にしません。"],
    ["素材の管理", "暗号化した外付けに二重でバックアップします。未公開の素材は、関係者にも渡しません。"],
    ["炎上への備え", "切り抜かれて広がる前提で作ります。単体で誤解される画は本編に置きません。窓口と手順も先に決めます。"],
  ];
  [left, right].forEach((col, ci) => {
    const x = M + ci * (cw + 0.45);
    col.forEach((it, i) => {
      const y = 2.8 + i * 1.2;
      card(s, x, y, cw, 1.05, INK_C, false);
      s.addText(it[0], { x: x + 0.35, y: y + 0.15, w: cw - 0.7, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 15, bold: true, color: EMBER });
      s.addText(it[1], { x: x + 0.35, y: y + 0.49, w: cw - 0.7, h: 0.5, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11.5, color: FROST, lineSpacingMultiple: 1.2 });
    });
  });
  s.addNotes("撮らない勇気の話。ここを詰めておくと、紹介が紹介を呼ぶ。");
}

/* =========================================================
   17  3年ロードマップ
========================================================= */
{
  const s = base(false);
  head(s, { n: "16", dark: false, eye: "ROADMAP ／ 3年後",
    t: "3年で、100人分残したいです",
    sub: "1本ずつは小さな記録でも、積み上がれば北海道の同時代史になると思っています。" });
  const w = (CW - 0.8) / 3;
  const yr = [
    ["YEAR 1", "6本", "道東で6本。地域のなかで、あの映像の人と覚えてもらえる状態をつくります。"],
    ["YEAR 2", "12本", "全道に広げて年12本。企業ドキュメントの受注が、事業の柱になっている状態を目指します。"],
    ["YEAR 3", "100人", "アーカイブが100人分。上映ツアーや展示、書籍化も考えます。残した記録が、次の被写体を連れてきてくれるはずです。"],
  ];
  yr.forEach((y, i) => {
    const x = M + i * (w + 0.4);
    const dark = i === 2;
    card(s, x, 2.85, w, 2.85, dark ? INK : PAPER_C, true);
    s.addText(y[0], { x: x + 0.4, y: 3.1, w: w - 0.8, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 11, bold: true, charSpacing: 2, color: dark ? EMBER : EMBER_L });
    s.addText(y[1], { x: x + 0.4, y: 3.45, w: w - 0.8, h: 0.85, isTextBox: true, margin: 0, valign: "middle", fontFace: FE, fontSize: 46, bold: true, color: dark ? "FFFFFF" : INK });
    s.addText(y[2], { x: x + 0.4, y: 4.4, w: w - 0.8, h: 1.2, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 12, color: dark ? FROST : CARDTX, lineSpacingMultiple: 1.3 });
  });
  s.addText("残したいのは再生数じゃなくて、あの時こう言っていた、と確認できる記録の束です。", {
    x: M, y: 6.05, w: CW, h: 0.4, isTextBox: true, margin: 0, valign: "top",
    fontFace: FM, fontSize: 15, bold: true, color: INK,
  });
  s.addNotes("再生数ではなくアーカイブの価値で話す。自治体や企業に効くのはこっち。");
}

/* =========================================================
   18  クロージング
========================================================= */
{
  const s = base(true);
  s.addText("GENZAICHI", {
    x: M, y: 0.85, w: 8, h: 0.4, isTextBox: true, margin: 0, valign: "top",
    fontFace: FE, fontSize: 14, bold: true, charSpacing: 6, color: EMBER,
  });
  s.addText("まだ、途中です。", {
    x: M, y: 2.25, w: 11.9, h: 1.3, isTextBox: true, margin: 0, valign: "middle",
    fontFace: FM, fontSize: 58, bold: true, color: "FFFFFF",
  });
  s.addText("完成した人生を見せるメディアは、もう十分にあります。撮りたいのは、まだ決着のついていない現在地の方です。", {
    x: M, y: 3.72, w: 11.0, h: 0.5, isTextBox: true, margin: 0, valign: "top",
    fontFace: FJ, fontSize: 14, color: FROST, lineSpacingMultiple: 1.25,
  });
  s.addText("次に決めること", { x: M, y: 4.7, w: 4, h: 0.3, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 11, bold: true, charSpacing: 2, color: EMBER });
  const w = (CW - 0.8) / 3;
  const nx = [
    ["パイロットの被写体", "知人と紹介から1名。断られる前提で、3人に当たります。"],
    ["公開する場所", "YouTubeチャンネルと公式サイト。名前と説明文を先に固めます。"],
    ["同意書と試写のルール", "取り下げの条項、直せる範囲、素材の管理を書面にします。"],
  ];
  nx.forEach((n, i) => {
    const x = M + i * (w + 0.4);
    card(s, x, 5.1, w, 1.5, INK_C, false);
    s.addText(String(i + 1).padStart(2, "0"), { x: x + 0.35, y: 5.28, w: 1, h: 0.28, isTextBox: true, margin: 0, valign: "top", fontFace: FE, fontSize: 12, bold: true, color: EMBER });
    s.addText(n[0], { x: x + 0.35, y: 5.56, w: w - 0.7, h: 0.34, isTextBox: true, margin: 0, valign: "top", fontFace: FM, fontSize: 15, bold: true, color: "FFFFFF" });
    s.addText(n[1], { x: x + 0.35, y: 5.94, w: w - 0.7, h: 0.55, isTextBox: true, margin: 0, valign: "top", fontFace: FJ, fontSize: 11, color: FROST, lineSpacingMultiple: 1.2 });
  });
  s.addNotes("締めは短く。まず1本撮りますで終える。");
}

pres.writeFile({ fileName: process.argv[2] || "GENZAICHI_企画書.pptx" }).then((f) => console.log("written:", f));
