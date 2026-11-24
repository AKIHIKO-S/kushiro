// 領収書の印刷ページ(申込集計モード)。印刷物を作るだけで、入金記録・発行履歴は保存しない。
//
// 元データ(会長杯領収書.docx)の体裁に合わせる: A4縦・余白ほぼ無し(3mm)・1ページに複数枚・切り取り線。
// 文面(見出し・但し書き・発行者)は元データを既定値にし、印刷前に画面で直せる。
// 画面側の描画はこのページ内のJSが行い(埋め込みJSONから)、設定を変えるとその場でプレビューが変わる。
const DEFAULT_ISSUER = "釧路卓球協会　会長　山本　満";

// 日付(YYYY-MM-DD)→「令和8年5月2日」。令和は2019-05-01から。範囲外・不正は空文字
function reiwaDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "";
  const y = +m[1], mo = +m[2], d = +m[3];
  const afterReiwa = y > 2019 || (y === 2019 && (mo > 5 || (mo === 5 && d >= 1)));
  if (!afterReiwa) return "";
  const yr = y - 2018;
  return `令和${yr === 1 ? "元" : yr}年${mo}月${d}日`;
}

function defaultsFor(t, env) {
  env = env || process.env;
  return {
    proviso: `大会参加費（${String(t.name || "").trim()}）として、上記のとおり領収いたしました。`,
    date: reiwaDate(t.date),
    issuer: String(env.RECEIPT_ISSUER || "").trim() || DEFAULT_ISSUER,
  };
}

// 申込団体ごとの領収金額。取り消し・却下は数えない。承認待ちは金額に含めず注意を出す。
// 金額が出せない(保存額が無い出場がある)・0円は amount=null(空欄で印刷=手書き)にして、誤った金額を印刷しない。
// entrants: 全状態の出場(submission_id付き)、subs: [{id, team_name}]、feeOf: 保存額(出せなければnull)
function receiptTeams(subs, entrants, feeOf) {
  const bySub = new Map();
  (entrants || []).forEach(e => { if (e.submission_id) { if (!bySub.has(e.submission_id)) bySub.set(e.submission_id, []); bySub.get(e.submission_id).push(e); } });
  const groups = new Map();
  (subs || []).forEach(s => {
    const name = String(s.team_name || "").trim() || "(団体名なし)";
    if (!groups.has(name)) groups.set(name, []);
    (bySub.get(s.id) || []).forEach(e => groups.get(name).push(e));
  });
  const teams = [], excluded = [];
  for (const [name, list] of groups) {
    const live = list.filter(e => (e.status || "confirmed") === "confirmed");
    const pending = list.filter(e => e.status === "pending").length;
    if (!live.length) { excluded.push({ name, reason: pending ? "承認待ちのみ" : "すべて取り消し" }); continue; }
    const warnings = [];
    const fees = live.map(feeOf);
    let amount = null;
    if (fees.some(f => f === null)) warnings.push("金額が保存されていない出場があるため、金額は空欄にしました");
    else {
      amount = fees.reduce((a, b) => a + b, 0);
      if (amount === 0) { amount = null; warnings.push("参加費が0円のため、金額は空欄にしました"); }
    }
    if (pending) warnings.push(`承認待ち ${pending} 件は金額に含めていません`);
    teams.push({ name, entries: live.length, amount, warnings });
  }
  teams.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return { teams, excluded };
}

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonForScript = (o) => JSON.stringify(o).replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");

// opts: { teams, excluded, defaults, sealUrl(登録済みの印影のURL・無ければ空), origin, pick(最初に選ぶ団体名) }
function buildReceiptPrintHTML(t, opts) {
  const data = { teams: opts.teams || [], excluded: opts.excluded || [], defaults: opts.defaults, seal: opts.sealUrl || "", origin: opts.origin || "", pick: opts.pick || "", tid: t.id };
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.name)} 領収書</title><style>
*{box-sizing:border-box}
@page{size:A4 portrait;margin:3mm 3mm 5mm 3mm}
body{margin:0;font-family:"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif;color:#111;background:#ecebe8}
.ui{font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif;background:#fff;border-bottom:1px solid #cfcdc8;padding:14px 16px 16px}
.ui h1{font-size:18px;margin:0 0 4px} .ui p.sub{margin:0 0 10px;font-size:13px;color:#555;line-height:1.6}
.ui fieldset{border:1px solid #d6d3cc;border-radius:4px;margin:0 0 10px;padding:8px 12px 10px}
.ui legend{font-size:13px;font-weight:700;padding:0 6px}
.ui label{display:block;font-size:13px;font-weight:700;margin:8px 0 3px}
.ui input[type=text],.ui input[type=number],.ui textarea,.ui select{width:100%;font:inherit;font-size:16px;font-weight:500;padding:8px 10px;border:1px solid #b9b6ae;border-radius:4px;background:#fff;color:#111}
.ui textarea{min-height:84px}
.ui .row{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center} .ui .row label{display:inline-flex;gap:6px;align-items:center;font-weight:500;margin:4px 0;min-height:36px}
.ui .grid{display:grid;grid-template-columns:1fr;gap:0 14px} @media(min-width:760px){.ui .grid{grid-template-columns:1.6fr 1fr 1.2fr}}
.ui .teams{max-height:190px;overflow:auto;border:1px solid #d6d3cc;border-radius:4px;padding:4px 10px}
.ui .teams label{display:flex;gap:8px;align-items:center;font-weight:500;margin:0;padding:6px 0;border-bottom:1px solid #eee;min-height:40px}
.ui .teams .am{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
.ui .warn{font-size:12px;color:#9a3412;margin:2px 0 0 26px}
.ui button{font:inherit;font-size:16px;font-weight:700;min-height:46px;padding:0 20px;border:0;border-radius:4px;background:#14294a;color:#fff;cursor:pointer}
.ui button.q{background:#fff;color:#14294a;border:1px solid #14294a}
.ui .note{font-size:12px;color:#666;margin:8px 0 0;line-height:1.6}
.ui .summary{font-size:13px;font-weight:700;margin:8px 0 0}
body{overflow-x:hidden} #sheets{max-width:100vw;overflow:hidden;padding:14px 0 40px;display:flex;flex-direction:column;align-items:center;gap:14px}
.sheet{width:204mm;height:289mm;background:#fff;display:grid;grid-template-columns:102mm 102mm;grid-auto-rows:69.8mm;align-content:start;box-shadow:0 1px 6px rgba(0,0,0,.18);page-break-after:always;break-after:page;overflow:hidden}
/* 元の領収書(会長杯領収書.docx): 1枚=102mm x 69.8mm の枠、2列x4段=8枚/ページ。枠線がそのまま切り取り線 */
.rc{position:relative;width:102mm;height:69.8mm;padding:0 2.4mm;border-right:.25mm solid #000;border-bottom:.25mm solid #000;font-size:10.5pt;line-height:13.6pt;break-inside:avoid;page-break-inside:avoid;overflow:visible}
.rc:nth-child(2n+1){border-left:.25mm solid #000} .rc:nth-child(-n+2){border-top:.25mm solid #000}
.rc p{margin:0}
.rc .bl{height:13.6pt}
.rc-t{text-align:center;font-size:20pt;line-height:26pt}
.rc-team{padding-left:4.2mm;font-size:14pt;line-height:19pt}
.rc-sum{text-align:center;font-size:14pt;line-height:19pt}
.rc .u{text-decoration:underline;text-decoration-thickness:.2mm;text-underline-offset:1.2mm}
.rc .s12{font-size:12pt}
.rc-p{font-size:9pt;line-height:13.6pt}
.rc-d{text-align:right;line-height:13.6pt;padding-right:19mm}
.rc-i{text-align:right;font-size:12pt;line-height:16pt;padding-right:17mm}
.rc .sealbox{position:absolute;right:1.5mm;top:49.5mm;width:18mm;height:18mm;isolation:isolate;pointer-events:none}
.rc .sealbox img{position:absolute;left:0;top:0;width:18mm;height:18mm;object-fit:contain;mix-blend-mode:multiply}
.rc .sealbox img:nth-child(2){left:.14mm}.rc .sealbox img:nth-child(3){top:.14mm}.rc .sealbox img:nth-child(4){left:.14mm;top:.14mm}
.rc .seal{display:none;position:absolute;right:1.5mm;top:49.5mm;width:18mm;height:18mm;object-fit:contain;mix-blend-mode:multiply;-webkit-print-color-adjust:exact;print-color-adjust:exact;pointer-events:none}
@media print{
  body{background:#fff} .ui{display:none} #sheets{padding:0;gap:0;display:block}
  .sheet{box-shadow:none;margin:0;zoom:1 !important}
}
</style></head><body>
<div class="ui" id="ui">
<h1>${esc(t.name)} 領収書の印刷</h1>
<p class="sub">金額は申込の保存額から出します（取り消しは対象外、承認待ちは金額に含めません）。ここで作るのは印刷物だけで、発行の記録は残りません。</p>
<fieldset><legend>何を印刷するか</legend>
<div class="row"><label><input type="radio" name="mode" value="teams" checked>申込団体ぶん</label><label><input type="radio" name="mode" value="addr">宛名を入力して（手書きで金額）</label><label><input type="radio" name="mode" value="blank">宛名・金額とも白紙</label></div>
<div id="pTeams"><div class="row"><button type="button" class="q" id="all">すべて選ぶ</button><button type="button" class="q" id="none">選択を外す</button></div><div class="teams" id="teamList"></div><div id="excl" class="note"></div><p class="note">団体名が「個人」の申込は、1枚にまとめて発行します。分けたいときは、上の「宛名を入力して」を選び、宛名ごとに発行してください。</p></div>
<div id="pAddr" hidden><label for="names">宛名（1行に1枚）</label><textarea id="names" placeholder="例&#10;釧路〇〇クラブ&#10;△△中学校"></textarea><label for="amt">金額（空欄なら手書き）</label><input type="number" id="amt" min="0" inputmode="numeric" placeholder="空欄"></div>
<div id="pBlank" hidden><label for="cnt">枚数</label><input type="number" id="cnt" min="1" max="200" value="8" inputmode="numeric"></div>
</fieldset>
<fieldset><legend>文面（印刷前に直せます）</legend><div class="grid">
<div><label for="proviso">但し書き</label><input type="text" id="proviso"></div>
<div><label for="date">日付</label><input type="text" id="date"></div>
<div><label for="issuer">発行者</label><input type="text" id="issuer"></div></div>
<p class="note" id="sealNote" style="margin-top:4px"></p></fieldset>
<div class="row"><button type="button" id="print">印刷する</button><span class="summary" id="sum"></span></div>
<p class="note">印刷の設定は「A4・縦・余白は最小（なし）・倍率100%」にしてください。枠線が切り取り線です。</p>
</div>
<div id="sheets"></div>
<script>
const D=${jsonForScript(data)};
const $=id=>document.getElementById(id);
const store={get(k){try{return localStorage.getItem("rcp."+k)||""}catch(e){return ""}},set(k,v){try{localStorage.setItem("rcp."+k,v)}catch(e){}}};
const yen=n=>String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");
$("proviso").value=D.defaults.proviso;$("date").value=D.defaults.date;$("issuer").value=store.get("issuer")||D.defaults.issuer;
const SEAL=D.seal?new URL(D.seal,D.origin||location.href).href:"";D.seal=SEAL;const sealOK=!!SEAL;
$("sealNote").textContent=sealOK?"印影は、大会運営モードの領収書で登録済みの電子印鑑を、必ず重ねて印刷します。":"";
if(!sealOK){const w=document.createElement("p");w.style.cssText="margin:8px 0 0;padding:10px 12px;background:#fdecea;color:#9f1d12;font-weight:700;font-size:14px;border:1px solid #e8a39b;border-radius:4px";w.textContent="印影が未登録です(管理設定の電子印鑑から登録してください)";w.setAttribute("role","alert");$("ui").insertBefore(w,$("ui").firstChild.nextSibling)}
const sel=new Set(D.pick?[D.pick]:D.teams.map(t=>t.name));
const list=$("teamList");
D.teams.forEach((t,i)=>{const l=document.createElement("label");const c=document.createElement("input");c.type="checkbox";c.checked=sel.has(t.name);c.onchange=()=>{c.checked?sel.add(t.name):sel.delete(t.name);render()};
const n=document.createElement("span");n.textContent=t.name+"（"+t.entries+"件）";const a=document.createElement("span");a.className="am";a.textContent=t.amount==null?"金額 空欄":yen(t.amount)+" 円";l.append(c,n,a);list.append(l);
t.warnings.forEach(w=>{const p=document.createElement("div");p.className="warn";p.textContent="注意: "+w;list.append(p)});t._c=c});
$("excl").textContent=D.excluded.length?"印刷の対象外: "+D.excluded.map(e=>e.name+"（"+e.reason+"）").join("、"):"";
if(!D.teams.length)list.textContent="印刷できる申込団体がまだありません。";
$("all").onclick=()=>{D.teams.forEach(t=>{t._c.checked=true;sel.add(t.name)});render()};$("none").onclick=()=>{D.teams.forEach(t=>{t._c.checked=false});sel.clear();render()};
const mode=()=>document.querySelector("input[name=mode]:checked").value;
function items(){const m=mode();
 if(m==="teams")return D.teams.filter(t=>sel.has(t.name)).map(t=>({name:t.name,amount:t.amount}));
 if(m==="addr"){const a=$("amt").value.trim();return $("names").value.split(/\\n/).map(s=>s.trim()).filter(Boolean).map(n=>({name:n,amount:a===""?null:Math.max(0,parseInt(a,10)||0)}))}
 const n=Math.min(200,Math.max(1,parseInt($("cnt").value,10)||1));return Array.from({length:n},()=>({name:"",amount:null}))}
function p(cls,txt){const e=document.createElement("p");e.className=cls;if(txt!=null)e.textContent=txt;return e}
function u(...kids){const e=document.createElement("span");e.className="u";kids.forEach(k=>e.append(k));return e}
function sp(cls,t){const e=document.createElement("span");if(cls)e.className=cls;e.textContent=t;return e}
function card(it){const d=document.createElement("div");d.className="rc";
 d.append(p("bl"));d.append(p("rc-t","領　収　書"));d.append(p("bl"));
 const nm=it.name||"";const fs=Math.max(8,Math.min(14,14*14/Math.max(nm.length,1)));
 const t=p("rc-team");const nn=sp("",nm||"　".repeat(11));nn.style.fontSize=fs+"pt";t.append(u(sp("s12","チーム名"),"　",nn,"　"));d.append(t);
 d.append(p("bl"));
 const s2=p("rc-sum");s2.append(u("合計　",it.amount==null?"　".repeat(6):String(it.amount),"　円"));d.append(s2);
 d.append(p("bl"));
 const pv=p("rc-p");const pt=$("proviso").value,ix=pt.indexOf("上記のとおり");pv.append(document.createTextNode("　"));if(ix>0){pv.append(sp("",pt.slice(0,ix)));const tl=sp("",pt.slice(ix));tl.style.whiteSpace="nowrap";pv.append(tl)}else pv.append(sp("",pt));d.append(pv);
 d.append(p("bl"));
 d.append(p("rc-d",$("date").value));
 d.append(p("rc-i",$("issuer").value));
 if(sealOK){const bx=document.createElement("div");bx.className="sealbox";for(let k=0;k<4;k++){const im=document.createElement("img");im.src=D.seal;im.alt="";bx.append(im)}d.append(bx)}
 return d}
function render(){const per=8;const its=items();const box=$("sheets");box.textContent="";
 for(let i=0;i<its.length;i+=per){const s=document.createElement("section");s.className="sheet";its.slice(i,i+per).forEach(it=>s.append(card(it)));box.append(s)}
 const m=mode();$("pTeams").hidden=m!=="teams";$("pAddr").hidden=m!=="addr";$("pBlank").hidden=m!=="blank";
 const blanks=its.filter(i=>i.amount==null).length;
 $("sum").textContent=its.length+"枚・"+Math.ceil(its.length/per)+"ページ"+(m==="teams"&&blanks?"（金額が空欄: "+blanks+"枚）":"");
 $("print").disabled=!its.length||!sealOK;fit()}
function fit(){const w=Math.min(1,(Math.min($("ui").clientWidth,document.body.clientWidth)-16)/(204/25.4*96));document.querySelectorAll(".sheet").forEach(s=>{s.style.zoom=w})}
addEventListener("resize",fit);
["proviso","date","issuer","amt","names","cnt"].forEach(id=>$(id).addEventListener("input",()=>{if(id==="issuer")store.set("issuer",$("issuer").value);render()}));
document.querySelectorAll("input[name=mode]").forEach(r=>r.addEventListener("change",render));
$("print").onclick=()=>{if(!sealOK)return;if(mode()==="teams"&&items().some(i=>i.amount==null)&&!confirm("金額が空欄の領収書があります（手書き用）。このまま印刷しますか？"))return;window.print()};
render();
</script></body></html>`;
}

module.exports = { reiwaDate, defaultsFor, receiptTeams, buildReceiptPrintHTML, DEFAULT_ISSUER };
