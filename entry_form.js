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
    tournDate: (() => {
      if (!tournament.date) return "";
      const dt = new Date(tournament.date);
      // date は自由記入TEXT。非ISO値(例「未定」)だと Invalid Date になるため、reports.js 同様 isNaN でガードし
      // そのまま表示する。tournDate はテンプレートで未エスケープ展開されるため、passthrough は escapeHtml する (#16)。
      return isNaN(dt.getTime())
        ? escapeHtml(String(tournament.date))
        : dt.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
    })(),
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
  const turnstileSitekey = opts.turnstile_sitekey || "";   // 設定時のみ Turnstile ウィジェットを表示
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
    // 中高校生料金 (空/未設定なら一般と同額)。数値化し、未設定は null にして「一般と同じ」と判定。
    fee_student: (e.fee_student != null && e.fee_student !== "" && !isNaN(parseInt(e.fee_student)))
      ? (parseInt(e.fee_student) || 0) : null,
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
<script>
/* ── 埋込安全網: 何が起きても真っ白(クラッシュ)にせず、利用者に分かる案内を出す ──
   Jimdo/STUDIO 等への iframe 埋込で稀に発生する初期化/通信エラーを捕捉し、
   再読み込み導線を提示する。最初の<script>として最優先で設置。*/
(function () {
  function showFatal(msg) {
    try {
      var b = document.getElementById("ttFatal");
      if (!b) {
        b = document.createElement("div");
        b.id = "ttFatal";
        b.style.cssText = "margin:16px;padding:14px 16px;background:#fef2f2;" +
          "border:2px solid #dc2626;border-radius:8px;color:#7f1d1d;" +
          "font-family:'Hiragino Sans','Yu Gothic UI',system-ui,sans-serif;" +
          "font-size:14px;line-height:1.7;max-width:840px;margin-left:auto;margin-right:auto";
        var host = document.body || document.documentElement;
        host.insertBefore(b, host.firstChild);
      }
      b.innerHTML =
        "<strong>申込フォームの読み込みで問題が発生しました。</strong><br>" +
        "お手数ですが「再読み込み」を押すか、時間をおいて再度お試しください。" +
        "繰り返す場合は大会主催者へお知らせください。" +
        "<div style='margin-top:10px'><button type='button' onclick='location.reload()' " +
        "style='padding:8px 16px;border:0;border-radius:6px;background:#dc2626;color:#fff;" +
        "font-weight:700;cursor:pointer'>再読み込み</button></div>" +
        "<div style='margin-top:6px;font-size:11px;color:#9ca3af'>" +
        (msg ? String(msg).slice(0, 200).replace(/[<>&]/g, " ") : "") + "</div>";
    } catch (_) {}
  }
  window.__ttShowFatal = showFatal;
  window.addEventListener("error", function (e) {
    showFatal(e && (e.message || (e.error && e.error.message)));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason; showFatal(r && (r.message || r) || "通信エラー");
  });
})();
</script>
<style>
  /* ───────────────────────────────────────────────
     丹頂エディトリアル — 釧路卓球協会 申込フォーム
     温かみのある紙 × 丹頂レッド × 墨。明朝の見出し + ゴシック本文。
     システムフォントのみ (HTTPS/Jimdo/STUDIO/CSP 準拠)。
     ─────────────────────────────────────────────── */
  :root {
    --paper:   #f1e9d9;
    --card:    #fffdf8;
    --card-2:  #fbf6ec;
    --ink:     #211b15;
    --ink-2:   #6c6153;
    --line:    #e4d8c2;
    --line-2:  #efe6d4;
    --red:     #c01526;   /* 丹頂レッド */
    --red-2:   #9c0f1c;
    --amber:   #9a6a10;
    --amber-bg:#f6ebcd;
    --green:   #1a7a45;
    --green-bg:#e9f7ee;
    --gothic:  'Hiragino Sans','BIZ UDPGothic','Yu Gothic UI','Yu Gothic','Meiryo',system-ui,sans-serif;
    --mincho:  'Hiragino Mincho ProN','Yu Mincho','YuMincho','Hiragino Mincho Pro',serif;
    --shadow:  0 18px 44px -22px rgba(48,32,16,.45);
    --radius:  16px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: var(--gothic);
    color: var(--ink);
    line-height: 1.78;
    font-size: 16.5px;
    letter-spacing: .005em;
    padding: 30px 16px 48px;
    max-width: 768px; margin: 0 auto;
    background-color: var(--paper);
    background-image:
      radial-gradient(1100px 520px at 108% -8%, rgba(192,21,38,.07), transparent 58%),
      radial-gradient(900px 520px at -12% 112%, rgba(154,106,16,.08), transparent 58%);
    -webkit-font-smoothing: antialiased;
  }
  /* かすかな紙の粒状感 */
  body::before {
    content:""; position:fixed; inset:0; z-index:-1; pointer-events:none; opacity:.6;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.04'/%3E%3C/svg%3E");
  }
  @keyframes ttRise { from { opacity:0; transform: translateY(14px); } to { opacity:1; transform:none; } }

  /* ── ヘッダー (大会プログラム風バナー) ── */
  .form-header {
    position: relative; overflow: hidden;
    background: linear-gradient(155deg, #241d16 0%, #36281c 60%, #2c2118 100%);
    color: #f6efe2;
    padding: 34px 34px 30px;
    border-radius: var(--radius) var(--radius) 0 0;
    border-top: 5px solid var(--red);
    animation: ttRise .5s ease both;
  }
  .form-header::after {
    content:""; position:absolute; left:0; right:0; bottom:0; height:3px;
    background: linear-gradient(90deg, var(--red), #d4a017 70%, transparent);
    opacity:.85;
  }
  .form-header-art {
    position: absolute; right: -6px; top: -6px;
    width: 224px; height: 116px; opacity: .9; pointer-events: none;
    filter: drop-shadow(0 4px 12px rgba(0,0,0,.25));
  }
  .form-header-art svg { width: 100%; height: 100%; }
  .form-header h1 {
    font-family: var(--mincho);
    font-size: 34px; font-weight: 700; line-height: 1.25;
    letter-spacing: .02em;
    position: relative; z-index: 1;
    text-wrap: balance;
  }
  .form-header .seal {
    display: inline-block; vertical-align: middle;
    background: var(--red); color: #fff;
    font-family: var(--gothic);
    font-size: 11px; font-weight: 800;
    padding: 5px 11px; border-radius: 4px;
    margin-right: 12px; letter-spacing: .22em;
    box-shadow: 0 2px 0 rgba(0,0,0,.25);
  }
  .form-header .meta {
    font-family: var(--gothic);
    font-size: 13.5px; color: #d8cdba; margin-top: 12px;
    position: relative; z-index: 1; letter-spacing: .04em;
  }

  /* ── 本文セクション ── */
  .form-section {
    background: var(--card);
    padding: 28px 30px;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    animation: ttRise .5s ease both;
  }
  .form-section:nth-of-type(2){ animation-delay:.05s; }
  .form-section:nth-of-type(3){ animation-delay:.1s; }
  .form-section:last-of-type {
    border-radius: 0 0 var(--radius) var(--radius);
    border-bottom: 1px solid var(--line);
    padding-bottom: 30px;
    box-shadow: var(--shadow);
  }
  .form-section h2 {
    font-family: var(--mincho);
    font-size: 21px; font-weight: 700;
    margin-bottom: 18px; color: var(--ink);
    display: flex; align-items: center; gap: 11px;
    letter-spacing: .03em;
  }
  .form-section h2::before {
    content:""; width: 6px; height: 22px; border-radius: 2px;
    background: linear-gradient(var(--red), var(--red-2));
    box-shadow: 0 1px 4px rgba(192,21,38,.4);
  }

  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .form-row.full { grid-template-columns: 1fr; }
  .form-row label {
    display: block; font-size: 12.5px; font-weight: 800;
    color: var(--ink-2); margin-bottom: 7px; letter-spacing: .08em;
  }
  .form-row label .required {
    background: var(--red); color: #fff;
    font-size: 11px; padding: 2px 7px; border-radius: 3px;
    margin-left: 7px; letter-spacing: .12em; vertical-align: 1px;
  }
  .form-row input[type="text"],
  .form-row input[type="email"],
  .form-row input[type="tel"],
  .form-row input[type="number"],
  .form-row select,
  .form-row textarea {
    width: 100%; padding: 13px 15px;
    border: 1.5px solid var(--line); border-radius: 9px;
    font-family: inherit; font-size: 16px;
    background: var(--card-2); color: var(--ink);
    transition: border-color .15s, box-shadow .15s, background .15s;
  }
  .form-row input:focus, .form-row select:focus, .form-row textarea:focus {
    outline: none; border-color: var(--red);
    box-shadow: 0 0 0 4px rgba(192,21,38,.12);
    background: #fff;
  }
  .form-row input::placeholder, .form-row textarea::placeholder { color: #8a7a64; }
  input:user-invalid { border-color: var(--red); background: #fff7f7; }

  /* ── 追加ボタン / カウント ── */
  .btn-add {
    background: #fff; color: var(--amber);
    border: 1.5px dashed #d9c8a8;
    padding: 12px 20px; border-radius: 9px;
    cursor: pointer; font-size: 14.5px; font-weight: 800;
    font-family: inherit; transition: all .15s;
  }
  .btn-add:hover { background: var(--amber-bg); border-color: var(--amber); transform: translateY(-1px); }
  .btn-add-bulk { background: var(--amber-bg); border-style: solid; border-color: #e0b75a; }
  .btn-add-bulk:hover { background: #f0e0b8; }
  .add-buttons { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
  .count-badge {
    display: inline-flex; align-items:center; margin-left: auto;
    padding: 4px 12px; background: var(--green-bg);
    color: var(--green); border: 1px solid #aee3c2;
    border-radius: 999px; font-size: 11.5px; font-weight: 800;
    font-family: var(--gothic); letter-spacing: .04em;
  }

  /* ── 種目ブロック ── */
  .event-block {
    border: 1.5px solid var(--line); border-radius: 13px;
    padding: 18px 20px; margin-bottom: 14px;
    background: var(--card);
    box-shadow: 0 2px 0 var(--line-2);
  }
  .event-block[open] { border-color: #d8c6a6; box-shadow: 0 6px 22px -14px rgba(160,90,16,.4); }
  .event-block summary {
    cursor: pointer; font-weight: 800;
    font-size: 16px; font-family: var(--gothic);
    list-style: none; outline: none;
    display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
    letter-spacing: .02em;
  }
  .event-block summary::-webkit-details-marker { display: none; }
  .event-block summary::before {
    content: "+"; display: inline-flex;
    align-items: center; justify-content: center;
    width: 26px; height: 26px; margin-right: 12px;
    background: linear-gradient(var(--red), var(--red-2)); color: #fff;
    border-radius: 7px; font-size: 17px; font-weight: 700;
    box-shadow: 0 2px 6px rgba(192,21,38,.35);
    transition: transform .2s;
  }
  .event-block[open] summary::before { content: "−"; }
  .event-block .members { margin-top: 16px; }
  .entry-row {
    background: var(--card-2);
    border: 1.5px solid var(--line-2);
    border-left: 4px solid #d6c8ab;
    border-radius: 10px;
    padding: 14px 16px; margin-bottom: 10px;
    transition: border-color .15s, box-shadow .15s;
    animation: ttRise .3s ease both;
  }
  .entry-row:hover { border-left-color: var(--red); box-shadow: 0 4px 16px -10px rgba(192,21,38,.3); }
  .entry-row .row-head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .entry-row .row-head .num {
    font-weight:800; font-size:13px; color:#fff;
    background: linear-gradient(var(--red),var(--red-2));
    width:24px; height:24px; border-radius:50%;
    display:inline-flex; align-items:center; justify-content:center;
  }
  .entry-grid { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
  .entry-row input[type="text"] {
    width:100%; padding:12px 14px;
    border:1.5px solid var(--line); border-radius:9px;
    font-size:15.5px; background:#fff; color:var(--ink);
    font-family:inherit; transition:border-color .15s, box-shadow .15s;
  }
  .entry-row input[type="text"]:focus { outline:none; border-color:var(--red); box-shadow:0 0 0 3px rgba(192,21,38,.13); }
  .entry-row input[type="text"]::placeholder { color:#8a7a64; }

  /* ── 参加区分セグメント (一般 / 中学生 / 高校生) ── */
  .div-seg {
    display: flex; gap: 6px; margin: 4px 0 12px;
    background: #f0e7d6; padding: 4px; border-radius: 11px;
    border: 1px solid var(--line);
  }
  .div-seg .seg { flex: 1; position: relative; cursor: pointer; }
  .div-seg .seg input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
  .div-seg .seg span {
    display: flex; flex-direction: column; align-items: center; gap: 1px;
    padding: 8px 4px; border-radius: 8px; text-align: center;
    font-size: 13.5px; font-weight: 800; color: var(--ink-2);
    transition: all .15s; line-height: 1.25;
  }
  .div-seg .seg span small { font-size: 11px; font-weight: 700; color: #a99a80; }
  .div-seg .seg input:checked + span {
    background: #fff; color: var(--red);
    box-shadow: 0 2px 8px -2px rgba(192,21,38,.35);
  }
  .div-seg .seg input:checked + span small { color: var(--red); }
  .div-seg .seg input:focus-visible + span { box-shadow: 0 0 0 3px rgba(192,21,38,.25); }
  .div-label { font-size: 11.5px; font-weight: 800; color: var(--ink-2); letter-spacing: .08em; margin-bottom: 2px; }

  .fee-tag {
    display: inline-flex; align-items:center;
    padding: 4px 12px; background: var(--amber-bg);
    color: var(--amber); border: 1px solid #e7d3a4;
    border-radius: 999px; font-size: 11.5px; font-weight: 800;
    margin-left: 10px; font-family: var(--gothic); letter-spacing: .03em;
  }

  .btn-del {
    background: transparent; color: var(--red);
    border: 1px solid #ecc6c6; padding: 4px 11px;
    border-radius: 6px; cursor: pointer; font-size: 11.5px;
    font-weight: 700; font-family: inherit; transition: all .15s;
  }
  .btn-del:hover { background: #fbe9e9; border-color: var(--red); }

  /* ── 合計 ── */
  .total-box {
    background: linear-gradient(150deg, #fffdf8, #faf2e3);
    border: 2px solid var(--amber);
    border-radius: 13px;
    padding: 20px 24px; margin: 22px 0;
    display: flex; justify-content: space-between; align-items: center;
    position: relative; overflow: hidden;
    box-shadow: 0 8px 26px -16px rgba(160,90,16,.5);
  }
  .total-box::before {
    content:""; position:absolute; top:-30px; right:-20px;
    width: 120px; height: 120px;
    background: radial-gradient(circle, rgba(192,21,38,.1) 30%, transparent 70%);
  }
  .total-box .label {
    font-family: var(--mincho);
    font-size: 16px; font-weight: 700; color: var(--amber); letter-spacing: .06em;
  }
  .total-box .amount {
    font-family: var(--mincho);
    font-size: 38px; font-weight: 700; color: var(--red);
    letter-spacing: .01em; line-height: 1; position: relative; z-index: 1;
    font-variant-numeric: tabular-nums;
  }

  /* ── 送信ボタン ── */
  .submit-btn {
    width: 100%; padding: 19px;
    font-size: 17px; font-weight: 800;
    font-family: var(--gothic);
    background: linear-gradient(var(--red), var(--red-2)); color: #fff;
    border: none; border-radius: 11px;
    cursor: pointer; margin-top: 20px;
    letter-spacing: .2em;
    transition: transform .12s, box-shadow .15s, filter .15s;
    box-shadow: 0 10px 24px -10px rgba(192,21,38,.6);
  }
  .submit-btn:hover { transform: translateY(-2px); filter: brightness(1.05); box-shadow: 0 14px 30px -10px rgba(192,21,38,.7); }
  .submit-btn:active { transform: translateY(0); }
  .submit-btn:disabled { background: #b9ad9c; cursor: not-allowed; transform: none; box-shadow: none; filter: none; }
  /* 送信中: グレーアウトでなく赤を保ち、回転スピナーを表示(処理中であることを明確に) */
  .submit-btn.is-sending, .submit-btn.is-sending:disabled {
    background: linear-gradient(var(--red), var(--red-2)); color: #fff;
    cursor: progress; opacity: .92; box-shadow: 0 10px 24px -10px rgba(192,21,38,.6); filter: none;
  }
  .btn-spinner {
    display: inline-block; box-sizing: border-box;
    width: 1.25em; height: 1.25em; vertical-align: -0.2em;
    border: 2.6px solid currentColor; border-right-color: transparent; border-radius: 50%;
    animation: ttSpin .7s linear infinite;
  }
  @keyframes ttSpin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .btn-spinner { animation-duration: 1.6s; } }

  .notice {
    background: var(--card-2);
    border-left: 4px solid var(--amber);
    padding: 13px 18px; font-size: 13px; margin: 16px 0;
    border-radius: 0 8px 8px 0; color: var(--ink-2);
  }
  .message {
    padding: 18px; margin: 16px 0;
    border-radius: 10px; text-align: center;
    font-weight: 800; font-size: 15.5px; font-family: var(--gothic);
  }
  .message.ok  { background: var(--green-bg); color: var(--green); border: 1px solid #aee3c2; }
  .message.err { background: #fbeaea; color: #8c1118; border: 1px solid #f0b9bb; }

  /* ── 確認 / 完了 ── */
  .confirm-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(33,27,21,.6); display: flex;
    align-items: center; justify-content: center; padding: 20px;
  }
  .confirm-modal {
    background: var(--card); max-width: 580px; width: 100%;
    max-height: 88vh; overflow: auto;
    border-radius: 16px; padding: 26px 28px;
    box-shadow: 0 30px 70px rgba(20,12,4,.4);
    font-family: var(--gothic);
    border-top: 5px solid var(--red);
  }
  .confirm-modal h3 {
    font-family: var(--mincho);
    font-size: 21px; margin-bottom: 16px; color: var(--ink);
    border-bottom: 2px solid var(--line); padding-bottom: 12px;
    letter-spacing: .03em;
  }
  .confirm-modal table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
  .confirm-modal td { padding: 8px 8px; border-bottom: 1px solid var(--line-2); vertical-align: top; }
  .confirm-modal td.label { color: var(--ink-2); width: 84px; font-weight: 700; }
  .confirm-modal td.val { font-weight: 700; }
  .confirm-modal .total {
    margin-top: 18px; padding: 16px 18px;
    background: linear-gradient(150deg, var(--amber-bg), #fbf2dc);
    border-radius: 10px; display: flex; justify-content: space-between;
    align-items: center; font-size: 15px;
  }
  .confirm-modal .total .amount {
    font-family: var(--mincho);
    font-size: 30px; font-weight: 700; color: var(--red);
    font-variant-numeric: tabular-nums;
  }
  .confirm-modal .buttons { display: flex; gap: 10px; margin-top: 20px; }
  .confirm-modal .buttons button {
    flex: 1; padding: 14px; border-radius: 10px;
    border: none; cursor: pointer; font-size: 14.5px;
    font-weight: 800; font-family: inherit; transition: filter .15s, transform .12s;
  }
  .confirm-modal .buttons button:hover { filter: brightness(1.04); transform: translateY(-1px); }
  .confirm-modal .btn-cancel { background: #efe7d6; color: var(--ink); }
  .confirm-modal .btn-confirm { background: linear-gradient(var(--red), var(--red-2)); color: #fff; }
  .confirm-modal .btn-confirm:disabled { background: #b9ad9c; cursor: wait; }
  .confirm-inline { max-width: 580px; margin: 8px auto 22px; animation: ttRise .35s ease both; }
  .confirm-inline .confirm-modal { max-height: none; box-shadow: var(--shadow); }

  .success-card {
    margin: 22px 0; padding: 24px;
    background: linear-gradient(150deg, var(--green-bg) 0%, #eafaf0 100%);
    border: 2px solid var(--green); border-radius: 14px;
    animation: ttRise .4s ease both;
  }
  .success-card h3 {
    font-family: var(--mincho);
    font-size: 21px; color: var(--green); margin-bottom: 12px; text-align: center;
  }
  .success-card .summary-text {
    background: #fff; padding: 16px;
    border-radius: 9px; font-size: 12.5px; line-height: 1.8;
    white-space: pre-wrap; word-break: break-word;
    font-family: var(--gothic);
    margin: 14px 0; max-height: 220px; overflow-y: auto;
    border: 1px solid #c9ecd6;
  }
  .copy-btn {
    width: 100%; padding: 14px; border-radius: 10px;
    background: var(--green); color: #fff; border: none;
    cursor: pointer; font-size: 14.5px; font-weight: 800; font-family: inherit;
    transition: filter .15s;
  }
  .copy-btn:hover { filter: brightness(1.06); }
  .copy-btn.copied { background: #14633a; }
  /* Phase4: 申込番号(本人が後から確認するためのチケット) */
  .ticket {
    margin: 6px 0 16px; padding: 16px 18px; text-align: center;
    background: var(--card); border: 2px dashed var(--red);
    border-radius: 12px; position: relative;
  }
  .ticket-label {
    font-family: var(--gothic); font-size: 11px; font-weight: 800;
    letter-spacing: .18em; color: var(--red); text-transform: uppercase;
  }
  .ticket-code {
    font-family: 'SFMono-Regular','Menlo','Consolas',monospace;
    font-size: 26px; font-weight: 800; letter-spacing: .12em;
    color: var(--ink); margin: 6px 0 8px; user-select: all;
  }
  .ticket-note { font-family: var(--gothic); font-size: 11.5px; color: var(--ink-2); line-height: 1.7; }
  .ticket-link {
    display: inline-block; margin-top: 11px; padding: 9px 18px;
    background: var(--red); color: #fff; border-radius: 8px;
    font-size: 13px; font-weight: 800; text-decoration: none; font-family: var(--gothic);
  }
  .ticket-link:hover { background: var(--red-2); }

  /* ── フッター ── */
  .form-footer {
    text-align: center; margin-top: 28px; padding: 22px;
    color: var(--ink-2); font-size: 11.5px;
  }
  .form-footer .org {
    font-family: var(--mincho);
    font-size: 14px; font-weight: 700; color: var(--ink);
    margin-bottom: 5px; letter-spacing: .14em;
  }

  /* ── レスポンシブ ── */
  @media (max-width: 600px) {
    body { padding: 16px 10px 36px; font-size: 16px; }
    .form-header { padding: 26px 20px 24px; }
    .form-header h1 { font-size: 27px; }
    .form-header-art { width: 150px; height: 80px; opacity: .8; }
    .form-section { padding: 22px 17px; }
    .form-row { grid-template-columns: 1fr; gap: 12px; margin-bottom: 13px; }
    .entry-grid { grid-template-columns: 1fr; }
    .total-box { padding: 16px 18px; }
    .total-box .amount { font-size: 30px; }
    .div-seg .seg span { font-size: 12.5px; }
  }
</style>
${turnstileSitekey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
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

<!-- ハニーポット: 人間には不可視。ボットが埋めるとサーバーで弾く (スパム対策) -->
<div aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden">
  <label>この欄は空のままにしてください<input type="text" name="hp_url" tabindex="-1" autocomplete="off"></label>
</div>
${turnstileSitekey ? '<div class="cf-turnstile" data-sitekey="' + escapeHtml(turnstileSitekey) + '" style="margin:14px 0"></div>' : ''}
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
const SUBMIT_URL = ${escapeJs(gasUrl)};  // 送信先。原則 同一オリジン(自サーバー)。サーバーが必要に応じGASへ中継。
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
    const hasStuFee = (ev.fee_student != null && ev.fee_student !== fee);   // 中高生に別料金がある種目
    const feeStu = hasStuFee ? ev.fee_student : fee;
    const unit = isTeam ? "チーム" : (isDoubles ? "ペア" : "選手");
    const unitSfx = isTeam ? " / チーム" : (isDoubles ? " / ペア" : " / 人");
    const feeTagHtml = hasStuFee
      ? '一般 ¥' + fee.toLocaleString("ja-JP") + ' ／ 中高生 ¥' + feeStu.toLocaleString("ja-JP") + unitSfx
      : '参加料 ¥' + fee.toLocaleString("ja-JP") + unitSfx;
    det.innerHTML = '<summary>' +
      escapeHtml(ev.name) +
      '<span class="fee-tag">' + feeTagHtml + '</span>' +
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

  // 中高校生に別料金がある種目だけ、行ごとに参加区分セグメント(一般/中学生/高校生)を出す。
  // 選んだ区分で料金が変動 (中学生・高校生は fee_student)。グループ名はグローバル一意にする。
  const hasStuFee = (ev.fee_student != null && ev.fee_student !== (ev.fee || 0));
  const seq = (window.__ttSeq = (window.__ttSeq || 0) + 1);
  let divSeg = "";
  if (hasStuFee) {
    const opts = [["general", "一般", ev.fee || 0],
                  ["middle", "中学生", ev.fee_student || 0],
                  ["high", "高校生", ev.fee_student || 0]];
    divSeg = '<div class="div-label">参加区分を選択してください</div>' +
      '<div class="div-seg" role="radiogroup" aria-label="参加区分">' +
      opts.map(function (o, i) {
        return '<label class="seg"><input type="radio" name="ttdiv' + seq + '" value="' + o[0] + '"' +
          (i === 0 ? ' checked' : '') + ' onchange="recalcTotal()">' +
          '<span>' + o[1] + '<small>¥' + o[2].toLocaleString("ja-JP") + '</small></span></label>';
      }).join('') + '</div>';
  }

  let html = '<div class="row-head"><span class="num">' + (idx + 1) + '</span>' +
    '<button type="button" class="btn-del" onclick="removeEntry(this, ' + eventIdx + ')">削除</button></div>';

  if (isTeam) {
    html += '<input type="text" name="ev' + eventIdx + '_team' + idx + '_name" placeholder="チーム名" aria-label="チーム名" oninput="recalcTotal()" style="margin-bottom:9px;" />';
    const per = ev.per_team || 6;
    html += '<div class="entry-grid">';
    for (let i = 0; i < per; i++) {
      html += '<input type="text" name="ev' + eventIdx + '_team' + idx + '_m' + i + '" placeholder="メンバー' + (i + 1) + ' 氏名" aria-label="メンバー' + (i + 1) + ' 氏名" oninput="recalcTotal()" />';
    }
    html += '</div>';
  } else if (isDoubles) {
    html += '<div class="entry-grid">' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_n1" placeholder="選手1 氏名" aria-label="選手1 氏名" oninput="recalcTotal()" />' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_t1" placeholder="選手1 所属" aria-label="選手1 所属" oninput="recalcTotal()" />' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_n2" placeholder="選手2 氏名" aria-label="選手2 氏名" oninput="recalcTotal()" />' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_t2" placeholder="選手2 所属" aria-label="選手2 所属" oninput="recalcTotal()" />' +
      '</div>';
  } else {
    html += '<div class="entry-grid">' +
      '<input type="text" name="ev' + eventIdx + '_p' + idx + '_name" placeholder="氏名 (フルネーム)" aria-label="氏名 (フルネーム)" oninput="recalcTotal()" />' +
      '<input type="text" name="ev' + eventIdx + '_p' + idx + '_team" placeholder="所属" aria-label="所属" oninput="recalcTotal()" />' +
      '</div>';
  }
  html += divSeg;
  row.innerHTML = html;
  container.appendChild(row);
  recalcTotal();
}

function removeEntry(btn, eventIdx) {
  btn.closest(".entry-row").remove();
  recalcTotal();
}

// 行の参加区分(general/middle/high)を返す。セグメントが無い種目は general。
function rowDivision(row) {
  const r = row.querySelector(".div-seg input:checked");
  return r ? r.value : "general";
}
// 区分に応じた料金。一般以外(中学生/高校生)は中高生料金 fee_student。
function rowFee(ev, row) {
  return (rowDivision(row) !== "general" && ev.fee_student != null)
    ? ev.fee_student : (ev.fee || 0);
}
// 区分の表示ラベル (一般は空文字 = 表示しない)。
function ttDivLabel(d) {
  return d === "middle" ? "中学生" : d === "high" ? "高校生" : d === "student" ? "中高生" : "";
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
      if (hasContent) { filled++; total += rowFee(ev, row); }   // 区分別料金で加算
    });
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
    cf_turnstile_token: fd.get("cf-turnstile-response") || "",   // Turnstile ウィジェットが挿入する隠しトークン
    hp_url: fd.get("hp_url") || "",                              // ハニーポット(空のはず)
  };

  EVENTS.forEach((ev, idx) => {
    const container = document.getElementById("members_" + idx);
    if (!container) return;
    // ★ DOM上の各行を「行スコープのセレクタ」で読む (recalcTotal と同じ方式)。
    //   旧実装は現在のDOM位置(ri)で input 名を組み立てていたため、途中行を削除すると
    //   名前(=追加時のindex)とズレて以降の選手が送信から欠落していた。行内の input を
    //   index非依存で拾うことでデータ欠落を解消し、表示合計と送信内容を常に一致させる。
    Array.from(container.children).forEach((row) => {
      const val = (sel) => { const el = row.querySelector(sel); return el ? (el.value || "") : ""; };
      const obj = { event: ev.name, type: ev.type || "singles",
        fee: rowFee(ev, row), division: rowDivision(row) };   // 区分別料金 + 区分(general/student)
      if (ev.type === "team") {
        obj.team_name = val('input[name*="_team"][name$="_name"]');
        obj.members = [];
        row.querySelectorAll('input[name*="_m"]').forEach((inp) => {
          const v = (inp.value || "").trim(); if (v) obj.members.push(v);
        });
        if (!obj.team_name && obj.members.length === 0) return;
      } else if (ev.type === "doubles") {
        obj.name1 = val('input[name*="_n1"]');
        obj.name2 = val('input[name*="_n2"]');
        obj.team1 = val('input[name*="_t1"]');
        obj.team2 = val('input[name*="_t2"]');
        obj.team = obj.team1; // 後方互換
        if (!obj.name1 && !obj.name2) return;
      } else {
        obj.name = val('input[name*="_name"]');
        obj.team = val('input[name*="_team"]');
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
      lines.push("    参加料 ¥" + (e.fee || 0).toLocaleString("ja-JP") + (ttDivLabel(e.division) ? "（" + ttDivLabel(e.division) + "）" : ""));
    } else if (e.type === "doubles") {
      lines.push("・[ダブルス] " + e.event);
      lines.push("    " + (e.name1 || "") + " (" + (e.team1 || e.team || "") + ")");
      lines.push("    " + (e.name2 || "") + " (" + (e.team2 || e.team1 || e.team || "") + ")");
      lines.push("    参加料 ¥" + (e.fee || 0).toLocaleString("ja-JP") + (ttDivLabel(e.division) ? "（" + ttDivLabel(e.division) + "）" : ""));
    } else {
      lines.push("・" + e.event + ": " + (e.name || "") + " (" + (e.team || "") + ")");
      lines.push("    参加料 ¥" + (e.fee || 0).toLocaleString("ja-JP") + (ttDivLabel(e.division) ? "（" + ttDivLabel(e.division) + "）" : ""));
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
    // iframe埋込(自動高さ)では position:fixed が画面外に出るため、確認はインラインで表示する。
    const ov = document.createElement("div");
    ov.className = "confirm-inline";
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
          (ttDivLabel(e.division) ? ' <span style="font-size:11px;color:#0369a1;font-weight:bold;">' + ttDivLabel(e.division) + '</span>' : '') +
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
    // フォームを一時的に隠し、確認パネルをその位置にインライン表示する。
    // → iframe はパネルの高さに自動縮小し、グレーの全画面オーバーレイや高さ暴走が起きない。
    const form = document.getElementById("entryForm");
    const sections = form ? form.querySelectorAll(".form-section") : [];
    const submitBtn = document.getElementById("submitBtn");
    sections.forEach(function (s) { s.style.display = "none"; });
    if (submitBtn) submitBtn.style.display = "none";
    if (form && form.parentNode) form.parentNode.insertBefore(ov, form);
    else document.body.appendChild(ov);
    ttScrollTop();
    setTimeout(ttPostHeight, 0);
    function finish(result) {
      ov.remove();
      // 確認を抜けたらフォームを元に戻す(送信成功時は submitForm 側で改めて隠す)。
      sections.forEach(function (s) { s.style.display = ""; });
      if (submitBtn) submitBtn.style.display = "";
      ttScrollTop();
      setTimeout(ttPostHeight, 0);
      resolve(result);
    }
    ov.querySelector(".btn-cancel").onclick = function () { finish(false); };
    ov.querySelector(".btn-confirm").onclick = function () { finish(true); };
  });
}

// 内容から安定した冪等キーを作る (同一内容の再送=同キー=サーバーで1回だけ登録。内容変更時は別キー)。
function ttHash(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function ttOpId(data) {
  var sig = JSON.stringify({
    t: data.team_name || "", e: data.contact_email || "", n: data.contact_name || "",
    x: (data.entries || []).map(function (it) {
      return [it.event, it.type, it.name || "", it.name1 || "", it.name2 || "",
        it.team_name || "", (it.members || []).join(",")];
    }),
  });
  return "entry-" + TOURNAMENT_ID + "-" + ttHash(sig);
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
  btn.classList.add("is-sending");
  // 「送信中...」テキストの代わりに回転スピナーを表示
  btn.innerHTML = '<span class="btn-spinner" role="status" aria-label="送信中"></span>';

  // 通信タイムアウト (25秒) — 圏外/不安定回線でボタンが「送信中…」のまま固まるのを防ぐ
  const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, 25000) : null;
  try {
    // 同一オリジン(自サーバー)へ text/plain で送信。サーバーが必要に応じGASへ中継するため、
    // ブラウザからのクロスオリジン送信(応答がCORSで読めず誤エラーになる問題)を回避。
    const resp = await fetch(SUBMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8", "X-Op-Id": ttOpId(data) },
      body: JSON.stringify(data),
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    const txt = await resp.text();
    let result;
    try { result = JSON.parse(txt); } catch { result = { ok: resp.ok, raw: txt }; }
    if (result.ok || resp.ok || resp.status === 201) {
      // ★ 送信成功 → LINE 共有用コピーカードを表示
      const summary = buildSummaryText(data);
      // Phase4: 申込番号(トークン)。本人が後から /entry/status で申込内容を確認できる。
      const token = result.applicant_token || "";
      let appOrigin = ""; try { appOrigin = new URL(SUBMIT_URL).origin; } catch (_) {}
      const statusUrl = token ? appOrigin + "/entry/status?token=" + encodeURIComponent(token) : "";
      const tokenBlock = token ? (
        '<div class="ticket">' +
          '<div class="ticket-label">申込番号</div>' +
          '<div class="ticket-code">' + escapeHtml(token) + '</div>' +
          '<div class="ticket-note">この番号で申込内容をいつでも確認できます。' +
            (statusUrl ? '' : '控えメールにも記載しています。') + '</div>' +
          (statusUrl ? '<a class="ticket-link" href="' + statusUrl + '" target="_blank" rel="noopener">申込内容を確認する →</a>' : '') +
        '</div>'
      ) : "";
      // 全件が重複(既に申込済み)で新規作成が無かった場合は、失敗と誤認させないよう明示する。
      const alreadyRegistered = !!result.already_registered || (result.entry_count === 0 && !token);
      const merged = !!result.merged && !alreadyRegistered;   // 既存申込へ追加併合
      const heading = alreadyRegistered ? 'この内容はすでに申込済みです'
        : merged ? '既存のお申込に追加しました' : '申込を受け付けました';
      const intro = alreadyRegistered
        ? '同じ内容の申込がすでに登録されています。最初に申込まれた際の<b>申込番号</b>(控えメール)でご確認ください。お心当たりがない場合や修正が必要な場合は大会本部までご連絡ください。'
        : merged
          ? '今回の追加分を、既存のお申込にまとめました。下記の<b>申込番号</b>で全種目をまとめて確認できます(以前の申込番号でも確認できます)。'
          : 'お申込ありがとうございます。下記の申込番号を控えてください。<br>お申込内容をLINE等で関係者と共有する場合は、下記をコピーしてご利用ください。';
      const card = document.createElement("div");
      card.className = "success-card";
      card.innerHTML =
        '<h3>' + heading + '</h3>' +
        '<div style="text-align:center;font-size:13px;color:#14532d;line-height:1.7;">' + intro + '</div>' +
        tokenBlock +
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
        ttScrollTop();
      setTimeout(ttPostHeight, 0);
      };
      ttScrollTop();
      setTimeout(ttPostHeight, 0);
    } else {
      showMessage("送信できませんでした: " + (result.error || ("サーバー応答 " + resp.status)) +
        "。入力内容をご確認のうえ、もう一度お試しください。", "err");
    }
  } catch (err) {
    if (timer) clearTimeout(timer);
    const aborted = err && err.name === "AbortError";
    showMessage(aborted
      ? "通信がタイムアウトしました。電波の良い場所で、もう一度「送信」ボタンを押してください。(入力内容は保持されています)"
      : "送信できませんでした。通信環境をご確認のうえ、もう一度お試しください。(" + ((err && err.message) || "network") + ")",
      "err");
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-sending");
    btn.textContent = "申込内容を送信";   // innerHTML(スピナー)も textContent で上書きされ復元される
  }
  return false;
}

function showMessage(text, type) {
  const box = document.getElementById("messageBox");
  box.innerHTML = '<div class="message ' + type + '">' + escapeHtml(text) + '</div>';
  window.scrollTo({ top: box.offsetTop - 100, behavior: "smooth" });
  if (type === "ok") setTimeout(() => box.innerHTML = "", 8000);
}

// ── 埋込iframeの高さ自動調整 ──
// 実コンテンツ高さを親フレームへ通知。親側リスナ(埋込スニペットに同梱)が iframe の
// 高さを合わせる。スクリプトを除去するCMS(一部Jimdo)では通知が無視され固定高にフォールバック。
// 確認/完了の表示に切り替えた時、フォーム先頭へスクロールし、親フレームにも「上へスクロール」を依頼する。
// 親の埋込スニペットが対応していれば iframe を視界へ送る。未対応でもインライン表示なので破綻しない。
function ttScrollTop() {
  try { window.scrollTo(0, 0); } catch (_) {}
  try {
    if (window.parent !== window) {
      window.parent.postMessage(
        { __ktta_entry_form: true, id: TOURNAMENT_ID, scrollIntoView: true }, "*");
    }
  } catch (_) {}
}
var __ttLastH = 0;
function ttPostHeight() {
  try {
    if (window.parent === window) return; // 埋込でない(単独表示)なら不要
    // ★コンテンツ(body)の高さだけを測る。documentElement.scrollHeight は親が iframe を伸ばすと
    //   それに追従して「最低でも iframe 高」になり、ResizeObserver/親の高さ加算と無限ループ(縦に伸び続ける)
    //   を起こすため使わない。body は min-height 等を持たず内容高そのものなので追従しない。
    var h = document.body ? document.body.scrollHeight : 0;
    if (h <= 0) return;
    if (Math.abs(h - __ttLastH) < 2) return; // 変化なし(±1px)なら送らない=フィードバックループ遮断
    __ttLastH = h;
    window.parent.postMessage(
      { __ktta_entry_form: true, id: TOURNAMENT_ID, height: h }, "*");
  } catch (_) {}
}
if (window.ResizeObserver) {
  try { new ResizeObserver(ttPostHeight).observe(document.body); } catch (_) {}
}
window.addEventListener("load", ttPostHeight);
window.addEventListener("resize", ttPostHeight);
// レイアウト/フォント確定後の取りこぼし対策に数回だけ遅延送信
[120, 500, 1200].forEach(function (ms) { setTimeout(ttPostHeight, ms); });

// 初期化 (失敗しても安全網が案内を表示)
try {
  renderEvents();
  recalcTotal();
  ttPostHeight();
} catch (e) {
  if (window.__ttShowFatal) window.__ttShowFatal(e && e.message);
  else throw e;
}
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// Phase4: 申込者本人の閲覧ページ (/entry/status?token=…)
// 申込番号(トークン)で自分の申込内容を確認する(閲覧のみ)。自己完結HTML。
// データは GET /api/public/applicants/:token から取得し、PII(メール等)は含まない。
// ─────────────────────────────────────────────────────────────
function buildApplicantStatusHTML() {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>申込内容の確認 | 釧路卓球協会</title>
<style>
  :root{
    --paper:#f1e9d9; --card:#fffdf8; --ink:#211b15; --ink-2:#6c6153;
    --red:#c01526; --red-2:#9c0f1c; --line:#e4dccb;
    --gothic:'Hiragino Sans','BIZ UDPGothic','Yu Gothic UI','Meiryo',system-ui,sans-serif;
    --mincho:'Hiragino Mincho ProN','Yu Mincho','YuMincho',serif;
    --ok:#15803d; --ok-bg:#e7f6ec; --warn:#9a6a10; --warn-bg:#f6ebcd; --err:#b91c1c; --err-bg:#fbe8e8;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--gothic);
    font-size:16px;line-height:1.6;padding:24px 14px 60px;}
  .wrap{max-width:640px;margin:0 auto;}
  .head{text-align:center;margin-bottom:18px;}
  .kicker{font-size:11px;letter-spacing:.2em;color:var(--red);font-weight:800;text-transform:uppercase;}
  h1{font-family:var(--mincho);font-size:26px;margin:6px 0 2px;}
  .sub{color:var(--ink-2);font-size:13px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;
    padding:20px;margin-bottom:16px;box-shadow:0 8px 24px -18px rgba(33,27,21,.5);}
  .lookup{display:flex;gap:8px;flex-wrap:wrap;}
  .lookup input{flex:1;min-width:180px;padding:12px 14px;border:1.5px solid var(--line);
    border-radius:9px;font-size:18px;font-family:'SFMono-Regular','Menlo',monospace;letter-spacing:.08em;}
  .btn{padding:12px 20px;background:var(--red);color:#fff;border:none;border-radius:9px;
    font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;}
  .btn:hover{background:var(--red-2)}
  .ticket-code{font-family:'SFMono-Regular','Menlo',monospace;font-size:22px;font-weight:800;
    letter-spacing:.1em;text-align:center;color:var(--ink);}
  .meta{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14px;margin-top:6px;}
  .meta dt{color:var(--ink-2);}
  .meta dd{margin:0;font-weight:700;}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:14px;}
  th,td{padding:9px 8px;text-align:left;border-bottom:1px solid var(--line);}
  th{font-size:11px;letter-spacing:.08em;color:var(--ink-2);text-transform:uppercase;}
  td.num{text-align:right;font-variant-numeric:tabular-nums;}
  .badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;font-weight:800;}
  .b-ok{background:var(--ok-bg);color:var(--ok);}
  .b-warn{background:var(--warn-bg);color:var(--warn);}
  .b-err{background:var(--err-bg);color:var(--err);}
  .total{display:flex;justify-content:space-between;align-items:baseline;
    margin-top:12px;padding-top:12px;border-top:2px solid var(--ink);}
  .total b{font-size:24px;font-family:var(--mincho);}
  .note{font-size:12.5px;color:var(--ink-2);line-height:1.8;}
  .msg{padding:14px;border-radius:9px;text-align:center;font-size:14px;}
  .msg.err{background:var(--err-bg);color:var(--err);}
  .hidden{display:none;}
  a.home{color:var(--red);font-weight:700;text-decoration:none;font-size:13px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div class="kicker">釧路卓球協会</div>
    <h1>申込内容の確認</h1>
    <div class="sub">申込番号を入力すると、お申込の内容と状態を確認できます（閲覧のみ）。</div>
  </div>

  <div class="card">
    <form id="lookupForm" class="lookup">
      <input id="tokenInput" type="text" inputmode="latin" autocomplete="off"
        placeholder="例: ABCD-EFGH-JKLM" aria-label="申込番号" />
      <button class="btn" type="submit">確認する</button>
    </form>
  </div>

  <div id="msg"></div>

  <div id="result" class="hidden">
    <div class="card">
      <div class="kicker" style="text-align:center;">申込番号</div>
      <div class="ticket-code" id="rToken"></div>
      <dl class="meta">
        <dt>大会</dt><dd id="rTournament"></dd>
        <dt>申込団体</dt><dd id="rTeam"></dd>
        <dt>担当者</dt><dd id="rContact"></dd>
        <dt>申込日時</dt><dd id="rDate"></dd>
      </dl>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>種目</th><th>氏名</th><th>区分</th><th class="num">参加料</th><th>状態</th></tr></thead>
        <tbody id="rRows"></tbody>
      </table>
      <div class="total"><span>合計参加料</span><b id="rTotal"></b></div>
    </div>
    <div class="card note">
      <b>状態について：</b> <span class="badge b-ok">受付済</span> = 受付完了 ／
      <span class="badge b-warn">確認中</span> = 本部で確認中 ／
      <span class="badge b-err">無効</span> = 受付対象外。<br>
      申込内容の<b>修正・取消</b>が必要な場合は、お手数ですが大会本部までご連絡ください
      （このページからは変更できません）。
    </div>
  </div>

  <div style="text-align:center;margin-top:10px;">
    <a class="home" href="javascript:history.length>1?history.back():window.close()">← 戻る</a>
  </div>
</div>

<script>
  function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
  var DIV={general:"一般",middle:"中学生",high:"高校生",student:"中高生"};
  var CAT={general:"一般",middle:"中学",high:"高校",elementary:"小学",university:"大学",
    senior:"シニア",junior:"ジュニア",youth:"ユース",large:"ラージ"};
  function yen(n){return "¥"+(parseInt(n)||0).toLocaleString("ja-JP");}
  function statusBadge(s){
    if(s==="rejected")return '<span class="badge b-err">無効</span>';
    if(s==="pending")return '<span class="badge b-warn">確認中</span>';
    return '<span class="badge b-ok">受付済</span>';
  }
  function divLabel(e){
    if(e.division&&DIV[e.division])return DIV[e.division];
    if(e.category&&CAT[e.category])return CAT[e.category];
    return "—";
  }
  function show(id,on){document.getElementById(id).classList[on?"remove":"add"]("hidden");}
  function setMsg(html){document.getElementById("msg").innerHTML=html?('<div class="card"><div class="msg err">'+html+'</div></div>'):"";}

  function render(d){
    setMsg("");
    document.getElementById("rToken").textContent=document.getElementById("tokenInput").value.trim().toUpperCase();
    document.getElementById("rTournament").textContent=(d.tournament&&d.tournament.name||"")+(d.tournament&&d.tournament.date?(" ("+d.tournament.date+")"):"");
    document.getElementById("rTeam").textContent=d.team_name||"—";
    document.getElementById("rContact").textContent=d.contact_name||"—";
    document.getElementById("rDate").textContent=d.created_at||"—";
    var rows=(d.entries||[]).map(function(e){
      var who=esc(e.name||"");
      if(e.is_doubles&&e.partner_name)who+=" / "+esc(e.partner_name);
      if(e.team_members&&e.team_members.length)who+='<br><span style="font-size:12px;color:#6c6153">'+esc(e.team_members.join("、"))+'</span>';
      return '<tr><td>'+esc(e.event)+'</td><td>'+who+'</td><td>'+esc(divLabel(e))+
        '</td><td class="num">'+yen(e.fee)+'</td><td>'+statusBadge(e.status)+'</td></tr>';
    }).join("");
    document.getElementById("rRows").innerHTML=rows||'<tr><td colspan="5" style="color:#6c6153">エントリーがありません</td></tr>';
    document.getElementById("rTotal").textContent=yen(d.total_amount);
    show("result",true);
  }

  function lookup(token){
    token=String(token||"").trim();
    if(!token){setMsg("申込番号を入力してください。");return;}
    show("result",false);
    setMsg("");
    fetch("/api/public/applicants/"+encodeURIComponent(token))
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(x){
        if(!x.ok||x.j.error){setMsg(esc(x.j.error||"申込が見つかりませんでした。番号をご確認ください。"));return;}
        render(x.j);
      })
      .catch(function(){setMsg("通信エラーが発生しました。時間をおいて再度お試しください。");});
  }

  document.getElementById("lookupForm").addEventListener("submit",function(e){
    e.preventDefault();lookup(document.getElementById("tokenInput").value);
  });
  // URL の ?token= があれば自動で照会
  (function(){
    var m=location.search.match(/[?&]token=([^&]+)/);
    if(m){var tok=decodeURIComponent(m[1]);document.getElementById("tokenInput").value=tok;lookup(tok);}
  })();
</script>
</body>
</html>`;
}

module.exports = {
  buildEntryFormHTML,
  buildApplicantStatusHTML,
};
