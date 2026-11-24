// 受付名簿の印刷用の組版(2026-11-24 オーナー承認の「案2 選手と種目の一覧表型」)。
// 画面のHTMLではなく、A4縦の紙に刷る前提:
//   ・チーム(所属)ごとに、選手を行・種目を列にした罫線の表。誰がどの種目に出るかが一目で分かる
//   ・種目名の上に、男子(黒ベタ)・女子(二重罫の枠)・混合(斜線)の見出し帯。色に頼らないので白黒印刷でも区別できる
//   ・種目ごとの列に「番号」欄(組合せ表の枠番号)と、出場の印(シングルス=●、ダブルス=◎+ペアの相手)。
//     番号は組合せの取込・抽選で付いた枠番号。まだ付いていなければ空欄で、手書きの余白になる。ダブルスのペアは同じ番号
//   ・紙を減らすため、既定は「詰める」(人数の少ないチームは1枚に続けて載せる)。「チームごとに改ページ」にもできる
//   ・チームの表は途中で割れないようにし、割れる大きさ(1ページを超える)のときは、見出しを次ページの先頭に繰り返す
// 純関数(DB・サーバーに依存しない)。buildReceptionPrintHTML(大会, 出場者の配列, { pack }) → { html, meta }
"use strict";

const EG = require("../public/shared/event-gender.js");

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const CAT = { middle: "中学生", high: "高校生", elementary: "小学生", university: "大学生", general: "一般" };
const GL = { male: "男子", female: "女子", mixed: "混合", other: "その他" };
const GORDER = ["male", "female", "mixed", "other"];
const norm = (s) => String(s == null ? "" : s).normalize("NFKC").replace(/[\s　]+/g, "");
const isDbl = (name) => /ダブルス|複/.test(String(name || ""));

// 紙の寸法(mm)。A4の幅210から、左右の余白10mmずつを引く
const USABLE = 190;
const W = { chk: 6, grade: 12, nameMax: 60, nameMin: 46, nameFloor: 34 };
// 種目の列の幅: [理想, 下限]。シングルス=番号+印、ダブルス=番号+ペアの相手の氏名
const UNIT = { s: { num: [8, 6], body: [8, 5] }, d: { num: [8, 6], body: [24, 10] } };

function genderOf(ev) { return EG.of(ev) || "other"; }
function shortEvent(ev) { return String(ev || "").replace(/(男子|女子|混合|ミックス)/g, "").trim() || String(ev || ""); }

// 出場者(1行=1種目の1エントリー)を、チームごとの「選手×種目」に組み替える。
// ダブルスのペアの相手も、自分の所属の選手として載せる(所属が違えば、そちらのチームの表に載る)。
function groupTeams(entrants) {
  // 取込済みの組合せは「左の山の1..、右の山の1..」と山ごとに番号が振られ、同じ番号が左右に出る種目がある。
  // そのような種目だけ、番号の前に左/右を付けて、どの枠か分かるようにする(通しの番号の種目は番号だけ)
  const seen = new Map(), dupEvents = new Set();
  (entrants || []).forEach(e => { const n = parseInt(e.bracket_number, 10); if (!(n > 0)) return; const k = e.event + "#" + n; if (seen.has(k)) dupEvents.add(String(e.event || "")); seen.set(k, 1); });
  const teams = new Map();
  const get = (team) => { const k = String(team || "").trim() || "(所属未記入)"; if (!teams.has(k)) teams.set(k, { name: k, persons: new Map(), count: 0 }); return teams.get(k); };
  (entrants || []).forEach(e => {
    const ev = String(e.event || "");
    const num = parseInt(e.bracket_number, 10) > 0 ? parseInt(e.bracket_number, 10) : 0;
    const side = num && dupEvents.has(ev) ? (e.bracket_side === "L" ? "左" : e.bracket_side === "R" ? "右" : "") : "";
    const grade = String(e.age_group || "").trim() || CAT[e.category] || "";
    const add = (teamName, name, furi, key, partner) => {
      if (!String(name || "").trim()) return;
      const t = get(teamName);
      const pk = norm(key || name);
      if (!t.persons.has(pk)) t.persons.set(pk, { name: String(name).trim(), furi: String(furi || "").trim(), grades: new Set(), cells: new Map() });
      const p = t.persons.get(pk);
      if (!p.furi && furi) p.furi = String(furi).trim();
      if (grade) p.grades.add(grade);
      p.cells.set(ev, { num, side, partner: partner || "" });
      t.count++;
    };
    const dbl = !!e.is_doubles || (isDbl(ev) && String(e.partner_name || "").trim());
    const ptn = dbl && String(e.partner_name || "").trim() ? String(e.partner_name).trim() : "";
    add(e.team, e.name, e.furigana, e.player_id || e.name, ptn);
    if (ptn) add(e.partner_team || e.team, e.partner_name, e.partner_furigana, e.partner_player_id || e.partner_name, String(e.name || "").trim());
  });
  return [...teams.values()].sort((a, b) => a.name.localeCompare(b.name, "ja")).map(t => {
    t.list = [...t.persons.values()].sort((a, b) => (a.furi || a.name).localeCompare(b.furi || b.name, "ja") || a.name.localeCompare(b.name, "ja"));
    return t;
  });
}

// そのチームの種目の列(男子→女子→混合→その他。中はシングルス→ダブルス→名前順)
function eventColumns(team) {
  const evs = new Set();
  team.list.forEach(p => p.cells.forEach((_, ev) => evs.add(ev)));
  const arr = [...evs].map(ev => ({ ev, g: genderOf(ev), d: isDbl(ev) }));
  arr.sort((a, b) => (GORDER.indexOf(a.g) - GORDER.indexOf(b.g)) || (a.d - b.d) || a.ev.localeCompare(b.ev, "ja"));
  return arr;
}

// 列幅を決める。理想の幅で収まればそのまま(余りは氏名欄へ)、収まらなければ氏名欄・各列を縮める。
// それでも下限を超えて収まらないときは overflow=true(印刷はできるが、列が窮屈になる)。
function widths(cols) {
  const ideal = (c) => (c.d ? UNIT.d : UNIT.s);
  const sum = (idx) => cols.reduce((a, c) => a + ideal(c).num[idx] + ideal(c).body[idx], 0);
  const idealSum = sum(0), minSum = sum(1);
  const fixed = W.chk + W.grade;
  let name = W.nameMin, t;
  let avail = USABLE - fixed - name;
  let overflow = false;
  if (avail >= idealSum) { t = 1; name = Math.min(W.nameMax, USABLE - fixed - idealSum); }
  else {
    if (avail < minSum) name = Math.max(W.nameFloor, USABLE - fixed - minSum);
    avail = USABLE - fixed - name;
    if (avail < minSum) { overflow = true; t = 0; } else t = (avail - minSum) / (idealSum - minSum);
  }
  const lerp = (r) => r[1] + t * (r[0] - r[1]);
  return { name, t, overflow, cols: cols.map(c => ({ num: lerp(ideal(c).num), body: lerp(ideal(c).body) })) };
}

// 種目の見出し: 「一般ダブルス」→「一般<br>ダブルス」。列が細くても、語の途中で折れないように
const eventHead = (ev) => { const sh = shortEvent(ev); const m = sh.match(/^(.*?)(シングルス|ダブルス)$/); return m && m[1] ? esc(m[1]) + "<br>" + m[2] : esc(sh); };
const splitName = (n) => { const m = String(n).trim().split(/[\s　]+/); return m.length === 2 ? esc(m[0]) + "<br>" + esc(m[1]) : esc(n); };

function teamTable(team) {
  const cols = eventColumns(team);
  const w = widths(cols);
  const groups = [];
  cols.forEach((c) => { const last = groups[groups.length - 1]; if (last && last.g === c.g) { last.n++; last.span += 2; } else groups.push({ g: c.g, n: 1, span: 2 }); });
  const nCols = 3 + cols.length * 2;
  const narrow = w.t < 0.45;   // 列が詰まったときは、ペアの相手の氏名を小さく2行にする
  const colgroup = `<colgroup><col style="width:${W.chk}mm"><col style="width:${w.name.toFixed(1)}mm"><col style="width:${W.grade}mm">` +
    w.cols.map(c => `<col style="width:${c.num.toFixed(1)}mm"><col style="width:${c.body.toFixed(1)}mm">`).join("") + "</colgroup>";
  const nPerson = team.list.length;
  const head = `<thead>
<tr class="cap"><th colspan="${nCols}"><span class="tn">${esc(team.name)}</span><span class="ts">選手 ${nPerson}名 / 出場 ${team.count}件${w.overflow ? " (種目が多く、列を詰めています)" : ""}</span></th></tr>
<tr><th rowspan="2" class="chk">受付</th><th rowspan="2" class="nm">選手名(ふりがな)</th><th rowspan="2" class="gr">学年<br>区分</th>${groups.map(g => `<th class="g ${g.g}" colspan="${g.span}">${GL[g.g]}</th>`).join("")}</tr>
<tr>${cols.map(c => `<th class="e${narrow ? " nr" : ""}" colspan="2">${eventHead(c.ev)}</th>`).join("")}</tr>
</thead>`;
  const rows = team.list.map(p => {
    const grade = [...p.grades].join("・");
    const cells = cols.map(c => {
      const cell = p.cells.get(c.ev);
      if (!cell) return `<td class="n"></td><td class="m"></td>`;
      const num = cell.num ? (cell.side ? `<small class="sd">${cell.side}</small>` : "") + `<b>${cell.num}</b>` : "";
      return c.d
        ? `<td class="n">${num}</td><td class="m d${narrow ? (w.t < 0.15 ? " nr xnr" : " nr") : ""}"><span class="dm">◎</span> ${narrow ? splitName(cell.partner) : esc(cell.partner)}</td>`
        : `<td class="n">${num}</td><td class="m s">●</td>`;
    }).join("");
    return `<tr><td class="chk"><i></i></td><td class="nm"><b>${esc(p.name)}</b>${p.furi ? `<small>${esc(p.furi)}</small>` : ""}</td><td class="gr">${esc(grade)}</td>${cells}</tr>`;
  }).join("");
  // 1ページに収まる大きさのチームは、途中で割らない(収まらない大きさだけ割り、見出しを繰り返す)
  const fits = nPerson <= 36;
  return { html: `<table class="tt${fits ? " keep" : ""}">${colgroup}${head}<tbody>${rows}</tbody></table>`, overflow: w.overflow, events: cols.length };
}

function buildReceptionPrintHTML(t, entrants, opts) {
  opts = opts || {};
  const pack = opts.pack !== false;   // 既定は「詰める」
  const teams = groupTeams(entrants);
  const tables = teams.map(tm => teamTable(tm));
  const total = teams.reduce((a, x) => a + x.count, 0);
  const persons = teams.reduce((a, x) => a + x.list.length, 0);
  const overflowTeams = teams.filter((_, i) => tables[i].overflow).map(x => x.name);
  const meta = { teams: teams.length, persons, entries: total, overflowTeams };
  const dateTxt = (() => { const m = String(t.date || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (!m) return esc(t.date || ""); const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return m[1] + "年" + (+m[2]) + "月" + (+m[3]) + "日(" + "日月火水木金土"[d.getUTCDay()] + ")"; })();
  const css = `
@page{size:A4 portrait;margin:10mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;color:#000;background:#fff;font-size:9pt;line-height:1.25;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar{position:sticky;top:0;z-index:5;background:#f7f6f2;border-bottom:1px solid #999;padding:8px 12px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:14px}
.bar button{font:inherit;font-weight:700;padding:8px 18px;border:1px solid #14294a;background:#14294a;color:#fff;border-radius:6px;cursor:pointer}
.bar label{display:inline-flex;gap:6px;align-items:center;min-height:36px}
.bar .nt{color:#444;font-size:12px}
.paper{width:190mm;margin:0 auto}
.hd{display:flex;justify-content:space-between;align-items:baseline;font-size:9pt;border-bottom:.5pt solid #000;padding:2mm 0 1.2mm;margin-bottom:2.5mm}
.hd .nm0{font-weight:700;font-size:10pt}
.blk{margin:0 0 4mm}
body.brk .blk{break-before:page;page-break-before:always;margin-top:0}
body.brk .blk:first-child{break-before:auto;page-break-before:auto}
table.tt{width:190mm;border-collapse:collapse;table-layout:fixed}
table.tt.keep{break-inside:avoid;page-break-inside:avoid}
table.tt th,table.tt td{border:.5pt solid #000;padding:0 1mm;text-align:center;vertical-align:middle;overflow:hidden}
table.tt thead{display:table-header-group}
table.tt tr{break-inside:avoid;page-break-inside:avoid}
tr.cap th{text-align:left;border:.9pt solid #000;padding:1.2mm 2mm;background:#fff}
.tn{font-size:12.5pt;font-weight:800;letter-spacing:.02em}.ts{font-size:8.5pt;font-weight:400;float:right;margin-top:1mm}
th{font-size:8pt;font-weight:700;line-height:1.15}
th.g{font-size:9pt;letter-spacing:.35em;padding:.4mm 0}
th.g.male{background:#000;color:#fff}
th.g.female{background:#fff;color:#000;border:1.4pt solid #000;border-bottom:2.6pt double #000}
th.g.mixed{background:repeating-linear-gradient(135deg,#fff 0 1.6mm,#c9c9c9 1.6mm 2.1mm);border:1pt dashed #000}
th.g.other{background:#fff;border:1pt solid #000;letter-spacing:.2em}
th.e{padding:.5mm .3mm;font-size:7.5pt}
th.e.nr{font-size:6.6pt;letter-spacing:-.02em}
td{height:6.2mm;font-size:8.5pt}
td.nm{text-align:left;white-space:nowrap}
td.nm b{font-size:9.5pt}td.nm small{font-size:7pt;margin-left:1.6mm;letter-spacing:.03em}
td.gr{font-size:8pt;line-height:1.1}
td.chk{width:6mm}td.chk i{display:inline-block;width:3.6mm;height:3.6mm;border:.7pt solid #000;vertical-align:middle}
td.n b{font-size:10pt}td.n .sd{font-size:6pt;margin-right:.2mm;vertical-align:1pt}
td.m.s{font-size:10pt}
td.m.d{text-align:left;font-size:7.5pt;line-height:1.1;padding-left:.8mm}
td.m.d .dm{font-size:9pt}
td.m.d.nr{font-size:6.8pt;line-height:1.05;padding-left:.4mm}
td.m.d.xnr{font-size:6pt;line-height:1.05;padding-left:.2mm}
.fnote{font-size:7.5pt;margin-top:1mm}
@media print{.bar{display:none}.paper{margin:0}}
`;
  const body = `<div class="bar"><button type="button" onclick="window.print()">印刷 / PDF保存</button>
<label><input type="checkbox" id="brk"> チームごとに改ページする(オフ=紙を減らすため詰めて印刷)</label>
<span class="nt">A4縦・余白10mm。「番号」は組合せ表の枠番号(組合せの取込前は空欄で、手書きできます)。</span></div>
<div class="paper"><div class="hd"><span class="nm0">${esc(t.name || "")} 受付名簿</span><span>${dateTxt}　${esc(t.venue || "")}　確定出場 ${(entrants || []).length}件 / ${teams.length}所属 / 選手 ${persons}名</span></div>
${tables.length ? teams.map((tm, i) => `<section class="blk">${tables[i].html}</section>`).join("") : "<p>確定した出場はまだありません。</p>"}
<div class="fnote">●=シングルス ◎=ダブルス(右の氏名がペアの相手) / 番号=その種目の組合せ表の枠番号(ペアは同じ番号。左右の山で番号が重なる種目は「左」「右」つき)</div></div>
<script>(function(){var c=document.getElementById("brk");function set(on){document.body.classList.toggle("brk",on);}
var q=location.search.match(/[?&]break=(team|pack)/);var on=document.body.classList.contains("brk");if(q){on=q[1]==="team";}else{try{var v=localStorage.getItem("ktta_reception_break");if(v!==null){on=v==="1";}}catch(e){}}
c.checked=on;set(on);c.addEventListener("change",function(){set(c.checked);try{localStorage.setItem("ktta_reception_break",c.checked?"1":"0");}catch(e){}});})();</script>`;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.name || "")} 受付名簿</title><style>${css}</style></head><body${pack ? "" : ' class="brk"'}>${body}</body></html>`;
  return { html, meta };
}

module.exports = { buildReceptionPrintHTML, groupTeams, eventColumns, widths, USABLE };
