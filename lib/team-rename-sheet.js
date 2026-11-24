// 所属名の一括統一: 読み込む一覧(CSV/Excel)から「変更前・変更後」の組を取り出す。
// 列は見出しの「変更前」「変更後」で探す(「順」「人数」など他の列があってもよい)。見出しが無ければ左の2列。
// 文字コードは UTF-8(BOM可)を優先し、読めなければ Shift_JIS。最大 MAX_ROWS 行。
const XLSX = require("xlsx");
const MAX_ROWS = 2000;

function decode(buf) {
  let s = buf.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.includes("�")) { try { s = new TextDecoder("shift_jis").decode(buf); } catch (_) {} }
  return s;
}
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const clean = (v) => String(v == null ? "" : v).normalize("NFC").replace(/^[\s　]+|[\s　]+$/g, "");

function parse(buffer, filename) {
  if (!buffer || !buffer.length) return { error: "ファイルが空です" };
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  let rows;
  try {
    if (isZip || /\.xlsx?$/i.test(filename || "")) {
      const wb = XLSX.read(buffer, { type: "buffer" });
      const name = wb.SheetNames.includes("反映の順番") ? "反映の順番" : wb.SheetNames[0];
      rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    } else rows = parseCsv(decode(buffer));
  } catch (e) { return { error: "ファイルを読めませんでした(CSVまたはExcelで保存し直してください)" }; }
  if (rows.length > MAX_ROWS + 1) return { error: "行が多すぎます(" + MAX_ROWS + "行まで)" };
  let ci = 0, ti = 1, start = 0;
  const head = (rows[0] || []).map(clean);
  const f = head.findIndex(h => h === "変更前"), t = head.findIndex(h => h === "変更後");
  if (f >= 0 && t >= 0) { ci = f; ti = t; start = 1; }
  const pairs = []; let empty = 0;
  for (let i = start; i < rows.length; i++) {
    const from = clean((rows[i] || [])[ci]), to = clean((rows[i] || [])[ti]);
    if (!from && !to) { empty++; continue; }
    pairs.push({ from, to, line: i + 1 });
  }
  if (!pairs.length) return { error: "「変更前」「変更後」の行が見つかりません" };
  return { pairs, empty };
}
module.exports = { parse, MAX_ROWS };
