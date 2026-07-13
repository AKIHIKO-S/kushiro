/**
 * 大会申込フォーム 受信ハンドラ (Google Apps Script)
 * KTTA Platform - まりもオープン集計表 準拠 自動仕訳版
 *
 * 受信したフォームデータを以下の7シートに自動振分け:
 *   1. 申込台帳        - 全申込履歴 (1申込 = 1行)
 *   2. 選手名簿        - 団体別の出場選手一覧 (横並びレイアウト)
 *   3. 団体            - 団体戦エントリー (区分・氏名・年齢・チーム名)
 *   4. ダブルス        - ダブルスペア (区分・氏名1・年齢・氏名2・年齢・チーム1・2)
 *   5. ミックス        - 混合ダブルス (性別・氏名・年齢・チーム名)
 *   6. お弁当、懇親会  - 弁当/懇親会 参加者
 *   7. ダブルス相手募集者 - ペア探しのリクエスト
 *   8. 集計用          - 自動再計算 (団体ごと種目別人数+合計金額)
 *
 * セットアップ:
 *   ① Google スプレッドシートを新規作成
 *   ② 拡張機能 → Apps Script を開く
 *   ③ このスクリプトを貼り付け
 *   ④ プロジェクト設定 → スクリプトプロパティ:
 *        ADMIN_EMAIL = 主催者メールアドレス (任意)
 *        ASSOCIATION_NAME = 釧路卓球協会
 *        PRICE_TEAM_M / PRICE_TEAM_F / PRICE_DBL_M / PRICE_DBL_F /
 *        PRICE_MIX_M / PRICE_MIX_F / PRICE_BENTO / PRICE_PARTY
 *        (デフォルト: 1000 / 1000 / 1000 / 1000 / 500 / 500 / 800 / 3500)
 *   ⑤ デプロイ → 新しいデプロイ → ウェブアプリ
 *        - アクセス: 全員 / 実行ユーザー: 自分
 *   ⑥ デプロイ URL を KTTA Platform の申込フォーム設定に登録
 */

const SHEETS = {
  LEDGER:    "申込台帳",
  ROSTER:    "選手名簿",
  TEAM:      "団体",
  DOUBLES:   "ダブルス",
  MIXED:     "ミックス",
  SINGLES:   "シングルス",
  BENTO:     "お弁当、懇親会",
  PARTNER:   "ダブルス相手募集者",
  AGGREGATE: "集計用",
  RECEIPTS:  "領収書一覧",
  RECEIPT_MANUAL: "領収書(個別発行)",
};

const SINGLES_HEADERS = ["種目", "区分", "氏名", "年齢", "チーム名"];

const LEDGER_HEADERS = [
  "受付日時", "大会名", "団体名", "申込責任者", "電話番号", "メールアドレス",
  "引率顧問", "コーチ", "申込種目数", "参加人数(述べ)", "合計金額",
  "備考", "tournament_id",
];

const TEAM_HEADERS = ["種目", "区分", "氏名", "年齢", "チーム名"];
const DOUBLES_HEADERS = ["種目", "区分", "氏名1", "年齢", "氏名2", "年齢", "チーム名1", "チーム名2"];
const MIXED_HEADERS = ["種目", "性別", "氏名", "年齢", "チーム名"];
const PARTNER_HEADERS = ["申込チーム", "区分", "氏名1", "年齢", "備考"];

// 集計用シートの料金 (スクリプトプロパティで上書き可)
function getPrices() {
  const p = PropertiesService.getScriptProperties();
  const num = (k, def) => parseInt(p.getProperty(k)) || def;
  return {
    team_m:  num("PRICE_TEAM_M", 1000),
    team_f:  num("PRICE_TEAM_F", 1000),
    dbl_m:   num("PRICE_DBL_M",  1000),
    dbl_f:   num("PRICE_DBL_F",  1000),
    mix_m:   num("PRICE_MIX_M",   500),
    mix_f:   num("PRICE_MIX_F",   500),
    bento:   num("PRICE_BENTO",   800),
    party:   num("PRICE_PARTY",  3500),
  };
}

// ════════════════════════════════════════════
// 区分・種目タイプ 判定ヘルパー
// ════════════════════════════════════════════

// イベント名から「区分」を抽出: "一般男子 団体戦" → "一般男子"
function deriveDivision(eventName) {
  if (!eventName) return "";
  const s = String(eventName);
  // パターン: "{一般|高校|中学|小学|シニア|壮年|...}{男子|女子}" + 空白 + 種目
  const m = s.match(/(一般|高校|中学|小学|シニア|壮年|ジュニア|オープン)(男子|女子)/);
  if (m) return m[1] + m[2];
  // 単に「男子」「女子」を含むなら抽出
  if (/男子/.test(s)) return "一般男子";
  if (/女子/.test(s)) return "一般女子";
  return "一般";
}

// 区分が男子か女子かを判定
function divGender(division) {
  if (!division) return "";
  if (/男/.test(division)) return "male";
  if (/女/.test(division)) return "female";
  return "";
}

// イベント名+typeから種目タイプを判定 (team/doubles/mixed/singles/bento/party/partner)
function classifyEntry(entry) {
  const ev = entry.event || "";
  const t = entry.type || "";
  if (/相手募集|ペア募集/.test(ev)) return "partner";
  if (/弁当|べんとう|ベントウ/.test(ev)) return "bento";
  if (/懇親|パーティ/.test(ev)) return "party";
  if (t === "team" || /団体|チーム/.test(ev)) return "team";
  if (/混合|ミックス|mixed/i.test(ev)) return "mixed";
  if (t === "doubles" || /ダブルス|doubles/i.test(ev)) return "doubles";
  if (t === "custom") return "custom";
  return "singles";
}

// ════════════════════════════════════════════
// シート取得・初期化
// ════════════════════════════════════════════

function getOrCreateSheet(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers && headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
      sh.getRange(1, 1, 1, headers.length).setBackground("#f1f5f9");
    }
  }
  return sh;
}

function ensureAllSheets(ss) {
  getOrCreateSheet(ss, SHEETS.LEDGER, LEDGER_HEADERS);
  getOrCreateSheet(ss, SHEETS.TEAM, TEAM_HEADERS);
  getOrCreateSheet(ss, SHEETS.DOUBLES, DOUBLES_HEADERS);
  getOrCreateSheet(ss, SHEETS.MIXED, MIXED_HEADERS);
  getOrCreateSheet(ss, SHEETS.SINGLES, SINGLES_HEADERS);
  getOrCreateSheet(ss, SHEETS.PARTNER, PARTNER_HEADERS);
  // 弁当・懇親会は2列構造 (お弁当 | 懇親会)
  const sb = ss.getSheetByName(SHEETS.BENTO);
  if (!sb) {
    const sh = ss.insertSheet(SHEETS.BENTO);
    sh.getRange(1, 1).setValue("お弁当");
    sh.getRange(1, 4).setValue("懇親会");
    sh.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#f1f5f9");
    sh.setFrozenRows(1);
  }
}

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
    } catch (parseErr) {
      return _json({ ok: false, error: "JSON 解析失敗" });
    }

    // バリデーション
    const required = ["tournament_name", "team_name", "contact_name", "contact_tel", "contact_email"];
    for (const k of required) {
      if (!data[k] || !String(data[k]).trim()) {
        return _json({ ok: false, error: "必須項目が未入力: " + k });
      }
    }
    if (!Array.isArray(data.entries) || data.entries.length === 0) {
      return _json({ ok: false, error: "出場選手が登録されていません" });
    }

    // 冪等: 同じ op_id を二重処理しない(ブラウザの二度押しや Node からの再送で
    // シートに重複行が出るのを防ぐ。Node 側 DB の op_id 冪等と揃える)。
    // CacheService を使う(TTL自動失効=無限増殖しない)。記録は「追記が全て成功した後」に行う
    // (途中失敗で op_id だけ確定し、再送が握り潰されて行が永久欠落するのを防ぐ)。
    const opId = String(data.op_id || "").trim();
    const _cache = CacheService.getScriptCache();
    if (opId && _cache.get("opid_" + opId)) {
      return _json({ ok: true, duplicate: true, message: "処理済みの申込です(再送)" });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureAllSheets(ss);

    // ─── 1. 申込台帳 (履歴) ───
    const ledgerSh = ss.getSheetByName(SHEETS.LEDGER);
    const ts = new Date();
    const totalEntries = data.entries.length;
    const totalPeople = data.entries.reduce((s, en) => {
      if (en.type === "team") return s + (en.members || []).length;
      if (en.type === "doubles" || en.type === "mixed") return s + 2;
      return s + 1;
    }, 0);
    const ledgerRow = [
      ts, data.tournament_name, data.team_name, data.contact_name,
      data.contact_tel, data.contact_email,
      data.supervisor || "", data.coach || "",
      totalEntries, totalPeople, data.total_amount || 0,
      data.note || "", data.tournament_id || "",
    ];
    ledgerSh.appendRow(ledgerRow);
    const ledgerRowNum = ledgerSh.getLastRow();

    // ─── 2. 各シートに振り分け ───
    distributeEntries(ss, data);

    // ─── 3. ダブルス相手募集 ───
    if (Array.isArray(data.partner_search)) {
      const sh = ss.getSheetByName(SHEETS.PARTNER);
      data.partner_search.forEach(ps => {
        if (!ps.name) return;
        sh.appendRow([
          data.team_name,
          ps.division || ps.category || "",
          ps.name,
          ps.age || "",
          ps.note || "",
        ]);
      });
    }

    // ─── 4. 集計用 再計算 ───
    rebuildAggregate(ss, data.tournament_name);

    // ─── 5. 選手名簿 (横並びレイアウト) ───
    appendToRoster(ss, data);

    // ─── 6. 種目別 選手リスト 自動再生成 ───
    try { generateEventLists(); }
    catch (evErr) { console.error("種目別リスト生成失敗:", evErr); }

    // ─── 7. 自動返信メール ───
    try { _sendReplyMail(data, ledgerRowNum); }
    catch (mailErr) { console.error("自動返信メール失敗:", mailErr); }
    try { _sendAdminNotification(data, ledgerRowNum); }
    catch (notifyErr) { console.error("主催者通知失敗:", notifyErr); }

    // 追記が全て成功した後にだけ op_id を記録(6時間保持=再送はこの窓内・自動失効で増殖なし)。
    if (opId) _cache.put("opid_" + opId, "1", 21600);
    return _json({ ok: true, ledger_row: ledgerRowNum });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ════════════════════════════════════════════
// 振分けロジック
// ════════════════════════════════════════════

function distributeEntries(ss, data) {
  const teamSh = ss.getSheetByName(SHEETS.TEAM);
  const dblSh = ss.getSheetByName(SHEETS.DOUBLES);
  const mixSh = ss.getSheetByName(SHEETS.MIXED);
  const sglSh = ss.getSheetByName(SHEETS.SINGLES);
  const bentoSh = ss.getSheetByName(SHEETS.BENTO);

  data.entries.forEach(en => {
    const kind = classifyEntry(en);
    const division = deriveDivision(en.event);
    const teamName = data.team_name || "";

    if (kind === "team") {
      // 団体: 各メンバーを 1 行ずつ
      const members = en.members_detail || [];
      // members_detail がない場合は members (文字列配列) からも対応
      const fallback = (en.members || []).map(name => ({ name }));
      const list = members.length ? members : fallback;
      list.forEach(m => {
        if (!m.name) return;
        teamSh.appendRow([
          en.event || "",
          division || "一般",
          m.name,
          m.age || "",
          m.team || teamName,
        ]);
      });
    } else if (kind === "doubles") {
      // ダブルス: 1 ペア = 1 行
      dblSh.appendRow([
        en.event || "",
        division,
        en.name1 || "",
        en.age1 || "",
        en.name2 || "",
        en.age2 || "",
        en.team1 || en.team || teamName,
        en.team2 || en.team || teamName,
      ]);
    } else if (kind === "mixed") {
      // ミックス: ペアの 2 名をそれぞれ別行に展開
      if (en.name1) {
        mixSh.appendRow([en.event || "", "男子", en.name1, en.age1 || "", en.team1 || en.team || teamName]);
      }
      if (en.name2) {
        mixSh.appendRow([en.event || "", "女子", en.name2, en.age2 || "", en.team2 || en.team || teamName]);
      }
    } else if (kind === "singles") {
      // シングルス: 専用シートに記録
      if (en.name) {
        sglSh.appendRow([
          en.event || "",
          division,
          en.name,
          en.age || "",
          en.team || teamName,
        ]);
      }
    } else if (kind === "bento") {
      // 弁当: 個数 = en.count、または 1
      const count = parseInt(en.count) || 1;
      const name = en.name || data.contact_name || "";
      const startRow = Math.max(2, bentoSh.getLastRow() + 1);
      for (let i = 0; i < count; i++) {
        bentoSh.getRange(startRow + i, 1).setValue(name);
      }
    } else if (kind === "party") {
      // 懇親会: 同上、列4
      const count = parseInt(en.count) || 1;
      const name = en.name || data.contact_name || "";
      // 懇親会列の現状最終行を取得
      const colVals = bentoSh.getRange(1, 4, Math.max(bentoSh.getLastRow(), 1), 1).getValues();
      let nextRow = 2;
      for (let i = colVals.length - 1; i >= 1; i--) {
        if (colVals[i][0]) { nextRow = i + 2; break; }
      }
      for (let i = 0; i < count; i++) {
        bentoSh.getRange(nextRow + i, 4).setValue(name);
      }
    } else if (kind === "custom") {
      // 自由記入 → 申込台帳 (備考扱い、別シートには出さない)
    }
  });

  // 弁当/懇親会フィールドが data 直下にある場合の対応
  if (data.bento_count) {
    const c = parseInt(data.bento_count) || 0;
    if (c > 0) {
      const startRow = Math.max(2, bentoSh.getLastRow() + 1);
      for (let i = 0; i < c; i++) {
        bentoSh.getRange(startRow + i, 1).setValue(data.team_name + " 弁当 #" + (i+1));
      }
    }
  }
  if (data.party_count) {
    const c = parseInt(data.party_count) || 0;
    if (c > 0) {
      const colVals = bentoSh.getRange(1, 4, Math.max(bentoSh.getLastRow(), 1), 1).getValues();
      let nextRow = 2;
      for (let i = colVals.length - 1; i >= 1; i--) {
        if (colVals[i][0]) { nextRow = i + 2; break; }
      }
      for (let i = 0; i < c; i++) {
        bentoSh.getRange(nextRow + i, 4).setValue(data.team_name + " 懇親会 #" + (i+1));
      }
    }
  }
}

// ════════════════════════════════════════════
// 集計用シート 再計算
// ════════════════════════════════════════════

function rebuildAggregate(ss, tournamentName) {
  let sh = ss.getSheetByName(SHEETS.AGGREGATE);
  if (!sh) sh = ss.insertSheet(SHEETS.AGGREGATE);
  sh.clear();
  const prices = getPrices();

  // ヘッダー部
  sh.getRange("B1").setValue(new Date()).setNumberFormat("yyyy-MM-dd");
  sh.getRange("C1").setValue(tournamentName || "");
  sh.getRange("C1").setFontWeight("bold").setFontSize(14);

  // 行3: メイン列名
  sh.getRange(3, 1).setValue("No,");
  sh.getRange(3, 2).setValue("団体名");
  sh.getRange(3, 3).setValue("団体");
  sh.getRange(3, 5).setValue("ダブルス");
  sh.getRange(3, 7).setValue("ミックス");
  sh.getRange(3, 9).setValue("お弁当");
  sh.getRange(3, 10).setValue("懇親会");
  sh.getRange(3, 13).setValue("合計");
  // 列11/12: 申込人数+延べ人数は データ書込時に追加

  // 行4: 男女サブ列名
  sh.getRange(4, 3).setValue("男子");
  sh.getRange(4, 4).setValue("女子");
  sh.getRange(4, 5).setValue("男子");
  sh.getRange(4, 6).setValue("女子");
  sh.getRange(4, 7).setValue("男子");
  sh.getRange(4, 8).setValue("女子");

  // 行5: 単価
  sh.getRange(5, 3).setValue(prices.team_m);
  sh.getRange(5, 4).setValue(prices.team_f);
  sh.getRange(5, 5).setValue(prices.dbl_m);
  sh.getRange(5, 6).setValue(prices.dbl_f);
  sh.getRange(5, 7).setValue(prices.mix_m);
  sh.getRange(5, 8).setValue(prices.mix_f);
  sh.getRange(5, 9).setValue(prices.bento);
  sh.getRange(5, 10).setValue(prices.party);

  // スタイル
  sh.getRange(3, 1, 3, 11).setFontWeight("bold");
  sh.getRange(3, 1, 1, 11).setBackground("#e0e7ff");
  sh.getRange(4, 1, 1, 11).setBackground("#eef1f7");
  sh.getRange(5, 1, 1, 11).setBackground("#fef3c7");

  // ─── 各シートからカウント ───
  const counts = {}; // teamName -> { team_m, team_f, dbl_m, dbl_f, mix_m, mix_f, bento, party }
  const ensure = (tn) => {
    if (!counts[tn]) counts[tn] = {
      team_m: 0, team_f: 0, dbl_m: 0, dbl_f: 0,
      mix_m: 0, mix_f: 0, bento: 0, party: 0
    };
    return counts[tn];
  };

  // 団体シート: [種目, 区分, 氏名, 年齢, チーム名]
  const teamSh = ss.getSheetByName(SHEETS.TEAM);
  if (teamSh && teamSh.getLastRow() >= 2) {
    const rows = teamSh.getRange(2, 1, teamSh.getLastRow() - 1, 5).getValues();
    rows.forEach(r => {
      const div = String(r[1] || "");
      const tn = String(r[4] || "").trim();
      if (!tn) return;
      const c = ensure(tn);
      if (/男/.test(div)) c.team_m++;
      else if (/女/.test(div)) c.team_f++;
    });
  }

  // ダブルスシート: [種目, 区分, 氏名1, 年齢, 氏名2, 年齢, チーム1, チーム2]
  const dblSh = ss.getSheetByName(SHEETS.DOUBLES);
  if (dblSh && dblSh.getLastRow() >= 2) {
    const rows = dblSh.getRange(2, 1, dblSh.getLastRow() - 1, 8).getValues();
    rows.forEach(r => {
      const div = String(r[1] || "");
      const tn1 = String(r[6] || "").trim();
      const tn2 = String(r[7] || "").trim();
      const teams = [tn1, tn2].filter(Boolean);
      const uniq = Array.from(new Set(teams));
      uniq.forEach(tn => {
        const c = ensure(tn);
        if (/男/.test(div)) c.dbl_m++;
        else if (/女/.test(div)) c.dbl_f++;
      });
    });
  }

  // ミックスシート: [種目, 性別, 氏名, 年齢, チーム名]
  const mixSh = ss.getSheetByName(SHEETS.MIXED);
  if (mixSh && mixSh.getLastRow() >= 2) {
    const rows = mixSh.getRange(2, 1, mixSh.getLastRow() - 1, 5).getValues();
    rows.forEach(r => {
      const gender = String(r[1] || "");
      const tn = String(r[4] || "").trim();
      if (!tn) return;
      const c = ensure(tn);
      if (/男/.test(gender)) c.mix_m++;
      else if (/女/.test(gender)) c.mix_f++;
    });
  }

  // お弁当・懇親会: 名前から所属チーム判定は難しいので、ヘッダ "{チーム名} 弁当 #N" パターンで紐付け
  // 単純な実装: 弁当・懇親会の各行から「チーム名+space+弁当」パターンを探す
  // 簡易版: チーム別カウントせず、全体カウントとして team 不明扱い
  const bentoSh = ss.getSheetByName(SHEETS.BENTO);
  if (bentoSh && bentoSh.getLastRow() >= 2) {
    // 弁当列 (col 1)
    const bentoVals = bentoSh.getRange(2, 1, Math.max(bentoSh.getLastRow() - 1, 1), 1).getValues();
    bentoVals.forEach(r => {
      const v = String(r[0] || "");
      if (!v) return;
      // パターン "{teamname} 弁当 #N" 抽出
      const m = v.match(/^(.+?)\s*弁当/);
      if (m) {
        ensure(m[1].trim()).bento++;
      } else {
        // 個別名: 名前と所属チームの紐付けは出来ないので、不明扱い
        ensure("(不明)").bento++;
      }
    });
    // 懇親会列 (col 4)
    const partyVals = bentoSh.getRange(2, 4, Math.max(bentoSh.getLastRow() - 1, 1), 1).getValues();
    partyVals.forEach(r => {
      const v = String(r[0] || "");
      if (!v) return;
      const m = v.match(/^(.+?)\s*懇親会/);
      if (m) {
        ensure(m[1].trim()).party++;
      } else {
        ensure("(不明)").party++;
      }
    });
  }

  // 各団体の「実人数」を計算 (団体・ダブルス・ミックス・シングルスから重複排除して count)
  const peopleByTeam = {};  // teamName -> Set of unique person keys
  const pushPerson = (tn, name) => {
    if (!tn || !name) return;
    if (!peopleByTeam[tn]) peopleByTeam[tn] = new Set();
    peopleByTeam[tn].add(name);
  };
  // 団体
  if (teamSh && teamSh.getLastRow() >= 2) {
    teamSh.getRange(2, 1, teamSh.getLastRow() - 1, 5).getValues().forEach(r => {
      pushPerson(String(r[4] || "").trim(), String(r[2] || "").trim());
    });
  }
  // ダブルス (1ペア = 2人)
  if (dblSh && dblSh.getLastRow() >= 2) {
    dblSh.getRange(2, 1, dblSh.getLastRow() - 1, 8).getValues().forEach(r => {
      pushPerson(String(r[6] || "").trim(), String(r[2] || "").trim());
      pushPerson(String(r[7] || "").trim(), String(r[4] || "").trim());
    });
  }
  // ミックス
  if (mixSh && mixSh.getLastRow() >= 2) {
    mixSh.getRange(2, 1, mixSh.getLastRow() - 1, 5).getValues().forEach(r => {
      pushPerson(String(r[4] || "").trim(), String(r[2] || "").trim());
    });
  }
  // シングルス
  const sglSh2 = ss.getSheetByName(SHEETS.SINGLES);
  if (sglSh2 && sglSh2.getLastRow() >= 2) {
    sglSh2.getRange(2, 1, sglSh2.getLastRow() - 1, 5).getValues().forEach(r => {
      pushPerson(String(r[4] || "").trim(), String(r[2] || "").trim());
    });
  }

  // データ行を書き出し (チーム名アルファベット順) - 13列に拡張 (申込人数+述べ人数)
  // 列構成: No, 団体名, 団体男, 団体女, ダブルス男, ダブルス女, ミックス男, ミックス女,
  //         お弁当, 懇親会, 申込人数(実), 述べ人数, 参加料合計
  // → 既存 11 列を上書きして 13 列に拡張
  // ヘッダー行を更新
  sh.getRange(3, 11).setValue("申込人数");
  sh.getRange(3, 12).setValue("延べ人数");
  sh.getRange(3, 13).setValue("参加料合計");
  sh.getRange(4, 11).setValue("(実数)");
  sh.getRange(4, 12).setValue("(述べ)");
  sh.getRange(3, 1, 1, 13).setBackground("#e0e7ff").setFontWeight("bold");
  sh.getRange(4, 1, 1, 13).setBackground("#eef1f7").setFontWeight("bold");
  sh.getRange(5, 1, 1, 13).setBackground("#fef3c7").setFontWeight("bold");

  const teamNames = Object.keys(counts).sort((a, b) => a.localeCompare(b, "ja"));
  let totalsBy = { team_m: 0, team_f: 0, dbl_m: 0, dbl_f: 0, mix_m: 0, mix_f: 0,
                   bento: 0, party: 0, people: 0, nobe: 0, sum: 0 };
  teamNames.forEach((tn, i) => {
    const c = counts[tn];
    const total =
      c.team_m * prices.team_m + c.team_f * prices.team_f +
      c.dbl_m * prices.dbl_m + c.dbl_f * prices.dbl_f +
      c.mix_m * prices.mix_m + c.mix_f * prices.mix_f +
      c.bento * prices.bento + c.party * prices.party;
    const actualPeople = peopleByTeam[tn] ? peopleByTeam[tn].size : 0;
    // 述べ人数 = 団体男+団体女 + ダブルス(男+女)*2 + ミックス男+ミックス女
    const nobePeople =
      c.team_m + c.team_f +
      c.dbl_m * 2 + c.dbl_f * 2 +
      c.mix_m + c.mix_f;
    const row = 6 + i;
    sh.getRange(row, 1, 1, 13).setValues([[
      i + 1, tn, c.team_m, c.team_f, c.dbl_m, c.dbl_f, c.mix_m, c.mix_f,
      c.bento, c.party, actualPeople, nobePeople, total
    ]]);
    totalsBy.team_m += c.team_m; totalsBy.team_f += c.team_f;
    totalsBy.dbl_m += c.dbl_m; totalsBy.dbl_f += c.dbl_f;
    totalsBy.mix_m += c.mix_m; totalsBy.mix_f += c.mix_f;
    totalsBy.bento += c.bento; totalsBy.party += c.party;
    totalsBy.people += actualPeople;
    totalsBy.nobe += nobePeople;
    totalsBy.sum += total;
  });

  // 合計行
  const totalRow = 6 + teamNames.length;
  sh.getRange(totalRow, 1).setValue("").setBackground("#dbeafe");
  sh.getRange(totalRow, 2).setValue("総計").setFontWeight("bold").setBackground("#dbeafe");
  sh.getRange(totalRow, 3, 1, 11).setValues([[
    totalsBy.team_m, totalsBy.team_f, totalsBy.dbl_m, totalsBy.dbl_f,
    totalsBy.mix_m, totalsBy.mix_f, totalsBy.bento, totalsBy.party,
    totalsBy.people, totalsBy.nobe, totalsBy.sum
  ]]).setFontWeight("bold").setBackground("#dbeafe");

  // ── 上部に サマリー カード ──
  // C1セル隣に大きな数字でサマリー表示
  const summaryRow = totalRow + 2;
  sh.getRange(summaryRow, 1, 1, 4).merge()
    .setValue("【全体サマリー】")
    .setFontWeight("bold").setFontSize(14)
    .setBackground("#1e2a4a").setFontColor("#fff");
  sh.getRange(summaryRow + 1, 1).setValue("申込団体数:");
  sh.getRange(summaryRow + 1, 2).setValue(teamNames.length + " 団体").setFontWeight("bold").setFontSize(14);
  sh.getRange(summaryRow + 2, 1).setValue("申込人数 (実):");
  sh.getRange(summaryRow + 2, 2).setValue(totalsBy.people + " 名").setFontWeight("bold").setFontSize(14);
  sh.getRange(summaryRow + 3, 1).setValue("延べ人数:");
  sh.getRange(summaryRow + 3, 2).setValue(totalsBy.nobe + " 名").setFontWeight("bold").setFontSize(14);
  sh.getRange(summaryRow + 4, 1).setValue("参加料 合計:");
  sh.getRange(summaryRow + 4, 2).setValue("¥" + totalsBy.sum.toLocaleString("ja-JP"))
    .setFontWeight("bold").setFontSize(18).setFontColor("#b91c1c");

  // 列幅 調整
  sh.setColumnWidth(1, 40);
  sh.setColumnWidth(2, 170);
  for (let c = 3; c <= 13; c++) sh.setColumnWidth(c, 80);
  sh.getRange(6, 3, teamNames.length + 1, 11).setNumberFormat("#,##0");
  sh.getRange(6, 13, teamNames.length + 1, 1).setNumberFormat("¥#,##0");
}

// ════════════════════════════════════════════
// 選手名簿 (横並び レイアウト)
// ════════════════════════════════════════════

function appendToRoster(ss, data) {
  let sh = ss.getSheetByName(SHEETS.ROSTER);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.ROSTER);
    _initRosterHeader(sh);
  }
  // ヘッダー無ければ初期化
  if (sh.getLastRow() < 2) _initRosterHeader(sh);

  // この申込の各種目を分類
  const teamMembers = [];     // {division, name, age, team}
  const doublesEntries = [];  // {division, name1, age1, name2, age2, team1, team2}
  const mixedMembers = [];    // {name, age, team}
  const bentoNames = [];
  const partyNames = [];

  data.entries.forEach(en => {
    const kind = classifyEntry(en);
    const division = deriveDivision(en.event);
    const tn = data.team_name || "";
    if (kind === "team") {
      const list = en.members_detail || (en.members || []).map(name => ({ name }));
      list.forEach(m => {
        if (!m.name) return;
        teamMembers.push({
          division: division || "一般",
          name: m.name, age: m.age || "",
          team: m.team || tn,
        });
      });
    } else if (kind === "doubles") {
      doublesEntries.push({
        division,
        name1: en.name1 || "", age1: en.age1 || "",
        name2: en.name2 || "", age2: en.age2 || "",
        team1: en.team1 || en.team || tn,
        team2: en.team2 || en.team || tn,
      });
    } else if (kind === "mixed") {
      if (en.name1) mixedMembers.push({ name: en.name1, age: en.age1 || "", team: en.team1 || en.team || tn });
      if (en.name2) mixedMembers.push({ name: en.name2, age: en.age2 || "", team: en.team2 || en.team || tn });
    } else if (kind === "bento") {
      const c = parseInt(en.count) || 1;
      for (let i = 0; i < c; i++) bentoNames.push(en.name || data.contact_name);
    } else if (kind === "party") {
      const c = parseInt(en.count) || 1;
      for (let i = 0; i < c; i++) partyNames.push(en.name || data.contact_name);
    }
  });

  // この団体のセクション行数 = 各リストの最大長
  const lines = Math.max(
    1,
    teamMembers.length, doublesEntries.length,
    mixedMembers.length, bentoNames.length, partyNames.length
  );

  const startRow = sh.getLastRow() + 1;
  const prices = getPrices();
  const counts = {
    team_m: teamMembers.filter(m => /男/.test(m.division)).length,
    team_f: teamMembers.filter(m => /女/.test(m.division)).length,
    dbl_m: doublesEntries.filter(d => /男/.test(d.division)).length,
    dbl_f: doublesEntries.filter(d => /女/.test(d.division)).length,
    mix_m: 0, // ミックスは性別が混合なので集計列は概算
    mix_f: 0,
  };
  // ミックスは name1=男子, name2=女子 と仮定
  data.entries.forEach(en => {
    if (classifyEntry(en) === "mixed") {
      if (en.name1) counts.mix_m++;
      if (en.name2) counts.mix_f++;
    }
  });

  // 各行を組み立て (31列)
  for (let i = 0; i < lines; i++) {
    const row = new Array(31).fill("");
    if (i === 0) {
      row[0]  = data.team_name;      // 申請団体
      row[1]  = data.contact_name;   // 申込責任者
    }
    // 団体 (列 4-7)
    if (teamMembers[i]) {
      row[3] = teamMembers[i].division;
      row[4] = teamMembers[i].name;
      row[5] = teamMembers[i].age;
      row[6] = teamMembers[i].team;
    }
    // ダブルス (列 9-15)
    if (doublesEntries[i]) {
      row[8]  = doublesEntries[i].division;
      row[9]  = doublesEntries[i].name1;
      row[10] = doublesEntries[i].age1;
      row[11] = doublesEntries[i].name2;
      row[12] = doublesEntries[i].age2;
      row[13] = doublesEntries[i].team1;
      row[14] = doublesEntries[i].team2;
    }
    // ミックス (列 17-19)
    if (mixedMembers[i]) {
      row[16] = mixedMembers[i].name;
      row[17] = mixedMembers[i].age;
      row[18] = mixedMembers[i].team;
    }
    // お弁当 (列 21) / 懇親会 (列 22)
    if (bentoNames[i]) row[20] = bentoNames[i];
    if (partyNames[i]) row[21] = partyNames[i];
    // 集計 (1行目のみ書く)
    if (i === 0) {
      row[23] = counts.team_m;
      row[24] = counts.team_f;
      row[25] = counts.dbl_m;
      row[26] = counts.dbl_f;
      row[27] = counts.mix_m;
      row[28] = counts.mix_f;
      row[29] = bentoNames.length;
      row[30] = partyNames.length;
    }
    sh.getRange(startRow + i, 1, 1, 31).setValues([row]);
  }

  // この申込セクション末尾に空行
  // (次の申込が始まる位置 = getLastRow + 1)
}

function _initRosterHeader(sh) {
  // 1行目: グループ ヘッダー
  sh.getRange(1, 4).setValue("団体");
  sh.getRange(1, 9).setValue("ダブルス");
  sh.getRange(1, 17).setValue("ミックス");
  sh.getRange(1, 24).setValue("集計");
  sh.getRange(1, 1, 1, 31).setFontWeight("bold").setBackground("#1e2a4a").setFontColor("#fff");

  // 2行目: 列名
  sh.getRange(2, 1).setValue("申請団体");
  sh.getRange(2, 2).setValue("申込責任者");
  sh.getRange(2, 4).setValue("区分");
  sh.getRange(2, 5).setValue("氏名");
  sh.getRange(2, 6).setValue("年齢");
  sh.getRange(2, 7).setValue("チーム名");
  sh.getRange(2, 9).setValue("区分");
  sh.getRange(2, 10).setValue("氏名1");
  sh.getRange(2, 11).setValue("年齢");
  sh.getRange(2, 12).setValue("氏名2");
  sh.getRange(2, 13).setValue("年齢");
  sh.getRange(2, 14).setValue("チーム名1");
  sh.getRange(2, 15).setValue("チーム名2");
  sh.getRange(2, 17).setValue("氏名");
  sh.getRange(2, 18).setValue("年齢");
  sh.getRange(2, 19).setValue("チーム名");
  sh.getRange(2, 21).setValue("お弁当");
  sh.getRange(2, 22).setValue("懇親会");
  sh.getRange(2, 24).setValue("団体(男)");
  sh.getRange(2, 25).setValue("団体(女)");
  sh.getRange(2, 26).setValue("ダブルス(男)");
  sh.getRange(2, 27).setValue("ダブルス(女)");
  sh.getRange(2, 28).setValue("ミックス(男)");
  sh.getRange(2, 29).setValue("ミックス(女)");
  sh.getRange(2, 30).setValue("お弁当");
  sh.getRange(2, 31).setValue("懇親会");
  sh.getRange(2, 1, 1, 31).setFontWeight("bold").setBackground("#eef1f7");

  sh.setFrozenRows(2);
  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 110);
  for (let c = 3; c <= 31; c++) sh.setColumnWidth(c, 80);
}

// ════════════════════════════════════════════
// メール
// ════════════════════════════════════════════

function _sendReplyMail(data, ledgerRow) {
  const props = PropertiesService.getScriptProperties();
  const assoc = props.getProperty("ASSOCIATION_NAME") || "釧路卓球協会";
  const subject = "【" + data.tournament_name + "】 お申込みを受け付けました";

  const ts = new Date().toLocaleString("ja-JP");
  let breakdown = "";
  const eventGroups = {};
  for (const en of data.entries) {
    const ev = en.event || "未分類";
    if (!eventGroups[ev]) eventGroups[ev] = [];
    let label;
    if (en.type === "team") {
      label = "[団体] " + (en.team_name || "") + ": " +
        ((en.members || []).join(", "));
    } else if (en.type === "doubles" || en.type === "mixed") {
      label = "[" + (en.type === "mixed" ? "ミックス" : "ダブルス") + "] " +
        (en.name1 || "") + " / " + (en.name2 || "") + " (" + (en.team || "") + ")";
    } else if (en.type === "custom") {
      label = "[自由記入] " + (en.name || "") + " (" + (en.team || "") + ")";
    } else {
      label = "[シングルス] " + (en.name || "") + " (" + (en.team || "") + ")";
    }
    eventGroups[ev].push("  ・" + label + "  ¥" + (en.fee || 0).toLocaleString("ja-JP"));
  }
  for (const ev in eventGroups) {
    breakdown += "\n《" + ev + "》\n" + eventGroups[ev].join("\n") + "\n";
  }

  const body =
    data.contact_name + " 様\n\n" +
    "このたびは " + data.tournament_name + " へのお申込みありがとうございます。\n" +
    "以下の内容でお申込みを受け付けました。\n\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "■ 受付日時:  " + ts + "\n" +
    "■ 受付番号:  #" + String(ledgerRow).padStart(4, "0") + "\n\n" +
    "■ 大会名:    " + data.tournament_name + "\n" +
    "■ 団体名:    " + data.team_name + "\n" +
    "■ 申込責任者: " + data.contact_name + "\n" +
    "■ 連絡先:    " + data.contact_tel + "\n" +
    "■ メール:    " + data.contact_email + "\n" +
    (data.supervisor ? "■ 引率顧問:  " + data.supervisor + "\n" : "") +
    (data.coach ? "■ コーチ:    " + data.coach + "\n" : "") +
    "━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "【お申込み内容】" + breakdown + "\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "■ 合計金額: ¥" + (data.total_amount || 0).toLocaleString("ja-JP") + "\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    (data.note ? "【備考】\n" + data.note + "\n\n" : "") +
    "参加料は、大会当日の受付でお支払いください。\n\n" +
    "ご不明な点がございましたら、本メールへご返信ください。\n\n" +
    assoc + "\n";

  GmailApp.sendEmail(data.contact_email, subject, body, { name: assoc });
}

function _sendAdminNotification(data, ledgerRow) {
  const props = PropertiesService.getScriptProperties();
  const adminEmail = props.getProperty("ADMIN_EMAIL");
  if (!adminEmail) return;
  const subject = "【新規申込】" + data.tournament_name + " / " + data.team_name;
  const totalPeople = data.entries.reduce((s, en) => {
    if (en.type === "team") return s + (en.members || []).length;
    if (en.type === "doubles" || en.type === "mixed") return s + 2;
    return s + 1;
  }, 0);
  const body = "新規申込が届きました。\n\n" +
    "受付番号: #" + String(ledgerRow).padStart(4, "0") + "\n" +
    "団体名:   " + data.team_name + "\n" +
    "責任者:   " + data.contact_name + "\n" +
    "連絡先:   " + data.contact_tel + " / " + data.contact_email + "\n" +
    "申込種目: " + data.entries.length + " 件 (述べ " + totalPeople + " 名)\n" +
    "合計金額: ¥" + (data.total_amount || 0).toLocaleString("ja-JP") + "\n\n" +
    "スプレッドシート:\n" + SpreadsheetApp.getActiveSpreadsheet().getUrl() + "\n";
  GmailApp.sendEmail(adminEmail, subject, body);
}

// ════════════════════════════════════════════
// CORS / レスポンス
// ════════════════════════════════════════════

function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || "";
  if (action === "stats") {
    return _json(_buildStats(params.tournament_id || ""));
  }
  if (action === "list") {
    return _json(_buildList(params.tournament_id || ""));
  }
  if (action === "rebuild") {
    // 集計用シート手動再計算 (デバッグ用)
    try {
      rebuildAggregate(SpreadsheetApp.getActiveSpreadsheet(), params.tournament_name || "");
      return _json({ ok: true, message: "集計用シートを再計算しました" });
    } catch (err) {
      return _json({ ok: false, error: String(err) });
    }
  }
  return _json({ ok: true, message: "KTTA Platform Entry Form Handler is running" });
}

// 集計取得 (admin から呼ぶ)
function _buildStats(tournamentId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ledger = ss.getSheetByName(SHEETS.LEDGER);
  if (!ledger || ledger.getLastRow() < 2) {
    return { ok: true, tournament_id: tournamentId || null,
      teams_count: 0, entries_count: 0, total_amount: 0,
      by_event: {}, applications_count: 0,
      updated_at: new Date().toISOString() };
  }
  const rows = ledger.getDataRange().getValues();
  const h = rows[0] || [];
  const tidIdx = h.indexOf("tournament_id");
  const totalIdx = h.indexOf("合計金額");
  const teamIdx = h.indexOf("団体名");

  const filtered = rows.slice(1).filter(r => !tournamentId || String(r[tidIdx] || "") === String(tournamentId));
  const totalAmount = filtered.reduce((s, r) => s + (Number(r[totalIdx]) || 0), 0);
  const teams = new Set(filtered.map(r => String(r[teamIdx] || "")).filter(Boolean));

  // 種目別: 団体・ダブルス・ミックス の総数を取得
  const byEvent = {};
  const sheetsCheck = [
    [SHEETS.TEAM, "団体"],
    [SHEETS.DOUBLES, "ダブルス"],
    [SHEETS.MIXED, "ミックス"],
  ];
  let totalEntries = 0;
  sheetsCheck.forEach(([sn, label]) => {
    const s = ss.getSheetByName(sn);
    if (s && s.getLastRow() >= 2) {
      const count = s.getLastRow() - 1;
      byEvent[label] = count;
      totalEntries += count;
    }
  });

  return {
    ok: true, tournament_id: tournamentId || null,
    teams_count: teams.size,
    entries_count: totalEntries,
    total_amount: totalAmount,
    by_event: byEvent,
    applications_count: filtered.length,
    updated_at: new Date().toISOString(),
  };
}

function _buildList(tournamentId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const teamSh = ss.getSheetByName(SHEETS.TEAM);
  if (!teamSh) return { ok: false, error: "シートが見つかりません" };
  const rows = teamSh.getDataRange().getValues().slice(1);
  return { ok: true, count: rows.length, entries: rows.map(r => ({
    division: r[0], name: r[1], age: r[2], team: r[3]
  })) };
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ════════════════════════════════════════════
// デバッグ用テスト
// ════════════════════════════════════════════

function _test() {
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({
        tournament_id: "test-id",
        tournament_name: "テスト大会",
        team_name: "テスト団体A",
        contact_name: "山田 太郎",
        contact_tel: "0154-XX-XXXX",
        contact_email: Session.getActiveUser().getEmail(),
        note: "テスト送信",
        total_amount: 7000,
        entries: [
          {
            event: "一般男子 団体戦", type: "team", fee: 1000,
            members_detail: [
              { name: "三本 雅敏", age: 60 },
              { name: "村上 将三", age: 80 },
            ],
          },
          {
            event: "一般男子 ダブルス", type: "doubles", fee: 1000,
            name1: "三本 雅敏", age1: 60,
            name2: "村上 将三", age2: 80,
            team1: "テスト団体A", team2: "テスト団体A",
          },
          {
            event: "混合ダブルス", type: "mixed", fee: 500,
            name1: "三本 雅敏", age1: 60,
            name2: "江口 久美子", age2: 74,
            team1: "テスト団体A", team2: "テスト団体A",
          },
          { event: "お弁当", type: "bento", count: 3, name: "テスト団体A" },
          { event: "懇親会", type: "party", count: 2, name: "テスト団体A" },
        ],
        partner_search: [
          { division: "一般男子", name: "山田 太郎", age: 60, note: "Aクラス希望" },
        ],
      }),
    },
  };
  const result = doPost(fakeEvent);
  console.log(result.getContent());
}

// ════════════════════════════════════════════
// 種目別 選手リスト 自動生成
// ════════════════════════════════════════════

/**
 * 申込台帳の全申込を読み、種目ごとにシートを動的生成。
 * シート名: "_種目_{種目名}" (アンダースコア + 種目名)
 * 列: No, 区分, 氏名, 年齢, 所属チーム, 申込団体, 受付日時
 *
 * 既存の "_種目_..." シートは全削除して再生成。
 */
function generateEventLists() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 既存の "_種目_*" シートを削除
  ss.getSheets().forEach(s => {
    if (s.getName().indexOf("_種目_") === 0) {
      ss.deleteSheet(s);
    }
  });

  // 各エントリーシートから種目別にデータ収集
  const byEvent = {};  // {event: [{kind, division, name, age, team, applicant_team, ts}]}
  const pushRow = (event, row) => {
    if (!event) return;
    (byEvent[event] = byEvent[event] || []).push(row);
  };

  // 申込台帳から 申込団体名・受付日時 を取得するためのマップ
  const ledger = ss.getSheetByName(SHEETS.LEDGER);
  const teamByEvent = {};
  // 簡易: 申込台帳の各行で 団体名 と 受付日時 を保持し、その後の処理は シートそのものから読む
  // 各 entry シートから「チーム名」または「申込団体」が分からない場合は空欄

  // 団体シート: [種目, 区分, 氏名, 年齢, チーム名]
  const tSh = ss.getSheetByName(SHEETS.TEAM);
  if (tSh && tSh.getLastRow() >= 2) {
    tSh.getRange(2, 1, tSh.getLastRow() - 1, 5).getValues().forEach(r => {
      pushRow(r[0], {
        kind: "団体",
        division: r[1], name: r[2], age: r[3],
        team: r[4],
      });
    });
  }

  // ダブルスシート: [種目, 区分, 氏名1, 年齢1, 氏名2, 年齢2, チーム1, チーム2]
  const dSh = ss.getSheetByName(SHEETS.DOUBLES);
  if (dSh && dSh.getLastRow() >= 2) {
    dSh.getRange(2, 1, dSh.getLastRow() - 1, 8).getValues().forEach(r => {
      // 1ペアを「ペア」として 1 行で記録
      pushRow(r[0], {
        kind: "ダブルス",
        division: r[1],
        name: (r[2] || "") + (r[4] ? " / " + r[4] : ""),
        age: (r[3] || "") + (r[5] ? " / " + r[5] : ""),
        team: (r[6] || "") + (r[7] && r[7] !== r[6] ? " / " + r[7] : ""),
      });
    });
  }

  // ミックスシート: [種目, 性別, 氏名, 年齢, チーム名]
  const mSh = ss.getSheetByName(SHEETS.MIXED);
  if (mSh && mSh.getLastRow() >= 2) {
    mSh.getRange(2, 1, mSh.getLastRow() - 1, 5).getValues().forEach(r => {
      pushRow(r[0], {
        kind: "ミックス",
        division: r[1], name: r[2], age: r[3],
        team: r[4],
      });
    });
  }

  // シングルスシート: [種目, 区分, 氏名, 年齢, チーム名]
  const sSh = ss.getSheetByName(SHEETS.SINGLES);
  if (sSh && sSh.getLastRow() >= 2) {
    sSh.getRange(2, 1, sSh.getLastRow() - 1, 5).getValues().forEach(r => {
      pushRow(r[0], {
        kind: "シングルス",
        division: r[1], name: r[2], age: r[3],
        team: r[4],
      });
    });
  }

  // 各種目ごとにシート作成
  const eventNames = Object.keys(byEvent).sort((a, b) => a.localeCompare(b, "ja"));
  let createdCount = 0;
  eventNames.forEach(ev => {
    if (!ev) return;
    // シート名: "_種目_" + 種目名 (シート名に使えない文字を置換)
    const sName = ("_種目_" + ev).replace(/[\\\/\*\?\[\]]/g, " ").substring(0, 95);
    let sh = ss.getSheetByName(sName);
    if (sh) ss.deleteSheet(sh);
    sh = ss.insertSheet(sName);

    // ヘッダー
    sh.getRange(1, 1).setValue(ev).setFontWeight("bold").setFontSize(14);
    sh.getRange(1, 1, 1, 7).merge();
    sh.getRange(2, 1, 1, 7).setValues([["No", "種別", "区分", "氏名", "年齢", "所属チーム", "備考"]])
      .setFontWeight("bold").setBackground("#1e2a4a").setFontColor("#fff");

    // データ行
    const rows = byEvent[ev];
    rows.forEach((row, i) => {
      sh.getRange(i + 3, 1, 1, 7).setValues([[
        i + 1,
        row.kind || "",
        row.division || "",
        row.name || "",
        row.age || "",
        row.team || "",
        "",
      ]]);
    });

    // 件数表示
    const totalRow = rows.length + 4;
    sh.getRange(totalRow, 3).setValue("合計人数 (ペア=2人換算)").setFontWeight("bold");
    const totalPeople = rows.reduce((s, r) => {
      return s + (r.kind === "ダブルス" || r.kind === "ミックス" ? 2 : 1);
    }, 0);
    sh.getRange(totalRow, 5).setValue(totalPeople).setFontWeight("bold").setBackground("#fef3c7");

    sh.setFrozenRows(2);
    sh.setColumnWidth(1, 40);
    sh.setColumnWidth(2, 90);
    sh.setColumnWidth(3, 110);
    sh.setColumnWidth(4, 220);
    sh.setColumnWidth(5, 100);
    sh.setColumnWidth(6, 180);
    sh.setColumnWidth(7, 150);
    createdCount++;
  });

  return { ok: true, events: createdCount, total_records: eventNames.reduce((s, e) => s + byEvent[e].length, 0) };
}

// ════════════════════════════════════════════
// 領収書 発行
// ════════════════════════════════════════════

/**
 * 全申込団体に対して 領収書を一括発行。
 * シート "領収書一覧" に各団体 1枚ずつフォーマット済領収書を縦に並べる。
 * 印刷時は 1領収書 = 1ページ 区切りになるよう改ページを設定。
 */
function generateAllReceipts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ledger = ss.getSheetByName(SHEETS.LEDGER);
  if (!ledger || ledger.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert("申込台帳にデータがありません。");
    return;
  }

  // 申込台帳の各行 = 1領収書
  const rows = ledger.getRange(2, 1, ledger.getLastRow() - 1, LEDGER_HEADERS.length).getValues();
  const props = PropertiesService.getScriptProperties();
  const issuer = props.getProperty("ISSUER_NAME") || "釧路卓球協会 会長 山本 満";
  const tournamentName = (rows[0] && rows[0][1]) || ""; // 大会名は最初の行から

  // 既存シート 削除して再作成
  let sh = ss.getSheetByName(SHEETS.RECEIPTS);
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet(SHEETS.RECEIPTS);

  // 1領収書 = 12行 として配置
  const ROWS_PER_RECEIPT = 12;

  rows.forEach((r, idx) => {
    const baseRow = idx * ROWS_PER_RECEIPT + 1;
    const receiptNo = idx + 1;
    const ts = r[0];
    const tournament = r[1] || "";
    const teamName = r[2] || "";
    const contact = r[3] || "";
    const total = Number(r[10]) || 0;
    const dateStr = ts instanceof Date
      ? Utilities.formatDate(ts, "Asia/Tokyo", "yyyy年 M月 d日")
      : String(ts);

    _drawReceipt(sh, baseRow, {
      no: receiptNo, dateStr, teamName, contact,
      total, tournament, issuer,
    });

    // 領収書間 改ページ
    try {
      sh.setRowHeight(baseRow + ROWS_PER_RECEIPT - 1, 30);
    } catch (e) {}
  });

  // 全体スタイル
  sh.setColumnWidth(1, 60);
  sh.setColumnWidth(2, 180);
  sh.setColumnWidth(3, 100);
  sh.setColumnWidth(4, 180);

  SpreadsheetApp.getUi().alert(rows.length + " 件の領収書を「" + SHEETS.RECEIPTS + "」シートに発行しました。\n\n印刷時はファイル → 印刷 → 用紙サイズA4 で 1領収書/1ページ になります。");
}

// 個別領収書発行 — 「領収書(個別発行)」シートの入力をもとに 1枚発行
function generateManualReceipt() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS.RECEIPT_MANUAL);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.RECEIPT_MANUAL);
    _initManualReceiptSheet(sh);
    SpreadsheetApp.getUi().alert(
      "「" + SHEETS.RECEIPT_MANUAL + "」シートを作成しました。\n" +
      "B3 (宛名)・B4 (金額)・B5 (但し書き)・B6 (日付) を入力後、\n" +
      "もう一度メニュー「KTTA → 個別領収書を発行」を選択してください。"
    );
    return;
  }

  // 入力値を読む
  const addressee = String(sh.getRange("B3").getValue() || "").trim();
  const amount = Number(sh.getRange("B4").getValue()) || 0;
  const note = String(sh.getRange("B5").getValue() || "").trim()
    || "卓球大会 参加料として";
  let dateVal = sh.getRange("B6").getValue();
  let dateStr;
  if (dateVal instanceof Date) {
    dateStr = Utilities.formatDate(dateVal, "Asia/Tokyo", "yyyy年 M月 d日");
  } else if (dateVal) {
    dateStr = String(dateVal);
  } else {
    dateStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy年 M月 d日");
  }

  if (!addressee || amount <= 0) {
    SpreadsheetApp.getUi().alert("宛名と金額を入力してください (B3, B4)。");
    return;
  }

  // 領収書を行 10 から描画
  const props = PropertiesService.getScriptProperties();
  const issuer = props.getProperty("ISSUER_NAME") || "釧路卓球協会 会長 山本 満";

  // 既存の領収書出力エリアをクリア
  sh.getRange(10, 1, 14, 5).clear();
  sh.getRange(10, 1, 14, 5).clearFormat();

  _drawReceipt(sh, 10, {
    no: "(個別)", dateStr,
    teamName: addressee,
    total: amount,
    note: note,
    issuer,
  });

  SpreadsheetApp.getUi().alert("領収書を発行しました (行10〜)。\n印刷してご利用ください。");
}

// 領収書1枚を指定行から描画 (12行分使用)
function _drawReceipt(sh, baseRow, opts) {
  const { no, dateStr, teamName, contact, total, tournament, note, issuer } = opts;
  const noteText = note || ((tournament || "") + " 参加料として");

  // タイトル行
  sh.getRange(baseRow, 1, 1, 5).merge()
    .setValue("領 収 書")
    .setFontSize(28)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setVerticalAlignment("middle");
  sh.setRowHeight(baseRow, 56);

  // 番号・日付
  sh.getRange(baseRow + 1, 1).setValue("No.").setFontWeight("bold");
  sh.getRange(baseRow + 1, 2).setValue("#" + String(no).padStart(4, "0"));
  sh.getRange(baseRow + 1, 4).setValue("発行日").setFontWeight("bold");
  sh.getRange(baseRow + 1, 5).setValue(dateStr);

  // 宛名
  sh.getRange(baseRow + 3, 1).setValue("宛名").setFontWeight("bold");
  sh.getRange(baseRow + 3, 2, 1, 4).merge()
    .setValue(teamName + " 様")
    .setFontSize(18)
    .setFontWeight("bold")
    .setBorder(null, null, true, null, null, null);
  sh.setRowHeight(baseRow + 3, 38);

  // 金額
  sh.getRange(baseRow + 5, 1).setValue("金額").setFontWeight("bold");
  sh.getRange(baseRow + 5, 2, 1, 4).merge()
    .setValue("¥ " + total.toLocaleString("ja-JP") + "  -")
    .setFontSize(22)
    .setFontWeight("bold")
    .setHorizontalAlignment("left")
    .setBorder(null, null, true, null, null, null);
  sh.setRowHeight(baseRow + 5, 44);

  // 但し書き
  sh.getRange(baseRow + 7, 1).setValue("但し").setFontWeight("bold");
  sh.getRange(baseRow + 7, 2, 1, 4).merge()
    .setValue(noteText)
    .setBorder(null, null, true, null, null, null);

  // 発行者
  sh.getRange(baseRow + 9, 1).setValue("発行").setFontWeight("bold");
  sh.getRange(baseRow + 9, 2, 1, 4).merge()
    .setValue(issuer + "  (印)")
    .setFontSize(13);

  // 上記の通り領収いたしました
  sh.getRange(baseRow + 10, 1, 1, 5).merge()
    .setValue("上記の通り領収いたしました。")
    .setFontSize(11)
    .setHorizontalAlignment("center");

  // 枠線
  sh.getRange(baseRow, 1, 11, 5).setBorder(true, true, true, true, null, null);
  sh.getRange(baseRow, 1, 1, 5).setBackground("#1e2a4a").setFontColor("#fff");

  // 区切り行 (改ページ用)
  sh.setRowHeight(baseRow + 11, 24);
}

// 個別領収書 入力シート 初期化
function _initManualReceiptSheet(sh) {
  sh.getRange(1, 1, 1, 5).merge()
    .setValue("領収書 個別発行 - 入力欄")
    .setFontSize(16)
    .setFontWeight("bold")
    .setBackground("#1e2a4a")
    .setFontColor("#fff")
    .setHorizontalAlignment("center");

  sh.getRange(3, 1).setValue("宛名 *").setFontWeight("bold");
  sh.getRange(3, 2, 1, 4).merge();

  sh.getRange(4, 1).setValue("金額 *").setFontWeight("bold");
  sh.getRange(4, 2, 1, 4).merge();
  sh.getRange(4, 2).setNumberFormat("¥#,##0");

  sh.getRange(5, 1).setValue("但し書き").setFontWeight("bold");
  sh.getRange(5, 2, 1, 4).merge().setValue("卓球大会 参加料として");

  sh.getRange(6, 1).setValue("日付").setFontWeight("bold");
  sh.getRange(6, 2, 1, 4).merge().setValue(new Date()).setNumberFormat("yyyy/MM/dd");

  sh.getRange(8, 1, 1, 5).merge()
    .setValue("↓ 入力後、メニュー「KTTA → 個別領収書を発行」を選択 ↓")
    .setBackground("#fef3c7")
    .setHorizontalAlignment("center")
    .setFontWeight("bold");

  // 入力欄を明るく
  sh.getRange(3, 2, 4, 4).setBackground("#f0fdf4");

  sh.setColumnWidth(1, 90);
  sh.setColumnWidth(2, 200);
  sh.setColumnWidth(3, 100);
  sh.setColumnWidth(4, 100);
  sh.setColumnWidth(5, 100);
}

// ════════════════════════════════════════════
// カスタムメニュー (onOpen)
// ════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("KTTA Platform")
    .addItem("集計用シート 再計算", "menuRebuildAggregate")
    .addItem("種目別 選手リスト 生成", "menuGenerateEventLists")
    .addSeparator()
    .addItem("全団体の領収書を一括発行", "menuGenerateAllReceipts")
    .addItem("個別領収書を発行 (手動入力)", "menuGenerateManualReceipt")
    .addSeparator()
    .addItem("ヘルプ / 使い方", "menuShowHelp")
    .addToUi();
}

function menuRebuildAggregate() {
  rebuildAggregate(SpreadsheetApp.getActiveSpreadsheet(), "");
  SpreadsheetApp.getUi().alert("集計用シートを再計算しました。");
}

function menuGenerateEventLists() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert(
    "種目別 選手リスト生成",
    "既存の「_種目_*」シートはすべて削除して再生成されます。よろしいですか?",
    ui.ButtonSet.OK_CANCEL
  );
  if (ok !== ui.Button.OK) return;
  const r = generateEventLists();
  ui.alert(r.events + " 種目のシートを生成しました (合計 " + r.total_records + " 件)。");
}

function menuGenerateAllReceipts() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert(
    "全団体の領収書 一括発行",
    "申込台帳のすべての団体に対して領収書を発行します。\n既存の「" + SHEETS.RECEIPTS + "」シートは上書きされます。\nよろしいですか?",
    ui.ButtonSet.OK_CANCEL
  );
  if (ok !== ui.Button.OK) return;
  generateAllReceipts();
}

function menuGenerateManualReceipt() {
  generateManualReceipt();
}

function menuShowHelp() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    "KTTA Platform - GAS スプレッドシート",
    "■ シート一覧\n" +
    "  申込台帳: 申込履歴 (1申込=1行)\n" +
    "  選手名簿: 団体別の出場選手一覧\n" +
    "  団体/ダブルス/ミックス/シングルス: 種目別エントリー\n" +
    "  お弁当、懇親会: 弁当・懇親会の参加者\n" +
    "  ダブルス相手募集者: ペア募集リクエスト\n" +
    "  集計用: 団体別 種目別人数+合計金額 (自動再計算)\n" +
    "  _種目_*: 種目別 選手リスト (手動生成)\n" +
    "  領収書一覧: 全団体の領収書 (一括発行)\n" +
    "  領収書(個別発行): 手動入力 → 1枚発行\n\n" +
    "■ スクリプトプロパティ (任意設定)\n" +
    "  ADMIN_EMAIL: 主催者メール\n" +
    "  ASSOCIATION_NAME: 釧路卓球協会\n" +
    "  ISSUER_NAME: 釧路卓球協会 会長 山本 満\n" +
    "  PRICE_TEAM_M/F, PRICE_DBL_M/F, PRICE_MIX_M/F, PRICE_BENTO, PRICE_PARTY",
    ui.ButtonSet.OK
  );
}
