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
const mailer = require("./mailer");

// ─── Web Push (任意機能) ────────────────────────────────
// web-push 未インストールでもサーバーは動作する (プッシュのみ無効化)。
// VAPID 鍵は初回に自動生成して DB(app_kv) に保存する。
let webpush = null;
let PUSH_ENABLED = false;
let VAPID_PUBLIC = "";
try {
  webpush = require("web-push");
  let pub = db.kvGet("vapid_public");
  let priv = db.kvGet("vapid_private");
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    db.kvSet("vapid_public", pub);
    db.kvSet("vapid_private", priv);
    console.log("[push] VAPID 鍵を新規生成しました");
  }
  const subject = process.env.PUSH_CONTACT || "mailto:admin@example.com";
  webpush.setVapidDetails(subject, pub, priv);
  VAPID_PUBLIC = pub;
  PUSH_ENABLED = true;
  console.log("[push] Web Push 有効");
} catch (e) {
  console.warn("[push] Web Push 無効 (web-push 未インストール等):", e.message);
}

// 指定選手の全購読端末へ通知を送信 (失効した購読は削除)
async function sendPushToPlayer(playerId, payload) {
  if (!PUSH_ENABLED || !playerId) return;
  const subs = db.getPushSubscriptionsForPlayer(playerId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async ({ endpoint, sub }) => {
    try {
      await webpush.sendNotification(sub, body);
    } catch (err) {
      // 410 Gone / 404 → 購読失効。DBから削除。
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        db.deletePushSubscription(endpoint);
      }
    }
  }));
}

// xlsx 一時アップロード保存先 (拡張子保持)
const uploadDir = path.join(os.tmpdir(), "tt-uploads");
fs.mkdirSync(uploadDir, { recursive: true });
// 許可する拡張子 (Excel / PDF / 画像) — それ以外は拒否 (Y4 対策)
const ALLOWED_UPLOAD_EXT = new Set([".xlsx", ".xls", ".xlsm", ".csv", ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
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
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ALLOWED_UPLOAD_EXT.has(ext)) return cb(null, true);
    cb(new Error("対応していないファイル形式です (" + (ext || "不明") + ")。Excel/PDF/画像のみ許可"));
  },
});

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const IS_PROD = process.env.NODE_ENV === "production";

// HTML エラー応答 (本番では内部詳細を隠す — Y3 対策)
function errHtml(title, e) {
  const safe = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const detail = IS_PROD
    ? "<p>時間をおいて再度お試しください。解決しない場合は管理者にご連絡ください。</p>"
    : "<pre>" + safe(e && e.message || e) + "</pre>";
  return "<!doctype html><meta charset='utf-8'><style>body{font-family:system-ui;padding:40px;color:#1c1917}" +
    "h1{font-size:20px;color:#b91c1c}pre{background:#f5f5f4;padding:12px;border-radius:6px;overflow:auto}</style>" +
    "<h1>" + safe(title) + "</h1>" + detail;
}

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

// セキュリティヘッダ (依存追加なしの簡易 helmet 相当)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  // HTTPS 配信時のみ HSTS (nginx/Caddy 経由の x-forwarded-proto を信頼)
  if (IS_PROD && (req.secure || req.get("x-forwarded-proto") === "https")) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
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
// 変更系 (POST/PUT/DELETE) は X-Admin-Key ヘッダ必須 (URLにキーを載せない/Y2対策)。
// GET (Excel/PDF ダウンロード等・ヘッダ付与不可) のみ ?key= も許可。
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    // 本番で管理キー未設定なら「フェイルクローズ」: 無保護で通さず拒否する。
    // (キー流出やメール悪用による想定外コストを防ぐ — 開発時のみバイパス)
    if (IS_PROD) {
      if (!requireAdmin._warned) {
        requireAdmin._warned = true;
        console.error("[SECURITY] ADMIN_KEY 未設定 — 管理APIを全て 503 で停止します。/etc/ktta.env に ADMIN_KEY を設定してください。");
      }
      return res.status(503).json({ error: "管理機能は未設定です。サーバーに ADMIN_KEY を設定してください。" });
    }
    return next(); // 開発環境のみ無保護を許可
  }
  const headerKey = req.get("X-Admin-Key");
  const key = headerKey || (req.method === "GET" ? req.query.key : null);
  if (key === ADMIN_KEY) return next();
  res.status(401).json({ error: "管理キーが必要です" });
}

// ── 軽量レート制限 (公開申込のスパム/DoS 対策, 依存追加なし) ──
// IP ごとに windowMs 内 max 回まで。メモリ上の簡易実装。
function rateLimit({ windowMs = 60000, max = 20, message = "リクエストが多すぎます。しばらく待って再試行してください。" } = {}) {
  const hits = new Map(); // ip -> [timestamps]
  // 定期的に古いエントリを掃除 (メモリリーク防止)
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, arr] of hits) {
      const fresh = arr.filter(t => t > cutoff);
      if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const ip = (req.headers["x-forwarded-for"] || req.ip || req.connection?.remoteAddress || "unknown")
      .toString().split(",")[0].trim();
    const now = Date.now();
    const cutoff = now - windowMs;
    const arr = (hits.get(ip) || []).filter(t => t > cutoff);
    arr.push(now);
    hits.set(ip, arr);
    if (arr.length > max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
// 公開申込: 1分間に10件まで (同一IP)
const entryRateLimit = rateLimit({ windowMs: 60000, max: 10 });

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
app.post("/api/public/tournaments/:id/entry", entryRateLimit, (req, res) => {
  const r = db.createEntry(req.params.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});

// 新方式: 申込フォーム (entry_form.js) からの team-style POST 受け口
// GAS 経由でも、同一サーバー直接でも受けられる (text/plain or application/json)
// CORS は全開放 (公開フォームのため)
app.options("/api/public/tournaments/:id/submit-team-entry", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});
app.post("/api/public/tournaments/:id/submit-team-entry",
  entryRateLimit,
  express.text({ limit: "1mb", type: ["text/plain", "application/json"] }),
  async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    let payload = req.body;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); }
      catch { return res.status(400).json({ error: "JSON parse error", raw: payload.slice(0, 200) }); }
    }
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "ペイロードが空です" });
    }
    try {
      const r = db.createTeamEntry(req.params.id, payload);
      if (r.error) return res.status(400).json(r);

      // ── 控えメール送信 (非同期・失敗してもレスポンスはOKを返す) ──
      const tournament = db.getTournament(req.params.id);
      const mailResults = { confirmation: null, admin: null };
      if (mailer.isEnabled() && tournament) {
        const adminUrl = `${req.protocol}://${req.headers.host}/admin#tournament/${req.params.id}`;
        // 並列送信
        const [confirmRes, adminRes] = await Promise.allSettled([
          mailer.sendConfirmationEmail({ tournament, formData: payload, result: r }),
          mailer.sendAdminNotification({ tournament, formData: payload, result: r, adminUrl }),
        ]);
        mailResults.confirmation = confirmRes.status === "fulfilled"
          ? confirmRes.value : { ok: false, error: String(confirmRes.reason) };
        mailResults.admin = adminRes.status === "fulfilled"
          ? adminRes.value : { ok: false, error: String(adminRes.reason) };
      }
      res.status(201).json({ ...r, mail: mailResults });
    } catch (e) {
      recordError(e, req, res, 500);
      res.status(500).json({ error: "申込処理エラー: " + e.message });
    }
  }
);

// SMTP 設定状態を返す + テスト送信エンドポイント (admin専用)
app.get("/api/mail/status", requireAdmin, (req, res) => {
  res.json({
    enabled: mailer.isEnabled(),
    config: {
      ...mailer.config,
      // パスワードは絶対に返さない
    },
  });
});
app.post("/api/mail/test", requireAdmin, async (req, res) => {
  const to = req.body?.to || mailer.config.ADMIN_EMAIL;
  if (!to) return res.status(400).json({ error: "送信先メールアドレスが指定されていません" });
  try {
    const info = await mailer.sendTestEmail(to);
    res.json({ ok: true, message_id: info.messageId, to });
  } catch (e) {
    res.status(500).json({ error: "送信失敗: " + e.message });
  }
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

// ── 個別戦績 (試合) の手動入力・削除 ──
// 選手の試合一覧 (編集用・手動フラグ付き)
app.get("/api/players/:id/match-records", requireAdmin, (req, res) => {
  res.json(db.getPlayerMatchesForEdit(req.params.id));
});
// 手動で試合戦績を追加
// body: { won, opponent_name, opponent_team, my_score, opp_score, event, date }
app.post("/api/players/:id/match-records", requireAdmin, (req, res) => {
  const r = db.createManualMatch(req.params.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});
// 試合戦績を削除 (手動・通常どちらも。通常はブラケット整合に注意)
app.delete("/api/match-records/:id", requireAdmin, (req, res) => {
  db.deleteMatch(req.params.id); res.json({ ok: true });
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
// 進行管理から「予定試合」を追加 (player1/player2・status・台を保存)
app.post("/api/tournaments/:id/scheduled-match", requireAdmin, (req, res) => {
  const r = db.createScheduledMatch(req.params.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
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
// entrant.note には申込者の連絡先(氏名/メール/電話)が含まれる場合があるため、
// 一覧APIからは常に除外する (C1: PII漏洩対策)。連絡先は申込管理(entries)側で扱う。
function stripEntrantPII(rows) {
  return (rows || []).map(r => { const { note, ...rest } = r; return rest; });
}
app.get("/api/tournaments/:id/entrants", (req, res) => {
  res.json(stripEntrantPII(db.getEntrants(req.params.id, req.query.event)));
});
app.get("/api/public/tournaments/:id/entrants", (req, res) => {
  res.json(stripEntrantPII(db.getEntrants(req.params.id, req.query.event)));
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
// ── 抽選番号 (No.) 一括自動付与 ──
// POST body: { event?, mode?, force? }
//   event=指定なし → 全種目
//   mode: 'shuffle' (default) | 'submitted' | 'surname'
//   force: true なら既存番号も上書き
app.post("/api/tournaments/:id/entrants/auto-number", requireAdmin, (req, res) => {
  try {
    const r = db.autoAssignDrawNumbers(req.params.id, req.body || {});
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 名簿データ JSON ──
app.get("/api/tournaments/:id/roster.json", (req, res) => {
  const data = db.buildRosterData(req.params.id);
  if (!data) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(data);
});

// ── 名簿 HTML (印刷可・ニッタク杯形式) ──
app.get("/api/tournaments/:id/roster.html", (req, res) => {
  const data = db.buildRosterData(req.params.id);
  if (!data) return res.status(404).type("html").send("<h1>大会が見つかりません</h1>");
  const html = buildRosterHTML(data);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

function _escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildRosterHTML(data) {
  const t = data.tournament;
  const dateStr = t.date || "";
  const venue = t.venue || "";
  // 重複セクション
  const dupSection = data.duplicates.length
    ? `<section class="dup-section">
      <h2>重複申込チェック (${data.duplicates.length}名)</h2>
      <p class="dup-note">複数種目にエントリーしている選手 (要確認):</p>
      <table class="dup-table">
        <thead><tr><th>選手名</th><th>所属</th><th>出場種目</th></tr></thead>
        <tbody>${data.duplicates.map(d => `
          <tr>
            <td>${_escHtml(d.name)}</td>
            <td>${_escHtml(d.team)}</td>
            <td>${d.events.map(e => `<span class="ev-tag">${_escHtml(e)}</span>`).join("")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>`
    : `<section class="dup-section ok">
      <h2>重複申込チェック</h2>
      <p>重複申込はありません ✓</p>
    </section>`;

  // 種目別シート
  const eventSections = data.events.map(ev => {
    const rows = ev.entrants.map(e => {
      const num = `<td class="no">${e.no}</td>`;
      if (e.is_doubles) {
        return `<tr${e.dup_self || e.dup_partner ? ' class="dup"' : ""}>
          ${num}
          <td class="name${e.dup_self ? " dup-cell" : ""}">${_escHtml(e.name)}</td>
          <td class="name${e.dup_partner ? " dup-cell" : ""}">${_escHtml(e.partner_name)}</td>
          <td class="team">(${_escHtml(e.team)})</td>
          <td class="team">(${_escHtml(e.partner_team)})</td>
        </tr>`;
      }
      return `<tr${e.dup_self ? ' class="dup"' : ""}>
        ${num}
        <td class="name${e.dup_self ? " dup-cell" : ""}" colspan="2">${_escHtml(e.name)}</td>
        <td class="team" colspan="2">(${_escHtml(e.team)})</td>
      </tr>`;
    }).join("");
    return `<section class="event-section">
      <h3>${_escHtml(ev.name)} <span class="count">(${ev.count}名${ev.type === "double" ? "組" : ""})</span></h3>
      <table class="roster-table">${rows}</table>
    </section>`;
  }).join("");

  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<title>${_escHtml(t.name)} - 重複管理表 (名簿)</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Hiragino Mincho ProN", "Yu Mincho", "Yu Gothic UI", system-ui, sans-serif;
    color: #1c1917; background: #fff; padding: 16px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  header {
    text-align: right; margin-bottom: 24px; padding-bottom: 14px;
    border-bottom: 2px solid #b91c1c;
  }
  header h1 { font-size: 18px; margin-bottom: 4px; }
  header .meta { font-size: 12px; color: #57534e; }

  .dup-section {
    margin-bottom: 20px; padding: 12px 14px;
    background: #fef3c7; border-left: 4px solid #d97706;
    border-radius: 4px;
  }
  .dup-section.ok {
    background: #f0fdf4; border-left-color: #15803d;
  }
  .dup-section h2 { font-size: 14px; margin-bottom: 6px; color: #78350f; }
  .dup-section.ok h2 { color: #14532d; }
  .dup-note { font-size: 12px; margin-bottom: 8px; color: #78716c; }
  .dup-table { width: 100%; border-collapse: collapse; font-size: 12px; background: #fff; }
  .dup-table th, .dup-table td {
    padding: 6px 8px; border: 1px solid #e7e5e4; text-align: left;
  }
  .dup-table th { background: #f5f5f4; font-weight: bold; }
  .ev-tag {
    display: inline-block; padding: 1px 6px; margin: 1px 3px 1px 0;
    background: #fee2e2; border-radius: 3px; font-size: 11px; color: #7c2d12;
  }

  .event-section {
    margin-bottom: 18px; page-break-inside: avoid;
  }
  .event-section h3 {
    font-size: 14px; padding: 6px 10px;
    background: linear-gradient(to right, #fef9c3, #fef3c7);
    border-left: 5px solid #b91c1c;
    margin-bottom: 6px;
  }
  .event-section h3 .count {
    font-size: 11px; color: #57534e; font-weight: normal; margin-left: 6px;
  }
  .roster-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .roster-table tr { page-break-inside: avoid; }
  .roster-table td {
    padding: 5px 8px; border-bottom: 1px solid #e7e5e4;
    vertical-align: middle;
  }
  .roster-table tr.dup { background: #fef3c7; }
  .roster-table .no {
    width: 36px; text-align: center; font-weight: bold;
    color: #7c2d12; font-family: "Hiragino Sans", system-ui, sans-serif;
  }
  .roster-table .name { font-weight: bold; }
  .roster-table .name.dup-cell { color: #b91c1c; }
  .roster-table .name.dup-cell::before { content: "● "; font-size: 10px; }
  .roster-table .team { color: #78716c; font-size: 12px; }

  .toolbar {
    position: fixed; top: 12px; right: 12px;
    display: flex; gap: 8px;
  }
  .toolbar button {
    padding: 6px 14px; border: 1px solid #d6d3d1;
    background: #fff; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 12px;
  }
  .toolbar button:hover { background: #fafaf9; }
  @media print { .toolbar { display: none !important; } }
</style></head><body>
<div class="toolbar">
  <button onclick="window.print()">印刷</button>
  <button onclick="window.close()">閉じる</button>
</div>
<header>
  <div class="meta">釧路卓球協会</div>
  <h1>${_escHtml(t.name)}</h1>
  <div class="meta">
    ${dateStr ? "日時: " + _escHtml(dateStr) : ""}
    ${venue ? " / 会場: " + _escHtml(venue) : ""}
    / 出力: ${new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })}
  </div>
</header>
${dupSection}
${eventSections || '<p style="text-align:center;padding:40px;color:#a8a29e;">エントリーがまだありません</p>'}
</body></html>`;
}

// シード配置でトーナメント生成
// body: { event, regenerate?, entrant_ids? }
app.post("/api/tournaments/:id/bracket/generate", requireAdmin, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.generateBracket(req.params.id, event, {
    regenerate: req.body?.regenerate !== false,
    entrant_ids: req.body?.entrant_ids || null,
  });
  if (r?.error) return res.status(400).json(r);
  res.json(r);
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
      data.placement = "as_drawn"; // 取り込んだ表通りに対戦を固定配置 (再シードしない)
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
    data.placement = "as_drawn"; // 取り込んだ表通りに対戦を固定配置 (再シードしない)
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
let templateParser = null;
let templateBuilder = null;
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
try {
  templateParser = require("./tools/parse_template_bracket.js");
  templateBuilder = require("./tools/build_bracket_template.js");
} catch (e) {
  console.warn("[startup] テンプレ パーサーのロード失敗:", e.message);
}

// テンプレ Excel ダウンロード
app.get("/api/templates/bracket-import.xlsx", (req, res) => {
  if (!templateBuilder || !templateBuilder.buildTemplateBuffer) {
    return res.status(500).json({ error: "テンプレ生成モジュール未ロード" });
  }
  try {
    const buf = templateBuilder.buildTemplateBuffer({
      tournament_name: req.query.name || "釧路選手権大会 (記入例)",
      event: req.query.event || "一般男子シングルス",
      bracket_size: parseInt(req.query.size) || 64,
    });
    const filename = encodeURIComponent("トーナメント取込テンプレ.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  } catch (e) {
    res.status(500).json({ error: "テンプレ生成失敗: " + e.message });
  }
});

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

  // ── 1b-pre. テンプレ判定 (「設定」+「組合せ」シートあり) ──
  // 取込テンプレを優先試行 → 位置情報を正確に反映
  if (templateParser && templateParser.parseTemplate) {
    try {
      const XLSX = require("xlsx");
      const wb = XLSX.readFile(xlsxPath, { cellStyles: false });
      const hasTemplate = wb.SheetNames.includes("設定") && wb.SheetNames.includes("組合せ");
      if (hasTemplate) {
        const data = templateParser.parseTemplate(xlsxPath);
        try { fs.unlinkSync(xlsxPath); } catch {}
        if (data.error) {
          return res.status(400).json({ ...data, used_parser: "parse_template_bracket.js" });
        }
        data.regenerate = regenerate;
        data.auto_link_to_players = autoLink;
        const r = db.importBracket(req.params.id, data);
        return res.json({ ...r, used_parser: "parse_template_bracket.js" });
      }
    } catch (e) {
      console.warn("[parser] テンプレ判定失敗、汎用パーサーへフォールバック:", e.message);
    }
  }

  // ── 1b. Node.js 汎用 Excel パーサー (シード抽出) ──
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
    res.status(500).send(errHtml("領収書生成に失敗しました", e));
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
    res.status(500).send(errHtml("フォーム生成に失敗しました", e));
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
// 外部通信を行うため、コスト/クォータ悪用防止に専用レート制限 + タイムアウトを付与 (H1/H2対策)
const gasProxyRateLimit = rateLimit({ windowMs: 60000, max: 20,
  message: "集計取得が多すぎます。しばらく待って再試行してください。" });
app.get("/api/tournaments/:id/gas-stats", gasProxyRateLimit, async (req, res) => {
  const gasUrl = req.query.gas_url || "";
  if (!gasUrl) return res.status(400).json({ error: "gas_url が必要です" });
  // ホストを script.google.com に固定 (任意URLへの踏み台/SSRF防止)
  let parsed;
  try { parsed = new URL(gasUrl); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== "https:" || parsed.hostname !== "script.google.com") {
    return res.status(400).json({ error: "gas_url は https://script.google.com/... 形式である必要があります" });
  }
  try {
    const tournament = db.getTournament(req.params.id);
    const tournamentId = tournament ? tournament.id : req.params.id;
    const sep = gasUrl.includes("?") ? "&" : "?";
    const fullUrl = gasUrl + sep + "action=stats&tournament_id=" + encodeURIComponent(tournamentId);
    // Node 18+ なら fetch がネイティブ。GAS は googleusercontent へ 302 するため redirect は follow。
    // 8秒でタイムアウト (ハング・スローロリス対策)。
    const r = await fetch(fullUrl, { redirect: "follow", signal: AbortSignal.timeout(8000) });
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

// ── 進行状態(getOperationState)のフィンガープリント・キャッシュ ──
// 多数の観戦者が同時にポーリングしても、進行に変化が無ければ1回の計算結果を共有。
// キーは軽量フィンガープリント(呼出/結果/再コールで変化)なので、
// 変化が無い間は重い計算を一切行わず、変化直後は1回だけ再計算して全員で共有する。
// (TTLではなくフィンガープリント方式なので、運営の操作結果は即時反映され古い表示が出ない)
const _liveCache = new Map(); // tid -> { key, state }
function getCachedOperationState(tid) {
  const fp = db.getOpsFingerprint(tid);
  if (!fp || fp.error) return db.getOperationState(tid); // 大会なし等は通常処理(404)
  const key = fp.v + "|" + (fp.status || "");
  const c = _liveCache.get(tid);
  if (c && c.key === key) return c.state;
  const state = db.getOperationState(tid);
  _liveCache.set(tid, { key, state });
  if (_liveCache.size > 300) { // 古いエントリを軽く掃除
    const it = _liveCache.keys();
    while (_liveCache.size > 200) { const k = it.next().value; if (k === undefined) break; _liveCache.delete(k); }
  }
  return state;
}

app.get("/api/tournaments/:id/operations", (req, res) => {
  const state = getCachedOperationState(req.params.id);
  if (!state) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(state);
});

app.get("/api/public/tournaments/:id/live", (req, res) => {
  const state = getCachedOperationState(req.params.id);
  if (!state) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(state);
});

// 進行の変化検知用 軽量エンドポイント (クライアントは変化時のみ重い /live を取得)
app.get("/api/public/tournaments/:id/ops-version", (req, res) => {
  res.json(db.getOpsFingerprint(req.params.id));
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
  // 呼出成功 → 当該試合の選手にプッシュ通知 (対戦が入った段階での通知) #188
  try {
    const m = db.getMatch(req.params.id);
    if (m && PUSH_ENABLED) {
      const tableNo = m.table_no || (parseInt(req.body?.table_no) || 0);
      const mk = (meId, oppName) => ({
        title: "あなたの試合です！",
        body: `${m.event || ""} ${m.round || ""}\nvs ${oppName || "?"}` + (tableNo ? `\n台 ${tableNo} へお越しください` : ""),
        url: "/viewer/#mynumber",
        tag: "ktta-call",
      });
      if (m.player1_id) sendPushToPlayer(m.player1_id, mk(m.player1_id, m.player2_name)).catch(() => {});
      if (m.player2_id) sendPushToPlayer(m.player2_id, mk(m.player2_id, m.player1_name)).catch(() => {});
    }
  } catch (e) { /* 通知失敗は無視 (呼出本体は成功済み) */ }
});

app.post("/api/matches/:id/uncall", requireAdmin, (req, res) => {
  res.json(db.uncallMatch(req.params.id));
});

// ─── Web Push 購読 API ──────────────────────────────────
app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ enabled: PUSH_ENABLED, key: VAPID_PUBLIC });
});
app.post("/api/push/subscribe", (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "プッシュ通知は無効です" });
  const { player_id, subscription } = req.body || {};
  if (!player_id || !subscription) return res.status(400).json({ error: "player_id と subscription が必要です" });
  const r = db.savePushSubscription(player_id, subscription);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", (req, res) => {
  const ep = (req.body || {}).endpoint;
  if (ep) db.deletePushSubscription(ep);
  res.json({ ok: true });
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

// 結果修正 (完了済み試合の再編集)
// body: { winner_slot: 1|2, sets: [[w,l]...], winner_sets?, loser_sets? }
// 次の試合に既に進出済みなら自動で取消 → 新勝者で再進出
app.post("/api/matches/:id/correct", requireAdmin, (req, res) => {
  const r = db.correctResult(req.params.id, req.body || {});
  if (r?.error) return res.status(400).json(r);
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

// ドラッグ&ドロップ: 1回戦の選手位置を入れ替え
app.post("/api/tournaments/:id/bracket/swap", requireAdmin, (req, res) => {
  const { event, a, b } = req.body || {};
  if (!event || !a || !b) return res.status(400).json({ error: "event, a, b が必要です" });
  const r = db.swapBracketSlots(req.params.id, event, a, b);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// 1回戦の1スロットを設定 (BYE化/空き/別選手に置換) — 取込ズレ・シードの手動修正
app.post("/api/tournaments/:id/bracket/set-slot", requireAdmin, (req, res) => {
  const { event, pos, slot } = req.body || {};
  if (!event || pos == null || slot == null) return res.status(400).json({ error: "event, pos, slot が必要です" });
  const r = db.setBracketSlot(req.params.id, event, pos, slot, req.body || {});
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
app.get("/api/export/all", requireAdmin, (req, res) => { res.json(db.exportAllData()); });
app.get("/api/export/players", requireAdmin, (req, res) => { res.json(db.exportAllData()); });
app.post("/api/import/players", requireAdmin, (req, res) => {
  res.json(db.importPlayers(req.body.players || []));
});

// ═══ 統計 ═══════════════════════════════════════════════
app.get("/api/stats", (req, res) => { res.json(db.getStats()); });
app.get("/api/last-updated", (req, res) => { res.json({ t: db.getLastUpdated() }); });
app.get("/api/health", (req, res) => {
  // 公開ヘルスチェックは最小限のみ (M1: バージョン/メモリ/環境などの内部情報は出さない)。
  // 詳細は admin 専用の /api/diagnostics で確認する。
  let dbOk = false;
  try { db.getStats(); dbOk = true; } catch (e) { dbOk = false; }
  res.json({ ok: dbOk, time: new Date().toISOString() });
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

// ── 公開申込フォーム /entry/:id ───────────────────────
// Jimdo 等への iframe 埋込にも、単独URL公開にもこの URL を使用。
// 既存 /api/tournaments/:id/entry-form.html と同じ HTML を返すが
// デフォルトで「自己サーバーに POST」する設定にする (GAS 不要)。
app.get("/entry/:id", (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) {
      return res.status(404).type("html").send(
        "<!doctype html><meta charset='utf-8'><title>大会が見つかりません</title>" +
        "<style>body{font-family:system-ui;text-align:center;padding:80px 20px;color:#1c1917}" +
        "h1{font-size:24px}p{color:#78716c}</style>" +
        "<h1>大会が見つかりません</h1><p>URL を確認してください。</p>"
      );
    }
    const events = _resolveEvents(tournament);
    // POST 先: 大会に GAS URL が設定されていればそちらへ (スプレッドシート連携)
    //          設定されていなければ本サーバーへ (自己完結)
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const selfUrl = `${proto}://${host}/api/public/tournaments/${tournament.id}/submit-team-entry`;
    const postUrl = (tournament.entry_gas_url && /^https:\/\/script\.google\.com\//.test(tournament.entry_gas_url))
      ? tournament.entry_gas_url
      : (req.query.gas_url || selfUrl);

    const html = entryForm.buildEntryFormHTML(tournament, events, {
      gas_url: postUrl,
      admin_email: req.query.admin_email || "",
      deadline: tournament.entry_deadline || req.query.deadline || "",
      payment_note: req.query.payment_note || "",
      notes: req.query.notes || "",
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors *;");
    res.send(html);
  } catch (e) {
    recordError(e, req, res, 500);
    res.status(500).send(errHtml("フォーム生成に失敗しました", e));
  }
});

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
