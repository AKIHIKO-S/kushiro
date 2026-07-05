/**
 * ════════════════════════════════════════════════════════════════
 *  釧路卓球協会 大会申込管理システム（Google Sheets + GAS）
 * ════════════════════════════════════════════════════════════════
 *  機能：
 *   - Webフォームで大会申込を受付（doGetでフォーム配信）
 *   - 申込データを「申込データ」シートへ蓄積
 *   - 種目ごとに「種目別名簿_◯◯」シートを自動生成
 *   - 「団体別集計」シートに団体ごとの参加人数・参加料金を自動集計
 *   - 「全体集計」シートに大会全体の集計を出力
 *
 *  セットアップ手順：
 *   1) 新規Googleスプレッドシートを作成
 *   2) 拡張機能 > Apps Script を開く
 *   3) Code.gs にこのファイル全文を貼り付け
 *   4) Form.html を新規作成（HTML）して Form.html の中身を貼り付け
 *   5) スプレッドシートに戻り、メニュー「大会管理 > 初期セットアップ」を実行
 *   6) 「種目マスター」「大会設定」を必要に応じて編集
 *   7) デプロイ > 新しいデプロイ > ウェブアプリ
 *       - 実行ユーザー：自分
 *       - アクセス：全員
 *      表示されたURLが申込フォームのURL（釧路卓球協会サイトに貼り付け可能）
 *
 *  釧路卓球協会サイトへの貼り付け例（iframe）：
 *    <iframe src="（デプロイURL）" width="100%" height="1400" style="border:0"></iframe>
 *  もしくはリンクボタン：
 *    <a href="（デプロイURL）" target="_blank">大会申込フォームを開く</a>
 * ════════════════════════════════════════════════════════════════
 */

const SHEET = {
  CONFIG:   '大会設定',
  EVENTS:   '種目マスター',
  REGS:     '申込データ',
  TEAM_SUM: '団体別集計',
  ALL_SUM:  '全体集計'
};

const EVENT_SHEET_PREFIX = '種目別名簿_';

// ── メニュー ──────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('大会管理')
    .addItem('初期セットアップ', 'setupAll')
    .addSeparator()
    .addItem('集計を更新（手動）', 'rebuildAllAggregations')
    .addItem('種目別名簿を再生成', 'rebuildEventSheets')
    .addItem('団体別集計を再生成', 'rebuildTeamSummary')
    .addItem('全体集計を再生成', 'rebuildOverallSummary')
    .addSeparator()
    .addItem('申込フォームURLを表示', 'showFormUrl')
    .addToUi();
}

// ── 初期セットアップ ─────────────────────────────────────────
function setupAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1) 大会設定
  let s = ss.getSheetByName(SHEET.CONFIG);
  if (!s) {
    s = ss.insertSheet(SHEET.CONFIG);
    s.getRange('A1:B1').setValues([['項目','値']])
      .setFontWeight('bold').setBackground('#0f4c81').setFontColor('#fff');
    s.getRange('A2:B9').setValues([
      ['大会名',   '令和○年度 釧路卓球協会○○大会'],
      ['開催日',   ''],
      ['会場',     '釧路市民体育館'],
      ['主催',     '釧路卓球協会'],
      ['申込締切', ''],
      ['備考',     ''],
      ['受付状態', 'open'], // open / closed
      ['連絡先',   '']
    ]);
    s.setColumnWidths(1, 2, 280);
    s.getRange('A2:A9').setFontWeight('bold');
  }

  // 2) 種目マスター
  s = ss.getSheetByName(SHEET.EVENTS);
  if (!s) {
    s = ss.insertSheet(SHEET.EVENTS);
    const h = ['種目ID','種目名','種別','参加費','1組の人数','並び順','受付'];
    s.getRange(1,1,1,h.length).setValues([h])
      .setFontWeight('bold').setBackground('#7c3aed').setFontColor('#fff');
    // 釧路卓球協会で一般的な種目をシード
    const seed = [
      ['E01','一般男子シングルス',     'singles', 1500, 1, 1, 'TRUE'],
      ['E02','一般女子シングルス',     'singles', 1500, 1, 2, 'TRUE'],
      ['E03','一般男子ダブルス',       'doubles', 2000, 2, 3, 'TRUE'],
      ['E04','一般女子ダブルス',       'doubles', 2000, 2, 4, 'TRUE'],
      ['E05','ミックスダブルス',       'doubles', 2000, 2, 5, 'TRUE'],
      ['E06','30歳以上男子シングルス', 'singles', 1500, 1, 6, 'TRUE'],
      ['E07','40歳以上男子シングルス', 'singles', 1500, 1, 7, 'TRUE'],
      ['E08','50歳以上男子シングルス', 'singles', 1500, 1, 8, 'TRUE'],
      ['E09','60歳以上男子シングルス', 'singles', 1500, 1, 9, 'TRUE'],
      ['E10','70歳以上男子シングルス', 'singles', 1500, 1,10, 'TRUE'],
      ['E11','30歳以上女子シングルス', 'singles', 1500, 1,11, 'TRUE'],
      ['E12','40歳以上女子シングルス', 'singles', 1500, 1,12, 'TRUE'],
      ['E13','50歳以上女子シングルス', 'singles', 1500, 1,13, 'TRUE'],
      ['E14','60歳以上女子シングルス', 'singles', 1500, 1,14, 'TRUE'],
      ['E15','高校生男子シングルス',   'singles', 1000, 1,15, 'TRUE'],
      ['E16','高校生女子シングルス',   'singles', 1000, 1,16, 'TRUE'],
      ['E17','中学生男子シングルス',   'singles',  800, 1,17, 'TRUE'],
      ['E18','中学生女子シングルス',   'singles',  800, 1,18, 'TRUE'],
      ['E19','男子団体戦',             'team',    5000, 4,19, 'TRUE'],
      ['E20','女子団体戦',             'team',    5000, 4,20, 'TRUE']
    ];
    s.getRange(2,1,seed.length,h.length).setValues(seed);
    s.setFrozenRows(1);
    s.autoResizeColumns(1, h.length);
  }

  // 3) 申込データ
  s = ss.getSheetByName(SHEET.REGS);
  if (!s) {
    s = ss.insertSheet(SHEET.REGS);
    const h = [
      '申込ID','申込日時','団体名','代表者名','電話番号','メール',
      '種目ID','種目名','参加費','人数',
      '選手1','ふりがな1','性別1','学年/年代1',
      '選手2','ふりがな2','性別2','学年/年代2',
      '選手3','ふりがな3','性別3','学年/年代3',
      '選手4','ふりがな4','性別4','学年/年代4',
      '選手5','ふりがな5','性別5','学年/年代5',
      '選手6','ふりがな6','性別6','学年/年代6',
      '備考','入金状態'
    ];
    s.getRange(1,1,1,h.length).setValues([h])
      .setFontWeight('bold').setBackground('#0f4c81').setFontColor('#fff');
    s.setFrozenRows(1);
    s.setColumnWidth(1, 130);
    s.setColumnWidth(2, 150);
  }

  rebuildAllAggregations();

  SpreadsheetApp.getUi().alert(
    '✅ 初期セットアップ完了\n\n' +
    '次の手順：\n' +
    '1. 「大会設定」「種目マスター」を編集\n' +
    '2. デプロイ > 新しいデプロイ > ウェブアプリ\n' +
    '3. 表示されたURLを釧路卓球協会サイトに貼り付け'
  );
}

// ── Webアプリ：フォーム配信＆送信受付 ──────────────────────
function doGet(e) {
  const mode = (e && e.parameter && e.parameter.mode) || 'form';
  if (mode === 'api') {
    return jsonOut_({ ok: true, data: getPublicData_() });
  }
  const t = HtmlService.createTemplateFromFile('Form');
  t.bootstrap = getPublicData_();
  return t.evaluate()
    .setTitle('釧路卓球協会 大会申込フォーム')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const result = submitRegistration_(payload);
    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ ok: false, error: err.message });
  }
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── データ取得 ────────────────────────────────────────────────
function getConfig_() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.CONFIG);
  if (!s) return {};
  const rows = s.getRange('A2:B9').getValues();
  const cfg = {};
  rows.forEach(r => { if (r[0]) cfg[r[0]] = r[1]; });
  return cfg;
}

function getEvents_() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.EVENTS);
  if (!s) return [];
  const last = s.getLastRow();
  if (last < 2) return [];
  return s.getRange(2,1,last-1,7).getValues()
    .filter(r => r[0])
    .map(r => ({
      id: String(r[0]),
      name: String(r[1]),
      type: String(r[2] || 'singles'),
      fee:  Number(r[3]) || 0,
      size: Number(r[4]) || 1,
      sort: Number(r[5]) || 0,
      open: String(r[6]).toUpperCase() === 'TRUE'
    }))
    .sort((a,b) => a.sort - b.sort);
}

function getRegs_() {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET.REGS);
  if (!s) return [];
  const last = s.getLastRow();
  if (last < 2) return [];
  const vals = s.getRange(2,1,last-1,36).getValues();
  return vals.filter(r => r[0]).map(r => {
    const players = [];
    for (let i = 0; i < 6; i++) {
      const base = 10 + i*4;
      const name = r[base];
      if (name) players.push({
        name: String(name),
        kana: String(r[base+1] || ''),
        gender: String(r[base+2] || ''),
        age: String(r[base+3] || '')
      });
    }
    return {
      id: r[0], at: r[1], team: r[2], rep: r[3], phone: r[4], email: r[5],
      event_id: r[6], event_name: r[7], fee: Number(r[8])||0, size: Number(r[9])||0,
      players, notes: r[34], paid: r[35]
    };
  });
}

function getPublicData_() {
  const cfg = getConfig_();
  const events = getEvents_().filter(e => e.open);
  return {
    config: cfg,
    open: String(cfg['受付状態'] || 'open').toLowerCase() === 'open',
    events
  };
}

// ── 申込登録 ──────────────────────────────────────────────────
function submitRegistration_(payload) {
  const cfg = getConfig_();
  if (String(cfg['受付状態'] || 'open').toLowerCase() !== 'open') {
    return { ok: false, error: '現在は申込受付を停止しています' };
  }
  const team = (payload.team || '').trim();
  const rep  = (payload.rep || '').trim();
  if (!team) return { ok: false, error: '団体名を入力してください' };
  if (!rep)  return { ok: false, error: '代表者名を入力してください' };
  const entries = payload.entries || [];
  if (entries.length === 0) return { ok: false, error: '申込種目がありません' };

  const events = getEvents_();
  const eventById = {};
  events.forEach(ev => eventById[ev.id] = ev);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET.REGS);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);

  try {
    const now = new Date();
    const at = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    const ids = [];
    const summaryLines = [];
    let total = 0;

    entries.forEach(en => {
      const ev = eventById[en.event_id];
      if (!ev || !ev.open) return;
      const players = (en.players || []).filter(p => p && p.name && String(p.name).trim());
      if (players.length === 0) return;

      const id = 'R' + Utilities.formatDate(now,'Asia/Tokyo','yyMMddHHmmss')
                  + '-' + Math.random().toString(36).substring(2,5).toUpperCase();
      const row = new Array(36).fill('');
      row[0] = id;
      row[1] = at;
      row[2] = team;
      row[3] = rep;
      row[4] = payload.phone || '';
      row[5] = payload.email || '';
      row[6] = ev.id;
      row[7] = ev.name;
      row[8] = ev.fee;
      row[9] = players.length;
      for (let i = 0; i < Math.min(players.length, 6); i++) {
        const p = players[i];
        row[10 + i*4] = p.name || '';
        row[11 + i*4] = p.kana || '';
        row[12 + i*4] = p.gender || '';
        row[13 + i*4] = p.age || '';
      }
      row[34] = payload.notes || '';
      row[35] = '未';

      sheet.appendRow(row);
      ids.push(id);
      total += ev.fee;
      summaryLines.push('・' + ev.name + '（' + players.map(p => p.name).join('、') + '）  ¥' + ev.fee.toLocaleString());
    });

    if (ids.length === 0) return { ok: false, error: '有効な申込がありません（選手名未入力など）' };

    // 集計シート更新
    rebuildAllAggregations();

    // 確認メール
    if (payload.email) {
      try {
        const subject = (cfg['大会名'] || '釧路卓球協会大会') + ' 申込受付のお知らせ';
        const body = [
          (cfg['大会名'] || '釧路卓球協会大会') + ' への申込を受け付けました。',
          '',
          '【申込内容】',
          '団体名：' + team,
          '代表者：' + rep,
          '電話：' + (payload.phone || ''),
          '',
          '【申込種目】',
          summaryLines.join('\n'),
          '',
          '合計参加費：¥' + total.toLocaleString(),
          '',
          (cfg['開催日'] ? '開催日：' + cfg['開催日'] : ''),
          (cfg['会場']   ? '会場：'   + cfg['会場']   : ''),
          (cfg['連絡先'] ? '連絡先：' + cfg['連絡先'] : ''),
          '',
          '※ このメールは自動送信です。'
        ].filter(Boolean).join('\n');
        GmailApp.sendEmail(payload.email, subject, body);
      } catch (mailErr) {
        // メール失敗は致命的にしない
      }
    }

    return { ok: true, ids, total, summary: summaryLines.join('\n') };
  } finally {
    lock.releaseLock();
  }
}

// ── 集計：種目別名簿シート ───────────────────────────────────
function rebuildEventSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const events = getEvents_();
  const regs = getRegs_();

  // 既存の種目別シートを把握
  const existing = ss.getSheets()
    .filter(sh => sh.getName().indexOf(EVENT_SHEET_PREFIX) === 0)
    .map(sh => sh.getName());
  const keep = new Set(events.map(ev => EVENT_SHEET_PREFIX + ev.name.substring(0, 90)));

  // 不要なシートを削除
  existing.forEach(n => {
    if (!keep.has(n)) ss.deleteSheet(ss.getSheetByName(n));
  });

  events.forEach(ev => {
    const sheetName = EVENT_SHEET_PREFIX + ev.name.substring(0, 90);
    let s = ss.getSheetByName(sheetName);
    if (!s) s = ss.insertSheet(sheetName);
    s.clear();

    const evRegs = regs.filter(r => r.event_id === ev.id);

    // タイトル
    s.getRange(1,1).setValue(ev.name + '  参加者名簿').setFontSize(14).setFontWeight('bold');
    s.getRange(2,1).setValue(
      '組数：' + evRegs.length + '組　／　参加人数：' +
      evRegs.reduce((sum,r) => sum + r.players.length, 0) + '名　／　参加費合計：¥' +
      evRegs.reduce((sum,r) => sum + r.fee, 0).toLocaleString()
    );

    // ヘッダー
    let headers;
    if (ev.type === 'team') {
      headers = ['No.','団体名','代表者','選手1','選手2','選手3','選手4','補欠1','補欠2','連絡先','参加費','入金'];
    } else if (ev.type === 'doubles') {
      headers = ['No.','団体名','選手1','ふりがな1','選手2','ふりがな2','代表者','連絡先','参加費','入金'];
    } else {
      headers = ['No.','団体名','選手名','ふりがな','性別','学年/年代','代表者','連絡先','参加費','入金'];
    }
    s.getRange(4,1,1,headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#7c3aed').setFontColor('#fff');
    s.setFrozenRows(4);

    if (evRegs.length > 0) {
      const rows = evRegs.map((r, idx) => {
        const p = r.players;
        const get = (i, key) => p[i] ? (p[i][key] || '') : '';
        if (ev.type === 'team') {
          return [idx+1, r.team, r.rep,
            get(0,'name'), get(1,'name'), get(2,'name'), get(3,'name'),
            get(4,'name'), get(5,'name'),
            r.phone, r.fee, r.paid];
        } else if (ev.type === 'doubles') {
          return [idx+1, r.team,
            get(0,'name'), get(0,'kana'),
            get(1,'name'), get(1,'kana'),
            r.rep, r.phone, r.fee, r.paid];
        } else {
          return [idx+1, r.team,
            get(0,'name'), get(0,'kana'), get(0,'gender'), get(0,'age'),
            r.rep, r.phone, r.fee, r.paid];
        }
      });
      s.getRange(5,1,rows.length,headers.length).setValues(rows);
      // 縞模様
      s.getRange(5,1,rows.length,headers.length)
        .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY);
    }

    s.autoResizeColumns(1, headers.length);
  });
}

// ── 集計：団体別 ─────────────────────────────────────────────
function rebuildTeamSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const events = getEvents_();
  const regs = getRegs_();

  let s = ss.getSheetByName(SHEET.TEAM_SUM);
  if (!s) s = ss.insertSheet(SHEET.TEAM_SUM);
  s.clear();

  // 団体ごとに集計
  const teams = {};
  regs.forEach(r => {
    if (!teams[r.team]) teams[r.team] = {
      team: r.team, rep: r.rep, phone: r.phone, email: r.email,
      events: {}, total_fee: 0, total_players: 0, total_entries: 0, paid_fee: 0
    };
    const t = teams[r.team];
    t.events[r.event_id] = (t.events[r.event_id] || 0) + 1;
    t.total_fee += r.fee;
    t.total_players += r.players.length;
    t.total_entries += 1;
    if (r.paid === '済' || r.paid === true) t.paid_fee += r.fee;
  });

  // ヘッダー：固定列 + 種目別組数列 + 集計列
  const fixed = ['団体名','代表者','電話','メール'];
  const eventCols = events.map(ev => ev.name);
  const summary = ['総組数','総人数','参加費合計','入金済','未収'];
  const headers = [...fixed, ...eventCols, ...summary];

  s.getRange(1,1).setValue('団体別 申込集計').setFontSize(14).setFontWeight('bold');
  s.getRange(3,1,1,headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#0f4c81').setFontColor('#fff');
  s.setFrozenRows(3);
  s.setFrozenColumns(1);

  const teamList = Object.values(teams).sort((a,b) => a.team.localeCompare(b.team,'ja'));
  if (teamList.length > 0) {
    const rows = teamList.map(t => {
      const evCounts = events.map(ev => t.events[ev.id] || 0);
      return [
        t.team, t.rep, t.phone, t.email,
        ...evCounts,
        t.total_entries, t.total_players, t.total_fee, t.paid_fee, t.total_fee - t.paid_fee
      ];
    });
    s.getRange(4,1,rows.length,headers.length).setValues(rows);

    // 合計行
    const totalRow = ['合計','','','',
      ...events.map(ev => teamList.reduce((sum,t) => sum + (t.events[ev.id] || 0), 0)),
      teamList.reduce((s,t) => s + t.total_entries, 0),
      teamList.reduce((s,t) => s + t.total_players, 0),
      teamList.reduce((s,t) => s + t.total_fee, 0),
      teamList.reduce((s,t) => s + t.paid_fee, 0),
      teamList.reduce((s,t) => s + (t.total_fee - t.paid_fee), 0)
    ];
    s.getRange(4 + rows.length, 1, 1, headers.length).setValues([totalRow])
      .setFontWeight('bold').setBackground('#fef3c7');

    // 通貨書式
    const feeColStart = fixed.length + eventCols.length + 3; // 参加費合計の列
    s.getRange(4, feeColStart, rows.length + 1, 3).setNumberFormat('¥#,##0');
  }

  s.autoResizeColumns(1, headers.length);
}

// ── 集計：全体 ───────────────────────────────────────────────
function rebuildOverallSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const events = getEvents_();
  const regs = getRegs_();

  let s = ss.getSheetByName(SHEET.ALL_SUM);
  if (!s) s = ss.insertSheet(SHEET.ALL_SUM);
  s.clear();

  const cfg = getConfig_();
  s.getRange(1,1).setValue(cfg['大会名'] || '大会').setFontSize(16).setFontWeight('bold');
  s.getRange(2,1).setValue(
    (cfg['開催日'] ? '開催日：' + cfg['開催日'] + '　' : '') +
    (cfg['会場']   ? '会場：'   + cfg['会場']   : '')
  );

  // 全体サマリー
  const totalFee = regs.reduce((sum,r) => sum + r.fee, 0);
  const paidFee  = regs.filter(r => r.paid === '済' || r.paid === true)
                       .reduce((sum,r) => sum + r.fee, 0);
  const totalPlayers = regs.reduce((sum,r) => sum + r.players.length, 0);
  const teams = new Set(regs.map(r => r.team));

  const sumHead = [['項目','値']];
  const sumRows = [
    ['参加団体数', teams.size],
    ['総申込組数', regs.length],
    ['総参加人数', totalPlayers],
    ['参加費合計', totalFee],
    ['入金済',     paidFee],
    ['未収',       totalFee - paidFee]
  ];
  s.getRange(4,1,1,2).setValues(sumHead)
    .setFontWeight('bold').setBackground('#0f4c81').setFontColor('#fff');
  s.getRange(5,1,sumRows.length,2).setValues(sumRows);
  s.getRange(8,2,3,1).setNumberFormat('¥#,##0');

  // 種目別サマリー
  const evStart = 5 + sumRows.length + 2;
  s.getRange(evStart,1).setValue('種目別集計').setFontWeight('bold').setFontSize(12);
  const evHead = ['種目名','種別','参加費','組数','人数','参加費合計'];
  s.getRange(evStart+1,1,1,evHead.length).setValues([evHead])
    .setFontWeight('bold').setBackground('#7c3aed').setFontColor('#fff');

  const evRows = events.map(ev => {
    const er = regs.filter(r => r.event_id === ev.id);
    return [
      ev.name, ev.type, ev.fee,
      er.length,
      er.reduce((sum,r) => sum + r.players.length, 0),
      er.reduce((sum,r) => sum + r.fee, 0)
    ];
  });
  if (evRows.length > 0) {
    s.getRange(evStart+2,1,evRows.length,evHead.length).setValues(evRows);
    s.getRange(evStart+2,3,evRows.length,1).setNumberFormat('¥#,##0');
    s.getRange(evStart+2,6,evRows.length,1).setNumberFormat('¥#,##0');
  }

  s.autoResizeColumns(1, 6);
}

function rebuildAllAggregations() {
  rebuildEventSheets();
  rebuildTeamSummary();
  rebuildOverallSummary();
}

// ── フォームURL表示 ──────────────────────────────────────────
function showFormUrl() {
  const url = ScriptApp.getService().getUrl();
  const ui = SpreadsheetApp.getUi();
  if (!url) {
    ui.alert('まだウェブアプリとしてデプロイされていません。\nデプロイ > 新しいデプロイ > ウェブアプリ から公開してください。');
    return;
  }
  ui.alert(
    '申込フォームURL',
    url + '\n\n釧路卓球協会サイトに以下のように貼り付けてください：\n\n' +
    '<iframe src="' + url + '" width="100%" height="1400" style="border:0"></iframe>\n\n' +
    'またはリンク：\n<a href="' + url + '" target="_blank">大会申込フォームを開く</a>',
    ui.ButtonSet.OK
  );
}

// ── 申込編集時に自動再集計（オプション）─────────────────────
function onEdit(e) {
  if (!e || !e.range) return;
  const name = e.range.getSheet().getName();
  if (name === SHEET.REGS || name === SHEET.EVENTS) {
    // 軽量化のため、明示メニューでの再集計を推奨
    // 自動再集計したい場合は次行のコメントを外す
    // rebuildAllAggregations();
  }
}
