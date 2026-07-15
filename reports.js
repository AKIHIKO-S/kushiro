// ═══════════════════════════════════════════════════════
// 大会レポート出力モジュール
// ・集計表 (まりもオープン形式) Excel 出力
// ・申込団体別 領収書 一括出力 (HTML 印刷用)
// ═══════════════════════════════════════════════════════
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

// 種目分類のヘルパー
function classifyEvent(eventName) {
  const n = (eventName || "").toLowerCase();
  if (n.includes("団体")) return "team";
  if (n.includes("混合") || n.includes("ミックス") || n.includes("mix")) return "mixed";
  if (n.includes("ダブルス") || n.includes("doubles")) return "doubles";
  return "singles";
}

function genderOf(eventName, entrant) {
  if (entrant && entrant.gender === "female") return "female";
  if (entrant && entrant.gender === "male") return "male";
  const n = (eventName || "").toLowerCase();
  if (n.includes("女子") || n.includes("women")) return "female";
  if (n.includes("男子") || n.includes("men")) return "male";
  return "mixed";
}

// 区分ラベル ("一般男子" "一般女子" 等)
function categoryLabel(entrant, eventName) {
  const g = genderOf(eventName, entrant);
  const cat = entrant.category || "general";
  const catLabel = {
    general: "一般", high: "高校", middle: "中学",
    elementary: "小学", university: "大学", senior: "シニア", junior: "ジュニア",
    youth: "ユース", large: "ラージ",
  }[cat] || "一般";
  const gLabel = g === "female" ? "女子" : g === "male" ? "男子" : "混合";
  return catLabel + gLabel;
}

// ─── 集計・領収書 共通ヘルパ (DRY: 種別ラベル/日付/ソート/集計/明細) ───
const KIND_LABEL = {
  team_male: "団体戦男子", team_female: "団体戦女子",
  doubles_male: "ダブルス男子", doubles_female: "ダブルス女子",
  mixed_male: "混合ダブルス男子", mixed_female: "混合ダブルス女子",
  singles_male: "シングルス男子", singles_female: "シングルス女子",
};
// date は自由記入TEXT列。非ISO値("未定"等)だと new Date() が Invalid Date になり
// 領収書/対戦票に literally "Invalid Date" と印字されるため、パース不能なら原文を返す。
const _jaLongDate = d => {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d)
    : dt.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
};
// 短い日付 (対戦票ヘッダー用)。非ISOは原文をそのまま返す。
const _jaShortDate = d => {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString("ja-JP");
};
// 団体 Map を団体名(ja)順に [team, members] で返す
const sortedTeams = teams => Array.from(teams.entries()).sort((a, b) => a[0].localeCompare(b[0], "ja"));
// メンバー配列を 種別×性別 で集計 (8キー固定・挿入順保持)
function countByKindGender(members) {
  const cnt = { team_male:0, team_female:0, doubles_male:0, doubles_female:0,
                mixed_male:0, mixed_female:0, singles_male:0, singles_female:0 };
  members.forEach(m => { const k = `${m.kind}_${m.gender === "female" ? "female" : "male"}`; if (cnt[k] !== undefined) cnt[k]++; });
  return cnt;
}
// メンバー配列 → 種別×性別の明細 [{label,n,fee,sub}] と合計 sum。
// 料金は各メンバーに付与済みの m.fee(区分=一般/中高校生で異なる)を合算する。
// 未付与なら kind×gender 単価 F をフォールバック。fee 列は表示用に平均単価(均一なら実額)。
function breakdownOf(members, F) {
  const buckets = {};
  (members || []).forEach(m => {
    const k = `${m.kind}_${m.gender === "female" ? "female" : "male"}`;
    if (!(k in KIND_LABEL)) return;
    const b = (buckets[k] = buckets[k] || { n: 0, sub: 0 });
    b.n++;
    b.sub += (m.fee != null ? m.fee : (F[k] || 0));
  });
  let sum = 0; const breakdown = [];
  Object.keys(KIND_LABEL).forEach(k => {
    const b = buckets[k]; if (!b || !b.n) return;
    sum += b.sub;
    breakdown.push({ label: KIND_LABEL[k], n: b.n, fee: Math.round(b.sub / b.n), sub: b.sub });
  });
  return { breakdown, sum };
}
// 団体ごとの集計済み明細 [{no, team, total, breakdown}] (団体名順)
function teamItemsOf(teams, F) {
  let no = 1;
  return sortedTeams(teams).map(([team, members]) => {
    const { breakdown, sum } = breakdownOf(members, F);
    return { no: no++, team, total: sum, breakdown };
  });
}

// event_config (種目ごとの fee) を kind×gender バケットの単価へ写像する (#17)。
// これで集計表/領収書が、申込フォーム・確認メールと同じ「設定された参加料」を使う。
// 同一バケットに料金違いの種目が混在する場合は先に設定された種目の料金を採用 (近似)。
function feesFromEventConfig(tournament) {
  let cfg = [];
  try {
    cfg = typeof tournament.event_config === "string"
      ? JSON.parse(tournament.event_config || "[]")
      : (tournament.event_config || []);
  } catch (e) { cfg = []; }
  const out = {};
  (Array.isArray(cfg) ? cfg : []).forEach(c => {
    if (!c || !c.name) return;
    const fee = parseInt(c.fee, 10);
    if (!(fee >= 0)) return;
    const kind = classifyEvent(c.name);
    const gender = genderOf(c.name, {});
    const key = `${kind}_${gender === "female" ? "female" : "male"}`;   // countByKindGender と同じ規則
    if (out[key] === undefined) out[key] = fee;   // 先勝ち
  });
  return out;
}

// 大会の出場選手から集計データを構築
function buildAggregation(tournament, entrants, fees) {
  // 却下/受付待ち(rejected/pending 等)の申込は請求対象外。confirmed のみ集計・領収書に計上する。
  // 抽選番号付与(autoAssignDrawNumbers)・チームリーグ生成と同じ判定で、料金系だけが status を無視して
  // 却下分まで過大計上していた非対称を解消する。entrants の既定 status は 'confirmed'(自動承認)。
  entrants = (entrants || []).filter(e => (e.status || "confirmed") === "confirmed");
  // 団体名でグルーピング (チーム名 ≒ 申込団体名 として扱う)
  const byTeam = new Map();
  entrants.forEach(e => {
    // ダブルスは申込者(player1)の所属に「ペア1組=1件」で計上する(別所属パートナーの団体には課金しない=ペア単位課金。協会確定ポリシー 2026-05-30 QA)
    const records = [];
    records.push({
      team: e.team || "(無所属)",
      kind: classifyEvent(e.event),
      gender: genderOf(e.event, e),
      category: e.category || "general",  // categoryLabel 用。これが無いと名簿/団体/D/混合の区分が全て「一般」になる
      event_name: e.event,
      name: e.name,
      partner_name: e.partner_name || "",
      partner_team: e.partner_team || e.team,
      is_doubles: !!e.is_doubles,
      // 申込時の確定課金額(区分=中高生の学割を反映)。集計表・領収書はこの per-member fee を合算し、
      // 確認メール(authoritativeFees の fee_student)と一致させる。未設定(旧データ)は breakdownOf が
      // バケット単価 F へフォールバック。
      fee: (e.fee != null ? (parseInt(e.fee, 10) || 0) : null),
    });
    if (!byTeam.has(records[0].team)) byTeam.set(records[0].team, []);
    byTeam.get(records[0].team).push(records[0]);
  });

  // 単価: ハードコード既定 → event_config 由来(#17) → 明示 fees パラメータ の順で上書き。
  // これで領収書/集計が申込フォーム・確認メールと同じ参加料を使う (請求額の食い違いを防止)。
  const F = Object.assign({
    team_male: 1000, team_female: 1000,
    doubles_male: 1000, doubles_female: 1000,
    mixed_male: 1000, mixed_female: 1000,
    singles_male: 700, singles_female: 700,
    bento: 800, party: 3500,
  }, feesFromEventConfig(tournament), fees || {});

  // 各メンバーに参加料を付与 (区分=category で 一般/中高校生 を切替)。event_config に無い種目は
  // kind×gender 単価 F をフォールバック。集計表/領収書の合計が区分別料金で正しくなる。
  const feeMap = eventFeeByName(tournament);
  for (const members of byTeam.values()) {
    members.forEach(m => {
      const bucket = `${m.kind}_${m.gender === "female" ? "female" : "male"}`;
      const cfg = feeMap[String(m.event_name || "").trim()];
      if (cfg) {
        const isStudent = m.category && m.category !== "general";
        m.fee = (isStudent && cfg.fee_student != null) ? cfg.fee_student : cfg.fee;
      } else {
        m.fee = F[bucket] != null ? F[bucket] : 0;
      }
    });
  }

  return { teams: byTeam, fees: F };
}

// event_config の種目別 {一般料金, 中高校生料金} マップ (名称キー)。
function eventFeeByName(tournament) {
  let cfg = [];
  try {
    cfg = typeof tournament.event_config === "string"
      ? JSON.parse(tournament.event_config || "[]")
      : (tournament.event_config || []);
  } catch (e) { cfg = []; }
  const map = {};
  (Array.isArray(cfg) ? cfg : []).forEach(c => {
    if (!c || !c.name) return;
    const fee = parseInt(c.fee, 10);
    if (!(fee >= 0)) return;
    const fs = parseInt(c.fee_student, 10);
    map[String(c.name).trim()] = { fee, fee_student: (fs >= 0 ? fs : null) };
  });
  return map;
}

// ─── 集計表 Excel 出力 (まりもオープン形式) ───
function buildAggregationXlsx(tournament, entrants, opts) {
  opts = opts || {};
  const fees = opts.fees || {};
  const { teams, fees: F } = buildAggregation(tournament, entrants, fees);

  const wb = XLSX.utils.book_new();

  // ─── シート 1: 集計用 ───
  const aggRows = [
    [null, tournament.date || "", tournament.name || ""],
    [],
    ["No.", "団体名", "団体", null, "ダブルス", null, "ミックス", null, "お弁当", "懇親会", "合計"],
    [null, null, "男子", "女子", "男子", "女子", "男子", "女子", null, null, null],
    [null, null,
      F.team_male, F.team_female,
      F.doubles_male, F.doubles_female,
      F.mixed_male, F.mixed_female,
      F.bento, F.party, null],
  ];
  let idx = 1;
  const teamTotals = []; // for 差し込み用シート
  sortedTeams(teams)
    .forEach(([teamName, members]) => {
      const cnt = countByKindGender(members);
      // 合計は per-member の m.fee(学割反映)を合算する。従来の cnt×F だと学割が消え、領収書・確認メールと
      // 食い違っていた(同一バケットに一般/中高生が混在すると先勝ち単価で過大計上)。表示の人数列は cnt のまま。
      const { sum } = breakdownOf(members, F);
      aggRows.push([
        idx++, teamName,
        cnt.team_male || 0, cnt.team_female || 0,
        cnt.doubles_male || 0, cnt.doubles_female || 0,
        cnt.mixed_male || 0, cnt.mixed_female || 0,
        0, 0,
        sum,
      ]);
      teamTotals.push({ team: teamName, total: sum });
    });

  const ws1 = XLSX.utils.aoa_to_sheet(aggRows);
  XLSX.utils.book_append_sheet(wb, ws1, "集計用");

  // ─── シート 2: 選手名簿 (申込団体ごとに種目別) ───
  const rosterRows = [
    ["申請団体", "申込責任者", null, "団体",  null, null, null, null,
     "ダブルス", null, null, null, null, null, null, null,
     "ミックス", null, null, null],
    [null, null, null,
      "区分", "氏名", "年齢", "チーム名", null,
      "区分", "氏名1", "年齢", "氏名2", "年齢", "チーム名1", "チーム名2", null,
      "区分", "氏名", "年齢", "チーム名"],
  ];
  sortedTeams(teams)
    .forEach(([teamName, members]) => {
      const teamMembers = members.filter(m => m.kind === "team");
      const doublesMembers = members.filter(m => m.kind === "doubles");
      const mixedMembers = members.filter(m => m.kind === "mixed");
      const maxRows = Math.max(teamMembers.length, doublesMembers.length, mixedMembers.length, 1);
      for (let i = 0; i < maxRows; i++) {
        const t = teamMembers[i];
        const d = doublesMembers[i];
        const m = mixedMembers[i];
        rosterRows.push([
          i === 0 ? teamName : null,
          i === 0 ? (opts.contact?.[teamName] || "") : null,
          null,
          t ? categoryLabel(t, t.event_name) : null,
          t ? t.name : null,
          null, // 年齢 (DBに無いので空)
          t ? teamName : null,
          null,
          d ? categoryLabel(d, d.event_name) : null,
          d ? d.name : null,
          null,
          d ? d.partner_name : null,
          null,
          d ? teamName : null,
          d ? d.partner_team : null,
          null,
          m ? categoryLabel(m, m.event_name) : null,
          m ? m.name : null,
          null,
          m ? teamName : null,
        ]);
      }
      rosterRows.push([]);
    });
  const ws2 = XLSX.utils.aoa_to_sheet(rosterRows);
  XLSX.utils.book_append_sheet(wb, ws2, "選手名簿");

  // ─── シート 3: 団体 ───
  const teamRows = [["区分", "氏名", "年齢", "チーム名"]];
  let teamM = 0, teamF = 0;
  sortedTeams(teams)
    .forEach(([teamName, members]) => {
      members.filter(m => m.kind === "team").forEach(m => {
        teamRows.push([categoryLabel(m, m.event_name), m.name, "", teamName]);
        if (m.gender === "female") teamF++; else teamM++;
      });
    });
  teamRows.push([]);
  teamRows.push(["", "", "", "", "", "一般男子", teamM]);
  teamRows.push(["", "", "", "", "", "一般女子", teamF]);
  teamRows.push(["", "", "", "", "", "合計", teamM + teamF]);
  const ws3 = XLSX.utils.aoa_to_sheet(teamRows);
  XLSX.utils.book_append_sheet(wb, ws3, "団体");

  // ─── シート 4: ダブルス ───
  const dblRows = [["区分", "氏名1", "年齢", "氏名2", "年齢", "チーム名1", "チーム名2"]];
  let dM = 0, dF = 0;
  sortedTeams(teams)
    .forEach(([teamName, members]) => {
      members.filter(m => m.kind === "doubles").forEach(m => {
        dblRows.push([
          categoryLabel(m, m.event_name),
          m.name, "", m.partner_name, "",
          teamName, m.partner_team || ""
        ]);
        if (m.gender === "female") dF++; else dM++;
      });
    });
  dblRows.push([]);
  dblRows.push(["", "", "", "", "", "", "", "一般男子", dM]);
  dblRows.push(["", "", "", "", "", "", "", "一般女子", dF]);
  dblRows.push(["", "", "", "", "", "", "", "合計", dM + dF]);
  const ws4 = XLSX.utils.aoa_to_sheet(dblRows);
  XLSX.utils.book_append_sheet(wb, ws4, "ダブルス");

  // ─── シート 5: ミックス ───
  const mxRows = [["", "氏名", "年齢", "チーム名"]];
  let mM = 0, mF = 0;
  sortedTeams(teams)
    .forEach(([teamName, members]) => {
      members.filter(m => m.kind === "mixed").forEach(m => {
        mxRows.push([m.gender === "female" ? "女子" : "男子", m.name, "", teamName]);
        if (m.gender === "female") mF++; else mM++;
      });
    });
  mxRows.push([]);
  mxRows.push(["", "", "", "", "", "男子", mM]);
  mxRows.push(["", "", "", "", "", "女子", mF]);
  mxRows.push(["", "", "", "", "", "合計", mM + mF]);
  const ws5 = XLSX.utils.aoa_to_sheet(mxRows);
  XLSX.utils.book_append_sheet(wb, ws5, "ミックス");

  // ─── シート 6: 差し込み用 (領収書印刷データ) ───
  const mergeRows = [["大会名", "大会日", "団体名", "合計"]];
  teamTotals.forEach(t => {
    mergeRows.push([tournament.name, tournament.date, t.team, t.total]);
  });
  const ws6 = XLSX.utils.aoa_to_sheet(mergeRows);
  XLSX.utils.book_append_sheet(wb, ws6, "差し込み用");

  // バイナリ生成
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ─── 領収書 HTML 一括生成 (印刷用、印鑑画像埋込) ───
function buildReceiptsHTML(tournament, entrants, opts) {
  opts = opts || {};
  const { teams, fees: F } = buildAggregation(tournament, entrants, opts.fees);
  // src属性に展開するため必ずエスケープ (seal_url/logo_url はクエリ由来=反射XSS防止)
  // 印影は未設定なら空にして「印」枠を直接描く(0バイト/未配置の seal.png を無駄に取りに行って
  // 404→onerror で差し替える往復を避ける)。実アップロード(/uploads/seal.*)があれば server が seal_url を渡す。
  const sealPath = escapeHtml(opts.seal_url || "");
  const logoPath = escapeHtml(opts.logo_url || "/shared/assets/icon-192.png");   // 協会ロゴ (#272)
  const issuer = opts.issuer || "釧路卓球協会";
  const president = opts.president || "会長  山本 満";
  const startNo = parseInt(opts.start_no) > 0 ? parseInt(opts.start_no) : 1;
  const dateStr = _jaLongDate(tournament.date);

  const items = teamItemsOf(teams, F);

  // 個別発行: 指定団体だけに絞る (#272)。未指定なら全団体一括。
  const shown = opts.only_team ? items.filter(it => it.team === opts.only_team) : items;

  // HTML 構築
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>領収書 ${escapeHtml(tournament.name || "")}</title>
<style>
  /* 外部フォント@import撤去: BIZ UDPGothic はシステム同梱/Hiragino等で代替(オフライン整合) */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'BIZ UDPGothic', 'Hiragino Mincho ProN', 'Yu Mincho', serif;
    background: #fff; color: #000;
  }
  .toolbar {
    background: #1e2a4a; color: #fff;
    padding: 14px 28px;
    display: flex; justify-content: space-between; align-items: center;
    position: sticky; top: 0; z-index: 10;
  }
  .toolbar h1 { font-size: 18px; font-weight: 700; }
  .toolbar .info { font-size: 12px; opacity: .85; }
  .toolbar button {
    background: #fff; color: #1e2a4a;
    border: none; padding: 8px 20px;
    border-radius: 4px; font-weight: 700; cursor: pointer;
  }
  /* ─── A6 サイズ (105×148mm) 領収書 ─── */
  .receipt-page {
    width: 148mm; height: 105mm;   /* A6 横置き */
    padding: 10mm 10mm 8mm;
    margin: 8px auto;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.1);
    page-break-after: always;
    position: relative;
    border: 1px solid #ddd;
    overflow: hidden;
  }
  .receipt-title {
    text-align: center;
    font-size: 22px;
    letter-spacing: 0.4em;
    padding-left: 0.4em;
    border-bottom: 2px solid #000;
    padding-bottom: 4px;
    margin-bottom: 6px;
  }
  .receipt-no {
    position: absolute; top: 6mm; right: 10mm;
    font-size: 9px;
  }
  .receipt-logo {
    position: absolute; top: 5mm; left: 10mm;
    width: 13mm; height: 13mm; object-fit: contain; opacity: .92;
  }
  .receipt-to {
    font-size: 15px;
    margin: 4px 0 8px;
    padding: 3px 0;
    border-bottom: 1px solid #888;
  }
  .receipt-to-sub { font-size: 10px; color: #555; margin-left: 3px; }
  .receipt-amount {
    font-size: 24px;
    text-align: center;
    margin: 6px 0;
    font-weight: 700;
    border-top: 1px solid #000;
    border-bottom: 3px double #000;
    padding: 5px 0;
    letter-spacing: 0.08em;
  }
  .receipt-amount-prefix { font-size: 14px; vertical-align: middle; margin-right: 5px; }
  .receipt-purpose {
    font-size: 10px;
    margin: 6px 0;
    line-height: 1.5;
  }
  .receipt-purpose strong { font-size: 11px; }
  .breakdown {
    margin: 4px 0;
    border-collapse: collapse;
    width: 100%;
    font-size: 9px;
  }
  .breakdown th, .breakdown td {
    padding: 2px 5px;
    border: 1px solid #aaa;
    text-align: right;
  }
  .breakdown th { background: #f1f1f1; text-align: center; }
  .breakdown td:first-child { text-align: left; }
  .receipt-footer {
    position: absolute;
    bottom: 8mm; right: 10mm;
    text-align: right;
    font-size: 10px;
    line-height: 1.4;
  }
  .receipt-footer .issuer { font-size: 11px; font-weight: 700; margin-top: 2px; }
  .seal-wrap {
    display: inline-block; position: relative;
    margin-left: 4px;
    vertical-align: middle;
  }
  .seal-wrap img {
    width: 40px; height: 40px;
    object-fit: contain;
    opacity: 0.85;
  }
  .seal-wrap .no-seal {
    width: 36px; height: 36px;
    border: 2px solid #c91f37; color: #c91f37;
    border-radius: 4px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 9px;
    transform: rotate(-3deg);
  }
  .receipt-date {
    position: absolute;
    bottom: 8mm; left: 10mm;
    font-size: 10px;
  }
  @media print {
    .toolbar { display: none; }
    .receipt-page {
      margin: 0; box-shadow: none; border: none;
    }
    @page { size: A6 landscape; margin: 0; }
  }
</style>
</head>
<body>
<div class="toolbar">
  <h1>領収書 ${opts.only_team ? "（個別）" : "一括出力"}</h1>
  <div class="info">${escapeHtml(tournament.name || "")} ${dateStr} / ${shown.length} 団体分</div>
  <button onclick="window.print()">PDF で保存 / 印刷</button>
</div>
${shown.map((item, i) => renderReceipt(item, i, tournament, dateStr, sealPath, issuer, president, logoPath, startNo)).join("")}
</body>
</html>`;

  return html;
}

function renderReceipt(item, i, tournament, dateStr, sealPath, issuer, president, logoPath, startNo) {
  // 連番は団体固有の通し番号(item.no)を基準にする。配列インデックス i だと
  // 個別発行(only_team で1件のみ=i=0)時に全団体が No.0001 になり連番が衝突するため。
  // start_no はオフセット(既定1=item.no そのまま)。xlsx 版(item.no 使用)とも一致。
  const baseNo = item.no || (i + 1);
  const serialNo = (startNo || 1) + (baseNo - 1);
  const amountStr = item.total.toLocaleString("ja-JP");
  const sealHtml = sealPath
    ? `<div class="seal-wrap"><img src="${sealPath}" alt="印鑑" onerror="this.outerHTML='<span class=no-seal>印</span>'"></div>`
    : `<div class="seal-wrap"><span class="no-seal">印</span></div>`;
  return `
<div class="receipt-page">
  <img class="receipt-logo" src="${logoPath}" alt="" onerror="this.style.display='none'">
  <div class="receipt-no">No. ${String(serialNo).padStart(4, "0")}</div>
  <div class="receipt-title">領収書</div>
  <div class="receipt-to">${escapeHtml(item.team)}<span class="receipt-to-sub"> 様</span></div>
  <div class="receipt-amount">
    <span class="receipt-amount-prefix">金</span>¥ ${amountStr}<span class="receipt-amount-prefix">也</span>
  </div>
  <div class="receipt-purpose">
    <strong>但し</strong>　${escapeHtml(tournament.name || "")} 大会参加料として、上記正に領収いたしました。
  </div>
  <table class="breakdown">
    <thead><tr><th>種別</th><th>人数</th><th>単価</th><th>小計</th></tr></thead>
    <tbody>
      ${item.breakdown.map(b => `<tr>
        <td>${escapeHtml(b.label)}</td>
        <td>${b.n}</td>
        <td>¥${b.fee.toLocaleString("ja-JP")}</td>
        <td>¥${b.sub.toLocaleString("ja-JP")}</td>
      </tr>`).join("")}
      <tr><td colspan="3" style="text-align:right"><b>合計</b></td>
          <td><b>¥${amountStr}</b></td></tr>
    </tbody>
  </table>
  <div class="receipt-date">${dateStr}</div>
  <div class="receipt-footer">
    ${escapeHtml(issuer)}<br>
    <span class="issuer">${escapeHtml(president)}</span>
    ${sealHtml}
  </div>
</div>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── 領収書 Excel 一括出力 (1ファイル、1団体=1シート) ───
// 各シートが A5 横の領収書レイアウト
function buildReceiptsXlsx(tournament, entrants, opts) {
  opts = opts || {};
  const { teams, fees: F } = buildAggregation(tournament, entrants, opts.fees);
  const issuer = opts.issuer || "釧路卓球協会";
  const president = opts.president || "会長  山本 満";
  const dateStr = _jaLongDate(tournament.date);

  const wb = XLSX.utils.book_new();

  // ── 一覧シート ──
  const summaryRows = [
    [tournament.name || "", null, null, dateStr],
    [],
    ["No.", "団体名", "合計金額", "発行日"],
  ];
  const teamItems = teamItemsOf(teams, F);
  teamItems.forEach(it => summaryRows.push([it.no, it.team, it.total, dateStr]));
  // 合計行
  const grandTotal = teamItems.reduce((s, t) => s + t.total, 0);
  summaryRows.push([]);
  summaryRows.push(["", "合計", grandTotal, ""]);

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 6 }, { wch: 30 }, { wch: 12 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "一覧");

  // ── 各団体ごとに領収書シート ──
  teamItems.forEach(item => {
    const amountStr = "¥ " + item.total.toLocaleString("ja-JP") + " 也";
    const rows = [
      [null, null, null, null, null, "No. " + String(item.no).padStart(4, "0")],
      [],
      [null, null, "領    収    書"],
      [],
      [item.team, null, "様"],
      [],
      [null, null, "金", amountStr],
      [],
      [null, "但し  " + (tournament.name || "") + " 大会参加料として、上記正に領収いたしました。"],
      [],
      ["内訳:"],
      ["種別", "人数", "単価", "小計"],
    ];
    item.breakdown.forEach(b => {
      rows.push([b.label, b.n, b.fee, b.sub]);
    });
    rows.push(["合計", "", "", item.total]);
    rows.push([]);
    rows.push([]);
    rows.push([dateStr, null, null, null, issuer]);
    rows.push([null, null, null, null, president + "  (印)"]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 24 }, { wch: 10 }];
    // セルスタイルは XLSX library の community版だと制限あり。基本的なフォーマットのみ。
    ws["!merges"] = [
      { s: { r: 2, c: 2 }, e: { r: 2, c: 5 } },  // 領収書タイトル
      { s: { r: 4, c: 0 }, e: { r: 4, c: 1 } },  // 団体名
      { s: { r: 6, c: 3 }, e: { r: 6, c: 5 } },  // 金額
      { s: { r: 8, c: 1 }, e: { r: 8, c: 5 } },  // 但し書き
    ];
    // シート名: 団体名 (Excel制限: 31文字以内、特殊文字NG)
    const safe = String(item.team).replace(/[\[\]\\\/?\*:]/g, "_").slice(0, 28);
    XLSX.utils.book_append_sheet(wb, ws, `${item.no}_${safe}`.slice(0, 31));
  });

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ─── 団体一覧 (集計済) を JSON で返す (モーダル表示用) ───
function buildReceiptsList(tournament, entrants, opts) {
  opts = opts || {};
  const { teams, fees: F } = buildAggregation(tournament, entrants, opts.fees);
  const items = teamItemsOf(teams, F);
  return {
    tournament: { id: tournament.id, name: tournament.name, date: tournament.date },
    issuer: opts.issuer || "釧路卓球協会",
    president: opts.president || "会長  山本 満",
    items,
    grand_total: items.reduce((s, t) => s + t.total, 0),
  };
}

// ═══════════════════════════════════════════════════════
// 対戦票 (審判用記録票) 一括 Excel 出力
// 各試合 1 ブロック (10行 × 8列) のカード形式。1ページに 3 試合。
// ═══════════════════════════════════════════════════════
function buildMatchCardsXlsx(tournament, matches, entrants, opts) {
  opts = opts || {};
  const onlyPlayable = opts.only_playable !== false; // BYE 試合除外
  // entrants から選手番号を引けるマップ
  const numByEntrant = new Map();
  (entrants || []).forEach(e => {
    if (e.bracket_number && e.bracket_number > 0) {
      numByEntrant.set(e.id, "#" + e.bracket_number);
    }
  });

  const wb = XLSX.utils.book_new();

  // 種目ごとにシートを分ける
  const byEvent = new Map();
  (matches || []).forEach(m => {
    if (onlyPlayable) {
      // BYE 試合は除外
      const p1Bye = !m.player1_name || m.player1_name === "BYE";
      const p2Bye = !m.player2_name || m.player2_name === "BYE";
      if (p1Bye || p2Bye) return;
    }
    const key = m.event || "(未分類)";
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(m);
  });

  if (!byEvent.size) {
    // 空ワークブック対策: 1シートに案内のみ
    const ws = XLSX.utils.aoa_to_sheet([
      [tournament.name || "対戦票"],
      [""],
      ["対戦カードがありません。先にトーナメント表を取込んでください。"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "対戦票");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  }

  // セルスタイル定義 (XLSXフルスタイル対応版)
  const thinBorder = { style: "thin", color: { rgb: "000000" } };
  const borderAll = { top: thinBorder, bottom: thinBorder,
                      left: thinBorder, right: thinBorder };

  // 種目ごとに 1 シート
  Array.from(byEvent.entries()).forEach(([eventName, list]) => {
    // ラウンド・bracket_pos 順
    list.sort((a, b) =>
      (a.bracket_round || 99) - (b.bracket_round || 99) ||
      (a.bracket_pos || 99) - (b.bracket_pos || 99));

    const rows = [];
    // ページヘッダー
    rows.push([
      tournament.name || "", "", "", "",
      _jaShortDate(tournament.date),
      "", "", "",
    ]);
    rows.push(["対戦票 (審判用記録票) — " + eventName, "", "", "", "", "", "", ""]);
    rows.push([]);

    // 各試合 1 カード (10行) × 全試合
    list.forEach((m, idx) => {
      const p1Num = numByEntrant.get(m.player1_entrant_id) || "";
      const p2Num = numByEntrant.get(m.player2_entrant_id) || "";
      const tableNo = m.table_no || "未定";
      const refName = m.referee_name || "";

      // 試合カード (横長 8列)
      rows.push([
        "試合 #" + (m.match_no || (idx + 1)),
        "ラウンド: " + (m.round || ""),
        "", "",
        "台: " + tableNo,
        "審判:", refName, "",
      ]);
      rows.push([
        "選手1", p1Num, m.player1_name || "", m.player1_team || "",
        "選手2", p2Num, m.player2_name || "", m.player2_team || "",
      ]);
      // スコア記入欄 (5セットまで)
      rows.push([
        "", "", "", "", "", "", "", "",
      ]);
      rows.push([
        "セット", "第1", "第2", "第3", "第4", "第5", "勝", "備考",
      ]);
      rows.push([
        "選手1得点", "", "", "", "", "", "", "",
      ]);
      rows.push([
        "選手2得点", "", "", "", "", "", "", "",
      ]);
      rows.push([
        "勝者 (○記入):", "", "", "", "", "", "", "",
      ]);
      rows.push([
        "選手1の勝:", "□",
        "選手2の勝:", "□",
        "棄権:", "□",
        "両者署名:", "",
      ]);
      // カードの区切り (空行 2)
      rows.push([]);
      rows.push([]);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    // 列幅
    ws["!cols"] = [
      { wch: 12 }, { wch: 8 }, { wch: 18 }, { wch: 16 },
      { wch: 10 }, { wch: 8 }, { wch: 18 }, { wch: 14 },
    ];
    // 印刷設定: 横方向 (A4 横、上下マージン小)
    ws["!pageSetup"] = {
      orientation: "landscape",
      paperSize: 9, // A4
      fitToWidth: 1,
      fitToHeight: 0,
    };
    // セルに罫線適用 (試合カード範囲)
    rows.forEach((row, ri) => {
      if (!row || !row.length) return;
      // 0-indexed ri は AOA の行番号、シートでは ri 行
      for (let ci = 0; ci < 8; ci++) {
        const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
        const cell = ws[addr];
        if (cell) {
          cell.s = cell.s || {};
          cell.s.border = borderAll;
          cell.s.alignment = { vertical: "center", wrapText: true };
        }
      }
    });

    // シート名は 30 文字以内
    const sheetName = (eventName || "対戦票").slice(0, 30);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true });
}

// ═══════════════════════════════════════════════════════
// チーム結果まとめ (監督向け・A4 印刷用 HTML) #291
//   roster: 監督のマイ選手 [{id,name,furigana,team,branch}]
//   matches: getMatchesByTournament の結果行 (winner/loser ベース)
// ═══════════════════════════════════════════════════════
function _crNorm(s) { return String(s == null ? "" : s).replace(/[\s　]/g, ""); }
function _crSplit(s) { return String(s == null ? "" : s).split(/\s*[\/／・]\s*/).map(x => _crNorm(x)).filter(Boolean); }

function buildCoachResultsHTML(coach, tournament, roster, matches, opts) {
  opts = opts || {};
  const logoPath = escapeHtml(opts.logo_url || "/shared/assets/icon-192.png");   // src展開のためエスケープ(反射XSS防止)
  coach = coach || {}; tournament = tournament || {}; roster = roster || []; matches = matches || [];
  const teamName = coach.team || "";
  const dateStr = _jaLongDate(tournament.date);
  const nowStr = new Date().toLocaleString("ja-JP", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

  // 実際に行われた試合のみ (BYE/不戦勝は除外)
  const played = matches.filter(m => m && m.winner_name && m.loser_name
    && m.winner_name !== "BYE" && m.loser_name !== "BYE" && !Number(m.is_walkover));
  const resultOf = (m, p) => {
    const pid = p.id, pn = _crNorm(p.name);
    const winHit = (pid && m.winner_id === pid) || (pn && _crSplit(m.winner_name).includes(pn));
    const lossHit = (pid && m.loser_id === pid) || (pn && _crSplit(m.loser_name).includes(pn));
    if (winHit) return "win";
    if (lossHit) return "loss";
    return null;
  };

  let teamW = 0, teamL = 0, playedCount = 0;
  const rows = roster.map(p => {
    const ms = [];
    played.forEach(m => {
      const r = resultOf(m, p);
      if (!r) return;
      const opp = r === "win" ? m.loser_name : m.winner_name;
      const oppTeam = r === "win" ? (m.loser_team || "") : (m.winner_team || "");
      const score = (m.winner_sets != null && m.loser_sets != null)
        ? (r === "win" ? m.winner_sets + "-" + m.loser_sets : m.loser_sets + "-" + m.winner_sets) : "";
      ms.push({ result: r, opponent: opp, oppTeam, score, event: m.event || "", round: m.round || "" });
    });
    const w = ms.filter(x => x.result === "win").length;
    const l = ms.filter(x => x.result === "loss").length;
    return { player: p, matches: ms, w, l };
  });
  rows.sort((a, b) => String(a.player.furigana || a.player.name).localeCompare(String(b.player.furigana || b.player.name), "ja"));

  // 団体集計タイル(勝/敗/総試合数)は試合ID単位で重複排除する。ダブルスで相方2名が
  // ともに名簿に居ると同一試合が2回計上され水増しされるため(個人行は各自の記録なので別)。
  {
    const teamByMatch = new Map();
    played.forEach(m => {
      for (const p of roster) {
        const r = resultOf(m, p);
        if (!r) continue;
        if (!teamByMatch.has(m.id)) teamByMatch.set(m.id, new Set());
        teamByMatch.get(m.id).add(r);
      }
    });
    for (const set of teamByMatch.values()) { playedCount++; if (set.has("win")) teamW++; if (set.has("loss")) teamL++; }
  }

  const playerBlocks = rows.map(row => {
    const p = row.player;
    const head = `<div class="pl-head">
        <div class="pl-name">${escapeHtml(p.name || "")}${p.furigana ? `<span class="pl-furi">${escapeHtml(p.furigana)}</span>` : ""}</div>
        <div class="pl-rec">${row.matches.length ? `${row.w}勝 ${row.l}敗` : "出場記録なし"}</div>
      </div>`;
    if (!row.matches.length) return `<div class="pl-block">${head}</div>`;
    const trs = row.matches.map(mm => `<tr>
        <td class="c-res ${mm.result}">${mm.result === "win" ? "勝" : "敗"}</td>
        <td class="c-opp">${escapeHtml(mm.opponent || "")}${mm.oppTeam ? `<span class="c-team">${escapeHtml(mm.oppTeam)}</span>` : ""}</td>
        <td class="c-score">${escapeHtml(mm.score || "")}</td>
        <td class="c-event">${escapeHtml(mm.event || "")}</td>
      </tr>`).join("");
    return `<div class="pl-block">${head}
      <table class="pl-table"><thead><tr><th>結果</th><th>対戦相手</th><th>スコア</th><th>種目</th></tr></thead><tbody>${trs}</tbody></table>
    </div>`;
  }).join("");

  const total = teamW + teamL;
  const winRate = total > 0 ? Math.round((teamW / total) * 100) : 0;

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>チーム結果まとめ ${escapeHtml(teamName || coach.name || "")}</title>
<style>
  /* 外部フォント@import撤去: BIZ UDPGothic はシステム同梱/Hiragino等で代替(オフライン整合) */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'BIZ UDPGothic', sans-serif; background: #eef1f6; color: #1a2233; }
  .toolbar { background: #1e2a4a; color: #fff; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
  .toolbar .t { font-size: 15px; font-weight: 700; }
  .toolbar button { background: #fff; color: #1e2a4a; border: none; padding: 8px 22px; border-radius: 6px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .page { width: 210mm; min-height: 297mm; margin: 12px auto; background: #fff; padding: 16mm 14mm; box-shadow: 0 2px 10px rgba(0,0,0,.12); }
  .head-band { display: flex; align-items: center; gap: 12px; border-bottom: 3px solid #1e2a4a; padding-bottom: 10px; margin-bottom: 6px; }
  .head-band img { width: 46px; height: 46px; object-fit: contain; }
  .hb-main { flex: 1; }
  .hb-title { font-size: 22px; font-weight: 700; letter-spacing: .04em; }
  .hb-sub { font-size: 13px; color: #475569; margin-top: 2px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 22px; font-size: 13px; color: #334155; margin: 8px 0 4px; }
  .meta b { color: #1e2a4a; }
  .summary { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0 18px; }
  .sum-tile { background: #f1f5f9; border-radius: 10px; padding: 10px 18px; text-align: center; min-width: 92px; }
  .sum-tile .n { font-size: 24px; font-weight: 700; color: #1e2a4a; }
  .sum-tile .l { font-size: 11px; color: #64748b; margin-top: 2px; }
  .pl-block { margin-bottom: 14px; break-inside: avoid; }
  .pl-head { display: flex; justify-content: space-between; align-items: baseline; border-left: 5px solid #1e2a4a; padding: 4px 0 4px 10px; background: #f8fafc; }
  .pl-name { font-size: 16px; font-weight: 700; }
  .pl-furi { font-size: 11px; color: #64748b; margin-left: 8px; font-weight: 400; }
  .pl-rec { font-size: 14px; font-weight: 700; color: #1e2a4a; padding-right: 8px; }
  .pl-table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 13px; }
  .pl-table th { background: #1e2a4a; color: #fff; font-weight: 700; padding: 4px 8px; text-align: left; font-size: 11px; }
  .pl-table td { border-bottom: 1px solid #e2e8f0; padding: 4px 8px; }
  .c-res { width: 40px; text-align: center; font-weight: 700; }
  .c-res.win { color: #15803d; } .c-res.loss { color: #b91c1c; }
  .c-team { font-size: 10px; color: #94a3b8; margin-left: 6px; }
  .c-score { width: 64px; font-variant-numeric: tabular-nums; }
  .c-event { color: #475569; }
  .empty { padding: 30px; text-align: center; color: #94a3b8; }
  .foot { margin-top: 18px; padding-top: 8px; border-top: 1px solid #cbd5e1; font-size: 11px; color: #94a3b8; text-align: right; }
  @media print { body { background: #fff; } .toolbar { display: none; } .page { box-shadow: none; margin: 0; width: auto; min-height: auto; padding: 10mm; } }
</style></head><body>
<div class="toolbar"><span class="t">チーム結果まとめ</span><button onclick="window.print()">印刷 / PDF保存</button></div>
<div class="page">
  <div class="head-band">
    <img src="${logoPath}" alt="">
    <div class="hb-main">
      <div class="hb-title">チーム結果まとめ</div>
      <div class="hb-sub">${escapeHtml(tournament.name || "")}</div>
    </div>
  </div>
  <div class="meta">
    ${teamName ? `<span><b>チーム</b> ${escapeHtml(teamName)}</span>` : ""}
    <span><b>監督・顧問</b> ${escapeHtml(coach.name || "")}</span>
    ${dateStr ? `<span><b>開催日</b> ${escapeHtml(dateStr)}</span>` : ""}
    <span><b>登録選手</b> ${roster.length}名</span>
  </div>
  <div class="summary">
    <div class="sum-tile"><div class="n">${roster.length}</div><div class="l">マイ選手</div></div>
    <div class="sum-tile"><div class="n">${teamW}</div><div class="l">勝</div></div>
    <div class="sum-tile"><div class="n">${teamL}</div><div class="l">敗</div></div>
    <div class="sum-tile"><div class="n">${winRate}%</div><div class="l">勝率</div></div>
    <div class="sum-tile"><div class="n">${playedCount}</div><div class="l">総試合数</div></div>
  </div>
  ${rows.length ? playerBlocks : '<div class="empty">登録選手がいません。</div>'}
  <div class="foot">釧路卓球協会 大会運営システム ・ 出力: ${escapeHtml(nowStr)}（不戦勝・不戦敗は集計に含みません）</div>
</div>
</body></html>`;
}

// ─── 申込台帳 (フラット一覧) Excel 出力 ───
// Google フォーム → スプレッドシート の代替。1行 = 1申込(エントリー)。
// 申込をプラットフォームに集約し、そのまま Excel で配布/保管できるようにする。
function buildApplicantsXlsx(tournament, entrants, opts) {
  opts = opts || {};
  const GENDER = { male: "男子", female: "女子" };
  const CAT = { general: "一般", high: "高校", middle: "中学", elementary: "小学",
                university: "大学", senior: "シニア", junior: "ジュニア", youth: "ユース", large: "ラージ" };
  const STATUS = { confirmed: "確定", pending: "受付中", cancelled: "取消", withdrawn: "棄権", rejected: "却下" };
  const header = ["No", "申込団体", "氏名", "ふりがな", "種目", "性別", "区分",
                  "ダブルス相方", "相方所属", "状態", "申込日時", "備考(連絡先等)"];
  const sorted = [...(entrants || [])].sort((a, b) =>
    String(a.team || "").localeCompare(String(b.team || ""), "ja") ||
    String(a.event || "").localeCompare(String(b.event || ""), "ja") ||
    String(a.furigana || a.name || "").localeCompare(String(b.furigana || b.name || ""), "ja"));
  const rows = [header];
  sorted.forEach((e, i) => {
    rows.push([
      i + 1,
      e.team || "",
      e.display_name || e.name || "",
      e.furigana || "",
      e.event || "",
      GENDER[e.gender] || e.gender || "",
      CAT[e.category] || e.category || "",
      e.is_doubles ? (e.partner_name || "") : "",
      e.is_doubles ? (e.partner_team || "") : "",
      STATUS[e.status] || e.status || "",
      String(e.applied_at || e.created_at || "").slice(0, 16),
      // Phase4: 連絡先は構造化列(contact_*)へ移行。旧データは note にフォールバック。
      [[e.contact_name, e.contact_email, e.contact_tel].filter(Boolean).join(" / "), e.note]
        .filter(Boolean).join(" | "),
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 5 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 6 },
                 { wch: 8 }, { wch: 14 }, { wch: 18 }, { wch: 8 }, { wch: 18 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "申込一覧");
  const meta = [
    ["大会名", tournament.name || ""],
    ["開催日", tournament.date || ""],
    ["会場", tournament.venue || ""],
    ["申込件数", (entrants || []).length],
    ["出力日時", new Date().toLocaleString("ja-JP")],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), "大会情報");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ═══════════════════════════════════════════════════════
// トーナメント表(両山)Excel 出力 — for_mac.xls の「トーナメント表/P1」レイアウト踏襲
//   ・両山(左右対向): 左半分は左→右へ、右半分は右→左へ勝ち上がり、中央が決勝。
//   ・1選手 = 縦2行(名前/所属/シードを2行結合)。アンカー行を再帰計算してペアを罫線で結ぶ。
//   ・下罫線 = 勝者の横線、縦罫線 = 上下2試合を結ぶ縦線、「ｂｙｅ」= 不戦勝枠。
//   ・結果が入っていれば勝者名を各試合の横線セルに記入(空なら手書き用の空欄)。
//   matches = getMatchesByTournament の行(bracket_round/bracket_pos/player*_name/winner_name/event 等)。
//   entrants = シード番号・選手番号(bracket_number)引き当て用。opts.event で1種目に絞れる。
// ═══════════════════════════════════════════════════════
function buildBracketXlsx(tournament, matches, entrants, opts) {
  // community版 xlsx(0.20.3)はセル罫線を書き出せない(有料機能)。両山ブラケットの罫線
  // (勝者横線・縦線)は表の生命線なので、この関数内だけ罫線対応の drop-in fork を使う。
  // 読み込み(.xls/.xlsx パーサ)や他の帳票は従来どおり 0.20.3 のまま=パーサに影響なし。
  const XLSX = require("xlsx-js-style");
  opts = opts || {};
  tournament = tournament || {};
  const seedByEntrant = new Map();
  const numByEntrant = new Map();
  const entById = new Map();
  (entrants || []).forEach(e => {
    entById.set(e.id, e);
    if ((parseInt(e.seed) || 0) >= 1) seedByEntrant.set(e.id, parseInt(e.seed));
    if ((parseInt(e.bracket_number) || 0) >= 1) numByEntrant.set(e.id, parseInt(e.bracket_number));
  });

  const wb = XLSX.utils.book_new();
  const thin = { style: "thin", color: { rgb: "000000" } };
  const thick = { style: "medium", color: { rgb: "000000" } };

  // event 別に bracket 試合を仕分け(リーグ=bracket_round null は除外)
  const byEvent = new Map();
  (matches || []).forEach(m => {
    if (m.bracket_round == null) return;
    const key = m.event || "(未分類)";
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(m);
  });
  let events = Array.from(byEvent.keys());
  if (opts.event) events = events.filter(e => e === opts.event);

  if (!events.length) {
    const ws = XLSX.utils.aoa_to_sheet([
      [tournament.name || "トーナメント表"], [""],
      ["トーナメント表がありません。先に抽選/生成してください。"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "トーナメント表");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  }

  const importRows = [];   // ラウンドトリップ取込用(機械可読): [event,bracket_pos,slot,entrant_id,seed,name,team,bye]
  events.forEach(eventName => {
    const list = byEvent.get(eventName);
    const round1 = list.filter(m => m.bracket_round === 1).sort((a, b) => (a.bracket_pos || 0) - (b.bracket_pos || 0));
    if (!round1.length) return;
    const S = round1.length * 2;
    const totalRounds = Math.max(1, Math.round(Math.log2(S)));
    const byRP = {};
    list.forEach(m => { byRP[m.bracket_round + "_" + m.bracket_pos] = m; });

    const TOP = 4;                                  // ヘッダ行ぶんのオフセット(0始まり行)

    // ── ブロック分割(紙面方式: 2026なごやか亭杯の組合せ表を踏襲) ──
    // 大規模ドロー(S≥256)は 128リーフ=1ブロック(Ａ/Ｂ/Ｃ/Ｄ…)を横に並べ、各ブロックを
    // 小さな両山(左レール/右レールの余白に 番号・選手名・所属)として描く。ブロック勝者
    // どうしの準決勝・決勝は下段に別描きする。S<256 は従来どおり1ブロック(全体で両山)。
    // SS大会(open種目)はＡ〜Ｄ4ブロック固定(抽選・画面と同じ)。それ以外は128リーフ=1ブロック。
    let evOpen = false;
    try {
      const cfg = typeof tournament.event_config === "string" ? JSON.parse(tournament.event_config || "[]") : (tournament.event_config || []);
      evOpen = !!(cfg.find(c => c && c.name === eventName) || {}).open;
    } catch (e) { evOpen = false; }
    const BL = (evOpen && S >= 16) ? S / 4 : (S >= 256 ? 128 : S);   // 1ブロックのリーフ数
    const nBlocks = S / BL;
    const blockRounds = Math.max(1, Math.round(Math.log2(BL)));   // ブロック内最終ラウンド(=ブロック勝者決定)
    const sideR = blockRounds - 1;                 // ブロック片山のラウンド数
    // 列レイアウト(ブロックごとに反復・間に1列スペーサ)
    //  左: 組番号/選手名/所属/シード → 左ラウンド横線(R1→中央) → CENTER → 右(鏡像)
    const BLOCK_COLS = 4 + sideR + 1 + sideR + 4;
    const colsOf = (b) => {
      const base = b * (BLOCK_COLS + 1);
      const CENTER = base + 4 + sideR;
      return {
        base, CENTER,
        L_NUM: base, L_NAME: base + 1, L_TEAM: base + 2, L_SEED: base + 3,
        R_SEED: CENTER + sideR + 1, R_TEAM: CENTER + sideR + 2,
        R_NAME: CENTER + sideR + 3, R_NUM: CENTER + sideR + 4,
        LADV: (r) => base + 4 + (r - 1),                 // 左 round r の横線列
        RADV: (r) => CENTER + (sideR - r + 1),           // 右 round r の横線列(中央寄りが大きいr)
      };
    };
    const lastCol = nBlocks * (BLOCK_COLS + 1) - 2;
    // 最終リーフの下端。S=2 等の退化(halfR1非整数で片側に2枚載る)でも切れないよう実配置から算出。
    let maxLeafBottom = TOP + 1;

    const ws = {};
    const merges = [];
    function put(r, c, v, style) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cur = ws[addr] || {};
      ws[addr] = { t: "s", v: v == null ? "" : String(v), s: Object.assign({}, cur.s, style) };
    }
    function border(r, c, edges) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] || { t: "s", v: "" };
      cell.s = cell.s || {};
      cell.s.border = Object.assign({}, cell.s.border, edges);
      ws[addr] = cell;
    }
    // 掲示物として読めるよう、規模に応じてフォントと列幅を縮め(物理的に小さくして印刷の収まりを改善)、
    // 氏名/所属は shrinkToFit で枠内に収める。等幅寄りの Meiryo(環境に無ければ既定にフォールバック)。
    // ※ Excel の印刷スケール(!pageSetup)は SheetJS が書き出せないため、内容自体を縮める方針。
    const FONT = "Meiryo";
    const nfsz = S <= 32 ? 10 : S <= 64 ? 9 : 8;       // 本文フォント(規模連動)
    const centerStyle = { alignment: { horizontal: "center", vertical: "center", wrapText: true, shrinkToFit: true }, font: { sz: nfsz, name: FONT } };
    const nameStyle = { alignment: { horizontal: "left", vertical: "center", wrapText: true, shrinkToFit: true }, font: { sz: nfsz, name: FONT } };

    // ── ヘッダ ──
    put(0, colsOf(0).L_NAME, tournament.name || "", { font: { bold: true, sz: 14 } });
    put(1, colsOf(0).L_NAME, eventName + "  トーナメント表", { font: { bold: true, sz: 12 } });
    put(0, colsOf(0).CENTER, _jaShortDate(tournament.date), centerStyle);
    put(1, colsOf(0).CENTER, tournament.venue || "", centerStyle);
    // ブロック見出し(Ａブロック/Ｂブロック…)。1ブロック構成では出さない(従来表示)。
    if (nBlocks > 1) for (let b = 0; b < nBlocks; b++) {
      put(2, colsOf(b).L_NAME, String.fromCharCode(0xFF21 + b) + "ブロック", { font: { bold: true, sz: 11 } });
    }

    // ── 紙式コンパクト配置: 実選手だけに行を割る(1選手=縦2行)。BYE は行を作らない ──
    // 紙のトーナメント表の作法: 1回戦がある選手は隣と「小さい山」で結び、不戦勝(BYE)の選手は
    // 行を消して「登場回戦まで1本の長い罫線」で延長する(大きい山=2回戦から登場)。
    // スーパーシード(entry_round>1)も同じ一般則(片親ノードの線延長)で自動的に最長の罫線になる
    // (旧placeSuperの特殊処理を一般化して置換)。_import シートは正準位置bye込みのまま=取込互換。
    const leafArr = new Array(S).fill(null);
    round1.forEach(m => {
      const p = m.bracket_pos || 0;
      [[1, m.player1_name, m.player1_team, m.player1_entrant_id],
       [2, m.player2_name, m.player2_team, m.player2_entrant_id]].forEach(([sk, nm, tm, eid]) => {
        if (nm && nm !== "BYE") leafArr[2 * p + (sk - 1)] = { name: nm, team: tm || "", eid };
      });
    });
    // 各サイドのレール行割当(実選手のみ連番・2行ずつ)。railLine[g] = 選手レール(下罫線)の行。
    const railLine = new Array(S).fill(null);
    const assignRails = (from, to) => {
      let row = TOP;
      for (let g = from; g < to; g++) {
        if (!leafArr[g]) continue;
        railLine[g] = row + 1;
        if (row + 1 > maxLeafBottom) maxLeafBottom = row + 1;
        row += 2;
      }
    };
    if (S === 2) assignRails(0, S);
    else for (let b = 0; b < nBlocks; b++) { assignRails(b * BL, b * BL + BL / 2); assignRails(b * BL + BL / 2, (b + 1) * BL); }

    // 選手リーフ描画(実選手のみ)。所属ブロックの左右レール余白に 番号/選手名/所属/シード を記載。
    function placeLeaf(lf, g) {
      const top = railLine[g] - 1;
      const C = colsOf(Math.floor(g / BL));
      const side = (S === 2 || (g % BL) < BL / 2) ? "L" : "R";
      const seed = lf.eid != null ? seedByEntrant.get(lf.eid) : null;
      const num = lf.eid != null ? numByEntrant.get(lf.eid) : null;
      const ent = lf.eid != null ? entById.get(lf.eid) : null;
      const isDbl = ent && (parseInt(ent.is_doubles) || 0) && (ent.partner_name || "");
      const NUM = side === "L" ? C.L_NUM : C.R_NUM, NAME = side === "L" ? C.L_NAME : C.R_NAME, TEAM = side === "L" ? C.L_TEAM : C.R_TEAM, SEED = side === "L" ? C.L_SEED : C.R_SEED;
      // 番号・シードは2行結合(縦中央)
      put(top, NUM, num || "", centerStyle);
      put(top, SEED, seed ? "[" + seed + "]" : "", centerStyle);
      merges.push({ s: { r: top, c: NUM }, e: { r: top + 1, c: NUM } });
      merges.push({ s: { r: top, c: SEED }, e: { r: top + 1, c: SEED } });
      if (isDbl) {
        // ダブルス: 上段=申込者(氏名+所属) / 下段=パートナー(氏名+所属)。所属併記で別クラブ混成も明示。
        put(top, NAME, ent.name || lf.name, nameStyle);
        put(top, TEAM, ent.team || lf.team, nameStyle);
        put(top + 1, NAME, ent.partner_name || "", nameStyle);
        put(top + 1, TEAM, ent.partner_team || "", nameStyle);
      } else {
        put(top, NAME, lf.name, nameStyle);
        put(top, TEAM, lf.team, nameStyle);
        merges.push({ s: { r: top, c: NAME }, e: { r: top + 1, c: NAME } });
        merges.push({ s: { r: top, c: TEAM }, e: { r: top + 1, c: TEAM } });
      }
      // 下罫線(選手レール): 名前〜シード列(山により左右)
      const ra = side === "L" ? C.L_NAME : C.R_SEED, rb = side === "L" ? C.L_SEED : C.R_NAME;
      for (let c = Math.min(ra, rb); c <= Math.max(ra, rb); c++) border(top + 1, c, { bottom: thin });
    }
    for (let g = 0; g < S; g++) {
      if (!leafArr[g]) continue;
      placeLeaf(leafArr[g], g);
    }
    // _import 用(取込)は正準位置(bye込み)のまま出力=ラウンドトリップ取込互換。
    round1.forEach(m => {
      const p = m.bracket_pos || 0;
      [1, 2].forEach(sk => {
        const nm = sk === 1 ? (m.player1_name || "") : (m.player2_name || "");
        const tm = sk === 1 ? (m.player1_team || "") : (m.player2_team || "");
        const eid = sk === 1 ? m.player1_entrant_id : m.player2_entrant_id;
        const bye = (!nm || nm === "BYE") ? 1 : 0;
        const seed = (eid != null && seedByEntrant.has(eid)) ? seedByEntrant.get(eid) : "";
        importRows.push([eventName, p, sk, eid || "", seed, bye ? "" : nm, bye ? "" : tm, bye]);
      });
    });
    // ── 山の罫線(勝者横線・縦線・勝者名)をグラフベースで構築 ──
    // next_match_id/next_slot という実配線を辿って描く(位置演算ではない)。両子が実在: 通常の
    // 山(縦線+勝者横線)。片子のみ: 線をそのまま次列へ延長(=不戦勝の長い罫線)。子なし(BYE同士):
    // 何も描かない。自由配線編集(relinkBracketMatch)後もこのまま正しく描ける(admin SVG描画
    // renderPaperBracketのbuildBlockElと同一アルゴリズム)。
    const incomingOf = new Map();   // "matchId:slot" -> 試合(この種目全体・全ブロック共通)
    list.forEach(m => { if (m.next_match_id) incomingOf.set(m.next_match_id + ":" + (m.next_slot || 1), m); });
    const matchState = new Map();   // matchId -> row(数値) | null
    // 1回戦の中間点を計算し、blockRounds>=2ならLADV(1)/RADV(1)列にも罫線・勝者名を描画する
    // (blockRounds===1は1回戦=ブロック決勝そのものなのでbuildSideLinesのsideR===0特殊ケースに譲る)。
    const r1PerBlock = BL / 2, r1Half = r1PerBlock / 2;
    round1.forEach(m => {
      const p = m.bracket_pos || 0;
      const y1 = railLine[2 * p], y2 = railLine[2 * p + 1];
      let row = null;
      if (y1 != null && y2 != null) row = Math.round((y1 + y2) / 2);
      else if (y1 != null || y2 != null) row = (y1 != null ? y1 : y2);
      matchState.set(m.id, row);
      if (row == null || blockRounds < 2) return;
      const bBlk = Math.floor(p / r1PerBlock);
      const base = bBlk * r1PerBlock;
      const side = (p - base) < r1Half ? "L" : "R";
      const col = side === "L" ? colsOf(bBlk).LADV(1) : colsOf(bBlk).RADV(1);
      if (y1 != null && y2 != null) {
        const vEdge = side === "L" ? { left: thin } : { right: thin };
        for (let rw = Math.min(y1, y2) + 1; rw <= Math.max(y1, y2); rw++) border(rw, col, vEdge);
        border(row, col, { bottom: thin });
        // 勝者名(結果が入っていれば)。不戦勝(片方のみ存在)の素通しは、リーフに既に本人の
        // 名前があるので二重記載を避け、線の延長のみ(下のelseと同じ=名前は書かない)。
        if (m.status === "completed" && m.winner_name && m.winner_name !== "BYE") {
          put(row, col, m.winner_name, nameStyle);
          border(row, col, { bottom: thin });
        }
      } else {
        border(row, col, { bottom: thin });   // 線の延長のみ(紙の「大きい罫線」)
      }
    });
    // 2回戦〜ブロック準決勝(bracket_round=2..blockRounds-1)を回戦昇順・全ブロック一括で処理。
    // 「回戦前進」の不変条件(next_match_idは常に直後の回戦を指す)により、昇順処理だけで
    // 入力が必ず揃う(トポロジカルソート不要)。
    for (let r = 2; r < blockRounds; r++) {
      const perBlock = BL / Math.pow(2, r), half = perBlock / 2;
      list.filter(m => m.bracket_round === r).forEach(m => {
        const pos = m.bracket_pos || 0;
        const bBlk = Math.floor(pos / perBlock);
        const base = bBlk * perBlock;
        const side = (pos - base) < half ? "L" : "R";
        const col = side === "L" ? colsOf(bBlk).LADV(r) : colsOf(bBlk).RADV(r);
        const src1 = incomingOf.get(m.id + ":1"), src2 = incomingOf.get(m.id + ":2");
        const a = src1 ? matchState.get(src1.id) : null, bb = src2 ? matchState.get(src2.id) : null;
        if (a != null && bb != null) {
          const row = Math.round((a + bb) / 2);
          border(row, col, { bottom: thin });
          const vEdge = side === "L" ? { left: thin } : { right: thin };
          for (let rw = Math.min(a, bb) + 1; rw <= Math.max(a, bb); rw++) border(rw, col, vEdge);
          // 勝者名(結果が入っていれば)。不戦勝の素通し(片子)には書かない。
          if (m.status === "completed" && m.winner_name && m.winner_name !== "BYE") {
            put(row, col, m.winner_name, nameStyle);
            border(row, col, { bottom: thin });
          }
          matchState.set(m.id, row);
        } else if (a != null || bb != null) {
          const row = a != null ? a : bb;
          border(row, col, { bottom: thin });   // 線の延長(紙の「大きい罫線」)
          matchState.set(m.id, row);
        } else {
          matchState.set(m.id, null);
        }
      });
    }
    function buildSideLines(b, side) {
      if (sideR === 0) {
        // blockRounds===1: 1回戦の唯一の試合=ブロック決勝そのもの。このサイドのリーフの行を
        // 直接返す(2つのリーフが中央joinでV字合流する。admin SVG描画と同じ特別扱い)。
        const from = b * BL + (side === "L" ? 0 : BL / 2);
        for (let g = from; g < from + BL / 2; g++) if (railLine[g] != null) return railLine[g];
        return null;
      }
      // このブロック・このサイドの最終回戦(blockRounds-1回戦)の該当試合の状態を返す
      const finalR = blockRounds - 1;
      const perBlock = BL / Math.pow(2, finalR), half = perBlock / 2;
      const base = b * perBlock + (side === "L" ? 0 : half);
      const m = list.find(x => x.bracket_round === finalR && (x.bracket_pos || 0) >= base && (x.bracket_pos || 0) < base + half);
      return m ? matchState.get(m.id) : null;
    }

    // ── ブロック中央線(1ブロック時=決勝線 / 複数ブロック時=ブロック勝者線) ──
    const centerNodes = [];
    if (S > 2) for (let b = 0; b < nBlocks; b++) {
      const C = colsOf(b);
      const aL = buildSideLines(b, "L");
      const aR = buildSideLines(b, "R");
      let row = null;
      if (aL != null && aR != null) row = Math.round((aL + aR) / 2);
      else if (aL != null || aR != null) row = (aL != null ? aL : aR);
      if (row != null) {
        border(row, C.CENTER, { bottom: nBlocks === 1 ? thick : thin });
        // コンパクト詰めで左右の山の高さが違うときは、中央線へ縦線で接続する(紙の中央join)
        if (aL != null && aL !== row) for (let rw = Math.min(aL, row) + 1; rw <= Math.max(aL, row); rw++) border(rw, C.CENTER, { left: thin });
        if (aR != null && aR !== row) for (let rw = Math.min(aR, row) + 1; rw <= Math.max(aR, row); rw++) border(rw, C.CENTER, { right: thin });
        // ブロック勝者名(複数ブロック時のみ。1ブロック時の優勝は下で別記)
        const bm = byRP[blockRounds + "_" + b];
        if (nBlocks > 1 && bm && bm.status === "completed" && bm.winner_name && bm.winner_name !== "BYE") {
          put(row, C.CENTER, bm.winner_name, nameStyle);
          border(row, C.CENTER, { bottom: thin });
        }
      }
      centerNodes.push({ col: C.CENTER, row });
    }

    // ── 決勝まわり ──
    const finalMatch = byRP[totalRounds + "_0"];
    let lastRow = maxLeafBottom;   // 表の最下行(下段トーナメントで伸びる)
    if (nBlocks === 1) {
      let finalAnchor = (centerNodes.length && centerNodes[0].row != null) ? centerNodes[0].row : null;
      if (finalAnchor == null) {
        // S=2 等の退化: レール行から直接決勝線の高さを決める
        const rl = railLine.filter(v => v != null);
        finalAnchor = rl.length >= 2 ? Math.round((rl[0] + rl[rl.length - 1]) / 2) : TOP + 1;
        border(finalAnchor, colsOf(0).CENTER, { bottom: thick });
      }
      put(2, colsOf(0).CENTER, "決勝", Object.assign({ font: { bold: true, sz: 11 } }, centerStyle));
      if (finalMatch && finalMatch.status === "completed" && finalMatch.winner_name && finalMatch.winner_name !== "BYE") {
        put(finalAnchor, colsOf(0).CENTER, "優勝: " + finalMatch.winner_name, Object.assign({ font: { bold: true, sz: 11 } }, centerStyle));
        border(finalAnchor, colsOf(0).CENTER, { bottom: thick });
      }
    } else {
      // ── 下段: ブロック勝者どうしのトーナメント(準決勝・決勝。紙面の下側に別描き=紙の方式) ──
      let nodes = centerNodes.map(n => ({ col: n.col, row: n.row != null ? n.row : maxLeafBottom }));
      let r = blockRounds + 1;
      let joinRow = maxLeafBottom + 3;
      while (nodes.length > 1) {
        const label = nodes.length === 2 ? "決勝" : nodes.length === 4 ? "準決勝" : nodes.length === 8 ? "準々決勝" : (r + "回戦");
        const nxt = [];
        for (let q = 0; q * 2 < nodes.length; q++) {
          const a = nodes[2 * q], c = nodes[2 * q + 1];
          // 各ブロック勝者線から下へ縦線 → joinRow の横線で結ぶ
          for (let rw = a.row + 1; rw <= joinRow; rw++) border(rw, a.col, { left: thin });
          for (let rw = c.row + 1; rw <= joinRow; rw++) border(rw, c.col, { left: thin });
          for (let col = a.col; col < c.col; col++) border(joinRow, col, { bottom: thin });
          const mid = Math.round((a.col + c.col) / 2);
          const mm = byRP[r + "_" + q];
          if (mm && mm.status === "completed" && mm.winner_name && mm.winner_name !== "BYE") {
            put(joinRow, mid, (nodes.length === 2 ? "優勝: " : "") + mm.winner_name,
              Object.assign({}, nameStyle, nodes.length === 2 ? { font: { bold: true, sz: 11, name: FONT } } : null));
          }
          nxt.push({ col: mid, row: joinRow });
        }
        put(joinRow - 1, Math.max(0, nxt[0].col - 2), "（" + label + "）", { font: { sz: 9, name: FONT } });
        lastRow = Math.max(lastRow, joinRow + 1);
        nodes = nxt;
        r++;
        joinRow += 3;
      }
    }

    // ── 抽選メタの刻印(トレーサビリティ: 記録ID・実施者・日時) ──
    if (opts.draw_meta && opts.draw_meta.draw_seed != null) {
      const dm = opts.draw_meta;
      put(lastRow + 1, colsOf(0).L_NAME, `抽選 記録ID:${dm.draw_seed}` + (dm.drawn_by ? ` ・実施:${dm.drawn_by}` : "") + (dm.drawn_at ? ` ・${dm.drawn_at}` : ""),
        { font: { sz: 8, name: "Meiryo", color: { rgb: "64748B" } }, alignment: { horizontal: "left" } });
    }

    // ── 列幅(規模連動で圧縮: 大きいドローほど狭く。複数ブロック時は横線列をさらに絞る) ──
    const wName = S <= 32 ? 14 : S <= 64 ? 11 : 9;
    const wTeam = S <= 32 ? 11 : S <= 64 ? 9 : 7;
    const wAdv = nBlocks > 1 ? 5 : (S <= 32 ? 11 : S <= 64 ? 9 : 7);
    const cols = [];
    for (let b = 0; b < nBlocks; b++) {
      const C = colsOf(b);
      cols[C.L_NUM] = { wch: 4 }; cols[C.L_NAME] = { wch: wName }; cols[C.L_TEAM] = { wch: wTeam }; cols[C.L_SEED] = { wch: 4 };
      for (let r = 1; r <= sideR; r++) { cols[C.LADV(r)] = { wch: wAdv }; cols[C.RADV(r)] = { wch: wAdv }; }
      cols[C.CENTER] = { wch: wName };
      cols[C.R_SEED] = { wch: 4 }; cols[C.R_TEAM] = { wch: wTeam }; cols[C.R_NAME] = { wch: wName }; cols[C.R_NUM] = { wch: 4 };
      if (b < nBlocks - 1) cols[C.R_NUM + 1] = { wch: 2 };   // ブロック間スペーサ
    }
    for (let c = 0; c <= lastCol; c++) if (!cols[c]) cols[c] = { wch: 7 };

    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow + 1, c: lastCol } });
    ws["!cols"] = cols;
    ws["!merges"] = merges;
    // 印刷の規模連動: 小はA4横、64名級以上はA3横+縮小で掲示物として読めるようにする。
    //  ※ fitToWidth と scale を併用すると scale が無効化される(SheetJS仕様)ため scale 固定のみ。
    //    ブロック横並び(複数ブロック)は紙面が広いのでさらに縮小(掲示はA2以上への拡大印刷も想定)。
    const paperSize = S <= 16 ? 9 : 8;                 // 9=A4, 8=A3
    const scale = nBlocks >= 4 ? 22 : nBlocks === 2 ? 30
      : (S <= 16 ? 92 : S <= 32 ? 78 : S <= 64 ? 62 : S <= 128 ? 46 : 36);
    ws["!pageSetup"] = { orientation: "landscape", paperSize, scale, fitToHeight: 0 };
    ws["!margins"] = { left: 0.3, right: 0.3, top: 0.45, bottom: 0.4, header: 0.2, footer: 0.2 };
    XLSX.utils.book_append_sheet(wb, ws, (eventName || "表").slice(0, 30));
  });

  // ラウンドトリップ取込用シート(_import): 手修正後に再取込して『位置だけ』差分更新するための
  // 機械可読データ。視覚チャート(各種目シート)は人間用に残す。編集は禁止(編集はチャート側で)。
  if (importRows.length) {
    const imp = [
      ["__KTTA_BRACKET_IMPORT__", "v1", "このシートは取込用データです。編集しないでください(組合せの手修正はトーナメント表シートで)。"],
      ["event", "bracket_pos", "slot", "entrant_id", "seed", "name", "team", "bye"],
    ].concat(importRows);
    const impWs = XLSX.utils.aoa_to_sheet(imp);
    impWs["!cols"] = [{ wch: 16 }, { wch: 10 }, { wch: 5 }, { wch: 16 }, { wch: 5 }, { wch: 14 }, { wch: 11 }, { wch: 4 }];
    XLSX.utils.book_append_sheet(wb, impWs, "_import");
  }

  if (!wb.SheetNames.length) {
    const ws = XLSX.utils.aoa_to_sheet([[tournament.name || "トーナメント表"], [""], ["有効なブラケットがありません。"]]);
    XLSX.utils.book_append_sheet(wb, ws, "トーナメント表");
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true });
}

module.exports = {
  buildAggregationXlsx,
  buildApplicantsXlsx,
  buildReceiptsHTML,
  buildReceiptsXlsx,
  buildReceiptsList,
  buildMatchCardsXlsx,
  buildBracketXlsx,
  buildCoachResultsHTML,
  classifyEvent, genderOf,
  buildAggregation, feesFromEventConfig,   // テスト用に公開 (#17)
};
