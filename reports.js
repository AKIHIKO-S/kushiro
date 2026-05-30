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
    elementary: "小学", senior: "シニア", junior: "ジュニア",
    youth: "ユース", large: "ラージ",
  }[cat] || "一般";
  const gLabel = g === "female" ? "女子" : g === "male" ? "男子" : "混合";
  return catLabel + gLabel;
}

// 大会の出場選手から集計データを構築
function buildAggregation(tournament, entrants, fees) {
  // 団体名でグルーピング (チーム名 ≒ 申込団体名 として扱う)
  const byTeam = new Map();
  entrants.forEach(e => {
    // ダブルスは申込者(player1)の所属に「ペア1組=1件」で計上する(別所属パートナーの団体には課金しない=ペア単位課金。協会確定ポリシー 2026-05-30 QA)
    const records = [];
    records.push({
      team: e.team || "(無所属)",
      kind: classifyEvent(e.event),
      gender: genderOf(e.event, e),
      event_name: e.event,
      name: e.name,
      partner_name: e.partner_name || "",
      partner_team: e.partner_team || e.team,
      is_doubles: !!e.is_doubles,
    });
    if (!byTeam.has(records[0].team)) byTeam.set(records[0].team, []);
    byTeam.get(records[0].team).push(records[0]);
  });

  // 単価 (テンプレ由来 or fees パラメータ)
  const F = Object.assign({
    team_male: 1000, team_female: 1000,
    doubles_male: 1000, doubles_female: 1000,
    mixed_male: 1000, mixed_female: 1000,
    singles_male: 700, singles_female: 700,
    bento: 800, party: 3500,
  }, fees || {});

  return { teams: byTeam, fees: F };
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
  Array.from(teams.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .forEach(([teamName, members]) => {
      const cnt = {
        team_male: 0, team_female: 0,
        doubles_male: 0, doubles_female: 0,
        mixed_male: 0, mixed_female: 0,
        singles_male: 0, singles_female: 0,
      };
      members.forEach(m => {
        const g = m.gender === "female" ? "female" : "male";
        const key = `${m.kind}_${g}`;
        if (cnt[key] !== undefined) cnt[key]++;
      });
      const sum =
        cnt.team_male * F.team_male + cnt.team_female * F.team_female +
        cnt.doubles_male * F.doubles_male + cnt.doubles_female * F.doubles_female +
        cnt.mixed_male * F.mixed_male + cnt.mixed_female * F.mixed_female +
        cnt.singles_male * F.singles_male + cnt.singles_female * F.singles_female;
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
  Array.from(teams.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
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
  Array.from(teams.entries()).sort((a,b) => a[0].localeCompare(b[0], "ja"))
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
  Array.from(teams.entries()).sort((a,b) => a[0].localeCompare(b[0], "ja"))
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
  Array.from(teams.entries()).sort((a,b) => a[0].localeCompare(b[0], "ja"))
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
  const sealPath = opts.seal_url || "/shared/assets/seal.png";
  const logoPath = opts.logo_url || "/shared/assets/icon-192.png";   // 協会ロゴ (#272)
  const issuer = opts.issuer || "釧路卓球協会";
  const president = opts.president || "会長  山本 満";
  const startNo = parseInt(opts.start_no) > 0 ? parseInt(opts.start_no) : 1;
  const dateStr = tournament.date
    ? new Date(tournament.date).toLocaleDateString("ja-JP", { year:"numeric", month:"long", day:"numeric" })
    : "";

  // 各団体の合計を計算
  const items = [];
  Array.from(teams.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .forEach(([teamName, members]) => {
      let sum = 0;
      const breakdown = [];
      const cnt = { team_male:0, team_female:0, doubles_male:0, doubles_female:0,
                    mixed_male:0, mixed_female:0, singles_male:0, singles_female:0 };
      members.forEach(m => {
        const g = m.gender === "female" ? "female" : "male";
        const k = `${m.kind}_${g}`;
        if (cnt[k] !== undefined) cnt[k]++;
      });
      const KIND_LABEL_HTML = {
        team_male: "団体戦男子", team_female: "団体戦女子",
        doubles_male: "ダブルス男子", doubles_female: "ダブルス女子",
        mixed_male: "混合ダブルス男子", mixed_female: "混合ダブルス女子",
        singles_male: "シングルス男子", singles_female: "シングルス女子",
      };
      Object.entries(cnt).forEach(([k, n]) => {
        if (n > 0) {
          const fee = F[k] || 0;
          const sub = n * fee;
          sum += sub;
          breakdown.push({ label: KIND_LABEL_HTML[k], n, fee, sub });
        }
      });
      items.push({ team: teamName, total: sum, breakdown });
    });

  // 個別発行: 指定団体だけに絞る (#272)。未指定なら全団体一括。
  const shown = opts.only_team ? items.filter(it => it.team === opts.only_team) : items;

  // HTML 構築
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>領収書 ${escapeHtml(tournament.name || "")}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&display=swap');
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
  const serialNo = (startNo || 1) + i;
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
  const dateStr = tournament.date
    ? new Date(tournament.date).toLocaleDateString("ja-JP", { year:"numeric", month:"long", day:"numeric" })
    : "";

  const wb = XLSX.utils.book_new();
  const KIND_LABEL = {
    team_male: "団体戦男子", team_female: "団体戦女子",
    doubles_male: "ダブルス男子", doubles_female: "ダブルス女子",
    mixed_male: "混合ダブルス男子", mixed_female: "混合ダブルス女子",
    singles_male: "シングルス男子", singles_female: "シングルス女子",
  };

  // ── 一覧シート ──
  const summaryRows = [
    [tournament.name || "", null, null, dateStr],
    [],
    ["No.", "団体名", "合計金額", "発行日"],
  ];
  const teamItems = [];
  let no = 1;
  Array.from(teams.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .forEach(([teamName, members]) => {
      const cnt = { team_male:0, team_female:0, doubles_male:0, doubles_female:0,
                    mixed_male:0, mixed_female:0, singles_male:0, singles_female:0 };
      members.forEach(m => {
        const g = m.gender === "female" ? "female" : "male";
        const k = `${m.kind}_${g}`;
        if (cnt[k] !== undefined) cnt[k]++;
      });
      const breakdown = [];
      let sum = 0;
      Object.entries(cnt).forEach(([k, n]) => {
        if (n > 0) {
          const fee = F[k] || 0;
          const sub = n * fee;
          sum += sub;
          breakdown.push({ label: KIND_LABEL[k], n, fee, sub });
        }
      });
      teamItems.push({ no: no++, team: teamName, total: sum, breakdown });
      summaryRows.push([no - 1, teamName, sum, dateStr]);
    });
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
  const KIND_LABEL = {
    team_male: "団体戦男子", team_female: "団体戦女子",
    doubles_male: "ダブルス男子", doubles_female: "ダブルス女子",
    mixed_male: "混合ダブルス男子", mixed_female: "混合ダブルス女子",
    singles_male: "シングルス男子", singles_female: "シングルス女子",
  };
  const items = [];
  let no = 1;
  Array.from(teams.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .forEach(([teamName, members]) => {
      const cnt = { team_male:0, team_female:0, doubles_male:0, doubles_female:0,
                    mixed_male:0, mixed_female:0, singles_male:0, singles_female:0 };
      members.forEach(m => {
        const g = m.gender === "female" ? "female" : "male";
        const k = `${m.kind}_${g}`;
        if (cnt[k] !== undefined) cnt[k]++;
      });
      const breakdown = [];
      let sum = 0;
      Object.entries(cnt).forEach(([k, n]) => {
        if (n > 0) {
          const fee = F[k] || 0;
          const sub = n * fee;
          sum += sub;
          breakdown.push({ label: KIND_LABEL[k], n, fee, sub });
        }
      });
      items.push({ no: no++, team: teamName, total: sum, breakdown });
    });
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
      tournament.date ? new Date(tournament.date).toLocaleDateString("ja-JP") : "",
      "", "", "",
    ]);
    rows.push(["対戦票 (審判用記録票) — " + eventName, "", "", "", "", "", "", ""]);
    rows.push([]);

    // 各試合 1 カード (10行) × 全試合
    list.forEach((m, idx) => {
      const p1Num = numByEntrant.get(m.player1_entrant_id) || "";
      const p2Num = numByEntrant.get(m.player2_entrant_id) || "";
      const tableNo = m.table_no || "—";
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

module.exports = {
  buildAggregationXlsx,
  buildReceiptsHTML,
  buildReceiptsXlsx,
  buildReceiptsList,
  buildMatchCardsXlsx,
  classifyEvent, genderOf,
};
