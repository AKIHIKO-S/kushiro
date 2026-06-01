// ═══════════════════════════════════════════════════════
// 申込フォーム HTML 生成
// Jimdo などのノーコードサイトの「HTML埋め込み」ブロックに貼れる
// 完全スタンドアロン (CDN不要、外部依存なし)
// ═══════════════════════════════════════════════════════

// 共通ユーティリティ (lib/) を取り込み。escapeHtml/escapeJs/escapeJsId/eventName は entry_form 既存実装と同一。
const { escapeHtml, escapeJs, escapeJsId, jsonForScript } = require("./lib/text");
const { eventName: _eventName } = require("./lib/events");

// buildEntryFormHTML の前処理(締切/参加料注記/種目名正規化などの派生値)を計算する内部ヘルパ。
function _formPreamble(tournament, opts, events) {
  opts = opts || {};
  return {
    deadline: opts.deadline || "",
    paymentNote: opts.payment_note ||
      "参加料は、大会当日の開会式前に受付でお支払いください。",
    notes: opts.notes || "",
    tournName: escapeHtml(tournament.name || ""),
    tournDate: tournament.date
      ? new Date(tournament.date).toLocaleDateString("ja-JP",
          { year: "numeric", month: "long", day: "numeric", weekday: "short" })
      : "",
    events: (events || []).map(e => ({ ...e, name: _eventName(e.name) })),
  };
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
  const _c = _formPreamble(tournament, opts, events);
  const { deadline, paymentNote, notes, tournName, tournDate } = _c;
  events = _c.events;   // 壊れた event_config (name=オブジェクト) は _formPreamble で正規化済み

  // events は [{ name, fee, type, ... }, ...]
  // 種目を「個人戦 / 団体戦」「ダブルス」に分類してフォーム要素を作る
  const teamEvents = events.filter(e => e.type === "team");
  const singlesEvents = events.filter(e => e.type === "singles");
  const doublesEvents = events.filter(e => e.type === "doubles");

  // 各種目を JS データとして埋込 (インラインscript安全化: </script>等のブレイクアウト防止)
  const eventsJson = jsonForScript(events.map(e => ({
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
    padding: 10px 18px; border-radius: 6px;
    cursor: pointer; font-size: 14px; font-weight: 700;
    font-family: inherit; transition: all .15s;
  }
  .btn-add:hover { background: #fef3c7; border-color: #92400e; }
  .btn-add-bulk { background: #fef3c7; border-style: solid; border-color: #f59e0b; }
  .btn-add-bulk:hover { background: #fde68a; }
  .add-buttons { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .count-badge {
    display: inline-block; margin-left: auto;
    padding: 3px 10px; background: #f0fdf4;
    color: #14532d; border: 1px solid #86efac;
    border-radius: 12px; font-size: 11px; font-weight: 700;
    font-family: inherit;
  }
  /* 確認モーダル */
  .confirm-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,.55); display: flex;
    align-items: center; justify-content: center;
    padding: 20px;
  }
  .confirm-modal {
    background: #fff; max-width: 560px; width: 100%;
    max-height: 88vh; overflow: auto;
    border-radius: 10px; padding: 20px 22px;
    box-shadow: 0 20px 60px rgba(0,0,0,.3);
    font-family: 'Hiragino Sans', system-ui, sans-serif;
  }
  .confirm-modal h3 {
    font-size: 18px; margin-bottom: 12px; color: #7c2d12;
    border-bottom: 2px solid #b91c1c; padding-bottom: 8px;
  }
  .confirm-modal table {
    width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px;
  }
  .confirm-modal td {
    padding: 5px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top;
  }
  .confirm-modal td.label { color: #78716c; width: 80px; }
  .confirm-modal td.val { font-weight: bold; }
  .confirm-modal .total {
    margin-top: 14px; padding: 12px 16px;
    background: linear-gradient(135deg, #fef3c7, #fef9c3);
    border-radius: 6px; display: flex; justify-content: space-between;
    align-items: center; font-size: 15px;
  }
  .confirm-modal .total .amount {
    font-size: 26px; font-weight: 700; color: #b91c1c;
  }
  .confirm-modal .buttons {
    display: flex; gap: 8px; margin-top: 16px;
  }
  .confirm-modal .buttons button {
    flex: 1; padding: 12px; border-radius: 6px;
    border: none; cursor: pointer; font-size: 14px;
    font-weight: 700; font-family: inherit;
  }
  .confirm-modal .btn-cancel { background: #f5f5f4; color: #44403c; }
  .confirm-modal .btn-confirm { background: #b91c1c; color: #fff; }
  .confirm-modal .btn-confirm:disabled { background: #a8a29e; cursor: wait; }
  /* 送信完了画面 (LINE 共有用) */
  .success-card {
    margin: 20px 0; padding: 20px;
    background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%);
    border: 2px solid #15803d; border-radius: 8px;
  }
  .success-card h3 {
    font-size: 18px; color: #14532d; margin-bottom: 10px;
    text-align: center;
  }
  .success-card .summary-text {
    background: #fff; padding: 14px;
    border-radius: 6px; font-size: 12px; line-height: 1.7;
    white-space: pre-wrap; word-break: break-word;
    font-family: 'Hiragino Sans', monospace;
    margin: 12px 0; max-height: 200px; overflow-y: auto;
    border: 1px solid #d1fae5;
  }
  .copy-btn {
    width: 100%; padding: 12px; border-radius: 6px;
    background: #15803d; color: #fff; border: none;
    cursor: pointer; font-size: 14px; font-weight: 700;
    font-family: inherit;
  }
  .copy-btn:hover { background: #166534; }
  .copy-btn.copied { background: #166534; }
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

// 各種目ブロックを動的生成 (開いた状態 + 初期1行を表示)
function renderEvents() {
  const c = document.getElementById("eventsContainer");
  c.innerHTML = "";
  if (!EVENTS || !EVENTS.length) {
    c.innerHTML =
      '<div style="padding:16px;background:#fef2f2;border-left:4px solid #dc2626;' +
      'border-radius:4px;color:#7f1d1d;font-size:13px;line-height:1.7;">' +
      '<strong>出場種目が設定されていません。</strong><br>' +
      '大会主催者にお問い合わせください。</div>';
    return;
  }
  EVENTS.forEach((ev, idx) => {
    const isTeam = ev.type === "team";
    const isDoubles = ev.type === "doubles";
    const det = document.createElement("details");
    det.className = "event-block";
    det.dataset.idx = idx;
    det.open = true; // ★ 種目セクションは初期表示で開く
    const fee = ev.fee || 0;
    const unit = isTeam ? "チーム" : (isDoubles ? "ペア" : "選手");
    det.innerHTML = '<summary>' +
      escapeHtml(ev.name) +
      '<span class="fee-tag">参加料 ¥' + fee.toLocaleString("ja-JP") +
        (isTeam ? " / チーム" : (isDoubles ? " / ペア" : " / 人")) + '</span>' +
      '<span class="count-badge" id="count_' + idx + '">0 ' + unit + '</span>' +
      '</summary>' +
      '<div class="members" id="members_' + idx + '"></div>' +
      '<div class="add-buttons">' +
        '<button type="button" class="btn-add" onclick="addEntry(' + idx + ')">' +
          '+ ' + unit + 'を1つ追加</button>' +
        (isTeam ? '' :
          '<button type="button" class="btn-add btn-add-bulk" onclick="addEntryBulk(' + idx + ', 5)">' +
          '+ 5' + unit + 'を一括追加</button>') +
      '</div>';
    c.appendChild(det);
    // ★ 初期1行をプリ表示 (空行で何をすればいいか分かりやすく)
    addEntry(idx);
  });
}

// 複数行を一括追加 (まとめて担当者が登録するため)
function addEntryBulk(eventIdx, n) {
  for (let i = 0; i < n; i++) addEntry(eventIdx);
}

// 担当者所属を全選手の所属欄に一括反映
function applyTeamNameToAll() {
  const teamName = (document.querySelector('input[name="team_name"]') || {}).value || "";
  if (!teamName) return;
  document.querySelectorAll('input[name*="_team"]').forEach(inp => {
    if (!inp.value || inp.value === "") {
      inp.value = teamName;
    }
  });
  recalcTotal();
}

// 種目別の現在エントリー数を画面に反映 (記入済みのみカウント)
function updateCounts() {
  EVENTS.forEach((ev, idx) => {
    const container = document.getElementById("members_" + idx);
    const badge = document.getElementById("count_" + idx);
    if (!container || !badge) return;
    let filled = 0;
    Array.from(container.children).forEach((row) => {
      let hasContent = false;
      if (ev.type === "team") {
        const tn = row.querySelector('input[name$="_name"]');
        const members = row.querySelectorAll('input[name*="_m"]');
        if (tn && tn.value.trim()) hasContent = true;
        Array.from(members).forEach(m => { if (m.value.trim()) hasContent = true; });
      } else if (ev.type === "doubles") {
        const n1 = row.querySelector('input[name*="_n1"]');
        const n2 = row.querySelector('input[name*="_n2"]');
        if ((n1 && n1.value.trim()) || (n2 && n2.value.trim())) hasContent = true;
      } else {
        const n = row.querySelector('input[name*="_name"]');
        if (n && n.value.trim()) hasContent = true;
      }
      if (hasContent) filled++;
    });
    const unit = ev.type === "team" ? "チーム" : (ev.type === "doubles" ? "ペア" : "選手");
    badge.textContent = filled + " " + unit;
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
    html += '<input type="text" name="ev' + eventIdx + '_team' + idx + '_name" placeholder="チーム名" oninput="recalcTotal()" style="width:100%; margin-bottom:6px; padding:6px;" />';
    const per = ev.per_team || 6;
    for (let i = 0; i < per; i++) {
      html += '<input type="text" name="ev' + eventIdx + '_team' + idx + '_m' + i + '" placeholder="メンバー' + (i + 1) + ' 氏名" oninput="recalcTotal()" style="width:100%; margin-bottom:4px; padding:6px; font-size:12px;" />';
    }
  } else if (isDoubles) {
    // 選手1 (氏名 + 所属) / 選手2 (氏名 + 所属) — 違うチーム同士のペアにも対応
    html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:4px;">' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_n1" placeholder="選手1 氏名" oninput="recalcTotal()" style="padding:6px;" />' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_t1" placeholder="選手1 所属" oninput="recalcTotal()" style="padding:6px; font-size:12px;" />' +
      '</div>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_n2" placeholder="選手2 氏名" oninput="recalcTotal()" style="padding:6px;" />' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_t2" placeholder="選手2 所属" oninput="recalcTotal()" style="padding:6px; font-size:12px;" />' +
      '</div>';
  } else {
    html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">' +
      '<input type="text" name="ev' + eventIdx + '_p' + idx + '_name" placeholder="氏名 (フルネーム)" oninput="recalcTotal()" style="padding:6px;" />' +
      '<input type="text" name="ev' + eventIdx + '_p' + idx + '_team" placeholder="所属" oninput="recalcTotal()" style="padding:6px; font-size:12px;" />' +
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
    // ★ 空入力行はカウントしない (氏名 or チーム名が1文字以上ある行のみ)
    let filled = 0;
    Array.from(container.children).forEach((row) => {
      let hasContent = false;
      if (ev.type === "team") {
        const tn = row.querySelector('input[name*="_team"][name$="_name"]');
        const members = row.querySelectorAll('input[name*="_m"]');
        if (tn && tn.value.trim()) hasContent = true;
        Array.from(members).forEach(m => { if (m.value.trim()) hasContent = true; });
      } else if (ev.type === "doubles") {
        const n1 = row.querySelector('input[name*="_n1"]');
        const n2 = row.querySelector('input[name*="_n2"]');
        if ((n1 && n1.value.trim()) || (n2 && n2.value.trim())) hasContent = true;
      } else {
        const n = row.querySelector('input[name*="_name"]');
        if (n && n.value.trim()) hasContent = true;
      }
      if (hasContent) filled++;
    });
    total += filled * (ev.fee || 0);
  });
  document.getElementById("totalAmount").textContent = total.toLocaleString("ja-JP");
  // ★ 種目ごとのカウント表示も更新 (記入済みのみ)
  updateCounts();
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
        obj.team1 = (row.querySelector("input[name^='ev" + idx + "_pair" + ri + "_t1']") || {}).value || "";
        obj.team2 = (row.querySelector("input[name^='ev" + idx + "_pair" + ri + "_t2']") || {}).value || "";
        obj.team = obj.team1; // 後方互換
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

  return data;
}

// 申込内容を平文サマリーに変換 (LINE共有・コピー用)
function buildSummaryText(data) {
  const lines = [];
  lines.push("【" + TOURNAMENT_NAME + "】 申込内容");
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("団体: " + (data.team_name || ""));
  lines.push("担当: " + (data.contact_name || ""));
  if (data.contact_tel) lines.push("電話: " + data.contact_tel);
  if (data.contact_email) lines.push("メール: " + data.contact_email);
  lines.push("");
  lines.push("【申込内容】");
  data.entries.forEach((e, i) => {
    if (e.type === "team") {
      const members = (e.members || []).join("、");
      lines.push("・[団体] " + e.event);
      lines.push("    " + (e.team_name || "") + ": " + members);
      lines.push("    参加料 ¥" + (e.fee || 0).toLocaleString("ja-JP"));
    } else if (e.type === "doubles") {
      lines.push("・[ダブルス] " + e.event);
      lines.push("    " + (e.name1 || "") + " (" + (e.team1 || e.team || "") + ")");
      lines.push("    " + (e.name2 || "") + " (" + (e.team2 || e.team1 || e.team || "") + ")");
      lines.push("    参加料 ¥" + (e.fee || 0).toLocaleString("ja-JP"));
    } else {
      lines.push("・" + e.event + ": " + (e.name || "") + " (" + (e.team || "") + ")");
      lines.push("    参加料 ¥" + (e.fee || 0).toLocaleString("ja-JP"));
    }
  });
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push("合計: ¥" + (data.total_amount || 0).toLocaleString("ja-JP"));
  lines.push("");
  lines.push("※当日、開会式前に受付で参加料をお支払いください。");
  return lines.join("\\n");
}

// 確認モーダルを表示
function showConfirmModal(data) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "confirm-overlay";
    let entriesHTML = "";
    data.entries.forEach((e, i) => {
      let memberText = "";
      if (e.type === "team") {
        memberText = "[団体] " + (e.team_name || "") + " (" + (e.members || []).join("、") + ")";
      } else if (e.type === "doubles") {
        memberText = (e.name1 || "") + " / " + (e.name2 || "") + " (" + (e.team || "") + ")";
      } else {
        memberText = (e.name || "") + " (" + (e.team || "") + ")";
      }
      entriesHTML +=
        '<tr><td class="label">' + escapeHtml(e.event) + '</td>' +
        '<td class="val">' + escapeHtml(memberText) +
          ' <span style="color:#b91c1c;font-weight:bold;">¥' +
          (e.fee || 0).toLocaleString("ja-JP") + '</span></td></tr>';
    });
    ov.innerHTML =
      '<div class="confirm-modal">' +
      '<h3>申込内容のご確認</h3>' +
      '<div style="font-size:13px;color:#57534e;margin-bottom:10px;">' +
        '送信前に内容をご確認ください。修正する場合は「戻る」を押してください。</div>' +
      '<table>' +
      '<tr><td class="label">団体</td><td class="val">' + escapeHtml(data.team_name || "") + '</td></tr>' +
      '<tr><td class="label">担当者</td><td class="val">' + escapeHtml(data.contact_name || "") + '</td></tr>' +
      (data.contact_tel ? '<tr><td class="label">電話</td><td class="val">' + escapeHtml(data.contact_tel) + '</td></tr>' : '') +
      (data.contact_email ? '<tr><td class="label">メール</td><td class="val">' + escapeHtml(data.contact_email) + '</td></tr>' : '') +
      '</table>' +
      '<div style="margin-top:14px;font-size:13px;font-weight:bold;color:#57534e;">申込内容 (' + data.entries.length + '件)</div>' +
      '<table>' + entriesHTML + '</table>' +
      '<div class="total"><div>合計参加料</div><div class="amount">¥' +
        (data.total_amount || 0).toLocaleString("ja-JP") + '</div></div>' +
      '<div class="buttons">' +
      '<button type="button" class="btn-cancel">戻って修正</button>' +
      '<button type="button" class="btn-confirm">この内容で送信する</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    ov.querySelector(".btn-cancel").onclick = () => { ov.remove(); resolve(false); };
    ov.querySelector(".btn-confirm").onclick = () => { ov.remove(); resolve(true); };
  });
}

async function submitForm(e) {
  e.preventDefault();
  const data = gatherFormData();
  if (data.entries.length === 0) {
    showMessage("少なくとも 1 種目に 1名以上の参加者を登録してください。", "err");
    return false;
  }
  // ★ 確認モーダルを表示
  const ok = await showConfirmModal(data);
  if (!ok) return false;

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
      // ★ 送信成功 → LINE 共有用コピーカードを表示
      const summary = buildSummaryText(data);
      const card = document.createElement("div");
      card.className = "success-card";
      card.innerHTML =
        '<h3>申込を受け付けました</h3>' +
        '<div style="text-align:center;font-size:13px;color:#14532d;line-height:1.7;">' +
          'ご登録のメールアドレス宛に控えメールを送信しました。<br>' +
          'お申込内容をLINE等で関係者と共有する場合は、下記をコピーしてご利用ください。' +
        '</div>' +
        '<div class="summary-text" id="ttSummaryText">' + escapeHtml(summary) + '</div>' +
        '<button type="button" class="copy-btn" id="ttCopyBtn">クリップボードにコピー (LINE等で共有可)</button>' +
        '<button type="button" class="copy-btn" id="ttNewBtn" ' +
          'style="margin-top:8px;background:#78716c;">新しく申込みする (リセット)</button>';
      document.getElementById("messageBox").innerHTML = "";
      document.getElementById("messageBox").appendChild(card);
      // フォームを隠す
      document.getElementById("entryForm").querySelectorAll(".form-section").forEach(s => s.style.display = "none");
      document.getElementById("submitBtn").style.display = "none";
      // コピーボタン
      document.getElementById("ttCopyBtn").onclick = async function() {
        try {
          await navigator.clipboard.writeText(summary);
          this.textContent = "コピーしました ✓";
          this.classList.add("copied");
          setTimeout(() => {
            this.textContent = "クリップボードにコピー (LINE等で共有可)";
            this.classList.remove("copied");
          }, 2500);
        } catch (e) {
          // フォールバック: textarea 経由で選択
          const ta = document.createElement("textarea");
          ta.value = summary; document.body.appendChild(ta);
          ta.select(); document.execCommand("copy"); ta.remove();
          this.textContent = "コピーしました ✓";
        }
      };
      // 新規申込ボタン
      document.getElementById("ttNewBtn").onclick = function() {
        document.getElementById("entryForm").reset();
        document.getElementById("entryForm").querySelectorAll(".form-section").forEach(s => s.style.display = "");
        document.getElementById("submitBtn").style.display = "";
        document.getElementById("messageBox").innerHTML = "";
        renderEvents();
        recalcTotal();
        window.scrollTo({ top: 0, behavior: "smooth" });
      };
      window.scrollTo({ top: 0, behavior: "smooth" });
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

module.exports = {
  buildEntryFormHTML,
};
