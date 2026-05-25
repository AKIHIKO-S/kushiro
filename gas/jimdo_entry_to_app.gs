/**
 * Jimdo / Google Forms / その他フォームからの申込を
 * 種目別の参加者名簿に整形し、最終的に卓球大会運営アプリへ取込ます。
 *
 * 利用想定:
 *   1. Jimdo サイトに Google フォーム埋込 → 申込
 *   2. 回答が Google スプレッドシートに溜まる
 *   3. このスクリプトを設定して、スプレッドシート開閉時 or 定期実行で:
 *      a. 種目別名簿シートを生成 (集計表・選手名簿・団体・ダブルス・ミックス)
 *      b. アプリの API に POST して entrants として取込
 *      c. 領収書・集計表は アプリの管理画面からワンクリック出力
 *
 * 設定:
 *   - スクリプトプロパティ: APP_BASE_URL, ADMIN_KEY, TOURNAMENT_ID
 */

const APP_BASE_URL = "https://tabletennis.example.com";  // ホスティングしたアプリのURL
const SHEET_NAMES = {
  RESPONSES: "フォームの回答 1",
  ROSTER:    "選手名簿",
  AGG:       "集計用",
  TEAM:      "団体",
  DOUBLES:   "ダブルス",
  MIXED:     "ミックス",
  RECEIPTS:  "差し込み用シート",
};

const FEES = {
  team_male:    1000, team_female:    1000,
  doubles_male: 1000, doubles_female: 1000,
  mixed_male:   1000, mixed_female:   1000,
  singles_male:  700, singles_female:  700,
  bento: 800, party: 3500,
};

// メニュー追加 (スプレッドシートを開いた時)
function onOpen() {
  SpreadsheetApp.getUi().createMenu("卓球大会")
    .addItem("名簿を再生成", "regenerateRosters")
    .addItem("アプリに取込 (entrants 登録)", "pushToApp")
    .addItem("集計表(まりも形式)を生成", "generateAggregation")
    .addToUi();
}

// ─── 名簿シート再生成 (フォーム回答 → 種目別シート) ───
function regenerateRosters() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const resp = ss.getSheetByName(SHEET_NAMES.RESPONSES);
  if (!resp) {
    SpreadsheetApp.getUi().alert("回答シートが見つかりません: " + SHEET_NAMES.RESPONSES);
    return;
  }
  const data = resp.getDataRange().getValues();
  if (data.length < 2) return;
  const header = data[0];
  // 想定列: タイムスタンプ, 申込団体, 申込責任者, 氏名, ふりがな, 性別, 年齢, 種目1, 種目2, ...
  const idx = {
    timestamp:   header.indexOf("タイムスタンプ"),
    team:        header.findIndex(h => /団体|所属/.test(h)),
    contact:     header.findIndex(h => /責任者|代表者/.test(h)),
    name:        header.findIndex(h => /^氏名|^選手名/.test(h)),
    furigana:    header.findIndex(h => /ふりがな|フリガナ|読み/.test(h)),
    gender:      header.findIndex(h => /性別|男女/.test(h)),
    age:         header.findIndex(h => /年齢|生年/.test(h)),
    events:      []  // 種目フラグ列を全部取る
  };
  header.forEach((h, i) => {
    if (/(団体|ダブルス|シングルス|混合|ミックス)/.test(h)) idx.events.push({ col: i, label: h });
  });

  // 出席者リスト構築
  const teamRoster = []; // 団体戦
  const dblRoster = [];  // ダブルス (連続2人で1ペア相当)
  const mxRoster = [];   // 混合
  const sglRoster = [];  // シングルス

  data.slice(1).forEach(row => {
    const player = {
      team: row[idx.team] || "",
      contact: row[idx.contact] || "",
      name: row[idx.name] || "",
      furigana: row[idx.furigana] || "",
      gender: /女/.test(row[idx.gender]) ? "female" : "male",
      age: row[idx.age] || "",
    };
    idx.events.forEach(e => {
      const val = String(row[e.col] || "").trim();
      if (!val || val === "なし" || val === "no") return;
      const label = e.label;
      const item = { ...player, event: label };
      if (/団体/.test(label)) teamRoster.push(item);
      else if (/混合|ミックス/.test(label)) mxRoster.push(item);
      else if (/ダブルス/.test(label)) dblRoster.push(item);
      else sglRoster.push(item);
    });
  });

  // シート書き出し
  writeRosterSheet_(ss, SHEET_NAMES.TEAM, teamRoster);
  writeRosterSheet_(ss, SHEET_NAMES.DOUBLES, dblRoster);
  writeRosterSheet_(ss, SHEET_NAMES.MIXED, mxRoster);
  if (sglRoster.length) writeRosterSheet_(ss, "シングルス", sglRoster);

  SpreadsheetApp.getActiveSpreadsheet().toast("名簿シートを再生成しました");
}

function writeRosterSheet_(ss, name, items) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  if (!items.length) {
    sh.getRange(1, 1).setValue("(該当なし)");
    return;
  }
  sh.getRange(1, 1, 1, 5).setValues([["区分", "氏名", "年齢", "チーム名", "種目"]]);
  items.forEach((it, i) => {
    const cat = (it.gender === "female" ? "女子" : "男子");
    sh.getRange(i + 2, 1, 1, 5).setValues([[cat, it.name, it.age, it.team, it.event]]);
  });
}

// ─── アプリへ entrants として送信 ───
function pushToApp() {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = props.getProperty("APP_BASE_URL") || APP_BASE_URL;
  const adminKey = props.getProperty("ADMIN_KEY") || "";
  const tournamentId = props.getProperty("TOURNAMENT_ID");
  if (!tournamentId) {
    SpreadsheetApp.getUi().alert("TOURNAMENT_ID をスクリプトプロパティに設定してください");
    return;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const buildPlayers = (sheetName, eventLabel, isDoubles) => {
    const sh = ss.getSheetByName(sheetName);
    if (!sh) return [];
    const rows = sh.getDataRange().getValues().slice(1);
    return rows.filter(r => r[1])  // 氏名
      .map(r => ({
        name: String(r[1]),
        team: String(r[3] || ""),
        gender: /女/.test(r[0]) ? "female" : "male",
        event: r[4] || eventLabel,
        is_doubles: isDoubles,
      }));
  };
  const allPlayers = [
    ...buildPlayers(SHEET_NAMES.TEAM, "団体戦", false),
    ...buildPlayers(SHEET_NAMES.DOUBLES, "ダブルス", true),
    ...buildPlayers(SHEET_NAMES.MIXED, "混合ダブルス", true),
    ...buildPlayers("シングルス", "シングルス", false),
  ];
  // event 別にまとめる
  const byEvent = {};
  allPlayers.forEach(p => { (byEvent[p.event] = byEvent[p.event] || []).push(p); });

  const payload = {
    format: "tabletennis-tournament-v1",
    tournament: { id: tournamentId },
    regenerate: true,
    auto_link_to_players: true,
    brackets: Object.entries(byEvent).map(([ev, players]) => ({
      format: "tabletennis-seed-list-v1",
      event: ev,
      players,
    })),
  };

  const resp = UrlFetchApp.fetch(`${baseUrl}/api/tournaments/${tournamentId}/bracket/import`, {
    method: "post",
    contentType: "application/json",
    headers: { "X-Admin-Key": adminKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    code === 200 ? "アプリに取込成功" : `失敗 (${code}): ${text.slice(0, 100)}`
  );
}

// ─── 集計表生成 (まりも形式) ───
function generateAggregation() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAMES.AGG);
  if (!sh) sh = ss.insertSheet(SHEET_NAMES.AGG);
  sh.clear();
  const ts = new Date().toLocaleDateString("ja-JP");
  sh.getRange(1, 1, 1, 3).setValues([[null, ts, ss.getName()]]);

  // 団体ごと集計
  const buildAgg = (sheetName, kind) => {
    const sh = ss.getSheetByName(sheetName);
    if (!sh) return {};
    const counts = {};
    sh.getDataRange().getValues().slice(1).forEach(r => {
      const team = r[3] || "";
      const g = /女/.test(r[0]) ? "female" : "male";
      if (!team) return;
      if (!counts[team]) counts[team] = {};
      const key = `${kind}_${g}`;
      counts[team][key] = (counts[team][key] || 0) + 1;
    });
    return counts;
  };
  const team_data = buildAgg(SHEET_NAMES.TEAM, "team");
  const dbl_data = buildAgg(SHEET_NAMES.DOUBLES, "doubles");
  const mx_data = buildAgg(SHEET_NAMES.MIXED, "mixed");

  const allTeams = new Set([
    ...Object.keys(team_data), ...Object.keys(dbl_data), ...Object.keys(mx_data)
  ]);

  // ヘッダー
  sh.getRange(3, 1, 1, 11).setValues([["No.", "団体名", "団体", null, "ダブルス", null,
    "ミックス", null, "お弁当", "懇親会", "合計"]]);
  sh.getRange(4, 3, 1, 6).setValues([["男子", "女子", "男子", "女子", "男子", "女子"]]);
  sh.getRange(5, 3, 1, 8).setValues([[FEES.team_male, FEES.team_female,
    FEES.doubles_male, FEES.doubles_female, FEES.mixed_male, FEES.mixed_female,
    FEES.bento, FEES.party]]);

  let row = 6;
  let idx = 1;
  Array.from(allTeams).sort().forEach(team => {
    const t = team_data[team] || {};
    const d = dbl_data[team] || {};
    const m = mx_data[team] || {};
    const sum =
      (t.team_male || 0) * FEES.team_male + (t.team_female || 0) * FEES.team_female +
      (d.doubles_male || 0) * FEES.doubles_male + (d.doubles_female || 0) * FEES.doubles_female +
      (m.mixed_male || 0) * FEES.mixed_male + (m.mixed_female || 0) * FEES.mixed_female;
    sh.getRange(row, 1, 1, 11).setValues([[idx++, team,
      t.team_male || 0, t.team_female || 0,
      d.doubles_male || 0, d.doubles_female || 0,
      m.mixed_male || 0, m.mixed_female || 0,
      0, 0, sum]]);
    row++;
  });
  SpreadsheetApp.getActiveSpreadsheet().toast("集計表を生成しました");
}
