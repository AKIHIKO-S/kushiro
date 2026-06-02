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
  });
  return _transporter;
}

function isEnabled() {
  return !!(SMTP_USER && SMTP_PASS);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

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
    map[String(c.name).trim()] = { fee: f, fee_student: (fs >= 0 ? fs : null) };
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
  const list = (entries || []).map(e => {
    const cfg = map[String(e.event || "").trim()];
    let fee;
    if (cfg) {
      const isStudent = e.division && e.division !== "general";   // 中学生/高校生(旧 student 含む)
      fee = (isStudent && cfg.fee_student != null) ? cfg.fee_student : cfg.fee;
    } else {
      fee = parseInt(e.fee, 10) || 0;
    }
    total += fee;
    return Object.assign({}, e, { fee });
  });
  return { entries: list, total };
}

// 申込内容を HTML テーブルにする
function entriesTable(entries) {
  if (!entries || !entries.length) return "";
  const rows = entries.map(e => {
    let label = e.event || "(種目不明)";
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
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${esc(label)}</td>
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
  const toEmail = formData.contact_email;
  if (!toEmail) return { ok: false, skipped: true, reason: "宛先メールなし" };
  // 形式が不正なら送信を試みず明確にスキップ (sendMail の分かりにくい reject を避ける)。
  // 申込自体は成立済みなので控えメールのみ見送る。
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(toEmail).trim())) {
    return { ok: false, skipped: true, reason: "宛先メール形式が不正" };
  }

  const tournName = tournament.name || "";
  const tournDate = tournament.date || "";
  const venue = tournament.venue || "";
  const deadline = tournament.entry_deadline || "";
  const contactName = formData.contact_name || "";
  const contactTel = formData.contact_tel || "";
  const teamName = formData.team_name || "";
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
  const note = formData.note || "";
  // Phase4: 申込番号(トークン) + 本人確認ページのURL。本人が後から申込内容を閲覧できる。
  const token = (result && result.applicant_token) || "";
  const statusUrl = (token && opts.appOrigin)
    ? `${opts.appOrigin}/entry/status?token=${encodeURIComponent(token)}` : "";

  const subject = `【${tournName}】申込を受け付けました`;

  const text = [
    `${contactName} 様`,
    ``,
    `この度は ${tournName} へお申込みいただきありがとうございます。`,
    `下記の内容で承りました。`,
    ``,
    token ? `─────────────────────` : "",
    token ? `■ 申込番号: ${token}` : "",
    token ? `  この番号で申込内容を確認できます。大切に保管してください。` : "",
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
    ``,
    `■ 申込内容 (${feeEntries.length}件)`,
    ...(feeEntries.map(e => {
      if (e.type === "team") {
        return `  ・${e.event} : ${e.team_name || ""} [${(e.members || []).join("、")}] - ${formatYen(e.fee)}`;
      }
      if (e.type === "doubles") {
        return `  ・${e.event} : ${e.name1 || ""} / ${e.name2 || ""} (${e.team || ""}) - ${formatYen(e.fee)}`;
      }
      return `  ・${e.event} : ${e.name || ""} (${e.team || ""}) - ${formatYen(e.fee)}`;
    })),
    ``,
    `  合計: ${formatYen(total)}`,
    note ? `\n■ 通信欄\n  ${note}` : "",
    ``,
    `─────────────────────`,
    `■ 参加料お支払い`,
    `  大会当日、開会式前に受付でお支払いください。`,
    ``,
    `■ お問合せ`,
    `  ${ADMIN_EMAIL || SMTP_USER}`,
    ``,
    `釧路卓球協会`,
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
    <div style="font-size:11px;letter-spacing:2px;color:#b91c1c;font-weight:bold;">申込番号</div>
    <div style="font-size:24px;font-weight:bold;letter-spacing:2px;font-family:monospace;margin:4px 0;">${esc(token)}</div>
    <div style="font-size:12px;color:#78716c;">この番号で申込内容を確認できます。大切に保管してください。</div>
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
  </table>

  <h2 style="font-size:14px;border-left:4px solid #b91c1c;padding-left:8px;margin:24px 0 12px;">申込内容</h2>
  ${entriesTable(feeEntries)}
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

  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#78716c;">
    お問合せ: <a href="mailto:${esc(ADMIN_EMAIL || SMTP_USER)}" style="color:#b91c1c;">${esc(ADMIN_EMAIL || SMTP_USER)}</a><br>
    釧路卓球協会
  </div>
</div>`.trim();

  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: toEmail,
      subject,
      text,
      html,
    });
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
  const text = [
    `新規申込が届きました。`,
    ``,
    `大会: ${tournament.name}`,
    `所属: ${formData.team_name || ""}`,
    `担当: ${formData.contact_name || ""}`,
    `連絡先: ${formData.contact_email || ""} / ${formData.contact_tel || ""}`,
    `申込件数: ${result.entry_count}件`,
    `合計: ${formatYen(total)}`,
    ``,
    adminUrl ? `管理画面: ${adminUrl}` : "",
  ].filter(Boolean).join("\n");
  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to: ADMIN_EMAIL,
      subject,
      text,
    });
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

module.exports = {
  isEnabled,
  sendConfirmationEmail,
  sendAdminNotification,
  sendTestEmail,
  authoritativeFees,   // テスト用に公開 (#26)
  eventFeeMap,
  config: { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM, ADMIN_EMAIL },
};
