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
function entriesTable(entries) {
  if (!entries || !entries.length) return "";
  const rows = entries.map(e => {
    let label = e.event || "(種目不明)";
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
  const supervisor = formData.supervisor || "";
  const advisor = formData.advisor || "";
  const coach = formData.coach || "";
  // 申込単位スコープの自由項目(scope=submission)の回答。生の生年月日は含まない。
  const subAnswers = (formData.extra && typeof formData.extra === "object") ? formData.extra : null;
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
    ${supervisor ? `<tr><td style="color:#78716c;padding-right:12px;">引率顧問:</td><td>${esc(supervisor)}</td></tr>` : ""}
    ${advisor ? `<tr><td style="color:#78716c;padding-right:12px;">顧問:</td><td>${esc(advisor)}</td></tr>` : ""}
    ${coach ? `<tr><td style="color:#78716c;padding-right:12px;">コーチ:</td><td>${esc(coach)}</td></tr>` : ""}
    ${subAnswers ? Object.keys(subAnswers).map(k => `<tr><td style="color:#78716c;padding-right:12px;">${esc(k)}:</td><td>${esc(subAnswers[k] === true ? "はい" : String(subAnswers[k]))}</td></tr>`).join("") : ""}
  </table>

  <h2 style="font-size:14px;border-left:4px solid #b91c1c;padding-left:8px;margin:24px 0 12px;">申込内容</h2>
  ${entriesTable(feeEntries)}
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
  const title = isCancel ? "出場の取消" : "出場選手の変更";
  const detail = isCancel
    ? `${b.event || ""}: ${b.name || ""}${b.team ? "（" + b.team + "）" : ""} が取り消されました`
    : `${b.event || ""}: ${b.target || b.name || ""} → ${(a && (a.target || a.name)) || ""}`;
  const subject = `【${t.name || "大会"}】${title}がありました`;
  const text = [
    `申込者による${title}がありました。`,
    ``,
    `■ 大会: ${t.name || ""}${t.date ? "（" + t.date + "）" : ""}`,
    `■ 内容: ${detail}`,
    opts.reason ? `■ 理由: ${opts.reason}` : "",
    ``,
    `この変更は申込締切前・組合せ作成前にのみ受け付けています。`,
    opts.adminUrl ? `管理画面: ${opts.adminUrl}` : "",
    ``,
    `釧路卓球協会 申込システム`,
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
</div>`;
  return getTransporter().sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, html });
}

// 集計スプレッドシートへの中継が失敗したときの通報。
// 申込自体は本部のDBに残っているので「申込が消えた」わけではないが、シートを見て仕事をする人には
// 存在しない申込になる。過去にこれが事故になったため、黙って落とさず必ず知らせる。
// GAS 側は自分が動けたときしか通知できないので、GAS に届かなかった場合の通報はこちらの役目。
async function sendGasRelayFailure(opts) {
  opts = opts || {};
  if (!isEnabled()) return { skipped: "smtp_not_configured" };
  const to = ADMIN_EMAIL || SMTP_USER;
  if (!to) return { skipped: "no_admin_email" };
  const t = opts.tournament || {};
  const f = opts.formData || {};
  const rel = opts.relay || {};
  const reason = [rel.error, Array.isArray(rel.problems) ? rel.problems.join(" / ") : ""]
    .filter(Boolean).join(" / ") || "原因不明";
  const subject = `【要確認】${t.name || "大会"} 申込がスプレッドシートに記録できていません`;
  const text = [
    `申込を受け付けましたが、集計スプレッドシートへの記録ができませんでした。`,
    `申込そのものは本部のシステムに保存されています（申込者を待たせる必要はありません）。`,
    ``,
    `■ 大会:   ${t.name || ""}${t.date ? "（" + t.date + "）" : ""}`,
    `■ 団体:   ${f.team_name || ""}`,
    `■ 責任者: ${f.contact_name || ""}`,
    `■ 連絡先: ${f.contact_tel || ""} / ${f.contact_email || ""}`,
    `■ 原因:   ${reason}`,
    rel.retried ? `■ 再送:   1回試みましたが同じ結果でした` : "",
    ``,
    `【対処】`,
    `  1. 管理画面の申込一覧を開き、「未反映」の申込を確認してください`,
    `  2. 「シートへ再送」を押すと、受付時と同じ内容をもう一度送ります`,
    `  3. 直らない場合は、GASのデプロイ設定（アクセス権が「全員」か）を確認してください`,
    opts.adminUrl ? `\n管理画面: ${opts.adminUrl}` : "",
    ``,
    `釧路卓球協会 申込システム`,
  ].filter(s => s !== undefined && s !== null).join("\n");
  const html = `
<div style="font-family:'Hiragino Sans','Yu Gothic UI',system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#1c1917;">
  <div style="border-top:4px solid #b45309;padding-top:14px;">
    <h1 style="font-size:18px;margin:4px 0 10px;">申込がスプレッドシートに記録できていません</h1>
  </div>
  <p style="font-size:14px;margin:0 0 14px;">申込そのものは本部のシステムに保存されています。シートへの反映だけが失敗しました。</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:8px;background:#faf9f7;width:90px;">大会</td><td style="padding:8px;">${esc(t.name || "")}${t.date ? "（" + esc(t.date) + "）" : ""}</td></tr>
    <tr><td style="padding:8px;background:#faf9f7;">団体</td><td style="padding:8px;font-weight:bold;">${esc(f.team_name || "")}</td></tr>
    <tr><td style="padding:8px;background:#faf9f7;">責任者</td><td style="padding:8px;">${esc(f.contact_name || "")}</td></tr>
    <tr><td style="padding:8px;background:#faf9f7;">原因</td><td style="padding:8px;">${esc(reason)}</td></tr>
  </table>
  <p style="font-size:13px;color:#57534e;margin-top:14px;">管理画面の申込一覧で「未反映」を探し、「シートへ再送」を押してください。</p>
  ${opts.adminUrl ? `<p style="margin-top:12px;"><a href="${esc(opts.adminUrl)}" style="display:inline-block;padding:9px 16px;background:#211d18;color:#fff;border-radius:4px;text-decoration:none;font-size:13px;">管理画面を開く</a></p>` : ""}
</div>`;
  return getTransporter().sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text, html });
}

module.exports = {
  isEnabled,
  sendConfirmationEmail,
  sendAdminNotification,
  sendEntryChangeNotification,
  sendGasRelayFailure,
  sendTestEmail,
  authoritativeFees,   // テスト用に公開 (#26)
  eventFeeMap,
  config: { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM, ADMIN_EMAIL },
};
