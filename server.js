// ═══════════════════════════════════════════════════════
// 卓球大会運営アプリ - Express サーバー
//   /viewer  → 閲覧画面（公開・読み取り専用）
//   /admin   → 管理画面
//   /api/*   → REST API
// ═══════════════════════════════════════════════════════
const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const compression = require("compression");
const multer = require("multer");
const db = require("./db");
const reports = require("./reports");
const entryForm = require("./entry_form");

// xlsx 一時アップロード保存先 (拡張子保持)
const uploadDir = path.join(os.tmpdir(), "tt-uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || ".xlsx").toLowerCase() || ".xlsx";
      const safe = Date.now() + "_" + Math.random().toString(36).slice(2, 8) + ext;
      cb(null, safe);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// gzip 圧縮 (190KB JSON → 約 30KB)
// xlsx/zip 等の既に圧縮済みバイナリは再圧縮しない (ファイル破損防止)
app.use(compression({
  filter: (req, res) => {
    const ct = res.getHeader && res.getHeader("Content-Type");
    if (typeof ct === "string") {
      if (ct.includes("spreadsheet") || ct.includes("excel") ||
          ct.includes("zip") || ct.includes("octet-stream") ||
          ct.includes("image/") || ct.includes("pdf")) {
        return false;
      }
    }
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: "10mb" }));

// CORS（大会運営アプリや別ドメインのViewerから叩けるように）
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ═══ 診断モジュール (本番デバッグ用) ═══
// メモリ上にエラー・リクエスト履歴を保持し /api/diagnostics で確認可能に
const DIAG = {
  startedAt: new Date().toISOString(),
  errors: [],         // { time, method, url, status, message, stack }
  recentRequests: [], // { time, method, url, status, ms }
  maxErrors: 100,
  maxRequests: 200,
  totalRequests: 0,
  errorCount: 0,
};
function recordError(err, req, res, statusCode) {
  const entry = {
    time: new Date().toISOString(),
    method: (req && req.method) || "",
    url: (req && (req.originalUrl || req.url)) || "",
    status: statusCode || 500,
    message: String(err && err.message || err).slice(0, 500),
    stack: String(err && err.stack || "").slice(0, 2000),
  };
  DIAG.errors.unshift(entry);
  if (DIAG.errors.length > DIAG.maxErrors) DIAG.errors.length = DIAG.maxErrors;
  DIAG.errorCount++;
  console.error("[ERR]", entry.method, entry.url, "-", entry.message);
}

// リクエスト統計ミドルウェア
app.use((req, res, next) => {
  const t0 = Date.now();
  DIAG.totalRequests++;
  res.on("finish", () => {
    const ms = Date.now() - t0;
    // ヘルスチェック等は履歴に含めない (ノイズ削減)
    if (req.url === "/api/health" || req.url === "/api/diagnostics") return;
    DIAG.recentRequests.unshift({
      time: new Date().toISOString(),
      method: req.method,
      url: (req.originalUrl || req.url).slice(0, 200),
      status: res.statusCode,
      ms,
    });
    if (DIAG.recentRequests.length > DIAG.maxRequests) {
      DIAG.recentRequests.length = DIAG.maxRequests;
    }
    // 5xx は errors にも記録
    if (res.statusCode >= 500) {
      recordError(new Error("HTTP " + res.statusCode), req, res, res.statusCode);
    }
  });
  next();
});

// ADMIN_KEY 設定時のみ管理APIを保護
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next();
  const key = req.get("X-Admin-Key") || req.query.key;
  if (key === ADMIN_KEY) return next();
  res.status(401).json({ error: "管理キーが必要です" });
}

// ═══ 公開API（閲覧画面用・認証なし） ═══════════════════
app.get("/api/public/players", (req, res) => {
  const { search, gender, category, team, sort } = req.query;
  res.json(db.getPlayers({ search, gender, category, team, sort }));
});
app.get("/api/public/players/:id", (req, res) => {
  const player = db.getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(player);
});
app.get("/api/public/tournaments", (req, res) => { res.json(db.getTournaments()); });
app.get("/api/public/tournaments/:id", (req, res) => {
  const t = db.getTournament(req.params.id);
  if (!t) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(t);
});
app.get("/api/public/tournaments/:id/matches", (req, res) => {
  res.json(db.getMatchesByTournament(req.params.id));
});
app.get("/api/public/stats", (req, res) => { res.json(db.getStats()); });
app.get("/api/public/last-updated", (req, res) => { res.json({ t: db.getLastUpdated() }); });

// ── 試合検索 () ───────────────────────────────
app.get("/api/public/matches", (req, res) => {
  const matches = db.searchMatches(req.query);
  const total = db.countMatchesForSearch(req.query);
  res.json({ total, count: matches.length, matches });
});
app.get("/api/public/matches/filters", (req, res) => {
  res.json(db.getSearchFilters());
});
app.get("/api/public/players/:id/opponents", (req, res) => {
  res.json(db.getPlayerOpponents(req.params.id));
});
app.get("/api/public/players/:id/event-stats", (req, res) => {
  res.json(db.getPlayerEventStats(req.params.id));
});
app.get("/api/public/head-to-head", (req, res) => {
  const { p1, p2 } = req.query;
  if (!p1 || !p2) return res.status(400).json({ error: "p1 と p2 が必要です" });
  res.json(db.getHeadToHead(p1, p2));
});

// ── 公開申込 (大会への申込) ─────────────────────────
app.get("/api/public/open-tournaments", (req, res) => {
  res.json(db.getOpenTournaments());
});
app.post("/api/public/tournaments/:id/entry", (req, res) => {
  const r = db.createEntry(req.params.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});
app.get("/api/public/search", (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.json([]);
  const players = db.getPlayers({ search: q });
  res.json(players.slice(0, parseInt(limit) || 20));
});

// ═══ 管理API（選手CRUD） ══════════════════════════════
app.get("/api/players", (req, res) => {
  const { search, gender, category, team, sort } = req.query;
  res.json(db.getPlayers({ search, gender, category, team, sort }));
});
app.get("/api/players/:id", (req, res) => {
  const player = db.getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(player);
});
app.post("/api/players", requireAdmin, (req, res) => {
  try {
    res.status(201).json(db.createPlayer(req.body));
  } catch (e) {
    if (e.code === "INVALID_NAME") {
      return res.status(400).json({ error: e.message, invalid_name: e.invalidName });
    }
    res.status(500).json({ error: e.message });
  }
});
app.put("/api/players/:id", requireAdmin, (req, res) => {
  const player = db.updatePlayer(req.params.id, req.body);
  if (!player) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(player);
});
// 既存DBから「チーム名と判定される」選手レコードを削除 (admin 専用)
app.post("/api/players/cleanup-invalid", requireAdmin, (req, res) => {
  res.json(db.cleanupInvalidPlayers());
});

app.delete("/api/players/:id", requireAdmin, (req, res) => {
  db.deletePlayer(req.params.id); res.json({ ok: true });
});
app.delete("/api/players", requireAdmin, (req, res) => {
  db.deleteAllPlayers(); res.json({ ok: true });
});

// ── 戦績 ──
app.post("/api/players/:id/achievements", requireAdmin, (req, res) => {
  res.status(201).json(db.addAchievement(req.params.id, req.body));
});
app.delete("/api/achievements/:id", requireAdmin, (req, res) => {
  db.deleteAchievement(req.params.id); res.json({ ok: true });
});

// ═══ 管理API（大会CRUD） ══════════════════════════════
app.get("/api/tournaments", (req, res) => { res.json(db.getTournaments()); });
app.get("/api/tournaments/:id", (req, res) => {
  const t = db.getTournament(req.params.id);
  if (!t) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(t);
});
app.post("/api/tournaments", requireAdmin, (req, res) => {
  res.status(201).json(db.createTournament(req.body));
});
app.put("/api/tournaments/:id", requireAdmin, (req, res) => {
  const t = db.updateTournament(req.params.id, req.body);
  if (!t) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(t);
});
app.delete("/api/tournaments/:id", requireAdmin, (req, res) => {
  db.deleteTournament(req.params.id); res.json({ ok: true });
});

// ═══ 管理API（試合CRUD・セット記録） ═════════════
app.get("/api/tournaments/:id/matches", (req, res) => {
  res.json(db.getMatchesByTournament(req.params.id));
});
app.post("/api/tournaments/:id/matches", requireAdmin, (req, res) => {
  const match = db.createMatch({ ...req.body, tournament_id: req.params.id });
  res.status(201).json(match);
});
app.get("/api/matches/:id", (req, res) => {
  const m = db.getMatch(req.params.id);
  if (!m) return res.status(404).json({ error: "試合が見つかりません" });
  res.json(m);
});
app.put("/api/matches/:id", requireAdmin, (req, res) => {
  const match = db.updateMatch(req.params.id, req.body);
  if (!match) return res.status(404).json({ error: "試合が見つかりません" });
  res.json(match);
});
app.delete("/api/matches/:id", requireAdmin, (req, res) => {
  db.deleteMatch(req.params.id); res.json({ ok: true });
});

// ═══ 出場選手（エントリー管理） ═══════════════════════
app.get("/api/tournaments/:id/players", (req, res) => {
  res.json(db.getTournamentPlayers(req.params.id));
});
app.post("/api/tournaments/:id/players", requireAdmin, (req, res) => {
  const { player_id, event, seed } = req.body;
  db.addTournamentPlayer(req.params.id, player_id, event || "", seed || 0);
  res.json({ ok: true });
});
app.delete("/api/tournaments/:id/players/:pid", requireAdmin, (req, res) => {
  db.removeTournamentPlayer(req.params.id, req.params.pid);
  res.json({ ok: true });
});

// ═══ Entrants (大会参加選手) API ═══════════════════════
// マスタDB players とは完全独立。任意にリンク可能。
app.get("/api/tournaments/:id/entrants", (req, res) => {
  res.json(db.getEntrants(req.params.id, req.query.event));
});
app.get("/api/public/tournaments/:id/entrants", (req, res) => {
  res.json(db.getEntrants(req.params.id, req.query.event));
});
app.get("/api/entrants/:id", (req, res) => {
  const e = db.getEntrant(req.params.id);
  if (!e) return res.status(404).json({ error: "エントリーが見つかりません" });
  res.json(e);
});
app.post("/api/tournaments/:id/entrants", requireAdmin, (req, res) => {
  const e = db.createEntrant({ ...req.body, tournament_id: req.params.id });
  res.status(201).json(e);
});
app.put("/api/entrants/:id", requireAdmin, (req, res) => {
  const e = db.updateEntrant(req.params.id, req.body || {});
  if (!e) return res.status(404).json({ error: "エントリーが見つかりません" });
  res.json(e);
});
app.delete("/api/entrants/:id", requireAdmin, (req, res) => {
  db.deleteEntrant(req.params.id); res.json({ ok: true });
});
// マスタDBへのリンク
app.put("/api/entrants/:id/link", requireAdmin, (req, res) => {
  const { player_id, is_partner } = req.body || {};
  const e = db.linkEntrantToPlayer(req.params.id, player_id || null, !!is_partner);
  res.json(e);
});
// 選手番号 (大会固有・左右別) を手動設定
app.put("/api/entrants/:id/bracket-number", requireAdmin, (req, res) => {
  const e = db.setEntrantBracketNumber(
    req.params.id,
    parseInt(req.body?.number) || 0,
    (req.body?.side === "R" ? "R" : (req.body?.side === "L" ? "L" : ""))
  );
  if (!e) return res.status(404).json({ error: "エントリーが見つかりません" });
  res.json(e);
});
// マスタDBにリンクすべき選手の提案
app.get("/api/entrants/:id/suggest-player", (req, res) => {
  const e = db.getEntrant(req.params.id);
  if (!e) return res.status(404).json({ error: "エントリーが見つかりません" });
  const target = req.query.partner === "1"
    ? db.suggestPlayerForEntrant(e.partner_name, e.partner_team)
    : db.suggestPlayerForEntrant(e.name, e.team);
  res.json({ suggested: target || null });
});
// マスタDBに新規作成してリンク
app.post("/api/entrants/:id/create-player", requireAdmin, (req, res) => {
  const player = db.createPlayerFromEntrant(req.params.id, !!req.body?.is_partner);
  if (!player) return res.status(400).json({ error: "選手作成に失敗" });
  res.json(player);
});
// 組合せ表 Excel アップロード → Node.js パーサー (旧 Python 版から移行)
// /entrants/upload-excel と同等のロジックを kumiawase エンドポイントでも提供
app.post("/api/tournaments/:id/kumiawase/upload",
  requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルが添付されていません" });
  const filePath = req.file.path;
  const event = req.body.event || "";
  const mode = req.body.mode || "";  // 互換性保持 (未使用)
  const sheet = req.body.sheet || "";
  const dryRun = req.body.dry_run === "1" || req.body.dry_run === "true";
  const format = req.body.format;
  const originalName = (req.file.originalname || "").toLowerCase();
  const isPdf = originalName.endsWith(".pdf") || req.file.mimetype === "application/pdf";

  // PDF 経由
  if (isPdf) {
    if (!pdfParser || !pdfParser.parseWorkbook) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(500).json({ error: "PDF パーサーが利用できません" });
    }
    try {
      const data = await pdfParser.parseWorkbook(filePath, {
        formatHint: format && ["singles", "doubles", "team"].includes(format) ? format : null,
        eventHint: event || null,
      });
      try { fs.unlinkSync(filePath); } catch {}
      if (data.error) return res.status(400).json(data);
      if (dryRun) return res.json({ preview: data, message: "解析プレビュー (まだ取込されていません)" });
      data.regenerate = true;
      data.auto_link_to_players = true;
      const r = db.importBracket(req.params.id, data);
      return res.json({ ...r, source: "kumiawase_chart", used_parser: "parse_pdf_bracket.js" });
    } catch (e) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(500).json({
        error: "PDF 解析失敗: " + e.message,
        hint: "画像PDF (スキャン) は読み取れません。Excel またはテキストPDFをご利用ください。",
      });
    }
  }

  // Excel 経由 (Node 製パーサー)
  if (!kttaParser || !kttaParser.parseWorkbook) {
    try { fs.unlinkSync(filePath); } catch {}
    return res.status(500).json({ error: "Excel パーサーが利用できません" });
  }
  try {
    const data = kttaParser.parseWorkbook(filePath, {
      formatHint: format && ["singles", "doubles", "team"].includes(format) ? format : null,
      eventHint: event || null,
      sheet: sheet || null,
      allSheets: !sheet,
      verbose: false,
    });
    try { fs.unlinkSync(filePath); } catch {}
    if (data.error) return res.status(400).json(data);
    if (dryRun) return res.json({ preview: data, message: "解析プレビュー (まだ取込されていません)" });
    data.regenerate = true;
    data.auto_link_to_players = true;
    const r = db.importBracket(req.params.id, data);
    return res.json({ ...r, source: "kumiawase_chart", used_parser: "parse_ktta_bracket.js" });
  } catch (e) {
    try { fs.unlinkSync(filePath); } catch {}
    return res.status(500).json({ error: "Excel 解析失敗: " + e.message });
  }
});

// Excel/PDF 直接アップロード → 解析 → 出場選手取込 (ワンステップ)
// 新版: Node.js 製パーサー (Python 依存ゼロ)
let kttaParser = null;
let pdfParser = null;
try {
  kttaParser = require("./tools/parse_ktta_bracket.js");
} catch (e) {
  console.warn("[startup] parse_ktta_bracket.js のロード失敗:", e.message);
}
try {
  pdfParser = require("./tools/parse_pdf_bracket.js");
} catch (e) {
  console.warn("[startup] parse_pdf_bracket.js のロード失敗:", e.message);
}

app.post("/api/tournaments/:id/entrants/upload-excel",
  requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルが添付されていません" });
  const xlsxPath = req.file.path;
  const regenerate = req.body.regenerate === "1" || req.body.regenerate === "true";
  const autoLink = req.body.auto_link !== "0" && req.body.auto_link !== "false";
  const format = req.body.format;
  const eventHint = req.body.event || "";
  const originalName = (req.file.originalname || "").toLowerCase();
  const isPdf = originalName.endsWith(".pdf") || req.file.mimetype === "application/pdf";

  // ── 1a. PDF パーサー (テキストPDFのみ) ──
  if (isPdf) {
    if (!pdfParser || !pdfParser.parseWorkbook) {
      try { fs.unlinkSync(xlsxPath); } catch {}
      return res.status(500).json({ error: "PDF パーサーが利用できません" });
    }
    try {
      const data = await pdfParser.parseWorkbook(xlsxPath, {
        formatHint: format && ["singles", "doubles", "team"].includes(format) ? format : null,
        eventHint: eventHint || null,
      });
      try { fs.unlinkSync(xlsxPath); } catch {}
      if (data.error) {
        return res.status(400).json({ ...data, used_parser: "parse_pdf_bracket.js" });
      }
      data.regenerate = regenerate;
      data.auto_link_to_players = autoLink;
      const r = db.importBracket(req.params.id, data);
      return res.json({ ...r, used_parser: "parse_pdf_bracket.js" });
    } catch (e) {
      console.error("[parser] PDF parser failed:", e);
      try { fs.unlinkSync(xlsxPath); } catch {}
      return res.status(500).json({
        error: "PDF パーサー失敗: " + e.message,
        hint: "画像PDF (スキャンしたもの) は読み取れません。Excel または テキスト形式のPDF をお試しください。",
        used_parser: "parse_pdf_bracket.js",
      });
    }
  }

  // ── 1b. Node.js Excel パーサー (推奨・本番) ──
  if (kttaParser && kttaParser.parseWorkbook) {
    try {
      const data = kttaParser.parseWorkbook(xlsxPath, {
        formatHint: format && ["singles", "doubles", "team"].includes(format) ? format : null,
        eventHint: eventHint || null,
        allSheets: true,
        verbose: false,
      });
      try { fs.unlinkSync(xlsxPath); } catch {}
      if (data.error) {
        return res.status(400).json({ ...data, used_parser: "parse_ktta_bracket.js" });
      }
      data.regenerate = regenerate;
      data.auto_link_to_players = autoLink;
      const r = db.importBracket(req.params.id, data);
      return res.json({ ...r, used_parser: "parse_ktta_bracket.js" });
    } catch (e) {
      console.error("[parser] Node parser failed:", e);
      try { fs.unlinkSync(xlsxPath); } catch {}
      return res.status(500).json({
        error: "Excel パーサー失敗: " + e.message,
        used_parser: "parse_ktta_bracket.js",
      });
    }
  }

  // ── 2. fallback: Python parse_jtta_excel.py (旧版) ──
  const script = path.join(__dirname, "tools", "parse_jtta_excel.py");
  if (!fs.existsSync(script)) {
    try { fs.unlinkSync(xlsxPath); } catch {}
    return res.status(500).json({ error: "Node パーサーも Python パーサーも利用できません" });
  }
  const pyEnv = Object.assign({}, process.env);
  if (!pyEnv.PYTHONPATH) pyEnv.PYTHONPATH = path.join(__dirname, ".python-packages");
  const py = spawn("python3", [script, xlsxPath, "--all-sheets"], { env: pyEnv });
  let stdout = "", stderr = "";
  py.stdout.on("data", (d) => { stdout += d.toString(); });
  py.stderr.on("data", (d) => { stderr += d.toString(); });
  py.on("close", (code) => {
    try { fs.unlinkSync(xlsxPath); } catch {}
    if (code !== 0) {
      return res.status(500).json({
        error: "パーサー失敗 (exit code " + code + ")",
        stderr: stderr.slice(0, 500),
        used_parser: "parse_jtta_excel.py (fallback)",
      });
    }
    let data;
    try { data = JSON.parse(stdout); }
    catch (e) {
      return res.status(500).json({ error: "JSON 解析失敗: " + e.message,
        used_parser: "parse_jtta_excel.py (fallback)" });
    }
    if (data.error) {
      return res.status(400).json({ ...data, used_parser: "parse_jtta_excel.py (fallback)" });
    }
    data.regenerate = regenerate;
    data.auto_link_to_players = autoLink;
    const r = db.importBracket(req.params.id, data);
    res.json({ ...r, used_parser: "parse_jtta_excel.py (fallback)" });
  });
  py.on("error", (err) => {
    try { fs.unlinkSync(xlsxPath); } catch {}
    res.status(500).json({ error: "python3 が見つかりません: " + err.message });
  });
});

// バリデーション (重複/欠落検出)
app.get("/api/tournaments/:id/entrants/validate", (req, res) => {
  res.json(db.validateEntrants(req.params.id, req.query.event || ""));
});

// ─── 集計表 Excel 出力 ───
app.get("/api/tournaments/:id/aggregation.xlsx", (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    const entrants = db.getEntrants(req.params.id);
    if (!entrants.length) return res.status(400).json({ error: "出場選手が未登録です" });
    const fees = {};
    ["team_male","team_female","doubles_male","doubles_female",
     "mixed_male","mixed_female","singles_male","singles_female",
     "bento","party"].forEach(k => {
      if (req.query[k] !== undefined) fees[k] = parseInt(req.query[k]) || 0;
    });
    const buf = reports.buildAggregationXlsx(tournament, entrants, { fees });
    // バイナリ転送用に厳格な設定 (圧縮無効・キャッシュ無効・正確な長さ)
    const safeName = (tournament.name || "tournament").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const filename = encodeURIComponent(`集計表_${safeName}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buf);  // send() でなく end() で確実にバイナリ送信
  } catch (e) {
    console.error("aggregation.xlsx error:", e);
    res.status(500).json({ error: "集計表生成失敗: " + e.message });
  }
});

// ─── 領収書 一括 Excel 出力 (1団体=1シート) ───
app.get("/api/tournaments/:id/receipts.xlsx", (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    const entrants = db.getEntrants(req.params.id);
    if (!entrants.length) return res.status(400).json({ error: "出場選手が未登録です" });
    const fees = {};
    ["team_male","team_female","doubles_male","doubles_female",
     "mixed_male","mixed_female","singles_male","singles_female",
     "bento","party"].forEach(k => {
      if (req.query[k] !== undefined) fees[k] = parseInt(req.query[k]) || 0;
    });
    const buf = reports.buildReceiptsXlsx(tournament, entrants, {
      fees,
      issuer: req.query.issuer || "釧路卓球協会",
      president: req.query.president || "会長  山本 満",
    });
    const safeName = (tournament.name || "tournament").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const filename = encodeURIComponent(`領収書_${safeName}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buf);
  } catch (e) {
    console.error("receipts.xlsx error:", e);
    res.status(500).json({ error: "領収書生成失敗: " + e.message });
  }
});

// ─── 対戦票 (審判用記録票) 一括 Excel 出力 ───
app.get("/api/tournaments/:id/match-cards.xlsx", (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    const matches = db.getMatchesByTournament(req.params.id) || [];
    if (!matches.length) {
      return res.status(400).json({
        error: "試合データがありません。先にトーナメント表を取込んでください。",
      });
    }
    const entrants = db.getEntrants(req.params.id) || [];
    const buf = reports.buildMatchCardsXlsx(tournament, matches, entrants, {
      only_playable: req.query.include_bye !== "1",
    });
    const safeName = (tournament.name || "tournament").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const filename = encodeURIComponent(`対戦票_${safeName}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buf);
  } catch (e) {
    console.error("match-cards.xlsx error:", e);
    res.status(500).json({ error: "対戦票生成失敗: " + e.message });
  }
});

// ─── 領収書 一括 HTML 出力 (印刷で PDF 化、モーダル表示用) ───
app.get("/api/tournaments/:id/receipts.html", (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).send("<h1>大会が見つかりません</h1>");
    const entrants = db.getEntrants(req.params.id);
    if (!entrants.length) return res.status(400).send("<h1>出場選手が未登録です</h1>");
    const fees = {};
    ["team_male","team_female","doubles_male","doubles_female",
     "mixed_male","mixed_female","singles_male","singles_female",
     "bento","party"].forEach(k => {
      if (req.query[k] !== undefined) fees[k] = parseInt(req.query[k]) || 0;
    });
    // 印鑑URL: SEAL_DIR が設定されていれば /uploads/seal.png 優先
    let sealUrl = req.query.seal_url;
    if (!sealUrl) {
      if (SEAL_DIR_PERSISTENT) {
        // /uploads/seal.png または seal.jpg
        for (const e of [".png", ".jpg", ".jpeg"]) {
          if (fs.existsSync(path.join(SEAL_DIR_PERSISTENT, "seal" + e))) {
            sealUrl = "/uploads/seal" + e;
            break;
          }
        }
      }
      if (!sealUrl) sealUrl = "/shared/assets/seal.png";
    }
    const html = reports.buildReceiptsHTML(tournament, entrants, {
      fees,
      seal_url: sealUrl,
      issuer: req.query.issuer || "釧路卓球協会",
      president: req.query.president || "会長  山本 満",
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (e) {
    res.status(500).send("<h1>領収書生成失敗</h1><pre>" + e.message + "</pre>");
  }
});

// ─── 領収書 一覧 JSON (モーダル内表示用) ───
app.get("/api/tournaments/:id/receipts.json", (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    const entrants = db.getEntrants(req.params.id);
    if (!entrants.length) return res.json({ items: [], grand_total: 0, message: "出場選手が未登録です" });
    const fees = {};
    ["team_male","team_female","doubles_male","doubles_female",
     "mixed_male","mixed_female","singles_male","singles_female",
     "bento","party"].forEach(k => {
      if (req.query[k] !== undefined) fees[k] = parseInt(req.query[k]) || 0;
    });
    const r = reports.buildReceiptsList(tournament, entrants, {
      fees,
      issuer: req.query.issuer || "釧路卓球協会",
      president: req.query.president || "会長  山本 満",
    });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "領収書一覧生成失敗: " + e.message });
  }
});

// ─── 印鑑画像アップロード ───
// SEAL_DIR が設定されていればそこに保存 (Render 等の永続ディスク用)
// 未設定なら public/shared/assets に保存 (ローカル開発用)
const SEAL_DIR_PERSISTENT = process.env.SEAL_DIR || "";
const SEAL_DIR_DEFAULT = path.join(__dirname, "public", "shared", "assets");

app.post("/api/settings/seal", requireAdmin, upload.single("seal"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルが添付されていません" });
  if (req.file.size < 100) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: "ファイルが空または小さすぎます (画像が破損している可能性)" });
  }
  const mt = req.file.mimetype || "";
  if (!mt.startsWith("image/")) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: "画像ファイル (.png/.jpg) を選択してください: " + mt });
  }
  const targetDir = SEAL_DIR_PERSISTENT || SEAL_DIR_DEFAULT;
  fs.mkdirSync(targetDir, { recursive: true });
  const ext = path.extname(req.file.originalname || ".png").toLowerCase() || ".png";
  const dest = path.join(targetDir, "seal" + ext);
  fs.renameSync(req.file.path, dest);
  // 公開URL
  const url = SEAL_DIR_PERSISTENT
    ? "/uploads/seal" + ext
    : "/shared/assets/seal" + ext;
  res.json({ ok: true, path: url, size: req.file.size });
});

// 永続ディスク用 印鑑画像 配信
if (SEAL_DIR_PERSISTENT) {
  app.use("/uploads", express.static(SEAL_DIR_PERSISTENT));
}

// ─── 申込フォーム HTML 生成 (Jimdo 等への埋込用) ───
// テンプレID があれば templates から events を取得、なければ matches から推定
// よく使われる申込種目のデフォルトカタログ (admin で追加・編集可能)
const DEFAULT_EVENTS_CATALOG = [
  // 団体戦
  { name: "一般男子 団体戦", type: "team", fee: 4000, per_team: 6 },
  { name: "一般女子 団体戦", type: "team", fee: 4000, per_team: 6 },
  { name: "高校男子 団体戦", type: "team", fee: 3000, per_team: 6 },
  { name: "高校女子 団体戦", type: "team", fee: 3000, per_team: 6 },
  { name: "中学男子 団体戦", type: "team", fee: 3000, per_team: 6 },
  { name: "中学女子 団体戦", type: "team", fee: 3000, per_team: 6 },
  { name: "小学生 団体戦", type: "team", fee: 2500, per_team: 6 },
  // 混合ダブルス
  { name: "混合ダブルス 一般", type: "doubles", fee: 1200 },
  { name: "混合ダブルス 高校", type: "doubles", fee: 1000 },
  { name: "混合ダブルス 中学", type: "doubles", fee: 800 },
  // ダブルス
  { name: "男子ダブルス 一般", type: "doubles", fee: 1000 },
  { name: "女子ダブルス 一般", type: "doubles", fee: 1000 },
  { name: "男子ダブルス 高校", type: "doubles", fee: 800 },
  { name: "女子ダブルス 高校", type: "doubles", fee: 800 },
  { name: "男子ダブルス 中学", type: "doubles", fee: 600 },
  { name: "女子ダブルス 中学", type: "doubles", fee: 600 },
  // シングルス
  { name: "男子シングルス 一般", type: "singles", fee: 700 },
  { name: "女子シングルス 一般", type: "singles", fee: 700 },
  { name: "男子シングルス 高校", type: "singles", fee: 500 },
  { name: "女子シングルス 高校", type: "singles", fee: 500 },
  { name: "男子シングルス 中学", type: "singles", fee: 500 },
  { name: "女子シングルス 中学", type: "singles", fee: 500 },
  { name: "男子シングルス 小学", type: "singles", fee: 500 },
  { name: "女子シングルス 小学", type: "singles", fee: 500 },
  // 年齢別
  { name: "シニア男子 (50歳以上)", type: "singles", fee: 700 },
  { name: "シニア女子 (50歳以上)", type: "singles", fee: 700 },
  { name: "壮年男子 (40歳以上)", type: "singles", fee: 700 },
  { name: "壮年女子 (40歳以上)", type: "singles", fee: 700 },
  // その他
  { name: "オープン男子", type: "singles", fee: 1000 },
  { name: "オープン女子", type: "singles", fee: 1000 },
];

function _resolveEvents(tournament) {
  // ★ 最優先: tournament.event_config (フォーム生成で保存された full データ)
  try {
    if (tournament.event_config) {
      const cfg = typeof tournament.event_config === "string"
        ? JSON.parse(tournament.event_config)
        : tournament.event_config;
      if (Array.isArray(cfg) && cfg.length) {
        return cfg.map(e => ({
          name: e.name,
          type: e.type || "singles",
          fee: parseInt(e.fee) || 0,
          per_team: e.per_team || (e.type === "team" ? 6 : null),
          note: e.note || "",
        }));
      }
    }
  } catch {}

  // フォールバック: entry_events + matches + entrants から再構築
  const eventSet = new Set();
  try {
    const ee = tournament.entry_events
      ? (typeof tournament.entry_events === "string"
          ? JSON.parse(tournament.entry_events)
          : tournament.entry_events)
      : [];
    if (Array.isArray(ee)) ee.forEach(n => { if (n) eventSet.add(n); });
  } catch {}
  const matches = db.getMatchesByTournament(tournament.id);
  matches.forEach(m => { if (m.event) eventSet.add(m.event); });
  const entrants = db.getEntrants(tournament.id);
  entrants.forEach(e => { if (e.event) eventSet.add(e.event); });
  const inferType = (n) => {
    if (/団体|チーム/.test(n)) return "team";
    if (/ダブルス|混合|ミックス/.test(n)) return "doubles";
    return "singles";
  };
  const defaultFee = (type, name) => {
    if (type === "team") return /一般/.test(name) ? 4000 : 3000;
    if (type === "doubles") return /混合/.test(name) ? 1200 : (/一般/.test(name) ? 1000 : 800);
    return /一般/.test(name) ? 700 : 500;
  };
  return Array.from(eventSet).map(name => {
    const type = inferType(name);
    return { name, type, fee: defaultFee(type, name), per_team: type === "team" ? 6 : null };
  });
}

// 既定種目カタログ取得 (admin の「追加」ボタンで使用)
app.get("/api/events-catalog", (req, res) => {
  res.json({ events: DEFAULT_EVENTS_CATALOG });
});

app.get("/api/tournaments/:id/entry-form.html", (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).send("<h1>大会が見つかりません</h1>");
    let events = _resolveEvents(tournament);
    // フォーム要求にに events が含まれていれば優先 (JSON 文字列)
    if (req.query.events) {
      try {
        const parsed = JSON.parse(req.query.events);
        if (Array.isArray(parsed)) events = parsed;
      } catch {}
    }
    const html = entryForm.buildEntryFormHTML(tournament, events, {
      gas_url: req.query.gas_url || "REPLACE_WITH_GAS_WEB_APP_URL",
      admin_email: req.query.admin_email || "",
      deadline: req.query.deadline || "",
      payment_note: req.query.payment_note || "",
      notes: req.query.notes || "",
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // iframe 埋込許可 (Jimdo / STUDIO のいずれからも埋込可能に)
    res.removeHeader("X-Frame-Options");
    // CSP も緩めて anywhere from embedded可能
    res.setHeader("Content-Security-Policy",
      "frame-ancestors *;");
    // 全てのリソースを self とインライン許可 (外部依存なし)
    res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
    res.send(html);
  } catch (e) {
    res.status(500).send("<h1>フォーム生成失敗</h1><pre>" + e.message + "</pre>");
  }
});

// ─── Jimdo/STUDIO 直接貼付用 自己完結型スニペット ──────────
// DOCTYPE/html/body タグなし、外部依存ゼロの HTML フラグメント
// GET ?as=text で text/plain (コピペ用)
app.get("/api/tournaments/:id/entry-form-snippet", (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).send("大会が見つかりません");
    let events = _resolveEvents(tournament);
    if (req.query.events) {
      try {
        const parsed = JSON.parse(req.query.events);
        if (Array.isArray(parsed)) events = parsed;
      } catch {}
    }
    const snippet = entryForm.buildEntryFormSnippet(tournament, events, {
      gas_url: req.query.gas_url || "",
      deadline: req.query.deadline || "",
      payment_note: req.query.payment_note || "",
      notes: req.query.notes || "",
    });
    const as = req.query.as || "html";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (as === "text") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    }
    res.send(snippet);
  } catch (e) {
    res.status(500).send("スニペット生成失敗: " + e.message);
  }
});

// 申込フォームの events 情報を JSON で取得 (admin UI 用)
app.get("/api/tournaments/:id/entry-form-config", (req, res) => {
  const tournament = db.getTournament(req.params.id);
  if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
  const events = _resolveEvents(tournament);
  res.json({
    tournament: { id: tournament.id, name: tournament.name, date: tournament.date,
                  venue: tournament.venue, status: tournament.status },
    events,
    suggested_gas_url: "https://script.google.com/macros/s/AKfycb.../exec",
  });
});

// GAS スプレッドシートの集計を取得 (サーバー経由でプロキシ・CORS回避)
// GET /api/tournaments/:id/gas-stats?gas_url=...
app.get("/api/tournaments/:id/gas-stats", async (req, res) => {
  const gasUrl = req.query.gas_url || "";
  if (!gasUrl) return res.status(400).json({ error: "gas_url が必要です" });
  if (!/^https:\/\/script\.google\.com\//.test(gasUrl)) {
    return res.status(400).json({ error: "gas_url は https://script.google.com/... 形式である必要があります" });
  }
  try {
    const tournament = db.getTournament(req.params.id);
    const tournamentId = tournament ? tournament.id : req.params.id;
    const sep = gasUrl.includes("?") ? "&" : "?";
    const fullUrl = gasUrl + sep + "action=stats&tournament_id=" + encodeURIComponent(tournamentId);
    // Node 18+ なら fetch がネイティブ
    const r = await fetch(fullUrl, { redirect: "follow" });
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); }
    catch { return res.status(502).json({ error: "GAS 応答が JSON ではありません", raw: txt.slice(0, 200) }); }
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "GAS 通信失敗: " + err.message });
  }
});

// 申込団体別 (内訳付き) JSON 出力
app.get("/api/tournaments/:id/applicants", (req, res) => {
  const tournament = db.getTournament(req.params.id);
  if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
  const entrants = db.getEntrants(req.params.id);
  const fees = {};
  ["team_male","team_female","doubles_male","doubles_female",
   "mixed_male","mixed_female","singles_male","singles_female",
   "bento","party"].forEach(k => {
    if (req.query[k] !== undefined) fees[k] = parseInt(req.query[k]) || 0;
  });
  // reports.js の内部関数を再利用するため簡易処理
  const byTeam = new Map();
  entrants.forEach(e => {
    const key = e.team || "(無所属)";
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(e);
  });
  const result = [];
  Array.from(byTeam.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .forEach(([team, members]) => {
      result.push({
        team, count: members.length,
        members: members.map(m => ({
          event: m.event, name: m.display_name,
          gender: m.gender, is_doubles: m.is_doubles,
        })),
      });
    });
  res.json({ tournament_id: req.params.id, applicants: result });
});
// 統計 (種目×ブロック分布)
app.get("/api/tournaments/:id/entrants/stats", (req, res) => {
  res.json(db.getEntrantStats(req.params.id));
});

// ═══ 進行管理 (Operations) API ═══════════════════════
app.post("/api/tournaments/:id/bracket", requireAdmin, (req, res) => {
  const { event, regenerate, player_ids } = req.body || {};
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.generateBracket(req.params.id, event, { regenerate, player_ids });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

app.get("/api/tournaments/:id/bracket", (req, res) => {
  res.json(db.getBracket(req.params.id, req.query.event || ""));
});

app.delete("/api/tournaments/:id/bracket", requireAdmin, (req, res) => {
  const event = req.query.event || req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  res.json(db.deleteEventMatches(req.params.id, event));
});

app.get("/api/tournaments/:id/operations", (req, res) => {
  const state = db.getOperationState(req.params.id);
  if (!state) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(state);
});

app.get("/api/public/tournaments/:id/live", (req, res) => {
  const state = db.getOperationState(req.params.id);
  if (!state) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(state);
});

// 選手個人の試合状況 (マイ番号ポータル用)
app.get("/api/public/players/:id/live-status", (req, res) => {
  const status = db.getPlayerLiveStatus(req.params.id, req.query.tournament_id);
  if (!status) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(status);
});

app.post("/api/matches/:id/call", requireAdmin, (req, res) => {
  const r = db.callMatch(
    req.params.id,
    parseInt(req.body?.table_no) || 0,
    req.body?.referee_id || null,
    {
      force: !!req.body?.force,
      referee_name: req.body?.referee_name || "",
      auto_assign_referee: req.body?.auto_assign_referee !== false,
      extra_tables: Array.isArray(req.body?.extra_tables)
        ? req.body.extra_tables
        : (req.body?.extra_tables
            ? String(req.body.extra_tables).split(",").map(s => parseInt(s.trim())).filter(n => n > 0)
            : []),
    }
  );
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});

app.post("/api/matches/:id/uncall", requireAdmin, (req, res) => {
  res.json(db.uncallMatch(req.params.id));
});

app.post("/api/matches/:id/referee", requireAdmin, (req, res) => {
  // 任意の選手を審判に指定可能 (敗者プール外、DB外名も可)
  const r = db.assignAnyReferee(
    req.params.id,
    req.body?.referee_id || null,
    {
      force: !!req.body?.force,
      referee_name: req.body?.referee_name || "",
    }
  );
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});

app.put("/api/matches/:id/referee-required", requireAdmin, (req, res) => {
  res.json(db.setRefereeRequired(req.params.id, !!req.body?.required));
});

// 再コール回数 設定 (admin)
// body: { count: N, slot?: 1|2 } - slot 未指定/0 で両方同時設定
app.put("/api/matches/:id/call-count", requireAdmin, (req, res) => {
  const count = req.body && req.body.count !== undefined ? req.body.count : null;
  if (count === null) return res.status(400).json({ error: "count が必要" });
  const slot = parseInt(req.body.slot);
  res.json(db.setCallCount(req.params.id, count, slot === 1 || slot === 2 ? slot : null));
});

// 再コール +1 (admin)
// body: { slot?: 1|2 } - slot 未指定で両方+1 (互換性)
app.post("/api/matches/:id/recall", requireAdmin, (req, res) => {
  const slot = parseInt(req.body?.slot);
  res.json(db.bumpCallCount(req.params.id, slot === 1 || slot === 2 ? slot : null));
});

// 試合の手動編集 (任意のフィールド)
app.put("/api/matches/:id/edit", requireAdmin, (req, res) => {
  const r = db.editMatch(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: "試合が見つかりません" });
  res.json(r);
});

// 大会全体のルール設定 (敗者審判ルール on/off など)
app.put("/api/tournaments/:id/op-settings", requireAdmin, (req, res) => {
  const r = db.setOperationSettings(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(r);
});

app.post("/api/matches/:id/finish", requireAdmin, (req, res) => {
  const r = db.finishMatchOp(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: "試合が見つかりません" });
  res.json(r);
});

// ── ブラケット JSON エクスポート/インポート ─────────
app.get("/api/tournaments/:id/bracket/export", (req, res) => {
  const event = req.query.event;
  if (event) {
    const data = db.exportBracket(req.params.id, event);
    if (!data) return res.status(404).json({ error: "ブラケットが見つかりません" });
    res.json(data);
  } else {
    const data = db.exportAllBrackets(req.params.id);
    if (!data) return res.status(404).json({ error: "大会が見つかりません" });
    res.json(data);
  }
});
// 同じデータを公開API側でも取得可能（読み取り専用）
app.get("/api/public/tournaments/:id/bracket/export", (req, res) => {
  const event = req.query.event;
  if (event) {
    const data = db.exportBracket(req.params.id, event);
    if (!data) return res.status(404).json({ error: "ブラケットが見つかりません" });
    res.json(data);
  } else {
    const data = db.exportAllBrackets(req.params.id);
    if (!data) return res.status(404).json({ error: "大会が見つかりません" });
    res.json(data);
  }
});

app.post("/api/tournaments/:id/bracket/import", requireAdmin, (req, res) => {
  const r = db.importBracket(req.params.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

app.put("/api/tournaments/:id/court-layout", requireAdmin, (req, res) => {
  const r = db.setCourtLayout(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(r);
});

// ── 申込管理 (admin) ─────────────────────────────
app.get("/api/tournaments/:id/entries", (req, res) => {
  res.json(db.getEntries(req.params.id, req.query.status));
});
app.post("/api/tournaments/:id/entries", requireAdmin, (req, res) => {
  // 管理者直接追加（auto_confirm: true）
  const r = db.createEntry(req.params.id, { ...req.body, auto_confirm: true });
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});
app.put("/api/tournaments/:id/entries/:pid/status", requireAdmin, (req, res) => {
  const { status, event } = req.body || {};
  if (!["pending", "confirmed", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status は pending/confirmed/rejected" });
  }
  res.json(db.setEntryStatus(req.params.id, req.params.pid, event || null, status));
});
app.put("/api/tournaments/:id/entries/:pid/seed", requireAdmin, (req, res) => {
  const { event, seed } = req.body || {};
  if (!event) return res.status(400).json({ error: "event が必要です" });
  res.json(db.setEntrySeed(req.params.id, req.params.pid, event, seed));
});
app.put("/api/tournaments/:id/entry-settings", requireAdmin, (req, res) => {
  const r = db.updateEntrySettings(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(r);
});

// ═══ 大会運営アプリ連携API ═══════════════════════════
// 外部アプリから POST で試合結果をバルク送信
app.post("/api/sync/matches", requireAdmin, (req, res) => {
  const { tournament_id, matches } = req.body;
  if (!tournament_id || !Array.isArray(matches)) {
    return res.status(400).json({ error: "tournament_id と matches が必要です" });
  }
  const result = db.bulkImportMatches(tournament_id, matches);
  res.json(result);
});

// 大会全体をまとめてアップサート
app.post("/api/sync/tournament", requireAdmin, (req, res) => {
  const { tournament, matches } = req.body;
  if (!tournament) return res.status(400).json({ error: "tournament が必要です" });
  let tid = tournament.id;
  let existing = tid ? db.getTournament(tid) : null;
  if (!existing) { const t = db.createTournament(tournament); tid = t.id; }
  else { db.updateTournament(tid, tournament); }
  let matchResult = { created: 0, updated: 0 };
  if (Array.isArray(matches)) {
    matchResult = db.bulkImportMatches(tid, matches);
  }
  res.json({ tournament_id: tid, ...matchResult });
});

// ═══ インポート/エクスポート ══════════════════════════
app.get("/api/export/all", (req, res) => { res.json(db.exportAllData()); });
app.get("/api/export/players", (req, res) => { res.json(db.exportAllData()); });
app.post("/api/import/players", requireAdmin, (req, res) => {
  res.json(db.importPlayers(req.body.players || []));
});

// ═══ 統計 ═══════════════════════════════════════════════
app.get("/api/stats", (req, res) => { res.json(db.getStats()); });
app.get("/api/last-updated", (req, res) => { res.json({ t: db.getLastUpdated() }); });
app.get("/api/health", (req, res) => {
  // 拡張ヘルスチェック: DB 状態 + メモリ + アップタイム
  let dbOk = false, dbInfo = null;
  try {
    const stats = db.getStats();
    dbOk = true;
    dbInfo = stats;
  } catch (e) {
    dbInfo = { error: String(e.message || e) };
  }
  res.json({
    ok: dbOk,
    time: new Date().toISOString(),
    uptime_sec: Math.round(process.uptime()),
    node_version: process.version,
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    db: dbInfo,
    env: process.env.NODE_ENV || "development",
  });
});

// ═══ 診断 API (admin 専用) ═══
// 直近のエラー・リクエスト・サーバー状態を返す
app.get("/api/diagnostics", requireAdmin, (req, res) => {
  const mem = process.memoryUsage();
  let dbStats = null, dbSize = null;
  try { dbStats = db.getStats(); } catch (e) { dbStats = { error: String(e.message || e) }; }
  try {
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "tournament.db");
    if (fs.existsSync(DB_PATH)) {
      dbSize = fs.statSync(DB_PATH).size;
    }
  } catch {}

  res.json({
    server: {
      started_at: DIAG.startedAt,
      uptime_sec: Math.round(process.uptime()),
      node_version: process.version,
      platform: process.platform,
      env: process.env.NODE_ENV || "development",
      pid: process.pid,
      memory_mb: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heap_used: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total: Math.round(mem.heapTotal / 1024 / 1024),
      },
    },
    db: {
      ...dbStats,
      file_size_mb: dbSize ? Math.round(dbSize / 1024 / 1024 * 100) / 100 : null,
    },
    traffic: {
      total_requests: DIAG.totalRequests,
      error_count: DIAG.errorCount,
      error_rate: DIAG.totalRequests > 0
        ? Math.round(DIAG.errorCount / DIAG.totalRequests * 10000) / 100 + "%"
        : "0%",
    },
    recent_errors: DIAG.errors.slice(0, 50),
    recent_requests: DIAG.recentRequests.slice(0, 50),
  });
});

// 診断ログクリア (admin)
app.post("/api/diagnostics/clear", requireAdmin, (req, res) => {
  DIAG.errors = [];
  DIAG.recentRequests = [];
  DIAG.errorCount = 0;
  DIAG.totalRequests = 0;
  res.json({ ok: true });
});

// ═══ 静的ファイル ═══════════════════════════════════════
const publicDir = path.join(__dirname, "public");
app.use("/shared", express.static(path.join(publicDir, "shared")));
app.use("/admin", express.static(path.join(publicDir, "admin")));
app.use("/viewer", express.static(path.join(publicDir, "viewer")));

// 運用マニュアル (Markdown)
for (const docName of ["OPERATIONS.md", "RENDER_DEPLOY.md", "UPDATE_WORKFLOW.md", "HOSTING.md",
                       "ORACLE_CLOUD_DEPLOY.md", "ORACLE_BEGINNER.md"]) {
  app.get("/" + docName, (req, res) => {
    const f = path.join(__dirname, docName);
    if (!fs.existsSync(f)) return res.status(404).send("Not Found");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(f);
  });
}

app.get(["/admin", "/admin/*"], (req, res) => {
  res.sendFile(path.join(publicDir, "admin", "index.html"));
});
app.get(["/viewer", "/viewer/*"], (req, res) => {
  res.sendFile(path.join(publicDir, "viewer", "index.html"));
});
app.get("/", (req, res) => { res.redirect("/viewer"); });
app.get("*", (req, res) => { res.sendFile(path.join(publicDir, "viewer", "index.html")); });

// ═══ グローバル エラーハンドラ ═══
// 未捕捉のエラーを DIAG に記録 + 500 を返す
app.use((err, req, res, next) => {
  recordError(err, req, res, 500);
  if (res.headersSent) return next(err);
  res.status(500).json({
    error: "サーバーエラー",
    message: process.env.NODE_ENV === "production"
      ? undefined  // 本番では内部詳細を返さない
      : String(err.message || err),
  });
});

// 未捕捉の Promise 例外 / 同期例外
process.on("uncaughtException", (err) => {
  recordError(err, null, null, 500);
  console.error("[FATAL] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordError(err, null, null, 500);
  console.error("[FATAL] unhandledRejection:", reason);
});

app.listen(PORT, () => {
  console.log(`\n🏓 卓球大会運営アプリ 起動中`);
  console.log(`   閲覧画面:  http://localhost:${PORT}/viewer`);
  console.log(`   管理画面:  http://localhost:${PORT}/admin`);
  console.log(`   API:       http://localhost:${PORT}/api/health`);
  if (ADMIN_KEY) console.log(`   ADMIN_KEY: 設定あり（管理API保護）`);
  console.log("");
});
