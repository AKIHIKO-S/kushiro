// 申込の集計Excel(1冊)。受付台帳と同じ「申込団体」単位で、参加費・名簿・種目別名簿・領収書差し込みを出す。
// 見た目は協会サイト調(public/shared/site-tokens.css)の色に合わせる: 見出しは紺、罫は細い灰、要確認は琥珀。
// 名簿と金額の集計は確定のみ。「要確認」には承認待ちと、確認事項のある確定行を出す。
// 取消・却下だけは出さない。生年月日・連絡先(メール・電話)は出さない(印刷・共有される前提のため)。
const XLSX = require("xlsx-js-style");

const C = {
  ink: "1B1D22", navy: "14294A", white: "FFFFFF", sky: "EAF0F6", wash: "F2F3F1",
  mute: "5C6068", line: "D7D8DA", warn: "8A6510", warnBg: "F6EEDB",
};
const FONT = "BIZ UDPGothic";
const YEN = '#,##0"円"';
const NUM = "#,##0";
const hair = { style: "thin", color: { rgb: C.line } };
const box = { top: hair, bottom: hair, left: hair, right: hair };

const st = {
  title: { font: { name: FONT, sz: 15, bold: true, color: { rgb: C.ink } } },
  sub: { font: { name: FONT, sz: 10, color: { rgb: C.mute } } },
  head: { font: { name: FONT, sz: 10, bold: true, color: { rgb: C.white } }, fill: { fgColor: { rgb: C.navy } },
    alignment: { vertical: "center", horizontal: "center", wrapText: true }, border: box },
  cell: { font: { name: FONT, sz: 10.5, color: { rgb: C.ink } }, alignment: { vertical: "center", wrapText: true }, border: box },
  num: { font: { name: FONT, sz: 10.5, color: { rgb: C.ink } }, alignment: { vertical: "center", horizontal: "right" }, border: box },
  warn: { font: { name: FONT, sz: 10, bold: true, color: { rgb: C.warn } }, fill: { fgColor: { rgb: C.warnBg } },
    alignment: { vertical: "center", wrapText: true }, border: box },
  group: { font: { name: FONT, sz: 10.5, bold: true, color: { rgb: C.navy } }, fill: { fgColor: { rgb: C.sky } },
    alignment: { vertical: "center", wrapText: true }, border: box },
  total: { font: { name: FONT, sz: 10.5, bold: true, color: { rgb: C.ink } }, fill: { fgColor: { rgb: C.wash } },
    alignment: { vertical: "center", horizontal: "right" }, border: { ...box, top: { style: "medium", color: { rgb: C.ink } } } },
  totalLabel: { font: { name: FONT, sz: 10.5, bold: true, color: { rgb: C.ink } }, fill: { fgColor: { rgb: C.wash } },
    alignment: { vertical: "center" }, border: { ...box, top: { style: "medium", color: { rgb: C.ink } } } },
};

// 表示幅: 全角=2・半角=1 で数え、列幅(文字数)を決める。全項目が切れずに見える幅にする。
function textWidth(v) {
  let w = 0;
  for (const ch of String(v == null ? "" : v)) w += /[\u0000-ÿ｡-ﾟ]/.test(ch) ? 1 : 2;
  return w;
}
function displayOf(v, fmt) {
  if (typeof v === "number") return (fmt === YEN ? v.toLocaleString("ja-JP") + "円" : v.toLocaleString("ja-JP"));
  return v == null ? "" : String(v);
}

// rows: [{ cells:[{v, s, z}], height? }]。header は列見出し。title/subtitle は表の上に置く。
function makeSheet({ title, subtitle, header, rows, minWidths = [], maxWidth = 60, landscape = true }) {
  const ws = {};
  const put = (r, c, v, s, z) => {
    const ref = XLSX.utils.encode_cell({ r, c });
    const cell = { v: v == null ? "" : v, t: typeof v === "number" ? "n" : "s", s };
    if (z) cell.z = z;
    ws[ref] = cell;
  };
  const widths = header.map((h, i) => Math.max(minWidths[i] || 6, ...String(h).split("\n").map(textWidth)));
  put(0, 0, title, st.title);
  put(1, 0, subtitle || "", st.sub);
  const top = 3;
  header.forEach((h, c) => put(top, c, h, st.head));
  rows.forEach((row, i) => {
    row.cells.forEach((cell, c) => {
      if (!cell) { put(top + 1 + i, c, "", st.cell); return; }
      put(top + 1 + i, c, cell.v, cell.s || (typeof cell.v === "number" ? st.num : st.cell), cell.z);
      // 結合して横に広げる見出し行(団体名の行など)は列幅の計算に入れない(No.列だけ太くなるのを防ぐ)
      if (row.span) return;
      const lines = displayOf(cell.v, cell.z).split("\n");
      widths[c] = Math.max(widths[c], ...lines.map(textWidth));
    });
  });
  const lastRow = top + rows.length;
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: header.length - 1 } });
  ws["!cols"] = widths.map(w => ({ wch: Math.min(maxWidth, w + 3) }));
  ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }, { hpt: 8 }, { hpt: 30 }, ...rows.map(r => ({ hpt: r.height || 22 }))];
  ws["!autofilter"] = rows.length ? { ref: XLSX.utils.encode_range({ s: { r: top, c: 0 }, e: { r: lastRow, c: header.length - 1 } }) } : undefined;
  ws["!margins"] = { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
  ws["!print"] = { orientation: landscape ? "landscape" : "portrait" };
  return ws;
}

// Excelのシート名は31文字まで・[]:*?/\ は使えない・重複不可。
function sheetName(name, used) {
  let base = String(name || "種目").replace(/[\[\]:*?/\\]/g, "・").slice(0, 28) || "種目";
  let n = base, i = 2;
  while (used.has(n)) n = base.slice(0, 26) + "(" + i++ + ")";
  used.add(n);
  return n;
}

const KIND_LABEL = { singles: "シングルス", doubles: "ダブルス", team: "団体" };

// data: db.getEntryExport の戻り値
function buildEntryWorkbook(data) {
  const t = data.tournament || {};
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const when = [t.date, t.venue].filter(Boolean).join("　");
  const made = "作成 " + (data.generated_at || "");
  const subtitle = [when, made].filter(Boolean).join("　｜　");
  const groups = data.groups || [];
  const events = data.events || [];
  const custom = data.custom_fields || [];
  const review = data.review || [];
  const unknownFees = groups.flatMap(g => g.entries).filter(e => e.fee === null).length;
  const checkCell = e => (e.checks && e.checks.length) ? { v: e.checks.join("\n"), s: st.warn } : { v: "" };
  const feeCell = e => e.fee === null ? { v: "未確認", s: st.warn } : { v: e.fee, z: YEN };

  // ─── 1. 集計用: 申込団体ごとの参加費 ───
  {
    const header = ["No.", "申込団体", "申込者", ...events.map(e => e.name.replace(/(シングルス|ダブルス)/, "\n$1")), "確定出場", "保存済み参加費", "要確認"];
    const rows = [];
    const evTotal = events.map(() => 0);
    let nTotal = 0, feeTotal = 0, checkTotal = 0;
    groups.forEach((g, i) => {
      const counts = events.map((ev, k) => { const n = g.entries.filter(e => e.event === ev.name).length; evTotal[k] += n; return n; });
      const checks = g.entries.filter(e => e.checks.length).length;
      nTotal += g.entries.length; feeTotal += g.fee_total; checkTotal += checks;
      rows.push({ cells: [
        { v: i + 1, s: st.num }, { v: g.name }, { v: g.contact_name || "" },
        ...counts.map(n => ({ v: n || "", s: st.num, z: NUM })),
        { v: g.entries.length, z: NUM }, feeCell({ fee: g.entries.every(e => e.fee === null) ? null : g.fee_total }),
        checks ? { v: checks + "件", s: st.warn } : { v: "" },
      ] });
    });
    rows.push({ cells: [
      { v: "", s: st.totalLabel }, { v: "確定出場合計", s: st.totalLabel }, { v: "", s: st.totalLabel },
      ...evTotal.map(n => ({ v: n, s: st.total, z: NUM })),
      { v: nTotal, s: st.total, z: NUM }, { ...feeCell({ fee: nTotal && nTotal === unknownFees ? null : feeTotal }), s: st.total },
      { v: checkTotal ? checkTotal + "件" : "", s: st.total },
    ] });
    const feeNote = unknownFees ? `参加費未確認 ${unknownFees}件は合計外` : "";
    const ws = makeSheet({ title: (t.name || "大会") + "　確定出場の参加費集計",
      subtitle: [subtitle, feeNote].filter(Boolean).join("　｜　"), header, rows,
      minWidths: [4, 18, 10, ...events.map(() => 6), 6, 10, 8] });
    XLSX.utils.book_append_sheet(wb, ws, sheetName("集計用", used));
  }

  // 名簿の1行(氏名欄): シングルス=本人 / ダブルス=2人 / 団体=チーム名+メンバー
  const personCols = custom.map(c => c.label);
  const rosterRow = (e, lead) => {
    const extra = custom.map(c => ({ v: e.answers[c.key] != null ? String(e.answers[c.key]) : "" }));
    return [
      ...lead,
      { v: e.event },
      { v: e.name_text }, { v: e.kana_text }, { v: e.team_text },
      { v: e.class_text }, { v: e.grade_text }, { v: e.age_text },
      ...extra,
      feeCell(e),
      checkCell(e),
    ];
  };
  const personHeader = ["種目", "氏名", "ふりがな", "所属", "区分", "学年", "年齢", ...personCols, "参加費", "確認事項"];
  const personMin = [12, 14, 14, 12, 6, 5, 5, ...custom.map(() => 8), 9, 14];

  // ─── 2. 選手名簿(申込団体ごと) ───
  {
    const rows = [];
    groups.forEach(g => {
      rows.push({ cells: [{ v: g.name + (g.contact_name ? "（申込者 " + g.contact_name + "）" : "") + "　" + g.entries.length + "件", s: st.group },
        ...personHeader.map(() => ({ v: "", s: st.group }))], span: true });
      g.entries.forEach((e, i) => rows.push({ cells: rosterRow(e, [{ v: i + 1, s: st.num }]),
        height: Math.max(22, 16 * Math.max(e.lines, (e.checks || []).length)) }));
    });
    const ws = makeSheet({ title: (t.name || "大会") + "　選手名簿（申込団体別）", subtitle, header: ["No.", ...personHeader], rows,
      minWidths: [4, ...personMin] });
    // 団体の見出し行はセル結合して1行に見せる
    let r = 4;
    ws["!merges"] = [];
    groups.forEach(g => { ws["!merges"].push({ s: { r, c: 0 }, e: { r, c: personHeader.length } }); r += 1 + g.entries.length; });
    XLSX.utils.book_append_sheet(wb, ws, sheetName("選手名簿", used));
  }

  if (review.length) {
    const rows = review.map((e, i) => ({
      cells: rosterRow(e, [{ v: i + 1, s: st.num }, { v: e.group }, { v: e.status }]),
      height: Math.max(22, 16 * Math.max(e.lines, e.checks.length)),
    }));
    const ws = makeSheet({ title: (t.name || "大会") + "　要確認",
      subtitle: subtitle + "　｜　承認待ちは確定出場の集計・名簿には含みません",
      header: ["No.", "申込団体", "状態", ...personHeader], rows, minWidths: [4, 18, 9, ...personMin] });
    XLSX.utils.book_append_sheet(wb, ws, sheetName("要確認", used));
  }

  const receiptSheet = sheetName("領収書差し込み用", used);
  // ─── 3. 種目ごとの名簿 ───
  events.forEach(ev => {
    const list = [];
    groups.forEach(g => g.entries.filter(e => e.event === ev.name).forEach(e => list.push({ g, e })));
    if (!list.length) return;
    const header = ["No.", "氏名", "ふりがな", "所属", "区分", "学年", "年齢", ...personCols, "申込団体", "確認事項"];
    const rows = list.map(({ g, e }, i) => ({ cells: [
      { v: i + 1, s: st.num }, { v: e.name_text }, { v: e.kana_text }, { v: e.team_text },
      { v: e.class_text }, { v: e.grade_text }, { v: e.age_text },
      ...custom.map(c => ({ v: e.answers[c.key] != null ? String(e.answers[c.key]) : "" })),
      { v: g.name }, checkCell(e),
    ], height: Math.max(22, 16 * Math.max(e.lines, (e.checks || []).length)) }));
    const unit = ev.kind === "doubles" ? "組" : ev.kind === "team" ? "チーム" : "人";
    const ws = makeSheet({ title: (t.name || "大会") + "　" + ev.name + "（" + list.length + unit + "）", subtitle, header, rows,
      minWidths: [4, 14, 14, 12, 6, 5, 5, ...custom.map(() => 8), 14, 14] });
    XLSX.utils.book_append_sheet(wb, ws, sheetName(ev.name, used));
  });

  // ─── 4. 領収書差し込み用 ───
  {
    const header = ["No.", "宛名（申込団体）", "申込者", "金額", "但し書き", "件数", "大会名", "大会日", "要確認"];
    const ready = groups.filter(g => !g.fee_unknown);
    const rows = ready.map((g, i) => ({ cells: [
      { v: i + 1, s: st.num }, { v: g.name }, { v: g.contact_name || "" }, { v: g.fee_total, z: YEN },
      { v: (t.name || "大会") + " 参加費として" }, { v: g.entries.length, z: NUM },
      { v: t.name || "" }, { v: t.date || "" },
      g.entries.some(e => e.checks.length) ? { v: "名簿に確認事項あり", s: st.warn } : { v: "" },
    ] }));
    const feeNote = ready.length !== groups.length ? `参加費未確認の申込 ${groups.length - ready.length}件は発行保留` : "";
    const ws = makeSheet({ title: (t.name || "大会") + "　領収書 差し込み用一覧",
      subtitle: [subtitle, feeNote].filter(Boolean).join("　｜　"), header, rows,
      minWidths: [4, 18, 10, 10, 20, 5, 16, 10, 10] });
    XLSX.utils.book_append_sheet(wb, ws, receiptSheet);
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true });
}

module.exports = { buildEntryWorkbook, KIND_LABEL, textWidth };
