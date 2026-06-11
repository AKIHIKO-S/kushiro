/**
 * 外部大会 申込フォーム ハンドラ (Google Apps Script)
 * 対象フォーム:
 *   masters_2026           … 2026北海道選手権（マスターズの部）
 *   largeball_national_2026… 第39回全国ラージボール 北海道予選
 *   largeball_alljapan_2026… 第9回全日本ラージボール選手権 北海道予選
 *
 * セットアップ:
 *   ① Google スプレッドシートを新規作成
 *   ② 拡張機能 → Apps Script → このスクリプトを貼り付け
 *   ③ デプロイ → 新しいデプロイ → ウェブアプリ (アクセス:全員 / 実行:自分)
 *   ④ デプロイ URL を ktta-platform の環境変数に設定:
 *        GAS_EXTERNAL_URL=https://script.google.com/macros/s/XXXXX/exec
 */

// ════════════════════════════════════════════
// 設定
// ════════════════════════════════════════════

const NOTIFY_EMAILS = [
  "kouki160814@gmail.com",
  "sensation01210121@gmail.com",
  "yudusae7322@gmail.com",
  "sakusaku.pate@gmail.com",
];

const FORM_CONFIG = {
  masters_2026: {
    name: "2026北海道選手権（マスターズの部）参加申込",
    sheet: "マスターズ2026",
    singles_fee: 2000,
    doubles_fee: 2400,
  },
  largeball_national_2026: {
    name: "第39回全国ラージボール卓球大会 北海道予選",
    sheet: "全国ラージボール2026",
    singles_fee: 2000,
    doubles_fee: 2400,
  },
  largeball_alljapan_2026: {
    name: "第9回全日本ラージボール卓球選手権大会 北海道予選",
    sheet: "全日本ラージボール選手権2026",
    singles_fee: 2000,
    doubles_fee: 2400,
  },
};

const SHEET_HEADERS = [
  "受付日時", "大会名", "責任者", "連絡先",
  "シングルス人数", "ダブルス組数", "合計金額",
  "90歳代有", "備考", "内容詳細(JSON)",
];

// ════════════════════════════════════════════
// POST 受信
// ════════════════════════════════════════════

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    let data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (_) {
      return _json({ ok: false, error: "JSON解析失敗" });
    }

    const cfg = FORM_CONFIG[data.form_type];
    if (!cfg) {
      return _json({ ok: false, error: "不明なフォーム種別: " + (data.form_type || "") });
    }
    if (!String(data.contact_name || "").trim()) {
      return _json({ ok: false, error: "責任者名が未入力です" });
    }
    const singles = Array.isArray(data.singles) ? data.singles.filter(r => r.name) : [];
    const doubles = Array.isArray(data.doubles) ? data.doubles.filter(r => r.name1 || r.name2) : [];
    if (singles.length === 0 && doubles.length === 0) {
      return _json({ ok: false, error: "申込内容が空です" });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rowNum = _writeToSheet(ss, cfg, data, singles, doubles);
    _sendNotifications(cfg, data, singles, doubles, rowNum);

    return _json({ ok: true, row: rowNum });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ════════════════════════════════════════════
// スプレッドシートへ記録
// ════════════════════════════════════════════

function _writeToSheet(ss, cfg, data, singles, doubles) {
  let sh = ss.getSheetByName(cfg.sheet);
  if (!sh) {
    sh = ss.insertSheet(cfg.sheet);
    sh.getRange(1, 1, 1, SHEET_HEADERS.length)
      .setValues([SHEET_HEADERS])
      .setFontWeight("bold")
      .setBackground("#1e2a4a")
      .setFontColor("#fff");
    sh.setFrozenRows(1);
    sh.setColumnWidth(10, 300); // JSON列
  }

  const ts = new Date();
  const hasOver90 = !!data.has_over90;
  const row = [
    ts,
    cfg.name,
    data.contact_name || "",
    data.contact_tel || "",
    singles.length,
    doubles.length,
    data.total_amount || 0,
    hasOver90 ? "有" : "",
    data.note || "",
    JSON.stringify({ singles, doubles }),
  ];
  sh.appendRow(row);
  const rowNum = sh.getLastRow();

  // 金額列を数値フォーマット
  sh.getRange(rowNum, 7).setNumberFormat("¥#,##0");
  // 受付日時フォーマット
  sh.getRange(rowNum, 1).setNumberFormat("yyyy/MM/dd HH:mm");

  return rowNum;
}

// ════════════════════════════════════════════
// 通知メール送信 (4アドレスへ一括)
// ════════════════════════════════════════════

function _sendNotifications(cfg, data, singles, doubles, rowNum) {
  const subject = `【申込】${cfg.name} / ${data.contact_name}`;
  const body = _buildEmailBody(cfg, data, singles, doubles, rowNum);

  NOTIFY_EMAILS.forEach(email => {
    try {
      GmailApp.sendEmail(email, subject, body, { name: "KTTA 外部大会申込システム" });
    } catch (err) {
      console.error("メール送信失敗:", email, String(err));
    }
  });
}

function _buildEmailBody(cfg, data, singles, doubles, rowNum) {
  const ts = new Date().toLocaleString("ja-JP");
  const lines = [];

  lines.push(`${cfg.name} への申込が届きました。`);
  lines.push("");
  lines.push(`受付番号: #${String(rowNum).padStart(4, "0")}`);
  lines.push(`受付日時: ${ts}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`責任者: ${data.contact_name || ""}`);
  lines.push(`連絡先: ${data.contact_tel || ""}`);

  if (data.has_over90) {
    lines.push("");
    lines.push("⚠️ 90歳以上の選手が含まれます。同意書の提出を確認してください。");
  }

  // シングルス
  if (singles.length > 0) {
    lines.push("");
    lines.push(`【シングルス】 ${singles.length}名 × ¥${cfg.singles_fee.toLocaleString("ja-JP")} = ¥${(singles.length * cfg.singles_fee).toLocaleString("ja-JP")}`);
    singles.forEach((s, i) => {
      let label = `  ${i + 1}. `;
      // Masters fields
      if (s.gender_label || s.category_label) {
        label += `[${s.gender_label || ""}${s.category_label ? " " + s.category_label : ""}] `;
      }
      if (s.furigana) label += `${s.furigana} `;
      label += s.name || "";
      if (s.age) label += `（${s.age}歳）`;
      if (s.birthdate) label += ` 生${s.birthdate}`;
      if (s.team) label += ` / ${s.team}`;
      if (s.note) label += ` ※${s.note}`;
      lines.push(label);
    });
  }

  // ダブルス
  if (doubles.length > 0) {
    const dblLabel = cfg.name.includes("マスターズ") ? "ダブルス" : "混合ダブルス";
    lines.push("");
    lines.push(`【${dblLabel}】 ${doubles.length}組 × ¥${cfg.doubles_fee.toLocaleString("ja-JP")} = ¥${(doubles.length * cfg.doubles_fee).toLocaleString("ja-JP")}`);
    doubles.forEach((d, i) => {
      const catLabel = d.category_label ? `[${d.category_label}] ` : "";
      const ageSum = d.combined_age ? ` (合計${d.combined_age}歳)` : "";
      lines.push(`  ${i + 1}. ${catLabel}${d.name1 || ""}（${d.age1 || ""}歳）/ ${d.name2 || ""}（${d.age2 || ""}歳）${ageSum}`);
      if (d.team1 || d.team2) lines.push(`       ${d.team1 || "—"}  /  ${d.team2 || "—"}`);
      // Masters furigana
      if (d.furigana1 || d.furigana2) lines.push(`       ${d.furigana1 || ""}  /  ${d.furigana2 || ""}`);
    });
  }

  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`合計金額: ¥${(data.total_amount || 0).toLocaleString("ja-JP")}`);
  lines.push("（参加料は試合当日払い）");

  if (data.note) {
    lines.push("");
    lines.push(`【備考】\n${data.note}`);
  }

  lines.push("");
  lines.push("スプレッドシート:");
  lines.push(SpreadsheetApp.getActiveSpreadsheet().getUrl());

  return lines.join("\n");
}

// ════════════════════════════════════════════
// レスポンス
// ════════════════════════════════════════════

function doGet(e) {
  return _json({ ok: true, message: "KTTA 外部大会申込フォームハンドラ (GET は受付対象外)" });
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════
// デバッグ用テスト (GAS エディタから手動実行)
// ════════════════════════════════════════════

function _testMasters() {
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({
        form_type: "masters_2026",
        contact_name: "山田 太郎",
        contact_tel: "0154-XX-XXXX",
        has_over90: false,
        note: "テスト送信",
        total_amount: 8400,
        singles: [
          { gender: "male", gender_label: "男子", category: "forty", category_label: "フォーティ",
            furigana: "たなかいちろう", name: "田中 一郎", age: 45, birthdate: "1981-04-01", team: "釧路クラブ", note: "", fee: 2000 },
          { gender: "female", gender_label: "女子", category: "fifty", category_label: "フィフティ以上",
            furigana: "さとうはなこ", name: "佐藤 花子", age: 52, birthdate: "1974-04-01", team: "厚友会", note: "", fee: 2000 },
        ],
        doubles: [
          { category: "under_129", category_label: "129歳以下",
            furigana1: "たなかいちろう", name1: "田中 一郎", age1: 45, birthdate1: "1981-04-01", team1: "釧路クラブ",
            furigana2: "すずきじろう", name2: "鈴木 二郎", age2: 43, birthdate2: "1983-04-01", team2: "釧路クラブ",
            combined_age: 88, fee: 2400 },
        ],
      }),
    },
  };
  const result = doPost(fakeEvent);
  console.log(result.getContent());
}

function _testLargeball() {
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({
        form_type: "largeball_national_2026",
        contact_name: "山田 太郎",
        contact_tel: "0154-XX-XXXX",
        note: "",
        total_amount: 6400,
        singles: [
          { gender: "male", gender_label: "男子", category: "60", category_label: "シングルス60",
            name: "田中 一郎", age: 62, branch: "釧路支部", team: "釧路クラブ", fee: 2000 },
          { gender: "female", gender_label: "女子", category: "50", category_label: "シングルス50",
            name: "佐藤 花子", age: 51, branch: "釧路支部", team: "厚友会", fee: 2000 },
        ],
        doubles: [
          { category: "120", category_label: "混合ダブルス120",
            name1: "田中 一郎", age1: 62, branch1: "釧路支部", team1: "釧路クラブ",
            name2: "佐藤 花子", age2: 51, branch2: "釧路支部", team2: "厚友会",
            combined_age: 113, fee: 2400 },
        ],
      }),
    },
  };
  const result = doPost(fakeEvent);
  console.log(result.getContent());
}
