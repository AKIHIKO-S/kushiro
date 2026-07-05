// ═══════════════════════════════════════════════════════════════
// 卓球大会申込管理システム - Google Apps Script
// ═══════════════════════════════════════════════════════════════
//
// 【セットアップ手順】
// 1. Google スプレッドシートを新規作成
// 2. 拡張機能 > Apps Script を開く
// 3. このコード全体をコピーして Code.gs に貼り付け
// 4. 保存（Ctrl+S）後、関数選択で「onOpen」を選んで ▶実行
// 5. スプレッドシートに戻り 大会管理 > 初期設定 を実行
// 6. デプロイ > 新しいデプロイ > ウェブアプリ
//    - 説明: 卓球大会申込API
//    - 実行するユーザー: 自分
//    - アクセスできるユーザー: 全員
// 7. 表示されたウェブアプリURLをコピー → HTMLの設定画面に貼り付け
//
// 【更新時】
// コード修正後は「デプロイを管理」→「新しいバージョン」で再デプロイ
// ═══════════════════════════════════════════════════════════════

// ── 定数 ──────────────────────────────────────────────
const SN = {
  CONFIG:  '大会設定',
  EVENTS:  '種目マスター',
  REGS:    '申込データ',
  RECEIPTS:'領収書台帳'
};

// ── メニュー ──────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('大会管理')
    .addItem('初期設定（シート作成）', 'setupSheets')
    .addItem('種目別シート再生成', 'syncAllEventSheets')
    .addSeparator()
    .addItem('申込データ整理', 'sortRegistrations')
    .addToUi();
}

// ── 初期セットアップ ─────────────────────────────────
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 大会設定
  let cs = ss.getSheetByName(SN.CONFIG);
  if (!cs) {
    cs = ss.insertSheet(SN.CONFIG);
    cs.getRange('A1:B1').setValues([['項目','値']]).setFontWeight('bold').setBackground('#0f4c81').setFontColor('#fff');
    cs.getRange('A2:B10').setValues([
      ['大会名',''],['開催日',''],['会場',''],['コート数','4'],
      ['主催者',''],['申込締切',''],['備考',''],['フォーム公開','TRUE'],
      ['領収書但し書きテンプレート','○○大会 参加費として']
    ]);
    cs.setColumnWidths(1, 2, 250);
    cs.getRange('A2:A10').setFontWeight('bold');
  }

  // 種目マスター
  let es = ss.getSheetByName(SN.EVENTS);
  if (!es) {
    es = ss.insertSheet(SN.EVENTS);
    const h = ['種目ID','種別','種目名','性別制限','年代カテゴリ','参加費','定員','並び順'];
    es.getRange(1,1,1,h.length).setValues([h]).setFontWeight('bold').setBackground('#7c3aed').setFontColor('#fff');
    es.setFrozenRows(1);
  }

  // 申込データ
  let rs = ss.getSheetByName(SN.REGS);
  if (!rs) {
    rs = ss.insertSheet(SN.REGS);
    const h = [
      '申込ID','種目ID','種目名','団体名','代表者','電話番号','メール',
      '選手1','ふりがな1','性別1','年代1',
      '選手2','ふりがな2','性別2','年代2',
      '選手3','ふりがな3','性別3','年代3',
      '選手4','ふりがな4','性別4','年代4',
      '選手5','ふりがな5','性別5','年代5',
      '選手6(補欠)','ふりがな6','性別6','年代6',
      '参加費','入金状態','領収書番号','但し書き','備考','申込日時'
    ];
    rs.getRange(1,1,1,h.length).setValues([h]).setFontWeight('bold').setBackground('#0f4c81').setFontColor('#fff');
    rs.setFrozenRows(1);
    rs.setColumnWidth(1, 120);
  }

  // 領収書台帳
  let rcs = ss.getSheetByName(SN.RECEIPTS);
  if (!rcs) {
    rcs = ss.insertSheet(SN.RECEIPTS);
    const h = ['領収書番号','発行日','宛名','金額','但し書き','大会名','種目','申込ID'];
    rcs.getRange(1,1,1,h.length).setValues([h]).setFontWeight('bold').setBackground('#ca8a04').setFontColor('#fff');
    rcs.setFrozenRows(1);
  }

  SpreadsheetApp.getUi().alert('✅ 初期設定が完了しました！\n各シートにデータを入力してください。');
}

// ═══════════════════════════════════════════════════════
// Web API
// ═══════════════════════════════════════════════════════

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  let result = {};
  try {
    switch(action) {
      case 'getConfig':      result = getConfig(); break;
      case 'getEvents':      result = getEvents(); break;
      case 'getRegistrations': result = getRegistrations(e.parameter.eventId || ''); break;
      case 'getPublicData':  result = getPublicData(); break;
      case 'getStats':       result = getStats(); break;
      case 'getFormEmbed':   result = getFormEmbed_(e); break;
      case 'ping':           result = { ok: true, time: new Date().toISOString() }; break;
      default: result = { error: 'Unknown action: ' + action };
    }
  } catch(err) { result = { error: err.message }; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let data = {};
  try { data = JSON.parse(e.postData.contents); } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({error:'Invalid JSON'})).setMimeType(ContentService.MimeType.JSON);
  }
  const action = data.action || '';
  let result = {};
  try {
    switch(action) {
      case 'saveConfig':           result = saveConfig(data); break;
      case 'saveEvents':           result = saveEvents(data.events || []); break;
      case 'addRegistration':      result = addRegistration(data); break;
      case 'addBulkRegistration':  result = addBulkRegistration(data); break;
      case 'updateRegistration':   result = updateRegistration(data); break;
      case 'deleteRegistration':   result = deleteRegistration(data.id); break;
      case 'togglePayment':        result = togglePayment(data.id); break;
      case 'issueReceipt':         result = issueReceipt(data.id, data.description || ''); break;
      case 'sendConfirmationEmail': result = sendConfirmationEmail_(data.email, data.subject, data.body); break;
      default: result = { error: 'Unknown action: ' + action };
    }
  } catch(err) { result = { error: err.message }; }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════
// 大会設定
// ═══════════════════════════════════════════════════════

function getConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.CONFIG);
  if (!sheet) return { error: 'シートなし' };
  const data = sheet.getRange('A2:B10').getValues();
  const cfg = {};
  const keys = ['name','date','venue','court_count','organizer','deadline','notes','form_open','receipt_template'];
  data.forEach((row, i) => { if (keys[i]) cfg[keys[i]] = row[1]; });
  cfg.form_open = String(cfg.form_open).toUpperCase() === 'TRUE';
  cfg.court_count = parseInt(cfg.court_count) || 4;
  return cfg;
}

function saveConfig(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SN.CONFIG);
  if (!sheet) { setupSheets(); sheet = ss.getSheetByName(SN.CONFIG); }
  const vals = [
    ['大会名', data.name || ''],
    ['開催日', data.date || ''],
    ['会場', data.venue || ''],
    ['コート数', String(data.court_count || 4)],
    ['主催者', data.organizer || ''],
    ['申込締切', data.deadline || ''],
    ['備考', data.notes || ''],
    ['フォーム公開', data.form_open ? 'TRUE' : 'FALSE'],
    ['領収書但し書きテンプレート', data.receipt_template || '○○大会 参加費として']
  ];
  sheet.getRange('A2:B10').setValues(vals);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════
// 種目管理
// ═══════════════════════════════════════════════════════

function getEvents() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.EVENTS);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  return data.filter(r => r[0]).map(r => ({
    id: r[0], event_type: r[1], event_name: r[2], gender: r[3],
    age_category: r[4], fee: parseInt(r[5]) || 0, max_players: parseInt(r[6]) || 0,
    sort_order: parseInt(r[7]) || 0
  })).sort((a, b) => a.sort_order - b.sort_order);
}

function saveEvents(events) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SN.EVENTS);
  if (!sheet) { setupSheets(); sheet = ss.getSheetByName(SN.EVENTS); }

  // Clear existing (keep header)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 8).clearContent();

  // Write events
  if (events.length > 0) {
    const rows = events.map((ev, i) => [
      ev.id || ('evt_' + Utilities.getUuid().substring(0, 8)),
      ev.event_type || 'singles',
      ev.event_name || '',
      ev.gender || 'open',
      ev.age_category || 'general',
      ev.fee || 0,
      ev.max_players || 0,
      ev.sort_order !== undefined ? ev.sort_order : i
    ]);
    sheet.getRange(2, 1, rows.length, 8).setValues(rows);
  }

  // Sync event sheets
  syncAllEventSheets();
  return { ok: true, count: events.length };
}

// ── 種目別シート自動生成 ──────────────────────────────
function syncAllEventSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const events = getEvents();
  const regs = getAllRegistrations_();

  events.forEach(ev => {
    const sheetName = ev.event_name.substring(0, 50); // シート名の長さ制限
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    // ヘッダー設定（種目タイプに応じて変更）
    let headers;
    if (ev.event_type === 'team') {
      headers = ['No.','団体名','代表者','選手1','選手2','選手3','選手4','選手5','補欠','連絡先','参加費','入金','領収書No.','備考'];
    } else if (ev.event_type === 'doubles' || ev.event_type === 'mixed_doubles') {
      headers = ['No.','所属/団体','選手1','ふりがな1','選手2','ふりがな2','代表者','連絡先','参加費','入金','領収書No.','備考'];
    } else {
      headers = ['No.','所属/団体','選手名','ふりがな','性別','年代','代表者','連絡先','参加費','入金','領収書No.','備考'];
    }

    // Clear and write header
    sheet.clear();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#7c3aed').setFontColor('#fff');
    sheet.setFrozenRows(1);

    // Filter registrations for this event
    const evRegs = regs.filter(r => r.event_id === ev.id);

    if (evRegs.length > 0) {
      const rows = evRegs.map((r, i) => {
        if (ev.event_type === 'team') {
          return [i+1, r.team_name, r.representative, r.m1, r.m2, r.m3, r.m4, r.m5, r.m6, r.phone, r.fee_amount, r.fee_paid, r.receipt_number, r.notes];
        } else if (ev.event_type === 'doubles' || ev.event_type === 'mixed_doubles') {
          return [i+1, r.team_name, r.m1, r.f1, r.m2, r.f2, r.representative, r.phone, r.fee_amount, r.fee_paid, r.receipt_number, r.notes];
        } else {
          return [i+1, r.team_name, r.m1, r.f1, r.g1, r.a1, r.representative, r.phone, r.fee_amount, r.fee_paid, r.receipt_number, r.notes];
        }
      });
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }

    // Auto-resize
    sheet.autoResizeColumns(1, headers.length);
  });
}

// ═══════════════════════════════════════════════════════
// 申込管理
// ═══════════════════════════════════════════════════════

function getAllRegistrations_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.REGS);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 36).getValues();
  return data.filter(r => r[0]).map(r => ({
    id: r[0], event_id: r[1], event_name: r[2],
    team_name: r[3], representative: r[4], phone: r[5], email: r[6],
    m1: r[7], f1: r[8], g1: r[9], a1: r[10],
    m2: r[11], f2: r[12], g2: r[13], a2: r[14],
    m3: r[15], f3: r[16], g3: r[17], a3: r[18],
    m4: r[19], f4: r[20], g4: r[21], a4: r[22],
    m5: r[23], f5: r[24], g5: r[25], a5: r[26],
    m6: r[27], f6: r[28], g6: r[29], a6: r[30],
    fee_amount: parseInt(r[31]) || 0,
    fee_paid: r[32] === '済' || r[32] === true ? '済' : '未',
    receipt_number: r[33] || '',
    receipt_desc: r[34] || '',
    notes: r[35] || '',
    created_at: r[36] || ''
  }));
}

function getRegistrations(eventId) {
  const all = getAllRegistrations_();
  if (eventId && eventId !== 'all') {
    return all.filter(r => r.event_id === eventId);
  }
  return all;
}

// ── 選手備考をメイン備考に統合する ──────────────────────
function buildNotesWithPlayerNotes_(baseNotes, members) {
  let notes = baseNotes || '';
  if (!members || members.length === 0) return notes;

  const playerNoteParts = [];
  members.forEach((m, i) => {
    if (m && m.notes && m.notes.trim()) {
      playerNoteParts.push('[選手' + (i + 1) + '備考: ' + m.notes.trim() + ']');
    }
  });

  if (playerNoteParts.length > 0) {
    if (notes) notes += ' ';
    notes += playerNoteParts.join(' ');
  }
  return notes;
}

// ── 申込サマリーテキスト生成 ─────────────────────────
function buildSummaryText_(regId, eventName, data, members, feeAmount) {
  const config = getConfig();
  const lines = [];
  lines.push('━━━ 申込確認 ━━━');
  if (config.name) lines.push('大会名: ' + config.name);
  lines.push('申込ID: ' + regId);
  lines.push('種目: ' + eventName);
  lines.push('');
  lines.push('【申込者情報】');
  if (data.team_name) lines.push('団体名: ' + data.team_name);
  if (data.representative) lines.push('代表者: ' + data.representative);
  if (data.phone) lines.push('電話番号: ' + data.phone);
  if (data.email) lines.push('メール: ' + data.email);
  lines.push('');
  if (members && members.length > 0) {
    lines.push('【選手一覧】');
    members.forEach((m, i) => {
      if (m && m.player_name) {
        let line = '  ' + (i + 1) + '. ' + m.player_name;
        if (m.furigana) line += ' (' + m.furigana + ')';
        if (m.gender) line += ' / ' + m.gender;
        if (m.age_category) line += ' / ' + m.age_category;
        if (m.notes) line += ' [' + m.notes + ']';
        lines.push(line);
      }
    });
    lines.push('');
  }
  lines.push('参加費: ' + (feeAmount || 0) + '円');
  if (data.notes) lines.push('備考: ' + data.notes);
  lines.push('');
  if (config.date) lines.push('開催日: ' + config.date);
  if (config.venue) lines.push('会場: ' + config.venue);
  lines.push('━━━━━━━━━━━━━━');
  return lines.join('\n');
}

function addRegistration(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SN.REGS);
  if (!sheet) { setupSheets(); sheet = ss.getSheetByName(SN.REGS); }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const id = 'reg_' + Utilities.getUuid().substring(0, 8);
    const members = data.members || [];
    const m = (i, key) => members[i] ? (members[i][key] || '') : '';
    const events = getEvents();
    const ev = events.find(e => e.id === data.event_id);
    const feeAmount = data.fee_amount !== undefined ? data.fee_amount : (ev ? ev.fee : 0);
    const eventName = ev ? ev.event_name : '';

    // Build notes with player-level notes appended
    const combinedNotes = buildNotesWithPlayerNotes_(data.notes, members);

    const row = [
      id, data.event_id || '', eventName,
      data.team_name || '', data.representative || '', data.phone || '', data.email || '',
      m(0,'player_name'), m(0,'furigana'), m(0,'gender'), m(0,'age_category'),
      m(1,'player_name'), m(1,'furigana'), m(1,'gender'), m(1,'age_category'),
      m(2,'player_name'), m(2,'furigana'), m(2,'gender'), m(2,'age_category'),
      m(3,'player_name'), m(3,'furigana'), m(3,'gender'), m(3,'age_category'),
      m(4,'player_name'), m(4,'furigana'), m(4,'gender'), m(4,'age_category'),
      m(5,'player_name'), m(5,'furigana'), m(5,'gender'), m(5,'age_category'),
      feeAmount, '未', '', '', combinedNotes,
      new Date().toLocaleString('ja-JP')
    ];

    sheet.appendRow(row);

    // 種目別シートにも追加
    syncAllEventSheets();

    // Generate summary text
    const summary_text = buildSummaryText_(id, eventName, data, members, feeAmount);

    return { ok: true, id: id, summary_text: summary_text };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════
// 一括申込（複数種目同時登録）
// ═══════════════════════════════════════════════════════

function addBulkRegistration(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SN.REGS);
  if (!sheet) { setupSheets(); sheet = ss.getSheetByName(SN.REGS); }

  const eventIds = data.event_ids || [];
  if (eventIds.length === 0) return { error: '種目が選択されていません' };

  const membersPerEvent = data.members_per_event || {};
  const events = getEvents();

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const ids = [];
    const summaryParts = [];
    const config = getConfig();
    let totalFee = 0;

    eventIds.forEach(eventId => {
      const id = 'reg_' + Utilities.getUuid().substring(0, 8);
      const ev = events.find(e => e.id === eventId);
      const eventName = ev ? ev.event_name : '';
      const feeAmount = ev ? ev.fee : 0;
      totalFee += feeAmount;

      const members = membersPerEvent[eventId] || [];
      const m = (i, key) => members[i] ? (members[i][key] || '') : '';

      // Build notes with player-level notes
      const combinedNotes = buildNotesWithPlayerNotes_(data.notes, members);

      const row = [
        id, eventId, eventName,
        data.team_name || '', data.representative || '', data.phone || '', data.email || '',
        m(0,'player_name'), m(0,'furigana'), m(0,'gender'), m(0,'age_category'),
        m(1,'player_name'), m(1,'furigana'), m(1,'gender'), m(1,'age_category'),
        m(2,'player_name'), m(2,'furigana'), m(2,'gender'), m(2,'age_category'),
        m(3,'player_name'), m(3,'furigana'), m(3,'gender'), m(3,'age_category'),
        m(4,'player_name'), m(4,'furigana'), m(4,'gender'), m(4,'age_category'),
        m(5,'player_name'), m(5,'furigana'), m(5,'gender'), m(5,'age_category'),
        feeAmount, '未', '', '', combinedNotes,
        new Date().toLocaleString('ja-JP')
      ];

      sheet.appendRow(row);
      ids.push(id);

      // Build per-event summary
      const memberLines = [];
      members.forEach((mb, i) => {
        if (mb && mb.player_name) {
          let line = '  ' + (i + 1) + '. ' + mb.player_name;
          if (mb.furigana) line += ' (' + mb.furigana + ')';
          if (mb.gender) line += ' / ' + mb.gender;
          if (mb.age_category) line += ' / ' + mb.age_category;
          if (mb.notes) line += ' [' + mb.notes + ']';
          memberLines.push(line);
        }
      });
      let part = '■ ' + eventName + ' (ID: ' + id + ') - ' + feeAmount + '円';
      if (memberLines.length > 0) part += '\n' + memberLines.join('\n');
      summaryParts.push(part);
    });

    // Sync event sheets
    syncAllEventSheets();

    // Build full summary text
    const summaryLines = [];
    summaryLines.push('━━━ 一括申込確認 ━━━');
    if (config.name) summaryLines.push('大会名: ' + config.name);
    summaryLines.push('');
    summaryLines.push('【申込者情報】');
    if (data.team_name) summaryLines.push('団体名: ' + data.team_name);
    if (data.representative) summaryLines.push('代表者: ' + data.representative);
    if (data.phone) summaryLines.push('電話番号: ' + data.phone);
    if (data.email) summaryLines.push('メール: ' + data.email);
    summaryLines.push('');
    summaryLines.push('【申込種目】');
    summaryLines.push(summaryParts.join('\n\n'));
    summaryLines.push('');
    summaryLines.push('合計参加費: ' + totalFee + '円');
    if (data.notes) summaryLines.push('備考: ' + data.notes);
    summaryLines.push('');
    if (config.date) summaryLines.push('開催日: ' + config.date);
    if (config.venue) summaryLines.push('会場: ' + config.venue);
    summaryLines.push('━━━━━━━━━━━━━━');
    const summary_text = summaryLines.join('\n');

    // Auto-send confirmation email if email is provided
    if (data.email) {
      try {
        const subject = (config.name || '卓球大会') + ' 申込確認';
        sendConfirmationEmail_(data.email, subject, summary_text);
      } catch (emailErr) {
        // Email sending failure should not fail the registration
        return { ok: true, ids: ids, summary_text: summary_text, email_error: emailErr.message };
      }
    }

    return { ok: true, ids: ids, summary_text: summary_text };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════
// 確認メール送信
// ═══════════════════════════════════════════════════════

function sendConfirmationEmail_(email, subject, body) {
  if (!email) return { error: 'メールアドレスが指定されていません' };
  if (!subject) subject = '卓球大会 申込確認';
  if (!body) body = '申込を受け付けました。';

  GmailApp.sendEmail(email, subject, body);
  return { ok: true, sent_to: email };
}

// ═══════════════════════════════════════════════════════
// 申込更新・削除
// ═══════════════════════════════════════════════════════

function updateRegistration(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.REGS);
  if (!sheet) return { error: 'シートなし' };

  const rowIndex = findRowById_(sheet, data.id);
  if (rowIndex < 0) return { error: '申込が見つかりません' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const existing = sheet.getRange(rowIndex, 1, 1, 36).getValues()[0];
    const members = data.members || [];
    const m = (i, key) => members[i] ? (members[i][key] || '') : '';
    const hasMemberUpdate = members.length > 0;

    // Update fields (keep existing if not provided)
    if (data.team_name !== undefined) existing[3] = data.team_name;
    if (data.representative !== undefined) existing[4] = data.representative;
    if (data.phone !== undefined) existing[5] = data.phone;
    if (data.email !== undefined) existing[6] = data.email;
    if (hasMemberUpdate) {
      for (let i = 0; i < 6; i++) {
        existing[7 + i*4] = m(i, 'player_name');
        existing[8 + i*4] = m(i, 'furigana');
        existing[9 + i*4] = m(i, 'gender');
        existing[10 + i*4] = m(i, 'age_category');
      }
    }
    if (data.fee_amount !== undefined) existing[31] = data.fee_amount;
    if (data.fee_paid !== undefined) existing[32] = data.fee_paid;
    if (data.receipt_number !== undefined) existing[33] = data.receipt_number;
    if (data.receipt_desc !== undefined) existing[34] = data.receipt_desc;
    if (data.notes !== undefined) {
      existing[35] = buildNotesWithPlayerNotes_(data.notes, hasMemberUpdate ? members : []);
    }

    sheet.getRange(rowIndex, 1, 1, 36).setValues([existing]);
    syncAllEventSheets();

    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function deleteRegistration(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.REGS);
  if (!sheet) return { error: 'シートなし' };

  const rowIndex = findRowById_(sheet, id);
  if (rowIndex < 0) return { error: '見つかりません' };

  sheet.deleteRow(rowIndex);
  syncAllEventSheets();
  return { ok: true };
}

function togglePayment(id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.REGS);
  if (!sheet) return { error: 'シートなし' };

  const rowIndex = findRowById_(sheet, id);
  if (rowIndex < 0) return { error: '見つかりません' };

  const current = sheet.getRange(rowIndex, 33).getValue(); // 入金状態 col=33 (col AG)
  const newVal = current === '済' ? '未' : '済';
  sheet.getRange(rowIndex, 33).setValue(newVal);
  syncAllEventSheets();
  return { ok: true, fee_paid: newVal };
}

// ═══════════════════════════════════════════════════════
// 領収書
// ═══════════════════════════════════════════════════════

function issueReceipt(regId, description) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const regSheet = ss.getSheetByName(SN.REGS);
  const rcpSheet = ss.getSheetByName(SN.RECEIPTS);
  if (!regSheet || !rcpSheet) return { error: 'シートなし' };

  const rowIndex = findRowById_(regSheet, regId);
  if (rowIndex < 0) return { error: '申込が見つかりません' };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const regRow = regSheet.getRange(rowIndex, 1, 1, 36).getValues()[0];
    const config = getConfig();

    // 領収書番号生成
    const rcpLastRow = rcpSheet.getLastRow();
    const now = new Date();
    const prefix = 'R' + Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMM');
    const num = prefix + '-' + String(rcpLastRow).padStart(4, '0');

    // 但し書き（引数があればそちらを使用、なければテンプレート）
    const desc = description || config.receipt_template || (config.name + ' 参加費として');

    // 領収書台帳に追加
    rcpSheet.appendRow([
      num,
      Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd'),
      regRow[3] || regRow[4], // 団体名 or 代表者
      regRow[31], // 参加費
      desc,
      config.name,
      regRow[2], // 種目名
      regId
    ]);

    // 申込データ更新（入金済・領収書番号・但し書き）
    regSheet.getRange(rowIndex, 33).setValue('済');
    regSheet.getRange(rowIndex, 34).setValue(num);
    regSheet.getRange(rowIndex, 35).setValue(desc);

    syncAllEventSheets();

    return { ok: true, receipt_number: num, description: desc };
  } finally {
    lock.releaseLock();
  }
}

function generateReceiptNumber() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.RECEIPTS);
  const lastRow = sheet ? sheet.getLastRow() : 1;
  const now = new Date();
  const prefix = 'R' + Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMM');
  return prefix + '-' + String(lastRow).padStart(4, '0');
}

// ═══════════════════════════════════════════════════════
// 公開フォーム用データ
// ═══════════════════════════════════════════════════════

function getPublicData() {
  const config = getConfig();
  if (!config.form_open) return { error: '受付終了', form_open: false };

  const events = getEvents();
  const regs = getAllRegistrations_();

  const eventsWithCount = events.map(ev => ({
    ...ev,
    current_count: regs.filter(r => r.event_id === ev.id).length
  }));

  return {
    form_open: true,
    name: config.name, date: config.date, venue: config.venue,
    organizer: config.organizer, deadline: config.deadline,
    notes: config.notes, events: eventsWithCount
  };
}

// ═══════════════════════════════════════════════════════
// フォーム埋め込み情報
// ═══════════════════════════════════════════════════════

function getFormEmbed_(e) {
  const scriptUrl = ScriptApp.getService().getUrl();
  return {
    ok: true,
    form_url: scriptUrl,
    embed_url: scriptUrl + '?mode=form',
    gas_url: scriptUrl
  };
}

// ═══════════════════════════════════════════════════════
// 統計
// ═══════════════════════════════════════════════════════

function getStats() {
  const events = getEvents();
  const regs = getAllRegistrations_();
  const totalFee = regs.reduce((s, r) => s + r.fee_amount, 0);
  const paidFee = regs.filter(r => r.fee_paid === '済').reduce((s, r) => s + r.fee_amount, 0);

  const byEvent = events.map(ev => {
    const evRegs = regs.filter(r => r.event_id === ev.id);
    return {
      event_name: ev.event_name,
      count: evRegs.length,
      fee_total: evRegs.reduce((s, r) => s + r.fee_amount, 0),
      fee_paid: evRegs.filter(r => r.fee_paid === '済').reduce((s, r) => s + r.fee_amount, 0)
    };
  });

  return {
    total_registrations: regs.length,
    total_fee: totalFee,
    paid_fee: paidFee,
    unpaid_fee: totalFee - paidFee,
    by_event: byEvent
  };
}

// ═══════════════════════════════════════════════════════
// ユーティリティ
// ═══════════════════════════════════════════════════════

function findRowById_(sheet, id) {
  if (!id) return -1;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2; // +2: header row + 0-indexed
  }
  return -1;
}

function sortRegistrations() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SN.REGS);
  if (!sheet || sheet.getLastRow() < 3) return;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 36).sort([{column: 2, ascending: true}, {column: 36, ascending: true}]);
}
