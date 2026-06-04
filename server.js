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
const crypto = require("crypto");
const { spawn } = require("child_process");
// 子プロセス実行に上限を課す (#20): タイムアウトで SIGKILL し、stdout 肥大も打ち切る。
// 不正/巨大な xlsx・pdf でパーサがハング/暴走しても、リクエストとサーバ全体を巻き込まない。
function runChild(cmd, args, { env, timeoutMs = 30000, maxOut = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false, proc = null;
    let timer = null;
    const finish = (r) => {
      if (done) return; done = true;
      if (timer) clearTimeout(timer);
      try { if (proc && proc.exitCode == null) proc.kill("SIGKILL"); } catch {}
      resolve(r);
    };
    try { proc = spawn(cmd, args, { env }); }
    catch (e) { return resolve({ code: -1, out: "", err: e.message }); }
    timer = setTimeout(() => finish({ code: -1, out: "", err: "timeout" }), timeoutMs);
    if (timer.unref) timer.unref();
    proc.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > maxOut) finish({ code: -1, out: "", err: "output too large" });
    });
    proc.stderr.on("data", (d) => { if (err.length < 65536) err += d.toString(); });
    proc.on("close", (code) => finish({ code, out, err }));
    proc.on("error", (e) => finish({ code: -1, out: "", err: e.message }));
  });
}
const compression = require("compression");
const multer = require("multer");
const QRCode = require("qrcode");     // ローカルQR生成(会場オフラインで外部QRサービスに依存しないLAN接続案内用)
const db = require("./db");
const reports = require("./reports");
const entryForm = require("./entry_form");
const mailer = require("./mailer");
const { conditional } = require("./lib/http-cache");          // 条件付きGET(ETag/304)で未変化ポーリングを軽量化
const { installServerHardening } = require("./lib/lifecycle"); // HTTPタイムアウト調整 + graceful shutdown

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

// この選手を名簿に持つ監督の端末へまとめて呼出通知 (#287)
async function sendPushToCoachesForPlayer(playerId, payload) {
  if (!PUSH_ENABLED || !playerId) return;
  const subs = db.getCoachSubscriptionsForPlayer(playerId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async ({ endpoint, sub }) => {
    try { await webpush.sendNotification(sub, body); }
    catch (err) {
      if (err && (err.statusCode === 410 || err.statusCode === 404)) db.deleteCoachSubscription(endpoint);
    }
  }));
}

// 有効な全監督端末へ一斉配信 (本部お知らせ #290)。送信できた件数を返す。
async function sendPushToAllCoaches(payload) {
  if (!PUSH_ENABLED) return 0;
  const subs = db.getAllCoachSubscriptions();
  if (!subs.length) return 0;
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async ({ endpoint, sub }) => {
    try { await webpush.sendNotification(sub, body); sent++; }
    catch (err) {
      if (err && (err.statusCode === 410 || err.statusCode === 404)) db.deleteCoachSubscription(endpoint);
    }
  }));
  return sent;
}

// xlsx 一時アップロード保存先 (拡張子保持)
const uploadDir = path.join(os.tmpdir(), "tt-uploads");
fs.mkdirSync(uploadDir, { recursive: true });
// 許可する拡張子 (Excel / PDF / ラスタ画像) — それ以外は拒否 (Y4 対策)
// SVG は内部にスクリプトを含み得る (同一オリジン配信で保存型XSSの恐れ) ため除外。
const ALLOWED_UPLOAD_EXT = new Set([".xlsx", ".xls", ".xlsm", ".csv", ".pdf",
  ".png", ".jpg", ".jpeg", ".gif", ".webp"]);
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
// リバースプロキシ(Caddy/nginx)・Cloudflare・Cloudflare Tunnel の背後で動作するため
// X-Forwarded-* を信頼し、req.ip 等が実クライアントを指すようにする (#236)。
// 既定は true (現行動作を維持)。本番で Node ポートを直接到達可能にしている場合は
// 環境変数 TRUST_PROXY=loopback (やプロキシのIP/サブネット) に絞ると、
// X-Forwarded-For 偽装によるレート制限/SSE上限の回避を防げる。
function parseTrustProxy(v) {
  if (v === undefined || v === "") return true;   // 既定: 現行どおり
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);    // ホップ数
  return v;                                        // 'loopback' / IP / サブネットのCSV
}
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
// 実クライアントIP判定の唯一の出所 (#7/#25)。
// 生の cf-connecting-ip / x-forwarded-for[0] を無検証で信頼しない: それらは攻撃者が毎リクエスト偽装でき、
// レート制限・監督コード/審判パスコードの総当たりロックアウト・SSE上限を丸ごと回避できてしまう。
// Express の req.ip は上の `trust proxy` 設定に従って算出される。公開エッジの nginx が X-Forwarded-For を
// $remote_addr で上書きする (deploy/nginx.conf) 前提なら、クライアント偽装のXFFは破棄され req.ip=実クライアントになる。
// Cloudflare 配下で実クライアントIPの粒度が必要なら nginx 側で `X-Forwarded-For $http_cf_connecting_ip;` を設定する。
function clientIp(req) {
  return (req.ip || (req.socket && req.socket.remoteAddress) || "unknown").toString().trim();
}
// メール等に埋め込む正規オリジン。クライアント供給の X-Forwarded-Host は信用しない
// (ホストヘッダ注入で確認URL/トークンを攻撃者サーバへ誘導されるのを防ぐ)。
// 優先: 環境変数 PUBLIC_BASE_URL → nginx が設定する Host(=$host) + X-Forwarded-Proto。
function appOriginOf(req) {
  const env = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (env) return env;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers.host || "";   // X-Forwarded-Host(クライアント制御)は使わない
  return `${proto}://${host}`;
}
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
// クラウド公開ミラー同期(本部ローカル=正本 → クラウド)。
//   SYNC_KEY: 受信側(クラウド)に設定すると /api/sync/push を有効化。送信側(本部)にも同値を設定。
//   SYNC_CLOUD_URL: 送信側(本部ローカル)に設定するクラウドのベースURL。設定時のみ push する。
const SYNC_KEY = process.env.SYNC_KEY || "";
const SYNC_CLOUD_URL = (process.env.SYNC_CLOUD_URL || "").replace(/\/$/, "");
const _syncState = { last_ok_at: null, last_error: null, last_count: 0 };
async function pushTournamentToCloud(tid) {
  if (!SYNC_CLOUD_URL || !SYNC_KEY) return { error: "クラウド同期が未設定です(SYNC_CLOUD_URL / SYNC_KEY)" };
  const snap = db.exportPublicSnapshot(tid);
  if (!snap) return { error: "大会が見つかりません" };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(SYNC_CLOUD_URL + "/api/sync/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Key": SYNC_KEY },
      body: JSON.stringify(snap), signal: ctrl.signal,
    });
    clearTimeout(to);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { _syncState.last_error = "HTTP " + res.status + (j.error ? " " + j.error : ""); return { error: _syncState.last_error }; }
    _syncState.last_ok_at = new Date().toISOString(); _syncState.last_error = null; _syncState.last_count = (snap.matches || []).length;
    return { ok: true, matches: snap.matches.length };
  } catch (e) {
    clearTimeout(to);
    _syncState.last_error = (e && e.name === "AbortError") ? "タイムアウト(オフライン?)" : (e && e.message) || "失敗";
    return { error: _syncState.last_error };
  }
}
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
          ct.includes("image/") || ct.includes("pdf") ||
          ct.includes("event-stream")) {   // SSE はバッファ厳禁 (#264 リアルタイムpush)
        return false;
      }
    }
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: "10mb" }));

// ── 冪等性ガード: op_id 付き書込みの二重適用を防ぐ (オフライン再送対策) ──
// クライアントが op_id (body または X-Op-Id ヘッダ) を付けて再送した場合、
// 既に成功済みなら処理を再実行せず前回のレスポンスを返す。
// op_id 無しのリクエストは素通り (従来通り)。成功(2xx)のみキャッシュ。
const _idempCache = new Map(); // op_id -> { status, body, t }
// 有効期限ベースで保持する。数量(FIFO)evictだと、オフライン端末が1000件超の後に
// 復帰して再送した場合に op_id が押し出されて二重適用(/finish・/correct=二重Elo/枠再反映)
// が起きるため、再送猶予(大会1日分)を確保しつつ古いものは時間で破棄する。
const IDEMP_TTL_MS = 12 * 60 * 60 * 1000;  // 12時間 (大会1日をカバー)
const IDEMP_MAX = 20000;                    // メモリ上限の保険 (主役はTTL掃引)
let _idempLastSweep = 0;
function _idempSweep(now) {
  for (const [k, v] of _idempCache) { if (now - v.t > IDEMP_TTL_MS) _idempCache.delete(k); }
  // 掃引後もなお上限超過(異常な大量書込み)なら古い順に間引く保険
  while (_idempCache.size > IDEMP_MAX) {
    const k = _idempCache.keys().next().value;
    if (k === undefined) break;
    _idempCache.delete(k);
  }
  _idempLastSweep = now;
}
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const opId = (req.body && req.body.op_id) || req.get("X-Op-Id");
  if (!opId) return next();
  // キーは method+path+op_id に名前空間化する。op_id 単体だと、別ルート/別権限の要求が
  // 同じ op_id を提示した際に前回応答を取り違える(公開POSTでキャッシュを仕込み、後続の
  // 管理操作が素通りする等)。同一URL+同一op_idの再送だけが正しくヒットする。
  const cacheKey = req.method + " " + req.path + "::" + opId;
  const hit = _idempCache.get(cacheKey);
  if (hit) {
    if (Date.now() - hit.t <= IDEMP_TTL_MS) { res.set("X-Idempotent-Replay", "1"); return res.status(hit.status).json(hit.body); }
    _idempCache.delete(cacheKey);  // 期限切れ(再送猶予を過ぎた)→破棄して通常処理
  }
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const sc = res.statusCode || 200;
    if (sc < 400) {
      const now = Date.now();
      _idempCache.set(cacheKey, { status: sc, body, t: now });
      if (now - _idempLastSweep > 60000 || _idempCache.size > IDEMP_MAX) _idempSweep(now);
    }
    return origJson(body);
  };
  next();
});

// CORS（大会運営アプリや別ドメインのViewerから叩けるように）
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, X-Op-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// セキュリティヘッダ (依存追加なしの簡易 helmet 相当)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // 検索エンジン索引を全面禁止 (#271): 参加者(未成年含む)の氏名・所属が
  // 検索結果から「思わぬところ」で閲覧される事故を防ぐ。robots.txt と二重で抑止。
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // 埋込許可パス(Jimdo/STUDIO等の外部サイトに iframe 埋込するウィジェット/申込フォーム)は
  // X-Frame-Options:SAMEORIGIN を付けると外部ドメインで真っ白になるため、frame-ancestors * を使う。
  // (X-Frame-Options に「任意元許可」値は無い。ALLOWALL は非標準で無視されるため CSP を使用。)
  const p = req.path || "";
  // 申込フォーム(/entry/:id)・ウィジェットは外部サイト埋込のため frame-ancestors * 。
  // ただし申込者本人の閲覧ページ /entry/status は PII(氏名/連絡先/料金)を表示するので
  // 第三者サイトへの iframe 埋込を許さない(クリックジャッキング対策)。
  const embeddable = (p.startsWith("/entry") && p !== "/entry/status" && !p.startsWith("/entry/status"))
    || p.startsWith("/widget") || p.includes("/entry-form");
  // Content-Security-Policy: 既知の外部リソース(Googleフォント / QR生成画像)だけ許可し他を遮断。
  // インラインscript/styleはアプリ構造上 'unsafe-inline' が必要だが、外部scriptの注入・
  // connect でのデータ持ち出し・object/base は塞ぐ(XSS時の被害を限定)。
  // frame-ancestors は埋込許可パスのみ * 、それ以外は 'self' (クリックジャッキング対策)。
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://api.qrserver.com",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors " + (embeddable ? "*" : "'self'"),
  ].join("; "));
  // 旧ブラウザ向けクリックジャッキング対策フォールバック (埋込パス以外)
  if (!embeddable) res.setHeader("X-Frame-Options", "SAMEORIGIN");
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

// 定数時間比較 (タイミング攻撃でキー長/内容を推測されないように)。
function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a));
  const bb = Buffer.from(String(b == null ? "" : b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}
// ADMIN_KEY 設定時のみ管理APIを保護。
// 認証は X-Admin-Key ヘッダのみ受け付ける (URLに ?key= を載せない=
// アクセスログ/ブラウザ履歴/Referer への管理キー漏えいを防止)。
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
  const key = req.get("X-Admin-Key");
  if (key && safeEqualStr(key, ADMIN_KEY)) return next();
  res.status(401).json({ error: "管理キーが必要です" });
}

// requireAdmin と同じ判定の真偽値版。リクエストは拒否せず「秘密フィールドを返すか」の出し分けに使う。
function isAdminAuthed(req) {
  if (!ADMIN_KEY) return !IS_PROD;            // 開発時のみ許可 / 本番でキー未設定はフェイルクローズ
  const key = req.get("X-Admin-Key");
  return !!(key && safeEqualStr(key, ADMIN_KEY));
}

// 未認証レスポンスから漏らしてはならない大会の秘密フィールド。
//  referee_token / referee_passcode(_required): 審判認証の鍵 (#1)。漏洩すると会場限定・パスコード制が遠隔から無効化される。
//  entry_gas_url: 申込POST先の GAS URL (#14)。漏洩すると集計シートへの直接スパムを許す。
// 管理UIはこれらを referee-config 系 (requireAdmin) と認証済みの大会GET経由で取得するため、未認証側で落としても壊れない。
const TOURNAMENT_SECRET_FIELDS = ["referee_token", "referee_passcode", "referee_passcode_required", "entry_gas_url"];
function sanitizeTournamentPublic(t) {
  if (!t || typeof t !== "object") return t;
  const c = { ...t };
  for (const f of TOURNAMENT_SECRET_FIELDS) delete c[f];
  return c;
}

// 審判結果入力 用ミドルウェア (管理キーとは別の限定トークン)。
// X-Referee-Token ヘッダ or ?t= or body.t で受け取り、有効な大会に解決できれば通す。
// 解決できない=トークン無効/審判入力OFF/失効 → 403。req.refTournament に大会を載せる。
function requireReferee(req, res, next) {
  // (a) 共有トークン (大会全コート共通)
  const token = req.get("X-Referee-Token")
    || (req.query && req.query.t)
    || (req.body && req.body.t);
  if (token) {
    const t = db.getTournamentByRefereeToken(token);
    if (t) { req.refTournament = t; req.refCourt = null; return next(); }
  }
  // (b) コート別トークン (試験運用 #229): tid + court + ct。自分のコートのみ。
  const q = req.query || {}, b = req.body || {};
  const tid = q.tid || b.tid, court = q.court || b.court, ct = q.ct || b.ct;
  if (tid && court && ct) {
    const r = db.resolveRefereeCourt(tid, court, ct);
    if (r) { req.refTournament = r.tournament; req.refCourt = r.court; return next(); }
  }
  return res.status(403).json({
    error: "この審判用リンクは無効です（審判入力がOFF、またはリンクが失効しています）。本部にご確認ください。",
  });
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
    const ip = clientIp(req);   // trust proxy 準拠の req.ip (生ヘッダ偽装に依存しない / #7)
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
// 申込番号の照会(閲覧)は送信(entryRateLimit)とは別カウンタにする。共有すると
// 同一IP/NATからの照会が申込送信の枠を食い潰し合う(相互DoS)。照会はUI再読込分も見込み緩め。
const applicantLookupRateLimit = rateLimit({ windowMs: 60000, max: 40 });
// 検索/全件系(選手検索・横断検索・全試合検索・対戦比較)の per-IP 上限。全観客が常時叩く大会ビュー
// (matches/standings/live)には掛けず(会場NATで同一IPに多数の観客が居るため)、濫用向きの occasional な
// 検索系のみを緩く制限する。真の volumetric/分散DDoS はインフラ層(nginx limit_req / Cloudflare)が一次防御。
const publicSearchRateLimit = rateLimit({ windowMs: 60000, max: parseInt(process.env.PUBLIC_SEARCH_MAX) || 120,
  message: "検索リクエストが多すぎます。少し待って再試行してください。" });

// robots.txt: 全クローラに索引禁止を明示 (#271 参加者PII保護。X-Robots-Tag と二重)
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

// ═══ 公開API（閲覧画面用・認証なし） ═══════════════════
app.get("/api/public/players", publicSearchRateLimit, (req, res) => {
  const { search, gender, category, team, sort } = req.query;
  res.json(db.getPlayers({ search, gender, category, team, sort }));
});
app.get("/api/public/players/:id", (req, res) => {
  const player = db.getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(player);
});
app.get("/api/public/tournaments", (req, res) => { res.json(db.getTournaments().map(sanitizeTournamentPublic)); });
app.get("/api/public/tournaments/:id", (req, res) => {
  // 軽量版: 全試合の埋込みを省く (閲覧はメタ+選手数のみ使用し、試合は /matches を別途取得)。大規模大会で~1MBの無駄を削減。
  const t = db.getTournamentMeta(req.params.id);
  if (!t) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(sanitizeTournamentPublic(t));
});
// 公開 /matches から落とす内部列(進行内部・Elo差分・原文sets_json重複・承認待ち暫定結果)。
// 軽量化が主目的(数百試合で生320KB級→約▲59%)。表示に要る referee_name(「審判: X」を viewer が表示)・
// note・整形済 sets・tie_results・相方/bracket_number は残す(viewer未使用列のみ除去=描画を壊さない)。
const PUBLIC_MATCH_OMIT = new Set([
  "referee_id", "pending_result",
  "winner_rating_delta", "loser_rating_delta",
  "next_match_id", "next_slot",
  "call_count", "call_count_p1", "call_count_p2", "recall_count", "called_at",
  "sets_json", "tournament_id", "created_at", "updated_at",
]);
function publicMatch(m) { const o = {}; for (const k in m) if (!PUBLIC_MATCH_OMIT.has(k)) o[k] = m[k]; return o; }
// /live(on_table/recent_finished)専用の射影。/matches より残す列が多い: 再コール系
// (call_count*/recall_count/called_at)は PII でなく /viewer/live が「再コール」バッジ・呼出時刻として
// 観戦者に表示する意図的機能(コート盤面 tables[].match も表示)。これを落とすと盤面と進行中リストで
// バッジが不一致になるため、/live では残し、真に内部の列(Elo差分/承認待ち/次戦リンク/原文sets_json等)のみ落とす。
const LIVE_MATCH_OMIT = new Set([
  "referee_id", "pending_result",
  "winner_rating_delta", "loser_rating_delta",
  "next_match_id", "next_slot",
  "sets_json", "tournament_id", "created_at", "updated_at",
]);
function liveMatch(m) { const o = {}; for (const k in m) if (!LIVE_MATCH_OMIT.has(k)) o[k] = m[k]; return o; }
app.get("/api/public/tournaments/:id/matches", (req, res) => {
  // 進行フィンガープリントを ETag 化(未変化の再取得は304で本体0=ポーリング軽量化)。
  const fp = db.getOpsFingerprint(req.params.id);
  const tag = (fp && fp.v != null ? fp.v : "0") + "|" + (fp && fp.status || "") + "|pm";
  if (conditional(req, res, tag, "public, max-age=2")) return;
  res.json(db.getMatchesByTournament(req.params.id).map(publicMatch));
});
app.get("/api/public/stats", (req, res) => { res.json(db.getStats()); });
// 全試合の平均値 (選手プロフィールの相対比較用 #243)。60秒キャッシュ。
app.get("/api/public/stats/match-averages", (req, res) => {
  try { res.set("Cache-Control", "public, max-age=60").json(db.getGlobalMatchAverages()); }
  catch (e) { res.status(500).json({ error: "averages failed" }); }
});
app.get("/api/public/last-updated", (req, res) => { res.json({ t: db.getLastUpdated() }); });

// ── 試合検索 () ───────────────────────────────
app.get("/api/public/matches", publicSearchRateLimit, (req, res) => {
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
app.get("/api/public/head-to-head", publicSearchRateLimit, (req, res) => {
  const { p1, p2 } = req.query;
  if (!p1 || !p2) return res.status(400).json({ error: "p1 と p2 が必要です" });
  res.json(db.getHeadToHead(p1, p2));
});

// ── 公開申込 (大会への申込) ─────────────────────────
app.get("/api/public/open-tournaments", (req, res) => {
  res.json(db.getOpenTournaments().map(sanitizeTournamentPublic));
});
app.post("/api/public/tournaments/:id/entry", entryRateLimit, async (req, res) => {
  const payload = req.body || {};
  if (isHoneypotTripped(payload)) return res.status(201).json({ ok: true, screened: true });
  const ts = await verifyTurnstile(payload.cf_turnstile_token, clientIp(req));
  if (!ts.ok) return res.status(403).json({ error: "認証(Turnstile)に失敗しました。ページを再読み込みしてお試しください。", captcha: true });
  const r = db.createEntry(req.params.id, payload);
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});

// 新方式: 申込フォーム (entry_form.js) からの team-style POST 受け口
// 申込ペイロードを GAS Web App へサーバー側から中継する (server→GAS は CORS 制約なし)。
// ブラウザからの直POSTを廃し、ここで中継することで「保存成功なのに送信エラー誤表示」を解消。
// 失敗しても申込受付(DB保存)は成立済みのため、結果オブジェクトを返すだけで例外は投げない。
async function relayEntryToGas(gasUrl, payload) {
  if (typeof fetch !== "function") return { ok: false, error: "fetch 利用不可" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: controller.signal,
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    console.warn("[GAS relay] 失敗:", e && e.message);
    return { ok: false, error: (e && e.name === "AbortError") ? "timeout" : String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// ── スパム対策: Cloudflare Turnstile 検証 + ハニーポット (無償・無人運用) ──
// TURNSTILE_SECRET を設定した瞬間に有効化。未設定なら素通り(他の対策=スクリーニング/レート制限/承認は機能)。
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return { ok: true, skipped: true };     // 未設定=無効化
  if (!token) return { ok: false, error: "captcha-missing" };
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token) });
    if (ip) body.set("remoteip", ip);
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const data = await resp.json();
    return { ok: !!data.success, errors: data["error-codes"] };
  } catch (e) {
    // 検証サーバーへ到達できない時は「申込漏れ防止」を最優先しフェイルオープン(通す)。ログのみ。
    console.warn("[turnstile] verify失敗(フェイルオープン):", e && e.message);
    return { ok: true, degraded: true };
  }
}
// ハニーポット: 人間に見えない隠しフィールドに値が入っていればボット。
function isHoneypotTripped(payload) {
  return !!(payload && (payload.hp_url || payload.website || payload.hp_email));
}

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
    // ハニーポット(隠しフィールド)に値→ボット。黙って成功を返す(作成もメールもしない)。
    if (isHoneypotTripped(payload)) {
      return res.status(201).json({ ok: true, screened: true });
    }
    // Turnstile 検証 (有効時のみ)。明確な不合格(ボット)は拒否。
    const ts = await verifyTurnstile(payload.cf_turnstile_token, clientIp(req));
    if (!ts.ok) {
      return res.status(403).json({ error: "認証(Turnstile)に失敗しました。ページを再読み込みしてお試しください。", captcha: true });
    }
    try {
      const tournament = db.getTournament(req.params.id);
      // op_id(X-Op-Id ヘッダ / body)を渡し、メモリキャッシュ非ヒット(再起動後など)でも
      // DBレベルで replay 判定する (Phase4残: 真のDB冪等)。
      const opId = req.get("X-Op-Id") || (payload && payload.op_id) || "";
      const r = db.createTeamEntry(req.params.id, payload, opId);

      // GAS 連携が設定されていればサーバー側から中継 (スプレッドシート反映、best-effort)。
      // server→GAS は CORS 制約なし。ブラウザ直POSTの誤エラーを解消する要。
      let gasRelay = null;
      if (tournament && tournament.entry_gas_url
          && /^https:\/\/script\.google\.com\//.test(tournament.entry_gas_url)) {
        gasRelay = await relayEntryToGas(tournament.entry_gas_url, payload);
      }

      // 受付成立 = 自サーバー保存 または GAS中継 の少なくとも一方が成功。
      // GAS主運用(自サーバーが受理しない構成)でも、スプレッドシートへ届けば成功扱い。
      if (r.error && !(gasRelay && gasRelay.ok)) {
        return res.status(400).json({ error: r.error, gas: gasRelay });
      }

      // ── 控えメール送信 (実際に申込が作成された時のみ。全件スクリーニング除外なら送らない=いたずらメール防止) ──
      const mailResults = { confirmation: null, admin: null };
      const created = !r.error && r.entrant_ids && r.entrant_ids.length > 0;
      if (created && mailer.isEnabled() && tournament) {
        const appOrigin = appOriginOf(req);   // X-Forwarded-Host を信用しない正規オリジン
        const adminUrl = `${appOrigin}/admin#tournament/${req.params.id}`;
        const [confirmRes, adminRes] = await Promise.allSettled([
          mailer.sendConfirmationEmail({ tournament, formData: payload, result: r, appOrigin }),
          mailer.sendAdminNotification({ tournament, formData: payload, result: r, adminUrl }),
        ]);
        mailResults.confirmation = confirmRes.status === "fulfilled"
          ? confirmRes.value : { ok: false, error: String(confirmRes.reason) };
        mailResults.admin = adminRes.status === "fulfilled"
          ? adminRes.value : { ok: false, error: String(adminRes.reason) };
      }
      const base = r.error ? { ok: true, saved_to: "gas_only" } : r;
      res.status(201).json({ ...base, mail: mailResults, gas: gasRelay });
    } catch (e) {
      recordError(e, req, res, 500);
      res.status(500).json({ error: "申込処理エラー: " + e.message });
    }
  }
);

// ── Phase4: 申込者本人の閲覧 (申込番号トークンで自分の申込内容を確認。閲覧のみ・認証不要・PII最小) ──
// トークン空間は 32^12 ≈ 1.1e18 と広く列挙は非現実的だが、念のため専用レート制限を併用。
// 閲覧元 /entry/status は同一オリジンなので CORS 開放はしない(クロスオリジンからの読取を許さない)。
app.get("/api/public/applicants/:token", applicantLookupRateLimit, (req, res) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const r = db.getSubmissionByToken(String(req.params.token || ""));
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

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
app.get("/api/public/search", publicSearchRateLimit, (req, res) => {
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
// 所属(校名)から小/中/高/大カテゴリを一括自動振り分け (#247)
app.post("/api/players/normalize-categories", requireAdmin, (req, res) => {
  res.json(db.normalizePlayerCategories());
});

app.delete("/api/players/:id", requireAdmin, (req, res) => {
  db.deletePlayer(req.params.id); res.json({ ok: true });
});
app.delete("/api/players", requireAdmin, (req, res) => {
  db.deleteAllPlayers(); res.json({ ok: true });
});
// 選手の重複候補 + 結合 (マージ) #275
app.get("/api/player-merge/candidates", requireAdmin, (req, res) => {
  res.json(db.findDuplicatePlayerCandidates());
});
app.post("/api/players/:id/merge", requireAdmin, (req, res) => {
  const r = db.mergePlayers(req.params.id, (req.body || {}).duplicate_id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// ═══ 監督・顧問モード (#285) ════════════════════════════
// 監督コードの総当たり対策: 認証失敗を per-IP で計数し、閾値超で一時ブロック。
// 正しいコードでの認証は計数をクリアするため、正規の監督は制限されない。
const _coachFail = new Map(); // ip -> { count, resetAt }
const COACH_FAIL_MAX = 15, COACH_FAIL_WINDOW = 5 * 60000; // 5分で15回失敗まで
setInterval(() => { const now = Date.now(); for (const [ip, e] of _coachFail) if (now > e.resetAt) _coachFail.delete(ip); }, COACH_FAIL_WINDOW).unref();
function _coachIp(req) { return clientIp(req); }   // #7: trust proxy 準拠の単一ヘルパに統一
function coachBlocked(ip) { const e = _coachFail.get(ip); return !!(e && Date.now() <= e.resetAt && e.count >= COACH_FAIL_MAX); }
function coachFail(ip) { const now = Date.now(); const e = _coachFail.get(ip);
  if (!e || now > e.resetAt) _coachFail.set(ip, { count: 1, resetAt: now + COACH_FAIL_WINDOW }); else e.count++; }
function coachOk(ip) { _coachFail.delete(ip); }
const COACH_BLOCK_MSG = "試行回数が多すぎます。しばらく待ってから再度お試しください。";
// 監督コード認証 (X-Coach-Code ヘッダ / body / query)
function requireCoach(req, res, next) {
  const ip = _coachIp(req);
  if (coachBlocked(ip)) return res.status(429).json({ error: COACH_BLOCK_MSG });
  const code = req.get("X-Coach-Code") || (req.body && req.body.coach_code) || req.query.coach_code;
  const coach = db.coachByCode(code);
  if (!coach) { coachFail(ip); return res.status(401).json({ error: "監督ログインが必要です（コードが無効か無効化されています）" }); }
  coachOk(ip);
  req.coach = coach;
  next();
}
// 監督ログイン (コード→アカウント情報。コード自体は返さない)
app.post("/api/coach/login", (req, res) => {
  const ip = _coachIp(req);
  if (coachBlocked(ip)) return res.status(429).json({ error: COACH_BLOCK_MSG });
  const coach = db.coachByCode((req.body || {}).code);
  if (!coach) { coachFail(ip); return res.status(401).json({ error: "コードが無効です。本部にご確認ください。" }); }
  coachOk(ip);
  const count = db.getCoachRoster(coach.id).length;
  res.json({ ok: true, coach: { id: coach.id, name: coach.name, team: coach.team || "", player_cap: coach.player_cap, player_count: count,
    member_name: coach.member_name || "", member_role: coach.member_role || "" } });
});
app.get("/api/coach/me", requireCoach, (req, res) => {
  res.json({ id: req.coach.id, name: req.coach.name, team: req.coach.team || "", player_cap: req.coach.player_cap,
    player_count: db.getCoachRoster(req.coach.id).length,
    member_name: req.coach.member_name || "", member_role: req.coach.member_role || "" });
});
app.get("/api/coach/roster", requireCoach, (req, res) => {
  res.json({ players: db.getCoachRoster(req.coach.id), cap: req.coach.player_cap });
});
app.get("/api/coach/players/search", requireCoach, (req, res) => {
  const rows = db.getPlayers({ search: req.query.q || "", sort: "furigana" }).slice(0, 30);
  res.json(rows.map(p => ({ id: p.id, name: p.name, furigana: p.furigana, team: p.team, branch: p.branch, gender: p.gender })));
});
app.post("/api/coach/roster", requireCoach, (req, res) => {
  const r = db.addCoachPlayer(req.coach.id, (req.body || {}).player_id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.delete("/api/coach/roster/:playerId", requireCoach, (req, res) => {
  res.json(db.removeCoachPlayer(req.coach.id, req.params.playerId));
});
app.post("/api/coach/requests", requireCoach, (req, res) => {
  const r = db.createPlayerRequest(req.coach.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});
app.get("/api/coach/requests", requireCoach, (req, res) => {
  res.json({ requests: db.getCoachRequests(req.coach.id) });
});
// 監督が承認待ちの申請を取り消す (#289)
app.delete("/api/coach/requests/:id", requireCoach, (req, res) => {
  const r = db.cancelPlayerRequest(req.coach.id, req.params.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
// 本部からのお知らせ一覧 (監督向け #290)
app.get("/api/coach/announcements", requireCoach, (req, res) => {
  res.json({ announcements: db.listCoachAnnouncements(req.query.limit) });
});
// チーム結果まとめ (A4 印刷用 HTML) #291。ヘッダ認証なのでコードはURLに出さない。
app.get("/api/coach/results", requireCoach, (req, res) => {
  const tid = req.query.tournament_id;
  const t = db.getTournament(tid);
  if (!t) return res.status(404).send("大会が見つかりません");
  const roster = db.getCoachRoster(req.coach.id);
  const matches = db.getMatchesByTournament(tid);
  const html = reports.buildCoachResultsHTML(req.coach, t, roster, matches, {});
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});
// マイ選手の進行ダッシュボード (#286)
app.get("/api/coach/dashboard", requireCoach, (req, res) => {
  const r = db.getCoachDashboard(req.coach.id, req.query.tournament_id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
// 監督端末のプッシュ購読 (#287)
app.post("/api/coach/push/subscribe", requireCoach, (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "プッシュ通知は無効です" });
  const sub = (req.body || {}).subscription;
  if (!sub) return res.status(400).json({ error: "subscription が必要です" });
  const r = db.saveCoachSubscription(req.coach.id, sub);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});
app.post("/api/coach/push/unsubscribe", requireCoach, (req, res) => {
  const ep = (req.body || {}).endpoint;
  if (ep) db.deleteCoachSubscription(ep);
  res.json({ ok: true });
});
// ── Admin: 監督アカウント発行・管理 ──
app.get("/api/admin/coaches", requireAdmin, (req, res) => { res.json({ coaches: db.listCoachAccounts() }); });
app.post("/api/admin/coaches", requireAdmin, (req, res) => { res.status(201).json(db.createCoachAccount(req.body || {})); });
app.put("/api/admin/coaches/:id", requireAdmin, (req, res) => {
  const c = db.updateCoachAccount(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: "アカウントが見つかりません" });
  res.json(c);
});
app.post("/api/admin/coaches/:id/regenerate", requireAdmin, (req, res) => {
  const c = db.regenerateCoachCode(req.params.id);
  if (!c) return res.status(404).json({ error: "アカウントが見つかりません" });
  res.json(c);
});
// コードを任意の値に変更
app.post("/api/admin/coaches/:id/set-code", requireAdmin, (req, res) => {
  const r = db.setCoachCode(req.params.id, (req.body || {}).code);
  if (r.error) return res.status(400).json(r);
  res.json(r.coach);
});
app.delete("/api/admin/coaches/:id", requireAdmin, (req, res) => { db.deleteCoachAccount(req.params.id); res.json({ ok: true }); });
// ── 共同監督メンバー (複数顧問で共有 / 年度引き継ぎ) #292 ──
app.get("/api/admin/coaches/:id/members", requireAdmin, (req, res) => {
  res.json({ members: db.listCoachMembers(req.params.id) });
});
app.post("/api/admin/coaches/:id/members", requireAdmin, (req, res) => {
  const r = db.addCoachMember(req.params.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r.member);
});
app.put("/api/admin/coach-members/:mid", requireAdmin, (req, res) => {
  const r = db.updateCoachMember(req.params.mid, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r.member);
});
app.post("/api/admin/coach-members/:mid/regenerate", requireAdmin, (req, res) => {
  const r = db.regenerateCoachMemberCode(req.params.mid);
  if (r.error) return res.status(400).json(r);
  res.json(r.member);
});
app.post("/api/admin/coach-members/:mid/set-code", requireAdmin, (req, res) => {
  const r = db.setCoachMemberCode(req.params.mid, (req.body || {}).code);
  if (r.error) return res.status(400).json(r);
  res.json(r.member);
});
app.delete("/api/admin/coach-members/:mid", requireAdmin, (req, res) => {
  res.json(db.deleteCoachMember(req.params.mid));
});
// マイ番号(プッシュ)登録済みの選手一覧 (#288 Admin可視化)
app.get("/api/admin/push/players", requireAdmin, (req, res) => {
  const rows = db.getPushPlayerIds();
  res.json({ players: rows, count: rows.length });
});
// ── Admin: 本部→監督への一斉お知らせ (#290) ──
app.get("/api/admin/coach-announcements", requireAdmin, (req, res) => {
  res.json({ announcements: db.listCoachAnnouncements(req.query.limit) });
});
app.post("/api/admin/coach-announcements", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const wantPush = !!b.push && PUSH_ENABLED;
  const r = db.createCoachAnnouncement({ body: b.body, pushed: wantPush });
  if (r.error) return res.status(400).json(r);
  let pushed = 0;
  if (wantPush) {
    try { pushed = await sendPushToAllCoaches({ title: "本部からのお知らせ", body: String(b.body || "").slice(0, 120), url: "/viewer/#coach", tag: "ktta-coach-announce" }); }
    catch (e) { pushed = 0; }
  }
  res.status(201).json({ announcement: r, pushed });
});
app.delete("/api/admin/coach-announcements/:id", requireAdmin, (req, res) => {
  res.json(db.deleteCoachAnnouncement(req.params.id));
});
// ── Admin: 選手DB 修正/削除 申請の審査 ──
app.get("/api/admin/player-requests", requireAdmin, (req, res) => {
  res.json({ requests: db.listPlayerRequests(req.query.status || "pending"), pending: db.countPendingRequests() });
});
app.post("/api/admin/player-requests/:id/resolve", requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = db.resolvePlayerRequest(req.params.id, b.action, b.note);
  if (r.error) return res.status(400).json(r);
  res.json(r);
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
app.get("/api/tournaments", (req, res) => {
  // 認証なしでも到達可能な経路。管理キーがあれば完全データ、なければ秘密フィールドを除去 (#1/#14)。
  const list = db.getTournaments();
  res.json(isAdminAuthed(req) ? list : list.map(sanitizeTournamentPublic));
});
app.get("/api/tournaments/:id", (req, res) => {
  const t = db.getTournament(req.params.id);
  if (!t) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(isAdminAuthed(req) ? t : sanitizeTournamentPublic(t));
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
// entrant.note / Phase4 の contact_* 列には申込者の連絡先(氏名/メール/電話)が含まれるため、
// 一覧APIからは常に除外する (C1: PII漏洩対策)。連絡先は申込管理(entries, admin限定)側で扱う。
// submission_id は申込原本(トークン束)への参照なので公開しない。
function stripEntrantPII(rows) {
  return (rows || []).map(r => {
    const { note, contact_name, contact_email, contact_tel, submission_id, ...rest } = r;
    return rest;
  });
}
app.get("/api/tournaments/:id/entrants", (req, res) => {
  res.json(stripEntrantPII(db.getEntrants(req.params.id, req.query.event)));
});
app.get("/api/public/tournaments/:id/entrants", (req, res) => {
  res.json(stripEntrantPII(db.getEntrants(req.params.id, req.query.event)));
});
// 単一エントリーは note(申込者の連絡先PII)を含む生データを返すため要管理キー
// (利用元は admin の編集/連携フローのみ。一覧APIは stripEntrantPII 済み)。
app.get("/api/entrants/:id", requireAdmin, (req, res) => {
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

// ── 名簿データ JSON ── (運営者限定: 全参加者の氏名/ふりがな/所属/連絡先を含む内部帳票)
app.get("/api/tournaments/:id/roster.json", requireAdmin, (req, res) => {
  const data = db.buildRosterData(req.params.id);
  if (!data) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(data);
});

// ── 名簿 HTML (印刷可・ニッタク杯形式) ── (運営者限定。admin UI は管理キー付き fetch+Blob で開く)
app.get("/api/tournaments/:id/roster.html", requireAdmin, (req, res) => {
  const data = db.buildRosterData(req.params.id);
  if (!data) return res.status(404).type("html").send("<h1>大会が見つかりません</h1>");
  const html = buildRosterHTML(data);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

// ── 受付名簿 HTML (紙の当日受付用・所属別 + 参加料/領収印欄・印刷可) ── (運営者限定)
// Platform は「名簿 + 請求予定額(種目設定料金)」を出力するのみ。実際の入金・領収の管理は
// スプレッドシート(GAS)/紙が正 → 会計と二重管理にならず競合しない。
app.get("/api/tournaments/:id/reception.html", requireAdmin, (req, res) => {
  const t = db.getTournament(req.params.id);
  if (!t) return res.status(404).type("html").send("<h1>大会が見つかりません</h1>");
  const entrants = db.getEntrants(req.params.id) || [];
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(buildReceptionHTML(t, entrants));
});

function buildReceptionHTML(t, entrants) {
  const yen = (n) => "¥" + (parseInt(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let cfg = [];
  try { cfg = JSON.parse(t.event_config || "[]"); } catch (e) {}
  const feeMap = {};
  (Array.isArray(cfg) ? cfg : []).forEach(c => { if (c && c.name) feeMap[String(c.name).trim()] = parseInt(c.fee) || 0; });
  const feeOf = (ev) => feeMap[String(ev || "").trim()] || 0;
  const byTeam = {};
  entrants.forEach(e => {
    const team = (e.team || "").trim() || "(所属未記入)";
    (byTeam[team] = byTeam[team] || []).push(e);
  });
  const teamNames = Object.keys(byTeam).sort((a, b) => a.localeCompare(b, "ja"));
  let grand = 0, grandCount = 0;
  const sections = teamNames.map(team => {
    const list = byTeam[team];
    let sub = 0;
    const rows = list.map(e => {
      const fee = feeOf(e.event); sub += fee; grand += fee; grandCount++;
      const nm = (e.is_doubles && e.partner_name)
        ? (_escHtml(e.name) + " ・ " + _escHtml(e.partner_name)) : _escHtml(e.name);
      const furi = e.furigana ? `<span class="furi">${_escHtml(e.furigana)}</span>` : "";
      return `<tr><td class="chk"></td><td class="no">${e.bracket_number || ""}</td>` +
        `<td class="nm">${nm}${furi}</td><td class="ev">${_escHtml(e.event || "")}</td>` +
        `<td class="fee">${fee ? yen(fee) : ""}</td><td class="seal"></td></tr>`;
    }).join("");
    return `<section class="team-sec"><h3>${_escHtml(team)} <span class="tc">${list.length}件</span></h3>` +
      `<table class="rcp-table"><thead><tr><th class="chk">受付</th><th class="no">No</th>` +
      `<th>氏名（ふりがな）</th><th>種目</th><th class="fee">参加料</th><th class="seal">領収印</th></tr></thead>` +
      `<tbody>${rows}</tbody><tfoot><tr><td colspan="4" class="sub-l">小計（${list.length}件）</td>` +
      `<td class="fee">${yen(sub)}</td><td></td></tr></tfoot></table></section>`;
  }).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>${_escHtml(t.name)} 受付名簿</title><style>
*{box-sizing:border-box} body{font-family:system-ui,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;color:#1c1917;margin:0;padding:18px}
h1{font-size:20px;margin:0 0 2px} .meta{color:#57534e;font-size:13px;margin-bottom:6px}
.grand{font-size:15px;font-weight:800;margin:8px 0 10px;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;display:inline-block}
.note{font-size:11px;color:#78716c;margin-bottom:14px;line-height:1.6}
.team-sec{margin-bottom:16px;page-break-inside:avoid}
h3{font-size:15px;margin:0 0 4px;border-bottom:2px solid #1c1917;padding-bottom:2px} h3 .tc{font-size:11px;color:#78716c;font-weight:500;margin-left:6px}
.rcp-table{width:100%;border-collapse:collapse;font-size:13px}
.rcp-table th,.rcp-table td{border:1px solid #d6d3d1;padding:5px 6px;text-align:left}
.rcp-table th{background:#f5f5f4;font-size:12px} .rcp-table .chk{width:40px;text-align:center}
.rcp-table .no{width:40px;text-align:center;color:#78716c} .rcp-table .ev{width:22%}
.rcp-table .fee{width:86px;text-align:right} .rcp-table .seal{width:64px} .furi{display:block;font-size:10px;color:#78716c}
.sub-l{text-align:right;font-weight:700} tfoot td{background:#fafaf9}
.print-btn{position:fixed;top:12px;right:12px;padding:8px 16px;background:#15803d;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer}
@media print{.print-btn{display:none} body{padding:8px}}
</style></head><body>
<button class="print-btn" onclick="window.print()">印刷 / PDF保存</button>
<h1>${_escHtml(t.name)} 受付名簿</h1>
<div class="meta">${_escHtml(t.date || "")}　${_escHtml(t.venue || "")}</div>
<div class="grand">参加料 合計予定額　${yen(grand)}　（全${grandCount}件 / ${teamNames.length}団体）</div>
<div class="note">※ 当日受付（紙）用。金額は申込種目の設定料金からの「請求予定額」です。実際の入金・領収の管理はスプレッドシート/紙が正です。受付欄・領収印欄に押印してご利用ください。</div>
${sections || "<p>申込がまだありません。</p>"}
</body></html>`;
}

function _escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 名簿用 支部ヘルパ (common.js と同一ロジックをサーバ側に複製し、印刷HTMLを自己完結に保つ) #273
const _HOKKAIDO_BRANCHES = ["札幌","函館","旭川","釧路","十勝","千歳","苫小牧","江別","室蘭","名寄","根室","後志","滝川","北見","岩見沢","留萌","日高","稚内","紋別","小樽","深川","網走","富良野","斜里"];
function _branchBase(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  s = s.replace(/[\s　]+/g, "");
  const base = s.replace(/管内/g, "").replace(/(卓球)?(協会|連盟|クラブ|協議会)$/g, "").replace(/支部$/g, "").trim();
  if (_HOKKAIDO_BRANCHES.includes(base)) return base;
  for (const b of _HOKKAIDO_BRANCHES) { if (s.indexOf(b) === 0) return b; }
  return null;
}
function _officialBranch(raw) { const b = _branchBase(raw); return b ? b + "支部" : ""; }
function _branchColor(raw) {
  const base = _branchBase(raw);
  if (base == null) return { bg: "#f1f5f9", fg: "#64748b" };
  const idx = _HOKKAIDO_BRANCHES.indexOf(base);
  const hue = Math.round(idx * 137.508) % 360;
  const sat = 64 + (idx % 3) * 6;
  const light = 90 + (idx % 2) * 3;
  return { bg: `hsl(${hue}, ${sat}%, ${light}%)`, fg: `hsl(${hue}, ${Math.min(sat + 10, 88)}%, 30%)` };
}

function buildRosterHTML(data) {
  const t = data.tournament;
  const dateStr = t.date || "";
  const venue = t.venue || "";
  // 支部の集計 (凡例 + 各行の色)
  const branchSet = new Map();
  let totalEntrants = 0;
  data.events.forEach(ev => {
    totalEntrants += ev.entrants.length;
    ev.entrants.forEach(e => {
      const label = _officialBranch(e.region) || _officialBranch(e.team);
      if (label && !branchSet.has(label)) branchSet.set(label, _branchColor(e.region || e.team));
    });
  });
  const legend = Array.from(branchSet.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ja"))
    .map(([name, c]) => `<span class="lg" style="background:${c.bg};color:${c.fg}">${_escHtml(name)}</span>`).join("");

  // 重複セクション (複数種目にエントリーしている選手)
  const dupSection = data.duplicates.length
    ? `<section class="dup-section">
      <h2>重複出場チェック <span class="dc">${data.duplicates.length}名</span></h2>
      <p class="dup-note">複数種目にエントリーしている選手 (要確認):</p>
      <table class="dup-table">
        <thead><tr><th>選手名</th><th>所属</th><th>出場種目</th></tr></thead>
        <tbody>${data.duplicates.map(d => `<tr><td>${_escHtml(d.name)}</td><td>${_escHtml(d.team)}</td><td>${d.events.map(e => `<span class="ev-tag">${_escHtml(e)}</span>`).join("")}</td></tr>`).join("")}</tbody>
      </table>
    </section>`
    : `<section class="dup-section ok"><h2>重複出場チェック</h2><p>複数種目への重複申込はありません。</p></section>`;

  // 種目タブ
  const eventTabs = data.events.map((ev, i) =>
    `<button class="tab" data-ev="${i}" onclick="pickEv('${i}',this)">${_escHtml(ev.name)} <b>${ev.count}</b></button>`).join("");

  // 種目別 名簿 (支部色分け・ふりがな・男女属性つき)
  const eventSections = data.events.map((ev, i) => {
    const rows = ev.entrants.map(e => {
      const dup = (e.dup_self || e.dup_partner) ? "1" : "0";
      const brLabel = _officialBranch(e.region) || _officialBranch(e.team);
      const brColor = _branchColor(e.region || e.team);
      const brBadge = brLabel ? `<span class="br" style="background:${brColor.bg};color:${brColor.fg}">${_escHtml(brLabel)}</span>` : "";
      const bar = `border-left:4px solid ${brColor.bg};`;
      const attrs = `data-gender="${e.gender}" data-dup="${dup}" data-furi="${_escHtml(e.furigana || "")}" data-no="${e.no}"`;
      if (e.is_doubles) {
        return `<tr ${attrs} style="${bar}">
          <td class="no">${e.no}</td>
          <td class="nm"><div class="${e.dup_self ? "d" : ""}">${_escHtml(e.name)}${e.furigana ? `<span class="fr">${_escHtml(e.furigana)}</span>` : ""}</div><div class="${e.dup_partner ? "d" : ""}">${_escHtml(e.partner_name)}${e.partner_furigana ? `<span class="fr">${_escHtml(e.partner_furigana)}</span>` : ""}</div></td>
          <td class="tm"><div>${_escHtml(e.team)}</div><div>${_escHtml(e.partner_team)}</div></td>
          <td class="brc">${brBadge}</td>
        </tr>`;
      }
      return `<tr ${attrs} style="${bar}">
        <td class="no">${e.no}</td>
        <td class="nm"><div class="${e.dup_self ? "d" : ""}">${_escHtml(e.name)}${e.furigana ? `<span class="fr">${_escHtml(e.furigana)}</span>` : ""}</div></td>
        <td class="tm">${_escHtml(e.team)}</td>
        <td class="brc">${brBadge}</td>
      </tr>`;
    }).join("");
    return `<section class="event-section" data-ev="${i}">
      <h3>${_escHtml(ev.name)} <span class="count">${ev.count}${ev.type === "double" ? "組" : "名"}</span></h3>
      <table class="roster-table"><thead><tr><th class="no">No</th><th>氏名（ふりがな）</th><th>所属</th><th class="brc">支部</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  }).join("");

  const outDate = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${_escHtml(t.name)} 名簿</title>
<style>
  /* 外部フォント@import撤去: BIZ UDPGothic はシステム同梱/Hiragino等で代替(オフライン整合) */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "BIZ UDPGothic", "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif;
    color: #1c1917; background: #f1f5f9; padding: 16px 16px 60px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .topbar { position: fixed; top: 10px; right: 12px; display: flex; gap: 8px; z-index: 30; }
  .topbar button { padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 13px; font-weight: 700; }
  .topbar .pr { background: #0f766e; color: #fff; }
  .topbar .cl { background: #fff; color: #334155; border: 1px solid #cbd5e1; }
  header.hd {
    background: linear-gradient(135deg, #1e293b 0%, #0f766e 100%);
    color: #fff; border-radius: 12px; padding: 16px 20px; margin-bottom: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,.12);
  }
  header.hd .assoc { font-size: 12px; letter-spacing: .14em; opacity: .85; }
  header.hd h1 { font-size: 22px; font-weight: 700; margin: 2px 0 4px; }
  header.hd .meta { font-size: 12.5px; opacity: .9; }
  header.hd .chips { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
  header.hd .chip { background: rgba(255,255,255,.16); border-radius: 999px; padding: 3px 12px; font-size: 12px; font-weight: 700; }

  .controls {
    position: sticky; top: 0; z-index: 20; background: #fff; border-radius: 10px;
    padding: 10px 12px; margin-bottom: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08);
    display: flex; flex-direction: column; gap: 8px;
  }
  .ctl-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .ctl-label { font-size: 11px; font-weight: 700; color: #64748b; margin-right: 2px; }
  .tab, .gtab, .stab {
    padding: 5px 11px; border: 1px solid #cbd5e1; background: #fff; color: #334155;
    border-radius: 999px; cursor: pointer; font-family: inherit; font-size: 12px;
  }
  .tab b { color: #0f766e; margin-left: 3px; }
  .tab.on, .gtab.on, .stab.on { background: #0f766e; color: #fff; border-color: #0f766e; }
  .tab.on b { color: #d1fae5; }
  .dup-toggle { font-size: 12px; color: #334155; display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; cursor: pointer; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px; }
  .legend .lg { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; font-weight: 700; }

  .dup-section { margin-bottom: 14px; padding: 12px 14px; background: #fffbeb; border: 1px solid #fde68a; border-left: 5px solid #d97706; border-radius: 8px; }
  .dup-section.ok { background: #f0fdf4; border-color: #bbf7d0; border-left-color: #15803d; }
  .dup-section h2 { font-size: 14px; margin-bottom: 6px; color: #78350f; }
  .dup-section .dc { background: #d97706; color: #fff; border-radius: 999px; font-size: 11px; padding: 1px 9px; margin-left: 4px; }
  .dup-section.ok h2 { color: #14532d; }
  .dup-note { font-size: 12px; margin-bottom: 8px; color: #78716c; }
  .dup-table { width: 100%; border-collapse: collapse; font-size: 12px; background: #fff; }
  .dup-table th, .dup-table td { padding: 6px 8px; border: 1px solid #e7e5e4; text-align: left; }
  .dup-table th { background: #f5f5f4; font-weight: 700; }
  .ev-tag { display: inline-block; padding: 1px 7px; margin: 1px 3px 1px 0; background: #fee2e2; border-radius: 999px; font-size: 11px; color: #7c2d12; }

  .events { }
  .event-section { margin-bottom: 14px; background: #fff; border-radius: 8px; padding: 8px 10px 4px; box-shadow: 0 1px 3px rgba(0,0,0,.06); break-inside: avoid; }
  .event-section h3 { font-size: 14px; padding: 4px 4px 6px; border-bottom: 2px solid #0f766e; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: baseline; }
  .event-section h3 .count { font-size: 11px; color: #fff; background: #0f766e; border-radius: 999px; padding: 1px 9px; font-weight: 700; }
  .roster-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .roster-table thead th { font-size: 10.5px; color: #64748b; text-align: left; padding: 2px 6px; border-bottom: 1px solid #e2e8f0; font-weight: 700; }
  .roster-table tbody tr { border-bottom: 1px solid #f1f5f9; }
  .roster-table tbody tr[data-dup="1"] { background: #fffbeb; }
  .roster-table td { padding: 4px 6px; vertical-align: middle; }
  .roster-table .no { width: 34px; text-align: center; font-weight: 700; color: #0f766e; }
  .roster-table .nm { font-weight: 700; }
  .roster-table .nm .fr { font-weight: 400; font-size: 10px; color: #94a3b8; margin-left: 5px; }
  .roster-table .nm .d { color: #b91c1c; }
  .roster-table .nm .d::before { content: "● "; font-size: 8px; vertical-align: 2px; }
  .roster-table .tm { color: #64748b; font-size: 11px; }
  .roster-table .brc { width: 76px; text-align: right; }
  .roster-table .br { font-size: 10px; padding: 1px 7px; border-radius: 999px; font-weight: 700; white-space: nowrap; }
  .empty { text-align: center; padding: 40px; color: #a8a29e; }

  @media print {
    body { background: #fff; padding: 0; }
    .topbar, .controls { display: none !important; }
    header.hd { box-shadow: none; border-radius: 0; }
    .events { column-count: 2; column-gap: 9mm; }
    .event-section { box-shadow: none; border: 1px solid #e2e8f0; margin-bottom: 8px; }
    .roster-table tr { break-inside: avoid; }
    @page { size: A4; margin: 11mm; }
  }
</style></head><body>
<div class="topbar">
  <button class="pr" onclick="window.print()">印刷 / PDF</button>
  <button class="cl" onclick="window.close()">閉じる</button>
</div>
<header class="hd">
  <div class="assoc">KUSHIRO TABLE TENNIS ASSOCIATION</div>
  <h1>${_escHtml(t.name)} 名簿</h1>
  <div class="meta">${dateStr ? _escHtml(dateStr) : ""}${venue ? "　/　" + _escHtml(venue) : ""}　/　出力: ${outDate}</div>
  <div class="chips"><span class="chip">${data.events.length} 種目</span><span class="chip">${totalEntrants} 件</span>${data.duplicates.length ? `<span class="chip">重複 ${data.duplicates.length} 名</span>` : ""}</div>
</header>
<div class="controls">
  <div class="ctl-row"><span class="ctl-label">種目</span><button class="tab on" data-ev="all" onclick="pickEv('all',this)">全種目</button>${eventTabs}</div>
  <div class="ctl-row">
    <span class="ctl-label">性別</span>
    <button class="gtab on" onclick="pickGender('all',this)">全</button>
    <button class="gtab" onclick="pickGender('male',this)">男子</button>
    <button class="gtab" onclick="pickGender('female',this)">女子</button>
    <span class="ctl-label" style="margin-left:8px">並び</span>
    <button class="stab on" onclick="setSort('no',this)">番号順</button>
    <button class="stab" onclick="setSort('furi',this)">ふりがな順</button>
    <label class="dup-toggle"><input type="checkbox" onchange="toggleDup(this)"> 重複のみ</label>
  </div>
  ${legend ? `<div class="ctl-row"><span class="ctl-label">支部</span><div class="legend">${legend}</div></div>` : ""}
</div>
${dupSection}
<div class="events">
${eventSections || '<p class="empty">エントリーがまだありません</p>'}
</div>
<script>
(function(){
  var st = { ev: "all", gender: "all", dupOnly: false, sort: "no" };
  function secs(){ return Array.prototype.slice.call(document.querySelectorAll(".event-section")); }
  function apply(){
    secs().forEach(function(sec){
      var evOk = (st.ev === "all") || (sec.getAttribute("data-ev") === st.ev);
      if (!evOk) { sec.style.display = "none"; return; }
      var vis = 0;
      Array.prototype.slice.call(sec.querySelectorAll("tbody tr")).forEach(function(tr){
        var gOk = (st.gender === "all") || (tr.getAttribute("data-gender") === st.gender);
        var dOk = (!st.dupOnly) || (tr.getAttribute("data-dup") === "1");
        var show = gOk && dOk;
        tr.style.display = show ? "" : "none";
        if (show) vis++;
      });
      sec.style.display = vis > 0 ? "" : "none";
    });
  }
  window.pickEv = function(v, btn){
    st.ev = String(v);
    document.querySelectorAll(".tab").forEach(function(b){ b.classList.toggle("on", b.getAttribute("data-ev") === st.ev); });
    apply();
  };
  window.pickGender = function(g, btn){
    st.gender = g;
    document.querySelectorAll(".gtab").forEach(function(b){ b.classList.remove("on"); });
    if (btn) btn.classList.add("on");
    apply();
  };
  window.toggleDup = function(cb){ st.dupOnly = cb.checked; apply(); };
  window.setSort = function(mode, btn){
    st.sort = mode;
    document.querySelectorAll(".stab").forEach(function(b){ b.classList.remove("on"); });
    if (btn) btn.classList.add("on");
    secs().forEach(function(sec){
      var tb = sec.querySelector("tbody"); if (!tb) return;
      var rows = Array.prototype.slice.call(tb.querySelectorAll("tr"));
      rows.sort(function(a, b){
        if (mode === "furi") return (a.getAttribute("data-furi") || "").localeCompare(b.getAttribute("data-furi") || "", "ja");
        return (parseInt(a.getAttribute("data-no")) || 9999) - (parseInt(b.getAttribute("data-no")) || 9999);
      });
      rows.forEach(function(r){ tb.appendChild(r); });
    });
  };
})();
</script>
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
    force: !!req.body?.force,   // 結果入力済み試合がある種目の再生成ガードを越える(運営が確認の上)
  });
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});
// 抽選ドロー: シードを標準位置に固定 + 非シードをランダム抽選(同一所属/地区を分散) → ブラケット凍結。
// body: { event, draw_seed?, separate_by?('team'|'region'|'none'), force?, preview?, drawn_by? }
//   preview=1(query/body): DBを書かず組合せだけ返す(確定前dry_run)。
//   確定(preview無し)は実施者名 drawn_by 必須(単一ADMIN_KEYで個人識別できないため最小の説明責任)。
// 同じ draw_seed を指定すれば同一結果を再現できる(検証・引き直し用)。結果入力済みは force ガード。
app.post("/api/tournaments/:id/bracket/draw", requireAdmin, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const preview = req.query.preview === "1" || req.body?.preview === true || req.body?.preview === 1;
  if (!preview && !String(req.body?.drawn_by || "").trim()) {
    return res.status(400).json({ error: "実施者名(drawn_by)が必要です(抽選の記録用)", needs_drawn_by: true });
  }
  const r = db.drawSingleBracket(req.params.id, event, {
    draw_seed: req.body?.draw_seed,
    separate_by: req.body?.separate_by,
    force: !!req.body?.force,
    preview,
    drawn_by: req.body?.drawn_by,
  });
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});
// 進行開始(不戦勝を確定): 抽選で配置・編集した1回戦を確定し、不戦勝(vs BYE)を繰り上げて進行を開始する。
// 抽選ドローは1回戦を「配置するだけ」で自動進行させないため、編集後に運営がこれで進める。
app.post("/api/tournaments/:id/bracket/advance-byes", requireAdmin, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const advanced = db.autoAdvanceByes(req.params.id, event);
  res.json({ ok: true, advanced });
});
// 抽選の事前検査(プリフライト・ポカヨケ)。?event=種目名
app.get("/api/tournaments/:id/bracket/draw-readiness", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  res.json(db.checkDrawReadiness(req.params.id, event));
});
// 直前の抽選を取り消し、抽選直前のブラケットへ戻す。body: { event }
app.post("/api/tournaments/:id/bracket/undo-draw", requireAdmin, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.undoDraw(req.params.id, event);
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});
// 抽選履歴(監査用・件数とメタのみ)。?event=種目名(省略可)
app.get("/api/tournaments/:id/bracket/draw-log", requireAdmin, (req, res) => {
  res.json(db.getDrawLog(req.params.id, req.query.event || ""));
});
// 確定封印の差分: 抽選確定時の配置から手修正された枠を返す(原配置との突合・可視化)。?event=種目名
app.get("/api/tournaments/:id/bracket/draw-diff", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  res.json(db.getBracketDrawDiff(req.params.id, event));
});
// シード自動提案(Elo rating + 過去成績 achievements → 客観スコア順の候補)。?event=&by=blend|elo|achievements
app.get("/api/tournaments/:id/seed-suggestions", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  res.json(db.suggestSeeds(req.params.id, event, { by: req.query.by }));
});
// 提案を人手確認のうえ一括適用(自動確定はしない)。body: { assignments:[{entrant_id,seed,reason}], by, set_by }
app.post("/api/tournaments/:id/seed-suggestions/apply", requireAdmin, (req, res) => {
  const assignments = req.body?.assignments;
  if (!Array.isArray(assignments)) return res.status(400).json({ error: "assignments が必要です" });
  const source = "auto:" + (req.body?.by || "blend");
  const setBy = String(req.body?.set_by || "").trim();
  let applied = 0;
  for (const a of assignments) {
    if (!a || !a.entrant_id) continue;
    db.setEntrantSeed(a.entrant_id, a.seed, { source, reason: a.reason || "", by: setBy });
    applied++;
  }
  res.json({ ok: true, applied });
});
// 団体リーグ(総当たり)を生成。body: { event, num_blocks?, assignments?, regenerate?, force? }
app.post("/api/tournaments/:id/league/generate", requireAdmin, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.generateTeamLeague(req.params.id, event, {
    num_blocks: req.body?.num_blocks,
    assignments: req.body?.assignments || null,
    regenerate: req.body?.regenerate !== false,
    force: !!req.body?.force,
  });
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});
// 釧路リーグ: 前回大会の各部順位から今回の部を提案(運営限定)。
// ?prev=<前回大会id>&prev_event=<前回の団体種目名>&event=<今回の団体種目名>&promote_top=&relegate_from=
app.get("/api/tournaments/:id/league/promotion-suggest", requireAdmin, (req, res) => {
  const event = req.query.event;
  const prev = req.query.prev;
  const prevEvent = req.query.prev_event || event;
  if (!event) return res.status(400).json({ error: "event(今回の団体種目)が必要です" });
  if (!prev) return res.status(400).json({ error: "prev(前回大会id)が必要です" });
  const currentEntrants = db.getEntrants(req.params.id, event) || [];
  const r = db.computePromotionSuggestion(prev, prevEvent, currentEntrants,
    { promote_top: req.query.promote_top, relegate_from: req.query.relegate_from });
  res.json({ event, prev, prev_event: prevEvent, ...r });
});
// 過去の団体リーグ大会一覧(前回大会の選択用・運営限定)。当大会自身は除外。
app.get("/api/tournaments/:id/league/previous-candidates", requireAdmin, (req, res) => {
  const cur = req.params.id;
  const list = (db.getTournaments() || [])
    .filter(t => t.id !== cur)
    .map(t => ({ id: t.id, name: t.name, date: t.date }))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  res.json(list);
});
// 団体リーグの順位表+対戦結果(公開・PIIなし)。?event=&block= 。block 省略で全ブロック。
app.get("/api/public/tournaments/:id/standings", (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const block = req.query.block || undefined;
  res.json({ event, block: block || null,
    standings: db.computeLeagueStandings(req.params.id, event, block),
    matches: db.getLeagueMatchResults(req.params.id, event, block) });
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
  // ── 主系統: 実データ駆動の seed-list パーサー (#268・実測100%) ──
  // 組合せExcelからシード順の選手リストを抽出し、種目ごとに取込む(複数シート=複数種目を一括)。
  if (seedListParser && seedListParser.parseSeedList) {
    try {
      const parsed = seedListParser.parseSeedList(filePath, {
        sheet: sheet || null,
        eventHint: (sheet && event) ? event : null,
        formatHint: (sheet && ["singles", "doubles", "team"].includes(format)) ? format : null,
      });
      const events = (parsed.events || []).filter(ev => (ev.players || []).length >= 2);
      if (events.length) {
        if (dryRun) {
          try { fs.unlinkSync(filePath); } catch {}
          return res.json({
            preview: { events: events.map(e => ({ event: e.event, format: e.format, count: e.players.length, players: e.players })) },
            message: `解析プレビュー: ${events.length}種目 / 計${events.reduce((s, e) => s + e.players.length, 0)}人 (まだ取込されていません)`,
            used_parser: "parse_bracket_seedlist.js",
          });
        }
        const imported = [];
        for (const ev of events) {
          const r = db.importBracket(req.params.id, {
            format: "tabletennis-seed-list-v1",
            event: ev.event,
            players: ev.players,
            regenerate: true,
            auto_link_to_players: true,
            auto_create_players: true,
          });
          imported.push({ event: ev.event, format: ev.format, count: ev.players.length, result: r });
        }
        try { fs.unlinkSync(filePath); } catch {}
        return res.json({ ok: true, source: "kumiawase_seedlist", used_parser: "parse_bracket_seedlist.js", imported });
      }
      // 何も取れなければ Python 罫線パーサー → 旧パーサーへフォールバック
    } catch (e) {
      console.warn("[kumiawase] seed-list parse failed, fallback:", e.message);
    }
  }
  // ── 副系統: Python 罫線パーサー (tools/bracket_parser, 実測100%) ──
  // 本体にロジックは置かず subprocess の JSON のみ取込む(疎結合・将来改修容易)。
  // JS seed-list が空振りした表でも openpyxl で罫線/番号を読み直す second opinion。
  try {
    const pyEnv = Object.assign({}, process.env);
    const pyPaths = [path.join(__dirname, "tools"), path.join(__dirname, ".python-packages")];
    pyEnv.PYTHONPATH = pyPaths.join(path.delimiter) + (pyEnv.PYTHONPATH ? path.delimiter + pyEnv.PYTHONPATH : "");
    const pyArgs = ["-m", "bracket_parser", filePath];
    if (sheet) {
      pyArgs.push("--sheet", sheet);
      if (event) pyArgs.push("--event", event);
      if (["singles", "doubles", "team"].includes(format)) pyArgs.push("--format", format);
    }
    const pyRes = await runChild("python3", pyArgs, { env: pyEnv });   // #20: タイムアウト/出力上限つき
    let parsed = null;
    if (pyRes.code === 0 && pyRes.out) {
      try { parsed = JSON.parse(pyRes.out); } catch { parsed = null; }
    }
    const pyEvents = (parsed && !parsed.error ? (parsed.events || []) : [])
      .filter((ev) => (ev.players || []).length >= 2);
    if (pyEvents.length) {
      if (dryRun) {
        try { fs.unlinkSync(filePath); } catch {}
        return res.json({
          preview: { events: pyEvents.map((e) => ({ event: e.event, format: e.format, count: e.players.length, players: e.players })) },
          message: `解析プレビュー: ${pyEvents.length}種目 / 計${pyEvents.reduce((s, e) => s + e.players.length, 0)}人 (まだ取込されていません)`,
          used_parser: "bracket_parser (python)",
        });
      }
      const imported = [];
      for (const ev of pyEvents) {
        const r = db.importBracket(req.params.id, {
          format: "tabletennis-seed-list-v1",
          event: ev.event,
          players: ev.players,
          regenerate: true,
          auto_link_to_players: true,
          auto_create_players: true,
        });
        imported.push({ event: ev.event, format: ev.format, count: ev.players.length, result: r });
      }
      try { fs.unlinkSync(filePath); } catch {}
      return res.json({ ok: true, source: "kumiawase_seedlist", used_parser: "bracket_parser (python)", imported });
    }
  } catch (e) {
    console.warn("[kumiawase] python bracket_parser fallback failed:", e.message);
  }
  // ── フォールバック: 旧 parse_ktta_bracket (テンプレ/特殊形式向け) ──
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
let seedListParser = null;
try {
  kttaParser = require("./tools/parse_ktta_bracket.js");
} catch (e) {
  console.warn("[startup] parse_ktta_bracket.js のロード失敗:", e.message);
}
try {
  // 実データ駆動の新パーサー (#268): シングルス/ダブルス 4種目で実測100%。Excel取込の主系統。
  seedListParser = require("./tools/parse_bracket_seedlist.js");
} catch (e) {
  console.warn("[startup] parse_bracket_seedlist.js のロード失敗:", e.message);
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
  // #20: タイムアウト/出力上限つきで実行 (不正xlsxでのハング/暴走を遮断)。
  const r0 = await runChild("python3", [script, xlsxPath, "--all-sheets"], { env: pyEnv });
  try { fs.unlinkSync(xlsxPath); } catch {}
  if (r0.code !== 0) {
    const timedOut = r0.err === "timeout" || r0.err === "output too large";
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut ? "パーサーが時間/サイズ上限を超過しました" : "パーサー失敗 (exit code " + r0.code + ")",
      stderr: (r0.err || "").slice(0, 500),
      used_parser: "parse_jtta_excel.py (fallback)",
    });
  }
  let data;
  try { data = JSON.parse(r0.out); }
  catch (e) {
    return res.status(500).json({ error: "JSON 解析失敗: " + e.message,
      used_parser: "parse_jtta_excel.py (fallback)" });
  }
  if (data.error) {
    return res.status(400).json({ ...data, used_parser: "parse_jtta_excel.py (fallback)" });
  }
  data.regenerate = regenerate;
  data.auto_link_to_players = autoLink;
  try {
    const r = db.importBracket(req.params.id, data);
    return res.json({ ...r, used_parser: "parse_jtta_excel.py (fallback)" });
  } catch (e) {
    return res.status(500).json({ error: "取込に失敗しました: " + e.message,
      used_parser: "parse_jtta_excel.py (fallback)" });
  }
});

// バリデーション (重複/欠落検出)
app.get("/api/tournaments/:id/entrants/validate", (req, res) => {
  res.json(db.validateEntrants(req.params.id, req.query.event || ""));
});
// 所属相違の解決: 同一人物としてマスタDBの所属を更新 (#192)
app.post("/api/entrants/:id/resolve-branch", requireAdmin, (req, res) => {
  const { player_id, new_team } = req.body || {};
  if (!player_id) return res.status(400).json({ error: "player_id が必要です" });
  const r = db.resolveBranchChange(req.params.id, player_id, new_team);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// ─── 集計表 Excel 出力 ───
app.get("/api/tournaments/:id/aggregation.xlsx", requireAdmin, (req, res) => {
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
app.get("/api/tournaments/:id/receipts.xlsx", requireAdmin, (req, res) => {
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
app.get("/api/tournaments/:id/match-cards.xlsx", requireAdmin, (req, res) => {
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

// ─── トーナメント表(両山)Excel 出力 — 抽選結果を手修正・印刷できる形で書き出す ───
// ?event=種目名 で1種目に絞れる(未指定=全ブラケット種目を別シートで)。
// ブラケットは公開閲覧データ(選手名/所属/シード)なので、運営版と公開読取版の両方を用意。
function _sendBracketXlsx(req, res) {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    const matches = (db.getMatchesByTournament(req.params.id) || []).filter(m => m.bracket_round != null);
    if (!matches.length) {
      return res.status(400).json({ error: "トーナメント表がありません。先に抽選/生成してください。" });
    }
    const entrants = db.getEntrants(req.params.id) || [];
    let drawMeta = null;
    if (req.query.event) {
      const committed = (db.getDrawLog(req.params.id, req.query.event) || []).find(x => x.status === "committed");
      if (committed) drawMeta = { draw_seed: committed.draw_seed, drawn_by: committed.drawn_by, drawn_at: committed.created_at };
    }
    const buf = reports.buildBracketXlsx(tournament, matches, entrants, { event: req.query.event || "", draw_meta: drawMeta });
    const safeName = (tournament.name || "tournament").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const evPart = req.query.event ? "_" + String(req.query.event).replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_") : "";
    const filename = encodeURIComponent(`トーナメント表_${safeName}${evPart}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buf);
  } catch (e) {
    console.error("bracket.xlsx error:", e);
    res.status(500).json({ error: "トーナメント表生成失敗: " + e.message });
  }
}
app.get("/api/tournaments/:id/bracket/export.xlsx", requireAdmin, _sendBracketXlsx);
app.get("/api/public/tournaments/:id/bracket/export.xlsx", _sendBracketXlsx);

// Excelラウンドトリップ取込: export.xlsx を手修正→再取込して『位置だけ』正本化する(往復ループを閉じる)。
// _import シート(機械可読)を読み、entrantを消さず差分でブラケットを再構成。dry_run=1でプレビュー・force=1で結果上書き。
app.post("/api/tournaments/:id/bracket/import-xlsx", requireAdmin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルが添付されていません" });
  const filePath = req.file.path;
  try {
    const XLSX = require("xlsx");
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets["_import"];
    if (!sheet) return res.status(400).json({ error: "このExcelには取込用データ(_importシート)がありません。システムが出力したトーナメント表Excelをそのまま使ってください。" });
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    if (String((aoa[0] || [])[0]) !== "__KTTA_BRACKET_IMPORT__") return res.status(400).json({ error: "_importシートの形式が不正です。" });
    const header = aoa[1] || [];
    const ci = (n) => header.indexOf(n);
    const cEvent = ci("event"), cPos = ci("bracket_pos"), cSlot = ci("slot"), cEid = ci("entrant_id"), cName = ci("name"), cTeam = ci("team"), cBye = ci("bye");
    const rows = aoa.slice(2).filter(r => r && r.length).map(r => ({
      event: r[cEvent], bracket_pos: r[cPos], slot: r[cSlot], entrant_id: r[cEid], name: r[cName], team: r[cTeam], bye: r[cBye],
    }));
    const preview = req.query.dry_run === "1" || req.body?.dry_run === "1" || req.body?.dry_run === "true";
    const force = req.body?.force === "1" || req.body?.force === "true" || req.body?.force === true;
    const r = db.importBracketRoundtrip(req.params.id, rows, { force, preview });
    if (r.error) return res.status(400).json(r);
    return res.json(r);
  } catch (e) {
    console.error("bracket import-xlsx error:", e);
    return res.status(500).json({ error: "取込失敗: " + e.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch (x) {}
  }
});

// ─── 領収書 一括 HTML 出力 (印刷で PDF 化、モーダル表示用) ───
app.get("/api/tournaments/:id/receipts.html", requireAdmin, (req, res) => {
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
      // 実アップロードが無ければ印影は空(領収書は「印」枠を直接描く)。存在しない seal.png への404を出さない。
      if (!sealUrl) sealUrl = "";
    }
    // 協会ロゴURL: アップロード済み logo.* があれば優先、なければ既定アイコン (#272)
    let logoUrl = req.query.logo_url;
    if (!logoUrl) {
      if (SEAL_DIR_PERSISTENT) {
        for (const e of [".png", ".jpg", ".jpeg"]) {
          if (fs.existsSync(path.join(SEAL_DIR_PERSISTENT, "logo" + e))) {
            logoUrl = "/uploads/logo" + e;
            break;
          }
        }
      }
      if (!logoUrl) {
        // 永続ディスク未設定(ローカル/単純デプロイ)では public/shared/assets を確認
        for (const e of [".png", ".jpg", ".jpeg"]) {
          if (fs.existsSync(path.join(SEAL_DIR_DEFAULT, "logo" + e))) {
            logoUrl = "/shared/assets/logo" + e;
            break;
          }
        }
      }
      if (!logoUrl) logoUrl = "/shared/assets/icon-192.png";
    }
    const html = reports.buildReceiptsHTML(tournament, entrants, {
      fees,
      seal_url: sealUrl,
      logo_url: logoUrl,
      only_team: req.query.team || undefined,   // 個別発行: 指定団体のみ (#272)
      start_no: req.query.start_no,             // 連番の開始番号 (#272)
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
app.get("/api/tournaments/:id/receipts.json", requireAdmin, (req, res) => {
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

// ─── 協会ロゴ画像アップロード (領収書ヘッダ用) #272 ───
app.post("/api/settings/logo", requireAdmin, upload.single("logo"), (req, res) => {
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
  const dest = path.join(targetDir, "logo" + ext);
  fs.renameSync(req.file.path, dest);
  const url = SEAL_DIR_PERSISTENT
    ? "/uploads/logo" + ext
    : "/shared/assets/logo" + ext;
  res.json({ ok: true, path: url, size: req.file.size });
});

// 永続ディスク用 印鑑/ロゴ画像 配信
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

// 壊れた event_config 救済: 種目 name にイベントオブジェクトが入っている場合、内側の name 文字列を取り出す
// (申込フォームの種目名が「[object Object]」になる不具合の多重防御。保存時と読取時の両方で使う)
function _eventNameStr(n) {
  while (n && typeof n === "object") n = n.name;
  return n == null ? "" : String(n);
}

function _resolveEvents(tournament) {
  // ★ 最優先: tournament.event_config (フォーム生成で保存された full データ)
  try {
    if (tournament.event_config) {
      const cfg = typeof tournament.event_config === "string"
        ? JSON.parse(tournament.event_config)
        : tournament.event_config;
      if (Array.isArray(cfg) && cfg.length) {
        return cfg.map(e => ({
          name: _eventNameStr(e.name),
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
      turnstile_sitekey: process.env.TURNSTILE_SITEKEY || "",
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
// 申込台帳 (フラット一覧) Excel 出力。Googleフォーム→スプレッドシートの代替。
// note 列(=氏名/メール/電話の連絡先PII)を「備考(連絡先等)」として出力するため要管理キー。
app.get("/api/tournaments/:id/applicants.xlsx", requireAdmin, (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    const entrants = db.getEntrants(req.params.id);
    if (!entrants.length) return res.status(400).json({ error: "申込がまだありません" });
    const buf = reports.buildApplicantsXlsx(tournament, entrants, {});
    const safeName = (tournament.name || "tournament").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const filename = encodeURIComponent(`申込一覧_${safeName}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buf);
  } catch (e) {
    console.error("applicants.xlsx error:", e);
    res.status(500).json({ error: "申込一覧生成失敗: " + e.message });
  }
});
// 統計 (種目×ブロック分布)
app.get("/api/tournaments/:id/entrants/stats", (req, res) => {
  res.json(db.getEntrantStats(req.params.id));
});

// ═══ 進行管理 (Operations) API ═══════════════════════
app.post("/api/tournaments/:id/bracket", requireAdmin, (req, res) => {
  const { event, regenerate, player_ids, force } = req.body || {};
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.generateBracket(req.params.id, event, { regenerate, player_ids, force: !!force });
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
// 公開ビュー用にペイロードを軽量化 (#233 負荷対策)。
// callable は試合行(全列)が重いので閲覧に必要な項目だけに絞る(件数は維持)。
// recent は12件に、referee_queue(閲覧未使用)は省略。
function slimPublicState(st) {
  const slimCall = (st.callable || []).map(m => ({
    id: m.id, event: m.event, round: m.round, round_order: m.round_order,
    player1_name: m.player1_name, player2_name: m.player2_name,
    player1_team: m.player1_team, player2_team: m.player2_team,
    player1_furigana: m.player1_furigana, player2_furigana: m.player2_furigana,
    player1_bracket_number: m.player1_bracket_number, player2_bracket_number: m.player2_bracket_number,
    entrant1_bracket_number: m.entrant1_bracket_number, entrant2_bracket_number: m.entrant2_bracket_number,
    // 選手DBリンク用 (ダブルスは2名を別々にリンクするため id/相方情報も渡す #266)
    player1_id: m.player1_id, player2_id: m.player2_id,
    player1_main_name: m.player1_main_name, player2_main_name: m.player2_main_name,
    player1_partner_id: m.player1_partner_id, player2_partner_id: m.player2_partner_id,
    player1_partner_name: m.player1_partner_name, player2_partner_name: m.player2_partner_name,
    blocks: m.blocks, is_blocked: m.is_blocked,
  }));
  return {
    // on_table / recent_finished は callable と違いフル row が素通しだった(内部の
    // next_match_id/referee_id/rating_delta/sets_json 等を全観客へ毎回配布)。liveMatch で内部列のみ落とす。
    // 1得点変化×200観客の差が大きい。再コール系(call_count*/recall_count/called_at)・elapsed_min/pending は
    // /viewer/live がバッジ/呼出時刻として表示するため liveMatch が保持(/matches とは別射影=盤面と整合)。
    tournament: sanitizeTournamentPublic(st.tournament), tables: st.tables,
    on_table: (st.on_table || []).map(liveMatch),
    callable: slimCall, waiting: st.waiting,
    recent_finished: (st.recent_finished || []).slice(0, 12).map(liveMatch),
    finished_count: st.finished_count,
    event_stats: st.event_stats, total_matches: st.total_matches, progress: st.progress,
  };
}
// /live は直列化済みJSON文字列をフィンガープリント単位でキャッシュ。
// 多数同時アクセスでも再シリアライズせず文字列を send → CPU/帯域を大幅節約。
const _liveCache = new Map(); // tid -> { key, json, fpAt }
// 突発負荷(SSE一斉切断→全員が同時に /live をポーリング 等)で fingerprint 取得(DB読取)が集中し
// event-loop を飽和させるのを防ぐため、直近 TTL 内は fingerprint を引かずに前回JSONを返す。
// SSE が変化を即push する主経路のため、ポーリング側の最大 TTL 遅延は実用上問題なし。
const LIVE_FP_TTL_MS = parseInt(process.env.LIVE_FP_TTL_MS) || 200;
function getCachedLiveJSON(tid) {
  const cached = _liveCache.get(tid);
  const now = Date.now();
  // 直近 TTL 内に検証済みなら、DBを引かずそのまま返す (バースト時のDB読取を集約)
  if (cached && cached.fpAt && (now - cached.fpAt) < LIVE_FP_TTL_MS) return cached;
  const fp = db.getOpsFingerprint(tid);
  if (!fp || fp.error) {
    const st = db.getOperationState(tid);
    return st ? { json: JSON.stringify(slimPublicState(st)) } : null; // 大会なし→null(404)
  }
  const key = fp.v + "|" + (fp.status || "");
  const c = _liveCache.get(tid);
  if (c && c.key === key) { c.fpAt = now; return c; }   // 変化なし → 再シリアライズせず流用
  const st = db.getOperationState(tid);
  if (!st) return null;
  const entry = { key, json: JSON.stringify(slimPublicState(st)), fpAt: now };
  _liveCache.set(tid, entry);
  if (_liveCache.size > 300) {
    const it = _liveCache.keys();
    while (_liveCache.size > 200) { const k = it.next().value; if (k === undefined) break; _liveCache.delete(k); }
  }
  return entry;
}

app.get("/api/tournaments/:id/operations", (req, res) => {
  // 管理(進行管理)は常にフレッシュ取得 (キャッシュ非経由)。
  // 審判の報告→承認待ちが本部に即座に届くように。公開 /live はキャッシュ維持で負荷を抑える。
  const state = db.getOperationState(req.params.id);
  if (!state) return res.status(404).json({ error: "大会が見つかりません" });
  // この経路も認証必須ではないため、未認証時は埋め込み大会の秘密フィールドを除去 (#1/#14)。
  if (!isAdminAuthed(req)) state.tournament = sanitizeTournamentPublic(state.tournament);
  res.json(state);
});

// 団体戦の所属選手 (名簿) — 進行管理で「どの選手が出場するか」を表示するため。
// メンバー名のみ返却 (連絡先などの PII は含めない)。
app.get("/api/tournaments/:id/team-rosters", (req, res) => {
  res.json({ rosters: db.getTeamRosters(req.params.id) });
});

// 各種目のベスト8 (準々決勝進出者・氏名+所属) — 進行管理で常時表示 #208
app.get("/api/tournaments/:id/best8", (req, res) => {
  res.json({ events: db.getAllBest8(req.params.id) });
});

// ─── DB スナップショット (試合中の自動バックアップ + 手動保存/復元) ───────────
// 一覧 (名前/サイズ/日時のみ・中身は返さない → GET 可)
app.get("/api/admin/snapshots", requireAdmin, (req, res) => {
  res.json({ snapshots: db.listSnapshots(), auto_enabled: true,
    ongoing: db.hasOngoingTournament() });
});
// 今すぐ保存 (管理者)
app.post("/api/admin/snapshots", requireAdmin, async (req, res) => {
  try { res.json(await db.createSnapshot("manual")); }
  catch (e) { res.status(500).json({ error: "保存に失敗しました: " + e.message }); }
});
// ダウンロード (管理者・POST で X-Admin-Key を送らせる。ファイルをそのまま返す)
app.post("/api/admin/snapshots/download", requireAdmin, (req, res) => {
  const p = db.snapshotPath((req.body && req.body.name) || "");
  if (!p) return res.status(404).json({ error: "スナップショットが見つかりません" });
  res.download(p);
});
// 復元 (管理者・破壊的)。安全網スナップを取ってから差し替え、プロセス再起動。
app.post("/api/admin/snapshots/restore", requireAdmin, (req, res) => {
  const name = (req.body && req.body.name) || "";
  let r;
  try { r = db.restoreSnapshot(name); }
  catch (e) { return res.status(500).json({ error: "復元に失敗しました: " + e.message }); }
  if (r.error) return res.status(400).json(r);
  res.json(r);
  if (r.restart_required) {
    console.log("[restore] スナップショット復元 → プロセスを再起動します:", name);
    // 応答を送り切ってからプロセス終了 (systemd 等が再起動して復元後DBで再オープン)
    setTimeout(() => process.exit(0), 400);
  }
});

app.get("/api/public/tournaments/:id/live", (req, res) => {
  const entry = getCachedLiveJSON(req.params.id);
  if (!entry) return res.status(404).json({ error: "大会が見つかりません" });
  // 進行fingerprint(entry.key)を ETag 化。未変化のポーリングは 304(本体なし)で返し帯域/再シリアライズを節約。
  // 直列化済み文字列をそのまま返す (再シリアライズなし)。短期ブラウザ/CDNキャッシュも許可。
  if (conditional(req, res, entry.key, "public, max-age=2")) return;
  return res.type("application/json").send(entry.json);
});

// 進行の変化検知用 軽量エンドポイント (クライアントは変化時のみ重い /live を取得)
app.get("/api/public/tournaments/:id/ops-version", (req, res) => {
  const fp = db.getOpsFingerprint(req.params.id);
  // fp 自体を ETag 化。未変化のポーリング(大半)は 304 で返し、Cloudflare/ブラウザが安価に再検証できる。
  const tag = (fp && fp.v != null ? fp.v : "0") + "|" + (fp && fp.status || "");
  if (conditional(req, res, tag, "public, max-age=2")) return;
  res.json(fp);
});

// 大会進行「タブ」用 全試合リスト (待機中/終了/総試合タブを開いた時だけ遅延取得)。
// /live と同様に進行フィンガープリント単位で直列化JSONをキャッシュ → 多数同時でもCPU/帯域節約。
// 公開 /live のペイロードは軽量に保ったまま、参照タブを開いた人だけが全試合を取得する。
const _matchListCache = new Map(); // tid -> { key, json }
function getCachedMatchListJSON(tid) {
  const fp = db.getOpsFingerprint(tid);
  if (!fp || fp.error) {
    const ml = db.getOpMatchList(tid);
    return ml ? { json: JSON.stringify(ml) } : null;
  }
  const key = fp.v + "|" + (fp.status || "");
  const c = _matchListCache.get(tid);
  if (c && c.key === key) return c;
  const ml = db.getOpMatchList(tid);
  if (!ml) return null;
  const entry = { key, json: JSON.stringify(ml) };
  _matchListCache.set(tid, entry);
  if (_matchListCache.size > 300) {
    const it = _matchListCache.keys();
    while (_matchListCache.size > 200) { const k = it.next().value; if (k === undefined) break; _matchListCache.delete(k); }
  }
  return entry;
}
app.get("/api/public/tournaments/:id/match-list", (req, res) => {
  const entry = getCachedMatchListJSON(req.params.id);
  if (!entry) return res.status(404).json({ error: "大会が見つかりません" });
  // 進行fingerprint(entry.key)を ETag 化。参照タブの再取得が未変化なら 304 で軽量化。
  if (conditional(req, res, entry.key, "public, max-age=2")) return;
  return res.type("application/json").send(entry.json);
});

// ─── 進行リアルタイム通知 (SSE: Server-Sent Events) #264 ───
// 変化したら各クライアントへ即push。送るのは「reload合図」のみでデータ本体やPIIは載せない
// (公開可)。実データ取得は従来どおり認証付きエンドポイントで行う。
// nginx 等のバッファリングは X-Accel-Buffering:no で無効化、~5秒ハートビートで切断を防ぐ。
const sseClients = new Map();    // tid -> Set<res>
const sseLastFp = new Map();     // tid -> fingerprint
const sseLastEmit = new Map();   // tid -> ms
let sseTotal = 0;
// 同時SSE接続の上限。会場の共有WiFi/Cloudflare 経由では多数の視聴者が「1つの IP」に集約されるため、
// per-IP 上限が低いと正規の観戦者が締め出される(#271の方針=閲覧ページはIP制限しない)。
// グローバル上限(SSE_MAX)を資源枯渇/DoSの主防御とし、per-IP は会場規模を通すため大きめ。env で運用調整可。
// 拒否されても CLIENT は自動でポーリングに退避するため致命ではないが、100人規模の会場では受理されるべき。
const SSE_MAX = parseInt(process.env.SSE_MAX) || 600;
const sseByIp = new Map();       // IP -> 接続数
const SSE_PER_IP = parseInt(process.env.SSE_PER_IP) || 200;
function sseClientIp(req) {
  return clientIp(req);   // #25: trust proxy 準拠の単一ヘルパに統一 (生 cf-connecting-ip 偽装での上限回避を防止)
}
function sseSend(res, obj) { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {} }
function sseBroadcast(tid, obj) {
  const set = sseClients.get(tid); if (!set) return;
  for (const r of set) sseSend(r, obj);
  sseLastEmit.set(tid, Date.now());
}
// 変化検知 + ハートビート (in-process。SQLite fingerprint は軽量)。クライアントがいる大会のみ。
setInterval(() => {
  if (sseClients.size === 0) return;
  const now = Date.now();
  for (const [tid, set] of sseClients) {
    if (!set || set.size === 0) { sseClients.delete(tid); sseLastFp.delete(tid); sseLastEmit.delete(tid); continue; }
    let fp; try { fp = JSON.stringify(db.getOpsFingerprint(tid)); } catch (e) { continue; }
    if (fp !== sseLastFp.get(tid)) { sseLastFp.set(tid, fp); sseBroadcast(tid, { type: "ops" }); }
    else if (now - (sseLastEmit.get(tid) || 0) > 5000) { sseBroadcast(tid, { type: "ping" }); }
  }
}, 800).unref();  // プロセスのクリーン終了を妨げない (他の定期掃引と同じ方針)

app.get("/api/public/tournaments/:id/ops-stream", (req, res) => {
  if (sseTotal >= SSE_MAX) return res.status(503).end();
  const ip = sseClientIp(req);
  if ((sseByIp.get(ip) || 0) >= SSE_PER_IP) return res.status(429).end();  // 同一IPの過剰接続を拒否
  const tid = String(req.params.id);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",   // nginx/Cloudflare: この応答はバッファせず即流す (SSE 必須)
  });
  if (res.flushHeaders) res.flushHeaders();
  // 再接続間隔を接続ごとにジッタ化(2.5〜5.5秒)。systemctl restart で200台が一斉切断されても
  // 固定3秒だと3秒境界に再接続が殺到しスパイクするため、各クライアントの retry をばらして平準化する。
  res.write("retry: " + (2500 + Math.floor(Math.random() * 3000)) + "\n\n");
  sseSend(res, { type: "hello" });
  let set = sseClients.get(tid); if (!set) { set = new Set(); sseClients.set(tid, set); }
  set.add(res); sseTotal++;
  sseByIp.set(ip, (sseByIp.get(ip) || 0) + 1);
  // 基準fingerprintは「その大会に既存の基準が無いとき(=最初の購読者)」だけ設定する。
  // 既存購読者がいるのに基準を現在値へ上書きすると、直前のadmin操作など未配信の変化を全員が
  // 取りこぼす (#15)。新規接続クライアントは初期データを別途取得済みなので誤pushにはならない。
  if (!sseLastFp.has(tid)) {
    try { sseLastFp.set(tid, JSON.stringify(db.getOpsFingerprint(tid))); } catch (e) {}
  }
  sseLastEmit.set(tid, Date.now());
  let closed = false;
  const cleanup = () => {
    if (closed) return; closed = true;
    const s = sseClients.get(tid); if (s) s.delete(res);
    sseTotal = Math.max(0, sseTotal - 1);
    const n = (sseByIp.get(ip) || 1) - 1;
    if (n <= 0) sseByIp.delete(ip); else sseByIp.set(ip, n);
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
});

// 選手個人の試合状況 (マイ番号ポータル用)
app.get("/api/public/players/:id/live-status", (req, res) => {
  const status = db.getPlayerLiveStatus(req.params.id, req.query.tournament_id);
  if (!status) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(status);
});

app.post("/api/matches/:id/call", requireAdmin, (req, res) => {
  const pre = db.getMatch(req.params.id);
  const before = db.snapshotMatchRows(pre ? [pre.id] : [req.params.id]);
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
  if (pre) db.recordOp(pre.tournament_id, "call",
    `呼出: 台${parseInt(req.body?.table_no) || pre.table_no || "?"}（${pre.player1_name || ""} vs ${pre.player2_name || ""}）`,
    [pre.id], before);
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
      // 監督・顧問へまとめて呼出通知 (#287): マイ選手に該当があれば監督端末へ
      const coachNote = (playerName, oppName) => ({
        title: "マイ選手の呼出", body: `${playerName || "選手"} → ${tableNo ? "台" + tableNo : "コール"}` + (oppName ? `\n（対 ${oppName}）` : ""),
        url: "/viewer/#coach", tag: "ktta-coach-call",
      });
      if (m.player1_id) sendPushToCoachesForPlayer(m.player1_id, coachNote(m.player1_name, m.player2_name)).catch(() => {});
      if (m.player2_id) sendPushToCoachesForPlayer(m.player2_id, coachNote(m.player2_name, m.player1_name)).catch(() => {});
    }
  } catch (e) { /* 通知失敗は無視 (呼出本体は成功済み) */ }
});

app.post("/api/matches/:id/uncall", requireAdmin, (req, res) => {
  const pre = db.getMatch(req.params.id);
  const before = db.snapshotMatchRows(pre ? [pre.id] : [req.params.id]);
  const r = db.uncallMatch(req.params.id);
  if (pre && !(r && r.error)) db.recordOp(pre.tournament_id, "uncall",
    `台から戻す: 台${pre.table_no || "?"}（${pre.player1_name || ""} vs ${pre.player2_name || ""}）`,
    [pre.id], before);
  res.json(r);
});

// ─── Web Push 購読 API ──────────────────────────────────
app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ enabled: PUSH_ENABLED, key: VAPID_PUBLIC });
});
app.post("/api/push/subscribe", rateLimit({ windowMs: 60000, max: 30 }), (req, res) => {
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
  const pre = db.getMatch(req.params.id);
  // 前方チェーン全体を snapshot/undo 対象に。BYE連鎖の自動進行は1回の確定で次戦より先
  // (C,D..)まで書き換えるため、1ホップ[A,B]だと undo が下流の進出を戻せない(#undo)。
  const ids = pre ? db.collectForwardChain(pre.id) : [req.params.id];
  const before = db.snapshotMatchRows(ids);
  const r = db.finishMatchOp(req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: "試合が見つかりません" });
  if (!r.error && pre) db.recordOp(pre.tournament_id, "finish",
    `結果入力: ${r.winner_name || ""} ${r.winner_sets || 0}-${r.loser_sets || 0} ${r.loser_name || ""}（${pre.event || ""} ${pre.round || ""}）`,
    ids, before);
  res.json(r);
});

// 結果修正 (完了済み試合の再編集)
// body: { winner_slot: 1|2, sets: [[w,l]...], winner_sets?, loser_sets? }
// 次の試合に既に進出済みなら自動で取消 → 新勝者で再進出
app.post("/api/matches/:id/correct", requireAdmin, (req, res) => {
  const pre = db.getMatch(req.params.id);
  // 前方チェーン全体を snapshot/undo 対象に。BYE連鎖の自動進行は1回の確定で次戦より先
  // (C,D..)まで書き換えるため、1ホップ[A,B]だと undo が下流の進出を戻せない(#undo)。
  const ids = pre ? db.collectForwardChain(pre.id) : [req.params.id];
  const before = db.snapshotMatchRows(ids);
  const r = db.correctResult(req.params.id, req.body || {});
  if (r?.error) return res.status(400).json(r);
  try { db.markResultSource(req.params.id, "hq"); } catch (e) { /* 本部が修正=確認済扱い */ }
  if (pre) db.recordOp(pre.tournament_id, "correct",
    `結果修正: ${r.winner_name || ""} ${r.winner_sets || 0}-${r.loser_sets || 0} ${r.loser_name || ""}（${pre.event || ""} ${pre.round || ""}）`,
    ids, before);
  res.json(r);
});

// 審判入力された結果を本部が「確認」(承認)して確定 (#215)。result_source を 'hq' に。
app.post("/api/matches/:id/confirm-result", requireAdmin, (req, res) => {
  const m = db.getMatch(req.params.id);
  if (!m) return res.status(404).json({ error: "試合が見つかりません" });
  db.markResultSource(m.id, "hq");
  try {
    db.recordOp(m.tournament_id, "confirm",
      `結果確認: ${m.winner_name || ""} ${m.winner_sets || 0}-${m.loser_sets || 0} ${m.loser_name || ""}` +
      `（${m.event || ""} ${m.round || ""}）`,
      [m.id], db.snapshotMatchRows([m.id]));
  } catch (e) { /* ログ失敗は本処理に影響させない */ }
  res.json({ ok: true, result_source: "hq" });
});

// ─── 操作ログ + Undo (誤操作/抗議対応) ──────────────────────────
app.get("/api/tournaments/:id/op-log", (req, res) => {
  res.json({ log: db.getOpLog(req.params.id, req.query.limit) });
});
app.post("/api/tournaments/:id/undo-last", requireAdmin, (req, res) => {
  const r = db.undoLastOp(req.params.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// ─── 審判結果入力 (本部に来ずに審判が結果報告) ──────────────────
// 管理側: トークン発行/再発行・ON/OFF・現在の設定取得。
// 審判側 (/api/ref/*): 管理キー不要、限定トークンで「結果報告のみ」。
//   テスト大会で先に有効化 → 裏側検証 → 本番大会で解禁、という段階運用を想定。

// 現在の設定 (トークン・有効/無効) を取得
app.get("/api/admin/tournaments/:id/referee-config", requireAdmin, (req, res) => {
  const cfg = db.getRefereeConfig(req.params.id);
  if (!cfg) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(cfg);
});
// トークン発行/再発行 (body.enable で有効化も同時指定可)。再発行で旧リンクは失効。
app.post("/api/admin/tournaments/:id/referee-token", requireAdmin, (req, res) => {
  const r = db.setRefereeToken(req.params.id, { enable: req.body ? req.body.enable : undefined });
  if (r && r.error) return res.status(404).json(r);
  res.json(r);
});
// 審判入力の ON/OFF 切替 (有効化時にトークン未発行なら自動発行)
app.put("/api/admin/tournaments/:id/referee-input", requireAdmin, (req, res) => {
  const r = db.setRefereeInputEnabled(req.params.id, !!(req.body && req.body.enabled));
  if (r && r.error) return res.status(404).json(r);
  res.json(r);
});
// 会場パスコード (#261): 要求ON/OFF・再生成・任意指定。会場で審判に伝える暗証番号。
// body: { required?:bool, code?:string, regenerate?:bool }
app.put("/api/admin/tournaments/:id/referee-passcode", requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = db.setRefereePasscode(req.params.id, {
    required: b.required, code: b.code, regenerate: b.regenerate,
  });
  if (r && r.error) return res.status(404).json(r);
  res.json(r);
});
// コート別リンク (試験運用 #229): 全コート分のキーを返す。マスタトークンから自動導出。
app.get("/api/admin/tournaments/:id/referee-court-links", requireAdmin, (req, res) => {
  const r = db.getRefereeCourtLinks(req.params.id);
  if (!r) return res.status(400).json({ error: "審判入力が有効ではありません（先に「有効にする」を押してください）" });
  res.json(r);
});

// 審判ビュー: 現在台に入っている試合 (PII除外・管理キー不要・トークンのみ)
// トークン漏洩時のスクレイピング/DoS 対策にレート制限 (正規の審判は12秒間隔ポーリング)。
app.get("/api/ref/state",
  rateLimit({ windowMs: 60000, max: 120, message: "リクエストが多すぎます。少し待って再試行してください。" }),
  requireReferee, (req, res) => {
  const v = db.getRefereeView(req.refTournament.id, req.refCourt);
  if (!v) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(v);
});
// 会場パスコードの総当たり対策 (#261強化): パスコードは短い数字のため、
// per-IP の「連続失敗」計数で一時ブロックする。正解でクリアするので正規の審判は影響なし。
// (報告自体は本部承認制で守られているが、総当たりによる承認待ちスパムを防ぐ)
const _refPassFail = new Map(); // ip -> { count, resetAt }
const REF_PASS_MAX = 10, REF_PASS_WINDOW = 5 * 60000; // 5分で10回失敗まででブロック
setInterval(() => { const now = Date.now(); for (const [ip, e] of _refPassFail) if (now > e.resetAt) _refPassFail.delete(ip); }, REF_PASS_WINDOW).unref();
function refPassBlocked(ip) { const e = _refPassFail.get(ip); return !!(e && Date.now() <= e.resetAt && e.count >= REF_PASS_MAX); }
function refPassFail(ip) { const now = Date.now(), e = _refPassFail.get(ip); if (!e || now > e.resetAt) _refPassFail.set(ip, { count: 1, resetAt: now + REF_PASS_WINDOW }); else e.count++; }
function refPassOk(ip) { _refPassFail.delete(ip); }
const REF_PASS_BLOCK_MSG = "試行回数が多すぎます。しばらく待ってから再度お試しください。";
// 会場パスコード照合 (#261): 審判ページが入力前に正誤を確認するための軽量エンドポイント。
// 要求OFFなら常に ok:true。最終的な担保は finish 側でも再検証する。
app.post("/api/ref/verify-passcode",
  rateLimit({ windowMs: 60000, max: 60, message: "リクエストが多すぎます。少し待って再試行してください。" }),
  requireReferee, (req, res) => {
  const ip = _coachIp(req);
  if (refPassBlocked(ip)) return res.status(429).json({ error: REF_PASS_BLOCK_MSG });
  const ok = db.verifyRefereePasscode(req.refTournament.id, req.body && req.body.passcode);
  if (ok) refPassOk(ip); else refPassFail(ip);
  res.json({ ok: !!ok });
});
// 審判による結果送信。winner-only 可 (sets 空でOK / セット数も任意で送れる)。
// セキュリティ: そのトークンの大会の「台に入っている」試合だけ確定可能。
app.post("/api/ref/matches/:id/finish",
  rateLimit({ windowMs: 60000, max: 120, message: "送信が多すぎます。少し待って再試行してください。" }),
  requireReferee, (req, res) => {
  // 会場パスコード (#261): 要求ONの大会は、正しいパスコードが無いと報告不可。
  // 総当たり対策: verify-passcode と同じ per-IP 失敗ゲートで保護。
  const _refIp = _coachIp(req);
  if (refPassBlocked(_refIp)) return res.status(429).json({ error: REF_PASS_BLOCK_MSG, passcode_error: true });
  if (!db.verifyRefereePasscode(req.refTournament.id, req.body && req.body.passcode)) {
    refPassFail(_refIp);
    return res.status(403).json({
      error: "会場パスコードが正しくありません。本部にご確認ください。",
      passcode_error: true,
    });
  }
  refPassOk(_refIp);
  const m = db.getMatch(req.params.id);
  if (!m) return res.status(404).json({ error: "試合が見つかりません" });
  if (m.tournament_id !== req.refTournament.id)
    return res.status(403).json({ error: "この試合はこのリンクの対象外です" });
  // コート別トークンは自分のコートの試合のみ報告可 (#229)
  if (req.refCourt && Number(m.table_no) !== Number(req.refCourt))
    return res.status(403).json({ error: "このリンクはコート" + req.refCourt + "専用です。担当コートの試合のみ報告できます。" });
  if (m.status !== "on_table")
    return res.status(409).json({ error: "この試合は現在コートに入っていません。本部にご確認ください。" });
  // 確定せず「本部承認待ち」の暫定結果として保存 (承認されるまでコートに残す #223)
  const r = db.setPendingResult(req.params.id, req.body || {});
  if (r && r.error) return res.status(400).json(r);
  db.recordOp(m.tournament_id, "report",
    `審判報告(承認待ち): ${r.pending.winner_name || ""} の勝ち` +
    `（${m.event || ""} ${m.round || ""} コート${m.table_no || "?"}）`,
    [m.id], db.snapshotMatchRows([m.id]));
  res.json({
    ok: true, awaiting_approval: true,
    winner_name: r.pending.winner_name, loser_name: r.pending.loser_name,
    winner_sets: r.pending.winner_sets, loser_sets: r.pending.loser_sets,
  });
});

// 審判の暫定結果を本部が承認 → 確定 (勝者を進出させコートから外す) #223
app.post("/api/matches/:id/approve-result", requireAdmin, (req, res) => {
  const m = db.getMatch(req.params.id);
  if (!m) return res.status(404).json({ error: "試合が見つかりません" });
  const pend = db.getPendingResult(req.params.id);
  if (!pend) return res.status(400).json({ error: "承認待ちの結果がありません" });
  // 前方チェーン全体を undo 対象に (BYE連鎖で次戦より先まで波及するため。#undo)
  const ids = db.collectForwardChain(m.id);
  const before = db.snapshotMatchRows(ids);
  const r = db.finishMatchOp(req.params.id, pend);
  if (!r) return res.status(404).json({ error: "試合が見つかりません" });
  if (r.error) return res.status(400).json(r);
  try { db.markResultSource(m.id, "referee"); } catch (e) { /* 由来バッジ */ }
  db.clearPendingResult(m.id);
  db.recordOp(m.tournament_id, "approve",
    `結果承認: ${r.winner_name || ""} ${r.winner_sets || 0}-${r.loser_sets || 0} ${r.loser_name || ""}` +
    `（${m.event || ""} ${m.round || ""}）`,
    ids, before);
  res.json({ ok: true, winner_name: r.winner_name, loser_name: r.loser_name,
    winner_sets: r.winner_sets, loser_sets: r.loser_sets });
});
// 審判の暫定結果を却下 (コートに戻す・結果は確定しない) #223
app.post("/api/matches/:id/reject-result", requireAdmin, (req, res) => {
  const m = db.getMatch(req.params.id);
  if (!m) return res.status(404).json({ error: "試合が見つかりません" });
  db.clearPendingResult(req.params.id);
  try {
    db.recordOp(m.tournament_id, "reject",
      `審判報告を却下（${m.event || ""} ${m.round || ""} コート${m.table_no || "?"}）`,
      [m.id], db.snapshotMatchRows([m.id]));
  } catch (e) { /* ログ失敗は無視 */ }
  res.json({ ok: true });
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
// 申込台帳(entry_note=連絡先PIIを含む)。利用元は admin の申込管理のみ → 要管理キー。
app.get("/api/tournaments/:id/entries", requireAdmin, (req, res) => {
  res.json(db.getEntries(req.params.id, req.query.status));
});
app.post("/api/tournaments/:id/entries", requireAdmin, (req, res) => {
  // 管理者直接追加（auto_confirm: true）
  const r = db.createEntry(req.params.id, { ...req.body, auto_confirm: true });
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});
// 申込の承認状態/シード操作は entrants(申込の正本)に対して行う。:pid は entrant.id (Phase1)。
app.put("/api/tournaments/:id/entries/:pid/status", requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!["pending", "confirmed", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status は pending/confirmed/rejected" });
  }
  const r = db.setEntrantStatus(req.params.pid, status);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
app.put("/api/tournaments/:id/entries/:pid/seed", requireAdmin, (req, res) => {
  const { seed } = req.body || {};
  const r = db.setEntrantSeed(req.params.pid, seed);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

// スーパーシード: 登場ラウンド(予選免除)を設定。1=1回戦から(既定), R=R回戦から登場。
// 標準配置の生成時に 2^(entry_round-1) ラウンドぶん BYE 上がりになる。
app.put("/api/tournaments/:id/entries/:pid/entry-round", requireAdmin, (req, res) => {
  const { entry_round } = req.body || {};
  const r = db.setEntrantEntryRound(req.params.pid, entry_round);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

// ── Phase4: データ品質(種目名と gender/category の不整合・ふりがな欠落 を検出/修正) ──
app.get("/api/tournaments/:id/entry-issues", requireAdmin, (req, res) => {
  res.json(db.findEntrantDataIssues(req.params.id));
});
// PII 削除依頼対応: 申込原本と紐づく entrants の連絡先を匿名化(構造は残す)。閲覧トークンも失効。
app.delete("/api/submissions/:id/pii", requireAdmin, (req, res) => {
  const r = db.deleteSubmissionPII(req.params.id, { revoke_tokens: true });
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
// 保持期間超過の申込原本PIIを手動で一括匿名化(?days=N)。env PII_RETENTION_DAYS 既定。
app.post("/api/admin/purge-submission-pii", requireAdmin, (req, res) => {
  const days = req.query.days || req.body?.days || process.env.PII_RETENTION_DAYS;
  res.json(db.purgeOldSubmissionPII(days));
});
app.post("/api/tournaments/:id/entries/:pid/fix", requireAdmin, (req, res) => {
  const r = db.fixEntrant(req.params.pid, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.post("/api/tournaments/:id/entry-issues/bulk-fix", requireAdmin, (req, res) => {
  res.json(db.bulkFixEntrantInference(req.params.id, req.body || {}));
});
app.put("/api/tournaments/:id/entry-settings", requireAdmin, (req, res) => {
  const body = req.body || {};
  // 源を断つ: 保存時に event_config の種目 name を必ず文字列化する(壊れた name=オブジェクトを弾く)
  if (Array.isArray(body.event_config)) {
    body.event_config = body.event_config.map(e => (e && typeof e === "object") ? { ...e, name: _eventNameStr(e.name) } : e);
  }
  const r = db.updateEntrySettings(req.params.id, body);
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

// 端末接続案内(LAN URL + ローカル生成QR)。会場オフラインでも外部QRサービスに依存しない(qrcode 同梱)。
// 本部ホストで開いた管理画面が、他の運営端末/大画面/観客端末の接続先を提示するのに使う。
app.get("/api/lan-info", async (req, res) => {
  const ips = lanIPv4s();
  const targets = [
    { path: "admin", label: "運営(他端末)" },
    { path: "viewer/live", label: "大画面(コート)" },
    { path: "viewer", label: "観戦(選手・観客)" },
  ];
  const urls = [];
  for (const ip of ips) {
    for (const t of targets) {
      const url = `http://${ip}:${PORT}/${t.path}`;
      let qr = "";
      try { qr = await QRCode.toString(url, { type: "svg", margin: 1, width: 150 }); } catch (e) {}
      urls.push({ ip, label: t.label, path: t.path, url, qr });
    }
  }
  res.json({ port: Number(PORT) || PORT, ips, urls });
});

// クラウド受信(公開ミラー): 本部ローカルからのスナップショットを適用。X-Sync-Key で認証。
// 大会の公開フィールドと matches のみ反映(秘匿列・申込PIIは温存)。本部が正本=全置換。
app.post("/api/sync/push", (req, res) => {
  if (!SYNC_KEY) return res.status(503).json({ error: "同期受信が無効です(SYNC_KEY 未設定)" });
  const key = req.get("X-Sync-Key") || "";
  if (!safeEqualStr(key, SYNC_KEY)) return res.status(401).json({ error: "同期キーが不正です" });
  try {
    const r = db.applyPublicSnapshot(req.body);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) { console.error("sync/push error:", e); res.status(500).json({ error: "同期適用失敗: " + e.message }); }
});
// 本部ローカル: 今すぐクラウドへ同期(手動)。:id 指定でその大会、無指定は進行中/準備中の大会を一括。
app.post("/api/tournaments/:id/sync/now", requireAdmin, async (req, res) => {
  const r = await pushTournamentToCloud(req.params.id);
  if (r.error) return res.status(r.error.includes("未設定") ? 400 : 502).json(r);
  res.json(r);
});
app.post("/api/sync/now", requireAdmin, async (req, res) => {
  if (!SYNC_CLOUD_URL || !SYNC_KEY) return res.status(400).json({ error: "クラウド同期が未設定です(SYNC_CLOUD_URL / SYNC_KEY)" });
  const active = (db.getTournaments() || []).filter(t => t.status === "ongoing" || t.status === "preparation");
  const results = [];
  for (const t of active) { results.push({ id: t.id, name: t.name, ...(await pushTournamentToCloud(t.id)) }); }
  res.json({ ok: results.every(r => r.ok), pushed: results.filter(r => r.ok).length, total: results.length, results });
});
// 同期の設定/状態(admin)。
app.get("/api/sync/status", requireAdmin, (req, res) => {
  res.json({
    push_enabled: !!(SYNC_CLOUD_URL && SYNC_KEY),     // この機(本部)からクラウドへ送れるか
    receive_enabled: !!SYNC_KEY,                       // この機がクラウド受信側か
    cloud_host: SYNC_CLOUD_URL ? SYNC_CLOUD_URL.replace(/^https?:\/\//, "") : "",
    last_ok_at: _syncState.last_ok_at, last_error: _syncState.last_error, last_count: _syncState.last_count,
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
    // ディスク残量 (DB/スナップショットが置かれるボリューム)。満杯になると書込失敗→運用停止のため監視用。
    disk: (() => {
      try {
        if (typeof fs.statfsSync !== "function") return null;  // Node 18.15+/19.6+
        const dbp = process.env.DB_PATH || path.join(__dirname, "data", "tournament.db");
        const s = fs.statfsSync(path.dirname(dbp));
        const free = s.bavail * s.bsize, total = s.blocks * s.bsize;
        return {
          free_gb: Math.round(free / 1e9 * 100) / 100,
          total_gb: Math.round(total / 1e9 * 100) / 100,
          used_pct: total ? Math.round((1 - free / total) * 1000) / 10 : null,
        };
      } catch (e) { return { error: String(e.message || e) }; }
    })(),
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
// 更新したJS/CSS/HTMLが必ず反映されるよう「都度再検証」(no-cache=ETagで304判定・キャッシュ自体は許可)。
// これを付けないとブラウザのヒューリスティックキャッシュで古い common.js 等が使われ、
// 進行管理の確定ボタンが無反応になる等の事故が起きるため。
// 版付与(?v=)されたリクエストは内容が確定しているので長期 immutable キャッシュ可。版が無い直アクセスは
// 従来どおり no-cache(毎回再検証)で安全側。これで「?v= 版busting × no-cache」の相殺を解消し、会場200台が
// common.js/css/アイコンを毎回再検証する往復を消す(ASSET_VER はデプロイ毎に変わるので古コード固着なし)。
function cacheMw(req, res, next) { res._ktVersioned = (req.query && req.query.v != null); next(); }
const staticOpts = {
  setHeaders: (res) => res.setHeader("Cache-Control",
    res._ktVersioned ? "public, max-age=31536000, immutable" : "no-cache"),
};

// ── アセットのキャッシュ破棄 ───────────────────────────────────────
// デプロイ(サーバ再起動)ごとに変わるバージョンを、index HTML 内の /shared/*.js,css
// 参照に注入する。これにより古い common.js 等がブラウザに残り続ける事故を根絶
// (例: TT.playerStatsSection is not a function)。
const ASSET_VER = Date.now().toString(36);
function _serveVersionedHtml(file) {
  return (req, res) => {
    fs.readFile(file, "utf8", (err, html) => {
      if (err) return res.status(404).type("html").send("<h1>not found</h1>");
      // js/css に加え、ほぼ不変のアイコン(svg/png/webp)・サブディレクトリ(/shared/assets/...)も版付与し
      // immutable 化に乗せる(毎回再検証の往復を消す)。href/src の ?v= 既存分は付け替える。
      const out = html.replace(/(\/shared\/[A-Za-z0-9_.\-/]+\.(?:js|css|svg|png|webp))(\?v=[^"']*)?/g, `$1?v=${ASSET_VER}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.send(out);
    });
  };
}
app.get(["/admin", "/admin/", "/admin/index.html"], _serveVersionedHtml(path.join(publicDir, "admin", "index.html")));
app.get(["/viewer", "/viewer/", "/viewer/index.html"], _serveVersionedHtml(path.join(publicDir, "viewer", "index.html")));
app.get(["/viewer/live", "/viewer/live/", "/viewer/live/index.html"], _serveVersionedHtml(path.join(publicDir, "viewer", "live", "index.html")));
app.get(["/widget", "/widget/", "/widget/index.html"], _serveVersionedHtml(path.join(publicDir, "widget", "index.html")));
app.get(["/ref", "/ref/", "/ref/index.html"], _serveVersionedHtml(path.join(publicDir, "ref", "index.html"))); // 審判結果入力 (限定トークン)

// ルートスコープ Service Worker(アプリ本体のオフラインキャッシュ・network-first)。
// scope "/" を効かせるため root から配信。SW自身は no-cache で更新を確実に伝播させる。
app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(publicDir, "sw.js"));
});

app.use("/shared", cacheMw, express.static(path.join(publicDir, "shared"), staticOpts));
app.use("/admin", cacheMw, express.static(path.join(publicDir, "admin"), staticOpts));
app.use("/viewer", cacheMw, express.static(path.join(publicDir, "viewer"), staticOpts));
app.use("/widget", cacheMw, express.static(path.join(publicDir, "widget"), staticOpts)); // Jimdo/STUDIO 埋込ウィジェット
app.use("/ref", cacheMw, express.static(path.join(publicDir, "ref"), staticOpts)); // 審判結果入力ページ

// 運用マニュアル (Markdown)
for (const docName of ["OPERATIONS.md", "RENDER_DEPLOY.md", "UPDATE_WORKFLOW.md", "HOSTING.md",
                       "ORACLE_CLOUD_DEPLOY.md", "ORACLE_BEGINNER.md", "CLOUDFLARE_SETUP.md"]) {
  app.get("/" + docName, (req, res) => {
    const f = path.join(__dirname, docName);
    if (!fs.existsSync(f)) return res.status(404).send("Not Found");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(f);
  });
}

// ── Phase4: 申込者本人の閲覧ページ /entry/status?token=… ───
// 申込番号(トークン)で自分の申込内容を確認する(閲覧のみ)。:id ルートより前に置く。
app.get("/entry/status", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // PII を表示するため第三者埋込を許さない(X-Frame-Options:SAMEORIGIN はミドルウェアが付与)。
  res.send(entryForm.buildApplicantStatusHTML());
});

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
    // 正規オリジン(appOriginOf)を使う。X-Forwarded-Host は信用しない(送信先のすり替え防止)。
    const selfUrl = `${appOriginOf(req)}/api/public/tournaments/${tournament.id}/submit-team-entry`;
    // 送信は常に同一オリジン(自サーバー)へ。GAS連携が設定されていても、ブラウザから
    // script.google.com へ直接POSTすると応答が CORS で読めず「送信エラー」を誤表示する
    // (実際は保存成功)。そのため submit-team-entry がサーバー側でGASへ中継する方式に統一。
    const postUrl = selfUrl;

    const html = entryForm.buildEntryFormHTML(tournament, events, {
      gas_url: postUrl,
      admin_email: req.query.admin_email || "",
      deadline: tournament.entry_deadline || req.query.deadline || "",
      payment_note: req.query.payment_note || "",
      notes: req.query.notes || "",
      turnstile_sitekey: process.env.TURNSTILE_SITEKEY || "",
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
app.get("*", _serveVersionedHtml(path.join(publicDir, "viewer", "index.html")));

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

// LAN内の他端末(運営2〜3台/大画面/観客)が本部ホストに接続するための IPv4 を列挙。
function lanIPv4s() {
  const out = [];
  const ns = os.networkInterfaces();
  for (const k in ns) for (const n of (ns[k] || [])) {
    if (n.family === "IPv4" && !n.internal) out.push(n.address);
  }
  return out;
}
const server = app.listen(PORT, () => {   // host未指定=0.0.0.0(全インターフェース)=LAN内の他端末から到達可能
  console.log(`\n🏓 卓球大会運営アプリ 起動中`);
  console.log(`   閲覧画面:  http://localhost:${PORT}/viewer`);
  console.log(`   管理画面:  http://localhost:${PORT}/admin`);
  console.log(`   API:       http://localhost:${PORT}/api/health`);
  const lan = lanIPv4s();
  if (lan.length) {
    console.log(`\n   ── 会場内の他端末(運営2〜3台/大画面)はこのPCのIPで接続 ──`);
    lan.forEach(ip => {
      console.log(`   本部運営: http://${ip}:${PORT}/admin   大画面: http://${ip}:${PORT}/viewer/live`);
    });
    console.log(`   ※ 同じローカルネットワーク(本PCのテザリング/モバイルルータ)に繋げば会場WiFi断でも動作します`);
  }
  if (ADMIN_KEY) console.log(`   ADMIN_KEY: 設定あり（管理API保護）`);
  // PII 保持期間: env PII_RETENTION_DAYS 指定時のみ、大会終了からN日超過の申込原本連絡先を起動時に匿名化。
  // 既定(未設定)は無効=既存挙動を変えない(自動データ破壊を避けるオプトイン)。
  if (process.env.PII_RETENTION_DAYS) {
    try {
      const r = db.purgeOldSubmissionPII(process.env.PII_RETENTION_DAYS);
      if (r && r.ok) console.log(`   PII purge: ${r.purged}件匿名化(${r.retention_days}日超過 / 〜${r.cutoff})`);
    } catch (e) { console.error("[PII purge] 失敗:", e.message); }
  }
  console.log("");
});
// 耐性: HTTPタイムアウト(keep-alive延長/slow-loris遮断) + graceful shutdown。
// SIGTERM(デプロイ時の systemctl restart 等)で新規受付を停止し在席を畳み、SSEを明示クローズして
// クライアントの自動再接続を促す。取りこぼし/中断を最小化する。
installServerHardening(server, {
  closeExtras: () => {
    for (const set of sseClients.values()) {
      for (const r of set) { try { r.end(); } catch (e) {} }
    }
  },
});

// 試合中の自動スナップショット: 進行中の大会がある時だけ定期バックアップ (既定7分)。
// データ消失リスクを「最大7分」に抑える。進行中でなければ何もしない (ノイズ防止)。
const SNAPSHOT_INTERVAL_MS = parseInt(process.env.SNAPSHOT_INTERVAL_MS) || 7 * 60 * 1000;
setInterval(() => {
  try {
    if (!db.hasOngoingTournament()) return;
    db.createSnapshot("auto").catch((e) =>
      console.error("[snapshot] 自動バックアップ失敗:", e.message));
  } catch (e) { /* 進行中判定の失敗は無視 */ }
}, SNAPSHOT_INTERVAL_MS).unref();

// クラウド公開ミラーへの自動同期(本部ローカルのみ・SYNC_CLOUD_URL 設定時)。
// インターネットが生きた間欠で、進行中/準備中の大会をクラウドへ push(失敗=オフラインは黙って次回再試行)。
if (SYNC_CLOUD_URL && SYNC_KEY) {
  setInterval(async () => {
    try {
      const active = (db.getTournaments() || []).filter(t => t.status === "ongoing" || t.status === "preparation");
      for (const t of active) { await pushTournamentToCloud(t.id); }
    } catch (e) { /* オフライン等は無視(次回再試行) */ }
  }, 3 * 60 * 1000).unref();
  console.log(`   クラウド同期: 有効(${SYNC_CLOUD_URL.replace(/^https?:\/\//, "")} へ進行中大会を自動push)`);
}
