'use strict';
// 外部大会申込フォーム HTML 生成
// 対象: マスターズ / 全国ラージボール / 全日本ラージボール選手権 各道予選
// GAS Web App へ POST するスタンドアロン HTML。
// 丹頂エディトリアル デザイン継承。

const { escapeHtml, escapeJs } = require('./lib/text');

// ─── 共有 CSS ───────────────────────────────────────────
const _CSS = `
  :root{
    --paper:#f1e9d9;--card:#fffdf8;--card-2:#fbf6ec;
    --ink:#211b15;--ink-2:#6c6153;--line:#e4d8c2;--line-2:#efe6d4;
    --red:#c01526;--red-2:#9c0f1c;
    --amber:#9a6a10;--amber-bg:#f6ebcd;
    --green:#1a7a45;--green-bg:#e9f7ee;
    --gothic:'Hiragino Sans','BIZ UDPGothic','Yu Gothic UI','Yu Gothic','Meiryo',system-ui,sans-serif;
    --mincho:'Hiragino Mincho ProN','Yu Mincho','YuMincho','Hiragino Mincho Pro',serif;
    --shadow:0 18px 44px -22px rgba(48,32,16,.45);
    --radius:14px;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  html{-webkit-text-size-adjust:100%;}
  body{
    font-family:var(--gothic);color:var(--ink);line-height:1.78;
    font-size:16px;padding:24px 14px 56px;
    max-width:900px;margin:0 auto;
    background-color:var(--paper);
    background-image:
      radial-gradient(1100px 520px at 108% -8%,rgba(192,21,38,.07),transparent 58%),
      radial-gradient(900px 520px at -12% 112%,rgba(154,106,16,.08),transparent 58%);
    -webkit-font-smoothing:antialiased;
  }
  @keyframes ttRise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  .fhd{
    background:linear-gradient(155deg,#241d16 0%,#36281c 60%,#2c2118 100%);
    color:#f6efe2;padding:30px 30px 26px;
    border-radius:var(--radius) var(--radius) 0 0;
    border-top:5px solid var(--red);animation:ttRise .5s ease both;
    position:relative;overflow:hidden;
  }
  .fhd::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;
    background:linear-gradient(90deg,var(--red),#d4a017 70%,transparent);opacity:.85;}
  .fhd h1{font-family:var(--mincho);font-size:28px;font-weight:700;line-height:1.3;
    letter-spacing:.02em;position:relative;z-index:1;text-wrap:balance;}
  .fhd .seal{display:inline-block;vertical-align:middle;
    background:var(--red);color:#fff;font-size:11px;font-weight:800;
    padding:4px 10px;border-radius:4px;margin-right:10px;letter-spacing:.18em;
    box-shadow:0 2px 0 rgba(0,0,0,.25);}
  .fhd .meta{font-size:13px;color:#d8cdba;margin-top:10px;position:relative;z-index:1;letter-spacing:.04em;}
  .fsec{
    background:var(--card);padding:24px 26px;
    border-left:1px solid var(--line);border-right:1px solid var(--line);
    animation:ttRise .5s ease both;
  }
  .fsec:last-of-type{
    border-radius:0 0 var(--radius) var(--radius);
    border-bottom:1px solid var(--line);padding-bottom:28px;
    box-shadow:var(--shadow);
  }
  .fsec h2{
    font-family:var(--mincho);font-size:19px;font-weight:700;
    margin-bottom:16px;color:var(--ink);
    display:flex;align-items:center;gap:10px;letter-spacing:.03em;
  }
  .fsec h2::before{content:"";width:5px;height:20px;border-radius:2px;
    background:linear-gradient(var(--red),var(--red-2));
    box-shadow:0 1px 4px rgba(192,21,38,.4);}
  .frow{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
  .frow.full{grid-template-columns:1fr;}
  .frow.three{grid-template-columns:1fr 1fr 1fr;}
  .frow label{display:block;font-size:12px;font-weight:800;color:var(--ink-2);
    margin-bottom:6px;letter-spacing:.07em;}
  .frow label .req{background:var(--red);color:#fff;font-size:9px;
    padding:2px 6px;border-radius:3px;margin-left:6px;letter-spacing:.12em;vertical-align:1px;}
  .frow input,.frow select,.frow textarea{
    width:100%;padding:11px 13px;border:1.5px solid var(--line);border-radius:8px;
    font-family:inherit;font-size:15px;background:var(--card-2);color:var(--ink);
    transition:border-color .15s,box-shadow .15s,background .15s;
  }
  .frow input:focus,.frow select:focus,.frow textarea:focus{
    outline:none;border-color:var(--red);box-shadow:0 0 0 3px rgba(192,21,38,.12);background:#fff;
  }
  .frow input::placeholder,.frow textarea::placeholder{color:#b3a892;}
  .fee-note{
    display:inline-flex;align-items:center;padding:4px 12px;
    background:var(--amber-bg);color:var(--amber);border:1px solid #e7d3a4;
    border-radius:999px;font-size:11.5px;font-weight:800;margin:0 0 14px;
  }
  .entry-row{
    background:var(--card-2);border:1.5px solid var(--line-2);
    border-left:4px solid #d6c8ab;border-radius:9px;
    padding:12px 14px;margin-bottom:10px;
    transition:border-color .15s,box-shadow .15s;
    animation:ttRise .25s ease both;
  }
  .entry-row:hover{border-left-color:var(--red);box-shadow:0 3px 14px -8px rgba(192,21,38,.3);}
  .row-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
  .row-num{
    font-weight:800;font-size:12px;color:#fff;
    background:linear-gradient(var(--red),var(--red-2));
    width:22px;height:22px;border-radius:50%;
    display:inline-flex;align-items:center;justify-content:center;
  }
  .btn-del{
    background:transparent;color:var(--red);border:1px solid #ecc6c6;
    padding:3px 9px;border-radius:5px;cursor:pointer;font-size:11px;
    font-weight:700;font-family:inherit;transition:all .15s;
  }
  .btn-del:hover{background:#fbe9e9;border-color:var(--red);}
  .eg{display:grid;gap:8px;margin-bottom:6px;}
  .eg.g2{grid-template-columns:1fr 1fr;}
  .eg.g3{grid-template-columns:1fr 1fr 1fr;}
  .eg.g4{grid-template-columns:1fr 1fr 1fr 1fr;}
  .eg label{font-size:11px;font-weight:800;color:var(--ink-2);letter-spacing:.06em;margin-bottom:4px;display:block;}
  .eg .req{background:var(--red);color:#fff;font-size:9px;
    padding:2px 5px;border-radius:3px;margin-left:4px;letter-spacing:.1em;}
  .eg input,.eg select{
    width:100%;padding:9px 11px;border:1.5px solid var(--line);border-radius:7px;
    font-size:14.5px;background:#fff;color:var(--ink);
    font-family:inherit;transition:border-color .15s,box-shadow .15s;
  }
  .eg input:focus,.eg select:focus{
    outline:none;border-color:var(--red);box-shadow:0 0 0 3px rgba(192,21,38,.13);
  }
  .eg input::placeholder{color:#b3a892;}
  .pair-sep{
    display:flex;align-items:center;gap:8px;margin:8px 0;
    font-size:12px;font-weight:800;color:var(--ink-2);letter-spacing:.1em;
  }
  .pair-sep::before,.pair-sep::after{content:"";flex:1;height:1px;background:var(--line);}
  .combined-age-wrap{
    display:flex;align-items:center;gap:6px;margin-top:4px;
    font-size:12.5px;color:var(--ink-2);font-weight:700;
  }
  .combined-age-val{
    font-weight:800;font-size:15px;color:var(--red);
    background:#fef2f2;border:1px solid #fcc;
    padding:2px 10px;border-radius:6px;min-width:48px;text-align:center;
  }
  .btn-add{
    background:#fff;color:var(--amber);border:1.5px dashed #d9c8a8;
    padding:10px 18px;border-radius:8px;cursor:pointer;
    font-size:13.5px;font-weight:800;font-family:inherit;
    transition:all .15s;
  }
  .btn-add:hover{background:var(--amber-bg);border-color:var(--amber);transform:translateY(-1px);}
  .add-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
  .count-badge{
    display:inline-flex;align-items:center;
    padding:3px 10px;background:var(--green-bg);
    color:var(--green);border:1px solid #aee3c2;
    border-radius:999px;font-size:11px;font-weight:800;
    margin-left:auto;font-family:var(--gothic);
  }
  .notice{
    background:var(--card-2);border-left:4px solid var(--amber);
    padding:11px 16px;font-size:13px;margin:12px 0;
    border-radius:0 7px 7px 0;color:var(--ink-2);line-height:1.7;
  }
  .total-box{
    background:linear-gradient(150deg,#fffdf8,#faf2e3);
    border:2px solid var(--amber);border-radius:12px;
    padding:18px 22px;margin:18px 0;
    display:flex;justify-content:space-between;align-items:center;
    box-shadow:0 6px 22px -14px rgba(160,90,16,.5);
  }
  .total-box .t-label{font-family:var(--mincho);font-size:15px;font-weight:700;color:var(--amber);}
  .total-box .t-amount{font-family:var(--mincho);font-size:36px;font-weight:700;color:var(--red);
    font-variant-numeric:tabular-nums;}
  .check-row{
    display:flex;align-items:flex-start;gap:10px;
    background:#fef9ee;border:1.5px solid #f0d998;
    border-radius:8px;padding:12px 16px;margin:12px 0;font-size:13.5px;color:#7a5800;
  }
  .check-row input[type=checkbox]{width:18px;height:18px;margin-top:2px;accent-color:var(--red);flex-shrink:0;}
  .submit-btn{
    width:100%;padding:17px;font-size:16px;font-weight:800;font-family:var(--gothic);
    background:linear-gradient(var(--red),var(--red-2));color:#fff;
    border:none;border-radius:10px;cursor:pointer;margin-top:18px;
    letter-spacing:.18em;transition:transform .12s,box-shadow .15s;
    box-shadow:0 8px 22px -8px rgba(192,21,38,.55);
  }
  .submit-btn:hover{transform:translateY(-2px);box-shadow:0 12px 28px -8px rgba(192,21,38,.7);}
  .submit-btn:disabled{background:#b9ad9c;cursor:not-allowed;transform:none;box-shadow:none;}
  @keyframes ttSpin{to{transform:rotate(360deg)}}
  .btn-spinner{display:inline-block;width:1.2em;height:1.2em;vertical-align:-.15em;
    border:2.4px solid currentColor;border-right-color:transparent;border-radius:50%;
    animation:ttSpin .7s linear infinite;}
  .msg{padding:16px;margin:14px 0;border-radius:9px;text-align:center;
    font-weight:800;font-size:15px;font-family:var(--gothic);}
  .msg.ok{background:var(--green-bg);color:var(--green);border:1px solid #aee3c2;}
  .msg.err{background:#fbeaea;color:#8c1118;border:1px solid #f0b9bb;}
  .success-card{
    margin:18px 0;padding:22px;
    background:linear-gradient(150deg,var(--green-bg) 0%,#eafaf0 100%);
    border:2px solid var(--green);border-radius:13px;
    animation:ttRise .4s ease both;
  }
  .success-card h3{font-family:var(--mincho);font-size:20px;color:var(--green);
    margin-bottom:10px;text-align:center;}
  .summary-pre{
    background:#fff;padding:14px;border-radius:8px;font-size:12px;
    line-height:1.8;white-space:pre-wrap;word-break:break-word;
    font-family:var(--gothic);margin:12px 0;max-height:200px;overflow-y:auto;
    border:1px solid #c9ecd6;
  }
  .copy-btn{
    width:100%;padding:12px;border-radius:9px;background:var(--green);
    color:#fff;border:none;cursor:pointer;font-size:14px;font-weight:800;
    font-family:inherit;transition:filter .15s;
  }
  .copy-btn:hover{filter:brightness(1.07);}
  .ffoot{text-align:center;margin-top:24px;padding:18px;color:var(--ink-2);font-size:11px;}
  .ffoot .org{font-family:var(--mincho);font-size:13px;font-weight:700;color:var(--ink);
    margin-bottom:4px;letter-spacing:.12em;}
  @media(max-width:640px){
    body{padding:14px 8px 42px;font-size:15px;}
    .fhd{padding:22px 16px 20px;}
    .fhd h1{font-size:22px;}
    .fsec{padding:18px 14px;}
    .frow{grid-template-columns:1fr;}
    .eg.g2,.eg.g3,.eg.g4{grid-template-columns:1fr;}
    .total-box .t-amount{font-size:28px;}
  }
`;

// ─── 共有クライアント JS ─────────────────────────────────
// 動的 DOM 操作はすべて安全な DOM メソッドのみ使用。innerHTML への変数代入は行わない。
const _COMMON_JS = `
function removeRow(btn){ btn.closest('.entry-row').remove(); recalcTotal(); }

function recalcTotal(){
  var total=0,sc=0,dc=0;
  document.querySelectorAll('.singles-row').forEach(function(r){
    var n=r.querySelector('[data-field="name"]');
    if(n&&n.value.trim()){sc++;total+=SINGLES_FEE;}
  });
  document.querySelectorAll('.doubles-row').forEach(function(r){
    var n1=r.querySelector('[data-field="name1"]'),n2=r.querySelector('[data-field="name2"]');
    if((n1&&n1.value.trim())||(n2&&n2.value.trim())){dc++;total+=DOUBLES_FEE;}
  });
  var el=document.getElementById('totalAmount');
  if(el) el.textContent=total.toLocaleString('ja-JP');
  var sc_el=document.getElementById('singlesCount');
  if(sc_el) sc_el.textContent=sc+' 名';
  var dc_el=document.getElementById('doublesCount');
  if(dc_el) dc_el.textContent=dc+' 組';
  return{singles:sc,doubles:dc,total:total};
}

function updateCombinedAge(row){
  var a1=parseInt((row.querySelector('[data-field="age1"]')||{}).value)||0;
  var a2=parseInt((row.querySelector('[data-field="age2"]')||{}).value)||0;
  var el=row.querySelector('.combined-age-val');
  if(el) el.textContent=(a1+a2>0)?(a1+a2)+'歳':'—';
}

function _clr(el){ while(el.firstChild) el.removeChild(el.firstChild); }

function showMsg(text,type){
  var box=document.getElementById('msgBox');
  _clr(box);
  var div=document.createElement('div');
  div.className='msg '+(['ok','err'].indexOf(type)>=0?type:'err');
  div.textContent=text;
  box.appendChild(div);
  box.scrollIntoView({behavior:'smooth',block:'center'});
  if(type==='ok') setTimeout(function(){_clr(box);},10000);
}

function showSuccess(summary){
  document.getElementById('mainForm').style.display='none';
  var box=document.getElementById('msgBox');
  _clr(box);
  var card=document.createElement('div'); card.className='success-card';
  var h3=document.createElement('h3'); h3.textContent='申込を受け付けました';
  card.appendChild(h3);
  var p=document.createElement('p');
  p.style.cssText='text-align:center;font-size:13px;color:#14532d;';
  p.textContent='お申込みありがとうございます。担当者へ通知メールを送信しました。';
  card.appendChild(p);
  var pre=document.createElement('div'); pre.className='summary-pre'; pre.id='summaryPre';
  pre.textContent=summary;
  card.appendChild(pre);
  var btn=document.createElement('button'); btn.type='button'; btn.className='copy-btn'; btn.id='copyBtn';
  btn.textContent='クリップボードにコピー';
  btn.addEventListener('click',function(){
    var self=this;
    if(navigator.clipboard){
      navigator.clipboard.writeText(summary).then(function(){
        self.textContent='コピーしました ✓';
        setTimeout(function(){self.textContent='クリップボードにコピー';},2500);
      }).catch(function(){_legacyCopy(summary,self);});
    }else{ _legacyCopy(summary,self); }
  });
  card.appendChild(btn);
  box.appendChild(card);
  box.scrollIntoView({behavior:'smooth',block:'start'});
}

function _legacyCopy(text,btn){
  var ta=document.createElement('textarea');
  ta.value=text; document.body.appendChild(ta); ta.select();
  try{document.execCommand('copy');}catch(e){}
  ta.remove();
  btn.textContent='コピーしました ✓';
  setTimeout(function(){btn.textContent='クリップボードにコピー';},2500);
}

function submitForm(e){
  e.preventDefault();
  var data=gatherData();
  if(!data) return false;
  var btn=document.getElementById('submitBtn');
  btn.disabled=true;
  btn.classList.add('is-sending');
  btn.textContent='';
  var sp=document.createElement('span'); sp.className='btn-spinner'; btn.appendChild(sp);
  var ctrl=(typeof AbortController!=='undefined')?new AbortController():null;
  var timer=ctrl?setTimeout(function(){ctrl.abort();},25000):null;
  fetch(GAS_URL,{
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body:JSON.stringify(data),
    signal:ctrl?ctrl.signal:undefined,
  }).then(function(resp){
    if(timer) clearTimeout(timer);
    return resp.text().then(function(txt){
      var result;
      try{result=JSON.parse(txt);}catch(_){result={ok:resp.ok};}
      if(result.ok||resp.ok){ showSuccess(buildSummary(data)); }
      else{ showMsg('送信できませんでした: '+(result.error||('サーバー応答 '+resp.status)),'err'); }
    });
  }).catch(function(err){
    if(timer) clearTimeout(timer);
    var aborted=err&&err.name==='AbortError';
    showMsg(aborted?'通信タイムアウト。もう一度送信してください。':'送信できませんでした。通信環境をご確認ください。','err');
  }).finally(function(){
    btn.disabled=false;
    btn.classList.remove('is-sending');
    btn.textContent='申込内容を送信';
  });
  return false;
}
`;

// ═══════════════════════════════════════════
// 1. 北海道選手権 マスターズ申込フォーム
// ═══════════════════════════════════════════

function buildMasters2026FormHTML(opts) {
  opts = opts || {};
  const gasUrl = escapeJs(opts.gas_url || '');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>2026北海道選手権（マスターズの部）参加申込</title>
<style>${_CSS}</style>
</head>
<body>

<!-- テンプレート: シングルス行 (cloneNode で複製。innerHTML への変数代入なし) -->
<template id="singlesTpl">
  <div class="entry-row singles-row">
    <div class="row-head">
      <span class="row-num">1</span>
      <button type="button" class="btn-del" onclick="removeRow(this)">削除</button>
    </div>
    <div class="eg g2" style="margin-bottom:8px;">
      <div>
        <label>性別</label>
        <select data-field="gender" onchange="recalcTotal()">
          <option value="male">男子</option>
          <option value="female">女子</option>
        </select>
      </div>
      <div>
        <label>カテゴリ</label>
        <select data-field="category" onchange="recalcTotal()">
          <option value="forty" data-label="フォーティ">フォーティ（40〜49歳）</option>
          <option value="fifty" data-label="フィフティ以上">フィフティ以上（50歳〜）</option>
        </select>
      </div>
    </div>
    <div class="eg" style="grid-template-columns:1fr 1.2fr 0.8fr 1.3fr 1.3fr 1fr;">
      <div>
        <label>ふりがな</label>
        <input type="text" data-field="furigana" placeholder="たなか いちろう" oninput="recalcTotal()">
      </div>
      <div>
        <label>氏名 <span class="req">必須</span></label>
        <input type="text" data-field="name" placeholder="田中 一郎" oninput="recalcTotal()">
      </div>
      <div>
        <label>年齢</label>
        <input type="number" data-field="age" min="40" max="120" placeholder="45" oninput="recalcTotal()">
      </div>
      <div>
        <label>生年月日</label>
        <input type="date" data-field="birthdate" oninput="recalcTotal()">
      </div>
      <div>
        <label>所属チーム</label>
        <input type="text" data-field="team" placeholder="○○クラブ" oninput="recalcTotal()">
      </div>
      <div>
        <label>参考</label>
        <input type="text" data-field="note" placeholder="" oninput="recalcTotal()">
      </div>
    </div>
  </div>
</template>

<!-- テンプレート: ダブルス行 -->
<template id="doublesTpl">
  <div class="entry-row doubles-row">
    <div class="row-head">
      <span class="row-num">1</span>
      <button type="button" class="btn-del" onclick="removeRow(this)">削除</button>
    </div>
    <div class="eg g2" style="margin-bottom:10px;">
      <div>
        <label>カテゴリ（2名の年齢合計）</label>
        <select data-field="category" onchange="recalcTotal()">
          <option value="under_129" data-label="129歳以下">129歳以下</option>
          <option value="over_130" data-label="130歳以上">130歳以上</option>
        </select>
      </div>
      <div class="combined-age-wrap">
        合計年齢: <span class="combined-age-val">—</span>
      </div>
    </div>
    <div class="pair-sep">選手A</div>
    <div class="eg" style="grid-template-columns:1fr 1.2fr 0.8fr 1.3fr 1.3fr;">
      <div>
        <label>ふりがな</label>
        <input type="text" data-field="furigana1" placeholder="よみがな" oninput="recalcTotal()">
      </div>
      <div>
        <label>氏名 <span class="req">必須</span></label>
        <input type="text" data-field="name1" placeholder="田中 一郎" oninput="recalcTotal()">
      </div>
      <div>
        <label>年齢</label>
        <input type="number" data-field="age1" min="40" max="120" placeholder="45"
          oninput="updateCombinedAge(this.closest('.entry-row'));recalcTotal()">
      </div>
      <div>
        <label>生年月日</label>
        <input type="date" data-field="birthdate1">
      </div>
      <div>
        <label>所属チーム</label>
        <input type="text" data-field="team1" placeholder="○○クラブ">
      </div>
    </div>
    <div class="pair-sep">選手B</div>
    <div class="eg" style="grid-template-columns:1fr 1.2fr 0.8fr 1.3fr 1.3fr;">
      <div>
        <label>ふりがな</label>
        <input type="text" data-field="furigana2" placeholder="よみがな" oninput="recalcTotal()">
      </div>
      <div>
        <label>氏名 <span class="req">必須</span></label>
        <input type="text" data-field="name2" placeholder="鈴木 二郎" oninput="recalcTotal()">
      </div>
      <div>
        <label>年齢</label>
        <input type="number" data-field="age2" min="40" max="120" placeholder="43"
          oninput="updateCombinedAge(this.closest('.entry-row'));recalcTotal()">
      </div>
      <div>
        <label>生年月日</label>
        <input type="date" data-field="birthdate2">
      </div>
      <div>
        <label>所属チーム</label>
        <input type="text" data-field="team2" placeholder="△△クラブ">
      </div>
    </div>
  </div>
</template>

<div class="fhd">
  <h1><span class="seal">参加申込</span>2026北海道選手権（マスターズの部）</h1>
  <div class="meta">開催日: 2026年 &nbsp;·&nbsp; 主催: 北海道卓球連盟</div>
</div>

<form id="mainForm" onsubmit="return submitForm(event)">

<div class="fsec">
  <h2>申込支部・責任者</h2>
  <div class="frow three">
    <div>
      <label>支部名 <span class="req">必須</span></label>
      <input type="text" id="branch_name" required placeholder="例: 釧路支部">
    </div>
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
  <h2>シングルス申込 <span class="count-badge" id="singlesCount">0&nbsp;名</span></h2>
  <div class="fee-note">1名 ¥2,000（参加料は試合当日払い）</div>
  <div class="notice">
    ・男女 / カテゴリをそれぞれ選択してください。<br>
    ・フォーティ: 40〜49歳 &nbsp;／&nbsp; フィフティ以上: 50歳以上（2027年4月1日時点）
  </div>
  <div id="singlesContainer"></div>
  <div class="add-btns">
    <button type="button" class="btn-add" onclick="addSingles()">＋ 選手を1名追加</button>
    <button type="button" class="btn-add" onclick="addSinglesN(5)"
      style="border-style:solid;border-color:#e0b75a;background:var(--amber-bg);">＋ 5名を一括追加</button>
  </div>
</div>

<div class="fsec">
  <h2>ダブルス申込 <span class="count-badge" id="doublesCount">0&nbsp;組</span></h2>
  <div class="fee-note">1組 ¥2,400（参加料は試合当日払い）</div>
  <div class="notice">
    ・129歳以下: 2名の年齢合計が129歳以下 &nbsp;／&nbsp; 130歳以上: 2名の年齢合計が130歳以上<br>
    ・男女の別を問わず出場可（混合も可）
  </div>
  <div id="doublesContainer"></div>
  <div class="add-btns">
    <button type="button" class="btn-add" onclick="addDoubles()">＋ ペアを1組追加</button>
  </div>
</div>

<div class="fsec">
  <h2>合計・確認</h2>
  <div class="total-box">
    <div class="t-label">参加料合計</div>
    <div class="t-amount">¥&thinsp;<span id="totalAmount">0</span></div>
  </div>
  <div class="check-row">
    <input type="checkbox" id="has_over90">
    <label for="has_over90">
      <strong>90歳以上の選手が含まれます。</strong><br>
      同意書（別紙「2026選手権マスターズ90歳代同意書」）を大会事務局へ別途提出します。
    </label>
  </div>
  <div class="frow full" style="margin-top:12px;">
    <div>
      <label>備考・連絡事項</label>
      <textarea id="note" rows="3" placeholder="連絡事項があればご記入ください"
        style="width:100%;padding:10px 13px;border:1.5px solid var(--line);border-radius:8px;font-family:inherit;font-size:15px;background:var(--card-2);resize:vertical;"></textarea>
    </div>
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
var GAS_URL = '${gasUrl}';
var SINGLES_FEE = 2000;
var DOUBLES_FEE = 2400;
var FORM_TYPE   = 'masters_2026';
var FORM_NAME   = '2026北海道選手権（マスターズの部）参加申込';

function addSingles(){
  var container = document.getElementById('singlesContainer');
  var tpl = document.getElementById('singlesTpl');
  var frag = document.importNode(tpl.content, true);
  var row = frag.querySelector('.entry-row');
  row.querySelector('.row-num').textContent = String(container.children.length + 1);
  container.appendChild(frag);
  recalcTotal();
}
function addSinglesN(n){ for(var i=0;i<n;i++) addSingles(); }

function addDoubles(){
  var container = document.getElementById('doublesContainer');
  var tpl = document.getElementById('doublesTpl');
  var frag = document.importNode(tpl.content, true);
  var row = frag.querySelector('.entry-row');
  row.querySelector('.row-num').textContent = String(container.children.length + 1);
  container.appendChild(frag);
  recalcTotal();
}

function gatherData(){
  var branch  = (document.getElementById('branch_name').value||'').trim();
  var cname   = (document.getElementById('contact_name').value||'').trim();
  var ctel    = (document.getElementById('contact_tel').value||'').trim();
  if(!branch||!cname||!ctel){
    showMsg('支部名・責任者・電話番号は必須です。','err'); return null;
  }
  var singles=[], doubles=[];
  document.querySelectorAll('.singles-row').forEach(function(row){
    var name = (row.querySelector('[data-field="name"]').value||'').trim();
    if(!name) return;
    var gSel   = row.querySelector('[data-field="gender"]');
    var catSel = row.querySelector('[data-field="category"]');
    var catOpt = catSel.options[catSel.selectedIndex];
    singles.push({
      gender:         gSel.value,
      gender_label:   gSel.options[gSel.selectedIndex].text.split('（')[0].trim(),
      category:       catSel.value,
      category_label: catOpt.dataset.label||catSel.value,
      furigana:       (row.querySelector('[data-field="furigana"]').value||'').trim(),
      name:           name,
      age:            parseInt(row.querySelector('[data-field="age"]').value)||'',
      birthdate:      row.querySelector('[data-field="birthdate"]').value||'',
      team:           (row.querySelector('[data-field="team"]').value||'').trim(),
      note:           (row.querySelector('[data-field="note"]').value||'').trim(),
      fee:            SINGLES_FEE,
    });
  });
  document.querySelectorAll('.doubles-row').forEach(function(row){
    var name1 = (row.querySelector('[data-field="name1"]').value||'').trim();
    var name2 = (row.querySelector('[data-field="name2"]').value||'').trim();
    if(!name1&&!name2) return;
    var age1 = parseInt(row.querySelector('[data-field="age1"]').value)||0;
    var age2 = parseInt(row.querySelector('[data-field="age2"]').value)||0;
    var catSel = row.querySelector('[data-field="category"]');
    var catOpt = catSel.options[catSel.selectedIndex];
    doubles.push({
      category:       catSel.value,
      category_label: catOpt.dataset.label||catSel.value,
      furigana1:      (row.querySelector('[data-field="furigana1"]').value||'').trim(),
      name1: name1, age1: age1||'',
      birthdate1:     row.querySelector('[data-field="birthdate1"]').value||'',
      team1:          (row.querySelector('[data-field="team1"]').value||'').trim(),
      furigana2:      (row.querySelector('[data-field="furigana2"]').value||'').trim(),
      name2: name2, age2: age2||'',
      birthdate2:     row.querySelector('[data-field="birthdate2"]').value||'',
      team2:          (row.querySelector('[data-field="team2"]').value||'').trim(),
      combined_age:   age1+age2||'',
      fee: DOUBLES_FEE,
    });
  });
  if(!singles.length&&!doubles.length){
    showMsg('少なくとも1名（シングルス）または1組（ダブルス）を入力してください。','err');
    return null;
  }
  return {
    form_type: FORM_TYPE, form_name: FORM_NAME,
    branch_name: branch, contact_name: cname, contact_tel: ctel,
    has_over90: document.getElementById('has_over90').checked,
    note: (document.getElementById('note').value||'').trim(),
    singles: singles, doubles: doubles,
    total_amount: singles.length*SINGLES_FEE + doubles.length*DOUBLES_FEE,
    submitted_at: new Date().toISOString(),
  };
}

function buildSummary(data){
  var ls=[];
  ls.push('「'+FORM_NAME+'」');
  ls.push('支部: '+data.branch_name+' / 責任者: '+data.contact_name+' / 連絡先: '+data.contact_tel);
  if(data.has_over90) ls.push('※ 90歳以上選手あり（同意書別途提出）');
  ls.push('');
  if(data.singles.length){
    ls.push('■ シングルス（'+data.singles.length+'名）');
    data.singles.forEach(function(s,i){
      ls.push('  '+(i+1)+'. ['+(s.gender_label)+' '+(s.category_label)+'] '+(s.furigana?s.furigana+' ':'')+s.name+(s.age?'('+s.age+'歳)':'')+(s.team?' / '+s.team:''));
    });
  }
  if(data.doubles.length){
    ls.push('');
    ls.push('■ ダブルス（'+data.doubles.length+'組）');
    data.doubles.forEach(function(d,i){
      ls.push('  '+(i+1)+'. ['+d.category_label+'] '+d.name1+'('+d.age1+'歳) / '+d.name2+'('+d.age2+'歳) 合計'+d.combined_age+'歳');
    });
  }
  ls.push('');
  ls.push('合計: ¥'+data.total_amount.toLocaleString('ja-JP'));
  return ls.join('\n');
}

${_COMMON_JS}

// 初期1行
addSingles();
addDoubles();
</script>
</body>
</html>`;
}


// ═══════════════════════════════════════════
// 共通: ラージボール系フォーム生成
// ═══════════════════════════════════════════

function _singlesCatOpts() {
  return [
    '<option value="一般" data-label="シングルス一般">一般（年齢制限無し）</option>',
    '<option value="40"  data-label="シングルス40">40（40歳以上）</option>',
    '<option value="50"  data-label="シングルス50">50（50歳以上）</option>',
    '<option value="60"  data-label="シングルス60">60（60歳以上）</option>',
    '<option value="65"  data-label="シングルス65">65（65歳以上）</option>',
    '<option value="70"  data-label="シングルス70">70（70歳以上）</option>',
    '<option value="75"  data-label="シングルス75">75（75歳以上）</option>',
    '<option value="80"  data-label="シングルス80">80（80歳以上）</option>',
    '<option value="85"  data-label="シングルス85">85（85歳以上）</option>',
  ].join('\n          ');
}

function _doublesCatOpts() {
  return [
    '<option value="一般" data-label="混合ダブルス一般">一般（年齢制限無し）</option>',
    '<option value="80"  data-label="混合ダブルス80">混80（80歳以上）</option>',
    '<option value="100" data-label="混合ダブルス100">混100（100歳以上）</option>',
    '<option value="120" data-label="混合ダブルス120">混120（120歳以上）</option>',
    '<option value="130" data-label="混合ダブルス130">混130（130歳以上）</option>',
    '<option value="140" data-label="混合ダブルス140">混140（140歳以上）</option>',
    '<option value="150" data-label="混合ダブルス150">混150（150歳以上）</option>',
    '<option value="160" data-label="混合ダブルス160">混160（160歳以上）</option>',
  ].join('\n          ');
}

function _buildLargeballFormHTML(cfg, gasUrl) {
  const title       = escapeHtml(cfg.title);
  const subtitle    = escapeHtml(cfg.subtitle);
  const formTypeJs  = escapeJs(cfg.form_type);
  const formNameJs  = escapeJs(cfg.form_name);
  const gasUrlJs    = escapeJs(gasUrl);
  const sCatOpts    = _singlesCatOpts();
  const dCatOpts    = _doublesCatOpts();

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} 参加申込</title>
<style>${_CSS}</style>
</head>
<body>

<!-- テンプレート: シングルス行 -->
<template id="singlesTpl">
  <div class="entry-row singles-row">
    <div class="row-head">
      <span class="row-num">1</span>
      <button type="button" class="btn-del" onclick="removeRow(this)">削除</button>
    </div>
    <div class="eg g2" style="margin-bottom:8px;">
      <div>
        <label>性別</label>
        <select data-field="gender" onchange="recalcTotal()">
          <option value="male">男子</option>
          <option value="female">女子</option>
        </select>
      </div>
      <div>
        <label>カテゴリ（年齢区分）</label>
        <select data-field="category" onchange="recalcTotal()">
          ${sCatOpts}
        </select>
      </div>
    </div>
    <div class="eg" style="grid-template-columns:2fr 1fr 2fr 2fr;">
      <div>
        <label>氏名 <span class="req">必須</span></label>
        <input type="text" data-field="name" placeholder="田中 一郎" oninput="recalcTotal()">
      </div>
      <div>
        <label>年齢</label>
        <input type="number" data-field="age" min="1" max="120" placeholder="62" oninput="recalcTotal()">
      </div>
      <div>
        <label>所属支部</label>
        <input type="text" data-field="branch" placeholder="釧路支部" oninput="recalcTotal()">
      </div>
      <div>
        <label>所属チーム</label>
        <input type="text" data-field="team" placeholder="○○クラブ" oninput="recalcTotal()">
      </div>
    </div>
  </div>
</template>

<!-- テンプレート: 混合ダブルス行 -->
<template id="doublesTpl">
  <div class="entry-row doubles-row">
    <div class="row-head">
      <span class="row-num">1</span>
      <button type="button" class="btn-del" onclick="removeRow(this)">削除</button>
    </div>
    <div class="eg g2" style="margin-bottom:10px;">
      <div>
        <label>カテゴリ（合計年齢）</label>
        <select data-field="category" onchange="recalcTotal()">
          ${dCatOpts}
        </select>
      </div>
      <div class="combined-age-wrap">
        2名の合計年齢: <span class="combined-age-val">—</span>
      </div>
    </div>
    <div class="pair-sep">男子選手</div>
    <div class="eg" style="grid-template-columns:2fr 1fr 2fr 2fr;">
      <div>
        <label>氏名 <span class="req">必須</span></label>
        <input type="text" data-field="name1" placeholder="田中 一郎" oninput="recalcTotal()">
      </div>
      <div>
        <label>年齢</label>
        <input type="number" data-field="age1" min="1" max="120" placeholder="62"
          oninput="updateCombinedAge(this.closest('.entry-row'));recalcTotal()">
      </div>
      <div>
        <label>所属支部</label>
        <input type="text" data-field="branch1" placeholder="釧路支部">
      </div>
      <div>
        <label>所属チーム</label>
        <input type="text" data-field="team1" placeholder="○○クラブ">
      </div>
    </div>
    <div class="pair-sep">女子選手</div>
    <div class="eg" style="grid-template-columns:2fr 1fr 2fr 2fr;">
      <div>
        <label>氏名 <span class="req">必須</span></label>
        <input type="text" data-field="name2" placeholder="佐藤 花子" oninput="recalcTotal()">
      </div>
      <div>
        <label>年齢</label>
        <input type="number" data-field="age2" min="1" max="120" placeholder="58"
          oninput="updateCombinedAge(this.closest('.entry-row'));recalcTotal()">
      </div>
      <div>
        <label>所属支部</label>
        <input type="text" data-field="branch2" placeholder="釧路支部">
      </div>
      <div>
        <label>所属チーム</label>
        <input type="text" data-field="team2" placeholder="△△クラブ">
      </div>
    </div>
  </div>
</template>

<div class="fhd">
  <h1><span class="seal">参加申込</span>${title}</h1>
  <div class="meta">${subtitle}</div>
</div>

<form id="mainForm" onsubmit="return submitForm(event)">

<div class="fsec">
  <h2>申込支部・責任者</h2>
  <div class="frow three">
    <div>
      <label>申込支部名 <span class="req">必須</span></label>
      <input type="text" id="branch_name" required placeholder="例: 釧路支部">
    </div>
    <div>
      <label>申込責任者 <span class="req">必須</span></label>
      <input type="text" id="contact_name" required placeholder="山田 太郎">
    </div>
    <div>
      <label>連絡先電話番号 <span class="req">必須</span></label>
      <input type="tel" id="contact_tel" required placeholder="0154-XX-XXXX">
    </div>
  </div>
</div>

<div class="fsec">
  <h2>シングルス申込 <span class="count-badge" id="singlesCount">0&nbsp;名</span></h2>
  <div class="fee-note">1名 ¥2,000（参加料は試合当日払い）</div>
  <div class="notice">
    ・性別・カテゴリ（年齢区分）をそれぞれ選択してください。<br>
    ・年齢は2027年4月1日時点の年齢。シングルスと混合ダブルスの両種目に出場可能です。<br>
    ・選手名・支部・所属チーム名は登録名を正確にご記入ください。
  </div>
  <div id="singlesContainer"></div>
  <div class="add-btns">
    <button type="button" class="btn-add" onclick="addSingles()">＋ 選手を1名追加</button>
    <button type="button" class="btn-add" onclick="addSinglesN(5)"
      style="border-style:solid;border-color:#e0b75a;background:var(--amber-bg);">＋ 5名を一括追加</button>
  </div>
</div>

<div class="fsec">
  <h2>混合ダブルス申込 <span class="count-badge" id="doublesCount">0&nbsp;組</span></h2>
  <div class="fee-note">1組 ¥2,400（参加料は試合当日払い）</div>
  <div class="notice">
    ・カテゴリは2名の年齢合計で選択してください。<br>
    ・支部をまたいでペアを組む場合は、所属支部・チーム名の間違いに充分ご注意ください。
  </div>
  <div id="doublesContainer"></div>
  <div class="add-btns">
    <button type="button" class="btn-add" onclick="addDoubles()">＋ ペアを1組追加</button>
  </div>
</div>

<div class="fsec">
  <h2>合計・確認</h2>
  <div class="total-box">
    <div class="t-label">参加料合計</div>
    <div class="t-amount">¥&thinsp;<span id="totalAmount">0</span></div>
  </div>
  <div class="frow full" style="margin-top:12px;">
    <div>
      <label>備考・連絡事項</label>
      <textarea id="note" rows="3" placeholder="連絡事項があればご記入ください"
        style="width:100%;padding:10px 13px;border:1.5px solid var(--line);border-radius:8px;font-family:inherit;font-size:15px;background:var(--card-2);resize:vertical;"></textarea>
    </div>
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
var GAS_URL     = '${gasUrlJs}';
var SINGLES_FEE = 2000;
var DOUBLES_FEE = 2400;
var FORM_TYPE   = '${formTypeJs}';
var FORM_NAME   = '${formNameJs}';

function addSingles(){
  var container = document.getElementById('singlesContainer');
  var tpl = document.getElementById('singlesTpl');
  var frag = document.importNode(tpl.content, true);
  var row = frag.querySelector('.entry-row');
  row.querySelector('.row-num').textContent = String(container.children.length + 1);
  container.appendChild(frag);
  recalcTotal();
}
function addSinglesN(n){ for(var i=0;i<n;i++) addSingles(); }

function addDoubles(){
  var container = document.getElementById('doublesContainer');
  var tpl = document.getElementById('doublesTpl');
  var frag = document.importNode(tpl.content, true);
  var row = frag.querySelector('.entry-row');
  row.querySelector('.row-num').textContent = String(container.children.length + 1);
  container.appendChild(frag);
  recalcTotal();
}

function gatherData(){
  var branch = (document.getElementById('branch_name').value||'').trim();
  var cname  = (document.getElementById('contact_name').value||'').trim();
  var ctel   = (document.getElementById('contact_tel').value||'').trim();
  if(!branch||!cname||!ctel){
    showMsg('申込支部名・申込責任者・連絡先は必須です。','err'); return null;
  }
  var singles=[], doubles=[];
  document.querySelectorAll('.singles-row').forEach(function(row){
    var name = (row.querySelector('[data-field="name"]').value||'').trim();
    if(!name) return;
    var gSel   = row.querySelector('[data-field="gender"]');
    var catSel = row.querySelector('[data-field="category"]');
    var catOpt = catSel.options[catSel.selectedIndex];
    singles.push({
      gender:         gSel.value,
      gender_label:   gSel.options[gSel.selectedIndex].text,
      category:       catSel.value,
      category_label: catOpt.dataset.label||catSel.value,
      name:           name,
      age:            parseInt(row.querySelector('[data-field="age"]').value)||'',
      branch:         (row.querySelector('[data-field="branch"]').value||'').trim(),
      team:           (row.querySelector('[data-field="team"]').value||'').trim(),
      fee:            SINGLES_FEE,
    });
  });
  document.querySelectorAll('.doubles-row').forEach(function(row){
    var name1 = (row.querySelector('[data-field="name1"]').value||'').trim();
    var name2 = (row.querySelector('[data-field="name2"]').value||'').trim();
    if(!name1&&!name2) return;
    var age1 = parseInt(row.querySelector('[data-field="age1"]').value)||0;
    var age2 = parseInt(row.querySelector('[data-field="age2"]').value)||0;
    var catSel = row.querySelector('[data-field="category"]');
    var catOpt = catSel.options[catSel.selectedIndex];
    doubles.push({
      category:       catSel.value,
      category_label: catOpt.dataset.label||catSel.value,
      name1: name1, age1: age1||'',
      branch1: (row.querySelector('[data-field="branch1"]').value||'').trim(),
      team1:   (row.querySelector('[data-field="team1"]').value||'').trim(),
      name2: name2, age2: age2||'',
      branch2: (row.querySelector('[data-field="branch2"]').value||'').trim(),
      team2:   (row.querySelector('[data-field="team2"]').value||'').trim(),
      combined_age: age1+age2||'',
      fee: DOUBLES_FEE,
    });
  });
  if(!singles.length&&!doubles.length){
    showMsg('少なくとも1名（シングルス）または1組（混合ダブルス）を入力してください。','err');
    return null;
  }
  return{
    form_type: FORM_TYPE, form_name: FORM_NAME,
    branch_name: branch, contact_name: cname, contact_tel: ctel,
    note: (document.getElementById('note').value||'').trim(),
    singles: singles, doubles: doubles,
    total_amount: singles.length*SINGLES_FEE + doubles.length*DOUBLES_FEE,
    submitted_at: new Date().toISOString(),
  };
}

function buildSummary(data){
  var ls=[];
  ls.push('「'+FORM_NAME+'」');
  ls.push('申込支部: '+data.branch_name+' / 責任者: '+data.contact_name+' / 連絡先: '+data.contact_tel);
  ls.push('');
  if(data.singles.length){
    ls.push('■ シングルス（'+data.singles.length+'名）');
    data.singles.forEach(function(s,i){
      ls.push('  '+(i+1)+'. ['+s.gender_label+' '+s.category_label+'] '+s.name+(s.age?'('+s.age+'歳)':'')+(s.branch?' / '+s.branch:'')+(s.team?' / '+s.team:''));
    });
  }
  if(data.doubles.length){
    ls.push('');
    ls.push('■ 混合ダブルス（'+data.doubles.length+'組）');
    data.doubles.forEach(function(d,i){
      ls.push('  '+(i+1)+'. ['+d.category_label+'] '+d.name1+'('+d.age1+'歳) / '+d.name2+'('+d.age2+'歳) 合計'+d.combined_age+'歳');
      if(d.team1||d.team2){
        ls.push('       '+[d.branch1,d.team1].filter(Boolean).join(' ')+' / '+[d.branch2,d.team2].filter(Boolean).join(' '));
      }
    });
  }
  ls.push('');
  ls.push('合計: ¥'+data.total_amount.toLocaleString('ja-JP')+'（試合当日払い）');
  return ls.join('\n');
}

${_COMMON_JS}

// 初期1行
addSingles();
addDoubles();
</script>
</body>
</html>`;
}


// ═══════════════════════════════════════════
// 2. 全国ラージボール 北海道予選 申込フォーム
// ═══════════════════════════════════════════

function buildLargeballNational2026FormHTML(opts) {
  opts = opts || {};
  return _buildLargeballFormHTML({
    title:     '第39回 全国ラージボール卓球大会 北海道予選会',
    subtitle:  '2026年7月26日（日）· 申込締切: 2026年7月3日（金）',
    form_type: 'largeball_national_2026',
    form_name: '第39回全国ラージボール卓球大会 北海道予選',
  }, opts.gas_url || '');
}


// ═══════════════════════════════════════════
// 3. 全日本ラージボール選手権 北海道予選 申込フォーム
// ═══════════════════════════════════════════

function buildLargeballAllJapan2026FormHTML(opts) {
  opts = opts || {};
  return _buildLargeballFormHTML({
    title:     '第9回 全日本ラージボール卓球選手権大会 北海道予選会',
    subtitle:  '2026年7月26日（日）· 申込締切: 2026年7月3日（金）',
    form_type: 'largeball_alljapan_2026',
    form_name: '第9回全日本ラージボール卓球選手権大会 北海道予選',
  }, opts.gas_url || '');
}


module.exports = {
  buildMasters2026FormHTML,
  buildLargeballNational2026FormHTML,
  buildLargeballAllJapan2026FormHTML,
};
