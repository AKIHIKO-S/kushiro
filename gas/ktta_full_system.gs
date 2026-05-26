/**
 * ════════════════════════════════════════════════════════════
 * 釧路卓球協会 大会申込・集計・トーナメント支援システム (GAS)
 * ════════════════════════════════════════════════════════════
 *
 * このスクリプトを Google スプレッドシートに貼り付けるだけで
 * 申込フォーム発行 → 受信転記 → 集計 → 種目別一覧 → トーナメント表
 * の全工程を Google エコシステム内で完結できます。
 *
 * KTTA Platform (本番運営システム) とは独立しています。
 * トーナメント表 Excel 出力後、Platform に取り込んで運営します。
 *
 * ─── セットアップ手順 ───
 *  1. Google スプレッドシートを新規作成
 *  2. 拡張機能 → Apps Script を開く
 *  3. このスクリプト全体を貼り付け、保存
 *  4. 「ファイル」→「プロジェクト設定」→「スクリプトプロパティ」で
 *     以下を設定 (任意):
 *       ADMIN_EMAIL       = 主催者メールアドレス
 *       ASSOCIATION_NAME  = 釧路卓球協会
 *       PRESIDENT_NAME    = 会長 山本 満
 *       VENUE             = ウインドヒルくしろスーパーアリーナ
 *  5. スプレッドシートに戻り、メニューバーに「KTTA」が追加される
 *     (初回は再読込が必要)
 *  6. KTTA → 「初期セットアップ」を実行
 *  7. KTTA → 「申込フォームを発行」で URL を取得 → Jimdo / メール等で公開
 *
 * ─── 主要機能 ───
 *  ・申込フォーム HTML (フォーム発行) — Web App として公開
 *  ・受信時に自動で 8 シートに振分け転記
 *  ・団体別集計 (人数・参加料合計)
 *  ・種目別一覧表 (種目ごとの選手リスト)
 *  ・領収書 PDF 一括生成
 *  ・トーナメント表シート 自動レイアウト (シード配置)
 *
 * ════════════════════════════════════════════════════════════
 */

// ─── 設定 ─────────────────────────────────────
const PROPS = PropertiesService.getScriptProperties();
const DEFAULTS = {
  ASSOCIATION_NAME: '釧路卓球協会',
  PRESIDENT_NAME: '会長 山本 満',
  VENUE: 'ウインドヒルくしろスーパーアリーナ',
  ADMIN_EMAIL: '',
  // 種目別 参加料 (円)
  PRICE_TEAM_M: 4000,
  PRICE_TEAM_F: 4000,
  PRICE_DBL_M: 1000,
  PRICE_DBL_F: 1000,
  PRICE_MIX: 1200,
  PRICE_SGL_M: 700,
  PRICE_SGL_F: 700,
  PRICE_BENTO: 800,
  PRICE_PARTY: 3500,
};
function prop(key) {
  return PROPS.getProperty(key) || DEFAULTS[key] || '';
}
function priceProp(key) {
  return parseInt(PROPS.getProperty(key) || DEFAULTS[key]) || 0;
}

// シート名
const SHEETS = {
  CONFIG: '設定',
  RECEIVE_LOG: '申込台帳',
  ROSTER: '選手名簿',
  TEAM: '団体戦',
  DOUBLES: 'ダブルス',
  MIXED: 'ミックス',
  SINGLES: 'シングルス',
  EXTRAS: 'お弁当・懇親会',
  SEEKING: 'ダブルス相手募集',
  SUMMARY: '団体別集計',
  EVENT_LIST: '種目別一覧',
  BRACKET: 'トーナメント表',
};

// 既定種目
const DEFAULT_EVENTS = [
  '男子シングルス', '女子シングルス',
  '男子ダブルス', '女子ダブルス', '混合ダブルス',
  '男子団体戦', '女子団体戦',
  '高校男子シングルス', '高校女子シングルス',
  '中学男子シングルス', '中学女子シングルス',
  '小学男子シングルス', '小学女子シングルス',
  'サーティ男子', 'サーティ女子', 'フォーティ男子', 'フォーティ女子',
  'フィフティ男子', 'フィフティ女子',
  'ローシックスティ男子', 'ハイシックスティ男子',
  'ローセブンティ男子', 'ハイセブンティ男子',
];

// ═══════════════════════════════════════════════
// メニュー (スプレッドシートに表示される KTTA メニュー)
// ═══════════════════════════════════════════════
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('KTTA')
    .addItem('初期セットアップ (全シート作成)', 'setupAllSheets')
    .addSeparator()
    .addItem('① 申込フォームの URL を表示', 'showFormUrl')
    .addItem('② テスト申込を投入 (動作確認用)', 'insertTestEntry')
    .addSeparator()
    .addItem('③ 団体別集計を再計算', 'rebuildSummary')
    .addItem('④ 種目別一覧を再構築', 'rebuildEventList')
    .addSeparator()
    .addItem('⑤ 領収書 PDF を一括生成', 'generateReceipts')
    .addItem('⑥ トーナメント表シートを作成', 'buildBracketSheet')
    .addSeparator()
    .addItem('⑦ KTTA Platform 用 Excel を書出', 'exportForPlatform')
    .addSeparator()
    .addItem('設定を編集', 'openConfigDialog')
    .addToUi();
}

// ═══════════════════════════════════════════════
// 初期セットアップ
// ═══════════════════════════════════════════════
function setupAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.values(SHEETS).forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  initConfigSheet_(ss);
  initReceiveLogSheet_(ss);
  initRosterSheet_(ss);
  initTeamSheet_(ss);
  initDoublesSheet_(ss);
  initMixedSheet_(ss);
  initSinglesSheet_(ss);
  initExtrasSheet_(ss);
  initSeekingSheet_(ss);
  initSummarySheet_(ss);
  initEventListSheet_(ss);
  initBracketSheet_(ss);

  // 不要なデフォルトシート削除
  const sh = ss.getSheetByName('シート1');
  if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);

  SpreadsheetApp.getUi().alert('初期セットアップが完了しました。\n' +
    'KTTA メニューから「申込フォームの URL を表示」で公開URLを取得してください。');
}

function initConfigSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.CONFIG);
  sh.clear();
  sh.getRange('A1:B1').setValues([['◆ 大会設定 (このシートを編集後、再読込してください)', '']])
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  const rows = [
    ['協会名', prop('ASSOCIATION_NAME')],
    ['会長名', prop('PRESIDENT_NAME')],
    ['会場', prop('VENUE')],
    ['管理者メール', prop('ADMIN_EMAIL')],
    ['', ''],
    ['◆ 参加料 (円)', ''],
    ['団体戦 男子', priceProp('PRICE_TEAM_M')],
    ['団体戦 女子', priceProp('PRICE_TEAM_F')],
    ['ダブルス 男子', priceProp('PRICE_DBL_M')],
    ['ダブルス 女子', priceProp('PRICE_DBL_F')],
    ['混合ダブルス', priceProp('PRICE_MIX')],
    ['シングルス 男子', priceProp('PRICE_SGL_M')],
    ['シングルス 女子', priceProp('PRICE_SGL_F')],
    ['お弁当', priceProp('PRICE_BENTO')],
    ['懇親会', priceProp('PRICE_PARTY')],
  ];
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 300);
}

function initReceiveLogSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.RECEIVE_LOG);
  sh.clear();
  const headers = [
    '受付番号', '受付日時', '団体名', '申込責任者', 'メール', '電話',
    '種目', '氏名', 'ふりがな', '性別', '年齢区分', 'パートナー氏名',
    '弁当', '懇親会', 'ダブルス相手募集', '備考',
  ];
  sh.appendRow(headers);
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initRosterSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.ROSTER);
  sh.clear();
  sh.appendRow(['#', '団体名', '氏名', 'ふりがな', '性別', '年齢区分', '主な出場種目', 'メール']);
  sh.getRange(1, 1, 1, 8)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initTeamSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.TEAM);
  sh.clear();
  sh.appendRow([
    '#', '種目', 'チーム名', '所属団体',
    '選手1', '選手2', '選手3', '選手4', '選手5', '選手6',
  ]);
  sh.getRange(1, 1, 1, 10)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initDoublesSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.DOUBLES);
  sh.clear();
  sh.appendRow([
    '#', '種目', '選手1 氏名', '選手1 所属', '選手2 氏名', '選手2 所属', '受付番号',
  ]);
  sh.getRange(1, 1, 1, 7)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initMixedSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.MIXED);
  sh.clear();
  sh.appendRow([
    '#', '男子 氏名', '男子 所属', '女子 氏名', '女子 所属', '受付番号',
  ]);
  sh.getRange(1, 1, 1, 6)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initSinglesSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.SINGLES);
  sh.clear();
  sh.appendRow([
    '#', '種目', '氏名', '所属', 'ふりがな', '年齢区分', 'シード番号', '受付番号',
  ]);
  sh.getRange(1, 1, 1, 8)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initExtrasSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.EXTRAS);
  sh.clear();
  sh.appendRow(['#', '団体名', '氏名', '弁当', '懇親会', '備考', '受付番号']);
  sh.getRange(1, 1, 1, 7)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initSeekingSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.SEEKING);
  sh.clear();
  sh.appendRow(['#', '氏名', '所属', '性別', '種目', '連絡先', '受付番号']);
  sh.getRange(1, 1, 1, 7)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initSummarySheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.SUMMARY);
  sh.clear();
  sh.appendRow([
    '#', '団体名', '人数',
    '団体戦男', '団体戦女', 'ダブルス男', 'ダブルス女', 'ミックス',
    'シングルス男', 'シングルス女',
    '弁当数', '懇親会数', '参加料合計 (円)',
  ]);
  sh.getRange(1, 1, 1, 13)
    .setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
  sh.setFrozenRows(1);
}

function initEventListSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.EVENT_LIST);
  sh.clear();
  sh.appendRow(['◆ 種目別一覧 (再構築は KTTA メニュー → 「種目別一覧を再構築」)']);
  sh.getRange(1, 1).setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
}

function initBracketSheet_(ss) {
  const sh = ss.getSheetByName(SHEETS.BRACKET);
  sh.clear();
  sh.appendRow(['◆ トーナメント表 (生成は KTTA メニュー → 「トーナメント表シートを作成」)']);
  sh.getRange(1, 1).setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff');
}

// ═══════════════════════════════════════════════
// 申込フォーム (Web App としてデプロイ)
// ═══════════════════════════════════════════════
function doGet(e) {
  return HtmlService.createHtmlOutput(buildFormHtml_())
    .setTitle('大会申込フォーム — ' + prop('ASSOCIATION_NAME'))
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const result = receiveApplication(data);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, ...result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function buildFormHtml_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const events = DEFAULT_EVENTS;
  const webAppUrl = ScriptApp.getService().getUrl();
  return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>大会申込フォーム — ${prop('ASSOCIATION_NAME')}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', sans-serif;
  background: #f3f4f6; color: #111827; padding: 16px; }
.container { max-width: 720px; margin: 0 auto; background: #fff;
  border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); overflow: hidden; }
header { background: #1e293b; color: #fff; padding: 20px 24px; }
header h1 { font-size: 20px; margin-bottom: 4px; }
header .sub { font-size: 12px; opacity: 0.85; }
main { padding: 20px 24px; }
.section { margin: 20px 0; padding: 16px;
  border: 1px solid #e5e7eb; border-radius: 6px; }
.section h2 { font-size: 14px; margin-bottom: 12px;
  padding-bottom: 6px; border-bottom: 2px solid #1e293b; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 13px;
  font-weight: 600; margin-bottom: 4px; }
.field input, .field select, .field textarea {
  width: 100%; padding: 8px 10px; font-size: 14px;
  border: 1px solid #d1d5db; border-radius: 4px; }
.field input:focus, .field select:focus, .field textarea:focus {
  outline: none; border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); }
.ev-row { display: flex; gap: 8px; align-items: center;
  padding: 6px 8px; margin: 4px 0;
  background: #f9fafb; border-radius: 4px; }
.ev-row input[type=checkbox] { width: auto; }
.btn { width: 100%; padding: 12px; font-size: 15px;
  font-weight: 700; color: #fff; background: #2563eb;
  border: none; border-radius: 6px; cursor: pointer; }
.btn:hover { background: #1d4ed8; }
.btn:disabled { background: #9ca3af; cursor: not-allowed; }
.msg { padding: 12px; border-radius: 6px; margin-top: 12px;
  font-size: 14px; display: none; }
.msg.ok { background: #d1fae5; color: #064e3b; display: block; }
.msg.err { background: #fee2e2; color: #7f1d1d; display: block; }
@media (max-width: 480px) { .container { border-radius: 0; }
  header, main { padding: 14px 16px; } }
</style></head><body>
<div class="container">
<header>
<h1>${prop('ASSOCIATION_NAME')} 大会申込フォーム</h1>
<div class="sub">${prop('VENUE')}</div>
</header>
<main>
<form id="frm">
  <div class="section">
    <h2>団体情報</h2>
    <div class="field"><label>団体名 / 所属 *</label>
      <input name="team" required></div>
    <div class="field"><label>申込責任者 氏名 *</label>
      <input name="rep_name" required></div>
    <div class="field"><label>連絡先メール *</label>
      <input name="email" type="email" required></div>
    <div class="field"><label>連絡先電話</label>
      <input name="phone" type="tel"></div>
  </div>

  <div class="section">
    <h2>選手情報</h2>
    <div class="field"><label>氏名 *</label>
      <input name="player_name" required></div>
    <div class="field"><label>ふりがな</label>
      <input name="furigana"></div>
    <div class="field"><label>性別</label>
      <select name="gender">
        <option value="male">男子</option>
        <option value="female">女子</option>
      </select></div>
    <div class="field"><label>年齢区分</label>
      <select name="age_group">
        <option value="">指定なし</option>
        <option value="一般">一般</option>
        <option value="高校">高校</option>
        <option value="中学">中学</option>
        <option value="小学">小学</option>
        <option value="サーティ">サーティ (30代)</option>
        <option value="フォーティ">フォーティ (40代)</option>
        <option value="フィフティ">フィフティ (50代)</option>
        <option value="シックスティ">シックスティ (60代)</option>
        <option value="セブンティ">セブンティ (70代)</option>
        <option value="エイティ">エイティ (80代以上)</option>
      </select></div>
  </div>

  <div class="section">
    <h2>出場種目 (複数選択可)</h2>
    ${events.map(ev => `<div class="ev-row">
      <input type="checkbox" name="event_${ev}" id="ev_${ev.replace(/[^A-Za-z0-9一-龯ぁ-んァ-ヶー]/g, '_')}">
      <label for="ev_${ev.replace(/[^A-Za-z0-9一-龯ぁ-んァ-ヶー]/g, '_')}">${ev}</label>
    </div>`).join('')}
    <div class="field"><label>ダブルスのパートナー 氏名 (該当者のみ)</label>
      <input name="partner_name"></div>
  </div>

  <div class="section">
    <h2>その他</h2>
    <div class="field"><label>お弁当を注文する</label>
      <select name="bento">
        <option value="0">なし</option>
        <option value="1">1個</option>
        <option value="2">2個</option>
        <option value="3">3個</option>
      </select></div>
    <div class="field"><label>懇親会に参加する</label>
      <select name="party">
        <option value="0">なし</option>
        <option value="1">1名</option>
        <option value="2">2名</option>
      </select></div>
    <div class="field"><label>ダブルス相手募集 (パートナー未定の場合)</label>
      <select name="seeking">
        <option value="">不要</option>
        <option value="yes">募集する</option>
      </select></div>
    <div class="field"><label>備考 (連絡事項)</label>
      <textarea name="note" rows="3"></textarea></div>
  </div>

  <button type="submit" class="btn" id="sb">申込を送信</button>
  <div id="msg" class="msg"></div>
</form>
</main>
</div>
<script>
const events = ${JSON.stringify(events)};
document.getElementById('frm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('sb');
  const msg = document.getElementById('msg');
  btn.disabled = true; btn.textContent = '送信中…';
  const fd = new FormData(e.target);
  const data = {};
  fd.forEach((v, k) => { data[k] = v; });
  data.events = events.filter(ev => fd.get('event_' + ev));
  try {
    const r = await fetch('${webAppUrl}', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(data),
    });
    const json = await r.json();
    if (json.ok) {
      msg.className = 'msg ok';
      msg.textContent = '申込を受付ました (受付番号 #' + json.receipt_no + ')。' +
        '確認メールをご確認ください。';
      e.target.reset();
    } else {
      msg.className = 'msg err';
      msg.textContent = '送信失敗: ' + (json.error || '不明エラー');
    }
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = '通信エラー: ' + err.message;
  } finally {
    btn.disabled = false; btn.textContent = '申込を送信';
  }
});
</script>
</body></html>`;
}

function showFormUrl() {
  const url = ScriptApp.getService().getUrl();
  if (!url) {
    SpreadsheetApp.getUi().alert(
      'まず「デプロイ」→「新しいデプロイ」→ ウェブアプリ で公開してください。\n' +
      '・アクセスできるユーザー: 全員\n' +
      '・次のユーザーとして実行: 自分'
    );
    return;
  }
  SpreadsheetApp.getUi().alert(
    '申込フォーム URL:\n\n' + url + '\n\n' +
    'この URL を大会サイト/メール等で共有してください。'
  );
}

// ═══════════════════════════════════════════════
// 申込受信処理
// ═══════════════════════════════════════════════
function receiveApplication(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();
  // 受付番号 (UNIX 時間ベース)
  const receiptNo = Math.floor(now.getTime() / 1000) % 100000;

  // 各シートへ自動振分け
  const events = data.events || [];

  // 1) 申込台帳
  const logSh = ss.getSheetByName(SHEETS.RECEIVE_LOG);
  events.forEach(ev => {
    logSh.appendRow([
      receiptNo, now, data.team || '', data.rep_name || '',
      data.email || '', data.phone || '',
      ev, data.player_name || '', data.furigana || '',
      data.gender || '', data.age_group || '',
      data.partner_name || '',
      data.bento || 0, data.party || 0, data.seeking || '', data.note || '',
    ]);
  });

  // 2) 選手名簿 (重複しない選手リスト)
  const rosterSh = ss.getSheetByName(SHEETS.ROSTER);
  if (!rosterAlreadyExists_(rosterSh, data.team, data.player_name)) {
    const rosterCount = rosterSh.getLastRow();
    rosterSh.appendRow([
      rosterCount, data.team || '', data.player_name || '',
      data.furigana || '', data.gender || '', data.age_group || '',
      events.join(' / '), data.email || '',
    ]);
  }

  // 3) 各種目別シート
  events.forEach(ev => {
    if (/団体/.test(ev)) {
      const sh = ss.getSheetByName(SHEETS.TEAM);
      sh.appendRow([sh.getLastRow(), ev, data.team || '',
        data.team || '', data.player_name || '', '', '', '', '', '']);
    } else if (/混合|ミックス/.test(ev)) {
      const sh = ss.getSheetByName(SHEETS.MIXED);
      const isMale = data.gender === 'male';
      sh.appendRow([sh.getLastRow(),
        isMale ? (data.player_name || '') : (data.partner_name || ''),
        isMale ? (data.team || '') : '',
        !isMale ? (data.player_name || '') : (data.partner_name || ''),
        !isMale ? (data.team || '') : '',
        receiptNo,
      ]);
    } else if (/ダブルス|ペア/.test(ev)) {
      const sh = ss.getSheetByName(SHEETS.DOUBLES);
      sh.appendRow([sh.getLastRow(), ev,
        data.player_name || '', data.team || '',
        data.partner_name || '', data.team || '',
        receiptNo,
      ]);
    } else {
      const sh = ss.getSheetByName(SHEETS.SINGLES);
      sh.appendRow([sh.getLastRow(), ev,
        data.player_name || '', data.team || '',
        data.furigana || '', data.age_group || '', '', receiptNo]);
    }
  });

  // 4) お弁当・懇親会
  if (data.bento > 0 || data.party > 0) {
    const sh = ss.getSheetByName(SHEETS.EXTRAS);
    sh.appendRow([sh.getLastRow(), data.team || '', data.player_name || '',
      data.bento || 0, data.party || 0, data.note || '', receiptNo]);
  }

  // 5) ダブルス相手募集
  if (data.seeking === 'yes') {
    const sh = ss.getSheetByName(SHEETS.SEEKING);
    sh.appendRow([sh.getLastRow(), data.player_name || '', data.team || '',
      data.gender || '', events.join('/'),
      data.email || data.phone || '', receiptNo]);
  }

  // 6) 集計更新
  rebuildSummary();

  // 7) 確認メール
  if (data.email && prop('ADMIN_EMAIL')) {
    try {
      MailApp.sendEmail({
        to: data.email,
        bcc: prop('ADMIN_EMAIL'),
        subject: `[${prop('ASSOCIATION_NAME')}] 申込受付完了 (#${receiptNo})`,
        body: `${data.team || ''}\n${data.player_name || ''}様\n\n` +
          `申込を受付ました。\n受付番号: ${receiptNo}\n\n` +
          `出場種目:\n${events.map(e => '  ・' + e).join('\n')}\n\n` +
          `お問い合わせは ${prop('ADMIN_EMAIL')} まで。\n\n` +
          `${prop('ASSOCIATION_NAME')}\n${prop('PRESIDENT_NAME')}`,
      });
    } catch (err) {
      console.warn('メール送信失敗:', err);
    }
  }

  return { receipt_no: receiptNo, events: events.length };
}

function rosterAlreadyExists_(sh, team, name) {
  const last = sh.getLastRow();
  if (last < 2) return false;
  const data = sh.getRange(2, 2, last - 1, 2).getValues();
  return data.some(row => row[0] === team && row[1] === name);
}

// ═══════════════════════════════════════════════
// 団体別集計 再計算
// (まりもオープン集計表 準拠の美しいレイアウト)
//
//   レイアウト:
//     [大会日付] [大会名]
//     [No, 団体名, 団体(男/女), ダブルス(男/女), ミックス(男/女),
//      シングルス(男/女), お弁当, 懇親会, 合計]
//     [-, -, 男/女, 男/女, 男/女, 男/女, 数量, 数量, ¥]
//     [-, -, 単価, 単価, 単価, 単価, 単価, 単価, -]
//     [No1, 団体A, ...]
//     [No2, 団体B, ...]
//     ...
//     [合計]
// ═══════════════════════════════════════════════
function rebuildSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSh = ss.getSheetByName(SHEETS.RECEIVE_LOG);
  const sumSh = ss.getSheetByName(SHEETS.SUMMARY);

  // 申込台帳から団体別に集計
  const lastRow = logSh.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('申込台帳にデータがありません。');
    return;
  }
  const data = logSh.getRange(2, 1, lastRow - 1, 16).getValues();
  const byTeam = {};
  data.forEach(row => {
    const team = String(row[2] || '');
    const event = String(row[6] || '');
    const gender = String(row[9] || '');
    const bento = parseInt(row[12]) || 0;
    const party = parseInt(row[13]) || 0;
    if (!team) return;
    if (!byTeam[team]) {
      byTeam[team] = {
        names: new Set(),
        team_m: 0, team_f: 0,
        dbl_m: 0, dbl_f: 0,
        mix_m: 0, mix_f: 0,
        sgl_m: 0, sgl_f: 0,
        bento: 0, party: 0,
      };
    }
    const t = byTeam[team];
    t.names.add(String(row[7] || ''));
    if (/団体/.test(event)) {
      gender === 'female' ? t.team_f++ : t.team_m++;
    } else if (/混合|ミックス/.test(event)) {
      gender === 'female' ? t.mix_f++ : t.mix_m++;
    } else if (/ダブルス|ペア/.test(event)) {
      gender === 'female' ? t.dbl_f++ : t.dbl_m++;
    } else {
      gender === 'female' ? t.sgl_f++ : t.sgl_m++;
    }
    t.bento += bento;
    t.party += party;
  });

  // 価格
  const P = {
    team_m: priceProp('PRICE_TEAM_M'),
    team_f: priceProp('PRICE_TEAM_F'),
    dbl_m: priceProp('PRICE_DBL_M'),
    dbl_f: priceProp('PRICE_DBL_F'),
    mix_m: priceProp('PRICE_MIX'),
    mix_f: priceProp('PRICE_MIX'),
    sgl_m: priceProp('PRICE_SGL_M'),
    sgl_f: priceProp('PRICE_SGL_F'),
    bento: priceProp('PRICE_BENTO'),
    party: priceProp('PRICE_PARTY'),
  };

  // クリア + 再構築 (まりもオープン形式)
  sumSh.clear();
  sumSh.clearFormats();

  // 列ヘッダー定義
  // col 1=No, 2=団体名, 3-4=団体(男女), 5-6=ダブルス(男女),
  // 7-8=ミックス(男女), 9-10=シングルス(男女), 11=弁当, 12=懇親会, 13=合計
  const totalCols = 13;

  // ─── 行1: タイトル ───
  const today = Utilities.formatDate(new Date(), 'JST', 'yyyy年MM月dd日');
  sumSh.getRange(1, 1).setValue(today);
  sumSh.getRange(1, 1, 1, 2).merge().setFontSize(11).setFontColor('#475569')
    .setBackground('#f1f5f9');
  sumSh.getRange(1, 3).setValue('団体別 申込集計表 — ' + prop('ASSOCIATION_NAME'));
  sumSh.getRange(1, 3, 1, totalCols - 2).merge()
    .setFontSize(16).setFontWeight('bold')
    .setBackground('#1e293b').setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sumSh.setRowHeight(1, 36);

  // ─── 行2: 上段ヘッダー (大カテゴリ) ───
  sumSh.getRange(2, 1).setValue('No.');
  sumSh.getRange(2, 2).setValue('団体名');
  sumSh.getRange(2, 3).setValue('団体');
  sumSh.getRange(2, 3, 1, 2).merge();
  sumSh.getRange(2, 5).setValue('ダブルス');
  sumSh.getRange(2, 5, 1, 2).merge();
  sumSh.getRange(2, 7).setValue('ミックス');
  sumSh.getRange(2, 7, 1, 2).merge();
  sumSh.getRange(2, 9).setValue('シングルス');
  sumSh.getRange(2, 9, 1, 2).merge();
  sumSh.getRange(2, 11).setValue('お弁当');
  sumSh.getRange(2, 12).setValue('懇親会');
  sumSh.getRange(2, 13).setValue('合計');
  sumSh.getRange(2, 1, 1, totalCols)
    .setFontWeight('bold').setFontSize(11)
    .setBackground('#334155').setFontColor('#ffffff')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sumSh.setRowHeight(2, 30);

  // ─── 行3: 下段ヘッダー (男/女) ───
  sumSh.getRange(3, 3).setValue('男子');
  sumSh.getRange(3, 4).setValue('女子');
  sumSh.getRange(3, 5).setValue('男子');
  sumSh.getRange(3, 6).setValue('女子');
  sumSh.getRange(3, 7).setValue('男子');
  sumSh.getRange(3, 8).setValue('女子');
  sumSh.getRange(3, 9).setValue('男子');
  sumSh.getRange(3, 10).setValue('女子');
  sumSh.getRange(3, 1, 1, totalCols)
    .setBackground('#475569').setFontColor('#ffffff')
    .setFontSize(10).setFontWeight('bold')
    .setHorizontalAlignment('center');
  sumSh.setRowHeight(3, 22);
  // No 列と 団体名列を行2-3 で merge
  sumSh.getRange(2, 1, 2, 1).merge().setVerticalAlignment('middle');
  sumSh.getRange(2, 2, 2, 1).merge().setVerticalAlignment('middle');
  sumSh.getRange(2, 11, 2, 1).merge().setVerticalAlignment('middle');
  sumSh.getRange(2, 12, 2, 1).merge().setVerticalAlignment('middle');
  sumSh.getRange(2, 13, 2, 1).merge().setVerticalAlignment('middle');

  // ─── 行4: 単価 ───
  sumSh.getRange(4, 1).setValue('単価');
  sumSh.getRange(4, 1, 1, 2).merge().setHorizontalAlignment('center');
  sumSh.getRange(4, 3).setValue(P.team_m);
  sumSh.getRange(4, 4).setValue(P.team_f);
  sumSh.getRange(4, 5).setValue(P.dbl_m);
  sumSh.getRange(4, 6).setValue(P.dbl_f);
  sumSh.getRange(4, 7).setValue(P.mix_m);
  sumSh.getRange(4, 8).setValue(P.mix_f);
  sumSh.getRange(4, 9).setValue(P.sgl_m);
  sumSh.getRange(4, 10).setValue(P.sgl_f);
  sumSh.getRange(4, 11).setValue(P.bento);
  sumSh.getRange(4, 12).setValue(P.party);
  sumSh.getRange(4, 13).setValue('円').setHorizontalAlignment('center');
  sumSh.getRange(4, 1, 1, totalCols)
    .setBackground('#fef3c7').setFontColor('#92400e')
    .setFontStyle('italic').setFontSize(10)
    .setHorizontalAlignment('center');
  sumSh.getRange(4, 3, 1, 10).setNumberFormat('#,##0');
  sumSh.setRowHeight(4, 22);

  // ─── 行5+: 各団体の集計 ───
  const teamNames = Object.keys(byTeam).sort((a, b) => a.localeCompare(b, 'ja'));
  let grand = 0;
  const totals = {
    team_m: 0, team_f: 0, dbl_m: 0, dbl_f: 0,
    mix_m: 0, mix_f: 0, sgl_m: 0, sgl_f: 0,
    bento: 0, party: 0,
  };
  teamNames.forEach((name, idx) => {
    const t = byTeam[name];
    const row = 5 + idx;
    const fee = t.team_m * P.team_m + t.team_f * P.team_f +
                t.dbl_m * P.dbl_m + t.dbl_f * P.dbl_f +
                t.mix_m * P.mix_m + t.mix_f * P.mix_f +
                t.sgl_m * P.sgl_m + t.sgl_f * P.sgl_f +
                t.bento * P.bento + t.party * P.party;
    grand += fee;
    Object.keys(totals).forEach(k => { totals[k] += t[k] || 0; });

    sumSh.getRange(row, 1, 1, 13).setValues([[
      idx + 1, name,
      t.team_m, t.team_f,
      t.dbl_m, t.dbl_f,
      t.mix_m, t.mix_f,
      t.sgl_m, t.sgl_f,
      t.bento, t.party,
      fee,
    ]]);
    // ゼブラストライプ
    if (idx % 2 === 0) {
      sumSh.getRange(row, 1, 1, 13).setBackground('#f8fafc');
    } else {
      sumSh.getRange(row, 1, 1, 13).setBackground('#ffffff');
    }
    sumSh.getRange(row, 1).setHorizontalAlignment('center');
    sumSh.getRange(row, 2).setFontWeight('bold');
    sumSh.getRange(row, 3, 1, 10).setHorizontalAlignment('center');
    sumSh.getRange(row, 13).setNumberFormat('¥#,##0').setFontWeight('bold')
      .setHorizontalAlignment('right').setFontColor('#1d4ed8');
    // 0 のセルを薄く
    [3,4,5,6,7,8,9,10,11,12].forEach(c => {
      const cell = sumSh.getRange(row, c);
      if (cell.getValue() === 0) cell.setFontColor('#cbd5e1');
    });
  });

  // ─── 最終行: 合計 ───
  const totRow = 5 + teamNames.length;
  sumSh.getRange(totRow, 1).setValue('');
  sumSh.getRange(totRow, 2).setValue('総合計');
  sumSh.getRange(totRow, 3).setValue(totals.team_m);
  sumSh.getRange(totRow, 4).setValue(totals.team_f);
  sumSh.getRange(totRow, 5).setValue(totals.dbl_m);
  sumSh.getRange(totRow, 6).setValue(totals.dbl_f);
  sumSh.getRange(totRow, 7).setValue(totals.mix_m);
  sumSh.getRange(totRow, 8).setValue(totals.mix_f);
  sumSh.getRange(totRow, 9).setValue(totals.sgl_m);
  sumSh.getRange(totRow, 10).setValue(totals.sgl_f);
  sumSh.getRange(totRow, 11).setValue(totals.bento);
  sumSh.getRange(totRow, 12).setValue(totals.party);
  sumSh.getRange(totRow, 13).setValue(grand);
  sumSh.getRange(totRow, 1, 1, 13)
    .setBackground('#1e293b').setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(12);
  sumSh.getRange(totRow, 3, 1, 10).setHorizontalAlignment('center');
  sumSh.getRange(totRow, 13).setNumberFormat('¥#,##0').setFontSize(14)
    .setHorizontalAlignment('right');
  sumSh.setRowHeight(totRow, 32);

  // ─── 罫線 ───
  const range = sumSh.getRange(2, 1, totRow - 1, 13);
  range.setBorder(true, true, true, true, true, true,
    '#94a3b8', SpreadsheetApp.BorderStyle.SOLID);
  // 太枠 (外周)
  sumSh.getRange(2, 1, totRow - 1, 13)
    .setBorder(true, true, true, true, null, null,
      '#1e293b', SpreadsheetApp.BorderStyle.SOLID_THICK);
  // ヘッダー下太線
  sumSh.getRange(4, 1, 1, 13)
    .setBorder(null, null, true, null, null, null,
      '#1e293b', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  // 合計行 上太線
  sumSh.getRange(totRow, 1, 1, 13)
    .setBorder(true, null, null, null, null, null,
      '#1e293b', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // ─── 列幅 ───
  sumSh.setColumnWidth(1, 50);   // No
  sumSh.setColumnWidth(2, 180);  // 団体名
  for (let c = 3; c <= 10; c++) sumSh.setColumnWidth(c, 65);  // カウント列
  sumSh.setColumnWidth(11, 70);  // 弁当
  sumSh.setColumnWidth(12, 70);  // 懇親会
  sumSh.setColumnWidth(13, 110); // 合計

  // ─── 固定行 ───
  sumSh.setFrozenRows(4);
  sumSh.setFrozenColumns(2);

  // ─── 集計サマリーボード (上部の右寄り) ───
  // 注意: ここは行 1-4 の外 (列 15以降) に表示
  const dashCol = 15;
  sumSh.getRange(1, dashCol).setValue('◆ ハイライト');
  sumSh.getRange(1, dashCol, 1, 3).merge()
    .setBackground('#0f172a').setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(12)
    .setHorizontalAlignment('center');
  const cards = [
    ['団体数', teamNames.length, '#3b82f6'],
    ['選手数', Object.values(byTeam).reduce((a, t) => a + t.names.size, 0), '#10b981'],
    ['総合計', grand, '#dc2626'],
  ];
  cards.forEach((c, i) => {
    const r = 2 + i;
    sumSh.getRange(r, dashCol).setValue(c[0]);
    sumSh.getRange(r, dashCol, 1, 2).merge();
    sumSh.getRange(r, dashCol + 2).setValue(c[1]);
    sumSh.getRange(r, dashCol, 1, 3)
      .setBackground('#ffffff').setBorder(true, true, true, true, null, null,
      '#cbd5e1', SpreadsheetApp.BorderStyle.SOLID);
    sumSh.getRange(r, dashCol).setFontWeight('bold').setHorizontalAlignment('left')
      .setFontColor(c[2]).setFontSize(11);
    sumSh.getRange(r, dashCol + 2)
      .setHorizontalAlignment('right').setFontWeight('bold')
      .setFontSize(13).setFontColor(c[2]);
    if (c[0] === '総合計') {
      sumSh.getRange(r, dashCol + 2).setNumberFormat('¥#,##0');
    } else {
      sumSh.getRange(r, dashCol + 2).setNumberFormat('#,##0');
    }
    sumSh.setRowHeight(r, 30);
  });
  sumSh.setColumnWidth(dashCol, 80);
  sumSh.setColumnWidth(dashCol + 1, 30);
  sumSh.setColumnWidth(dashCol + 2, 100);

  SpreadsheetApp.getUi().alert(
    '団体別集計を更新しました。\n\n' +
    '団体数: ' + teamNames.length + '\n' +
    '選手数: ' + Object.values(byTeam).reduce((a, t) => a + t.names.size, 0) + '\n' +
    '総合計: ¥' + grand.toLocaleString());
}

// ═══════════════════════════════════════════════
// 種目別一覧 再構築
// ═══════════════════════════════════════════════
function rebuildEventList() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSh = ss.getSheetByName(SHEETS.RECEIVE_LOG);
  const evSh = ss.getSheetByName(SHEETS.EVENT_LIST);

  const lastRow = logSh.getLastRow();
  if (lastRow < 2) return;
  const data = logSh.getRange(2, 1, lastRow - 1, 16).getValues();
  const byEvent = {};
  data.forEach(row => {
    const ev = String(row[6] || '');
    if (!byEvent[ev]) byEvent[ev] = [];
    byEvent[ev].push({
      name: String(row[7] || ''),
      team: String(row[2] || ''),
      furigana: String(row[8] || ''),
      gender: String(row[9] || ''),
      age: String(row[10] || ''),
      partner: String(row[11] || ''),
    });
  });

  evSh.clear();
  let row = 1;
  Object.keys(byEvent).sort().forEach(ev => {
    const list = byEvent[ev];
    // セクション見出し
    evSh.getRange(row, 1).setValue('◆ ' + ev + ' (' + list.length + '名)');
    evSh.getRange(row, 1).setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff')
      .setFontSize(13);
    evSh.getRange(row, 1, 1, 7).merge();
    row++;
    // ヘッダー
    evSh.getRange(row, 1, 1, 7).setValues([['#', '氏名', '所属', 'ふりがな', '性別', '年齢区分', 'パートナー']])
      .setFontWeight('bold').setBackground('#cbd5e1');
    row++;
    // 各選手
    list.forEach((p, i) => {
      evSh.getRange(row, 1, 1, 7).setValues([[i + 1, p.name, p.team, p.furigana, p.gender, p.age, p.partner]]);
      row++;
    });
    row++; // 空行
  });
  evSh.setColumnWidth(1, 30);
  evSh.setColumnWidth(2, 120);
  evSh.setColumnWidth(3, 150);
  evSh.setColumnWidth(4, 120);
  evSh.setColumnWidth(5, 60);
  evSh.setColumnWidth(6, 90);
  evSh.setColumnWidth(7, 120);

  SpreadsheetApp.getUi().alert(
    '種目別一覧を再構築しました。\n種目数: ' + Object.keys(byEvent).length);
}

// ═══════════════════════════════════════════════
// 領収書 PDF 一括生成
// ═══════════════════════════════════════════════
function generateReceipts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sumSh = ss.getSheetByName(SHEETS.SUMMARY);
  const lastRow = sumSh.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('集計データがありません。先に「団体別集計を再計算」を実行してください。');
    return;
  }
  const data = sumSh.getRange(2, 1, lastRow - 1, 13).getValues();

  // Google ドキュメントを新規作成 (領収書 PDF まとめ)
  const docName = '領収書_' + Utilities.formatDate(new Date(), 'JST', 'yyyyMMdd_HHmm');
  const doc = DocumentApp.create(docName);
  const body = doc.getBody();
  const today = Utilities.formatDate(new Date(), 'JST', 'yyyy年MM月dd日');

  data.forEach((row, idx) => {
    const team = String(row[1] || '');
    const fee = parseInt(row[12]) || 0;
    if (!team || team.startsWith('◆') || !fee) return;

    if (idx > 0) body.appendPageBreak();
    body.appendParagraph('領収書').setHeading(DocumentApp.ParagraphHeading.HEADING1)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    body.appendParagraph('');
    body.appendParagraph(team + ' 様').setFontSize(14).setBold(true);
    body.appendParagraph('');
    body.appendParagraph('金額:  ¥' + fee.toLocaleString() + ' 円也')
      .setFontSize(20).setBold(true)
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    body.appendParagraph('');
    body.appendParagraph('但し、大会参加料として上記正に領収いたしました。')
      .setFontSize(11);
    body.appendParagraph('');
    body.appendParagraph(today).setFontSize(10);
    body.appendParagraph('');
    body.appendParagraph(prop('ASSOCIATION_NAME')).setFontSize(12);
    body.appendParagraph(prop('PRESIDENT_NAME')).setFontSize(12);
  });
  doc.saveAndClose();

  // PDF として保存
  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getAs('application/pdf').setName(docName + '.pdf');
  const pdfFile = DriveApp.createFile(pdfBlob);
  const pdfUrl = pdfFile.getUrl();

  SpreadsheetApp.getUi().alert(
    '領収書 PDF を生成しました。\n\n' +
    'Google Doc: ' + doc.getUrl() + '\n' +
    'PDF: ' + pdfUrl);
}

// ═══════════════════════════════════════════════
// トーナメント表シート 自動レイアウト
// ═══════════════════════════════════════════════
function buildBracketSheet() {
  const ui = SpreadsheetApp.getUi();
  const evResp = ui.prompt('トーナメント表を作成する種目名を入力してください\n(例: 男子シングルス)',
    ui.ButtonSet.OK_CANCEL);
  if (evResp.getSelectedButton() !== ui.Button.OK) return;
  const eventName = evResp.getResponseText().trim();
  if (!eventName) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // シングルス or ダブルス
  const isDoubles = /ダブルス|ペア|混合|ミックス/.test(eventName);
  const isTeam = /団体|チーム/.test(eventName);
  let entries = [];

  if (isTeam) {
    const sh = ss.getSheetByName(SHEETS.TEAM);
    const last = sh.getLastRow();
    if (last > 1) {
      const data = sh.getRange(2, 1, last - 1, 10).getValues();
      data.filter(r => r[1] === eventName).forEach(r => {
        entries.push({ name: r[2], team: r[3] });
      });
    }
  } else if (isDoubles) {
    if (/混合|ミックス/.test(eventName)) {
      const sh = ss.getSheetByName(SHEETS.MIXED);
      const last = sh.getLastRow();
      if (last > 1) {
        const data = sh.getRange(2, 1, last - 1, 6).getValues();
        data.forEach(r => {
          entries.push({ name: r[1] + ' / ' + r[3], team: r[2] || r[4] });
        });
      }
    } else {
      const sh = ss.getSheetByName(SHEETS.DOUBLES);
      const last = sh.getLastRow();
      if (last > 1) {
        const data = sh.getRange(2, 1, last - 1, 7).getValues();
        data.filter(r => r[1] === eventName).forEach(r => {
          entries.push({ name: r[2] + ' / ' + r[4], team: r[3] });
        });
      }
    }
  } else {
    const sh = ss.getSheetByName(SHEETS.SINGLES);
    const last = sh.getLastRow();
    if (last > 1) {
      const data = sh.getRange(2, 1, last - 1, 8).getValues();
      data.filter(r => r[1] === eventName).forEach(r => {
        entries.push({ name: r[2], team: r[3] });
      });
    }
  }

  if (!entries.length) {
    ui.alert('「' + eventName + '」のエントリーが見つかりません。');
    return;
  }

  // ブラケットサイズを 2 のべき乗で確定
  const N = entries.length;
  const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(N, 2))));
  const totalRounds = Math.log2(bracketSize);
  const byeCount = bracketSize - N;

  // シード配置 (標準) — 1 vs N, 2 vs N-1, 3 vs N/2+1 ...
  // 簡易: 提供順 = seed 順とみなして bracket_pos を割り当て
  const positions = standardBracketPositions(bracketSize);
  const slots = new Array(bracketSize).fill(null);
  positions.forEach((seed, i) => {
    if (seed <= N) slots[i] = entries[seed - 1];
  });

  // トーナメント表シートに描画 (両側レイアウト)
  const sh = ss.getSheetByName(SHEETS.BRACKET);
  sh.clear();
  sh.appendRow(['◆ ' + eventName + ' (Bracket ' + bracketSize + ', BYE ' + byeCount + ')']);
  sh.getRange(1, 1).setFontWeight('bold').setBackground('#1e293b').setFontColor('#fff').setFontSize(13);
  sh.getRange(1, 1, 1, totalRounds * 2 + 1).merge();

  // 1回戦の対戦表 (シンプルテーブル形式)
  sh.appendRow([]);
  sh.appendRow(['試合#', '選手1', '所属1', '選手2', '所属2']);
  sh.getRange(3, 1, 1, 5).setFontWeight('bold').setBackground('#cbd5e1');
  for (let i = 0; i < bracketSize; i += 2) {
    const matchNo = i / 2 + 1;
    const p1 = slots[i];
    const p2 = slots[i + 1];
    sh.appendRow([
      '1-' + matchNo,
      p1 ? p1.name : '(BYE)',
      p1 ? p1.team : '',
      p2 ? p2.name : '(BYE)',
      p2 ? p2.team : '',
    ]);
  }
  // 後半ラウンドのプレースホルダー
  sh.appendRow([]);
  sh.appendRow(['◆ 後半ラウンド (勝者が進出)']);
  sh.getRange(sh.getLastRow(), 1).setFontWeight('bold').setBackground('#fef3c7');
  for (let r = 2; r <= totalRounds; r++) {
    const matchesInRound = bracketSize / Math.pow(2, r);
    const roundName = r === totalRounds ? '決勝'
                   : r === totalRounds - 1 ? '準決勝'
                   : r === totalRounds - 2 ? '準々決勝'
                   : r + '回戦';
    sh.appendRow([roundName, matchesInRound + ' 試合']);
  }
  // 列幅
  sh.setColumnWidth(1, 80);
  sh.setColumnWidth(2, 140);
  sh.setColumnWidth(3, 140);
  sh.setColumnWidth(4, 140);
  sh.setColumnWidth(5, 140);

  ui.alert(
    'トーナメント表を作成しました。\n' +
    eventName + ' / ' + N + '名 / Bracket ' + bracketSize +
    ' (BYE ' + byeCount + ')');
}

// 標準シード位置 (1 → 1, 2 → bracketSize, 3 → bracketSize-3+2 ...)
function standardBracketPositions(size) {
  // 再帰的に「左半分の上 → 右半分の下 → 左半分の下 → 右半分の上」
  function gen(n, hi) {
    if (n === 1) return [1];
    const half = gen(n / 2, hi);
    const out = [];
    for (const s of half) {
      out.push(s, hi + 1 - s);
    }
    return out;
  }
  return gen(size, size);
}

// ═══════════════════════════════════════════════
// KTTA Platform 用 Excel エクスポート
// (フォーマット: tools/build_bracket_template.js と同じ)
// ═══════════════════════════════════════════════
function exportForPlatform() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    '「トーナメント表」シートを KTTA Platform 取込テンプレ形式で\n' +
    '別ファイルとして書き出します。\n\n' +
    '※ 先に「トーナメント表シートを作成」を実行してください。\n\n' +
    '別ファイル化: ファイルメニュー → ダウンロード → Microsoft Excel (.xlsx) を選択し、\n' +
    'KTTA Platform の「Excel/PDF 取込」からアップロードしてください。'
  );
}

// ═══════════════════════════════════════════════
// テスト申込投入
// ═══════════════════════════════════════════════
function insertTestEntry() {
  receiveApplication({
    team: 'テスト団体A',
    rep_name: '山田 太郎',
    email: 'test@example.com',
    phone: '0154-00-0000',
    player_name: '山田 太郎',
    furigana: 'やまだ たろう',
    gender: 'male',
    age_group: '一般',
    events: ['男子シングルス', '男子ダブルス'],
    partner_name: '鈴木 次郎',
    bento: 1,
    party: 0,
    seeking: '',
    note: 'テスト投入',
  });
  SpreadsheetApp.getUi().alert('テスト申込を投入しました。');
}

// ═══════════════════════════════════════════════
// 設定ダイアログ
// ═══════════════════════════════════════════════
function openConfigDialog() {
  const html = `<!DOCTYPE html><html><body>
<h3>スクリプトプロパティの編集</h3>
<p>変更したい設定値の隣に値を入力して「保存」を押してください。</p>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><th>キー</th><th>現在値</th><th>新しい値</th></tr>
${Object.keys(DEFAULTS).map(k => `<tr>
  <td>${k}</td><td>${prop(k)}</td>
  <td><input id="v_${k}" placeholder="変更しない"></td>
</tr>`).join('')}
</table>
<button onclick="save()">保存</button>
<script>
function save() {
  const out = {};
  ${Object.keys(DEFAULTS).map(k =>
    `if (document.getElementById('v_${k}').value) out['${k}'] = document.getElementById('v_${k}').value;`
  ).join('\n')}
  google.script.run.withSuccessHandler(() => {
    alert('保存しました。再読込してください。');
    google.script.host.close();
  }).saveProps_(out);
}
</script></body></html>`;
  SpreadsheetApp.getUi().showModalDialog(
    HtmlService.createHtmlOutput(html).setWidth(640).setHeight(560),
    'KTTA 設定');
}

function saveProps_(obj) {
  Object.keys(obj).forEach(k => {
    PROPS.setProperty(k, String(obj[k]));
  });
}
