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
    // 締切は開催日と同じ行に並ぶので、表記を揃える(片方だけ 2027-02-01 のISO表記だと素人臭い)。
    // 「2027-02-01 17:00」のような日付+時刻を受け、日付部分だけ和文に直して時刻はそのまま残す。
    deadline: (() => {
      const raw = String(opts.deadline || "").trim();
      if (!raw) return "";
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
      if (!m) return raw;                       // 「未定」等の自由記入はそのまま
      const dt = new Date(m[1] + "-" + m[2] + "-" + m[3] + "T00:00:00");
      if (isNaN(dt.getTime())) return raw;
      return dt.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" })
        + (m[4] || "");
    })(),
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
  // 受付状況(定員・残り枠)。server が db.getEntryCapacityState を渡す。
  // 種目名 → {remaining(null=無制限), full} に畳んでフォームへ埋め込む。
  const capState = (opts.capacity && Array.isArray(opts.capacity.events)) ? opts.capacity : null;
  const capByEvent = {};
  if (capState) capState.events.forEach(c => { capByEvent[c.event] = { remaining: c.remaining, full: !!c.full }; });
  // 受付が閉じている(締切超過 / 受付OFF / 大会全体が満員)ときは、フォームより先に理由を告げ、
  // 送信を止める。理由を出さずに送信時エラーだけ返すと、全部入力してから弾かれることになる。
  const closedReason = capState
    ? (capState.closed_reason || (capState.total_full ? "この大会は定員に達したため、申込を締め切りました。" : ""))
    : "";
  const closedNotice = closedReason
    ? '<div class="closed-banner"><strong>申込は締め切りました</strong>' +
      '<div class="closed-why">' + escapeHtml(closedReason) + "</div>" +
      "<div class=\"closed-why\">お問い合わせは大会本部までお願いします。</div></div>"
    : "";

  // 有料オプション(弁当・懇親会など)。主催者が定義したものだけを出す。
  // 単価はここでは表示だけに使い、請求額は受付時にサーバが定義から計算し直す。
  const entryOptions = Array.isArray(opts.entry_options) ? opts.entry_options : [];
  const optionsSection = entryOptions.length ? `
<div class="form-section">
  <h2>オプション</h2>
  <div class="opt-list">
    ${entryOptions.map(o => `<div class="opt-row">
      <div class="opt-info">
        <div class="opt-label">${escapeHtml(o.label)}</div>
        <div class="opt-price">1${escapeHtml(o.unit)} ¥${(o.price || 0).toLocaleString("ja-JP")}${o.max ? " ・上限" + o.max + escapeHtml(o.unit) : ""}</div>
        ${o.note ? '<div class="fld-help">' + escapeHtml(o.note) + "</div>" : ""}
      </div>
      <div class="opt-qty">
        <input type="number" inputmode="numeric" min="0"${o.max ? ' max="' + o.max + '"' : ""}
          name="opt_${escapeHtml(o.key)}" value="" placeholder="0"
          aria-label="${escapeHtml(o.label)}の数量" oninput="recalcTotal()">
        <span class="opt-unit">${escapeHtml(o.unit)}</span>
      </div>
    </div>`).join("")}
  </div>
</div>` : "";
  const optionsJson = jsonForScript(entryOptions.map(o => ({ key: o.key, label: o.label, price: o.price, unit: o.unit, max: o.max })));

  const eventsJson = jsonForScript(events.map(e => ({
    name: e.name,
    fee: e.fee || 0,
    // 残り枠(null=無制限)と満員フラグ。満員種目は行を追加できないようにする。
    remaining: capByEvent[e.name] ? capByEvent[e.name].remaining : null,
    full: capByEvent[e.name] ? capByEvent[e.name].full : false,
    // 中高校生料金 (空/未設定なら一般と同額)。数値化し、未設定は null にして「一般と同じ」と判定。
    fee_student: (e.fee_student != null && e.fee_student !== "" && !isNaN(parseInt(e.fee_student)))
      ? (parseInt(e.fee_student) || 0) : null,
    type: e.type || "singles",
    note: e.note || "",
    per_team: e.per_team || 6,
    // 種目の対象区分(elementary/middle/high/junior/youth/general/senior/large)。
    // 学年欄を学生の種目だけに出すために使う。
    category: e.category || "",
    // 団体戦の成立に必要な最少人数(要項の「4人以上」「3〜4人」等)。0/未設定なら下限なし。
    per_team_min: Math.max(0, parseInt(e.per_team_min) || 0),
    // 料金の単位("person"=1人あたり。団体戦で人数分を請求する大会がある)
    fee_unit: e.fee_unit === "person" ? "person" : undefined,
    // 大会が定義した参加区分(自己申告)。value/label/short/fee_override/min_age/max_age/combined を使う。
    entry_categories: Array.isArray(e.entry_categories) ? e.entry_categories : undefined,
    // 年齢自動判定(生年月日入力→基準日時点の満年齢で資格判定)。mode:"birthdate" で有効。
    age_check: (e.age_check && e.age_check.mode === "birthdate") ? e.age_check : undefined,
  })));

  // 年齢基準日 = 大会の年度の4月1日(学校年度)。生年月日から満年齢を算出する基準。
  // 大会日付が非ISO("未定"等)でも、種目に明示 as_of があればそれを使う(サーバの解決と揃える)。
  const AGE_ASOF = (function () {
    const m = String(tournament.date || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) { const y = +m[1], mo = +m[2]; return (mo >= 4 ? y : y - 1) + "-04-01"; }
    for (const e of events) {
      if (e.age_check && String(e.age_check.as_of || "").match(/^\d{4}-\d{2}-\d{2}/)) return String(e.age_check.as_of).slice(0, 10);
    }
    return "";
  })();
  // いずれかの種目が同意書年齢を持つか(同意チェックボックスの表示要否)。最小の consent_age を採る。
  const _consentAge = (function () {
    let ca = null;
    events.forEach(function (e) {
      if (e.age_check && e.age_check.mode === "birthdate" && e.age_check.consent_age != null && e.age_check.consent_age !== "") {
        const v = parseInt(e.age_check.consent_age); if (!isNaN(v) && (ca == null || v < ca)) ca = v;
      }
    });
    return ca;
  })();

  // ── 必須項目設定(field_config) ──────────────────────────────
  // server.js が db.resolveFieldConfig(tournament) を opts.field_config で渡す。
  // 未指定(直接呼び出し等)は現行フォーム相当の既定にフォールバックし、既存挙動を完全維持する。
  const FALLBACK_FC = {
    fields: { team_name: "required", furigana: "hidden", player_team: "optional", grade: "hidden",
      player_gender: "hidden", supervisor: "optional", advisor: "hidden", coach: "optional", note: "optional" },
    custom: [], event_overrides: {},
  };
  const fc = (opts.field_config && typeof opts.field_config === "object" && opts.field_config.fields)
    ? opts.field_config : FALLBACK_FC;
  const fcFields = fc.fields || {};
  const fcCustom = Array.isArray(fc.custom) ? fc.custom : [];
  const fcOverrides = (fc.event_overrides && typeof fc.event_overrides === "object") ? fc.event_overrides : {};
  const fcMeta = (fc.field_meta && typeof fc.field_meta === "object") ? fc.field_meta : {};
  const fst = (k) => fcFields[k] || "hidden";   // 大会レベルの項目状態 "required|optional|hidden"
  // 項目の表示名(主催者が field_meta.label で変更可能)。集計スプレッドシートの列名も同じ定義から
  // 作られるため、フォームの見出しとシートの列名が必ず一致する。
  const fcLabel = (k, def) => {
    const l = fcMeta[k] && typeof fcMeta[k].label === "string" ? fcMeta[k].label.trim() : "";
    return l || def;
  };
  const reqSpan = '<span class="required">必須</span>';
  // 連絡先セクションの標準テキスト項目を状態に応じて出す。hidden=DOMごと省略 / optional=required属性なし。
  // field_meta.help があれば入力欄の下に説明文を出す(項目名と同じく主催者が設定できる)。
  const stdTextField = (key, label, name, type, placeholder) => {
    const st = fst(key);
    if (st === "hidden") return "";
    const req = st === "required";
    const helpTxt = fcMeta[key] && typeof fcMeta[key].help === "string" ? fcMeta[key].help.trim() : "";
    return '<div><label>' + label + (req ? " " + reqSpan : "") + "</label>" +
      '<input type="' + (type || "text") + '" name="' + name + '"' + (req ? " required" : "") +
      (placeholder ? ' placeholder="' + escapeHtml(placeholder) + '"' : "") + ">" +
      (helpTxt ? '<div class="fld-help">' + escapeHtml(helpTxt) + "</div>" : "") + "</div>";
  };
  // 自由項目1つ分のHTMLを生成(text/select/checkbox)。name はフォーム送信キー。
  // 説明文(help)・入力制限(input/maxlen)・表示条件(when → data-wk/data-wv、ttWhenSync が制御)に対応。
  const renderCustomFieldHtml = (c, name) => {
    if (!c || !c.key) return "";
    const req = !!c.required;
    const label = escapeHtml(c.label || c.key) + (req ? " " + reqSpan : "");
    const helpHtml = c.help ? '<div class="fld-help">' + escapeHtml(String(c.help)) + "</div>" : "";
    const whenAttr = (c.when && c.when.key)
      ? ' data-wk="' + escapeHtml(String(c.when.key)) + '" data-wv="' + escapeHtml(c.when.equals != null ? String(c.when.equals) : "") + '"'
      : "";
    const textAttrs = (c.input === "number" ? ' inputmode="numeric" pattern="[0-9]*"'
      : c.input === "tel" ? ' inputmode="tel"' : "") +
      (c.maxlen ? ' maxlength="' + parseInt(c.maxlen) + '"' : "");
    if (c.type === "checkbox") {
      return '<div class="cust-field"' + whenAttr + '><label class="cust-check"><input type="checkbox" name="' + name + '" value="1"' +
        (req ? " required" : "") + "> " + label + "</label>" + helpHtml + "</div>";
    }
    if (c.type === "select") {
      const optsHtml = (Array.isArray(c.options) ? c.options : []).map(o =>
        '<option value="' + escapeHtml(String(o)) + '">' + escapeHtml(String(o)) + "</option>").join("");
      return '<div class="cust-field"' + whenAttr + '><label>' + label + "</label>" +
        '<select name="' + name + '"' + (req ? " required" : "") +
        '><option value="">選択してください</option>' + optsHtml + "</select>" + helpHtml + "</div>";
    }
    return '<div class="cust-field"' + whenAttr + '><label>' + label + "</label>" +
      '<input type="text" name="' + name + '"' + (req ? " required" : "") + textAttrs + ">" + helpHtml + "</div>";
  };
  // 申込単位スコープの自由項目(scope=submission)を連絡先セクション末尾に出す。
  const submissionCustomHtml = fcCustom.filter(c => c && c.scope === "submission")
    .map(c => renderCustomFieldHtml(c, "cust_" + c.key)).join("");
  // FIELD_CFG をクライアントへ埋込(選手行の可変項目 addEntry / gatherFormData が参照)。
  const fieldCfgJson = jsonForScript({ fields: fcFields, custom: fcCustom, event_overrides: fcOverrides,
    field_meta: fcMeta });

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
  /* 項目の説明文(主催者が設定)。ラベルより一段小さく、入力欄の直下に添える */
  .fld-help { font-size: 12px; color: var(--ink-2); margin-top: 5px; line-height: 1.6; }
  /* 定員の表示。残りわずか=琥珀、受付終了=丹頂(いずれも状態を示す機能色) */
  .cap-tag {
    display: inline-block; font-size: 11.5px; font-weight: 700;
    padding: 3px 9px; border-radius: 3px; margin-left: 8px;
    background: var(--amber-bg); color: var(--amber);
  }
  .cap-tag.cap-full { background: #fdecee; color: var(--red); }
  /* 団体戦の人数の決まり(要項の「4人以上」「3〜4人」) */
  .cap-tag.size { background: var(--card-2); color: var(--ink-2); border: 1px solid var(--line); }
  .cap-closed {
    padding: 14px 16px; font-size: 13.5px; color: var(--ink-2);
    background: var(--card-2); border-top: 1px solid var(--line);
  }
  /* 受付終了バナー(締切超過・受付OFF・大会全体が満員) */
  .closed-banner {
    background: #fdecee; border-top: 3px solid var(--red);
    padding: 18px 22px; color: #7f1d1d;
    font-size: 15px; font-weight: 800; line-height: 1.7;
  }
  .closed-banner .closed-why { font-size: 13px; font-weight: 500; margin-top: 4px; color: #8a4a4a; }
  /* 有料オプション(弁当・懇親会など) */
  .opt-list { display: flex; flex-direction: column; gap: 10px; }
  .opt-row {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    padding: 12px 14px; background: var(--card-2);
    border: 1.5px solid var(--line-2); border-radius: 9px;
  }
  .opt-row:focus-within { border-color: var(--red); background: #fff; }
  .opt-label { font-weight: 700; font-size: 14.5px; }
  .opt-price { font-size: 12.5px; color: var(--ink-2); margin-top: 2px; }
  .opt-qty { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .opt-qty input {
    width: 76px; padding: 10px 8px; text-align: right;
    border: 1.5px solid var(--line); border-radius: 8px;
    font-family: inherit; font-size: 16px; background: #fff; color: var(--ink);
  }
  .opt-qty input:focus { outline: none; border-color: var(--red); box-shadow: 0 0 0 3px rgba(192,21,38,.13); }
  .opt-unit { font-size: 13px; color: var(--ink-2); }
  /* 団体戦: メンバーごとに項目がある場合の区切り */
  .member-block {
    position: relative;
    padding: 10px 12px 10px 34px; margin-bottom: 8px;
    background: var(--card-2); border: 1px solid var(--line-2); border-radius: 8px;
  }
  .member-block .member-no {
    position: absolute; left: 10px; top: 12px;
    width: 18px; height: 18px; border-radius: 50%;
    background: var(--line); color: var(--ink-2);
    font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .member-block:focus-within { border-color: var(--red); background: #fff; }
  .member-block:focus-within .member-no { background: var(--red); color: #fff; }

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
    /* 区別は上端帯で作る。左縁の色付き線は使わない(KTTAの規範。過去に全画面で上端帯へ統一した) */
    border-top: 3px solid #d6c8ab;
    border-radius: 10px;
    padding: 14px 16px; margin-bottom: 10px;
    transition: border-color .15s, box-shadow .15s;
    animation: ttRise .3s ease both;
  }
  .entry-row:hover { border-top-color: #211d18; box-shadow: 0 4px 16px -12px rgba(33,29,24,.35); }
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

  /* ── 参加区分セグメント (大会ごとの区分。既定は一般/中学生/高校生) ── */
  .div-seg {
    display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px;
    background: #f0e7d6; padding: 4px; border-radius: 11px;
    border: 1px solid var(--line);
  }
  /* min-width:84px + flex-wrap で、区分が多い/狭い画面(375px)でも切れずに折り返す */
  .div-seg .seg { flex: 1 1 auto; min-width: 84px; position: relative; cursor: pointer; }
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
    /* 押し間違えると入力済みの選手が消えるので、指で確実に押せる大きさを確保する */
    min-height: 44px; min-width: 56px;
  }
  .btn-del:hover { background: #fbe9e9; border-color: var(--red); }
  .events-lead { font-size: 13px; color: #57534e; line-height: 1.75; margin: 0 0 14px; }
  /* 団体戦の人数の決まり(何人まで必須で、どこからが任意か)を欄のすぐ下に置く */
  .member-hint { font-size: 12px; color: var(--ink-2); line-height: 1.7; margin-top: 8px; }

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
  /* ══════════════════════════════════════════════════════════
     承認デザイン「白磁×墨罫」(2026-07-27 オーナー承認・見本案2)
     サイト/viewer の正典に合わせる。ここは既存定義への後勝ち上書きなので、
     上の既存CSSは消さずにこのブロックだけを直す。
     ══════════════════════════════════════════════════════════ */
  :root {
    --paper: #fbfaf7;
    --card: #ffffff;
    --card-2: #ffffff;
    --line: #d9d2c4;
    --line-2: #d9d2c4;
    --ink: #211d18;
    --shadow: none;
    --radius: 0px;
  }
  body {
    background-color: var(--paper);
    background-image: none;
    padding-top: 0;
  }
  body::before { display: none; }   /* 紙の粒状感オーバーレイを廃止(白磁はフラット) */

  /* ── マストヘッド: 白地+墨の太罫(新聞様式)。暗色バナー・金グラデを廃止 ── */
  .form-header {
    background: #fff;
    color: var(--ink);
    border-top: none;
    border-bottom: 2.5px solid #211d18;
    border-radius: 0;
    padding: 26px 30px 20px;
    animation: none;
  }
  .form-header::after { display: none; }
  .form-header-art { opacity: .5; filter: none; }
  .form-header h1 {
    font-family: var(--gothic);
    font-weight: 800;
    font-size: 27px;
    letter-spacing: .01em;
  }
  .form-header .seal {
    box-shadow: none;
    border-radius: 3px;
  }
  .form-header .meta { color: #52525b; }
  /* モバイル: 印(大会申込)を行から独立させ、題字の途中折れ(「釧」で改行)を防ぐ */
  @media (max-width: 480px) {
    .form-header { padding: 20px 18px 16px; }
    .form-header h1 { font-size: 21.5px; line-height: 1.35; }
    .form-header .seal { display: block; width: fit-content; margin: 0 0 10px; }
  }

  /* ── セクション: 白地+細罫。影で浮かせない ── */
  .form-section {
    border-color: var(--line);
    animation: none;
  }
  .form-section:last-of-type { box-shadow: none; border-radius: 0; }
  .form-section h2 {
    font-family: var(--gothic);
    font-size: 17.5px;
    font-weight: 800;
    letter-spacing: .02em;
    padding-bottom: 9px;
    border-bottom: 1.5px solid #211d18;   /* 新聞の小見出し=中罫 */
  }
  .form-section h2::before { display: none; }   /* 左の赤バー(左縁アクセント)を廃止 */

  /* ── 入力欄: 白地+細罫。フォーカスは丹頂(機能色) ── */
  .form-row input[type="text"], .form-row input[type="email"], .form-row input[type="tel"],
  .form-row input[type="number"], .form-row input[type="date"],
  .form-row select, .form-row textarea,
  .entry-row input[type="text"], .entry-row input[type="date"], .entry-row select {
    background: #fff;
    border-color: var(--line);
    border-radius: 3px;
  }
  .form-row input::placeholder, .form-row textarea::placeholder,
  .entry-row input::placeholder { color: #8e8a80; }

  /* いま入力している欄=墨のリング。丹頂は「必須・未入力・エラー」に温存する
     (現在地とエラーが同じ赤だと、書いている欄が間違えた欄に見える) */
  .form-row input:focus, .form-row select:focus, .form-row textarea:focus,
  .entry-row input:focus, .entry-row select:focus {
    border-color: #211d18 !important;
    box-shadow: 0 0 0 3px rgba(33, 29, 24, .14) !important;
  }
  input:user-invalid { border-color: var(--red); background: #fffafa; }

  /* ── 行(選手)・種目ブロック: 罫線で構造を作る ── */
  .entry-row { background: #fff; border-radius: 3px; animation: none; }
  .event-block { border-radius: 3px; }
  .event-block summary { border-radius: 3px; }

  /* 追加ボタン: 琥珀(意味=呼出間近)をやめ、白地+墨罫のゴシックに */
  .btn-add {
    background: #fff; color: var(--ink);
    border: 1.5px solid #211d18;
    border-radius: 3px; box-shadow: none;
  }
  .btn-add:hover { background: rgba(72, 58, 46, .07); }

  /* 参加区分セグメント: 生成り地をやめ、白磁のヘアライン枠+選択=墨の白抜き(首位セルと同じ文法) */
  .div-seg {
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 3px;
  }
  .div-seg .seg span { border-radius: 2px; box-shadow: none; }
  .div-seg .seg span small { color: #8e8a80; }
  .div-seg .seg input:checked + span {
    background: #211d18; color: #fff;
    box-shadow: none;
  }
  .div-seg .seg input:checked + span small { color: #e8e4dc; }

  /* ── 注意書き: 左縁の色付きアクセント線(最頻の禁止則)を廃止し、上下ヘアラインの帯に ── */
  .notice {
    background: #fff;
    border: none;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    border-radius: 0;
    color: #52525b;
  }

  /* ── 合計: 琥珀の枠・グラデ地・赤グローを廃止。墨罫の勘定書きにする ── */
  .total-box {
    background: #fff;
    border: 1.5px solid #211d18;
    border-radius: 3px;
    box-shadow: none;
  }
  .total-box::before, .total-box::after { display: none !important; }
  .total-box .label { font-family: var(--gothic); font-weight: 700; color: #52525b; }
  .total-box .amount {
    font-family: var(--gothic);
    font-weight: 800;
    color: var(--ink);                 /* 金額は情報。丹頂(機能色)を装飾に使わない */
    font-variant-numeric: tabular-nums;
  }

  /* ── 種目ブロックの開閉チップ・行番号バッジ ──
     案2(白磁)の時点では「赤グラデ+影 → 墨のフラット」だった。
     案1(罫線の帳簿・2026-07-29承認)で塗りチップ自体をやめ、墨の文字だけにしたため
     背景を落とす。!important は下の基底CSSの赤グラデを消すために必要
     (ここを外すと基底の linear-gradient が復活する)。 */
  .event-block summary::before,
  .entry-row .row-head .num {
    background: none !important;
    box-shadow: none !important;
  }
  /* 料金・人数のピル: 琥珀/緑の常時色を白地+細罫の文字チップへ(色は状態にだけ使う) */
  .fee-tag, .count-badge {
    background: #fff !important;
    border: 1px solid var(--line) !important;
    color: #52525b !important;
    box-shadow: none !important;
    border-radius: 2px !important;
  }

  /* ── 送信ボタン: 丹頂は機能色として維持。グラデとグローだけ外す ── */
  .submit-btn {
    background: var(--red);
    box-shadow: none;
    border-radius: 3px;
  }
  .submit-btn:hover { background: var(--red-2, #9c0f1c); transform: none; }

  /* ── 確認・完了・エラーも同じ紙面に揃える(承認後に「見本と違う画面」を出さない) ── */
  .confirm-modal { border-radius: 3px; border-top-color: #211d18; }
  .confirm-modal h3, .success-card h3, .form-footer .org, .total b {
    font-family: var(--gothic);
    font-weight: 800;
  }
  .confirm-inline, .success-card { animation: none; }
  .success-card { background: #fff; border: 1.5px solid #211d18; border-radius: 3px; box-shadow: none; }
  .ticket { border-radius: 3px; }
  .message { border-radius: 3px; }

  /* チェックボックス・ラジオの既定青を白磁パレットへ */
  input[type="checkbox"], input[type="radio"] { accent-color: #211d18; }

  /* 動きの規範(業務UI): transition:all を捨て、色と枠だけを200ms以内で動かす */
  .btn-add, .div-seg .seg span, .submit-btn {
    transition: background-color .15s ease-out, border-color .15s ease-out, color .15s ease-out;
  }

  /* ══ 道しるべ(見本案2): いま何を書いていて、あと何が要るかを常に示す ══ */
  #ttRail {
    position: sticky; top: 0; z-index: 50;
    background: #fbfaf7;
    border-bottom: 1.5px solid #211d18;
    padding: 0 8px;
    display: flex; align-items: stretch; gap: 2px;
    font-family: var(--gothic);
  }
  /* 埋込(iframeで高さ自動)ではページ自体がスクロールしないため sticky が効かない。
     その場合は貼り付けをやめ、フォーム冒頭の案内板として置く(情報は同じ)。 */
  body.tt-embedded #ttRail { position: static; }
  #ttRail .step {
    position: relative; flex: 1; text-align: center;
    padding: 10px 2px 12px;
    font-size: 12.5px; letter-spacing: .04em; color: var(--ink-2);
    cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
    background: none; border: none; font-family: inherit;
  }
  #ttRail .step .st { font-size: 10.5px; display: block; margin-top: 2px; color: #8a7a64; }
  #ttRail .step.done .st { color: var(--green); }
  #ttRail .step.cur { color: var(--ink); font-weight: 700; }
  #ttRail .bar {
    position: absolute; left: 0; bottom: -1.5px; height: 3px;
    background: var(--red); transform: translateX(0);
    transition: transform .18s ease-out; pointer-events: none;
  }
  /* 残り必須の常設チップ。埋込では画面外に出るので、送信ボタンの手前に置き換える */
  #ttRemain {
    position: fixed; right: 14px; bottom: 14px; z-index: 60;
    background: #fff; border: 1.5px solid var(--line); border-radius: 999px;
    padding: 9px 16px; font-family: var(--gothic); font-size: 13px; color: var(--ink);
    box-shadow: 0 10px 26px -14px rgba(48, 32, 16, .4);
  }
  #ttRemain.ok { border-color: var(--green); color: var(--green); background: var(--green-bg); }
  body.tt-embedded #ttRemain {
    position: static; display: block; margin: 0 0 10px; text-align: center;
    box-shadow: none;
  }
  @media (prefers-reduced-motion: reduce) {
    #ttRail .bar { transition-duration: .01ms; }
  }

  /* ══════════════════════════════════════════════════════════
     承認デザイン「罫線の帳簿」(2026-07-29 オーナー承認・見本案1)
     囲みを捨てて罫線だけで区切る。参照は大会本部の申込用紙。
     きっかけは「種目カード → 選手ブロック → 入力欄」の入れ子3重で、
     囲みが多く視線の起点が定まらなかったこと。入れ子を0にする。
     ここも既存定義への後勝ち上書きなので、上のCSSは消さずにここだけ直す。
     ══════════════════════════════════════════════════════════ */

  /* ── 種目 = 太罫の上に立つ見出し。カードの箱を捨てる ── */
  .event-block {
    border: none; border-top: 2px solid var(--ink);
    border-radius: 0; background: transparent; box-shadow: none;
    padding: 14px 0 0; margin: 0 0 26px;
  }
  .event-block[open] { border-color: var(--ink); box-shadow: none; }
  .event-block summary { padding-bottom: 12px; gap: 10px; }
  /* 開閉の印は塗り箱をやめ、墨の文字だけにする(帳簿の行頭に置く記号)。
     位置を固定して種目名の頭を揃える。 */
  .event-block summary::before {
    content: "＋"; display: inline-block;
    width: 22px; flex: 0 0 22px; height: auto; margin-right: 0;
    background: none; color: var(--ink); box-shadow: none; border-radius: 0;
    font-size: 14px; font-weight: 800; text-align: left; line-height: inherit;
  }
  .event-block[open] summary::before { content: "－"; }
  .event-block .members { margin-top: 0; }
  .event-block .add-buttons { padding-left: 22px; margin-top: 14px; }
  .cap-closed { background: transparent; border-top: 1px solid var(--line); padding: 14px 0 4px 22px; }

  /* 件数バッジ: 丸ピルをやめる(色・枠は白磁ブロックの白地+細罫をそのまま使う) */
  .count-badge { padding: 3px 10px; }
  /* 0件のときは hidden 属性で消す。.count-badge の display 指定が [hidden] の既定より
     詳細度で勝ってしまうため、空の枠だけが残っていた(実機で発見)。ここで明示的に消す。 */
  .count-badge[hidden] { display: none; }

  /* ── 選手 = 帳簿の1行。囲みを捨て、上に細罫を1本だけ引く ── */
  .entry-row {
    background: transparent; border: none; border-top: 1px solid var(--line);
    border-radius: 0; box-shadow: none;
    padding: 12px 0 14px 22px; margin: 0;
  }
  .entry-row:hover { border-top-color: var(--line); box-shadow: none; }
  .entry-row .row-head { margin-bottom: 6px; }
  /* 行番号は墨の細字。赤丸バッジをやめる(丹頂は機能色に限る) */
  .entry-row .row-head .num {
    background: none; color: var(--ink-2); width: auto; height: auto;
    font-size: 12px; font-weight: 800; letter-spacing: .1em;
  }

  /* ── 入力欄は枠を持たず下線だけ(3つ目の囲みが消える) ── */
  .entry-row input[type="text"], .entry-row input[type="date"], .entry-row select {
    border: none; border-bottom: 1px solid var(--line); border-radius: 0;
    background: transparent; padding: 9px 2px;
  }
  .entry-row input[type="text"]:focus,
  .entry-row input[type="date"]:focus,
  .entry-row select:focus {
    outline: none; border-bottom: 1.5px solid var(--ink);
    box-shadow: none; background: transparent;
  }
  .entry-row input:user-invalid { border-bottom-color: var(--red); background: transparent; }

  /* PCでは1人ぶんを横1行に詰めて名簿のように読めるようにし、狭い画面では縦に積む。
     項目数は大会設定で変わる(ふりがな・学年・性別・自由項目)ので、
     列数を固定せず auto-fit で入るだけ並べる。 */
  .entry-grid { grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 2px 18px; }

  /* ダブルスは選手ごとに区切る。囲みは作らず、小さな見出しと細罫だけで分ける */
  .entry-row .pair-side + .pair-side { border-top: 1px dashed var(--line); margin-top: 10px; padding-top: 8px; }
  .entry-row .pair-no {
    font-size: 11.5px; font-weight: 800; color: var(--ink-2);
    letter-spacing: .1em; margin-bottom: 2px;
  }

  /* 団体戦のメンバー枠も囲みを捨てる(番号 + 罫線で足りる) */
  .member-block {
    background: transparent; border: none; border-top: 1px solid var(--line);
    border-radius: 0; padding: 8px 0 8px 26px; margin-bottom: 0;
  }
  .member-block .member-no {
    background: none; color: var(--ink-2); width: auto; height: auto;
    left: 2px; top: 14px; font-size: 12px; font-weight: 800;
  }

  /* 追加ボタンは墨の細枠(白磁の作法に合わせる) */
  .btn-add-bulk { background: #fff; border-color: var(--line); color: var(--ink-2); font-weight: 600; }
  .btn-add-bulk:hover { background: rgba(33,29,24,.06); }

  @media (max-width: 560px) {
    .entry-grid { grid-template-columns: 1fr; }
    .entry-row { padding-left: 18px; }
    .event-block .add-buttons { padding-left: 18px; }
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
${closedNotice}

<form id="entryForm" onsubmit="return submitForm(event)">

<div class="form-section">
  <h2>申込責任者・連絡先</h2>
  <div class="form-row">
    ${stdTextField('team_name', '団体名', 'team_name', 'text', '例: ○○高校 / □□クラブ')}
    <div>
      <label>申込責任者 (氏名) ${reqSpan}</label>
      <input type="text" name="contact_name" required>
    </div>
  </div>
  <div class="form-row">
    <div>
      <label>連絡先 (電話番号) ${reqSpan}</label>
      <input type="tel" name="contact_tel" required placeholder="例: 0154-XX-XXXX">
    </div>
    <div>
      <label>メールアドレス <span class="required">必須・自動返信用</span></label>
      <input type="email" name="contact_email" required placeholder="example@example.com">
    </div>
  </div>
  ${(fst('supervisor') !== 'hidden' || fst('advisor') !== 'hidden' || fst('coach') !== 'hidden')
    ? '<div class="form-row">' + stdTextField('supervisor', fcLabel('supervisor', '引率顧問'), 'supervisor')
        + stdTextField('advisor', fcLabel('advisor', '顧問'), 'advisor')
        + stdTextField('coach', fcLabel('coach', 'コーチ'), 'coach') + '</div>'
    : ''}
  ${submissionCustomHtml ? '<div class="form-row full">' + submissionCustomHtml + '</div>' : ''}
</div>

<div class="form-section">
  <h2>出場種目</h2>
  ${events.length > 3 ? '<p class="events-lead">出場する種目をタップして開き、選手を記入してください。出ない種目はそのままで構いません。</p>' : ''}
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

${optionsSection}

${fst('note') !== 'hidden' ? `<div class="form-section">
  <h2>通信欄${fst('note') === 'required' ? ' ' + reqSpan : ''}</h2>
  <div class="form-row full">
    <textarea name="note" rows="3"${fst('note') === 'required' ? ' required' : ''} placeholder="連絡事項があればこちらに記入してください"></textarea>
  </div>
</div>` : ''}

<!-- ハニーポット: 人間には不可視。ボットが埋めるとサーバーで弾く (スパム対策) -->
<div aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden">
  <label>この欄は空のままにしてください<input type="text" name="hp_url" tabindex="-1" autocomplete="off"></label>
</div>
${_consentAge != null ? `<div class="form-section" style="padding:16px 18px;">
  <label style="display:flex;gap:10px;align-items:flex-start;font-size:14px;cursor:pointer;">
    <input type="checkbox" name="consent_check" style="margin-top:3px;">
    <span>${_consentAge}歳以上の選手が出場する場合、家族の同意書（別紙）を別途提出することを確認しました。</span>
  </label>
</div>` : ''}
${turnstileSitekey ? '<div class="cf-turnstile" data-sitekey="' + escapeHtml(turnstileSitekey) + '" style="margin:14px 0"></div>' : ''}
<button type="submit" class="submit-btn" id="submitBtn"${closedReason ? " disabled" : ""}>${closedReason ? "受付は終了しました" : "申込内容を送信"}</button>
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
const FIELD_CFG = ${fieldCfgJson};
const ENTRY_OPTIONS = ${optionsJson};
// オプションの数量を読み、上限を超えていれば入力欄ごと丸めてから小計を返す。
function optionsTotal() {
  let sum = 0;
  (ENTRY_OPTIONS || []).forEach(function (o) {
    const el = document.querySelector('[name="opt_' + o.key + '"]');
    if (!el) return;
    let n = parseInt(el.value) || 0;
    if (n < 0) n = 0;
    if (o.max && n > o.max) n = o.max;
    if (String(n) !== String(el.value || "") && el.value !== "") el.value = n ? String(n) : "";
    sum += (o.price || 0) * n;
  });
  return sum;
}
// 申込に含めるオプションの数量 {key: qty}(0は載せない)。
function gatherOptions() {
  const out = {};
  (ENTRY_OPTIONS || []).forEach(function (o) {
    const el = document.querySelector('[name="opt_' + o.key + '"]');
    if (!el) return;
    let n = parseInt(el.value) || 0;
    if (o.max && n > o.max) n = o.max;
    if (n > 0) out[o.key] = n;
  });
  return out;
}
const AGE_ASOF = ${escapeJs(AGE_ASOF)};   // 年齢基準日(大会年度の4/1)。空なら年齢判定は無効。

// その種目が学生対象か。学年を聞く意味があるのは小中高・ジュニアの種目だけで、
// 一般・シニア・ラージボールの年代別には学年が無い。
// category(種目設定)を第一に見て、未設定なら種目名から推定する。
function isStudentEvent(ev) {
  const c = String((ev && ev.category) || "");
  if (["elementary", "middle", "high", "junior", "youth", "student"].indexOf(c) >= 0) return true;
  if (["general", "senior", "large"].indexOf(c) >= 0) return false;
  return /小学|中学|高校|中高|高中|ジュニア|カデット|ホープス|カブ|バンビ|学生/.test(String((ev && ev.name) || ""));
}
// その種目に明示的な項目指定(event_overrides)があるか。あれば主催者の判断を優先する。
function hasEventOverride(evName, key) {
  const ov = FIELD_CFG.event_overrides && FIELD_CFG.event_overrides[evName];
  return !!(ov && ov[key]);
}
// 学年欄をどう出すか。
//  ・種目ごとの明示指定があればそれに従う(主催者の判断が最優先)
//  ・シニア/ラージボールの年代別 … 学年の概念が無いので出さない
//  ・学生の種目 … 大会レベルの設定どおり(学年別の部があるため必要)
//  ・一般の種目 … 任意で出す。「中3・高3は一般の部へ」「小6・管外の中学生も一般の部へ
//    出場できる」(バタフライ杯)のように、一般の部に学生が出場する場合に記入してもらう
function gradeStateFor(ev, evName) {
  const st = fstFor(evName, "grade");
  if (hasEventOverride(evName, "grade")) return st;
  if (st === "hidden") return "hidden";
  const c = String((ev && ev.category) || "");
  if (c === "senior" || c === "large") return "hidden";
  if (isStudentEvent(ev)) return st;
  return "optional";
}
// 種目単位の項目状態を解決(event_overrides > 大会レベル fields > hidden)。"required|optional|hidden"。
function fstFor(evName, key) {
  const ov = FIELD_CFG.event_overrides && FIELD_CFG.event_overrides[evName];
  if (ov && ov[key]) return ov[key];
  return (FIELD_CFG.fields && FIELD_CFG.fields[key]) || "hidden";
}
// クライアント側の自由項目レンダラ(text/select/checkbox)。name はフォーム送信キー。
// 説明文は選手行(グリッド密集地帯)では title 属性で出す。入力制限(input/maxlen)・
// 表示条件(when → data-wk/data-wv)はサーバ側レンダラと同じ挙動にする。
function renderCustomClient(c, name) {
  if (!c || !c.key) return "";
  const req = !!c.required;
  const label = c.label || c.key;
  const helpAttr = c.help ? ' title="' + escapeHtml(String(c.help)) + '"' : "";
  const whenAttr = (c.when && c.when.key)
    ? ' data-wk="' + escapeHtml(String(c.when.key)) + '" data-wv="' + escapeHtml(c.when.equals != null ? String(c.when.equals) : "") + '"'
    : "";
  const textAttrs = (c.input === "number" ? ' inputmode="numeric" pattern="[0-9]*"'
    : c.input === "tel" ? ' inputmode="tel"' : "") +
    (c.maxlen ? ' maxlength="' + parseInt(c.maxlen) + '"' : "");
  if (c.type === "checkbox") {
    return '<label class="cust-check"' + whenAttr + helpAttr + ' style="grid-column:1/-1;display:flex;align-items:center;gap:6px;font-size:13px;">' +
      '<input type="checkbox" name="' + name + '" value="1"' + (req ? " required" : "") + '> ' +
      escapeHtml(label) + (req ? " (必須)" : "") + '</label>';
  }
  if (c.type === "select") {
    const opts = (c.options || []).map(function (o) {
      return '<option value="' + escapeHtml(String(o)) + '">' + escapeHtml(String(o)) + '</option>';
    }).join("");
    return '<select name="' + name + '"' + (req ? " required" : "") + whenAttr + helpAttr + '>' +
      '<option value="">' + escapeHtml(label) + (req ? " (必須)" : "") + '</option>' + opts + '</select>';
  }
  return '<input type="text" name="' + name + '" placeholder="' + escapeHtml(label) + (req ? " (必須)" : "") + '"' +
    (req ? " required" : "") + whenAttr + helpAttr + textAttrs + ' />';
}
// 記入されていない選手行の必須を外す。
// gatherFormData は氏名(団体はチーム名/メンバー)が空の行を送信対象から外すので、必須検証も
// 同じ規則に揃える。揃えないと「追加したが使わなかった予備行」や「申し込まない種目の初期行」の
// ふりがな等が HTML5 検証に引っかかり、送信ボタンを押しても何も起きない(閉じている種目の行だと
// ブラウザがフォーカスできずエラー表示すら出ない)という詰みが起きる(2026-07-27 修正)。
function ttRowIsUsed(row) {
  var hit = false;
  row.querySelectorAll('input[name$="_name"], input[name$="_n1"], input[name$="_n2"], input[name*="_m"]')
    .forEach(function (el) { if (String(el.value || "").trim()) hit = true; });
  return hit;
}
// そのメンバー欄に何か書かれているか(氏名でも、ふりがな等の付随項目でも)。
function ttMemberIsUsed(block) {
  var hit = false;
  block.querySelectorAll("input, select, textarea").forEach(function (el) {
    if (el.type === "checkbox" ? el.checked : String(el.value || "").trim()) hit = true;
  });
  return hit;
}
function ttSyncRowRequired() {
  document.querySelectorAll(".entry-row").forEach(function (row) {
    if (!row.getAttribute("data-req-scanned")) {
      row.querySelectorAll("[required]").forEach(function (el) { el.setAttribute("data-req-orig", "1"); });
      row.setAttribute("data-req-scanned", "1");
    }
    var used = ttRowIsUsed(row);
    // 団体戦は「行」単位で必須を切り替えると、上限人数ぶん全員の入力を求めてしまう。
    // 最少人数までは必須、それ以降は「書き始めた人だけ」必須にする
    // (例: 4〜7人の大会で5人目の氏名だけ書いたら、その人のふりがなは必須になる)。
    var blocks = row.querySelectorAll(".member-block[data-mi]");
    if (blocks.length) {
      blocks.forEach(function (b) {
        var live = used && (b.querySelector('[data-req-orig="1"][name$="_m' + b.getAttribute("data-mi") + '"]')
          ? true : ttMemberIsUsed(b));
        b.querySelectorAll('[data-req-orig="1"]').forEach(function (el) {
          if (live) el.setAttribute("required", "");
          else el.removeAttribute("required");
        });
      });
      // メンバー欄の外(チーム名など)は従来どおり行単位
      row.querySelectorAll('[data-req-orig="1"]').forEach(function (el) {
        if (el.closest(".member-block[data-mi]")) return;
        if (used) el.setAttribute("required", "");
        else el.removeAttribute("required");
      });
      return;
    }
    row.querySelectorAll('[data-req-orig="1"]').forEach(function (el) {
      if (used) el.setAttribute("required", "");
      else el.removeAttribute("required");
    });
  });
}

// 表示条件(data-wk/data-wv)の一括評価。参照先の値は「同じ選手行の回答」→「申込単位の回答」の順で
// 解決する(サーバ側 _customVisible と同じ規則)。非表示中は disabled にして送信・必須検証から外す。
function ttWhenSync() {
  const nodes = document.querySelectorAll('[data-wk]');
  nodes.forEach(function (el) {
    const key = el.getAttribute('data-wk');
    const want = el.getAttribute('data-wv') || "";
    // 参照先: 同じ選手行(.entry-row)に「〜_cust_key」があればそれ、
    // 無ければフォーム全体の「cust_key」(申込単位)。
    const row = el.closest('.entry-row');
    let src = row ? row.querySelector('[name$="_cust_' + key + '"]') : null;
    if (!src) src = document.querySelector('[name="cust_' + key + '"]');
    let v = "";
    if (src) v = (src.type === "checkbox") ? (src.checked ? "1" : "") : (src.value || "");
    const met = want ? (v === want) : !!v;
    el.style.display = met ? "" : "none";
    el.querySelectorAll('input,select,textarea').forEach(function (inp) { inp.disabled = !met; });
    if (el.tagName === "INPUT" || el.tagName === "SELECT") el.disabled = !met;
  });
}
// 選手1スロット分の可変項目(ふりがな/学年/性別/選手スコープ自由項目)のHTML。
// prefix は input 名の接頭辞(行スコープで一意)。所属(player_team)は addEntry 側で扱う。
// 生年月日(YYYY-MM-DD)から基準日時点の満年齢を返す(サーバ ageAtDate と同一ロジック)。
function ttAgeAt(birth, asOf) {
  // ここはテンプレートリテラル内に埋め込まれるクライアントJS。数字クラスは \\d と二重に
  // 書かないと、テンプレート評価時にバックスラッシュが食われて「リテラルの文字 d」に化け、
  // 生年月日が永遠にマッチせず「満N歳」ヒントが一切出なくなる(2026-07-27 修正)。
  const bm = String(birth || "").match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  const am = String(asOf || "").match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  if (!bm || !am) return null;
  let age = (+am[1]) - (+bm[1]);
  if ((+am[2]) < (+bm[2]) || ((+am[2]) === (+bm[2]) && (+am[3]) < (+bm[3]))) age--;
  return (age >= 0 && age < 150) ? age : null;
}
// 項目の表示名(主催者が field_meta.label で変更できる。未指定なら標準の日本語名)。
// 集計スプレッドシートの列名も同じ定義から作られるため、フォームの見出しと列名が必ず一致する。
function flabel(key, def) {
  const m = FIELD_CFG.field_meta && FIELD_CFG.field_meta[key];
  const l = m && typeof m.label === "string" ? m.label.trim() : "";
  return l || def;
}
function playerFieldsHtml(prefix, ev) {
  const evName = ev.name;
  let h = "";
  const furi = fstFor(evName, "furigana");
  if (furi !== "hidden") {
    const lb = escapeHtml(flabel("furigana", "ふりがな"));
    h += '<input type="text" name="' + prefix + '_furi" placeholder="' + lb + (furi === "required" ? " (必須)" : "") +
      '" aria-label="' + lb + '"' + (furi === "required" ? " required" : "") + ' oninput="recalcTotal()" />';
  }
  // 年齢自動判定が有効な種目は生年月日を入力(基準日=年度4/1 時点の満年齢で資格判定)。
  if (ev.age_check && ev.age_check.mode === "birthdate" && AGE_ASOF) {
    h += '<input type="date" name="' + prefix + '_bdate" aria-label="生年月日 (必須)" required ' +
      'title="生年月日(' + AGE_ASOF + ' 時点の満年齢で出場資格を判定します)" ' +
      'oninput="ttUpdateAge(this)" style="color:#555;" />' +
      '<span class="age-hint" style="font-size:12px;color:var(--ink-2);align-self:center;"></span>';
  }
  // 学年の扱い(gradeStateFor): 学生の種目は設定どおり、一般の部は任意で出す
  // (一般の部に学生が出場する場合に記入してもらう)、シニア・ラージの年代別は出さない。
  const grade = gradeStateFor(ev, evName);
  if (grade !== "hidden") {
    const lb = escapeHtml(flabel("grade", "学年"));
    // 一般の部で「なぜ学年を聞かれるのか」が分からないと空欄のまま出されるので、
    // 任意で出しているときはプレースホルダで用途を言う(例: 中3・高3が一般の部に出る場合)。
    const ph = grade === "required" ? lb + " (必須)"
      : (isStudentEvent(ev) ? lb : lb + " (学生の方のみ)");
    h += '<input type="text" name="' + prefix + '_grade" placeholder="' + escapeHtml(ph) +
      '" aria-label="' + lb + '"' + (grade === "required" ? " required" : "") + ' />';
  }
  const pg = fstFor(evName, "player_gender");
  if (pg !== "hidden") {
    const lb = escapeHtml(flabel("player_gender", "性別"));
    h += '<select name="' + prefix + '_pgender" aria-label="' + lb + '"' + (pg === "required" ? " required" : "") +
      '><option value="">' + lb + '</option><option value="male">男</option><option value="female">女</option></select>';
  }
  (FIELD_CFG.custom || []).filter(function (c) { return c && c.scope === "player"; }).forEach(function (c) {
    h += renderCustomClient(c, prefix + "_cust_" + c.key);
  });
  return h;
}
// 生年月日入力の隣に算出年齢を表示(入力補助。最終判定はサーバが権威)。
function ttUpdateAge(inp) {
  const hint = inp.parentNode ? inp.parentNode.querySelector(".age-hint") : null;
  if (!hint) return;
  const age = ttAgeAt(inp.value, AGE_ASOF);
  hint.textContent = age == null ? "" : ("満" + age + "歳");
}

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
    // 種目が多い大会では、出ない種目の入力欄まで最初から全部見えていると
    // 「これを全部埋めるのか」と誤解させ、画面も十数ページぶんに膨らむ。
    // 3種目までは全部開いたほうが早いので開き、4種目以上はたたんで「選んで開く」形にする。
    det.open = EVENTS.length <= 3;
    const fee = ev.fee || 0;
    const hasStuFee = (ev.fee_student != null && ev.fee_student !== fee);   // 中高生に別料金がある種目
    const feeStu = hasStuFee ? ev.fee_student : fee;
    const unit = isTeam ? "チーム" : (isDoubles ? "ペア" : "選手");
    // 見出しに出す件数の助数詞。「0 選手」は日本語として不自然なので、数え方を分ける
    const countUnit = isTeam ? "チーム" : (isDoubles ? "組" : "名");
    const unitSfx = isTeam ? " / チーム" : (isDoubles ? " / ペア" : " / 人");
    const feeTagHtml = hasStuFee
      ? '一般 ¥' + fee.toLocaleString("ja-JP") + ' ／ 中高生 ¥' + feeStu.toLocaleString("ja-JP") + unitSfx
      : '参加料 ¥' + fee.toLocaleString("ja-JP") + unitSfx;
    // 団体戦の人数の決まり(要項の「4人以上」「3〜4人」)を見出しに添える
    const minN = isTeam ? (ev.per_team_min || 0) : 0;
    const maxN = isTeam ? (ev.per_team || 0) : 0;
    const sizeTag = !isTeam ? "" :
      (minN && maxN && minN !== maxN) ? '<span class="cap-tag size">' + minN + '〜' + maxN + '人</span>'
      : (minN ? '<span class="cap-tag size">' + minN + '人以上</span>' : "");
    // 定員: 満員なら申込欄を出さず「受付終了」、残りわずかなら残り枠を添える
    const isFull = !!ev.full;
    const remain = (ev.remaining == null) ? null : ev.remaining;
    const capTag = isFull
      ? '<span class="cap-tag cap-full">受付終了（定員に達しました）</span>'
      : (remain != null && remain <= 5
          ? '<span class="cap-tag">残り' + remain + unit + '</span>'
          : "");
    det.innerHTML = '<summary>' +
      escapeHtml(ev.name) +
      '<span class="fee-tag">' + feeTagHtml + '</span>' +
      sizeTag +
      capTag +
      (isFull ? "" : '<span class="count-badge" id="count_' + idx + '" data-unit="' + countUnit + '" hidden></span>') +
      '</summary>' +
      (isFull
        ? '<div class="cap-closed">この種目は定員に達したため、申込を締め切りました。</div>'
        : '<div class="members" id="members_' + idx + '"></div>' +
          '<div class="add-buttons">' +
            '<button type="button" class="btn-add" onclick="addEntry(' + idx + ')">' +
              '+ ' + unit + 'を1つ追加</button>' +
            (isTeam ? '' :
              '<button type="button" class="btn-add btn-add-bulk" onclick="addEntryBulk(' + idx + ', 5)">' +
              '+ 5' + (isDoubles ? '組' : '人') + 'ぶんまとめて追加</button>') +
          '</div>');
    c.appendChild(det);
    // ★ 初期1行をプリ表示 (空行で何をすればいいか分かりやすく)。満員種目には行を出さない。
    if (!isFull) addEntry(idx);
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
    // 0件のときはバッジを出さない(「0 選手」は日本語として不自然で、しかも情報量がゼロ)。
    // 1件以上になって初めて「3名」「2組」「1チーム」と出す。たたんだ種目でも件数が見える。
    const unit = badge.dataset.unit || "件";
    badge.hidden = filled === 0;
    badge.textContent = filled === 0 ? "" : filled + unit;
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
  // 参加区分セグメント。大会が entry_categories を定義していればそれを、無ければ中高生別料金がある
  // 種目に限り従来の 一般/中学生/高校生 を自動表示する(後方互換)。各区分は value/表示ラベル/料金を持ち、
  // 料金は data-fee に載せて rowFee がそこから読む(区分ごと料金 fee_override に対応)。
  const hasStuFee = (ev.fee_student != null && ev.fee_student !== (ev.fee || 0));
  const seq = (window.__ttSeq = (window.__ttSeq || 0) + 1);
  let divSeg = "";
  let segOpts = null;
  if (Array.isArray(ev.entry_categories) && ev.entry_categories.length) {
    segOpts = ev.entry_categories.map(function (c) {
      const fee = (c.fee_override != null && c.fee_override !== "") ? (parseInt(c.fee_override) || 0) : (ev.fee || 0);
      return { value: String(c.value || c.label || ""), label: String(c.short || c.label || c.value || ""), fee: fee };
    }).filter(function (o) { return o.value || o.label; });
  } else if (hasStuFee) {
    segOpts = [{ value: "general", label: "一般", fee: ev.fee || 0 },
               { value: "middle", label: "中学生", fee: ev.fee_student || 0 },
               { value: "high", label: "高校生", fee: ev.fee_student || 0 }];
  }
  if (segOpts && segOpts.length) {
    divSeg = '<div class="div-label">参加区分を選択してください</div>' +
      '<div class="div-seg" role="radiogroup" aria-label="参加区分">' +
      segOpts.map(function (o, i) {
        return '<label class="seg"><input type="radio" name="ttdiv' + seq + '" value="' + escapeHtml(o.value) + '"' +
          ' data-fee="' + o.fee + '" data-label="' + escapeHtml(o.label) + '"' +
          (i === 0 ? ' checked' : '') + ' onchange="recalcTotal()">' +
          '<span>' + escapeHtml(o.label) + '<small>¥' + o.fee.toLocaleString("ja-JP") + '</small></span></label>';
      }).join('') + '</div>';
  }

  let html = '<div class="row-head"><span class="num">' + (idx + 1) + '</span>' +
    '<button type="button" class="btn-del" onclick="removeEntry(this, ' + eventIdx + ')">削除</button></div>';

  if (isTeam) {
    html += '<input type="text" name="ev' + eventIdx + '_team' + idx + '_name" placeholder="チーム名" aria-label="チーム名" oninput="recalcTotal()" style="margin-bottom:9px;" />';
    const per = ev.per_team || 6;
    // 要項の最少人数(例: プリンセス大会は4〜7人)。ここまでは必須、それ以降は任意にする。
    // 登録できる上限の人数ぶん欄を出しているだけなので、全部埋めさせてはいけない。
    const minN = Math.max(0, Math.min(per, parseInt(ev.per_team_min) || 0));
    const memberLabel = (i) => "メンバー" + (i + 1) + " 氏名" + (i < minN ? " (必須)" : " (任意)");
    // メンバーごとの可変項目(ふりがな・学年・性別・選手スコープの自由項目)。
    // 種目別設定で1つでも表示される項目があるときだけメンバーを枠で囲む
    // (何も無ければ従来どおり氏名だけのフラットな並び=既存の見た目を変えない)。
    const memberFields = playerFieldsHtml('ev' + eventIdx + '_team' + idx + '_mx', ev);
    if (memberFields) {
      for (let i = 0; i < per; i++) {
        const pre = 'ev' + eventIdx + '_team' + idx + '_m' + i;
        // 最少人数を超える枠は「書く人だけ」。付随項目(ふりがな等)の見出しから「(必須)」を外す
        // ---書かない人の欄に必須と表示されていると、埋めないと送れないと誤解させる。
        // required 属性自体は残す(ttSyncRowRequired が、書き始めた人にだけ効かせ直す)。
        const fields = i < minN ? playerFieldsHtml(pre + '_x', ev)
          : playerFieldsHtml(pre + '_x', ev).split(' (必須)"').join('"');
        html += '<div class="member-block" data-mi="' + i + '">' +
          '<div class="member-no">' + (i + 1) + '</div>' +
          '<div class="entry-grid">' +
          '<input type="text" name="' + pre + '" placeholder="' + memberLabel(i) + '" aria-label="メンバー' + (i + 1) + ' 氏名"' +
          (i < minN ? " required" : "") + ' oninput="recalcTotal()" />' +
          fields +
          '</div></div>';
      }
    } else {
      html += '<div class="entry-grid">';
      for (let i = 0; i < per; i++) {
        html += '<div class="member-block" data-mi="' + i + '" style="padding:0;border:none">' +
          '<input type="text" name="ev' + eventIdx + '_team' + idx + '_m' + i + '" placeholder="' + memberLabel(i) +
          '" aria-label="メンバー' + (i + 1) + ' 氏名"' + (i < minN ? " required" : "") + ' oninput="recalcTotal()" /></div>';
      }
      html += '</div>';
    }
    if (minN) {
      html += '<div class="member-hint">' + minN + '人まで必須です。' + (per > minN
        ? (minN + 1) + '人目から' + per + '人目までは、出場する方だけご記入ください'
          + (memberFields ? '（記入した方は他の欄も必要です）' : '') + '。' : '') + '</div>';
    }
  } else if (isDoubles) {
    // 所属(player_team)の状態で 所属入力の要否を切替(hidden=省略 / required=必須)。
    const ptm = fstFor(ev.name, "player_team");
    const teamInput = (n) => ptm === "hidden" ? "" :
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_t' + n + '" placeholder="所属' +
      (ptm === "required" ? " (必須)" : "") + '" aria-label="選手' + n + ' 所属"' +
      (ptm === "required" ? " required" : "") + ' oninput="recalcTotal()" />';
    // ペアは選手ごとに区切る。1つのグリッドに8欄まとめて流し込むと、ふりがな・学年が
    // 選手1のものか選手2のものか読めなくなる(項目数が大会設定で変わるため列がずれる)。
    // name属性は変えないので、送信データの形は従来どおり。
    const side = (n) => '<div class="pair-side">' +
      '<div class="pair-no">選手' + n + '</div>' +
      '<div class="entry-grid">' +
      '<input type="text" name="ev' + eventIdx + '_pair' + idx + '_n' + n + '" placeholder="氏名 (フルネーム)" aria-label="選手' + n + ' 氏名" oninput="recalcTotal()" />' +
      teamInput(n) +
      playerFieldsHtml('ev' + eventIdx + '_pair' + idx + '_' + n, ev) +
      '</div></div>';
    html += side(1) + side(2);
  } else {
    const ptm = fstFor(ev.name, "player_team");
    const teamInput = ptm === "hidden" ? "" :
      '<input type="text" name="ev' + eventIdx + '_p' + idx + '_team" placeholder="所属' +
      (ptm === "required" ? " (必須)" : "") + '" aria-label="所属"' +
      (ptm === "required" ? " required" : "") + ' oninput="recalcTotal()" />';
    html += '<div class="entry-grid">' +
      '<input type="text" name="ev' + eventIdx + '_p' + idx + '_name" placeholder="氏名 (フルネーム)" aria-label="氏名 (フルネーム)" oninput="recalcTotal()" />' +
      teamInput +
      playerFieldsHtml('ev' + eventIdx + '_p' + idx, ev) +
      '</div>';
  }
  html += divSeg;
  row.innerHTML = html;
  container.appendChild(row);
  ttFormSync();   // 追加行の表示条件と必須状態(未記入なので必須は外れる)を初期化
  recalcTotal();
}

function removeEntry(btn, eventIdx) {
  btn.closest(".entry-row").remove();
  ttFormSync();   // 残った行の必須・表示条件を評価し直す
  recalcTotal();
}

// 行の参加区分の value を返す(entry_categories の value または general/middle/high)。無区分は general。
function rowDivision(row) {
  const r = row.querySelector(".div-seg input:checked");
  return r ? r.value : "general";
}
// 選択中の区分の表示ラベル(entry_categories の short/label。無区分は "")。
function rowDivLabel(row) {
  const r = row.querySelector(".div-seg input:checked");
  return r ? (r.getAttribute("data-label") || "") : "";
}
// 行の料金は選択区分の data-fee から読む(区分ごと料金 fee_override / 中高生別料金の両対応)。
function rowFee(ev, row) {
  let unit = ev.fee || 0;
  const r = row.querySelector(".div-seg input:checked");
  if (r) { const f = r.getAttribute("data-fee"); if (f != null && f !== "") unit = parseInt(f) || 0; }
  if (ev.fee_unit !== "person") return unit;
  // 「1人あたり」の種目は人数を掛ける(団体=記入済みメンバー数 / ダブルス=2)。
  // 実例: まりもオープンの団体戦は1人1,000円なので、4人チームなら4,000円。
  let n = 1;
  if (ev.type === "team") {
    n = 0;
    row.querySelectorAll('input[name*="_m"]').forEach(function (inp) {
      if (/_m\\d+$/.test(inp.name || "") && String(inp.value || "").trim()) n++;
    });
  } else if (ev.type === "doubles") {
    n = 2;
  }
  return unit * Math.max(1, n);
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
  // 有料オプション(弁当等)。単価は定義から取り、上限を超える入力はその場で丸める
  // (最終的な請求額はサーバが同じ定義で計算し直すので、ここは案内の表示)。
  total += optionsTotal();
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
    advisor: fd.get("advisor") || "",
    coach: fd.get("coach") || "",
    note: fd.get("note") || "",
    submitted_at: new Date().toISOString(),
    entries: [],
    total_amount: 0,
    cf_turnstile_token: fd.get("cf-turnstile-response") || "",   // Turnstile ウィジェットが挿入する隠しトークン
    hp_url: fd.get("hp_url") || "",                              // ハニーポット(空のはず)
    _consent: fd.get("consent_check") ? true : false,           // 同意書提出の確認(consent_age がある大会)
  };
  // 申込単位スコープの自由項目(scope=submission)を収集。checkbox は true/false。
  const subAnswers = {};
  (FIELD_CFG.custom || []).filter(function (c) { return c && c.scope === "submission"; }).forEach(function (c) {
    const el = form.querySelector('[name="cust_' + c.key + '"]');
    if (!el || el.disabled) return;   // disabled=表示条件で非表示中(回答として送らない)
    const v = el.type === "checkbox" ? !!el.checked : (el.value || "");
    if (v !== "" && v !== false) subAnswers[c.key] = v;
  });
  if (Object.keys(subAnswers).length) data.extra = subAnswers;
  // 有料オプションの数量。金額はサーバが定義から計算するので、ここでは数量だけを送る。
  const optQty = gatherOptions();
  if (Object.keys(optQty).length) data.options = optQty;

  EVENTS.forEach((ev, idx) => {
    const container = document.getElementById("members_" + idx);
    if (!container) return;
    // ★ DOM上の各行を「行スコープのセレクタ」で読む (recalcTotal と同じ方式)。
    //   旧実装は現在のDOM位置(ri)で input 名を組み立てていたため、途中行を削除すると
    //   名前(=追加時のindex)とズレて以降の選手が送信から欠落していた。行内の input を
    //   index非依存で拾うことでデータ欠落を解消し、表示合計と送信内容を常に一致させる。
    // 選手1スロット分の可変項目(ふりがな/学年/性別/選手スコープ自由項目)を行スコープで読む。
    //   token: シングルスは ""(接頭辞なし)、ダブルスは "_1"/"_2"(選手スロット識別)。
    // 接尾辞一致(name$=)で読む。前方/部分一致だと custom key(例 "furiX")が構造フィールド
    //   (_furi 等)と誤マッチするため。custom key は英数字_に無害化済み(sanitizeFieldConfig)。
    const readSlot = (row, token) => {
      const q = (suf) => { const el = row.querySelector('[name$="' + token + suf + '"]'); return el ? (el.value || "") : ""; };
      const furigana = q("_furi");
      const gender = q("_pgender");
      const ex = {};
      const g = q("_grade"); if (g) ex.grade = g;
      const bd = q("_bdate"); if (bd) ex.birth_date = bd;   // 年齢自動判定用(サーバが基準日で満年齢を検証)
      const answers = {};
      (FIELD_CFG.custom || []).filter((c) => c && c.scope === "player").forEach((c) => {
        const el = row.querySelector('[name$="' + token + "_cust_" + c.key + '"]');
        if (!el || el.disabled) return;   // disabled=表示条件で非表示中(回答として送らない)
        const v = el.type === "checkbox" ? !!el.checked : (el.value || "");
        if (v !== "" && v !== false) answers[c.key] = v;
      });
      if (Object.keys(answers).length) ex.answers = answers;
      return { furigana, gender, extra: Object.keys(ex).length ? ex : null };
    };
    Array.from(container.children).forEach((row) => {
      const val = (sel) => { const el = row.querySelector(sel); return el ? (el.value || "") : ""; };
      const obj = { event: ev.name, type: ev.type || "singles",
        fee: rowFee(ev, row), division: rowDivision(row),     // 区分別料金 + 区分の value
        division_label: rowDivLabel(row) };                    // 区分の表示ラベル(entry_categories 用)
      if (ev.type === "team") {
        obj.team_name = val('input[name*="_team"][name$="_name"]');
        obj.members = [];
        // メンバー氏名は「_m<数字>」で終わる入力だけを拾う(可変項目 _m0_x_furi 等と混ざらないように)。
        // 数字クラスは \\d と二重に書く(テンプレートリテラル内なので、単一だと文字dに化ける)。
        const memberInputs = Array.from(row.querySelectorAll('input[name*="_m"]'))
          .filter((inp) => /_m\\d+$/.test(inp.name || ""));
        const detail = [];
        memberInputs.forEach((inp) => {
          const v = (inp.value || "").trim();
          if (v) obj.members.push(v);
          // メンバーごとの可変項目(ふりがな・学年・性別・自由回答)。項目を出していない
          // 種目では readSlot が空を返すので detail も空のままになる。
          const s = readSlot(row, inp.name.replace(/^.*?(_m\\d+)$/, "$1") + "_x");
          if (v) {
            const m = { name: v };
            if (s.furigana) m.furigana = s.furigana;
            if (s.gender) m.gender = s.gender;
            if (s.extra) Object.assign(m, s.extra);
            detail.push(m);
          }
        });
        // 可変項目を1つでも集めたときだけ members_detail を送る(従来の申込は形を変えない)。
        if (detail.some((m) => Object.keys(m).length > 1)) obj.members_detail = detail;
        if (!obj.team_name && obj.members.length === 0) return;
      } else if (ev.type === "doubles") {
        obj.name1 = val('input[name$="_n1"]');
        obj.name2 = val('input[name$="_n2"]');
        obj.team1 = val('input[name$="_t1"]');
        obj.team2 = val('input[name$="_t2"]');
        obj.team = obj.team1; // 後方互換
        if (!obj.name1 && !obj.name2) return;
        // ペアの可変項目: ふりがな→氏名/相方の読み、学年/性別/自由回答→extra_json.players[]。
        const s1 = readSlot(row, "_1"), s2 = readSlot(row, "_2");
        if (s1.furigana) obj.furigana1 = s1.furigana;
        if (s2.furigana) obj.furigana2 = s2.furigana;
        if (s1.gender) obj.gender = s1.gender;
        if (s2.gender) obj.partner_gender = s2.gender;
        if (s1.extra || s2.extra) obj.extra_json = { players: [s1.extra || {}, s2.extra || {}] };
      } else {
        obj.name = val('input[name$="_name"]');
        obj.team = val('input[name$="_team"]');
        if (!obj.name) return;
        // シングルスの可変項目: ふりがな→氏名の読み、学年/自由回答→extra_json、性別→gender。
        const s = readSlot(row, "");
        if (s.furigana) obj.furigana = s.furigana;
        if (s.gender) obj.gender = s.gender;
        if (s.extra) obj.extra_json = s.extra;
      }
      data.entries.push(obj);
      data.total_amount += obj.fee;
    });
  });
  data.total_amount += optionsTotal();   // 有料オプション分(確認画面の表示用。請求額はサーバが再計算)

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
  // 有料オプション(弁当等)の明細
  (ENTRY_OPTIONS || []).forEach(function (o) {
    const n = (data.options || {})[o.key] || 0;
    if (!n) return;
    lines.push("・" + o.label + ": " + n + o.unit +
      "  ¥" + ((o.price || 0) * n).toLocaleString("ja-JP"));
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
// 申込の「同一性」を表す鍵。同じ内容の再送(二度押し・通信リトライ)はこれが一致し、
// サーバ側で1件として扱われる=重複登録が起きない。
//
// 申込内容の一部だけを拾ってはいけない。以前は 氏名・団体名・種目 だけを見ていたため、
// 参加区分を選び直した / ふりがなを直した / 弁当の数量を変えた だけの送り直しが
// 「同じ申込」と判定され、前回の内容のまま「受け付けました」と返っていた
// (申込者は直ったと思い、本部には古い内容が残る)。
// そこで送信内容そのものを鍵にする。毎回変わる値(Turnstileトークン)だけ除く。
function ttOpId(data) {
  var copy = {};
  Object.keys(data || {}).forEach(function (k) {
    if (k === "cf_turnstile_token" || k === "hp_url") return;   // 送信のたびに変わる/意味を持たない
    copy[k] = data[k];
  });
  return "entry-" + TOURNAMENT_ID + "-" + ttHash(JSON.stringify(copy));
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
          this.textContent = "コピーしました";
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
          this.textContent = "コピーしました";
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

// ══ 道しるべ(見本案2・2026-07-27 承認): 行程レールと残り必須の表示 ══
// 目的は「いま何を書いていて、あと何が要るか」を常に見せること。
// 埋込(iframe自動高さ)ではページがスクロールしないため sticky/fixed が効かない。
// その環境では貼り付けをやめ、レールをフォーム冒頭に、残数を送信ボタンの手前に置く。
var TT_RAIL = null;
function ttBuildRail() {
  var form = document.getElementById("entryForm");
  if (!form || document.getElementById("ttRail")) return;
  var secs = Array.prototype.slice.call(form.querySelectorAll(".form-section"));
  if (secs.length < 2) return;
  var submitBtn = document.getElementById("submitBtn");
  var submitSec = submitBtn && submitBtn.closest(".form-section");
  var groups = [
    { label: "連絡先", secs: [secs[0]] },
    { label: "種目・選手", secs: secs.filter(function (s) { return s.querySelector("#eventsContainer"); }) },
    { label: "確認事項", secs: secs.filter(function (s, i) { return i > 0 && !s.querySelector("#eventsContainer") && s !== submitSec; }) },
    { label: "送信", secs: submitSec ? [submitSec] : (submitBtn ? [submitBtn] : []), isSubmit: true },
  ].filter(function (g) { return g.secs.length; });
  if (groups.length < 2) return;

  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var rail = document.createElement("div");
  rail.id = "ttRail";
  rail.setAttribute("role", "navigation");
  rail.setAttribute("aria-label", "入力の進み具合");
  groups.forEach(function (g) {
    var el = document.createElement("button");
    el.type = "button";
    el.className = "step";
    el.appendChild(document.createTextNode(g.label));
    var st = document.createElement("span");
    st.className = "st";
    st.textContent = "未入力";
    el.appendChild(st);
    el.addEventListener("click", function () {
      g.secs[0].scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    });
    g.el = el; g.stEl = st;
    rail.appendChild(el);
  });
  var bar = document.createElement("div");
  bar.className = "bar";
  bar.style.width = (100 / groups.length) + "%";
  rail.appendChild(bar);
  form.parentNode.insertBefore(rail, form);

  var remain = document.createElement("div");
  remain.id = "ttRemain";
  // 埋込では送信ボタンの手前に置く(画面外に固定しても見えないため)
  if (document.body.classList.contains("tt-embedded") && submitBtn && submitBtn.parentNode) {
    submitBtn.parentNode.insertBefore(remain, submitBtn);
  } else {
    document.body.appendChild(remain);
  }

  var current = -1;
  function setCurrent(i) {
    if (current === i) return;
    current = i;
    groups.forEach(function (g, j) { g.el.classList.toggle("cur", j === i); });
    bar.style.transform = "translateX(" + (i * 100) + "%)";
  }
  // 現在地の追従は IntersectionObserver で行う(scrollイベントは使わない)。
  // 送信ボタンは画面下端に来ても判定帯に入らないことがあるため、最下部到達で最終工程に送る。
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      groups.forEach(function (g, i) { if (g.secs.indexOf(e.target) >= 0) setCurrent(i); });
    });
  }, { rootMargin: "-35% 0px -55% 0px" });
  groups.forEach(function (g) { g.secs.forEach(function (s) { io.observe(s); }); });
  setCurrent(0);

  TT_RAIL = { groups: groups, remain: remain, setCurrent: setCurrent };
  ttRailUpdate();
}
// 表示中の必須欄だけを数える(表示条件で隠れた欄・未記入行の解除済み必須は数えない)。
function ttRailReqs(root) {
  return Array.prototype.slice.call(root.querySelectorAll("[required]")).filter(function (el) {
    return !el.disabled && el.offsetParent !== null;
  });
}
function ttRailFilled(el) {
  if (el.type === "checkbox") return el.checked;
  return String(el.value || "").trim() !== "";
}
function ttRailUpdate() {
  if (!TT_RAIL) return;
  // left は「まだ埋まっていない入力欄の数」だけを数える。
  // 出場種目の選択は「欄を埋める」ことではないので、ここに足し込むと画面の数字が実際と食い違う
  // (欄は4つしか無いのに「あと5項目」と出て、5つ目を探させてしまう)。別の条件として扱う。
  var left = 0;
  var picked = 0;
  try { picked = gatherFormData().entries.length; } catch (e) { picked = 0; }
  var needEvent = picked === 0;
  TT_RAIL.groups.forEach(function (g) {
    if (g.isSubmit) return;
    var reqs = [];
    g.secs.forEach(function (s) { reqs = reqs.concat(ttRailReqs(s)); });
    var n = reqs.filter(function (el) { return !ttRailFilled(el); }).length;
    left += n;
    var isEvents = g.secs.some(function (s) { return s.querySelector && s.querySelector("#eventsContainer"); });
    if (isEvents) {
      // 未記入の行は必須が外れているため、欄の数では「任意」に見えてしまう。件数で見る。
      if (needEvent) { g.stEl.textContent = "未選択"; g.el.classList.remove("done"); }
      else if (n === 0) { g.stEl.textContent = picked + "件 済"; g.el.classList.add("done"); }
      else { g.stEl.textContent = "あと" + n; g.el.classList.remove("done"); }
      return;
    }
    if (!reqs.length) { g.stEl.textContent = "任意"; g.el.classList.remove("done"); }
    else if (n === 0) { g.stEl.textContent = "済"; g.el.classList.add("done"); }
    else { g.stEl.textContent = "あと" + n; g.el.classList.remove("done"); }
  });
  var ready = left === 0 && !needEvent;
  TT_RAIL.groups.forEach(function (g) {
    if (!g.isSubmit) return;
    g.stEl.textContent = ready ? "できます" : "準備中";
    g.el.classList.toggle("done", ready);
  });
  TT_RAIL.remain.className = ready ? "ok" : "";
  // 「あと何をすればよいか」を、欄の数と種目の選択に分けて言う。
  TT_RAIL.remain.textContent = ready ? "送信できます"
    : left === 0 ? "出場種目を選んでください"
    : needEvent ? "必須があと" + left + "項目 ・ 出場種目 未選択"
    : "必須があと" + left + "項目";
}

// 表示条件つき項目の連動 + 未記入行の必須解除(入力のたびに評価し直す。件数は高々数十なので全走査で足りる)
function ttFormSync() { ttWhenSync(); ttSyncRowRequired(); ttRailUpdate(); }
document.getElementById("entryForm").addEventListener("input", ttFormSync);
document.getElementById("entryForm").addEventListener("change", ttFormSync);

// 埋込(iframeで高さを親に渡す運用)かどうか。ページ自体がスクロールしないため
// sticky/fixed が効かず、道しるべの置き場所を変える必要がある。
try {
  if (window.self !== window.top) document.body.classList.add("tt-embedded");
} catch (e) { document.body.classList.add("tt-embedded"); }

// 初期化 (失敗しても安全網が案内を表示)
try {
  renderEvents();
  recalcTotal();
  ttBuildRail();
  ttFormSync();
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
  /* 申込後の変更(選手の差し替え・取消) */
  .act-row td{padding-top:0!important;border-top:none!important;}
  .mini{padding:7px 12px;margin:0 6px 6px 0;font-size:12.5px;font-weight:700;font-family:inherit;
    background:#fff;color:var(--ink);border:1.5px solid var(--line);border-radius:7px;cursor:pointer;
    min-height:34px;}
  .mini:hover{background:#faf7f2;border-color:var(--ink-2);}
  .mini.danger{color:var(--red);border-color:#e8c9cc;}
  .mini.danger:hover{background:#fdf3f4;}
  .mbg{position:fixed;inset:0;background:rgba(33,27,21,.45);display:flex;align-items:center;
    justify-content:center;padding:18px;z-index:100;}
  .mbox{background:var(--card);border-radius:12px;padding:22px;max-width:460px;width:100%;
    max-height:88vh;overflow:auto;box-shadow:0 24px 60px -20px rgba(33,27,21,.6);}
  .mbox h3{font-size:17px;font-weight:800;margin-bottom:14px;}
  .mbox .fld{margin-bottom:12px;}
  .mbox .fld label{display:block;font-size:12.5px;font-weight:700;color:var(--ink-2);margin-bottom:5px;}
  .mbox .fld input{width:100%;padding:11px 12px;border:1.5px solid var(--line);border-radius:8px;
    font-size:16px;font-family:inherit;box-sizing:border-box;}
  .mbox .fld input:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px rgba(192,21,38,.12);}
  .mbox .note{font-size:12.5px;color:var(--ink-2);background:#faf7f2;padding:10px 12px;
    border-radius:8px;line-height:1.7;margin-bottom:12px;}
  .merr{color:var(--err);font-size:13px;margin:8px 0 0;line-height:1.6;}
  .mfoot{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}
  .btn.ghost{background:#fff;color:var(--ink);border:1.5px solid var(--line);}
  .btn.ghost:hover{background:#faf7f2;}
  .btn.danger{background:var(--red);}
  @media(max-width:480px){
    .mfoot{flex-direction:column-reverse;}
    .mfoot .btn{width:100%;}
  }
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
    return "";
  }
  function show(id,on){document.getElementById(id).classList[on?"remove":"add"]("hidden");}
  function setMsg(html){document.getElementById("msg").innerHTML=html?('<div class="card"><div class="msg err">'+html+'</div></div>'):"";}

  function render(d){
    setMsg("");
    document.getElementById("rToken").textContent=document.getElementById("tokenInput").value.trim().toUpperCase();
    document.getElementById("rTournament").textContent=(d.tournament&&d.tournament.name||"")+(d.tournament&&d.tournament.date?(" ("+d.tournament.date+")"):"");
    document.getElementById("rTeam").textContent=d.team_name||"未登録";
    document.getElementById("rContact").textContent=d.contact_name||"未登録";
    document.getElementById("rDate").textContent=d.created_at||"";
    LAST=d;
    var rows=(d.entries||[]).map(function(e,i){
      var who=esc(e.name||"");
      if(e.is_doubles&&e.partner_name)who+=" / "+esc(e.partner_name);
      if(e.team_members&&e.team_members.length)who+='<br><span style="font-size:12px;color:#6c6153">'+esc(e.team_members.join("、"))+'</span>';
      // 締切前・組合せ作成前だけ操作を出す。できないときは理由を小さく添える。
      var act="";
      if(e.cancelled){
        act='<span style="font-size:12px;color:#6c6153">取消済み</span>';
      }else if(e.editable){
        if(e.is_doubles){
          act='<button type="button" class="mini" onclick="openEdit('+i+',1)">選手1を変更</button>'+
              '<button type="button" class="mini" onclick="openEdit('+i+',2)">選手2を変更</button>';
        }else{
          act='<button type="button" class="mini" onclick="openEdit('+i+',1)">選手を変更</button>';
        }
        act+='<button type="button" class="mini danger" onclick="openCancel('+i+')">取り消す</button>';
      }else if(e.lock_reason){
        act='<span style="font-size:11.5px;color:#6c6153">'+esc(e.lock_reason)+'</span>';
      }
      var tr='<tr'+(e.cancelled?' style="opacity:.55"':'')+'><td>'+esc(e.event)+'</td><td>'+who+'</td><td>'+esc(divLabel(e))+
        '</td><td class="num">'+(e.cancelled?"—":yen(e.fee))+'</td><td>'+(e.cancelled?'<span class="badge">取消</span>':statusBadge(e.status))+'</td></tr>';
      if(act)tr+='<tr class="act-row"><td colspan="5">'+act+'</td></tr>';
      return tr;
    }).join("");
    document.getElementById("rRows").innerHTML=rows||'<tr><td colspan="5" style="color:#6c6153">エントリーがありません</td></tr>';
    document.getElementById("rTotal").textContent=yen(d.total_amount);
    show("result",true);
  }

  // ── 申込後の選手変更(締切前・組合せ作成前のみ) ──────────────────
  var LAST=null, TOKEN="";
  function openEdit(idx,slot){
    var e=(LAST&&LAST.entries||[])[idx]; if(!e)return;
    var cur = slot===2 ? (e.name2||e.partner_name||"") : (e.name1||e.name||"");
    var curFuri = slot===2 ? (e.furigana2||"") : (e.furigana||"");
    var curTeam = slot===2 ? (e.team2||"") : (e.team||"");
    modal("選手を変更",
      '<div class="fld"><label>新しい選手の氏名</label>'+
      '<input id="mName" type="text" value="'+esc(cur)+'" placeholder="例: 鈴木 三郎"></div>'+
      '<div class="fld"><label>ふりがな</label>'+
      '<input id="mFuri" type="text" value="'+esc(curFuri)+'" placeholder="例: すずき さぶろう"></div>'+
      '<div class="fld"><label>所属</label>'+
      '<input id="mTeam" type="text" value="'+esc(curTeam)+'" placeholder="例: 釧路湖陵"></div>'+
      '<div class="fld"><label>変更の理由（任意）</label>'+
      '<input id="mReason" type="text" placeholder="例: ケガのため"></div>'+
      '<div class="note">変更前: '+esc(e.event)+' / '+esc(cur||"(未記入)")+'</div>',
      "この内容で変更する",
      function(){
        return send("/entrants/"+encodeURIComponent(e.entrant_id)+"/replace",{
          slot:slot,
          name:val("mName"), furigana:val("mFuri"), team:val("mTeam"), reason:val("mReason"),
        });
      });
  }
  function openCancel(idx){
    var e=(LAST&&LAST.entries||[])[idx]; if(!e)return;
    modal("出場を取り消す",
      '<div class="note">'+esc(e.event)+' / '+esc(e.name||"")+' の出場を取り消します。<br>'+
      'この操作の後、同じ内容で申し込み直すことはできません（再度お申し込みください）。</div>'+
      '<div class="fld"><label>取消の理由（任意）</label>'+
      '<input id="mReason" type="text" placeholder="例: 部活の都合により"></div>',
      "取り消す",
      function(){
        return send("/entrants/"+encodeURIComponent(e.entrant_id)+"/cancel",{ reason:val("mReason") });
      }, true);
  }
  function val(id){var el=document.getElementById(id);return el?String(el.value||"").trim():"";}
  function send(path,body){
    return fetch("/api/public/applicants/"+encodeURIComponent(TOKEN)+path,{
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
    }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(x){
        if(!x.ok||x.j.error){ return { error: x.j.error||"変更できませんでした" }; }
        render(x.j);
        return { ok:true };
      })
      .catch(function(){ return { error:"通信エラーが発生しました。時間をおいて再度お試しください。" }; });
  }
  // 簡易モーダル(この画面だけで使う。外部ライブラリ不要)
  function modal(title, bodyHtml, okLabel, onOk, danger){
    var bg=document.createElement("div");
    bg.className="mbg";
    bg.innerHTML='<div class="mbox" role="dialog" aria-modal="true">'+
      '<h3>'+esc(title)+'</h3>'+
      '<div class="mbody">'+bodyHtml+'</div>'+
      '<div class="merr" id="mErr"></div>'+
      '<div class="mfoot">'+
      '<button type="button" class="btn ghost" id="mCancel">やめる</button>'+
      '<button type="button" class="btn'+(danger?" danger":"")+'" id="mOk">'+esc(okLabel)+'</button>'+
      '</div></div>';
    document.body.appendChild(bg);
    var close=function(){ if(bg.parentNode)bg.parentNode.removeChild(bg); };
    bg.querySelector("#mCancel").addEventListener("click",close);
    bg.addEventListener("click",function(ev){ if(ev.target===bg)close(); });
    var ok=bg.querySelector("#mOk");
    ok.addEventListener("click",function(){
      ok.disabled=true; ok.textContent="送信中…";
      Promise.resolve(onOk()).then(function(r){
        if(r&&r.error){
          bg.querySelector("#mErr").textContent=r.error;
          ok.disabled=false; ok.textContent=okLabel;
          return;
        }
        close();
      });
    });
    var first=bg.querySelector("input"); if(first)first.focus();
  }

  function lookup(token){
    token=String(token||"").trim();
    if(!token){setMsg("申込番号を入力してください。");return;}
    TOKEN=token.toUpperCase();
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

  // 表の中のボタン(onclick)から呼べるように公開する。この画面は即席のIIFEで包まれているため。
  window.openEdit=openEdit;
  window.openCancel=openCancel;

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
