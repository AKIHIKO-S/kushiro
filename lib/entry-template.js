// 申込フォームの「Excelで一括入力」用テンプレートの作成と読み取り。
//
// 流れ: 申込者がテンプレをダウンロード → 記入 → フォームで読み込む → フォームの入力欄に流し込む →
//       画面で確認して、いつもの送信ボタンで送る。
// ここでは申込を登録しない(読み取った値を返すだけ)。必須チェック・同じ種目の重複・申込番号の発行は
// すべて通常の送信で行う=受付の規則を二重に持たない。
//
// 列は大会の申込フォームと同じ規則で出し分ける(フォームに無い項目の列は作らない)。
// 種目ごとに1シート。読み取りは見出しの文字で列を探すので、列の並べ替えには強い。
const XLSX = require("xlsx-js-style");
const { unzipSync, zipSync, strFromU8, strToU8 } = require("fflate");

const FONT = "BIZ UDPGothic";
const NAVY = "14294A", SKY = "EAF0F6", WASH = "F2F3F1", INK = "1B1D22", MUTE = "5C6068", LINE = "C9CDD3";
const thin = { style: "thin", color: { rgb: LINE } };
const box = { top: thin, bottom: thin, left: thin, right: thin };
const st = {
  title: { font: { name: FONT, sz: 15, bold: true, color: { rgb: NAVY } } },
  sub: { font: { name: FONT, sz: 10, color: { rgb: MUTE } }, alignment: { wrapText: true, vertical: "top" } },
  head: { font: { name: FONT, sz: 10.5, bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: NAVY } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: box },
  cell: { font: { name: FONT, sz: 11, color: { rgb: INK } }, alignment: { vertical: "center" }, border: box },
  label: { font: { name: FONT, sz: 11, bold: true, color: { rgb: INK } }, fill: { patternType: "solid", fgColor: { rgb: SKY } },
    alignment: { vertical: "center" }, border: box },
  text: { font: { name: FONT, sz: 11, color: { rgb: INK } }, alignment: { vertical: "top", wrapText: true } },
  textBold: { font: { name: FONT, sz: 11, bold: true, color: { rgb: NAVY } }, alignment: { vertical: "top", wrapText: true } },
};

const GRADES = ["小1", "小2", "小3", "小4", "小5", "小6", "中1", "中2", "中3", "高1", "高2", "高3", "一般"];
const MAX_ROWS = 300;        // 1種目で読む行数の上限(誤って巨大なシートを読まないため)
const CLIP = 200;

// ── フォームと同じ出し分け(entry_form.js の fstFor / gradeStateFor と同じ規則) ──
function fstFor(cfg, evName, key) {
  const ov = cfg.event_overrides && cfg.event_overrides[evName];
  if (ov && ov[key]) return ov[key];
  return (cfg.fields && cfg.fields[key]) || "hidden";
}
function isStudentEvent(ev) {
  const c = String((ev && ev.category) || "");
  if (["elementary", "middle", "high", "junior", "youth", "student"].includes(c)) return true;
  if (["general", "senior", "large"].includes(c)) return false;
  return /小学|中学|高校|中高|高中|ジュニア|カデット|ホープス|カブ|バンビ|学生/.test(String((ev && ev.name) || ""));
}
function gradeState(cfg, ev) {
  const s = fstFor(cfg, ev.name, "grade");
  const ov = cfg.event_overrides && cfg.event_overrides[ev.name];
  if (ov && ov.grade) return s;
  if (s === "hidden") return "hidden";
  const c = String(ev.category || "");
  if (c === "senior" || c === "large") return "hidden";
  return isStudentEvent(ev) ? s : "optional";
}
function labelOf(cfg, key, def) {
  const m = cfg.field_meta && cfg.field_meta[key];
  return (m && typeof m.label === "string" && m.label.trim()) || def;
}
// 参加区分(一般/中学生/高校生 など)を行ごとに選ぶ種目か。選べる区分の表示名を返す。
function divisionOptions(ev) {
  if (Array.isArray(ev.entry_categories) && ev.entry_categories.length) {
    return ev.entry_categories.map(c => String(c.short || c.label || c.value || "")).filter(Boolean);
  }
  if (ev.fee_student != null && ev.fee_student !== (ev.fee || 0)) return ["一般", "中学生", "高校生"];
  return null;
}

// 1人ぶんの列(シングルス・ダブルスの各選手)。key は読み取り後の値の名前。
function personColumns(cfg, ev) {
  const cols = [{ key: "name", label: "氏名", req: true, help: "姓と名の間に空白" }];
  const add = (key, fkey, def, extra) => {
    const s = fstFor(cfg, ev.name, fkey);
    if (s !== "hidden") cols.push({ key, label: labelOf(cfg, fkey, def), req: s === "required", ...(extra || {}) });
  };
  add("furigana", "furigana", "ふりがな", { help: "ひらがな" });
  add("team", "player_team", "所属");
  const g = gradeState(cfg, ev);
  if (g !== "hidden") cols.push({ key: "grade", label: labelOf(cfg, "grade", "学年"), req: g === "required", help: "小1〜高3・一般" });
  if (ev.age_check && ev.age_check.mode === "birthdate") cols.push({ key: "birthdate", label: "生年月日", req: true, help: "例 2012/4/1" });
  else if (ev.age_check && ev.age_check.mode === "age") cols.push({ key: "age", label: "年齢", req: true });
  add("gender", "player_gender", "性別", { help: "男・女" });
  add("region", "player_region", "支部");
  add("first_time", "first_time", "出場経験", { help: "初めて・出場したことがある" });
  add("zendo_intent", "zendo_intent", "全道大会に出場する意思", { help: "あり・なし" });
  (cfg.custom || []).filter(c => c && c.key && c.scope === "player").forEach(c => {
    cols.push({ key: "cust:" + c.key, label: String(c.label || c.key).slice(0, 40), req: !!c.required,
      help: c.type === "select" && Array.isArray(c.options) ? c.options.slice(0, 6).join("・") : (c.type === "checkbox" ? "はい / 空欄" : "") });
  });
  return cols;
}

// 種目の列定義。doubles は「選手1 ◯◯」「選手2 ◯◯」、team は チーム名 + メンバー。
function eventColumns(cfg, ev) {
  const div = divisionOptions(ev);
  const divCol = div ? [{ key: "division", label: "参加区分", req: false, help: div.join("・") }] : [];
  if (ev.type === "team") {
    const per = Math.max(1, Math.min(30, parseInt(ev.per_team, 10) || 6));
    const minN = Math.max(0, Math.min(per, parseInt(ev.per_team_min, 10) || 0));
    const cols = [{ key: "team_name", label: "チーム名", req: true }];
    for (let i = 1; i <= per; i++) cols.push({ key: "m" + i, label: "メンバー" + i, req: i <= minN });
    return cols.concat(divCol);
  }
  const p = personColumns(cfg, ev);
  if (ev.type === "doubles") {
    return [1, 2].flatMap(n => p.map(c => ({ ...c, key: "p" + n + "." + c.key, label: "選手" + n + " " + c.label })))
      .concat(divCol);
  }
  return p.concat(divCol);
}

function contactRows(cfg, admin) {
  const rows = [
    { key: "team_name", label: labelOf(cfg, "team_name", "団体名"), req: (cfg.fields.team_name || "required") === "required", show: (cfg.fields.team_name || "required") !== "hidden" },
    { key: "contact_name", label: "申込責任者（氏名）", req: !admin, show: true },
    { key: "contact_tel", label: "電話番号", req: !admin, show: true },
    { key: "contact_email", label: "メールアドレス", req: !admin, show: true },
    { key: "supervisor", label: labelOf(cfg, "supervisor", "引率顧問"), req: cfg.fields.supervisor === "required", show: cfg.fields.supervisor !== "hidden" },
    { key: "advisor", label: labelOf(cfg, "advisor", "顧問"), req: cfg.fields.advisor === "required", show: cfg.fields.advisor !== "hidden" },
    { key: "coach", label: labelOf(cfg, "coach", "コーチ"), req: cfg.fields.coach === "required", show: cfg.fields.coach !== "hidden" },
  ];
  return rows.filter(r => r.show);
}

function textWidth(v) {
  let w = 0;
  for (const ch of String(v == null ? "" : v)) w += /[\u0000-ÿ]/.test(ch) ? 1 : 2;
  return w;
}
function sheetName(name, used) {
  const base = String(name || "種目").replace(/[\[\]:*?/\\]/g, "・").slice(0, 28) || "種目";
  let n = base, i = 2;
  while (used.has(n)) n = base.slice(0, 26) + "_" + (i++);
  used.add(n);
  return n;
}
const headLabel = (c) => c.label + (c.req ? "（必須）" : "");

// ── テンプレートを作る ──
function buildEntryTemplate({ tournament, events, fieldConfig, admin }) {
  const cfg = fieldConfig;
  const t = tournament || {};
  const wb = XLSX.utils.book_new();
  const used = new Set();
  const evs = (events || []).filter(e => e && e.name && !e.full);

  // 使い方
  {
    const lines = [
      [(t.name || "大会") + "　申込テンプレート", st.title],
      ["このファイルに記入して、申込フォームの「Excelで一括入力」から読み込むと、フォームの入力欄に自動で入ります。", st.text],
      ["読み込んだだけでは申込になりません。フォームの画面で内容を確かめてから「申込内容を送信」を押してください。", st.textBold],
      ["", st.text],
      ["書き方", st.textBold],
      ["1.「申込者」シートに団体名・申込責任者・連絡先を書きます。", st.text],
      ["2. 出場する種目のシートに、1行に1人（ダブルスは1組、団体戦は1チーム）ずつ書きます。出ない種目のシートは空欄のままにしてください。", st.text],
      ["3. 見出しに（必須）とある欄は必ず書いてください。氏名は姓と名の間に空白を入れてください。", st.text],
      ["　 ダブルスで相手が決まっていない場合は、選手2の欄を空欄にすると「ペア希望」として申し込めます。", st.text],
      ["4. 見出しの文字・シートの名前は変えないでください（並べ替えは問題ありません）。", st.text],
      ["", st.text],
      ["選べる値", st.textBold],
      ["学年: " + GRADES.join("・"), st.text],
      ["性別: 男・女", st.text],
      ["出場経験: 初めて・出場したことがある", st.text],
      ["", st.text],
      ["同じ選手を同じ種目に重ねて申し込むことはできません。申込後の修正・追加は、控えメールの申込番号から行ってください。", st.text],
    ];
    const ws = {};
    lines.forEach(([v, s], r) => { ws[XLSX.utils.encode_cell({ r, c: 0 })] = { v, t: "s", s }; });
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lines.length - 1, c: 0 } });
    ws["!cols"] = [{ wch: 110 }];
    ws["!rows"] = lines.map((_, i) => ({ hpt: i === 0 ? 26 : 22 }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName("使い方", used));
  }

  // 申込者
  {
    const rows = contactRows(cfg, admin);
    const ws = {};
    ws.A1 = { v: "申込者", t: "s", s: st.title };
    ws.A2 = { v: "右の「記入欄」に書いてください。", t: "s", s: st.sub };
    ws.A4 = { v: "項目", t: "s", s: st.head };
    ws.B4 = { v: "記入欄", t: "s", s: st.head };
    rows.forEach((r, i) => {
      ws[XLSX.utils.encode_cell({ r: 4 + i, c: 0 })] = { v: headLabel(r), t: "s", s: st.label };
      ws[XLSX.utils.encode_cell({ r: 4 + i, c: 1 })] = { v: "", t: "s", s: st.cell };
    });
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 4 + rows.length - 1, c: 1 } });
    ws["!cols"] = [{ wch: 26 }, { wch: 44 }];
    ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }, { hpt: 8 }, { hpt: 26 }, ...rows.map(() => ({ hpt: 26 }))];
    XLSX.utils.book_append_sheet(wb, ws, sheetName("申込者", used));
  }

  // 種目ごと
  const BLANK = 20;
  const gradeCols = [];   // シート順(1始まり) → 学年の列(リスト入力にする)
  evs.forEach(ev => {
    const cols = eventColumns(cfg, ev);
    const ws = {};
    const unit = ev.type === "team" ? "1行に1チーム" : ev.type === "doubles" ? "1行に1組" : "1行に1人";
    ws.A1 = { v: "種目：" + ev.name, t: "s", s: st.title };
    ws.A2 = { v: unit + "。出ない場合は空欄のままにしてください。", t: "s", s: st.sub };
    const helps = cols.map(c => c.help || "");
    cols.forEach((c, i) => {
      ws[XLSX.utils.encode_cell({ r: 3, c: i })] = { v: headLabel(c), t: "s", s: st.head };
      ws[XLSX.utils.encode_cell({ r: 4, c: i })] = { v: helps[i], t: "s",
        s: { ...st.cell, font: { name: FONT, sz: 9, color: { rgb: MUTE } }, fill: { patternType: "solid", fgColor: { rgb: WASH } } } };
      for (let r = 0; r < BLANK; r++) ws[XLSX.utils.encode_cell({ r: 5 + r, c: i })] = { v: "", t: "s", s: st.cell };
    });
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 4 + BLANK, c: Math.max(0, cols.length - 1) } });
    ws["!cols"] = cols.map((c, i) => ({ wch: Math.min(40, Math.max(12, textWidth(headLabel(c)) + 2, textWidth(helps[i]) + 2)) }));
    ws["!rows"] = [{ hpt: 26 }, { hpt: 18 }, { hpt: 8 }, { hpt: 30 }, { hpt: 18 }, ...Array(BLANK).fill({ hpt: 22 })];
    ws["!margins"] = { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
    XLSX.utils.book_append_sheet(wb, ws, sheetName(ev.name, used));
    gradeCols.push(cols.map((c, i) => (/(^|\.)grade$/.test(c.key) ? i : -1)).filter(i => i >= 0));
  });
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true });
  return addGradeDropdowns(buf, gradeCols, 2, 6, 5 + BLANK);
}

// 学年の列に、フォームと同じ並びのドロップダウン(データの入力規則・リスト)を付ける。
// SheetJS の書き出しは入力規則を持てないので、できあがった xlsx のシートXMLに直接足す。
// 警告つきなので、リストにない値(自由入力の旧い書き方)も入れられ、読み取り側は従来どおり読む。
function addGradeDropdowns(buf, gradeCols, sheetOffset, firstRow, lastRow) {
  const any = gradeCols.some(a => a.length);
  if (!any) return buf;
  const files = unzipSync(new Uint8Array(buf));
  gradeCols.forEach((colIdx, k) => {
    if (!colIdx.length) return;
    const name = "xl/worksheets/sheet" + (sheetOffset + k + 1) + ".xml";
    if (!files[name]) return;
    let xml = strFromU8(files[name]);
    const dv = colIdx.map(ci => {
      const L = XLSX.utils.encode_col(ci);
      return '<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorStyle="warning"'
        + ' errorTitle="学年" error="リストにない値です。小1〜高3・一般から選ぶと、確実に読み取れます。"'
        + ' promptTitle="学年" prompt="リストから選べます"'
        + ` sqref="${L}${firstRow}:${L}${lastRow}"><formula1>"${GRADES.join(",")}"</formula1></dataValidation>`;
    }).join("");
    const block = `<dataValidations count="${colIdx.length}">${dv}</dataValidations>`;
    // 入力規則は sheetData(・結合など)のあと、印刷設定の前に置く決まり
    const at = xml.search(/<(hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|drawing|legacyDrawing|tableParts|extLst)[\s>\/]/);
    xml = at >= 0 ? xml.slice(0, at) + block + xml.slice(at) : xml.replace("</worksheet>", block + "</worksheet>");
    files[name] = strToU8(xml);
  });
  return Buffer.from(zipSync(files));
}

// ── 読み取り ──
const norm = (s) => String(s == null ? "" : s).replace(/[\s　]+/g, "").replace(/（必須）|\(必須\)/g, "");
const clip = (v) => String(v == null ? "" : v).replace(/\r/g, "").trim().slice(0, CLIP);

function cellText(ws, r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return "";
  if (cell.t === "d" && cell.v instanceof Date) {
    const d = cell.v;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  if (cell.t === "n" && cell.z && /y|m|d/i.test(String(cell.z)) && !/0\.0/.test(String(cell.z))) {
    const p = XLSX.SSF.parse_date_code(cell.v);
    if (p) return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  }
  return clip(cell.w != null ? cell.w : cell.v);
}

function readEntryTemplate(buf, { events, fieldConfig, admin }) {
  const cfg = fieldConfig;
  let wb;
  try { wb = XLSX.read(buf, { type: "buffer", cellDates: true, sheetStubs: false }); }
  catch (_) { return { error: "Excelファイルを読み取れませんでした。テンプレートの .xlsx をそのまま保存して読み込んでください。" }; }
  const warnings = [];
  const evs = (events || []).filter(e => e && e.name);
  const used = new Set();
  const nameBySheet = {};
  evs.forEach(ev => { nameBySheet[sheetName(ev.name, used)] = ev.name; });
  const byName = {};
  evs.forEach(ev => { byName[norm(ev.name)] = ev; });

  // 申込者
  const contact = {};
  const cws = wb.Sheets["申込者"];
  if (cws && cws["!ref"]) {
    const range = XLSX.utils.decode_range(cws["!ref"]);
    const want = {};
    contactRows(cfg, admin).forEach(r => { want[norm(r.label)] = r.key; });
    for (let r = range.s.r; r <= Math.min(range.e.r, 40); r++) {
      const key = want[norm(cellText(cws, r, 0))];
      if (key) { const v = cellText(cws, r, 1); if (v) contact[key] = v; }
    }
  }

  const out = [];
  wb.SheetNames.forEach(sn => {
    if (sn === "使い方" || sn === "申込者") return;
    const ws = wb.Sheets[sn];
    if (!ws || !ws["!ref"]) return;
    const a1 = cellText(ws, 0, 0).replace(/^種目[：:]\s*/, "");
    const ev = byName[norm(a1)] || byName[norm(nameBySheet[sn] || "")] || byName[norm(sn)];
    if (!ev) { warnings.push(`シート「${sn}」は、この大会の種目に見当たらないため読み飛ばしました。`); return; }
    if (ev.full) { warnings.push(`「${ev.name}」は定員に達しているため読み込みませんでした。`); return; }
    const cols = eventColumns(cfg, ev);
    const range = XLSX.utils.decode_range(ws["!ref"]);
    // 見出し行を探す(最初の10行のうち、列定義の見出しに一番多く当たる行)
    let headRow = -1, best = 0;
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 10); r++) {
      let hit = 0;
      for (let c = range.s.c; c <= Math.min(range.e.c, 80); c++) {
        const t = norm(cellText(ws, r, c));
        if (t && cols.some(col => norm(col.label) === t)) hit++;
      }
      if (hit > best) { best = hit; headRow = r; }
    }
    if (headRow < 0) { warnings.push(`シート「${sn}」の見出し行が見つかりませんでした。`); return; }
    const colAt = {};
    for (let c = range.s.c; c <= Math.min(range.e.c, 80); c++) {
      const t = norm(cellText(ws, headRow, c));
      const col = cols.find(x => norm(x.label) === t);
      if (col && colAt[col.key] == null) colAt[col.key] = c;
    }
    const helpLine = cols.map(c => norm(c.help || ""));
    const rows = [];
    for (let r = headRow + 1; r <= range.e.r && rows.length < MAX_ROWS; r++) {
      const rec = {};
      let any = false;
      Object.keys(colAt).forEach(k => { const v = cellText(ws, r, colAt[k]); if (v) { rec[k] = v; any = true; } });
      if (!any) continue;
      // 記入方法の行(テンプレの2行目)は読み飛ばす
      if (Object.keys(colAt).every(k => !rec[k] || helpLine.includes(norm(rec[k])))) continue;
      rows.push(shapeRow(ev, rec));
    }
    if (range.e.r - headRow > MAX_ROWS + 5) warnings.push(`「${ev.name}」は${MAX_ROWS}行までを読み込みました。`);
    if (rows.length) out.push({ name: ev.name, type: ev.type || "singles", rows });
  });
  return { contact, events: out, warnings };
}

// 読み取った1行を、フォームへ流し込む形にする
function personOf(rec, pre) {
  const p = { custom: {} };
  Object.keys(rec).forEach(k => {
    if (pre && !k.startsWith(pre)) return;
    const key = pre ? k.slice(pre.length) : k;
    if (key.startsWith("cust:")) p.custom[key.slice(5)] = rec[k];
    else if (!/^(division|team_name|m\d+|p\d\..*)$/.test(key)) p[key] = rec[k];
  });
  return p;
}
function shapeRow(ev, rec) {
  if (ev.type === "team") {
    const members = [];
    Object.keys(rec).filter(k => /^m\d+$/.test(k)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))
      .forEach(k => members.push(rec[k]));
    return { team_name: rec.team_name || "", members, division: rec.division || "" };
  }
  if (ev.type === "doubles") {
    return { p1: personOf(rec, "p1."), p2: personOf(rec, "p2."), division: rec.division || "" };
  }
  return { ...personOf(rec, ""), division: rec.division || "" };
}

// ── 本部の一括登録(締切後も可)用 ──
// 本部の手入力登録は 氏名・ふりがな・所属・区分 だけを受け取る。取り込まれない列(学年・性別・支部など)を
// テンプレに出すと「書いたのに入らない」になるので、列も最小にする。
function adminTemplateConfig(cfg) {
  return {
    fields: { team_name: "required", furigana: "optional", player_team: "optional", grade: "hidden",
      player_gender: "hidden", player_region: "hidden", first_time: "hidden", zendo_intent: "hidden", name_split: "hidden",
      supervisor: (cfg.fields || {}).supervisor || "hidden", advisor: (cfg.fields || {}).advisor || "hidden",
      coach: (cfg.fields || {}).coach || "hidden" },
    custom: [], event_overrides: {}, field_meta: cfg.field_meta || {},
  };
}
function adminTemplateEvents(events) {
  return (events || []).map(e => { const { age_check, full, ...rest } = e; return rest; });
}
// 区分の表示名/値 → 本部登録が受け取る値
function divisionValue(ev, label) {
  const cats = Array.isArray(ev.entry_categories) ? ev.entry_categories : [];
  const want = String(label || "").trim();
  const hit = cats.find(c => want && [c.short, c.label, c.value].map(x => String(x || "")).includes(want));
  return hit ? String(hit.value || hit.label) : want;
}
// readEntryTemplate の結果を、本部の手入力登録(createManualSubmission)の入力に変える。
function toManualPatch(out, events) {
  const byName = {};
  (events || []).forEach(e => { byName[e.name] = e; });
  const add = [];
  for (const ie of out.events || []) {
    const ev = byName[ie.name] || {};
    for (const r of ie.rows || []) {
      const base = { event: ie.name };
      if (ev.entry_categories && ev.entry_categories.length) base.division = divisionValue(ev, r.division);
      if (ie.type === "team") add.push({ ...base, team_name: r.team_name || "", members: r.members || [] });
      else if (ie.type === "doubles") {
        const a = r.p1 || {}, b = r.p2 || {};
        add.push({ ...base, name1: a.name, name2: b.name, furigana1: a.furigana, furigana2: b.furigana, team1: a.team, team2: b.team });
      } else add.push({ ...base, name: r.name, furigana: r.furigana, team: r.team });
    }
  }
  return { contact: out.contact || {}, add };
}

module.exports = { buildEntryTemplate, readEntryTemplate, eventColumns, adminTemplateConfig, adminTemplateEvents, toManualPatch };
