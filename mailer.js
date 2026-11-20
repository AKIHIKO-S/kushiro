// ═══════════════════════════════════════════════════════
// メール送信 (申込控え / 管理者通知)
// ───────────────────────────────────────────────────────
// 環境変数で SMTP 設定:
//   SMTP_HOST     (default: smtp.gmail.com)
//   SMTP_PORT     (default: 465)
//   SMTP_SECURE   (default: true if port 465)
//   SMTP_USER     (Gmail アドレス)
//   SMTP_PASS     (Gmail App Password)
//   SMTP_FROM     (差出人表示, e.g. "釧路卓球協会 <kushiro@example.com>")
//   ADMIN_EMAIL   (管理者宛通知メールアドレス)
//
// 未設定の場合は、関数は { ok: false, skipped: true } を返すだけで例外を投げない。
// ═══════════════════════════════════════════════════════
const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_SECURE = process.env.SMTP_SECURE
  ? (process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === "1")
  : (SMTP_PORT === 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `釧路卓球協会 <${SMTP_USER}>` : "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  if (!SMTP_USER || !SMTP_PASS) return null;
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
  return _transporter;
}

function isEnabled() {
  return !!(SMTP_USER && SMTP_PASS);
}

function validRecipient(value) {
  return typeof value === "string" && value.trim().length <= 200 &&
    /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+$/i.test(value.trim());
}

function answerLines(answers, fields = []) {
  return fields.flatMap(({ key, label }) => {
    const value = answers && Object.hasOwn(answers, key) ? answers[key] : null;
    if (value == null || value === "" || !["string", "number", "boolean"].includes(typeof value)) return [];
    return [`${label}: ${typeof value === "boolean" ? (value ? "はい" : "いいえ") : value}`];
  });
}

function entryPersonLines(e, fields) {
  const ex = e.extra_json || {};
  const slot = (name, team, extra = {}) => {
    if (!name) return "";
    const values = [team, extra.grade && `学年: ${extra.grade}`, extra.age && `年齢: ${extra.age}`,
      ...answerLines(extra.answers, fields)].filter(Boolean);
    return `${name}${values.length ? `（${values.join("、")}）` : ""}`;
  };
  if (e.type === "team") return [e.team_name, ...(e.members || []).map((name, i) => slot(name, "", (e.members_detail || [])[i]))].filter(Boolean);
  if (e.type === "doubles" || e.type === "mixed") {
    const players = ex.players || [];
    return [slot(e.name1, e.team1, players[0]), slot(e.name2, e.team2, players[1])].filter(Boolean);
  }
  return [slot(e.name, e.team, ex)].filter(Boolean);
}

function entryText(e, fields) {
  const division = e.division_label ? `（${e.division_label}）` : "";
  return `・${e.event}${division}: ${entryPersonLines(e, fields).join(" / ")} - ${formatYen(e.fee)}`;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const signatureGuide = "大会等のメール配信に関するアドレスの追加・変更・削除は下記からお願いいたします。";
const signatureForm = "https://forms.gle/CSP5RwciRL7GFALM6";
const signatureMail = "kushirotta@gmail.com";
const signatureSite = "https://www.kushirotta.jp/";
const signatureRule = '"'.repeat(62);
const signatureText = [signatureGuide, signatureForm, signatureRule, "釧路卓球協会",
  `Mail：${signatureMail}`, `URL：${signatureSite}`, signatureRule].join("\n");
const signatureHtml = `<div style="margin-top:28px;font-size:13px;line-height:1.65;color:#57534e;">
  ${signatureGuide}<br><a href="${signatureForm}">${signatureForm}</a>
  <div style="margin-top:10px;padding:8px 0;border-block:1px solid #a8a29e;">
    釧路卓球協会<br>Mail：<a href="mailto:${signatureMail}">${signatureMail}</a><br>
    URL：<a href="${signatureSite}">${signatureSite}</a>
  </div>
</div>`;

function formatYen(n) {
  const v = parseInt(n) || 0;
  return `¥${v.toLocaleString("ja-JP")}`;
}

// 大会設定 (event_config) の種目別参加料マップ。
function eventFeeMap(tournament) {
  let cfg = [];
  try {
    cfg = typeof tournament.event_config === "string"
      ? JSON.parse(tournament.event_config || "[]")
      : (tournament.event_config || []);
  } catch (e) { cfg = []; }
  const map = {};
  (Array.isArray(cfg) ? cfg : []).forEach(c => {
    if (!c || !c.name) return;
    const f = parseInt(c.fee, 10);
    if (!(f >= 0)) return;
    const fs = parseInt(c.fee_student, 10);   // 中高校生料金 (未設定なら null=一般と同額)
    map[String(c.name).trim()] = {
      fee: f, fee_student: (fs >= 0 ? fs : null),
      categories: Array.isArray(c.entry_categories) && c.entry_categories.length ? c.entry_categories : null,
      // 料金の単位("person"=1人あたり。団体戦で人数分を請求する大会がある)
      fee_unit: c.fee_unit === "person" ? "person" : "entry",
    };
  });
  return map;
}

// 各申込の参加料と合計をサーバ側で確定する (#26)。
// クライアント供給の fee / total_amount は信用せず、設定済み(event_config)の料金を最優先。
// 参加区分(division: general/student)が中高校生なら fee_student を使う。
// 設定に無い種目(お弁当/懇親会等の任意項目)のみ、申込側の fee をフォールバックとして使う。
function authoritativeFees(tournament, entries) {
  const map = eventFeeMap(tournament);
  let total = 0;
  // 「1人あたり料金」の種目では申込の人数を掛ける(db.js の feeQtyOf と同じ規則)
  const qtyOf = (e) => {
    const t = e.type || "singles";
    if (t === "team") {
      const ms = Array.isArray(e.members) ? e.members.filter(m => String(m || "").trim()) : [];
      return Math.max(1, ms.length);
    }
    if (t === "doubles" || t === "mixed") return 2;
    return 1;
  };
  const list = (entries || []).map(e => {
    const cfg = map[String(e.event || "").trim()];
    let fee;
    if (cfg) {
      let unit;
      if (cfg.categories) {
        // entry_categories がある種目は選択区分の fee_override を優先(無ければ一般料金)。
        const cat = cfg.categories.find(x => x && String(x.value || x.label) === String(e.division));
        unit = (cat && cat.fee_override != null && cat.fee_override !== "") ? (parseInt(cat.fee_override, 10) || 0) : cfg.fee;
      } else {
        const isStudent = e.division && e.division !== "general";   // 中学生/高校生(旧 student 含む)
        unit = (isStudent && cfg.fee_student != null) ? cfg.fee_student : cfg.fee;
      }
      fee = cfg.fee_unit === "person" ? unit * qtyOf(e) : unit;
    } else {
      fee = parseInt(e.fee, 10) || 0;
    }
    total += fee;
    return Object.assign({}, e, { fee });
  });
  return { entries: list, total };
}

// 申込内容を HTML テーブルにする
function entriesTable(entries, fields) {
  if (!entries || !entries.length) return "";
  const rows = entries.map(e => {
    // label は「エスケープ済みの断片 + 自分で書いたタグ」を組み立てた HTML。
    // 出力時にもう一度 esc() を通すとタグが文字として見える(実際にメールで
    // 「<br><span style=...>区分: …</span>」がそのまま表示された)。
    // 値は必ずここで esc() し、出力側では素通しにする。
    let label = esc(e.event || "(種目不明)");
    // 参加区分(entry_categories のラベル / 中高生区分)があれば種目名の下に添える。
    if (e.division_label) label += `<br><span style="font-size:12px;color:#92400e;">区分: ${esc(e.division_label)}</span>`;
    // ★ 全てのユーザー入力を esc() でエスケープ (XSS / メールインジェクション対策)
    let detail = "";
    if (e.type === "team") {
      const members = (e.members || []).map(m => esc(m)).join("、");
      detail = `団体: ${esc(e.team_name || "")}<br>メンバー: ${members}`;
    } else if (e.type === "doubles") {
      const t1 = esc(e.team1 || e.team || "");
      const t2 = esc(e.team2 || e.team1 || e.team || "");
      detail = `${esc(e.name1 || "")} (${t1})<br>${esc(e.name2 || "")} (${t2})`;
    } else {
      detail = `${esc(e.name || "")} (${esc(e.team || "")})`;
    }
    if (e.extra_json || e.members_detail) detail = entryPersonLines(e, fields).map(esc).join("<br>");
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${detail}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatYen(e.fee)}</td>
    </tr>`;
  }).join("");
  return `<table cellpadding="0" cellspacing="0" border="0"
    style="border-collapse:collapse;width:100%;font-size:14px;border:1px solid #e5e7eb;">
    <thead><tr style="background:#fef3c7;">
      <th style="padding:8px 12px;text-align:left;font-weight:bold;border-bottom:1px solid #fbbf24;">種目</th>
      <th style="padding:8px 12px;text-align:left;font-weight:bold;border-bottom:1px solid #fbbf24;">参加者</th>
      <th style="padding:8px 12px;text-align:right;font-weight:bold;border-bottom:1px solid #fbbf24;">参加料</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── 本人控えメール ─────────────────────────────────────
async function sendConfirmationEmail(opts) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: "SMTP未設定" };
  const transporter = getTransporter();
  const { tournament, formData, result } = opts;
  const toEmail = String(formData.contact_email || "").trim();
  if (!toEmail) return { ok: false, skipped: true, reason: "宛先メールなし" };
  // 形式が不正なら送信を試みず明確にスキップ (sendMail の分かりにくい reject を避ける)。
  // 申込自体は成立済みなので控えメールのみ見送る。
  if (!validRecipient(toEmail)) {
    return { ok: false, skipped: true, reason: "宛先メール形式が不正" };
  }

  const tournName = tournament.name || "";
  const tournDate = tournament.date || "";
  const venue = tournament.venue || "";
  const deadline = tournament.entry_deadline || "";
  const contactName = formData.contact_name || "";
  const contactTel = formData.contact_tel || "";
  const teamName = formData.team_name || "";
  const supervisor = formData.supervisor || "";
  const advisor = formData.advisor || "";
  const coach = formData.coach || "";
  // 申込単位スコープの自由項目(scope=submission)の回答。生の生年月日は含まない。
  const subAnswers = (formData.extra && typeof formData.extra === "object") ? formData.extra : null;
  const subLines = answerLines(subAnswers, opts.fields?.submission);
  // #26: 参加料・合計はサーバ側で算出 (クライアント値は信用しない)。
  // Phase4: 実際に作成された申込(created_entries, 権威料金)があればそれを使う。
  // spam/重複で落ちた行を含む生の formData.entries で再計算すると、控えメールの明細・合計が
  // 台帳(entry_submissions.total)とズレるため(Phase4 review #3/#4)。
  let feeEntries, total;
  if (result && Array.isArray(result.created_entries)) {
    feeEntries = result.created_entries;
    total = (result.total_amount != null)
      ? result.total_amount
      : feeEntries.reduce((s, e) => s + (parseInt(e.fee, 10) || 0), 0);
  } else {
    const feeCalc = authoritativeFees(tournament, formData.entries);
    feeEntries = feeCalc.entries;
    total = feeCalc.total;
  }
  // 有料オプションの明細。受付時にサーバが権威計算した結果(result.options)だけを使い、
  // ここで金額を計算し直さない(計算箇所を増やすと台帳とメールがズレる)。
  const optionItems = (result && Array.isArray(result.options)) ? result.options : [];
  const note = formData.note || "";
  // Phase4: 申込番号(トークン) + 本人確認ページのURL。本人が後から申込内容を閲覧できる。
  const token = (result && result.applicant_token) || "";
  // 能力トークンをURLに含めない。確認ページで申込番号を入力し、HttpOnlyセッションへ交換する。
  const statusUrl = (token && opts.appOrigin) ? `${opts.appOrigin}/entry/status?tournament=${encodeURIComponent(tournament.id)}` : "";

  const subject = `【${tournName}】申込を受け付けました`;

  const text = [
    `${contactName} 様`,
    ``,
    `この度は ${tournName} へお申込みいただきありがとうございます。`,
    `下記の内容で承りました。`,
    ``,
    token ? `─────────────────────` : "",
    token ? `■ 申込番号: ${token}（申込ID）` : "",
    token ? `  申込内容の確認・修正・種目の追加には、この申込番号が必要です。` : "",
    token ? `  修正した内容は、この申込番号の申込に上書きされます(新しい申込にはなりません)。` : "",
    token ? `  同じ選手を同じ種目に改めて申し込むと、重複のため受け付けられません。` : "",
    token ? `  大切に保管してください。` : "",
    statusUrl ? `  確認ページ: ${statusUrl}` : "",
    ``,
    `─────────────────────`,
    `■ 大会`,
    `  ${tournName}`,
    tournDate ? `  日時: ${tournDate}` : "",
    venue ? `  会場: ${venue}` : "",
    ``,
    `■ お申込者`,
    `  所属: ${teamName}`,
    `  担当者: ${contactName}`,
    contactTel ? `  電話: ${contactTel}` : "",
    `  メール: ${toEmail}`,
    supervisor ? `  引率顧問: ${supervisor}` : "",
    advisor ? `  顧問: ${advisor}` : "",
    coach ? `  コーチ: ${coach}` : "",
    ...subLines,
    ``,
    `■ 申込内容 (${feeEntries.length}件)`,
    ...feeEntries.map(e => entryText(e, opts.fields?.player)),
    // 有料オプション(弁当・懇親会など)。金額はサーバが受付時に確定した明細をそのまま出す。
    ...(optionItems.length ? [``, `■ オプション`] : []),
    ...optionItems.map(o => `  ・${o.label} : ${o.qty}${o.unit || ""} - ${formatYen(o.amount)}`),
    ``,
    `  合計: ${formatYen(total)}`,
    note ? `\n■ 通信欄\n  ${note}` : "",
    ``,
    `─────────────────────`,
    `■ 参加料お支払い`,
    `  大会当日、開会式前に受付でお支払いください。`,
    ``,
    signatureText,
  ].filter(s => s !== undefined && s !== null).join("\n");

  const html = `
<div style="font-family:'Hiragino Sans','Yu Gothic UI',system-ui,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1c1917;">
  <div style="border-top:4px solid #b91c1c;padding-top:16px;">
    <div style="font-size:12px;color:#a16207;letter-spacing:2px;font-weight:bold;">KUSHIRO TABLE TENNIS ASSOCIATION</div>
    <h1 style="font-size:20px;margin:4px 0 16px;color:#7c2d12;">申込を受け付けました</h1>
  </div>
  <p style="line-height:1.7;">
    <strong>${esc(contactName)}</strong> 様<br><br>
    この度は <strong>${esc(tournName)}</strong> へお申込みいただきありがとうございます。<br>
    下記の内容で承りました。
  </p>

  ${token ? `<div style="margin:18px 0;padding:16px;border:2px dashed #b91c1c;border-radius:10px;text-align:center;background:#fffdf8;">
    <div style="font-size:11px;letter-spacing:2px;color:#b91c1c;font-weight:bold;">申込番号(申込ID)</div>
    <div style="font-size:24px;font-weight:bold;letter-spacing:2px;font-family:monospace;margin:4px 0;">${esc(token)}</div>
    <div style="font-size:12px;color:#57534e;line-height:1.7;">申込内容の確認・修正・種目の追加には、この申込番号が必要です。<br>修正した内容はこの申込に上書きされます(新しい申込にはなりません)。大切に保管してください。</div>
    ${statusUrl ? `<div style="margin-top:10px;"><a href="${esc(statusUrl)}" style="display:inline-block;padding:9px 18px;background:#b91c1c;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;font-size:13px;">申込内容を確認する →</a></div>` : ""}
  </div>` : ""}

  <h2 style="font-size:14px;border-left:4px solid #b91c1c;padding-left:8px;margin:24px 0 12px;">大会情報</h2>
  <table style="font-size:14px;line-height:1.8;">
    <tr><td style="color:#78716c;padding-right:12px;">大会:</td><td><strong>${esc(tournName)}</strong></td></tr>
    ${tournDate ? `<tr><td style="color:#78716c;padding-right:12px;">日時:</td><td>${esc(tournDate)}</td></tr>` : ""}
    ${venue ? `<tr><td style="color:#78716c;padding-right:12px;">会場:</td><td>${esc(venue)}</td></tr>` : ""}
  </table>

  <h2 style="font-size:14px;border-left:4px solid #b91c1c;padding-left:8px;margin:24px 0 12px;">お申込者情報</h2>
  <table style="font-size:14px;line-height:1.8;">
    <tr><td style="color:#78716c;padding-right:12px;">所属:</td><td>${esc(teamName)}</td></tr>
    <tr><td style="color:#78716c;padding-right:12px;">担当:</td><td>${esc(contactName)}</td></tr>
    ${contactTel ? `<tr><td style="color:#78716c;padding-right:12px;">電話:</td><td>${esc(contactTel)}</td></tr>` : ""}
    <tr><td style="color:#78716c;padding-right:12px;">メール:</td><td>${esc(toEmail)}</td></tr>
    ${supervisor ? `<tr><td style="color:#78716c;padding-right:12px;">引率顧問:</td><td>${esc(supervisor)}</td></tr>` : ""}
    ${advisor ? `<tr><td style="color:#78716c;padding-right:12px;">顧問:</td><td>${esc(advisor)}</td></tr>` : ""}
    ${coach ? `<tr><td style="color:#78716c;padding-right:12px;">コーチ:</td><td>${esc(coach)}</td></tr>` : ""}
    ${subLines.map(line => `<tr><td colspan="2">${esc(line)}</td></tr>`).join("")}
  </table>

  <h2 style="font-size:14px;border-left:4px solid #b91c1c;padding-left:8px;margin:24px 0 12px;">申込内容</h2>
  ${entriesTable(feeEntries, opts.fields?.player)}
  ${optionItems.length ? `
  <h2 style="font-size:14px;border-left:4px solid #b91c1c;padding-left:8px;margin:24px 0 12px;">オプション</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    ${optionItems.map(o => `<tr>
      <td style="padding:7px 8px;border-bottom:1px solid #e7e5e4;">${esc(o.label)}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e7e5e4;text-align:right;white-space:nowrap;">${o.qty}${esc(o.unit || "")}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #e7e5e4;text-align:right;white-space:nowrap;">${formatYen(o.amount)}</td>
    </tr>`).join("")}
  </table>` : ""}
  <div style="text-align:right;margin-top:8px;font-size:16px;font-weight:bold;color:#7c2d12;">
    合計: ${formatYen(total)}
  </div>

  ${note ? `<h2 style="font-size:14px;border-left:4px solid #b91c1c;padding-left:8px;margin:24px 0 12px;">通信欄</h2>
  <p style="background:#fefce8;padding:10px;border-radius:4px;white-space:pre-wrap;font-size:13px;">${esc(note)}</p>` : ""}

  <h2 style="font-size:14px;border-left:4px solid #b91c1c;padding-left:8px;margin:24px 0 12px;">参加料お支払いについて</h2>
  <p style="font-size:14px;line-height:1.7;background:#fff7ed;padding:12px;border-radius:4px;">
    大会当日、開会式前に受付でお支払いください。<br>
    ※当日のキャンセル・欠席による参加料の返金はできかねますのでご了承ください。
  </p>

  ${signatureHtml}
</div>`.trim();

  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: { address: toEmail, name: "" },
      subject,
      text,
      html,
    });
    if (!info.accepted?.length) return { ok: false };
    return { ok: true, message_id: info.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── 管理者通知メール ─────────────────────────────────
async function sendAdminNotification(opts) {
  if (!isEnabled()) return { ok: false, skipped: true, reason: "SMTP未設定" };
  if (!ADMIN_EMAIL) return { ok: false, skipped: true, reason: "ADMIN_EMAIL未設定" };
  const transporter = getTransporter();
  const { tournament, formData, result, adminUrl } = opts;
  // #26/Phase4: 合計は実際に作成された申込(result.total_amount)を正とする。無ければ event_config 再計算。
  const total = (result && result.total_amount != null)
    ? result.total_amount
    : authoritativeFees(tournament, formData.entries).total;
  const subject = `【新規申込】${tournament.name} - ${formData.team_name || formData.contact_name || ""}`;
  const entries = result.created_entries || [];
  const text = [
    `新規申込が届きました。`,
    ``,
    `大会: ${tournament.name}`,
    `所属: ${formData.team_name || ""}`,
    `担当: ${formData.contact_name || ""}`,
    `連絡先: ${formData.contact_email || ""} / ${formData.contact_tel || ""}`,
    formData.supervisor ? `引率顧問: ${formData.supervisor}` : "",
    formData.advisor ? `顧問: ${formData.advisor}` : "",
    formData.coach ? `コーチ: ${formData.coach}` : "",
    `申込件数: ${result.entry_count}件`,
    result.submission_id ? `受付台帳ID: ${result.submission_id}` : "",
    ...answerLines(formData.extra, opts.fields?.submission),
    ...entries.map(e => entryText(e, opts.fields?.player)),
    ...(result.options || []).map(o => `・${o.label}: ${o.qty}${o.unit || ""}`),
    formData.note ? `通信欄: ${formData.note}` : "",
    `合計: ${formatYen(total)}`,
    ``,
    adminUrl ? `管理画面: ${adminUrl}` : "",
  ].filter(Boolean).join("\n") + "\n\n" + signatureText;
  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: ADMIN_EMAIL,
      subject,
      text,
    });
    if (!info.accepted?.length || info.rejected?.length) return { ok: false };
    return { ok: true, message_id: info.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── 設定検証 (テスト送信用) ─────────────────────────
async function sendTestEmail(to) {
  if (!isEnabled()) throw new Error("SMTP_USER と SMTP_PASS が設定されていません");
  const transporter = getTransporter();
  return await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: "【KTTA Platform】メール送信テスト",
    text: "このメールは KTTA Platform からのテスト送信です。受信できていれば正常に動作しています。",
  });
}

// 申込後の変更(選手の差し替え・出場の取消)を主催者へ知らせる。
// 申込者は操作直後に画面で結果を確認できるので、本人への控えは送らない。
async function sendEntryChangeNotification(opts) {
  opts = opts || {};
  if (!isEnabled()) return { skipped: "smtp_not_configured" };
  const to = ADMIN_EMAIL || SMTP_USER;
  if (!to) return { skipped: "no_admin_email" };
  const t = opts.tournament || {};
  const b = opts.before || {};
  const a = opts.after || null;
  const isCancel = opts.kind === "cancel";
  const isEdit = opts.kind === "edit";
  const title = isCancel ? "出場の取消" : isEdit ? "申込内容の修正" : "出場選手の変更";
  // 修正は複数項目をまとめて直せるので、変更点を1行ずつ並べる(連絡先は項目名だけで値は載せない)
  const detail = isEdit
    ? (Array.isArray(opts.lines) ? opts.lines : []).slice(0, 30).join(" / ")
    : isCancel
    ? `${b.event || ""}: ${b.name || ""}${b.team ? "（" + b.team + "）" : ""} が取り消されました`
    : `${b.event || ""}: ${b.target || b.name || ""} → ${(a && (a.target || a.name)) || ""}`;
  const subject = `【${t.name || "大会"}】${title}がありました`;
  const text = [
    `${opts.actor === "admin" ? "本部" : "申込者"}による${title}がありました。`,
    ``,
    `■ 大会: ${t.name || ""}${t.date ? "（" + t.date + "）" : ""}`,
    `■ 内容: ${detail}`,
    opts.reason ? `■ 理由: ${opts.reason}` : "",
    ``,
    `この変更は申込締切前・組合せ作成前にのみ受け付けています。`,
    opts.adminUrl ? `管理画面: ${opts.adminUrl}` : "",
    ``,
    signatureText,
  ].filter(s => s !== undefined && s !== null).join("\n");
  const html = `
<div style="font-family:'Hiragino Sans','Yu Gothic UI',system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1c1917;">
  <div style="border-top:4px solid ${isCancel ? "#b45309" : "#b91c1c"};padding-top:14px;">
    <h1 style="font-size:18px;margin:4px 0 14px;">${esc(title)}がありました</h1>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:8px;background:#faf9f7;width:90px;">大会</td><td style="padding:8px;">${esc(t.name || "")}${t.date ? "（" + esc(t.date) + "）" : ""}</td></tr>
    <tr><td style="padding:8px;background:#faf9f7;">内容</td><td style="padding:8px;font-weight:bold;">${esc(detail)}</td></tr>
    ${opts.reason ? `<tr><td style="padding:8px;background:#faf9f7;">理由</td><td style="padding:8px;">${esc(opts.reason)}</td></tr>` : ""}
  </table>
  <p style="font-size:12.5px;color:#57534e;margin-top:14px;">この変更は申込締切前・組合せ作成前にのみ受け付けています。</p>
  ${opts.adminUrl ? `<p style="margin-top:12px;"><a href="${esc(opts.adminUrl)}" style="display:inline-block;padding:9px 16px;background:#211d18;color:#fff;border-radius:4px;text-decoration:none;font-size:13px;">管理画面で確認する</a></p>` : ""}
  ${signatureHtml}
</div>`;
  return getTransporter().sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, html });
}

async function sendOperatorInvite(to, link) {
  const info = await getTransporter().sendMail({
    from: SMTP_FROM || SMTP_USER, to,
    subject: "KTTA Platform | 運営アカウントの設定",
    text: "次のリンクから、氏名と運営アカウントのパスワードを設定してください。リンクは発行後24時間、1回だけ有効です。\n\n"
      + link + "\n\n心当たりがない場合は、このメールを破棄してください。",
  });
  if (!info.accepted?.length) throw new Error("招待メールを受け付けませんでした");
}

// 役員の自己登録があったとき、管理者宛てに知らせる(承認はオーナーが管理画面で行う)。パスワードは載せない。
async function sendOperatorRegistrationNotice({ name, email }) {
  if (!ADMIN_EMAIL) return { skipped: true };
  const info = await getTransporter().sendMail({
    from: SMTP_FROM || SMTP_USER, to: ADMIN_EMAIL,
    subject: "KTTA Platform | 役員の登録申請があります",
    text: "運営アカウントの登録申請がありました。\n\n氏名: " + name + "\nメールアドレス: " + email
      + "\n\n管理画面の「管理設定」→「システム管理（オーナー）」→「運営アカウントを管理」で、承認または却下してください。"
      + "\n心当たりのない申請は、却下してください。",
  });
  return { ok: !!info.accepted?.length };
}

async function sendOperatorReset(to, link) {
  const info = await getTransporter().sendMail({
    from: SMTP_FROM || SMTP_USER, to,
    subject: "KTTA Platform | パスワードの再設定",
    text: "運営アカウントのパスワード再設定を受け付けました。次のリンクから新しいパスワードを設定してください。リンクは発行後1時間、1回だけ有効です。\n\n"
      + link + "\n\n設定し直すまでは今のパスワードのまま使えます。心当たりがない場合は、このメールを破棄してください。",
  });
  if (!info.accepted?.length) throw new Error("再設定メールを受け付けませんでした");
}

module.exports = {
  isEnabled,
  validRecipient,
  sendOperatorInvite,
  sendOperatorReset,
  sendOperatorRegistrationNotice,
  sendConfirmationEmail,
  sendAdminNotification,
  sendEntryChangeNotification,
  sendTestEmail,
  authoritativeFees,   // テスト用に公開 (#26)
  eventFeeMap,
  config: { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM, ADMIN_EMAIL },
};
