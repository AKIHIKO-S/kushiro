'use strict';
// 外部大会申込フォーム HTML 生成
// createElement + addEventListener 方式 — inline handler・<template> 不使用 (CSP対応)

const { escapeHtml, escapeJs } = require('./lib/text');

// ── サーバーサイド: 種目定義 ────────────────────────────────────
const MASTERS_SINGLES_CATS = [
  ['fifty',  'フィフティ（50歳以上）',        'フィフティ'],
  ['low60',  'ローシックスティ（60歳以上）',   'ローシックスティ'],
  ['hi60',   'ハイシックスティ（65歳以上）',   'ハイシックスティ'],
  ['low70',  'ローセブンティ（70歳以上）',     'ローセブンティ'],
  ['hi70',   'ハイセブンティ（75歳以上）',     'ハイセブンティ'],
  ['low80',  'ローエイティ（80歳以上）',       'ローエイティ'],
  ['hi80',   'ハイエイティ（85歳以上）',       'ハイエイティ'],
  ['ninety', 'ナインティ（90歳以上）※同意書必須', 'ナインティ'],
];
const MASTERS_DOUBLES_CATS = [
  ['under_129', '129歳以下（合計129歳以下）', '129歳以下'],
  ['over_130',  '130歳以上（合計130歳以上）', '130歳以上'],
];
const LARGEBALL_SINGLES_CATS = [
  ['一般', '一般（年齢制限なし）',          '一般'],
  ['40',   'シングルス40（40歳以上）',      'S40'],
  ['50',   'シングルス50（50歳以上）',      'S50'],
  ['60',   'シングルス60（60歳以上）',      'S60'],
  ['65',   'シングルス65（65歳以上）',      'S65'],
  ['70',   'シングルス70（70歳以上）',      'S70'],
  ['75',   'シングルス75（75歳以上）',      'S75'],
  ['80',   'シングルス80（80歳以上）',      'S80'],
  ['85',   'シングルス85（85歳以上）',      'S85'],
];
const LARGEBALL_DOUBLES_CATS = [
  ['一般', '一般混合ダブルス（制限なし）',         '混合一般'],
  ['80',   '混合ダブルス80（合計80歳以上）',       '混合80'],
  ['100',  '混合ダブルス100（合計100歳以上）',     '混合100'],
  ['120',  '混合ダブルス120（合計120歳以上）',     '混合120'],
  ['130',  '混合ダブルス130（合計130歳以上）',     '混合130'],
  ['140',  '混合ダブルス140（合計140歳以上）',     '混合140'],
  ['150',  '混合ダブルス150（合計150歳以上）',     '混合150'],
  ['160',  '混合ダブルス160（合計160歳以上）',     '混合160'],
];

// ── CSS ──────────────────────────────────────────────────────────
const _CSS = `
:root{
  --paper:#f1e9d9;--card:#fffdf8;--card2:#fbf6ec;
  --ink:#211b15;--ink2:#6c6153;--line:#e4d8c2;--line2:#efe6d4;
  --red:#c01526;--red2:#9c0f1c;
  --amber:#9a6a10;--ambg:#f6ebcd;
  --green:#1a7a45;--gnbg:#e9f7ee;
  --g:'Hiragino Sans','BIZ UDPGothic','Yu Gothic UI',system-ui,sans-serif;
  --m:'Hiragino Mincho ProN','Yu Mincho','YuMincho',serif;
  --sh:0 18px 44px -22px rgba(48,32,16,.45);
  --r:14px;
}
*{box-sizing:border-box;margin:0;padding:0;}
html{-webkit-text-size-adjust:100%;}
body{font-family:var(--g);color:var(--ink);line-height:1.78;font-size:16px;
  padding:24px 14px 56px;max-width:900px;margin:0 auto;
  background:var(--paper) radial-gradient(1100px 520px at 108% -8%,rgba(192,21,38,.07),transparent 58%),
    radial-gradient(900px 520px at -12% 112%,rgba(154,106,16,.08),transparent 58%);
  -webkit-font-smoothing:antialiased;}
@keyframes ttR{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.fhd{background:linear-gradient(155deg,#241d16,#36281c 60%,#2c2118);
  color:#f6efe2;padding:28px 28px 24px;
  border-radius:var(--r) var(--r) 0 0;border-top:5px solid var(--red);
  animation:ttR .5s ease both;position:relative;overflow:hidden;}
.fhd::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;
  background:linear-gradient(90deg,var(--red),#d4a017 70%,transparent);opacity:.85;}
.fhd h1{font-family:var(--m);font-size:clamp(18px,4vw,26px);font-weight:700;
  line-height:1.35;letter-spacing:.02em;position:relative;z-index:1;}
.seal{display:inline-block;vertical-align:middle;background:var(--red);color:#fff;
  font-size:11px;font-weight:800;padding:3px 9px;border-radius:4px;
  margin-right:8px;letter-spacing:.15em;box-shadow:0 2px 0 rgba(0,0,0,.25);}
.fhd .meta{font-size:13px;color:#d8cdba;margin-top:8px;position:relative;z-index:1;}
.fsec{background:var(--card);padding:22px 24px;
  border-left:1px solid var(--line);border-right:1px solid var(--line);
  animation:ttR .5s ease both;}
.fsec:last-of-type{border-radius:0 0 var(--r) var(--r);
  border-bottom:1px solid var(--line);padding-bottom:26px;box-shadow:var(--sh);}
.fsec h2{font-family:var(--m);font-size:18px;font-weight:700;margin-bottom:14px;
  color:var(--ink);display:flex;align-items:center;gap:9px;}
.fsec h2::before{content:"";width:5px;height:19px;border-radius:2px;
  background:linear-gradient(var(--red),var(--red2));
  box-shadow:0 1px 4px rgba(192,21,38,.4);}
.cbadge{display:inline-flex;align-items:center;padding:2px 9px;
  background:var(--gnbg);color:var(--green);border:1px solid #aee3c2;
  border-radius:999px;font-size:11px;font-weight:800;margin-left:auto;}
.frow{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-bottom:13px;}
.frow.two{grid-template-columns:1fr 1fr;}
.frow label{display:block;font-size:12px;font-weight:800;color:var(--ink2);
  margin-bottom:5px;letter-spacing:.07em;}
.frow .req{background:var(--red);color:#fff;font-size:9px;
  padding:1px 5px;border-radius:3px;margin-left:5px;}
.frow input,.frow select,.frow textarea{width:100%;padding:10px 12px;
  border:1.5px solid var(--line);border-radius:8px;
  font-family:inherit;font-size:15px;background:var(--card2);color:var(--ink);
  transition:border-color .15s,box-shadow .15s;}
.frow input:focus,.frow select:focus,.frow textarea:focus{
  outline:none;border-color:var(--red);box-shadow:0 0 0 3px rgba(192,21,38,.12);background:#fff;}
.frow input::placeholder,.frow textarea::placeholder{color:#b3a892;}
.fnote{background:var(--ambg);color:var(--amber);border:1px solid #e7d3a4;
  border-radius:999px;font-size:11.5px;font-weight:800;
  display:inline-flex;align-items:center;padding:4px 12px;margin:0 0 12px;}
.notice{background:var(--card2);border-left:4px solid var(--amber);
  padding:10px 14px;font-size:13px;margin:10px 0;
  border-radius:0 6px 6px 0;color:var(--ink2);line-height:1.7;}
.entry-row{background:var(--card2);border:1.5px solid var(--line2);
  border-left:4px solid #d6c8ab;border-radius:9px;
  padding:11px 13px;margin-bottom:9px;
  transition:border-color .15s,box-shadow .15s;
  animation:ttR .2s ease both;}
.entry-row:hover{border-left-color:var(--red);box-shadow:0 3px 12px -8px rgba(192,21,38,.3);}
.row-head{display:flex;align-items:center;gap:8px;margin-bottom:9px;}
.row-num{font-weight:800;font-size:12px;color:#fff;
  background:linear-gradient(var(--red),var(--red2));
  width:21px;height:21px;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}
.btn-del{background:transparent;color:var(--red);border:1px solid #ecc6c6;
  padding:3px 8px;border-radius:5px;cursor:pointer;font-size:11px;
  font-weight:700;font-family:inherit;transition:all .15s;}
.btn-del:hover{background:#fbe9e9;border-color:var(--red);}
.eg{display:grid;gap:8px;margin-bottom:6px;}
.eg label{font-size:11px;font-weight:800;color:var(--ink2);letter-spacing:.05em;
  margin-bottom:3px;display:block;}
.eg .req{background:var(--red);color:#fff;font-size:9px;
  padding:1px 4px;border-radius:3px;margin-left:3px;}
.eg input,.eg select{width:100%;padding:8px 10px;border:1.5px solid var(--line);
  border-radius:7px;font-size:14px;background:#fff;color:var(--ink);
  font-family:inherit;transition:border-color .15s,box-shadow .15s;}
.eg input:focus,.eg select:focus{outline:none;border-color:var(--red);
  box-shadow:0 0 0 3px rgba(192,21,38,.13);}
.eg input::placeholder{color:#b3a892;}
.pair-sep{display:flex;align-items:center;gap:8px;margin:7px 0;
  font-size:11.5px;font-weight:800;color:var(--ink2);letter-spacing:.1em;}
.pair-sep::before,.pair-sep::after{content:"";flex:1;height:1px;background:var(--line);}
.caw{display:flex;align-items:center;gap:6px;margin:4px 0 10px;
  font-size:12.5px;color:var(--ink2);font-weight:700;}
.cav{font-weight:800;font-size:14px;color:var(--red);
  background:#fef2f2;border:1px solid #fcc;
  padding:2px 9px;border-radius:5px;min-width:44px;text-align:center;}
.btn-add{background:#fff;color:var(--amber);border:1.5px dashed #d9c8a8;
  padding:9px 16px;border-radius:8px;cursor:pointer;
  font-size:13px;font-weight:800;font-family:inherit;
  transition:all .15s;margin-right:8px;margin-top:8px;}
.btn-add:hover{background:var(--ambg);border-color:var(--amber);transform:translateY(-1px);}
.total-box{background:linear-gradient(150deg,#fffdf8,#faf2e3);
  border:2px solid var(--amber);border-radius:11px;padding:16px 20px;margin:16px 0;
  display:flex;justify-content:space-between;align-items:center;
  box-shadow:0 6px 20px -14px rgba(160,90,16,.5);}
.total-box .tl{font-family:var(--m);font-size:14px;font-weight:700;color:var(--amber);}
.total-box .ta{font-family:var(--m);font-size:34px;font-weight:700;color:var(--red);
  font-variant-numeric:tabular-nums;}
.check-row{display:flex;align-items:flex-start;gap:10px;
  background:#fef9ee;border:1.5px solid #f0d998;
  border-radius:8px;padding:11px 14px;margin:10px 0;font-size:13px;color:#7a5800;}
.check-row input[type=checkbox]{width:17px;height:17px;margin-top:2px;
  accent-color:var(--red);flex-shrink:0;cursor:pointer;}
.check-row label{cursor:pointer;}
.submit-btn{width:100%;padding:16px;font-size:16px;font-weight:800;
  font-family:var(--g);background:linear-gradient(var(--red),var(--red2));
  color:#fff;border:none;border-radius:10px;cursor:pointer;margin-top:16px;
  letter-spacing:.15em;transition:transform .12s,box-shadow .15s;
  box-shadow:0 8px 20px -8px rgba(192,21,38,.55);}
.submit-btn:hover{transform:translateY(-2px);box-shadow:0 12px 26px -8px rgba(192,21,38,.7);}
.submit-btn:disabled{background:#b9ad9c;cursor:not-allowed;transform:none;box-shadow:none;}
@keyframes ttSpin{to{transform:rotate(360deg)}}
.btn-spinner{display:inline-block;width:1.1em;height:1.1em;vertical-align:-.1em;
  border:2.5px solid currentColor;border-right-color:transparent;border-radius:50%;
  animation:ttSpin .7s linear infinite;}
.msg{padding:14px;margin:12px 0;border-radius:9px;text-align:center;
  font-weight:800;font-size:14px;}
.msg.ok{background:var(--gnbg);color:var(--green);border:1px solid #aee3c2;}
.msg.err{background:#fbeaea;color:#8c1118;border:1px solid #f0b9bb;}
.success-card{margin:16px 0;padding:20px;
  background:linear-gradient(150deg,var(--gnbg),#eafaf0);
  border:2px solid var(--green);border-radius:12px;animation:ttR .4s ease both;}
.success-card h3{font-family:var(--m);font-size:19px;color:var(--green);
  margin-bottom:8px;text-align:center;}
.summary-pre{background:#fff;padding:12px;border-radius:7px;font-size:12px;
  line-height:1.8;white-space:pre-wrap;word-break:break-word;
  font-family:var(--g);margin:10px 0;max-height:180px;overflow-y:auto;
  border:1px solid #c9ecd6;}
.copy-btn{width:100%;padding:11px;border-radius:8px;background:var(--green);
  color:#fff;border:none;cursor:pointer;font-size:14px;font-weight:800;
  font-family:inherit;transition:filter .15s;}
.copy-btn:hover{filter:brightness(1.07);}
.ffoot{text-align:center;margin-top:22px;padding:16px;color:var(--ink2);font-size:11px;}
.ffoot .org{font-family:var(--m);font-size:13px;font-weight:700;color:var(--ink);
  margin-bottom:3px;letter-spacing:.1em;}
@media(max-width:640px){
  body{padding:12px 8px 40px;}
  .fhd{padding:20px 14px 18px;}
  .fsec{padding:16px 12px;}
  .frow{grid-template-columns:1fr;}
  .eg{grid-template-columns:1fr !important;}
  .total-box .ta{font-size:26px;}
}`;

// ── クライアントサイド共通 JS ──────────────────────────────────
// createElement + addEventListener のみ — インラインハンドラ不使用
const _COMMON_JS = `
function _el(t,c){ var e=document.createElement(t); if(c)e.className=c; return e; }
function _tx(s){ return document.createTextNode(s); }
function _lbl(t){ var e=document.createElement('label'); e.textContent=t; return e; }
function _lblR(t){
  var e=document.createElement('label'); e.textContent=t;
  var s=_el('span','req'); s.textContent='必'; e.appendChild(s); return e;
}
function _cell(lt,el){ var d=_el('div'); d.appendChild(_lbl(lt)); d.appendChild(el); return d; }
function _cellR(lt,el){ var d=_el('div'); d.appendChild(_lblR(lt)); d.appendChild(el); return d; }
function _inp(type,field,ph,min,max){
  var e=document.createElement('input'); e.type=type;
  e.setAttribute('data-field',field);
  if(ph) e.placeholder=ph;
  if(min) e.min=min;
  if(max) e.max=max;
  return e;
}
function _sel(field,opts){
  var e=document.createElement('select'); e.setAttribute('data-field',field);
  opts.forEach(function(o){
    var op=document.createElement('option');
    op.value=o[0]; op.textContent=o[1]; if(o[2]) op.dataset.label=o[2];
    e.appendChild(op);
  });
  return e;
}
function _grid(cols,cells){
  var d=_el('div','eg'); d.style.cssText='grid-template-columns:'+cols+';';
  cells.forEach(function(c){ d.appendChild(c); }); return d;
}
function _sep(t){ var d=_el('div','pair-sep'); d.textContent=t; return d; }
function _rowHead(num,row){
  var h=_el('div','row-head');
  var sp=_el('span','row-num'); sp.textContent=String(num);
  var btn=_el('button','btn-del'); btn.type='button'; btn.textContent='削除';
  btn.addEventListener('click',function(){ row.remove(); recalcTotal(); });
  h.appendChild(sp); h.appendChild(btn); return h;
}
function recalcTotal(){
  var tot=0,sc=0,dc=0;
  document.querySelectorAll('.singles-row').forEach(function(r){
    var n=r.querySelector('[data-field="name"]');
    if(n&&n.value.trim()){ sc++; tot+=SINGLES_FEE; }
  });
  document.querySelectorAll('.doubles-row').forEach(function(r){
    var n1=r.querySelector('[data-field="name1"]'), n2=r.querySelector('[data-field="name2"]');
    if((n1&&n1.value.trim())||(n2&&n2.value.trim())){ dc++; tot+=DOUBLES_FEE; }
  });
  var el=document.getElementById('totalAmount'); if(el) el.textContent=tot.toLocaleString('ja-JP');
  var se=document.getElementById('singlesCount'); if(se) se.textContent=sc+' 名';
  var de=document.getElementById('doublesCount'); if(de) de.textContent=dc+' 組';
  return{singles:sc,doubles:dc,total:tot};
}
function updateCombinedAge(row){
  var a1=parseInt((row.querySelector('[data-field="age1"]')||{}).value)||0;
  var a2=parseInt((row.querySelector('[data-field="age2"]')||{}).value)||0;
  var el=row.querySelector('.cav');
  if(el) el.textContent=(a1+a2>0)?String(a1+a2)+'歳':'—';
}
function _clr(el){ while(el.firstChild) el.removeChild(el.firstChild); }
function showMsg(text,type){
  var box=document.getElementById('msgBox'); _clr(box);
  var d=_el('div','msg '+(['ok','err'].indexOf(type)>=0?type:'err'));
  d.textContent=text; box.appendChild(d);
  box.scrollIntoView({behavior:'smooth',block:'center'});
  if(type==='ok') setTimeout(function(){ _clr(box); },10000);
}
function showSuccess(summary){
  document.getElementById('mainForm').style.display='none';
  var box=document.getElementById('msgBox'); _clr(box);
  var card=_el('div','success-card');
  var h3=_el('h3'); h3.textContent='申込を受け付けました'; card.appendChild(h3);
  var p=_el('p');
  p.style.cssText='text-align:center;font-size:13px;color:#14532d;';
  p.textContent='お申込みありがとうございます。担当者へ通知メールを送信しました。'; card.appendChild(p);
  var pre=_el('div','summary-pre'); pre.id='summaryPre'; pre.textContent=summary; card.appendChild(pre);
  var btn=_el('button','copy-btn'); btn.type='button'; btn.id='copyBtn';
  btn.textContent='クリップボードにコピー';
  btn.addEventListener('click',function(){
    var self=this;
    if(navigator.clipboard){
      navigator.clipboard.writeText(summary).then(function(){
        self.textContent='コピーしました ✓';
        setTimeout(function(){ self.textContent='クリップボードにコピー'; },2500);
      }).catch(function(){ _lcopy(summary,self); });
    }else{ _lcopy(summary,self); }
  });
  card.appendChild(btn); box.appendChild(card);
  box.scrollIntoView({behavior:'smooth',block:'start'});
}
function _lcopy(text,btn){
  var ta=document.createElement('textarea'); ta.value=text;
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); }catch(e){}
  ta.remove(); btn.textContent='コピーしました ✓';
  setTimeout(function(){ btn.textContent='クリップボードにコピー'; },2500);
}
function submitForm(e){
  e.preventDefault();
  var data=gatherData(); if(!data) return false;
  var btn=document.getElementById('submitBtn');
  btn.disabled=true; btn.classList.add('is-sending'); btn.textContent='';
  btn.appendChild(_el('span','btn-spinner'));
  var ctrl=(typeof AbortController!=='undefined')?new AbortController():null;
  var timer=ctrl?setTimeout(function(){ ctrl.abort(); },25000):null;
  fetch(GAS_URL,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},
    body:JSON.stringify(data),signal:ctrl?ctrl.signal:undefined})
  .then(function(resp){
    if(timer) clearTimeout(timer);
    return resp.text().then(function(txt){
      var r; try{ r=JSON.parse(txt); }catch(_){ r={ok:resp.ok}; }
      if(r.ok||resp.ok){ showSuccess(buildSummary(data)); }
      else{ showMsg('送信できませんでした: '+(r.error||('HTTP '+resp.status)),'err'); }
    });
  }).catch(function(err){
    if(timer) clearTimeout(timer);
    showMsg((err&&err.name==='AbortError')?'通信タイムアウト。再度お試しください。':'送信できませんでした。通信環境をご確認ください。','err');
  }).finally(function(){
    btn.disabled=false; btn.classList.remove('is-sending');
    btn.textContent='申込内容を送信';
  });
  return false;
}
`;

// ═══════════════════════════════════════════════════════════
// 1. マスターズ申込フォーム
//    2026北海道卓球選手権大会（マスターズの部フィフティ以上）兼全日本予選会
// ═══════════════════════════════════════════════════════════

function buildMasters2026FormHTML(opts) {
  opts = opts || {};
  const gasUrl = escapeJs(opts.gas_url || '');
  const sCatsJs = JSON.stringify(MASTERS_SINGLES_CATS);
  const dCatsJs = JSON.stringify(MASTERS_DOUBLES_CATS);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>2026北海道卓球選手権大会（マスターズの部フィフティ以上）参加申込</title>
<style>${_CSS}</style>
</head>
<body>
<div class="fhd">
  <h1><span class="seal">参加申込</span>2026北海道卓球選手権大会（マスターズの部 フィフティ以上）<br>兼 全日本予選会</h1>
  <div class="meta">2026年8月8日(土)〜9日(日) · 苫小牧市総合体育館 · 申込締切: 2026年7月10日(金)</div>
</div>
<form id="mainForm">

<div class="fsec">
  <h2>申込責任者</h2>
  <div class="frow two">
    <div>
      <label>責任者氏名 <span class="req">必須</span></label>
      <input type="text" id="contact_name" required placeholder="山田 太郎">
    </div>
    <div>
      <label>電話番号 <span class="req">必須</span></label>
      <input type="tel" id="contact_tel" required placeholder="0154-XX-XXXX">
    </div>
  </div>
</div>

<div class="fsec">
  <h2>シングルス申込 <span class="cbadge" id="singlesCount">0&nbsp;名</span></h2>
  <div class="fnote">1名 ¥2,000（参加料は6月13日・ヤサカ杯にて集金）</div>
  <div class="notice">
    ・性別・種目（年齢区分）を選択してください。年齢は2027年4月1日時点。<br>
    ・各シングルス種目への参加は1人1種目です。<br>
    ・ナインティ（90歳以上）出場者は家族の同意書（別紙）が必要です。
  </div>
  <div id="singlesContainer"></div>
  <button type="button" class="btn-add" id="btnAddS">＋ 選手を1名追加</button>
  <button type="button" class="btn-add" id="btnAddS5" style="border-style:solid;border-color:#e0b75a;background:var(--ambg);">＋ 5名を一括追加</button>
</div>

<div class="fsec">
  <h2>ダブルス申込 <span class="cbadge" id="doublesCount">0&nbsp;組</span></h2>
  <div class="fnote">1組 ¥2,400（参加料は6月13日・ヤサカ杯にて集金）</div>
  <div class="notice">
    ・男子ダブルス・女子ダブルスのみ（混合不可）。50歳以上が出場可能。<br>
    ・カテゴリは2名の年齢合計で選択してください。
  </div>
  <div id="doublesContainer"></div>
  <button type="button" class="btn-add" id="btnAddD">＋ ペアを1組追加</button>
</div>

<div class="fsec">
  <h2>合計・確認</h2>
  <div class="total-box">
    <div class="tl">参加料合計（目安）</div>
    <div class="ta">¥&thinsp;<span id="totalAmount">0</span></div>
  </div>
  <div class="check-row">
    <input type="checkbox" id="has_over90">
    <label for="has_over90">
      <strong>ナインティ（90歳以上）の選手がいます。</strong><br>
      家族の同意書（別紙「2026選手権マスターズ90歳代同意書」）を別途提出します。
    </label>
  </div>
  <div style="margin-top:12px;">
    <label style="display:block;font-size:12px;font-weight:800;color:var(--ink2);margin-bottom:5px;">備考・連絡事項</label>
    <textarea id="note" rows="3" placeholder="連絡事項があればご記入ください"
      style="width:100%;padding:10px 12px;border:1.5px solid var(--line);border-radius:8px;font-family:inherit;font-size:15px;background:var(--card2);resize:vertical;"></textarea>
  </div>
  <button type="submit" class="submit-btn" id="submitBtn">申込内容を送信</button>
</div>
</form>
<div id="msgBox"></div>
<div class="ffoot">
  <div class="org">北海道卓球連盟 / 釧路卓球協会</div>
  <div>Powered by KTTA Platform</div>
</div>

<script>
var GAS_URL='${gasUrl}', SINGLES_FEE=2000, DOUBLES_FEE=2400;
var FORM_TYPE='masters_2026', FORM_NAME='2026北海道卓球選手権大会（マスターズの部フィフティ以上）兼全日本予選会';
var MASTERS_SINGLES_CATS=${sCatsJs};
var MASTERS_DOUBLES_CATS=${dCatsJs};

${_COMMON_JS}

function addSingles(){
  var c=document.getElementById('singlesContainer');
  var row=_el('div','entry-row singles-row');
  row.appendChild(_rowHead(c.children.length+1,row));
  var gSel=_sel('gender',[['male','男子'],['female','女子']]);
  gSel.addEventListener('change',recalcTotal);
  var cSel=_sel('category',MASTERS_SINGLES_CATS);
  cSel.addEventListener('change',recalcTotal);
  var top=_grid('1fr 2.5fr',[_cell('性別',gSel),_cell('種目（年齢区分）',cSel)]);
  top.style.marginBottom='10px'; row.appendChild(top);
  var fg=_inp('text','furigana','よみかた');
  fg.addEventListener('input',recalcTotal);
  var nm=_inp('text','name','田中 一郎');
  nm.addEventListener('input',recalcTotal);
  var ag=_inp('number','age','65','50','120');
  ag.addEventListener('input',recalcTotal);
  var bd=_inp('date','birthdate','');
  var tm=_inp('text','team','○○クラブ');
  tm.addEventListener('input',recalcTotal);
  row.appendChild(_grid('1fr 1.2fr 0.7fr 1.2fr 1.5fr',[
    _cell('ふりがな',fg),_cellR('氏名',nm),
    _cell('年齢',ag),_cell('生年月日',bd),_cell('所属',tm)
  ]));
  c.appendChild(row); recalcTotal();
}
function addSinglesN(n){ for(var i=0;i<n;i++) addSingles(); }

function addDoubles(){
  var c=document.getElementById('doublesContainer');
  var row=_el('div','entry-row doubles-row');
  row.appendChild(_rowHead(c.children.length+1,row));
  var pgSel=_sel('pair_gender',[['male','男子ダブルス'],['female','女子ダブルス']]);
  pgSel.addEventListener('change',recalcTotal);
  var catSel=_sel('category',MASTERS_DOUBLES_CATS);
  catSel.addEventListener('change',recalcTotal);
  var top=_grid('1fr 1fr',[_cell('ペアの性別',pgSel),_cell('カテゴリ（2名の合計年齢）',catSel)]);
  top.style.marginBottom='8px'; row.appendChild(top);
  var aw=_el('div','caw');
  aw.appendChild(_tx('合計年齢: '));
  var av=_el('span','cav'); av.textContent='—'; aw.appendChild(av);
  row.appendChild(aw);
  row.appendChild(_sep('選手A'));
  var fA=_inp('text','furigana1','よみかた'); fA.addEventListener('input',recalcTotal);
  var nA=_inp('text','name1','田中 一郎'); nA.addEventListener('input',recalcTotal);
  var aA=_inp('number','age1','65','50','120');
  aA.addEventListener('input',function(){ updateCombinedAge(row); recalcTotal(); });
  var bA=_inp('date','birthdate1','');
  var tA=_inp('text','team1','○○クラブ'); tA.addEventListener('input',recalcTotal);
  row.appendChild(_grid('1fr 1.2fr 0.7fr 1.2fr 1.5fr',[
    _cell('ふりがな',fA),_cellR('氏名',nA),
    _cell('年齢',aA),_cell('生年月日',bA),_cell('所属',tA)
  ]));
  row.appendChild(_sep('選手B'));
  var fB=_inp('text','furigana2','よみかた'); fB.addEventListener('input',recalcTotal);
  var nB=_inp('text','name2','鈴木 花子'); nB.addEventListener('input',recalcTotal);
  var aB=_inp('number','age2','62','50','120');
  aB.addEventListener('input',function(){ updateCombinedAge(row); recalcTotal(); });
  var bB=_inp('date','birthdate2','');
  var tB=_inp('text','team2','△△クラブ'); tB.addEventListener('input',recalcTotal);
  row.appendChild(_grid('1fr 1.2fr 0.7fr 1.2fr 1.5fr',[
    _cell('ふりがな',fB),_cellR('氏名',nB),
    _cell('年齢',aB),_cell('生年月日',bB),_cell('所属',tB)
  ]));
  c.appendChild(row); recalcTotal();
}

function gatherData(){
  var cname=(document.getElementById('contact_name').value||'').trim();
  var ctel=(document.getElementById('contact_tel').value||'').trim();
  if(!cname||!ctel){ showMsg('責任者氏名・電話番号は必須です。','err'); return null; }
  var singles=[],doubles=[];
  document.querySelectorAll('.singles-row').forEach(function(row){
    var name=(row.querySelector('[data-field="name"]').value||'').trim(); if(!name) return;
    var gSel=row.querySelector('[data-field="gender"]');
    var cSel=row.querySelector('[data-field="category"]');
    singles.push({
      gender:gSel.value, gender_label:gSel.options[gSel.selectedIndex].text,
      category:cSel.value, category_label:(cSel.options[cSel.selectedIndex].dataset.label||cSel.value),
      furigana:(row.querySelector('[data-field="furigana"]').value||'').trim(),
      name:name, age:parseInt(row.querySelector('[data-field="age"]').value)||'',
      birthdate:row.querySelector('[data-field="birthdate"]').value||'',
      team:(row.querySelector('[data-field="team"]').value||'').trim(), fee:SINGLES_FEE,
    });
  });
  document.querySelectorAll('.doubles-row').forEach(function(row){
    var n1=(row.querySelector('[data-field="name1"]').value||'').trim();
    var n2=(row.querySelector('[data-field="name2"]').value||'').trim();
    if(!n1&&!n2) return;
    var pg=row.querySelector('[data-field="pair_gender"]');
    var cs=row.querySelector('[data-field="category"]');
    var a1=parseInt(row.querySelector('[data-field="age1"]').value)||0;
    var a2=parseInt(row.querySelector('[data-field="age2"]').value)||0;
    doubles.push({
      pair_gender:pg.value, pair_gender_label:pg.options[pg.selectedIndex].text,
      category:cs.value, category_label:(cs.options[cs.selectedIndex].dataset.label||cs.value),
      furigana1:(row.querySelector('[data-field="furigana1"]').value||'').trim(),
      name1:n1, age1:a1||'', birthdate1:row.querySelector('[data-field="birthdate1"]').value||'',
      team1:(row.querySelector('[data-field="team1"]').value||'').trim(),
      furigana2:(row.querySelector('[data-field="furigana2"]').value||'').trim(),
      name2:n2, age2:a2||'', birthdate2:row.querySelector('[data-field="birthdate2"]').value||'',
      team2:(row.querySelector('[data-field="team2"]').value||'').trim(),
      combined_age:a1+a2||'', fee:DOUBLES_FEE,
    });
  });
  if(!singles.length&&!doubles.length){
    showMsg('少なくとも1名（シングルス）または1組（ダブルス）を入力してください。','err');
    return null;
  }
  return{form_type:FORM_TYPE,form_name:FORM_NAME,
    contact_name:cname,contact_tel:ctel,
    has_over90:document.getElementById('has_over90').checked,
    note:(document.getElementById('note').value||'').trim(),
    singles:singles,doubles:doubles,
    total_amount:singles.length*SINGLES_FEE+doubles.length*DOUBLES_FEE,
    submitted_at:new Date().toISOString()};
}
function buildSummary(data){
  var ls=['['+FORM_NAME+']',
    '責任者: '+data.contact_name+' / 連絡先: '+data.contact_tel];
  if(data.has_over90) ls.push('※ ナインティ出場者あり（同意書別途提出）');
  ls.push('');
  if(data.singles.length){
    ls.push('■ シングルス（'+data.singles.length+'名）');
    data.singles.forEach(function(s,i){
      ls.push('  '+(i+1)+'. ['+s.gender_label+' '+s.category_label+'] '+(s.furigana?s.furigana+' ':'')+s.name+(s.age?'('+s.age+'歳)':'')+(s.team?' / '+s.team:''));
    });
  }
  if(data.doubles.length){
    ls.push('');
    ls.push('■ ダブルス（'+data.doubles.length+'組）');
    data.doubles.forEach(function(d,i){
      ls.push('  '+(i+1)+'. ['+d.pair_gender_label+' '+d.category_label+'] '+d.name1+'('+d.age1+'歳) / '+d.name2+'('+d.age2+'歳) 合計'+d.combined_age+'歳');
    });
  }
  ls.push('');
  ls.push('合計: ¥'+data.total_amount.toLocaleString('ja-JP')+'（6/13 ヤサカ杯にて集金）');
  return ls.join('\\n');
}
document.getElementById('mainForm').addEventListener('submit', submitForm);
document.getElementById('btnAddS').addEventListener('click', addSingles);
document.getElementById('btnAddS5').addEventListener('click', function(){ addSinglesN(5); });
document.getElementById('btnAddD').addEventListener('click', addDoubles);
addSingles(); addDoubles();
</script>
</body>
</html>`;
}


// ═══════════════════════════════════════════════════════════
// 共通: ラージボール系フォーム生成
// ═══════════════════════════════════════════════════════════

function _buildLargeballFormHTML(cfg, gasUrl) {
  const title    = escapeHtml(cfg.title);
  const subtitle = escapeHtml(cfg.subtitle);
  const ftJs     = escapeJs(cfg.form_type);
  const fnJs     = escapeJs(cfg.form_name);
  const gasUrlJs = escapeJs(gasUrl);
  const sCatsJs  = JSON.stringify(LARGEBALL_SINGLES_CATS);
  const dCatsJs  = JSON.stringify(LARGEBALL_DOUBLES_CATS);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} 参加申込</title>
<style>${_CSS}</style>
</head>
<body>
<div class="fhd">
  <h1><span class="seal">参加申込</span>${title}</h1>
  <div class="meta">${subtitle}</div>
</div>
<form id="mainForm">

<div class="fsec">
  <h2>申込責任者</h2>
  <div class="frow two">
    <div>
      <label>責任者氏名 <span class="req">必須</span></label>
      <input type="text" id="contact_name" required placeholder="山田 太郎">
    </div>
    <div>
      <label>電話番号 <span class="req">必須</span></label>
      <input type="tel" id="contact_tel" required placeholder="0154-XX-XXXX">
    </div>
  </div>
</div>

<div class="fsec">
  <h2>シングルス申込 <span class="cbadge" id="singlesCount">0&nbsp;名</span></h2>
  <div class="fnote">1名 ¥2,000（参加料は6月13日・ヤサカ杯にて集金）</div>
  <div class="notice">
    ・性別・種目（年齢区分）を選択してください。年齢は2027年4月1日時点。<br>
    ・シングルスと混合ダブルスの両種目に出場できます。<br>
    ・第39回全国大会と第9回全日本選手権の重複出場はできません。
  </div>
  <div id="singlesContainer"></div>
  <button type="button" class="btn-add" id="btnAddS">＋ 選手を1名追加</button>
  <button type="button" class="btn-add" id="btnAddS5" style="border-style:solid;border-color:#e0b75a;background:var(--ambg);">＋ 5名を一括追加</button>
</div>

<div class="fsec">
  <h2>混合ダブルス申込 <span class="cbadge" id="doublesCount">0&nbsp;組</span></h2>
  <div class="fnote">1組 ¥2,400（参加料は6月13日・ヤサカ杯にて集金）</div>
  <div class="notice">
    ・カテゴリは2名の年齢合計で選択してください。
  </div>
  <div id="doublesContainer"></div>
  <button type="button" class="btn-add" id="btnAddD">＋ ペアを1組追加</button>
</div>

<div class="fsec">
  <h2>合計・確認</h2>
  <div class="total-box">
    <div class="tl">参加料合計（目安）</div>
    <div class="ta">¥&thinsp;<span id="totalAmount">0</span></div>
  </div>
  <div style="margin-top:12px;">
    <label style="display:block;font-size:12px;font-weight:800;color:var(--ink2);margin-bottom:5px;">備考・連絡事項</label>
    <textarea id="note" rows="3" placeholder="連絡事項があればご記入ください"
      style="width:100%;padding:10px 12px;border:1.5px solid var(--line);border-radius:8px;font-family:inherit;font-size:15px;background:var(--card2);resize:vertical;"></textarea>
  </div>
  <button type="submit" class="submit-btn" id="submitBtn">申込内容を送信</button>
</div>
</form>
<div id="msgBox"></div>
<div class="ffoot">
  <div class="org">北海道卓球連盟 / 釧路卓球協会</div>
  <div>Powered by KTTA Platform</div>
</div>

<script>
var GAS_URL='${gasUrlJs}', SINGLES_FEE=2000, DOUBLES_FEE=2400;
var FORM_TYPE='${ftJs}', FORM_NAME='${fnJs}';
var LARGEBALL_SINGLES_CATS=${sCatsJs};
var LARGEBALL_DOUBLES_CATS=${dCatsJs};

${_COMMON_JS}

function addSingles(){
  var c=document.getElementById('singlesContainer');
  var row=_el('div','entry-row singles-row');
  row.appendChild(_rowHead(c.children.length+1,row));
  var gSel=_sel('gender',[['male','男子'],['female','女子']]);
  gSel.addEventListener('change',recalcTotal);
  var cSel=_sel('category',LARGEBALL_SINGLES_CATS);
  cSel.addEventListener('change',recalcTotal);
  var top=_grid('1fr 3fr',[_cell('性別',gSel),_cell('種目（年齢区分）',cSel)]);
  top.style.marginBottom='10px'; row.appendChild(top);
  var nm=_inp('text','name','田中 一郎'); nm.addEventListener('input',recalcTotal);
  var ag=_inp('number','age','62','1','100'); ag.addEventListener('input',recalcTotal);
  var tm=_inp('text','team','○○クラブ'); tm.addEventListener('input',recalcTotal);
  row.appendChild(_grid('2fr 1fr 2fr',[
    _cellR('氏名',nm),_cell('年齢',ag),_cell('所属チーム',tm)
  ]));
  c.appendChild(row); recalcTotal();
}
function addSinglesN(n){ for(var i=0;i<n;i++) addSingles(); }

function addDoubles(){
  var c=document.getElementById('doublesContainer');
  var row=_el('div','entry-row doubles-row');
  row.appendChild(_rowHead(c.children.length+1,row));
  var cs=_sel('category',LARGEBALL_DOUBLES_CATS);
  cs.addEventListener('change',recalcTotal);
  var top=_grid('1.5fr 1fr',[_cell('カテゴリ（合計年齢）',cs),_el('div','')]);
  top.style.marginBottom='8px'; row.appendChild(top);
  var aw=_el('div','caw');
  aw.appendChild(_tx('2名の合計年齢: '));
  var av=_el('span','cav'); av.textContent='—'; aw.appendChild(av);
  row.appendChild(aw);
  row.appendChild(_sep('男子選手'));
  var n1=_inp('text','name1','田中 一郎'); n1.addEventListener('input',recalcTotal);
  var a1=_inp('number','age1','65','1','100');
  a1.addEventListener('input',function(){ updateCombinedAge(row); recalcTotal(); });
  var t1=_inp('text','team1','○○クラブ'); t1.addEventListener('input',recalcTotal);
  row.appendChild(_grid('2fr 1fr 2fr',[
    _cellR('氏名',n1),_cell('年齢',a1),_cell('所属チーム',t1)
  ]));
  row.appendChild(_sep('女子選手'));
  var n2=_inp('text','name2','佐藤 花子'); n2.addEventListener('input',recalcTotal);
  var a2=_inp('number','age2','58','1','100');
  a2.addEventListener('input',function(){ updateCombinedAge(row); recalcTotal(); });
  var t2=_inp('text','team2','△△クラブ'); t2.addEventListener('input',recalcTotal);
  row.appendChild(_grid('2fr 1fr 2fr',[
    _cellR('氏名',n2),_cell('年齢',a2),_cell('所属チーム',t2)
  ]));
  c.appendChild(row); recalcTotal();
}

function gatherData(){
  var cname=(document.getElementById('contact_name').value||'').trim();
  var ctel=(document.getElementById('contact_tel').value||'').trim();
  if(!cname||!ctel){ showMsg('責任者氏名・電話番号は必須です。','err'); return null; }
  var singles=[],doubles=[];
  document.querySelectorAll('.singles-row').forEach(function(row){
    var name=(row.querySelector('[data-field="name"]').value||'').trim(); if(!name) return;
    var gSel=row.querySelector('[data-field="gender"]');
    var cSel=row.querySelector('[data-field="category"]');
    singles.push({
      gender:gSel.value, gender_label:gSel.options[gSel.selectedIndex].text,
      category:cSel.value, category_label:(cSel.options[cSel.selectedIndex].dataset.label||cSel.value),
      name:name, age:parseInt(row.querySelector('[data-field="age"]').value)||'',
      team:(row.querySelector('[data-field="team"]').value||'').trim(), fee:SINGLES_FEE,
    });
  });
  document.querySelectorAll('.doubles-row').forEach(function(row){
    var n1=(row.querySelector('[data-field="name1"]').value||'').trim();
    var n2=(row.querySelector('[data-field="name2"]').value||'').trim();
    if(!n1&&!n2) return;
    var cs=row.querySelector('[data-field="category"]');
    var a1=parseInt(row.querySelector('[data-field="age1"]').value)||0;
    var a2=parseInt(row.querySelector('[data-field="age2"]').value)||0;
    doubles.push({
      category:cs.value, category_label:(cs.options[cs.selectedIndex].dataset.label||cs.value),
      name1:n1, age1:a1||'',
      team1:(row.querySelector('[data-field="team1"]').value||'').trim(),
      name2:n2, age2:a2||'',
      team2:(row.querySelector('[data-field="team2"]').value||'').trim(),
      combined_age:a1+a2||'', fee:DOUBLES_FEE,
    });
  });
  if(!singles.length&&!doubles.length){
    showMsg('少なくとも1名または1組を入力してください。','err'); return null;
  }
  return{form_type:FORM_TYPE,form_name:FORM_NAME,
    contact_name:cname,contact_tel:ctel,
    note:(document.getElementById('note').value||'').trim(),
    singles:singles,doubles:doubles,
    total_amount:singles.length*SINGLES_FEE+doubles.length*DOUBLES_FEE,
    submitted_at:new Date().toISOString()};
}
function buildSummary(data){
  var ls=['['+FORM_NAME+']',
    '責任者: '+data.contact_name+' / 連絡先: '+data.contact_tel,''];
  if(data.singles.length){
    ls.push('■ シングルス（'+data.singles.length+'名）');
    data.singles.forEach(function(s,i){
      ls.push('  '+(i+1)+'. ['+s.gender_label+' '+s.category_label+'] '+s.name+(s.age?'('+s.age+'歳)':'')+(s.team?' / '+s.team:''));
    });
  }
  if(data.doubles.length){
    ls.push('');
    ls.push('■ 混合ダブルス（'+data.doubles.length+'組）');
    data.doubles.forEach(function(d,i){
      ls.push('  '+(i+1)+'. ['+d.category_label+'] '+d.name1+'('+d.age1+'歳) / '+d.name2+'('+d.age2+'歳) 合計'+d.combined_age+'歳');
      if(d.team1||d.team2) ls.push('       '+(d.team1||'—')+' / '+(d.team2||'—'));
    });
  }
  ls.push('');
  ls.push('合計: ¥'+data.total_amount.toLocaleString('ja-JP')+'（6/13 ヤサカ杯にて集金）');
  return ls.join('\\n');
}
document.getElementById('mainForm').addEventListener('submit', submitForm);
document.getElementById('btnAddS').addEventListener('click', addSingles);
document.getElementById('btnAddS5').addEventListener('click', function(){ addSinglesN(5); });
document.getElementById('btnAddD').addEventListener('click', addDoubles);
addSingles(); addDoubles();
</script>
</body>
</html>`;
}


// ═══════════════════════════════════════════════════════════
// 2. 全国ラージボール北海道予選
// ═══════════════════════════════════════════════════════════

function buildLargeballNational2026FormHTML(opts) {
  opts = opts || {};
  return _buildLargeballFormHTML({
    title:     '第39回 全国ラージボール卓球大会 北海道予選会',
    subtitle:  '2026年7月26日(日) 開始式13時00分 · 札幌市白石体育館 競技室 · 申込締切: 2026年7月3日(金)',
    form_type: 'largeball_national_2026',
    form_name: '第39回全国ラージボール卓球大会 北海道予選',
  }, opts.gas_url || '');
}


// ═══════════════════════════════════════════════════════════
// 3. 全日本ラージボール選手権北海道予選
// ═══════════════════════════════════════════════════════════

function buildLargeballAllJapan2026FormHTML(opts) {
  opts = opts || {};
  return _buildLargeballFormHTML({
    title:     '第9回 全日本ラージボール卓球選手権大会 北海道予選会',
    subtitle:  '2026年7月26日(日) 開始式13時00分 · 札幌市白石体育館 競技室 · 申込締切: 2026年7月3日(金)',
    form_type: 'largeball_alljapan_2026',
    form_name: '第9回全日本ラージボール卓球選手権大会 北海道予選',
  }, opts.gas_url || '');
}


module.exports = {
  buildMasters2026FormHTML,
  buildLargeballNational2026FormHTML,
  buildLargeballAllJapan2026FormHTML,
};
