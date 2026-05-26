// ═══════════════════════════════════════════════════════
// 申込フォーム HTML 生成
// Jimdo などのノーコードサイトの「HTML埋め込み」ブロックに貼れる
// 完全スタンドアロン (CDN不要、外部依存なし)
// ═══════════════════════════════════════════════════════

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeJs(s) {
  return JSON.stringify(String(s == null ? "" : s));
}

/**
 * 大会の申込フォーム HTML を生成。
 *
 * @param {Object} tournament - 大会オブジェクト (DB getTournament)
 * @param {Array} events - 種目リスト [{name, fee, type, gender, category}, ...]
 * @param {Object} opts -
 *   gas_url: GAS Web App の URL (フォーム POST 先)
 *   admin_email: 主催者メールアドレス
 *   notes: 申込フォーム下部の注意事項
 *   deadline: 申込締切日 (表示用)
 *   payment_note: 支払方法の説明
 */
function buildEntryFormHTML(tournament, events, opts) {
  opts = opts || {};
  const gasUrl = opts.gas_url || "REPLACE_WITH_GAS_WEB_APP_URL";
  const adminEmail = opts.admin_email || "";
  const deadline = opts.deadline || "";
  const paymentNote = opts.payment_note ||
    "参加料は、大会当日の開会式前に受付でお支払いください。";
  const notes = opts.notes || "";

  // events は [{ name, fee, type, ... }, ...]
  // 種目を「個人戦 / 団体戦」「ダブルス」に分類してフォーム要素を作る
  const teamEvents = events.filter(e => e.type === "team");
  const singlesEvents = events.filter(e => e.type === "singles");
  const doublesEvents = events.filter(e => e.type === "doubles");

  const tournName = escapeHtml(tournament.name || "");
  const tournDate = tournament.date
    ? new Date(tournament.date).toLocaleDateString("ja-JP",
        { year: "numeric", month: "long", day: "numeric", weekday: "short" })
    : "";

  // 各種目を JS データとして埋込
  const eventsJson = JSON.stringify(events.map(e => ({
    name: e.name,
    fee: e.fee || 0,
    type: e.type || "singles",
    note: e.note || "",
    per_team: e.per_team || 6,
  })));

  // タンチョウ+卓球 イラスト (インラインSVG・HTTPS依存なし)
  const TANCHO_SVG = `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="tcsky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fef3c7"/>
        <stop offset="1" stop-color="#fde68a"/>
      </linearGradient>
    </defs>
    <!-- 背景の朝焼け -->
    <ellipse cx="100" cy="105" rx="120" ry="40" fill="url(#tcsky)" opacity="0.6"/>
    <!-- 地平線 -->
    <line x1="20" y1="85" x2="180" y2="85" stroke="#a16207" stroke-width="0.8" opacity="0.45"/>
    <!-- タンチョウ (左) -->
    <g transform="translate(40 35)">
      <!-- 体 -->
      <ellipse cx="0" cy="20" rx="22" ry="11" fill="#fafafa" stroke="#27272a" stroke-width="1"/>
      <!-- 尾羽 -->
      <path d="M 20 18 L 32 14 L 32 25 Z" fill="#0f172a"/>
      <!-- 脚 -->
      <line x1="-8" y1="30" x2="-8" y2="48" stroke="#1f2937" stroke-width="1.4" stroke-linecap="round"/>
      <line x1="2"  y1="30" x2="2"  y2="48" stroke="#1f2937" stroke-width="1.4" stroke-linecap="round"/>
      <!-- 首 S字 -->
      <path d="M -10 17 Q -16 0, -8 -10 Q 0 -18, 8 -16"
            stroke="#27272a" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <!-- 頭 -->
      <circle cx="10" cy="-17" r="4" fill="#fafafa" stroke="#27272a" stroke-width="1"/>
      <!-- 頭頂の赤 -->
      <path d="M 8 -20 Q 10 -23, 12 -20 L 12 -17 L 8 -17 Z" fill="#dc2626"/>
      <!-- くちばし -->
      <path d="M 13 -17 L 19 -17 L 13 -15 Z" fill="#0c0a09"/>
      <!-- 目 -->
      <circle cx="10" cy="-17" r="0.6" fill="#09090b"/>
    </g>
    <!-- 卓球ボール (右上、ラリー軌道) -->
    <circle cx="150" cy="30" r="6" fill="#fafafa" stroke="#71717a" stroke-width="1"/>
    <circle cx="148" cy="28" r="1.4" fill="#dc2626" opacity="0.85"/>
    <!-- 軌跡 (タンチョウ→ボール) -->
    <path d="M 55 18 Q 100 -5, 150 30"
          stroke="#dc2626" stroke-width="1.2" fill="none"
          stroke-dasharray="2 3" opacity="0.5" stroke-linecap="round"/>
    <!-- ラケット -->
    <g transform="translate(135 50) rotate(-30)">
      <ellipse cx="0" cy="0" rx="8" ry="10" fill="#dc2626" stroke="#7f1d1d" stroke-width="1"/>
      <ellipse cx="0" cy="0" rx="5" ry="7" fill="#1f2937"/>
      <rect x="-2" y="9" width="4" height="11" fill="#92400e" rx="1"/>
    </g>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${tournName} 申込フォーム</title>
<style>
  /* システムフォントのみ使用 (HTTPS / Jimdo / STUDIO / CSP 準拠) */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'YuMincho',
                 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif;
    background: #ffffff;
    color: #1c1917;
    line-height: 1.7;
    padding: 18px 12px;
    max-width: 820px; margin: 0 auto;
  }
  .form-header {
    background: #fafafa;
    color: #1c1917;
    padding: 28px 32px 32px;
    border-radius: 14px 14px 0 0;
    border: 1px solid #e7e5e4;
    border-bottom: none;
    position: relative;
    overflow: hidden;
  }
  .form-header-art {
    position: absolute; right: -10px; top: -10px;
    width: 200px; height: 100px; opacity: 0.95;
    pointer-events: none;
  }
  .form-header-art svg { width: 100%; height: 100%; }
  .form-header h1 {
    font-family: 'Hiragino Mincho ProN', 'Yu Mincho', serif;
    font-size: 26px; font-weight: 700;
    margin-bottom: 8px; letter-spacing: 0.01em;
    position: relative; z-index: 1;
  }
  .form-header .seal {
    display: inline-block;
    background: #b91c1c; color: #fff;
    font-size: 10px; font-weight: 700;
    padding: 3px 9px; border-radius: 3px;
    margin-right: 8px;
    letter-spacing: 0.18em;
    vertical-align: middle;
  }
  .form-header .meta {
    font-size: 13px; color: #44403c;
    position: relative; z-index: 1;
  }
  .form-section {
    background: #fff;
    padding: 22px 26px;
    margin-bottom: 6px;
    border-left: 1px solid #e7e5e4;
    border-right: 1px solid #e7e5e4;
  }
  .form-section:last-of-type {
    border-radius: 0 0 14px 14px;
    border-bottom: 1px solid #e7e5e4;
    padding-bottom: 28px;
  }
  .form-section h2 {
    font-family: 'Hiragino Mincho ProN', 'Yu Mincho', serif;
    font-size: 17px; font-weight: 700;
    margin-bottom: 14px;
    padding-left: 14px;
    border-left: 4px solid #b91c1c;
    color: #1c1917;
  }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  .form-row.full { grid-template-columns: 1fr; }
  .form-row label {
    display: block; font-size: 12px; font-weight: 700;
    color: #57534e; margin-bottom: 5px;
    letter-spacing: 0.03em;
  }
  .form-row label .required {
    background: #b91c1c; color: #fff;
    font-size: 9px; padding: 1px 6px;
    border-radius: 2px; margin-left: 5px;
    letter-spacing: 0.08em;
  }
  .form-row input[type="text"],
  .form-row input[type="email"],
  .form-row input[type="tel"],
  .form-row input[type="number"],
  .form-row select,
  .form-row textarea {
    width: 100%; padding: 11px 13px;
    border: 1px solid #d6d3d1; border-radius: 6px;
    font-family: inherit; font-size: 14.5px;
    background: #fdfdfc;
    transition: all .15s;
  }
  .form-row input:focus, .form-row select:focus, .form-row textarea:focus {
    outline: none;
    border-color: #b91c1c;
    box-shadow: 0 0 0 3px rgba(185, 28, 28, .1);
    background: #fff;
  }
  .btn-add {
    background: #ffffff; color: #78350f;
    border: 1.5px dashed #d6d3d1;
    padding: 8px 16px; border-radius: 6px;
    cursor: pointer; font-size: 13px; font-weight: 600;
    font-family: inherit; transition: all .15s;
  }
  .btn-add:hover { background: #fef3c7; border-color: #92400e; }
  .btn-del {
    background: transparent; color: #b91c1c;
    border: 1px solid #fecaca; padding: 3px 10px;
    border-radius: 4px; cursor: pointer; font-size: 11px;
    font-weight: 600; font-family: inherit;
  }
  .btn-del:hover { background: #fef2f2; }
  .total-box {
    background: #ffffff;
    border: 2px solid #b45309;
    border-radius: 10px;
    padding: 18px 22px;
    margin: 18px 0;
    display: flex; justify-content: space-between; align-items: center;
    position: relative;
    overflow: hidden;
  }
  .total-box::before {
    content: ""; position: absolute;
    top: 0; right: 0;
    width: 70px; height: 70px;
    background: radial-gradient(circle, rgba(220,38,38,.07) 30%, transparent 70%);
  }
  .total-box .label {
    font-family: 'Hiragino Mincho ProN', serif;
    font-size: 15px; font-weight: 700; color: #78350f;
    letter-spacing: 0.04em;
  }
  .total-box .amount {
    font-family: 'Hiragino Mincho ProN', serif;
    font-size: 32px; font-weight: 700; color: #b91c1c;
    letter-spacing: 0.02em;
    position: relative; z-index: 1;
  }
  .submit-btn {
    width: 100%; padding: 17px;
    font-size: 16px; font-weight: 700;
    font-family: 'Hiragino Mincho ProN', serif;
    background: #b91c1c; color: #fff;
    border: none; border-radius: 8px;
    cursor: pointer; margin-top: 18px;
    letter-spacing: 0.18em;
    transition: all .15s;
    box-shadow: 0 2px 6px rgba(185, 28, 28, .25);
  }
  .submit-btn:hover { background: #991b1b; transform: translateY(-1px); }
  .submit-btn:disabled { background: #a8a29e; cursor: not-allowed; transform: none; }
  .notice {
    background: #ffffff;
    border-left: 3px solid #b45309;
    padding: 11px 16px; font-size: 12.5px; margin: 14px 0;
    border-radius: 0 6px 6px 0;
    color: #44403c;
  }
  .message {
    padding: 18px; margin: 16px 0;
    border-radius: 8px; text-align: center;
    font-weight: 700; font-size: 15px;
    font-family: 'Hiragino Mincho ProN', serif;
  }
  .message.ok { background: #f0fdf4; color: #14532d; border: 1px solid #86efac; }
  .message.err { background: #fef2f2; color: #7f1d1d; border: 1px solid #fca5a5; }
  .fee-tag {
    display: inline-block;
    padding: 3px 10px;
    background: #fef3c7;
    color: #78350f;
    border: 1px solid #fde68a;
    border-radius: 12px;
    font-size: 11px; font-weight: 700;
    margin-left: 8px;
    font-family: inherit;
  }
  .event-block {
    border: 1px solid #e7e5e4; border-radius: 8px;
    padding: 16px 18px; margin-bottom: 12px;
    background: #ffffff;
  }
  .event-block summary {
    cursor: pointer; font-weight: 700;
    font-size: 14.5px; font-family: 'Hiragino Mincho ProN', serif;
    list-style: none; outline: none;
    display: flex; align-items: center; flex-wrap: wrap;
  }
  .event-block summary::-webkit-details-marker { display: none; }
  .event-block summary::before {
    content: "+"; display: inline-flex;
    align-items: center; justify-content: center;
    width: 22px; height: 22px; margin-right: 10px;
    background: #b91c1c; color: #fff;
    border-radius: 4px; font-size: 14px;
    transition: transform .2s;
  }
  .event-block[open] summary::before { content: "−"; }
  .event-block .members { margin-top: 14px; }
  .entry-row {
    background: #fafafa;
    border-left: 3px solid #d6d3d1;
    border-radius: 5px;
    padding: 12px 14px;
    margin-bottom: 8px;
    transition: border-color .15s;
  }
  .entry-row:hover { border-left-color: #b45309; }
  .form-footer {
    text-align: center;
    margin-top: 24px;
    padding: 20px;
    color: #78716c;
    font-size: 11px;
    border-top: 1px solid #e7e5e4;
  }
  .form-footer .org {
    font-family: 'Hiragino Mincho ProN', serif;
    font-size: 13px; font-weight: 600;
    color: #44403c;
    margin-bottom: 4px;
    letter-spacing: 0.1em;
  }
  @media (max-width: 600px) {
    body { padding: 10px 8px; }
    .form-header { padding: 22px 18px; }
    .form-header h1 { font-size: 21px; }
    .form-header-art { width: 130px; height: 70px; opacity: 0.85; }
    .form-section { padding: 18px 16px; }
    .form-row { grid-template-columns: 1fr; gap: 10px; margin-bottom: 10px; }
    .total-box { padding: 14px 16px; }
    .total-box .amount { font-size: 26px; }
  }
</style>
</head>
<body>
<div class="form-header">
  <h1><span class="seal">大会申込</span>${tournName}</h1>
  <div class="meta">
    開催日 ${tournDate || "日程未定"}
    ${tournament.venue ? "　·　会場 " + escapeHtml(tournament.venue) : ""}
    ${deadline ? "　·　締切 " + escapeHtml(deadline) : ""}
  </div>
</div>

<form id="entryForm" onsubmit="return submitForm(event)">

<div class="form-section">
  <h2>申込責任者・連絡先</h2>
  <div class="form-row">
    <div>
      <label>団体名 <span class="required">必須</span></label>
      <input type="text" name="team_name" required placeholder="例: ○○高校 / □□クラブ">
    </div>
    <div>
      <label>申込責任者 (氏名) <span class="required">必須</span></label>
      <input type="text" name="contact_name" required>
    </div>
  </div>
  <div class="form-row">
    <div>
      <label>連絡先 (電話番号) <span class="required">必須</span></label>
      <input type="tel" name="contact_tel" required placeholder="例: 0154-XX-XXXX">
    </div>
    <div>
      <label>メールアドレス <span class="required">必須・自動返信用</span></label>
      <input type="email" name="contact_email" required placeholder="example@example.com">
    </div>
  </div>
  <div class="form-row">
    <div>
      <label>引率顧問</label>
      <input type="text" name="supervisor">
    </div>
    <div>
      <label>コーチ</label>
      <input type="text" name="coach">
    </div>
  </div>
</div>

<div class="form-section">
  <h2>出場種目</h2>
  <div id="eventsContainer"></div>
  <details class="event-block" style="margin-top:12px;border-style:dashed;">
    <summary>その他の種目を申し込む (自由記入)</summary>
    <div style="font-size:12px;color:#6b7280;margin:8px 0;">
      上記に掲載のない種目をお申込みされる場合はこちらから入力してください。
      種目名・人数を確認のうえ大会主催者にて参加料を再計算します。
    </div>
    <div class="members" id="customEvents"></div>
    <button type="button" class="btn-add" onclick="addCustomEvent()">
      + その他種目を追加
    </button>
  </details>
</div>

<div class="form-section">
  <h2>合計</h2>
  <div class="total-box">
    <div class="label">参加料合計</div>
    <div class="amount">¥ <span id="totalAmount">0</span></div>
  </div>
  ${paymentNote ? '<div class="notice">' + escapeHtml(paymentNote) + '</div>' : ''}
  ${notes ? '<div class="notice">' + escapeHtml(notes) + '</div>' : ''}
</div>

<div class="form-section">
  <h2>備考</h2>
  <div class="form-row full">
    <textarea name="note" rows="3" placeholder="連絡事項があればこちらに記入してください"></textarea>
  </div>
</div>

<button type="submit" class="submit-btn" id="submitBtn">申込内容を送信</button>
<div id="messageBox"></div>

</form>

<div class="form-footer">
  <div class="org">釧路卓球協会 KUSHIRO TABLE TENNIS ASSOCIATION</div>
  <div>Powered by KTTA Platform</div>
</div>

<script>
const TOURNAMENT_ID = ${escapeJs(tournament.id)};
const TOURNAMENT_NAME = ${escapeJs(tournament.name || "")};
const GAS_URL = ${escapeJs(gasUrl)};
const EVENTS = ${eventsJson};

// 各種目ブロックを動的生成
function renderEvents() {
  const c = document.getElementById("eventsContainer");
  c.innerHTML = "";
  EVENTS.forEach((ev, idx) => {
    const isTeam = ev.type === "team";
    const isDoubles = ev.type === "doubles";
    const memberCount = isTeam ? (ev.per_team || 6) : (isDoubles ? 2 : 1);
    const det = document.createElement("details");
    det.className = "event-block";
    det.dataset.idx = idx;
    const fee = ev.fee || 0;
    det.innerHTML = '<summary>' +
      escapeHtml(ev.name) +
      '<span class="fee-tag">参加料 ¥' + fee.toLocaleString("ja-JP") + (isTeam ? " / チーム" : " / 人") + '</span>' +
      '</summary>' +
      '<div class="members" id="members_' + idx + '"></div>' +
      '<button type="button" class="btn-add" onclick="addEntry(' + idx + ')">+ ' +
        (isTeam ? "チーム" : (isDoubles ? "ペア" : "選手")) + 'を追加</button>';
    c.appendChild(det);
  });
}

function addEntry(eventIdx) {
  const ev = EVENTS[eventIdx];
  const container = document.getElementById("members_" + eventIdx);
  const idx = container.children.length;
  const isTeam = ev.type === "team";
  const isDoubles = ev.type === "doubles";

  const row = document.createElement("div");
  row.className = "entry-row";
  row.style.marginBottom = "8px";
  row.style.padding = "10px";
  row.style.background = "#f9fafb";
  row.style.borderRadius = "4px";
  row.style.position = "relative";

  let html = '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' +
    '<strong style="font-size:13px;">#' + (idx + 1) + '</strong>' +
    '<button type="button" class="btn-del" onclick="removeEntry(this, ' + eventIdx + ')">削除</button>' +
    '</div>';

  if (isTeam) {
    html += '<input type="text" name="ev' + eventIdx + '_team' + idx + '_name" placeholder="チーム名" style="width:100%; margin-bottom:6px; padding:6px;" />';
    const per = ev.per_team || 6;
    for (let i = 0; i < per; i++) {
      html += '<input type="text" name="ev' + eventIdx + '_team' + idx + '_m' + i + '" placeholder="メンバー' + (i + 1) + ' 氏名" style="width:100%; margin-bottom:4px; padding:6px; font-size:12px;" />';
    }
  } else if (isDoubles) {
    html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px;">' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_n1" placeholder="氏名1" style="padding:6px;" />' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_n2" placeholder="氏名2" style="padding:6px;" />' +
      '</div>' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_team" placeholder="所属" style="width:100%; padding:6px; font-size:12px;" />';
  } else {
    html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">' +
      '<input type="text" name="ev' + eventIdx + '_p' + idx + '_name" placeholder="氏名 (フルネーム)" style="padding:6px;" />' +
      '<input type="text" name="ev' + eventIdx + '_p' + idx + '_team" placeholder="所属" style="padding:6px; font-size:12px;" />' +
      '</div>';
  }
  row.innerHTML = html;
  container.appendChild(row);
  recalcTotal();
}

function removeEntry(btn, eventIdx) {
  btn.closest(".entry-row").remove();
  recalcTotal();
}

function recalcTotal() {
  let total = 0;
  EVENTS.forEach((ev, idx) => {
    const container = document.getElementById("members_" + idx);
    if (!container) return;
    const count = container.children.length;
    total += count * (ev.fee || 0);
  });
  // その他種目 (自由記入) の合計
  const cust = document.getElementById("customEvents");
  if (cust) {
    Array.from(cust.children).forEach((row) => {
      const feeInp = row.querySelector('input[name="cust_fee"]');
      const fee = parseInt((feeInp && feeInp.value) || "0", 10) || 0;
      total += fee;
    });
  }
  document.getElementById("totalAmount").textContent = total.toLocaleString("ja-JP");
}

// その他種目 (自由記入) の行を追加
function addCustomEvent() {
  const container = document.getElementById("customEvents");
  const idx = container.children.length;
  const row = document.createElement("div");
  row.className = "entry-row";
  row.style.marginBottom = "8px";
  row.style.padding = "10px";
  row.style.background = "#fff7ed";
  row.style.borderLeft = "3px solid #f59e0b";
  row.style.borderRadius = "4px";
  row.innerHTML =
    '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' +
    '<strong style="font-size:13px;">自由記入 #' + (idx + 1) + '</strong>' +
    '<button type="button" class="btn-del" ' +
    'onclick="this.closest(\'.entry-row\').remove(); recalcTotal();">削除</button>' +
    '</div>' +
    '<div style="display:grid; grid-template-columns:2fr 1fr; gap:6px; margin-bottom:6px;">' +
    '<input type="text" name="cust_name" placeholder="種目名 (例: ミックスダブルス・小学団体 等)" style="padding:6px;" />' +
    '<input type="number" name="cust_fee" placeholder="参加料(円)" min="0" step="100" style="padding:6px;" oninput="recalcTotal()" />' +
    '</div>' +
    '<input type="text" name="cust_players" placeholder="参加者氏名 (複数の場合はカンマ区切り)" style="width:100%; padding:6px; font-size:12px; margin-bottom:4px;" />' +
    '<input type="text" name="cust_team" placeholder="所属" style="width:100%; padding:6px; font-size:12px;" />';
  container.appendChild(row);
  recalcTotal();
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function gatherFormData() {
  const form = document.getElementById("entryForm");
  const fd = new FormData(form);
  const data = {
    tournament_id: TOURNAMENT_ID,
    tournament_name: TOURNAMENT_NAME,
    team_name: fd.get("team_name"),
    contact_name: fd.get("contact_name"),
    contact_tel: fd.get("contact_tel"),
    contact_email: fd.get("contact_email"),
    supervisor: fd.get("supervisor") || "",
    coach: fd.get("coach") || "",
    note: fd.get("note") || "",
    submitted_at: new Date().toISOString(),
    entries: [],
    total_amount: 0,
  };

  EVENTS.forEach((ev, idx) => {
    const container = document.getElementById("members_" + idx);
    if (!container) return;
    Array.from(container.children).forEach((row, ri) => {
      const inputs = row.querySelectorAll("input");
      const obj = { event: ev.name, type: ev.type || "singles", fee: ev.fee || 0 };
      if (ev.type === "team") {
        obj.team_name = (row.querySelector("input[name^='ev" + idx + "_team" + ri + "_name']") || {}).value || "";
        obj.members = [];
        for (let i = 0; i < (ev.per_team || 6); i++) {
          const v = (row.querySelector("input[name='ev" + idx + "_team" + ri + "_m" + i + "']") || {}).value;
          if (v && v.trim()) obj.members.push(v.trim());
        }
        if (!obj.team_name && obj.members.length === 0) return;
      } else if (ev.type === "doubles") {
        obj.name1 = (row.querySelector("input[name^='ev" + idx + "_pair" + ri + "_n1']") || {}).value || "";
        obj.name2 = (row.querySelector("input[name^='ev" + idx + "_pair" + ri + "_n2']") || {}).value || "";
        obj.team = (row.querySelector("input[name^='ev" + idx + "_pair" + ri + "_team']") || {}).value || "";
        if (!obj.name1 && !obj.name2) return;
      } else {
        obj.name = (row.querySelector("input[name^='ev" + idx + "_p" + ri + "_name']") || {}).value || "";
        obj.team = (row.querySelector("input[name^='ev" + idx + "_p" + ri + "_team']") || {}).value || "";
        if (!obj.name) return;
      }
      data.entries.push(obj);
      data.total_amount += obj.fee;
    });
  });

  // その他種目 (自由記入)
  const cust = document.getElementById("customEvents");
  if (cust) {
    Array.from(cust.children).forEach((row) => {
      const name = (row.querySelector('input[name="cust_name"]') || {}).value || "";
      const fee = parseInt((row.querySelector('input[name="cust_fee"]') || {}).value || "0", 10) || 0;
      const players = (row.querySelector('input[name="cust_players"]') || {}).value || "";
      const team = (row.querySelector('input[name="cust_team"]') || {}).value || "";
      if (!name.trim() && !players.trim()) return;
      data.entries.push({
        event: name.trim() || "(自由記入)",
        type: "custom",
        fee: fee,
        name: players.trim(),
        team: team.trim(),
      });
      data.total_amount += fee;
    });
  }

  return data;
}

async function submitForm(e) {
  e.preventDefault();
  const data = gatherFormData();
  if (data.entries.length === 0) {
    showMessage("少なくとも 1 種目に 1名以上の参加者を登録してください。", "err");
    return false;
  }
  const btn = document.getElementById("submitBtn");
  btn.disabled = true;
  btn.textContent = "送信中...";

  try {
    // GAS Web App は CORS のため text/plain で送信
    const resp = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(data),
    });
    const txt = await resp.text();
    let result;
    try { result = JSON.parse(txt); } catch { result = { ok: resp.ok, raw: txt }; }
    if (result.ok || resp.ok) {
      showMessage("申込を受け付けました。確認メールをご登録のメールアドレスに送信しました。", "ok");
      document.getElementById("entryForm").reset();
      renderEvents();
      recalcTotal();
    } else {
      showMessage("送信失敗: " + (result.error || resp.statusText), "err");
    }
  } catch (err) {
    showMessage("送信エラー: " + err.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "申込内容を送信";
  }
  return false;
}

function showMessage(text, type) {
  const box = document.getElementById("messageBox");
  box.innerHTML = '<div class="message ' + type + '">' + escapeHtml(text) + '</div>';
  window.scrollTo({ top: box.offsetTop - 100, behavior: "smooth" });
  if (type === "ok") setTimeout(() => box.innerHTML = "", 8000);
}

// 初期化
renderEvents();
recalcTotal();
</script>
</body>
</html>`;
}

/**
 * Jimdo 埋込用の iframe HTML を生成 (固定 URL に埋込む簡易版)
 */
function buildIframeEmbed(url, height) {
  height = height || 1200;
  return `<!-- 卓球大会 申込フォーム埋込 -->
<iframe src="${url}" width="100%" height="${height}" frameborder="0"
        style="border:0;max-width:800px;display:block;margin:0 auto"
        allow="clipboard-write"></iframe>`;
}

/**
 * Jimdo / STUDIO 直接貼付用 自己完結型 HTML スニペット
 * - <!DOCTYPE> / <html> / <body> タグなし (Jimdoが除去するため)
 * - 全クラス名に `tt-` prefix (Jimdo既存CSSと衝突回避)
 * - 外部依存ゼロ (フォント・CSS・画像すべてインライン)
 * - <style> + HTML + <script> の単一ブロック
 *
 * @param {Object} tournament  大会オブジェクト
 * @param {Array}  events      種目リスト [{name,type,fee,per_team}, ...]
 * @param {Object} opts        gas_url / deadline / payment_note / notes
 */
function buildEntryFormSnippet(tournament, events, opts) {
  opts = opts || {};
  const gasUrl = opts.gas_url || "";
  const deadline = opts.deadline || "";
  const paymentNote = opts.payment_note ||
    "参加料は、大会当日の開会式前に受付でお支払いください。";
  const notes = opts.notes || "";
  const tournName = escapeHtml(tournament.name || "");
  const tournDate = tournament.date
    ? new Date(tournament.date).toLocaleDateString("ja-JP",
        { year: "numeric", month: "long", day: "numeric", weekday: "short" })
    : "";

  const eventsJson = JSON.stringify(events.map(e => ({
    name: e.name,
    fee: e.fee || 0,
    type: e.type || "singles",
    per_team: e.per_team || 6,
  })));

  // タンチョウ+卓球の SVG (前バージョンの簡略版・インラインで埋込)
  const TANCHO_SVG = `<svg viewBox="0 0 120 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M 25 38 C 25 32, 32 28, 40 28 L 55 28 C 62 28, 65 31, 65 36 L 62 41 L 28 41 Z" fill="#fafafa" stroke="#27272a" stroke-width="0.8"/>
    <path d="M 25 38 L 18 36 L 20 42 L 27 41 Z" fill="#09090b"/>
    <line x1="35" y1="41" x2="35" y2="52" stroke="#27272a" stroke-width="1.4" stroke-linecap="round"/>
    <line x1="45" y1="41" x2="45" y2="52" stroke="#27272a" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M 53 28 Q 50 19, 46 14 Q 43 9, 45 6" stroke="#fafafa" stroke-width="3" fill="none" stroke-linecap="round"/>
    <circle cx="45" cy="6" r="3.8" fill="#fafafa" stroke="#27272a" stroke-width="0.8"/>
    <path d="M 42 4 Q 45 1, 48 4 L 48 6.5 L 42 6.5 Z" fill="#dc2626"/>
    <path d="M 48.5 6.5 L 54 7 L 48.5 7.8 Z" fill="#1c1917"/>
    <circle cx="45" cy="6.2" r="0.7" fill="#09090b"/>
    <circle cx="92" cy="14" r="4" fill="#fff" stroke="#71717a" stroke-width="0.8"/>
    <circle cx="91" cy="13" r="1.2" fill="#dc2626"/>
    <path d="M 65 22 Q 80 14, 92 14" stroke="#dc2626" stroke-width="1" fill="none" stroke-dasharray="2 2.5" opacity="0.7"/>
  </svg>`;

  // 単一ブロック (DOCTYPE / html / body 無し)
  return `<!-- ━━━━ KTTA Platform 申込フォーム ━━━━ -->
<!-- Jimdo / STUDIO の HTML埋込ブロックに貼り付けてください -->
<style>
  .tt-wrap { max-width: 760px; margin: 30px auto; padding: 24px 28px;
    background: #ffffff; border-radius: 14px;
    box-shadow: 0 4px 20px rgba(0,0,0,.06);
    font-family: "Hiragino Mincho ProN", "Yu Mincho", "YuMincho",
      "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif;
    color: #1c1917; line-height: 1.7; box-sizing: border-box; }
  .tt-wrap *, .tt-wrap *::before, .tt-wrap *::after { box-sizing: border-box; }
  .tt-hd { display: flex; align-items: center; gap: 14px;
    padding-bottom: 16px; margin-bottom: 18px;
    border-bottom: 2px solid #b91c1c; position: relative; }
  .tt-hd-art { width: 120px; height: 60px; flex-shrink: 0; }
  .tt-hd-text { flex: 1; min-width: 0; }
  .tt-hd-seal { display: inline-block; background: #b91c1c; color: #fff;
    font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 3px;
    letter-spacing: 0.18em; margin-right: 8px; vertical-align: middle; }
  .tt-hd h2 { font-family: "Hiragino Mincho ProN", serif;
    font-size: 22px; font-weight: 700; margin: 0 0 6px;
    letter-spacing: 0.01em; color: #1c1917; }
  .tt-hd .tt-meta { font-size: 12px; color: #57534e; }
  .tt-sec { margin-bottom: 20px; padding-bottom: 18px;
    border-bottom: 1px dashed #e7e5e4; }
  .tt-sec:last-child { border-bottom: none; }
  .tt-sec h3 { font-family: "Hiragino Mincho ProN", serif;
    font-size: 16px; font-weight: 700; margin: 0 0 12px;
    padding-left: 12px; border-left: 4px solid #b91c1c;
    color: #1c1917; }
  .tt-row { display: grid; grid-template-columns: 1fr 1fr;
    gap: 14px; margin-bottom: 12px; }
  .tt-row.tt-full { grid-template-columns: 1fr; }
  .tt-fld label { display: block; font-size: 12px; font-weight: 700;
    color: #57534e; margin-bottom: 5px; letter-spacing: 0.03em; }
  .tt-fld .tt-req { background: #b91c1c; color: #fff;
    font-size: 9px; padding: 1px 6px; border-radius: 2px;
    margin-left: 5px; letter-spacing: 0.08em; }
  .tt-fld input[type="text"], .tt-fld input[type="email"],
  .tt-fld input[type="tel"], .tt-fld input[type="number"],
  .tt-fld select, .tt-fld textarea {
    width: 100%; padding: 11px 13px;
    border: 1px solid #d6d3d1; border-radius: 6px;
    font-family: inherit; font-size: 14.5px;
    background: #fdfdfc; transition: all .15s;
    box-sizing: border-box; }
  .tt-fld input:focus, .tt-fld select:focus, .tt-fld textarea:focus {
    outline: none; border-color: #b91c1c;
    box-shadow: 0 0 0 3px rgba(185,28,28,.1); background: #fff; }
  .tt-ev { border: 1px solid #e7e5e4; border-radius: 8px;
    margin-bottom: 10px; background: #fff; }
  .tt-ev-hd { padding: 12px 16px; cursor: pointer;
    display: flex; align-items: center; gap: 10px;
    user-select: none; font-weight: 700; }
  .tt-ev-hd::before { content: "+"; display: inline-flex;
    align-items: center; justify-content: center;
    width: 22px; height: 22px; background: #b91c1c; color: #fff;
    border-radius: 4px; font-size: 14px; transition: transform .2s; }
  .tt-ev.tt-open .tt-ev-hd::before { content: "−"; }
  .tt-ev-name { flex: 1; font-size: 14.5px;
    font-family: "Hiragino Mincho ProN", serif; }
  .tt-ev-fee { font-size: 11px; padding: 3px 10px;
    background: #fef3c7; color: #78350f;
    border: 1px solid #fde68a; border-radius: 12px;
    font-weight: 700; }
  .tt-ev-body { display: none; padding: 12px 16px 16px;
    border-top: 1px solid #e7e5e4; }
  .tt-ev.tt-open .tt-ev-body { display: block; }
  .tt-mem-grid { display: grid; grid-template-columns: 1fr 1fr;
    gap: 10px; padding: 12px; background: #fafafa;
    border-radius: 6px; margin-bottom: 10px; }
  .tt-mem-grid input { width: 100%; padding: 8px 10px;
    border: 1px solid #d6d3d1; border-radius: 4px;
    font-size: 13px; box-sizing: border-box; background: #fff; }
  .tt-team-name { width: 100%; padding: 10px 12px;
    border: 1.5px solid #b45309; border-radius: 6px;
    margin-bottom: 8px; font-size: 14px; font-weight: 600;
    box-sizing: border-box; background: #fffbeb; }
  .tt-tot { margin: 20px 0; padding: 18px 22px;
    background: #fffaf0; border: 2px solid #b45309;
    border-radius: 10px; display: flex;
    justify-content: space-between; align-items: center; }
  .tt-tot-lbl { font-family: "Hiragino Mincho ProN", serif;
    font-size: 15px; font-weight: 700; color: #78350f; }
  .tt-tot-amt { font-family: "Hiragino Mincho ProN", serif;
    font-size: 30px; font-weight: 700; color: #b91c1c; }
  .tt-btn-area { display: flex; gap: 12px; justify-content: center;
    flex-wrap: wrap; margin-top: 20px; }
  .tt-btn { padding: 13px 26px; border: none; border-radius: 8px;
    font-size: 15px; font-weight: 700;
    font-family: "Hiragino Mincho ProN", serif;
    cursor: pointer; transition: all .15s;
    letter-spacing: 0.1em; text-decoration: none;
    display: inline-block; }
  .tt-btn-conf { background: #b91c1c; color: #fff; width: 100%; }
  .tt-btn-conf:hover { background: #991b1b; }
  .tt-btn-copy { background: #57534e; color: #fff; flex: 1; }
  .tt-btn-submit { background: #15803d; color: #fff; flex: 1; }
  .tt-btn:hover { opacity: .9; transform: translateY(-1px); }
  .tt-confirm { display: none; margin-top: 20px;
    padding: 20px 24px; background: #fff7ed;
    border: 2px dashed #b45309; border-radius: 10px;
    white-space: pre-wrap; font-size: 14px;
    font-family: "Hiragino Mincho ProN", serif; line-height: 1.7; }
  .tt-confirm-hd { font-weight: 700; margin-bottom: 12px;
    padding-bottom: 8px; border-bottom: 1px solid #b45309;
    color: #7c2d12; font-size: 15px; }
  .tt-notice { background: #fef3c7; border-left: 3px solid #b45309;
    padding: 10px 14px; font-size: 12.5px; margin: 12px 0;
    border-radius: 0 6px 6px 0; color: #44403c; }
  .tt-msg { padding: 14px; margin: 14px 0;
    border-radius: 6px; text-align: center; font-weight: 700; }
  .tt-msg-ok { background: #f0fdf4; color: #14532d; border: 1px solid #86efac; }
  .tt-msg-err { background: #fef2f2; color: #7f1d1d; border: 1px solid #fca5a5; }
  .tt-foot { text-align: center; margin-top: 24px;
    padding-top: 18px; color: #78716c; font-size: 11px;
    border-top: 1px solid #e7e5e4; }
  .tt-foot-org { font-family: "Hiragino Mincho ProN", serif;
    font-size: 13px; font-weight: 600; color: #44403c;
    letter-spacing: 0.1em; margin-bottom: 4px; }
  @media (max-width: 600px) {
    .tt-wrap { padding: 16px 14px; margin: 16px auto; }
    .tt-hd { gap: 10px; }
    .tt-hd-art { width: 80px; height: 40px; }
    .tt-hd h2 { font-size: 18px; }
    .tt-row { grid-template-columns: 1fr; gap: 10px; }
    .tt-mem-grid { grid-template-columns: 1fr; }
    .tt-tot { padding: 14px 16px; }
    .tt-tot-amt { font-size: 24px; }
  }
</style>

<div class="tt-wrap">
  <div class="tt-hd">
    <div class="tt-hd-text">
      <h2><span class="tt-hd-seal">大会申込</span>${tournName}</h2>
      <div class="tt-meta">
        開催日 ${tournDate || "日程未定"}
        ${tournament.venue ? "　·　会場 " + escapeHtml(tournament.venue) : ""}
        ${deadline ? "　·　締切 " + escapeHtml(deadline) : ""}
      </div>
    </div>
  </div>

  <form id="ttForm_${tournament.id}" onsubmit="return ttSubmit_${escapeJsId(tournament.id)}(event)">
    <div class="tt-sec">
      <h3>申込責任者・連絡先</h3>
      <div class="tt-row">
        <div class="tt-fld">
          <label>団体名<span class="tt-req">必須</span></label>
          <input type="text" name="team_name" required placeholder="例: ○○高校 / □□クラブ">
        </div>
        <div class="tt-fld">
          <label>申込責任者 (氏名)<span class="tt-req">必須</span></label>
          <input type="text" name="contact_name" required>
        </div>
      </div>
      <div class="tt-row">
        <div class="tt-fld">
          <label>電話番号<span class="tt-req">必須</span></label>
          <input type="tel" name="contact_tel" required placeholder="例: 0154-XX-XXXX">
        </div>
        <div class="tt-fld">
          <label>メールアドレス<span class="tt-req">必須</span></label>
          <input type="email" name="contact_email" required placeholder="example@example.com">
        </div>
      </div>
      <div class="tt-row">
        <div class="tt-fld"><label>引率顧問</label><input type="text" name="supervisor"></div>
        <div class="tt-fld"><label>コーチ</label><input type="text" name="coach"></div>
      </div>
    </div>

    <div class="tt-sec">
      <h3>出場種目</h3>
      <div id="ttEvCt_${escapeJsId(tournament.id)}"></div>
    </div>

    <div class="tt-sec">
      <h3>お弁当・懇親会</h3>
      <div class="tt-row">
        <div class="tt-fld">
          <label>お弁当 (¥<span id="ttBentoFee_${escapeJsId(tournament.id)}" data-fee="800">800</span>/個)</label>
          <input type="number" min="0" max="100" placeholder="個数"
            id="ttBento_${escapeJsId(tournament.id)}"
            oninput="window.ttRecalcExtras_${escapeJsId(tournament.id)}()" />
        </div>
        <div class="tt-fld">
          <label>懇親会 (¥<span id="ttPartyFee_${escapeJsId(tournament.id)}" data-fee="3500">3,500</span>/人)</label>
          <input type="number" min="0" max="100" placeholder="人数"
            id="ttParty_${escapeJsId(tournament.id)}"
            oninput="window.ttRecalcExtras_${escapeJsId(tournament.id)}()" />
        </div>
      </div>
    </div>

    <div class="tt-sec">
      <h3>ダブルスの相手募集 (任意)</h3>
      <div style="font-size:12px;color:#57534e;margin-bottom:8px">
        ダブルスのペア相手を募集する場合に入力してください。事務局でマッチングします。
      </div>
      <div id="ttPartner_${escapeJsId(tournament.id)}"></div>
      <button type="button" class="tt-btn"
        style="background:#fff;color:#b91c1c;border:1.5px dashed #d6d3d1;padding:8px 16px;font-size:12px;letter-spacing:0"
        onclick="window.ttAddPartner_${escapeJsId(tournament.id)}()">+ 相手募集を追加</button>
    </div>

    <div class="tt-tot">
      <div class="tt-tot-lbl">参加料 合計</div>
      <div class="tt-tot-amt">¥<span id="ttTotal_${escapeJsId(tournament.id)}">0</span></div>
    </div>

    ${paymentNote ? '<div class="tt-notice">' + escapeHtml(paymentNote) + '</div>' : ''}
    ${notes ? '<div class="tt-notice">' + escapeHtml(notes) + '</div>' : ''}

    <div class="tt-sec">
      <h3>備考</h3>
      <div class="tt-fld">
        <textarea name="note" rows="3" placeholder="連絡事項があればこちらに記入してください"></textarea>
      </div>
    </div>

    <button type="button" class="tt-btn tt-btn-conf"
      onclick="ttConfirm_${escapeJsId(tournament.id)}()">入力内容を確認</button>
  </form>

  <div id="ttConf_${escapeJsId(tournament.id)}" class="tt-confirm">
    <div class="tt-confirm-hd">【お申込内容の確認】</div>
    <div id="ttSum_${escapeJsId(tournament.id)}"></div>
    <div class="tt-btn-area">
      <button type="button" class="tt-btn tt-btn-copy"
        onclick="ttCopy_${escapeJsId(tournament.id)}()">内容をコピー</button>
      <button type="button" class="tt-btn tt-btn-submit"
        onclick="ttSend_${escapeJsId(tournament.id)}()">送信する</button>
    </div>
  </div>
  <div id="ttMsg_${escapeJsId(tournament.id)}"></div>

  <div class="tt-foot">
    <div class="tt-foot-org">釧路卓球協会 KUSHIRO TABLE TENNIS ASSOCIATION</div>
    <div>Powered by KTTA Platform</div>
  </div>
</div>

<script>
(function() {
  var TID = ${escapeJs(tournament.id)};
  var TNAME = ${escapeJs(tournament.name || "")};
  var GAS = ${escapeJs(gasUrl)};
  var EVENTS = ${eventsJson};
  var SUFFIX = ${escapeJs(escapeJsId(tournament.id))};

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderEvents() {
    var c = $("ttEvCt_" + SUFFIX);
    if (!c) return;
    c.innerHTML = "";
    EVENTS.forEach(function(ev, idx) {
      var isTeam = ev.type === "team";
      var isDoubles = ev.type === "doubles";
      var det = document.createElement("div");
      det.className = "tt-ev";
      det.dataset.idx = idx;
      var memberHtml = '<div class="tt-mem-grid" id="ttMem_" data-evidx="' + idx + '"></div>';
      det.innerHTML =
        '<div class="tt-ev-hd" onclick="this.parentElement.classList.toggle(\\'tt-open\\')">' +
          '<span class="tt-ev-name">' + esc(ev.name) + '</span>' +
          '<span class="tt-ev-fee">¥' + (ev.fee || 0).toLocaleString("ja-JP") +
            (isTeam ? " / チーム" : " / 人") + '</span>' +
        '</div>' +
        '<div class="tt-ev-body">' +
          '<div class="tt-members" id="ttMemList_' + idx + '_" data-evidx="' + idx + '"></div>' +
          '<button type="button" class="tt-btn" style="background:#fff;color:#b91c1c;border:1.5px dashed #d6d3d1;padding:8px 16px;font-size:12px;letter-spacing:0" onclick="window.ttAdd_' + SUFFIX + '(' + idx + ')">+ ' +
            (isTeam ? "チーム" : (isDoubles ? "ペア" : "選手")) + 'を追加</button>' +
        '</div>';
      c.appendChild(det);
    });
    recalcTotal();
  }

  window["ttAdd_" + SUFFIX] = function(eventIdx) {
    var ev = EVENTS[eventIdx];
    var container = document.querySelector('[data-evidx="' + eventIdx + '"].tt-members');
    if (!container) return;
    var idx = container.children.length;
    var isTeam = ev.type === "team";
    var isDoubles = ev.type === "doubles";
    var row = document.createElement("div");
    row.style.padding = "12px";
    row.style.background = "#fafafa";
    row.style.borderLeft = "3px solid #b45309";
    row.style.borderRadius = "5px";
    row.style.marginBottom = "8px";
    var html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<strong style="font-size:13px">#' + (idx + 1) + '</strong>' +
      '<button type="button" style="background:transparent;color:#b91c1c;border:1px solid #fecaca;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:auto" ' +
      'onclick="this.closest(\\'div\\').parentElement.removeChild(this.closest(\\'div\\').parentElement.lastChild === this.closest(\\'div\\') ? this.closest(\\'div\\') : this.closest(\\'div\\')); window.ttRecalc_' + SUFFIX + '()">削除</button>' +
      '</div>';
    if (isTeam) {
      html += '<input type="text" class="tt-team-name" name="ev' + eventIdx + '_t' + idx + '_name" placeholder="チーム名 (例: Aチーム)" />';
      var per = ev.per_team || 6;
      for (var i = 0; i < per; i++) {
        html += '<div style="display:grid;grid-template-columns:2fr 60px 2fr;gap:6px;margin-bottom:4px">' +
          '<input type="text" name="ev' + eventIdx + '_t' + idx + '_m' + i + '_name" placeholder="選手' + (i+1) + ' 氏名" />' +
          '<input type="number" name="ev' + eventIdx + '_t' + idx + '_m' + i + '_age" placeholder="年齢" min="0" max="120" />' +
          '<input type="text" name="ev' + eventIdx + '_t' + idx + '_m' + i + '_team" placeholder="所属 (省略可)" />' +
        '</div>';
      }
    } else if (isDoubles) {
      var isMixed = /混合|ミックス/.test(ev.name || "");
      html += '<div style="display:grid;grid-template-columns:2fr 60px 2fr;gap:6px;margin-bottom:6px">' +
        '<input type="text" name="ev' + eventIdx + '_p' + idx + '_n1" placeholder="' + (isMixed ? "男子 氏名" : "氏名1") + '" />' +
        '<input type="number" name="ev' + eventIdx + '_p' + idx + '_a1" placeholder="年齢" min="0" max="120" />' +
        '<input type="text" name="ev' + eventIdx + '_p' + idx + '_t1" placeholder="所属1" />' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:2fr 60px 2fr;gap:6px">' +
        '<input type="text" name="ev' + eventIdx + '_p' + idx + '_n2" placeholder="' + (isMixed ? "女子 氏名" : "氏名2") + '" />' +
        '<input type="number" name="ev' + eventIdx + '_p' + idx + '_a2" placeholder="年齢" min="0" max="120" />' +
        '<input type="text" name="ev' + eventIdx + '_p' + idx + '_t2" placeholder="所属2" />' +
        '</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:2fr 60px 2fr;gap:6px">' +
        '<input type="text" name="ev' + eventIdx + '_s' + idx + '_name" placeholder="氏名 (フルネーム)" />' +
        '<input type="number" name="ev' + eventIdx + '_s' + idx + '_age" placeholder="年齢" min="0" max="120" />' +
        '<input type="text" name="ev' + eventIdx + '_s' + idx + '_team" placeholder="所属" />' +
        '</div>';
    }
    row.innerHTML = html;
    container.appendChild(row);
    recalcTotal();
  };

  function recalcTotal() {
    var total = 0;
    EVENTS.forEach(function(ev, idx) {
      var container = document.querySelector('[data-evidx="' + idx + '"].tt-members');
      if (!container) return;
      total += container.children.length * (ev.fee || 0);
    });
    // お弁当・懇親会
    var bEl = $("ttBento_" + SUFFIX);
    var pEl = $("ttParty_" + SUFFIX);
    var bFeeEl = $("ttBentoFee_" + SUFFIX);
    var pFeeEl = $("ttPartyFee_" + SUFFIX);
    var bFee = bFeeEl ? parseInt(bFeeEl.dataset.fee, 10) || 800 : 800;
    var pFee = pFeeEl ? parseInt(pFeeEl.dataset.fee, 10) || 3500 : 3500;
    if (bEl && bEl.value) total += (parseInt(bEl.value, 10) || 0) * bFee;
    if (pEl && pEl.value) total += (parseInt(pEl.value, 10) || 0) * pFee;

    var tEl = $("ttTotal_" + SUFFIX);
    if (tEl) tEl.textContent = total.toLocaleString("ja-JP");
    return total;
  }
  window["ttRecalc_" + SUFFIX] = recalcTotal;
  window["ttRecalcExtras_" + SUFFIX] = recalcTotal;

  // ダブルス相手募集 行追加
  window["ttAddPartner_" + SUFFIX] = function() {
    var ct = $("ttPartner_" + SUFFIX);
    if (!ct) return;
    var idx = ct.children.length;
    var row = document.createElement("div");
    row.style.padding = "10px 12px";
    row.style.background = "#fafafa";
    row.style.borderLeft = "3px solid #b91c1c";
    row.style.borderRadius = "5px";
    row.style.marginBottom = "8px";
    row.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<strong style="font-size:12px">相手募集 #' + (idx+1) + '</strong>' +
      '<button type="button" style="background:transparent;color:#b91c1c;border:1px solid #fecaca;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;margin-left:auto" ' +
      'onclick="this.closest(\\'div\\').parentElement.removeChild(this.closest(\\'div\\'))">削除</button>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:130px 2fr 70px;gap:6px;margin-bottom:6px">' +
      '<select name="partner_div">' +
        '<option value="一般男子">一般男子</option>' +
        '<option value="一般女子">一般女子</option>' +
        '<option value="混合">混合</option>' +
        '<option value="高校男子">高校男子</option>' +
        '<option value="高校女子">高校女子</option>' +
      '</select>' +
      '<input type="text" name="partner_name" placeholder="氏名" />' +
      '<input type="number" name="partner_age" placeholder="年齢" min="0" max="120" />' +
      '</div>' +
      '<input type="text" name="partner_note" placeholder="希望条件 (例: Aクラス、年齢近め 等)" style="width:100%;padding:8px 10px;border:1px solid #d6d3d1;border-radius:4px;font-size:13px;box-sizing:border-box;background:#fff" />';
    ct.appendChild(row);
  };

  function gather() {
    var form = $("ttForm_" + TID);
    if (!form) return null;
    var fd = new FormData(form);
    var data = {
      tournament_id: TID, tournament_name: TNAME,
      team_name: fd.get("team_name") || "",
      contact_name: fd.get("contact_name") || "",
      contact_tel: fd.get("contact_tel") || "",
      contact_email: fd.get("contact_email") || "",
      supervisor: fd.get("supervisor") || "",
      coach: fd.get("coach") || "",
      note: fd.get("note") || "",
      submitted_at: new Date().toISOString(),
      entries: [], total_amount: 0,
    };
    EVENTS.forEach(function(ev, idx) {
      var container = document.querySelector('[data-evidx="' + idx + '"].tt-members');
      if (!container) return;
      Array.prototype.forEach.call(container.children, function(row, ri) {
        var obj = { event: ev.name, type: ev.type || "singles", fee: ev.fee || 0 };
        var isMixed = /混合|ミックス/.test(ev.name || "");
        if (isMixed) obj.type = "mixed";
        if (ev.type === "team") {
          var nameEl = row.querySelector('input[name^="ev' + idx + '_t' + ri + '_name"]');
          obj.team_name = nameEl ? nameEl.value.trim() : "";
          obj.members = [];
          obj.members_detail = [];
          var per = ev.per_team || 6;
          for (var i = 0; i < per; i++) {
            var nm = row.querySelector('input[name="ev' + idx + '_t' + ri + '_m' + i + '_name"]');
            var ag = row.querySelector('input[name="ev' + idx + '_t' + ri + '_m' + i + '_age"]');
            var tm = row.querySelector('input[name="ev' + idx + '_t' + ri + '_m' + i + '_team"]');
            var name = nm && nm.value.trim();
            if (name) {
              obj.members.push(name);
              obj.members_detail.push({
                name: name,
                age: ag && ag.value ? parseInt(ag.value, 10) : "",
                team: (tm && tm.value.trim()) || obj.team_name || data.team_name,
              });
            }
          }
          if (!obj.team_name && obj.members.length === 0) return;
        } else if (ev.type === "doubles" || isMixed) {
          var n1 = row.querySelector('input[name^="ev' + idx + '_p' + ri + '_n1"]');
          var a1 = row.querySelector('input[name^="ev' + idx + '_p' + ri + '_a1"]');
          var t1 = row.querySelector('input[name^="ev' + idx + '_p' + ri + '_t1"]');
          var n2 = row.querySelector('input[name^="ev' + idx + '_p' + ri + '_n2"]');
          var a2 = row.querySelector('input[name^="ev' + idx + '_p' + ri + '_a2"]');
          var t2 = row.querySelector('input[name^="ev' + idx + '_p' + ri + '_t2"]');
          obj.name1 = n1 ? n1.value.trim() : "";
          obj.age1  = a1 && a1.value ? parseInt(a1.value, 10) : "";
          obj.team1 = t1 ? t1.value.trim() : "";
          obj.name2 = n2 ? n2.value.trim() : "";
          obj.age2  = a2 && a2.value ? parseInt(a2.value, 10) : "";
          obj.team2 = t2 ? t2.value.trim() : "";
          obj.team  = obj.team1 || obj.team2 || data.team_name;
          if (!obj.name1 && !obj.name2) return;
        } else {
          var snm = row.querySelector('input[name^="ev' + idx + '_s' + ri + '_name"]');
          var sag = row.querySelector('input[name^="ev' + idx + '_s' + ri + '_age"]');
          var stm = row.querySelector('input[name^="ev' + idx + '_s' + ri + '_team"]');
          obj.name = snm ? snm.value.trim() : "";
          obj.age  = sag && sag.value ? parseInt(sag.value, 10) : "";
          obj.team = stm ? stm.value.trim() : "";
          if (!obj.name) return;
        }
        data.entries.push(obj);
        data.total_amount += obj.fee;
      });
    });

    // お弁当・懇親会
    var bentoEl = $("ttBento_" + SUFFIX);
    var partyEl = $("ttParty_" + SUFFIX);
    var bentoFee = parseInt(($("ttBentoFee_" + SUFFIX) || {}).dataset?.fee || "800", 10) || 800;
    var partyFee = parseInt(($("ttPartyFee_" + SUFFIX) || {}).dataset?.fee || "3500", 10) || 3500;
    if (bentoEl && bentoEl.value) {
      var bc = parseInt(bentoEl.value, 10) || 0;
      if (bc > 0) {
        data.entries.push({
          event: "お弁当", type: "bento", count: bc, fee: bentoFee * bc,
          name: data.team_name,
        });
        data.total_amount += bentoFee * bc;
        data.bento_count = bc;
      }
    }
    if (partyEl && partyEl.value) {
      var pc = parseInt(partyEl.value, 10) || 0;
      if (pc > 0) {
        data.entries.push({
          event: "懇親会", type: "party", count: pc, fee: partyFee * pc,
          name: data.team_name,
        });
        data.total_amount += partyFee * pc;
        data.party_count = pc;
      }
    }

    // ダブルス相手募集
    var partnerCt = $("ttPartner_" + SUFFIX);
    if (partnerCt) {
      data.partner_search = [];
      Array.prototype.forEach.call(partnerCt.children, function(row) {
        var div = row.querySelector('select[name="partner_div"]');
        var nm = row.querySelector('input[name="partner_name"]');
        var ag = row.querySelector('input[name="partner_age"]');
        var nt = row.querySelector('input[name="partner_note"]');
        var nmV = nm ? nm.value.trim() : "";
        if (!nmV) return;
        data.partner_search.push({
          division: div ? div.value : "",
          name: nmV,
          age: ag && ag.value ? parseInt(ag.value, 10) : "",
          note: nt ? nt.value.trim() : "",
        });
      });
    }

    return data;
  }

  window["ttConfirm_" + SUFFIX] = function() {
    var d = gather();
    if (!d) return;
    if (!d.team_name || !d.contact_name || !d.contact_tel || !d.contact_email) {
      alert("団体名・申込責任者・電話番号・メールアドレス は必須です。");
      return;
    }
    if (d.entries.length === 0) {
      alert("少なくとも 1 種目に 1 人以上の参加者を登録してください。");
      return;
    }
    // 確認テキスト生成
    var lines = [];
    lines.push("団体名:　" + d.team_name);
    lines.push("申込責任者:　" + d.contact_name);
    lines.push("電話番号:　" + d.contact_tel);
    lines.push("メール:　" + d.contact_email);
    if (d.supervisor) lines.push("引率顧問:　" + d.supervisor);
    if (d.coach) lines.push("コーチ:　" + d.coach);
    lines.push("");
    lines.push("─── 申込内容 ───");
    d.entries.forEach(function(e) {
      var s = "[" + e.event + "] ";
      if (e.type === "team") s += (e.team_name || "(無名)") + " : " + (e.members || []).join("、");
      else if (e.type === "doubles") s += (e.name1 || "") + " / " + (e.name2 || "") + " (" + (e.team || "") + ")";
      else s += (e.name || "") + " (" + (e.team || "") + ")";
      s += "　¥" + (e.fee || 0).toLocaleString("ja-JP");
      lines.push(s);
    });
    lines.push("");
    lines.push("合計金額:　¥" + d.total_amount.toLocaleString("ja-JP"));
    if (d.note) lines.push("\\n備考:　" + d.note);

    $("ttSum_" + SUFFIX).innerText = lines.join("\\n");
    $("ttConf_" + SUFFIX).style.display = "block";
    $("ttConf_" + SUFFIX).scrollIntoView({ behavior: "smooth", block: "start" });
  };

  window["ttCopy_" + SUFFIX] = function() {
    var txt = "【" + TNAME + " 申込フォーム】\\n\\n" + $("ttSum_" + SUFFIX).innerText;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function() {
        alert("申込内容をコピーしました。メールやLINE等に貼り付けてご利用ください。");
      }, function() { fallbackCopy(txt); });
    } else { fallbackCopy(txt); }
  };
  function fallbackCopy(txt) {
    var ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.top = "-1000px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); alert("申込内容をコピーしました"); }
    catch (e) { alert("コピー失敗: 手動で内容を選択してコピーしてください"); }
    document.body.removeChild(ta);
  }

  window["ttSend_" + SUFFIX] = function() {
    var d = gather();
    if (!d || d.entries.length === 0) { alert("入力内容を確認してください"); return; }
    if (!GAS) {
      alert("送信先 (GAS Web App URL) が設定されていません。\\n「内容をコピー」してメールでお送りください。");
      return;
    }
    var msg = $("ttMsg_" + SUFFIX);
    msg.innerHTML = '<div class="tt-msg" style="background:#f3f4f6;color:#374151;border:1px solid #d1d5db">送信中...</div>';
    fetch(GAS, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(d),
    }).then(function(r) { return r.text(); }).then(function(t) {
      var result;
      try { result = JSON.parse(t); } catch(e) { result = { ok: true, raw: t }; }
      if (result.ok) {
        msg.innerHTML = '<div class="tt-msg tt-msg-ok">申込を受け付けました。ご登録のメールアドレスに確認メールを送信しました。</div>';
        var form = $("ttForm_" + TID);
        if (form) form.reset();
        $("ttConf_" + SUFFIX).style.display = "none";
        renderEvents();
      } else {
        msg.innerHTML = '<div class="tt-msg tt-msg-err">送信失敗: ' + esc(result.error || "不明なエラー") + '</div>';
      }
    }).catch(function(e) {
      msg.innerHTML = '<div class="tt-msg tt-msg-err">通信エラー: ' + esc(e.message) + '</div>';
    });
  };

  // 初期化
  renderEvents();
})();
</script>
<!-- ━━━━ KTTA Platform 申込フォーム End ━━━━ -->`;
}

// JavaScript識別子として使える文字に変換 (id にハイフンが入る場合の対策)
function escapeJsId(s) {
  return String(s || "").replace(/[^a-zA-Z0-9]/g, "_");
}

module.exports = {
  buildEntryFormHTML,
  buildEntryFormSnippet,
  buildIframeEmbed,
};
