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
const { moveFile } = require("./lib/move-file");
const { isConfirmedEntry, summarizeEntries } = require("./lib/entry-summary");
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
const appMode = require("./app-mode");
const QRCode = require("qrcode");     // ローカルQR生成(会場オフラインで外部QRサービスに依存しないLAN接続案内用)
const db = require("./db");
const { MAX_OWNER_ACCOUNTS, PASSWORD_MIN, normalizeName, validName, normalizeEmail, validEmail, validPassword, boundedPassword } = require("./lib/operator-accounts");
const reports = require("./reports");
const entryWorkbook = require("./lib/entry-workbook");
const importQuality = require("./tools/import_quality");   // 取込プレビューの品質警告(notices)を全経路へ後付け
const rosterReader = require("./tools/roster_reader");       // ブック内の名簿と突合し取りこぼし/過大/表記揺れを検出
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
  // 秘密鍵は env 注入を優先(本番は /etc/ktta.env 600 に置きDBへ平文保存しない / #17)。
  // env 未設定時のみ従来どおり DB(app_kv) に自動生成・保存(開発/standalone の利便性維持)。
  // env は all-or-nothing: 片方だけだと env公開鍵 × DB秘密鍵の不一致ペアで push が無言で署名失敗するため、
  // 両方そろった時のみ env を採用し、片方のみなら警告して DB/自動生成にフォールバックする。
  const envPub = process.env.VAPID_PUBLIC_KEY, envPriv = process.env.VAPID_PRIVATE_KEY;
  const useEnv = !!(envPub && envPriv);
  if ((envPub || envPriv) && !useEnv)
    console.warn("[push] VAPID_PUBLIC_KEY と VAPID_PRIVATE_KEY は両方設定が必要です。片方のみのため env を無視し DB/自動生成にフォールバックします (#17)。");
  let pub = useEnv ? envPub : db.kvGet("vapid_public");
  let priv = useEnv ? envPriv : db.kvGet("vapid_private");
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

// 購読 endpoint の宛先検証 (#8 SSRF対策): web-push はサーバから endpoint へ POST するため、
// 内部ホスト/生IP/非HTTPS を弾き、既知のプッシュプロバイダ host のみ許可する。
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com", "android.googleapis.com",          // Chrome / FCM
  "push.services.mozilla.com",                              // Firefox
  "notify.windows.com", "wns.windows.com",                  // Edge / Windows
  "push.apple.com",                                         // Safari (web.push.apple.com 等)
];
function isAllowedPushEndpoint(ep) {
  let u; try { u = new URL(String(ep || "")); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;   // 生IP(プッシュは常にFQDN)=内部宛SSRF拒否
  return PUSH_HOST_SUFFIXES.some(s => host === s || host.endsWith("." + s));
}

// 指定選手の全購読端末へ通知を送信 (失効した購読は削除)
async function sendPushToPlayer(playerId, payload) {
  if (!PUSH_ENABLED || !playerId) return 0;
  const subs = db.getPushSubscriptionsForPlayer(playerId);
  if (!subs.length) return 0;
  const body = JSON.stringify(payload);
  let sent = 0;
  // timeout 付き(プッシュサービス無応答で一括送信が固着しないように)。実際に成功した端末数のみ数える。
  await Promise.all(subs.map(async ({ endpoint, sub }) => {
    try {
      await webpush.sendNotification(sub, body, { timeout: 8000 });
      sent++;
    } catch (err) {
      // 410 Gone / 404 → 購読失効。DBから削除。
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        db.deletePushSubscription(endpoint);
      }
    }
  }));
  return sent;   // 試行数ではなく成功数(管理UIの「N台へ送信」が実態と一致)
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

// DBファイル(.db / .db.gz)アップロード復元 専用 (オーナー権限・DR用)。通常アップロードとは別枠で、
// SQLite/gzip のみ許可・容量を大きめに。検証は db.restoreFromUpload が厳格に行う。
const uploadDb = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const gz = /\.gz$/i.test(file.originalname || "");
      cb(null, "restore_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + (gz ? ".db.gz" : ".db"));
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const n = (file.originalname || "").toLowerCase();
    if (/\.(db|sqlite)(\.gz)?$/.test(n)) return cb(null, true);
    cb(new Error(".db または .db.gz をアップロードしてください"));
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
// 受信側(クラウド)の送信元IP allowlist(任意)。設定時はこのIPからのみ /api/sync/push を受理 (#3)。
const SYNC_ALLOW_IPS = (process.env.SYNC_ALLOW_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
if (SYNC_KEY && SYNC_KEY.length < 32)
  console.warn("[sync] SYNC_KEY が短い(<32文字)です。十分な長さのランダム値を推奨します (#3)。");
// /api/sync/push の鍵総当たり対策: per-IP の連続失敗で一時ブロック (#3)。
const _syncFail = new Map(); // ip -> { count, resetAt }
const SYNC_FAIL_MAX = 10, SYNC_FAIL_WINDOW = 5 * 60000;
setInterval(() => { const now = Date.now(); for (const [ip, e] of _syncFail) if (now > e.resetAt) _syncFail.delete(ip); }, SYNC_FAIL_WINDOW).unref();
function syncFailBlocked(ip) { const e = _syncFail.get(ip); return !!(e && Date.now() <= e.resetAt && e.count >= SYNC_FAIL_MAX); }
function syncFailMark(ip) { const now = Date.now(), e = _syncFail.get(ip); if (!e || now > e.resetAt) _syncFail.set(ip, { count: 1, resetAt: now + SYNC_FAIL_WINDOW }); else e.count++; }
const _syncState = { last_ok_at: null, last_error: null, last_count: 0 };
async function pushTournamentToCloud(tid) {
  if (!SYNC_CLOUD_URL || !SYNC_KEY) return { error: "クラウド同期が未設定です(SYNC_CLOUD_URL / SYNC_KEY)" };
  // 本番は平文HTTPでの同期を拒否(SYNC_KEY と公開スナップショットの平文流出を遮断 / #2)。
  if (process.env.NODE_ENV === "production" && !/^https:\/\//i.test(SYNC_CLOUD_URL))
    return { error: "クラウドURLはHTTPSが必要です(平文同期は不可)" };
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
// ブラウザはCookieセッションのみ使う。旧X-Admin-Key等は開発・自動テストの互換経路としてだけ残し、
// 本番では明示的にALLOW_LEGACY_KEY_HEADERS=1を設定しない限り受け付けない。
const ALLOW_LEGACY_KEY_HEADERS = !IS_PROD || process.env.ALLOW_LEGACY_KEY_HEADERS === "1";

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

// ── 国外アクセス遮断 (任意・env で有効化。サイト全体に適用) ──
// Cloudflare が付与する CF-IPCountry を見て、許可国(GEO_ALLOW_COUNTRIES)以外を 403 で拒否する。
// 本来の主防御は「Cloudflareで国ブロック + オリジンをCloudflare限定」。本ミドルウェアは保険(直叩き/設定漏れ対策)。
//   GEO_ALLOW_COUNTRIES=JP            許可国(カンマ区切り。未設定なら本機能は無効=従来どおり)
//   GEO_ALLOW_IPS=1.2.3.4,...         国に関わらず常に許可するIP(運営PC・会場の固定IP等)
//   GEO_REQUIRE_COUNTRY_HEADER=1      CF-IPCountry が無いリクエストも拒否(完全にCF配下の本番向け。既定は通す)
// 既定で通すもの: /api/health(監視) と /api/sync/*(本部→クラウドのサーバ間同期。SYNC_KEY/IP制限で別途保護)。
// 本部のローカル/standalone は Cloudflare 非経由=CF-IPCountry 無し→既定で通る(GEO_STRICT を立てない限り)。
const GEO_ALLOW_COUNTRIES = (process.env.GEO_ALLOW_COUNTRIES || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const GEO_ALLOW_IPS = (process.env.GEO_ALLOW_IPS || "").split(",").map(s => s.trim()).filter(Boolean);
const GEO_STRICT = process.env.GEO_REQUIRE_COUNTRY_HEADER === "1";
function geoDeny(res) {
  return res.status(403).type("text/html; charset=utf-8").send(
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>アクセスできません</title></head><body style="font-family:-apple-system,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;color:#334155;line-height:1.7">' +
    '<h1 style="font-size:20px;color:#0f172a">このサイトは日本国内からのみご利用いただけます</h1>' +
    '<p>釧路卓球協会の大会運営システムは、日本国内からのアクセスに限定しています。</p>' +
    '<p style="color:#64748b;font-size:14px">This site is available from within Japan only.</p></body></html>');
}
if (GEO_ALLOW_COUNTRIES.length) {
  app.use((req, res, next) => {
    if (req.path === "/api/health" || req.path.startsWith("/api/sync/")) return next();
    if (GEO_ALLOW_IPS.length && GEO_ALLOW_IPS.includes(clientIp(req))) return next();
    const cc = (req.get("cf-ipcountry") || "").toUpperCase();
    if (!cc) return GEO_STRICT ? geoDeny(res) : next();   // 判定ヘッダ無し: 既定は通す(オリジン限定が本来の対策)
    if (GEO_ALLOW_COUNTRIES.includes(cc)) return next();
    return geoDeny(res);
  });
  console.log("[geo] 国外アクセス遮断 有効: 許可国=" + GEO_ALLOW_COUNTRIES.join(",") +
    (GEO_ALLOW_IPS.length ? " 許可IP=" + GEO_ALLOW_IPS.length + "件" : "") + (GEO_STRICT ? " (ヘッダ無しも拒否)" : ""));
}

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

// CORS: 認証Cookieを使うAPIを任意オリジンへ開放しない。外部埋込は画面だけを使い、
// データ要求は同一オリジンのサーバー経由に限定する。
const CORS_ALLOW_ORIGINS = new Set(
  (process.env.CORS_ALLOW_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)
);
app.use((req, res, next) => {
  const origin = req.get("Origin") || "";
  if (origin && CORS_ALLOW_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Op-Id");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") return origin && CORS_ALLOW_ORIGINS.has(origin) ? res.sendStatus(204) : res.sendStatus(403);
  next();
});

// セキュリティヘッダ (依存追加なしの簡易 helmet 相当)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  // 検索エンジン索引を全面禁止 (#271): 参加者(未成年含む)の氏名・所属が
  // 検索結果から「思わぬところ」で閲覧される事故を防ぐ。robots.txt と二重で抑止。
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // 他のサイトへの iframe 埋込は、どのページも許さない(クリックジャッキング対策)。
  // Content-Security-Policy: 既知の外部リソース(Googleフォント / QR生成画像)だけ許可し他を遮断。
  // インラインscript/styleはアプリ構造上 'unsafe-inline' が必要だが、外部scriptの注入・
  // connect でのデータ持ち出し・object/base は塞ぐ(XSS時の被害を限定)。
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; "));
  // 旧ブラウザ向けクリックジャッキング対策フォールバック
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
function auditResource(req) {
  const p = String(req.path || "");
  const m = p.match(/^\/api\/(?:public\/)?(tournaments|players|matches|entrants|applicant|coach|submissions)(?:\/([^/]+))?/);
  return m ? { type: m[1], id: String(m[2] || "").slice(0, 128) } : { type: "api", id: "" };
}
function auditRoute(req) {
  const route = req.route && req.route.path;
  return String(route || req.path || "").replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{20,}|\d{4,}|[A-Za-z0-9_-]{16,})(?=\/|$)/gi, "/:id").slice(0, 200);
}
function recordError(err, req, res, statusCode) {
  // 例外文やスタックには入力値・外部応答が含まれ得るため保存しない。診断には経路、
  // HTTP状態、例外種別だけで十分であり、個人情報を運用ログへ二次保存しない。
  const errorType = String((err && (err.code || err.name)) || "Error")
    .replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error";
  const entry = {
    time: new Date().toISOString(),
    method: (req && req.method) || "",
    url: (req && req.path) || "",
    status: statusCode || 500,
    error_type: errorType,
  };
  DIAG.errors.unshift(entry);
  if (DIAG.errors.length > DIAG.maxErrors) DIAG.errors.length = DIAG.maxErrors;
  DIAG.errorCount++;
  console.error("[ERR]", entry.method, entry.url, entry.status, entry.error_type);
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
      url: (req.path || "").slice(0, 200),
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
    // 監査は正規化済みpathとIDだけを記録する。クエリ・本文・Cookie・認証情報は絶対に残さない。
    if ((req.path || "").startsWith("/api/") && !["/api/health", "/api/diagnostics"].includes(req.path || "")) {
      const actor = req.auth || { principal_type: "anonymous", principal_id: "" };
      const resource = auditResource(req);
      db.logAccessAudit({
        principal_type: actor.principal_type,
        principal_id: actor.principal_id,
        action: ["GET", "HEAD"].includes(req.method) ? "read" : "write",
        resource_type: resource.type,
        resource_id: resource.id,
        method: req.method,
        route: auditRoute(req),
        status: res.statusCode,
      });
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

// ── サーバー側セッション ───────────────────────────────────────────
// ブラウザへは HttpOnly / Secure / SameSite Cookie だけを渡す。管理鍵・監督コード・
// 申込番号・本人確認コードそのものを localStorage / sessionStorage / URL に残さない。
const SESSION_COOKIE = "ktta_session";
function cookieValue(req, key) {
  const raw = String(req.get("cookie") || "");
  for (const item of raw.split(";")) {
    const i = item.indexOf("=");
    if (i < 0) continue;
    if (item.slice(0, i).trim() === key) {
      try { return decodeURIComponent(item.slice(i + 1).trim()); } catch (_) { return ""; }
    }
  }
  return "";
}
function sessionOf(req) {
  if (req.kttaSession !== undefined) return req.kttaSession;
  const token = cookieValue(req, SESSION_COOKIE);
  let s = db.getAuthSession(token) || db.operatorAccounts.session(token);
  // オーナー権限を付けた運営アカウントも、サーバーに OWNER_KEY が無い間は運営権限に留める(フェイルクローズ)。
  if (s && s.kind === "account" && s.principal_type === "owner" && !OWNER_KEY) s = { ...s, principal_type: "admin" };
  req.kttaSession = s;
  return req.kttaSession;
}
function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    path: "/",
    expires: new Date(expiresAt),
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: IS_PROD, sameSite: "strict", path: "/" });
}
function setPrincipal(req, type, id, scope) {
  req.auth = { principal_type: type, principal_id: String(id || ""), scope: scope || {} };
  return req.auth;
}
function sessionHas(req, ...types) {
  const s = sessionOf(req);
  if (!s || !types.includes(s.principal_type)) return false;
  setPrincipal(req, s.principal_type, s.principal_id, s.scope);
  return true;
}
function requireSameOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("Origin");
  // 通常の同一オリジンfetchはOriginを送る。非ブラウザ内部連携はCookieを持たないためここを通らない。
  if (!origin || origin !== appOriginOf(req)) return res.status(403).json({ error: "この操作は同一サイトからのみ実行できます" });
  next();
}
function requireSession(types) {
  return (req, res, next) => {
    if (!sessionHas(req, ...types)) return res.status(401).json({ error: "ログインが必要です" });
    return requireSameOrigin(req, res, next);
  };
}
// 管理APIはサーバー側Cookieセッションだけで保護する。旧ヘッダ鍵は開発・自動テスト以外では閉じる。
function requireAdmin(req, res, next) {
  if (sessionHas(req, "admin", "owner")) return requireSameOrigin(req, res, next);
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
  const key = ALLOW_LEGACY_KEY_HEADERS ? req.get("X-Admin-Key") : "";
  if (key && safeEqualStr(key, ADMIN_KEY)) { setPrincipal(req, "admin", "server-key"); return next(); }
  res.status(401).json({ error: "管理キーが必要です" });
}

// requireAdmin と同じ判定の真偽値版。リクエストは拒否せず「秘密フィールドを返すか」の出し分けに使う。
function isAdminAuthed(req) {
  if (sessionHas(req, "admin", "owner")) return true;
  if (!ADMIN_KEY) return !IS_PROD;            // 開発時のみ許可 / 本番でキー未設定はフェイルクローズ
  const key = ALLOW_LEGACY_KEY_HEADERS ? req.get("X-Admin-Key") : "";
  if (key && safeEqualStr(key, ADMIN_KEY)) { setPrincipal(req, "admin", "server-key"); return true; }
  return false;
}

// ── オーナー権限 (管理キーの更に上の「上級管理者」) ──
// 全選手削除・DB全体の保存(.dbダウンロード)・バックアップ/復元・全データエクスポート・PII一括削除・大会削除など、
// 取り返しのつかない/全件PIIを動かす操作を、普段使いの ADMIN_KEY から分離した別キー OWNER_KEY の背後に隔離する。
// フェイルクローズ: OWNER_KEY 未設定なら上級機能は一切使えない(管理キーにフォールバックしない=既存環境を勝手に露出しない)。
const OWNER_KEY = process.env.OWNER_KEY || "";
// オーナー鍵は最重要(漏れると全PII持ち出し/全削除が可能)。per-IP の連続失敗で一時ブロック。
const _ownerFail = new Map(); // ip -> { count, resetAt }
const OWNER_FAIL_MAX = 8, OWNER_FAIL_WINDOW = 10 * 60000;
setInterval(() => { const now = Date.now(); for (const [ip, e] of _ownerFail) if (now > e.resetAt) _ownerFail.delete(ip); }, OWNER_FAIL_WINDOW).unref();
function ownerBlocked(ip) { const e = _ownerFail.get(ip); return !!(e && Date.now() <= e.resetAt && e.count >= OWNER_FAIL_MAX); }
function ownerFailMark(ip) { const now = Date.now(), e = _ownerFail.get(ip); if (!e || now > e.resetAt) _ownerFail.set(ip, { count: 1, resetAt: now + OWNER_FAIL_WINDOW }); else e.count++; }
function ownerOk(ip) { _ownerFail.delete(ip); }
// 全選手削除など「全消し」系はオーナーキーの実設定を必須にする(未設定でも管理キーに落ちない)。
function requireOwnerStrict(req, res, next) {
  if (!OWNER_KEY) {
    return res.status(403).json({ error: "この操作にはオーナーキー(OWNER_KEY)の設定が必要です。サーバ環境変数 OWNER_KEY を設定し、「システム管理（オーナー）」ページから実行してください。" });
  }
  return requireOwner(req, res, next);
}
function requireOwner(req, res, next) {
  if (sessionHas(req, "owner")) return requireSameOrigin(req, res, next);
  const ip = clientIp(req);
  if (ownerBlocked(ip)) return res.status(429).json({ error: "試行回数が多すぎます。しばらく待ってから再試行してください。" });
  if (OWNER_KEY) {
    // 分離が有効: オーナーキー必須(管理キーだけでは通らない)。
    const key = ALLOW_LEGACY_KEY_HEADERS ? (req.get("X-Owner-Key") || (req.body && req.body.owner_key) || "") : "";
    if (key && safeEqualStr(key, OWNER_KEY)) { ownerOk(ip); setPrincipal(req, "owner", "server-key"); return next(); }
    ownerFailMark(ip);
    return res.status(401).json({ error: "オーナーキーが必要です" });
  }
  // 本番はOWNER_KEY無しでの管理キー代替を禁止する。全件データや復元機能を通常管理者へ落とさない。
  if (IS_PROD) return res.status(503).json({ error: "上級管理機能にはサーバー環境変数 OWNER_KEY が必要です" });
  // 開発環境だけ既存テストのために管理キーへフォールバックする。
  return requireAdmin(req, res, next);
}
const PASSWORD_RULE_MESSAGE = "パスワードは" + PASSWORD_MIN + "文字以上で、英字・数字・記号(! # $ % など)をそれぞれ1つ以上入れてください(128文字以内)";
// 招待・再設定メールに載せる管理画面のURL。本番は PUBLIC_BASE_URL(HTTPS・パスなし)だけを使う(Hostヘッダを信用しない)。
function operatorLinkBase(req) {
  const configured = (process.env.PUBLIC_BASE_URL || "").trim();
  try {
    const url = new URL(IS_PROD ? configured : appOriginOf(req));
    if (IS_PROD && (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)) return null;
    return url;
  } catch { return null; }
}
// オーナーキーを入力した本人か(オーナー権限を付けた運営アカウントではないか)。
// 権限の付与・剥奪はキー保持者だけにする。付与されたアカウントが別アカウントへ権限を広げられないようにするため。
function isOwnerKeyHolder(req) {
  const s = sessionOf(req);
  if (s) return s.principal_type === "owner" && s.kind !== "account";
  return !!(req.auth && req.auth.principal_type === "owner" && req.auth.principal_id === "server-key");
}
function requireOwnerKeyHolder(req, res, next) {
  if (!isOwnerKeyHolder(req)) return res.status(403).json({ error: "この操作はオーナーキーで入った画面からだけ行えます" });
  next();
}
// オーナー操作の実行者名(自由記入・日本語可)を取り出す。監査ログ用。
// HTTPヘッダは latin1 のみ(日本語不可)なので、ヘッダは encodeURIComponent 済みとして decode する。
// JSONボディ(operator)は UTF-8 をそのまま運べるため、POST はボディを優先。
function ownerOperator(req) {
  if (req.auth && req.auth.principal_type === "owner" && req.auth.principal_id) return String(req.auth.principal_id).slice(0, 80);
  if (req.body && req.body.operator) return String(req.body.operator).slice(0, 80);
  let op = req.get("X-Owner-Operator") || "";
  try { op = decodeURIComponent(op); } catch (e) { /* 不正な%列はそのまま */ }
  return String(op).slice(0, 80);
}
// オーナー操作を監査ログに記録するヘルパ。
function auditOwner(req, action, detail) {
  try { db.logOwnerAction({ action, operator: ownerAuditCode(req) }); } catch (e) {}
}
function validOperatorCode(value) {
  const code = String(value || "").trim();
  return /^[A-Za-z0-9_-]{3,32}$/.test(code) ? code : "";
}
// 監査の「誰」は氏名ではなく担当コードだけを保存する。旧ヘッダ鍵の server-key は実施者ではない。
function ownerAuditCode(req) {
  // メールのアカウントで入った人は、本文の担当コードで別人を名乗れないようアカウントのコードに固定する
  const s = sessionOf(req);
  if (s && s.kind === "account") return validOperatorCode(accountAuditCode(s.principal_id));
  const bodyCode = validOperatorCode(req.body && req.body.operator);
  if (bodyCode) return bodyCode;
  if (req.auth && req.auth.principal_type === "owner" && req.auth.principal_id !== "server-key") {
    return validOperatorCode(accountAuditCode(req.auth.principal_id));
  }
  return "";
}
// メールのアカウントは内部ID(UUID)の先頭8文字を担当コードにする(メールアドレスは監査に残さない)
function accountAuditCode(id) {
  id = String(id || "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? "acct-" + id.slice(0, 8) : id;
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
// 開発・合成テストだけは環境変数で明示的に公開を許可できる。本番既定は常に非公開。
const PUBLIC_VIEW_DEFAULT = !IS_PROD && process.env.PUBLIC_VIEW_DEFAULT === "1";
function isPublicTournament(tournament) {
  return !!tournament && (Number(tournament.public_view_enabled) === 1 || PUBLIC_VIEW_DEFAULT);
}
function requirePublicTournament(req, res, next) {
  const tournament = db.getTournamentMeta(req.params.id);
  if (!isPublicTournament(tournament)) {
    // 非公開大会と存在しない大会を同じ応答にしてID列挙を防ぐ。
    return res.status(404).json({ error: "公開されている大会が見つかりません" });
  }
  req.publicTournament = tournament;
  return next();
}

// 受付を明示的に開始した大会だけ申込フォームを公開する。管理者は受付前のプレビューを
// 継続できるが、第三者が大会IDを推測して受付設定・種目・会場を読むことは許可しない。
function requireOpenEntryOrAdmin(req, res, next) {
  const tournament = db.getTournament(req.params.id);
  if (!tournament || (!tournament.entries_open && !isAdminAuthed(req))) {
    return res.status(404).json({ error: "公開されている申込フォームが見つかりません" });
  }
  req.entryTournament = tournament;
  return next();
}

// 審判結果入力 用ミドルウェア (管理キーとは別の限定トークン)。
// X-Referee-Token ヘッダ or ?t= or body.t で受け取り、有効な大会に解決できれば通す。
// 解決できない=トークン無効/審判入力OFF/失効 → 403。req.refTournament に大会を載せる。
function requireReferee(req, res, next) {
  // URL能力トークンは初回の /api/ref/session 交換だけに使う。以後はHttpOnly Cookieの
  // スコープ(大会・コート)を優先し、ブラウザ履歴やオフラインキューへトークンを残さない。
  const session = sessionOf(req);
  if (session && session.principal_type === "referee" && session.scope && session.scope.tournament_id) {
    const t = db.getTournament(session.scope.tournament_id);
    if (t) {
      setPrincipal(req, "referee", session.principal_id, session.scope);
      req.refTournament = t;
      req.refCourt = session.scope.court == null ? null : Number(session.scope.court);
      return next();
    }
  }
  // 本番で能力トークンを受け付けるのはCookie交換の一度だけ。結果入力APIへ
  // ?t=... を直接付けても通さず、履歴・Referer・オフラインキューへの漏えいを防ぐ。
  if (IS_PROD && req.path !== "/api/ref/session") {
    return res.status(401).json({ error: "審判セッションが必要です。審判用リンクを開き直してください。" });
  }
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
function rateLimit({ windowMs = 60000, max = 20, message = "リクエストが多すぎます。しばらく待って再試行してください。", keyFor = clientIp } = {}) {
  const hits = new Map();
  // 定期的に古いエントリを掃除 (メモリリーク防止)
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, arr] of hits) {
      const fresh = arr.filter(t => t > cutoff);
      if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const key = keyFor(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const arr = (hits.get(key) || []).filter(t => t > cutoff);
    if (arr.length >= max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: message });
    }
    arr.push(now);
    hits.set(key, arr);
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

// ── 認証情報のCookie交換 ──────────────────────────────────────────
// 入力された鍵/コードは照合だけに使い、レスポンス・DB・監査ログ・ブラウザストレージへ残さない。
function createBrowserSession(req, res, principalType, principalId, scope, ttlSeconds) {
  const made = db.createAuthSession({ principal_type: principalType, principal_id: principalId, scope, ttl_seconds: ttlSeconds });
  if (made.error) return null;
  setSessionCookie(res, made.token, made.expires_at);
  setPrincipal(req, principalType, principalId, scope);
  return made;
}
function plainActor(value, fallback) {
  // 監査主体は氏名ではなく運営が発行する担当コードだけを許可する。
  // これにより「誰の操作か」を追える一方、監査DBに個人情報を蓄積しない。
  const s = String(value || "").trim().slice(0, 32);
  return /^[A-Za-z0-9_-]{3,32}$/.test(s) ? s : fallback;
}
// 申込集計モード: 残す入口以外を閉じる。認証より前で判定し、誰が来ても同じ応答にする。
function currentAppMode() { return appMode.resolveMode(process.env.KTTA_APP_MODE, db.kvGet(appMode.KV_KEY)); }
const ENTRY_LANDING = "/entry";
app.use((req, res, next) => {
  if (currentAppMode() !== "entry") return next();
  // Express の経路は大文字小文字を区別しないので、ゲート側も区別しない(/API/... のすり抜け防止)
  if (/^\/api\//i.test(req.path)) {
    if (appMode.isApiAllowedInEntryMode(req.method, req.path)) return next();
    return res.status(404).json({ error: "この機能は、申込集計モードの間は使えません", app_mode: "entry" });
  }
  if ((req.method === "GET" || req.method === "HEAD") && appMode.isHiddenPageInEntryMode(req.path)) {
    return res.redirect(302, ENTRY_LANDING);
  }
  next();
});

app.get("/api/app-mode", (req, res) => {
  res.json({ mode: currentAppMode(), locked: appMode.MODES.includes(process.env.KTTA_APP_MODE) });
});

app.get("/api/auth/session", (req, res) => {
  res.set("Cache-Control", "no-store");
  const s = sessionOf(req);
  if (!s) return res.json({ authenticated: false });
  // kind: account=メールで入った運営アカウント / key=管理キー・オーナーの鍵で入ったセッション
  // label: 画面右上に出す名前(アカウントは氏名、未登録ならメールアドレス。鍵は操作担当コード)
  const kind = s.kind === "account" ? "account" : "key";
  const label = kind === "account" ? String(s.name || s.email || "") : String(s.principal_id || "");
  res.json({ authenticated: true, principal_type: s.principal_type, principal_id: s.principal_id, expires_at: s.expires_at, kind, label: label.slice(0, 120) });
});
app.delete("/api/auth/session", requireSession(["admin", "owner", "coach", "applicant", "player", "referee"]), (req, res) => {
  const token = cookieValue(req, SESSION_COOKIE);
  if (sessionOf(req).id) db.destroyAuthSession(token);
  else db.operatorAccounts.logout(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});
app.post("/api/auth/admin/session", rateLimit({ windowMs: 60000, max: 8, message: "試行回数が多すぎます。しばらく待ってください。" }), (req, res) => {
  const key = String((req.body || {}).key || "");
  if (!ADMIN_KEY || !safeEqualStr(key, ADMIN_KEY)) return res.status(401).json({ error: "管理キーが正しくありません" });
  const actor = plainActor((req.body || {}).operator, "admin");
  createBrowserSession(req, res, "admin", actor, {}, 60 * 60 * 8);
  res.json({ ok: true, principal_type: "admin", principal_id: actor });
});

const operatorLoginLimit = rateLimit({ windowMs: 60_000, max: 8 });
const operatorEmailLimit = rateLimit({ windowMs: 5 * 60_000, max: 15, keyFor: req =>
  crypto.createHash("sha256").update(normalizeEmail(req.body?.email).slice(0, 254)).digest("hex") });
app.post("/api/auth/admin/password", requireSameOrigin, operatorLoginLimit, operatorEmailLimit, async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const { email, password } = req.body || {};
  const address = normalizeEmail(email);
  const denied = () => res.status(401).json({ error: "メールアドレスまたはパスワードを確認してください" });
  if (!validEmail(address) || !boundedPassword(password) || !password) return denied();
  try {
    const login = await db.operatorAccounts.login(address, password);
    if (login.busy) return res.status(429).json({ error: "時間をおいて、もう一度お試しください" });
    if (!login.id) return denied();
    const previous = cookieValue(req, SESSION_COOKIE);
    if (previous) {
      if (sessionOf(req)?.id) db.destroyAuthSession(previous);
      else db.operatorAccounts.logout(previous);
    }
    setSessionCookie(res, login.token, login.expires_at);
    setPrincipal(req, "admin", login.id);
    res.json({ ok: true, principal_type: "admin", principal_id: login.id });
  } catch (error) { next(error); }
});
// パスワードを忘れた本人が、登録メールアドレス宛てに再設定リンクを受け取る。オーナーの操作は要らない。
// 登録の有無を推測させないため、形式が正しいアドレスには常に同じ応答をすぐ返し、送信は応答の後に行う。
const operatorResetIpLimit = rateLimit({ windowMs: 15 * 60_000, max: 5 });
const operatorResetEmailLimit = rateLimit({ windowMs: 60 * 60_000, max: 3, keyFor: req =>
  "reset:" + crypto.createHash("sha256").update(normalizeEmail(req.body?.email).slice(0, 254)).digest("hex") });
app.post("/api/auth/admin/password-reset", requireSameOrigin, operatorResetIpLimit, operatorResetEmailLimit, (req, res) => {
  res.set("Cache-Control", "no-store");
  const email = normalizeEmail(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ error: "メールアドレスを確認してください" });
  const base = operatorLinkBase(req);
  if (!base || !mailer.isEnabled()) return res.status(503).json({ error: "いまは再設定メールを送れません。オーナーにご連絡ください" });
  res.json({ ok: true, message: "登録されているアドレスであれば、再設定のメールを送りました。届かない場合はオーナーにご連絡ください。" });
  const reset = db.operatorAccounts.issueReset(email);
  if (!reset) return;
  const link = new URL("/admin/", base);
  link.hash = "operator-reset=" + reset.token;
  mailer.sendOperatorReset(email, link.href).then(
    () => db.logOwnerAction({ action: "運営アカウント:パスワード再設定メール " + accountAuditCode(reset.id) }),
    () => db.operatorAccounts.cancelInvite(reset.token));
});
app.post("/api/auth/admin/activate", requireSameOrigin, rateLimit({ max: 8 }), async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const { token, password } = req.body || {};
  const name = normalizeName((req.body || {}).name);
  if (name && !validName(name)) return res.status(400).json({ error: "氏名は40文字以内で入力してください" });
  if (!validPassword(password)) return res.status(400).json({ error: PASSWORD_RULE_MESSAGE });
  try {
    const result = await db.operatorAccounts.accept(token, password, name);
    if (result.needName) return res.status(400).json({ error: "氏名を入力してください" });
    if (result.busy) return res.status(429).json({ error: "時間をおいて、もう一度お試しください" });
    if (!result.id) return res.status(400).json({ error: "設定リンクが無効です。オーナーに再発行を依頼してください" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/api/owner/operators", requireOwnerStrict, (req, res) => {
  // can_grant: 画面がオーナー権限の付与ボタンを出すかの判断材料(ページ表示後にキーを入れた場合もここで正しく分かる)
  res.set("Cache-Control", "no-store").json({ accounts: db.operatorAccounts.list(), can_grant: isOwnerKeyHolder(req) });
});
app.post("/api/owner/operators/invite", requireSameOrigin, requireOwnerStrict, rateLimit({ max: 6 }), async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const email = normalizeEmail(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ error: "有効なメールアドレスを入力してください" });
  const url = operatorLinkBase(req);
  if (!url) return res.status(503).json({ error: "招待に使う管理画面のHTTPS URLが未設定です" });
  if (!mailer.isEnabled()) return res.status(503).json({ error: "招待メールの送信設定が必要です" });
  try {
    const invite = db.operatorAccounts.issue(email);
    try {
      const link = new URL("/admin/", url);
      link.hash = "operator-invite=" + invite.token;
      await mailer.sendOperatorInvite(email, link.href);
    } catch {
      db.operatorAccounts.cancelInvite(invite.token);
      return res.status(502).json({ error: "メールを送信できませんでした。送信設定を確認して再発行してください" });
    }
    auditOwner(req, "運営アカウント:招待メール");
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});
app.post("/api/owner/operators/:id/disable", requireSameOrigin, requireOwnerStrict, (req, res) => {
  res.set("Cache-Control", "no-store");
  // オーナー権限を持つアカウントの停止はキー保持者だけ(付与されたアカウント同士で締め出し合わない)
  if (db.operatorAccounts.isOwner(req.params.id) && !isOwnerKeyHolder(req)) {
    return res.status(403).json({ error: "オーナー権限のあるアカウントは、オーナーキーで入った画面からだけ停止できます" });
  }
  if (!db.operatorAccounts.disable(req.params.id)) return res.status(404).json({ error: "アカウントが見つかりません" });
  auditOwner(req, "運営アカウント:停止 " + accountAuditCode(req.params.id));
  res.json({ ok: true });
});
// 運営アカウントの氏名の登録・修正(右上の「ログイン中」表示に使う)。空欄で未登録に戻す。
app.post("/api/owner/operators/:id/name", requireSameOrigin, requireOwnerStrict, (req, res) => {
  res.set("Cache-Control", "no-store");
  const name = String((req.body || {}).name == null ? "" : (req.body || {}).name).trim();
  const r = db.operatorAccounts.setName(req.params.id, name);
  if (r.error === "not_found") return res.status(404).json({ error: "アカウントが見つかりません" });
  if (r.error) return res.status(400).json({ error: "氏名は40文字までで入力してください" });
  auditOwner(req, "運営アカウント:氏名を" + (r.name ? "登録 " : "未登録に戻す ") + accountAuditCode(req.params.id));
  res.json({ ok: true, name: r.name });
});
// 運営アカウントへのオーナー権限の付与・剥奪。オーナーキー保持者だけ・上限つき・監査ログに記録。
app.post("/api/owner/operators/:id/owner", requireSameOrigin, requireOwnerStrict, requireOwnerKeyHolder, (req, res) => {
  res.set("Cache-Control", "no-store");
  const granted = (req.body || {}).granted;
  if (typeof granted !== "boolean") return res.status(400).json({ error: "付与するか外すかを指定してください" });
  const result = db.operatorAccounts.setOwner(req.params.id, granted);
  if (result.error === "not_found") return res.status(404).json({ error: "アカウントが見つかりません" });
  if (result.error === "not_active") return res.status(409).json({ error: "パスワード設定済みで利用中のアカウントにだけ付けられます" });
  if (result.error === "limit") return res.status(409).json({ error: "オーナー権限を付けられるのは " + MAX_OWNER_ACCOUNTS + " アカウントまでです。先にほかのアカウントから外してください" });
  if (result.changed) auditOwner(req, (granted ? "運営アカウント:オーナー権限を付与 " : "運営アカウント:オーナー権限を解除 ") + accountAuditCode(req.params.id));
  res.json({ ok: true, owner: granted });
});

app.post("/api/auth/owner/session", rateLimit({ windowMs: 60000, max: 8, message: "試行回数が多すぎます。しばらく待ってください。" }), (req, res) => {
  const key = String((req.body || {}).key || "");
  if (!OWNER_KEY || !safeEqualStr(key, OWNER_KEY)) return res.status(401).json({ error: "オーナーキーが正しくありません" });
  const actor = plainActor((req.body || {}).operator, "owner");
  createBrowserSession(req, res, "owner", actor, {}, 60 * 60);
  res.json({ ok: true, principal_type: "owner", principal_id: actor });
});
app.post("/api/auth/coach/session", (req, res) => {
  const ip = _coachIp(req);
  if (coachBlocked(ip)) return res.status(429).json({ error: COACH_BLOCK_MSG });
  const coach = db.coachByCode((req.body || {}).code);
  if (!coach) { coachFail(ip); return res.status(401).json({ error: "コードが無効です。本部にご確認ください。" }); }
  coachOk(ip);
  createBrowserSession(req, res, "coach", coach.id, { team: coach.team || "" }, 60 * 60 * 8);
  const count = db.getCoachRoster(coach.id).length;
  res.json({ ok: true, coach: { id: coach.id, name: coach.name, team: coach.team || "", player_cap: coach.player_cap, player_count: count,
    member_name: coach.member_name || "", member_role: coach.member_role || "" } });
});
app.post("/api/auth/applicant/session", applicantLookupRateLimit, (req, res) => {
  const body = req.body || {};
  const sub = db.getSubmissionByToken(String(body.token || ""));
  if (sub.error || !sub.ok || !sub.tournament || (body.tournament_id && body.tournament_id !== sub.tournament.id)) {
    return res.status(404).json({ error: "申込が見つかりません。大会と申込番号をご確認ください。" });
  }
  // getSubmissionByTokenは表示用へ投影済みなので、申込IDだけを改めてトークンから取得する専用関数を使わない。
  // entry_idからは所有性を復元できないため、DB側でトークン照合したIDを返す小さな経路を利用する。
  const source = db.resolveSubmissionToken(String((req.body || {}).token || ""));
  if (!source) return res.status(404).json({ error: "申込が見つかりません" });
  createBrowserSession(req, res, "applicant", source.id, { tournament_id: source.tournament_id }, 60 * 60 * 24 * 14);
  res.json({ ok: true, tournament: sub.tournament });
});
app.post("/api/auth/player/session", rateLimit({ windowMs: 60000, max: 10, message: "試行回数が多すぎます。しばらく待ってください。" }), (req, res) => {
  const player = db.verifyPlayerAccessCode((req.body || {}).player_id, (req.body || {}).code);
  if (!player) return res.status(401).json({ error: "選手番号または本人確認コードが正しくありません" });
  createBrowserSession(req, res, "player", player.id, {}, 60 * 60 * 24 * 30);
  res.json({ ok: true, player: { id: player.id, name: player.name } });
});
// 審判QRの能力トークンを短期Cookieへ交換する。トークンはこの一度のPOST以外では受け取らない。
app.post("/api/ref/session", rateLimit({ windowMs: 60000, max: 20, message: "リクエストが多すぎます。しばらく待って再試行してください。" }), requireReferee, (req, res) => {
  const tid = req.refTournament.id;
  const court = req.refCourt == null ? null : Number(req.refCourt);
  createBrowserSession(req, res, "referee", tid + ":" + (court || "all"), { tournament_id: tid, court }, 60 * 60 * 12);
  res.json({ ok: true, tournament_id: tid, court });
});

// robots.txt: 全クローラに索引禁止を明示 (#271 参加者PII保護。X-Robots-Tag と二重)
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
});

// ═══ 公開API（閲覧画面用・認証なし） ═══════════════════
// 選手名簿・対戦履歴の横断検索は本人以外の行を列挙できるため公開しない。
app.all("/api/public/players", (req, res) => res.status(404).json({ error: "公開選手名簿は提供していません" }));
app.all("/api/public/players/:id", (req, res) => res.status(404).json({ error: "公開選手名簿は提供していません" }));
app.get("/api/public/tournaments", (req, res) => {
  res.json(db.getTournaments().filter(isPublicTournament).map(sanitizeTournamentPublic));
});
app.get("/api/public/tournaments/:id", requirePublicTournament, (req, res) => {
  // 軽量版: 全試合の埋込みを省く (閲覧はメタ+選手数のみ使用し、試合は /matches を別途取得)。大規模大会で~1MBの無駄を削減。
  res.json(sanitizeTournamentPublic(req.publicTournament));
});
// 公開 /matches から落とす内部列(進行内部・Elo差分・原文sets_json重複・承認待ち暫定結果)。
// 軽量化が主目的(数百試合で生320KB級→約▲59%)。表示に要る referee_name(「審判: X」を viewer が表示)・
// note・整形済 sets・tie_results・相方/bracket_number は残す(viewer未使用列のみ除去=描画を壊さない)。
const PUBLIC_MATCH_OMIT = new Set([
  "referee_id", "pending_result",
  "winner_rating_delta", "loser_rating_delta",
  // next_match_id/next_slot は公開する(#10 観戦のSVG罫線化)。マッチUUID間の参照のみで
  // PIIなし。観戦画面が運営・印刷と同じ共有レイアウト(bracket-layout)で実配線
  // (自由配線の組み替え後を含む)どおりの山を描くために必要。
  "call_count", "call_count_p1", "call_count_p2", "recall_count", "called_at",
  "sets_json", "tournament_id", "created_at", "updated_at",
  "live_sets_json", "live_score_rev",   // 速報は /live 専用(下のLIVE射影でsets側を残す)。revは常に内部
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
  // セットカウント速報は getOperationState がパース済み `live`({s1,s2}) を付与するため、
  // 生JSONと改訂カウンタは落とす(観戦フロントは m.live だけを見る規約)。
  "live_sets_json", "live_score_rev",
]);
function liveMatch(m) { const o = {}; for (const k in m) if (!LIVE_MATCH_OMIT.has(k)) o[k] = m[k]; return o; }
// 公開の選手オブジェクトから内部列を落とす(PII保護)。note=運営の内部メモ(連絡事項・怪我情報等が
// 書かれうる)・rating=Elo(閲覧画面は非公開方針)・merged_into/created_at/updated_at=内部管理列。
// redirected_from(旧IDで開いた印)は残す(リクエスト者自身が使ったIDで非機密)。
const PUBLIC_PLAYER_OMIT = new Set(["note", "rating", "merged_into", "created_at", "updated_at"]);
// 選手詳細の埋込戦績・公開試合検索用の射影: PUBLIC_MATCH_OMIT から tournament_id だけ残す
// (選手詳細は出場大会数の集計・大会別グループ化に tournament_id を使う)。パース済み sets は残る。
const PUBLIC_HISTORY_OMIT = new Set([...PUBLIC_MATCH_OMIT].filter(k => k !== "tournament_id"));
function publicHistoryMatch(m) { const o = {}; for (const k in m) if (!PUBLIC_HISTORY_OMIT.has(k)) o[k] = m[k]; return o; }
function publicPlayer(p) {
  const o = {};
  for (const k in p) if (!PUBLIC_PLAYER_OMIT.has(k)) o[k] = p[k];
  if (Array.isArray(o.matches)) o.matches = o.matches.map(publicHistoryMatch);
  return o;
}
app.get("/api/public/tournaments/:id/matches", requirePublicTournament, (req, res) => {
  // 進行フィンガープリントを ETag 化(未変化の再取得は304で本体0=ポーリング軽量化)。
  // fingerprint は live_score_rev を含むため、速報の更新でもポーラーが新データを取れる。
  const fp = db.getOpsFingerprint(req.params.id);
  const tag = (fp && fp.v != null ? fp.v : "0") + "|" + (fp && fp.status || "") + "|pm";
  if (conditional(req, res, tag, "public, max-age=2")) return;
  // セットカウント速報は進行中(on_table)の試合にだけパース済み `live`({s1,s2}) を添付する。
  // 生JSON(live_sets_json)と改訂カウンタは PUBLIC_MATCH_OMIT で引き続き落とす
  // (観戦フロントは m.live だけを見る規約=観戦ボード・カード面が「● 台N 2-1」を出す)。
  res.json(db.getMatchesByTournament(req.params.id).map(m => {
    const o = publicMatch(m);
    if (m.status === "on_table") {
      const lv = db.parseLiveScore(m.live_sets_json);
      if (lv) o.live = lv;
    }
    return o;
  }));
});
app.get("/api/public/stats", (req, res) => { res.json(db.getStats()); });
// 全試合の平均値 (選手プロフィールの相対比較用 #243)。60秒キャッシュ。
app.get("/api/public/stats/match-averages", (req, res) => {
  try { res.set("Cache-Control", "public, max-age=60").json(db.getGlobalMatchAverages()); }
  catch (e) { res.status(500).json({ error: "averages failed" }); }
});
// 全体統計ダッシュボード用の横断集計 (種目別/カテゴリ別/年度別/ゲーム統計 等)。60秒キャッシュ。
app.get("/api/public/stats/breakdowns", (req, res) => {
  try { res.set("Cache-Control", "public, max-age=60").json(db.getPublicBreakdowns()); }
  catch (e) { res.status(500).json({ error: "breakdowns failed" }); }
});
app.get("/api/public/last-updated", (req, res) => { res.json({ t: db.getLastUpdated() }); });

// ── 試合検索 () ───────────────────────────────
app.all("/api/public/matches", (req, res) => res.status(404).json({ error: "公開横断検索は提供していません" }));
app.all("/api/public/matches/filters", (req, res) => res.status(404).json({ error: "公開横断検索は提供していません" }));
app.all("/api/public/players/:id/opponents", (req, res) => res.status(404).json({ error: "公開選手名簿は提供していません" }));
app.all("/api/public/players/:id/event-stats", (req, res) => res.status(404).json({ error: "公開選手名簿は提供していません" }));
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
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
        signal: AbortSignal.timeout(5000) });   // #32 ハング防止(到達不能時は下のcatchでフェイルオープン)
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

// GAS 経由でも、同一サーバー直接でも受けられる (text/plain or application/json)。
// 任意オリジンからの書込みを許すと、第三者サイトが利用者のブラウザを踏み台にして申込を量産できる。
// 外部連携のサーバー間POSTは Origin を持たないため許可し、ブラウザCORSは許可済みオリジンだけに限定する。
app.options("/api/public/tournaments/:id/submit-team-entry", (req, res) => {
  const origin = req.get("Origin");
  if (!origin || !CORS_ALLOW_ORIGINS.has(origin)) return res.sendStatus(403);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});
async function deliverEntryMail(submissionId = null) {
  if (!mailer.isEnabled()) return;
  await Promise.all(db.claimEntryMail(submissionId).map(async job => {
    let ok = false;
    let skipped = false;
    try {
      const data = db.getEntryMailContent(job.submission_id, job.recipient);
      if (!data) skipped = true;
      else {
        const origin = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
        const send = job.recipient === "applicant" ? mailer.sendConfirmationEmail : mailer.sendAdminNotification;
        ok = !!(await send({ ...data, appOrigin: origin,
          adminUrl: origin ? `${origin}/admin#tournament/${encodeURIComponent(data.tournament.id)}` : "" })).ok;
      }
    } catch (_) { /* SMTPエラーには宛先が含まれ得るためログに残さない。 */ }
    db.finishEntryMail(job, ok, Date.now(), skipped);
  }));
}
let entryMailRunning = false;
// ── Google スプレッドシートへの控え(未設定なら何もしない) ──
// アプリのDBが正本で、ここは控え。失敗しても申込の受付・修正は止めず、応答も待たせない
// (切り離して送り、結果は sheet_backup_log に残す。件数は管理画面に出る)。
const sheetBackup = require("./lib/sheets-backup").create();
function backupSubmission(submissionId, kind) {
  if (!sheetBackup.enabled || !submissionId) return;
  setImmediate(async () => {
    let logId = null;
    try {
      const b = db.buildBackupRows(submissionId, kind);
      if (!b || !b.rows.length) return;
      logId = db.recordBackupAttempt(b);
      db.finishBackup(logId, await sheetBackup.append(b.rows));
    } catch (e) {
      console.error("[sheet-backup] 失敗:", e && e.message);
      if (logId != null) { try { db.finishBackup(logId, { ok: false, error: String((e && e.message) || e) }); } catch (_) {} }
    }
  });
}
function backupFromChange(rec) { if (rec && rec.submission_id) backupSubmission(rec.submission_id, "修正"); }

function scheduleEntryMail(submissionId = null) {
  if (entryMailRunning) return;
  entryMailRunning = true;
  deliverEntryMail(submissionId)
    .catch(() => console.error("[entry mail] 送信処理を完了できませんでした"))
    .finally(() => { entryMailRunning = false; });
}

app.post("/api/public/tournaments/:id/submit-team-entry",
  entryRateLimit,
  express.text({ limit: "1mb", type: ["text/plain", "application/json"] }),
  async (req, res) => {
    const origin = req.get("Origin");
    if (origin) {
      if (origin !== appOriginOf(req) && !CORS_ALLOW_ORIGINS.has(origin)) {
        return res.status(403).json({ error: "許可されていない送信元です" });
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
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
      const opId = db.publicEntryOperationId(req.params.id, req.get("X-Op-Id") || payload.op_id);
      // enforce:true = 公開フォーム経路は field_config の必須項目をサーバ側で強制(クライアント不信)。
      if (!mailer.validRecipient(payload.contact_email)) {
        return res.status(400).json({ error: "連絡先メールアドレスを正しく入力してください。" });
      }
      const r = db.createTeamEntry(req.params.id, { ...payload, source: "form" }, opId,
        { enforce: true, explicit_additions: true, queue_mail: true, reject_registered: true });

      // Platformで成立していない受付はシートへ送らない。
      if (r.error) {
        return res.status(400).json({ error: r.error });
      }
      const created = r.entrant_ids && r.entrant_ids.length > 0;
      if (created) { scheduleEntryMail(r.submission_id); backupSubmission(r.submission_id, "新規"); }

      const { contact: _contact, ...base } = r;
      res.status(201).json({ ...base, mail: created ? { queued: true } : null });
    } catch (e) {
      recordError(e, req, res, 500);
      res.status(500).json({ error: "申込処理エラー: " + e.message });
    }
  }
);

// ── 申込者本人の閲覧・変更 ─────────────────────────────────────────
// 申込番号は /api/auth/applicant/session でHttpOnly Cookieへ一度だけ交換する。
// URLに能力トークンを置かないため、履歴・プロキシログ・共有リンクからの漏えいを防ぐ。
app.get("/api/applicant/me", requireSession(["applicant"]), (req, res) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const r = db.getSubmissionById(req.auth.principal_id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

app.post("/api/applicant/entrants/:id/replace", requireSession(["applicant"]), async (req, res) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const b = req.body || {};
  const r = db.applicantReplaceEntrantBySubmission(req.auth.principal_id, String(req.params.id || ""), {
    slot: b.slot, name: b.name, furigana: b.furigana, team: b.team,
    grade: b.grade, birth_date: b.birth_date, answers: b.answers, reason: b.reason,
  });
  if (r.error) return res.status(400).json({ error: r.error });
  // 主催者へ通知(best-effort。失敗しても変更自体は成立させる)
  try {
    if (mailer.isEnabled() && r.tournament) {
      await mailer.sendEntryChangeNotification({
        tournament: r.tournament, kind: "replace", before: r.before, after: r.after,
        reason: b.reason || "", adminUrl: `${appOriginOf(req)}/admin#tournament/${r.tournament.id}`,
      });
    }
  } catch (e) { recordError(e, req, res, 0); }
  backupSubmission(req.auth.principal_id, "修正");
  res.json(db.getSubmissionById(req.auth.principal_id));
});

app.post("/api/applicant/entrants/:id/cancel", requireSession(["applicant"]), async (req, res) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const reason = String((req.body || {}).reason || "");
  const r = db.applicantCancelEntrantBySubmission(req.auth.principal_id, String(req.params.id || ""), reason);
  if (r.error) return res.status(400).json({ error: r.error });
  try {
    if (mailer.isEnabled() && r.tournament) {
      await mailer.sendEntryChangeNotification({
        tournament: r.tournament, kind: "cancel", before: r.before, after: null,
        reason, adminUrl: `${appOriginOf(req)}/admin#tournament/${r.tournament.id}`,
      });
    }
  } catch (e) { recordError(e, req, res, 0); }
  backupSubmission(req.auth.principal_id, "取消");
  res.json(db.getSubmissionById(req.auth.principal_id));
});

// ── 申込後の修正(申込者・本部共通) ─────────────────────────────
async function notifyEdit(req, r) {
  try {
    if (mailer.isEnabled() && r.tournament && r.changes && r.changes.length) {
      await mailer.sendEntryChangeNotification({
        tournament: r.tournament, kind: "edit", actor: r.actor,
        lines: r.changes.map(c => (c.event ? c.event + ": " : "") + c.summary),
        reason: r.reason || "", adminUrl: `${appOriginOf(req)}/admin#tournament/${r.tournament.id}`,
      });
    }
  } catch (e) { recordError(e, req, null, 0); }
}

// 申込者の修正画面用。連絡先は伏せ字で返し、生年月日は返さない(申込番号が漏れた場合の被害を抑える)。
app.get("/api/applicant/edit-view", requireSession(["applicant"]), (req, res) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const r = db.getSubmissionEditView(req.auth.principal_id, { admin: false });
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

app.post("/api/applicant/submission", requireSession(["applicant"]), async (req, res) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  const b = req.body || {};
  const r = db.editSubmission(req.auth.principal_id,
    { contact: b.contact, options: b.options, entries: b.entries, add: b.add, reason: b.reason }, { actor: "applicant" });
  if (r.error) return res.status(400).json({ error: r.error });
  if (!r.unchanged) { await notifyEdit(req, r); backupSubmission(r.submission_id, "修正"); }
  res.json({ ok: true, unchanged: !!r.unchanged, changes: r.changes || [],
    view: db.getSubmissionEditView(req.auth.principal_id, { admin: false }) });
});

// 本部による修正
app.get("/api/submissions/:sid/edit-view", requireAdmin, (req, res) => {
  const r = db.getSubmissionEditView(req.params.sid, { admin: true });
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

app.put("/api/submissions/:sid", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const r = db.editSubmission(req.params.sid,
    { contact: b.contact, options: b.options, entries: b.entries, add: b.add, reason: b.reason }, { actor: "admin" });
  if (r.error) return res.status(400).json({ error: r.error });
  if (!r.unchanged) backupSubmission(r.submission_id, "修正");
  res.json({ ok: true, unchanged: !!r.unchanged, changes: r.changes || [],
    view: db.getSubmissionEditView(req.params.sid, { admin: true }) });
});

app.post("/api/submissions/:sid/mail-resend", requireAdmin, (req, res) => {
  const recipient = req.body?.recipient;
  if (recipient !== "applicant" && recipient !== "admin") return res.status(400).json({ error: "再送先を確認してください。" });
  if (!mailer.isEnabled()) return res.status(503).json({ error: "メール送信が設定されていません。" });
  if (!db.retryEntryMail(req.params.sid, recipient)) return res.status(409).json({ error: "再送できるメールがありません。" });
  scheduleEntryMail(req.params.sid);
  res.status(202).json({ ok: true });
});

// 申込の一覧(件数・修正・シート反映・別団体との重複)。金銭の収受は扱わない。
app.get("/api/tournaments/:id/submissions", requireAdmin, (req, res) => {
  const r = db.getSubmissionList(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

// 受付台帳(申込集計モードの受付画面)。電話・メールは返さない
app.get("/api/entry-desk/tournaments", requireAdmin, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(db.getEntryDeskList());
});
app.get("/api/tournaments/:id/desk", requireAdmin, (req, res) => {
  const r = db.getEntryDesk(req.params.id);
  res.setHeader("Cache-Control", "no-store");
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

app.get("/api/tournaments/:id/desk/manual", requireAdmin, (req, res) => {
  const view = db.getManualSubmissionView(req.params.id);
  res.setHeader("Cache-Control", "no-store");
  res.status(view.error ? 404 : 200).json(view);
});

app.post("/api/tournaments/:id/desk/manual", requireAdmin, (req, res) => {
  const body = req.body || {};
  const opId = String(body.request_id || "");
  if (!/^[a-z0-9-]{16,64}$/i.test(opId)) return res.status(400).json({ error: "登録操作を識別できません。画面を開き直してください。" });
  const r = db.createManualSubmission(req.params.id, body, opId);
  if (r.error) return res.status(400).json({ error: r.error });
  if (!r.submission_id) return res.status(409).json({ error: r.already_registered ? "すでに登録済みの出場です" : "登録できる出場がありません" });
  if (!r.replayed) backupSubmission(r.submission_id, "本部登録");
  res.status(r.replayed ? 200 : 201).json({ ok: true, submission_id: r.submission_id, replayed: !!r.replayed });
});

// スプレッドシートへの控えの状況と、失敗分の再送(設定が無ければ enabled=false を返すだけ)。
app.get("/api/tournaments/:id/sheet-backup", requireAdmin, (req, res) => {
  if (!db.getTournament(req.params.id)) return res.status(404).json({ error: "大会が見つかりません" });
  res.setHeader("Cache-Control", "no-store");
  res.json({ enabled: sheetBackup.enabled, tab: sheetBackup.enabled ? sheetBackup.tab : "", ...db.getBackupState(req.params.id) });
});
app.post("/api/tournaments/:id/sheet-backup/resend", requireAdmin, async (req, res) => {
  if (!db.getTournament(req.params.id)) return res.status(404).json({ error: "大会が見つかりません" });
  if (!sheetBackup.enabled) return res.status(400).json({ error: "スプレッドシートの控えは設定されていません" });
  const items = db.listBackupToResend(req.params.id, 30);
  let ok = 0, ng = 0;
  for (const it of items) {
    const r = await sheetBackup.append(it.rows);
    db.finishBackup(it.id, r);
    if (r.ok) ok++; else ng++;
  }
  res.json({ ok: true, sent: items.length, succeeded: ok, failed: ng, ...db.getBackupState(req.params.id) });
});

// 本部の一括登録(締切後も可): Excelテンプレの書き出しと、記入済みファイルの読み取り(登録はしない)。
// 読み取り結果は画面で確認させ、登録は上の desk/manual(同じ受付規則・冪等)で行う=書き込み経路を増やさない。
app.get("/api/tournaments/:id/desk/manual-template.xlsx", requireAdmin, (req, res) => {
  const t = db.getTournament(req.params.id);
  if (!t) return res.status(404).json({ error: "大会が見つかりません" });
  try {
    const buf = entryTemplate.buildEntryTemplate({ tournament: t, admin: true,
      events: entryTemplate.adminTemplateEvents(_resolveEvents(t)),
      fieldConfig: entryTemplate.adminTemplateConfig(db.resolveFieldConfig(t)) });
    const fname = `本部登録テンプレート_${String(t.name || "大会").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="desk-template.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) {
    console.error("[desk-template] 作成に失敗:", e && e.message);
    res.status(500).json({ error: "テンプレートを作成できませんでした" });
  }
});
app.post("/api/tournaments/:id/desk/manual-template/read", requireAdmin,
  express.text({ limit: "2mb", type: ["text/plain", "application/json"] }), (req, res) => {
    const t = db.getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: "大会が見つかりません" });
    let body = req.body;
    try { if (typeof body === "string") body = JSON.parse(body); } catch (_) { body = null; }
    const b64 = body && typeof body.file === "string" ? body.file.replace(/^data:[^,]*,/, "") : "";
    const buf = Buffer.from(b64, "base64");
    if (!buf.length || buf.length > 1024 * 1024) return res.status(400).json({ error: "ファイルが空か、大きすぎます(1MBまで)" });
    const sig = buf.slice(0, 4).toString("hex");
    if (sig !== "504b0304" && sig !== "d0cf11e0") return res.status(400).json({ error: "Excelファイル(.xlsx)を選んでください" });
    try {
      const events = entryTemplate.adminTemplateEvents(_resolveEvents(t));
      const out = entryTemplate.readEntryTemplate(buf, { events, admin: true,
        fieldConfig: entryTemplate.adminTemplateConfig(db.resolveFieldConfig(t)) });
      if (out.error) return res.status(400).json({ error: out.error });
      const patch = entryTemplate.toManualPatch(out, events);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...patch, warnings: out.warnings || [],
        summary: (out.events || []).map(e => ({ event: e.name, count: e.rows.length })) });
    } catch (e) {
      console.error("[desk-template] 読み取りに失敗:", e && e.message);
      res.status(400).json({ error: "Excelファイルを読み取れませんでした" });
    }
  });

// 変更履歴(管理画面の申込管理で表示)
app.get("/api/tournaments/:id/entry-changes", requireAdmin, (req, res) => {
  res.json({ items: db.listEntryChanges(req.params.id, req.query.limit) });
});

// 申込設定のコピー元候補(去年の同じ大会などを選ぶ)
app.get("/api/tournaments/:id/entry-settings/sources", requireAdmin, (req, res) => {
  res.json({ items: db.listEntrySettingSources(req.params.id, req.query.limit) });
});
// 申込設定を他の大会からコピー(締切日・受付フラグ・申込データは引き継がない)
app.post("/api/tournaments/:id/entry-settings/copy", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.from) return res.status(400).json({ error: "コピー元の大会(from)が必要です" });
  const r = db.copyEntrySettings(req.params.id, String(b.from), { with_events: !!b.with_events });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// SMTP 設定状態を返す + テスト送信エンドポイント (admin専用)
// 送信サーバー名・アカウント・宛先などの値は画面へ出さない(運営の端末に内部情報を残さないため)。
// 返すのは「使えるか」と「通知先が決まっているか」だけ。値の確認・変更はサーバー側で行う。
app.get("/api/mail/status", requireOwner, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ enabled: mailer.isEnabled(), notify_configured: !!(mailer.config && mailer.config.ADMIN_EMAIL) });
});
app.post("/api/mail/test", requireOwner, async (req, res) => {
  const to = req.body?.to || mailer.config.ADMIN_EMAIL;
  if (!to) return res.status(400).json({ error: "送信先メールアドレスが指定されていません" });
  try {
    const info = await mailer.sendTestEmail(to);
    res.json({ ok: true, message_id: info.messageId, to });
  } catch (e) {
    res.status(500).json({ error: "送信失敗: " + e.message });
  }
});
// 個人情報を含む書き出しの記録。氏名などは残さず、日時・種類・担当コードだけをオーナーの監査ログへ。
// 担当コード: 管理キーは入力された操作担当コード、メールのアカウントは内部IDの先頭8文字(acct-xxxxxxxx)
const EXPORT_LOG_KINDS = { players_csv: "書き出し:選手CSV", matches_csv: "書き出し:試合CSV", entrants_csv: "書き出し:出場者CSV" };
app.post("/api/admin/export-log", requireAdmin, (req, res) => {
  const action = EXPORT_LOG_KINDS[String((req.body || {}).kind || "")];
  if (!action) return res.status(400).json({ error: "書き出しの種類が正しくありません" });
  const id = String((req.auth && req.auth.principal_id) || "");
  const code = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? "acct-" + id.slice(0, 8) : id;
  db.logOwnerAction({ action, operator: code });
  res.json({ ok: true });
});
app.all("/api/public/search", (req, res) => res.status(404).json({ error: "公開選手検索は提供していません" }));

// ═══ 管理API（選手CRUD） ══════════════════════════════
// GET も requireAdmin(note=内部メモ・rating 等の生データを返すため。利用元は admin UI のみ。
// 公開閲覧は /api/public/players 系=サニタイズ済み を使う)。
app.get("/api/players", requireAdmin, (req, res) => {
  const { search, gender, category, team, sort } = req.query;
  res.json(db.getPlayers({ search, gender, category, team, sort }));
});
app.get("/api/players/:id", requireAdmin, (req, res) => {
  const player = db.getPlayer(req.params.id);
  if (!player) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(player);
});
// 選手本人ポータル用の確認コードは管理者だけが発行/再発行できる。
// 平文はこのレスポンスで一度だけ返し、DBにはハッシュのみを残す。
app.post("/api/players/:id/access-code", requireAdmin, (req, res) => {
  const r = db.issuePlayerAccessCode(req.params.id, (req.body || {}).ttl_seconds);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
// ─── 登録団体マスタ(取込で団体を選手にしない正本リスト) ───────────────
app.get("/api/registered-teams", requireAdmin, (req, res) => {
  res.json(db.listRegisteredTeams());
});
app.post("/api/registered-teams", requireAdmin, (req, res) => {
  const r = db.addRegisteredTeam(req.body && req.body.name);
  if (r && r.error) return res.status(400).json(r);
  res.status(201).json(r);
});
app.delete("/api/registered-teams/:id", requireAdmin, (req, res) => {
  res.json(db.deleteRegisteredTeam(req.params.id));
});
// ─── 楽観ロック(同時編集の衝突検知) ──────────────────────────────
// 保存時に「他の端末が先に編集したか」を判定し、競合なら 409 を返して後勝ち(変更の黙殺)を防ぐ。
// 既定=内容ベース: クライアントが base_fields(編集対象フィールドの“編集開始時の値”)を送り、現在値と突き合わせる。
//   → Elo レーティング等の機械的更新(updated_at だけ動く)を競合と誤検知しない(これが重要)。
// base_fields が無い時のみ版ベース(base_updated_at)へフォールバック(機械churnの無い記録向け・後方互換)。
// いずれも未指定なら従来どおり通す。
function occStale(current, body) {
  if (!current || !body) return false;
  if (body.base_fields && typeof body.base_fields === "object") {
    for (const k of Object.keys(body.base_fields)) {
      if (String(current[k] == null ? "" : current[k]) !== String(body.base_fields[k] == null ? "" : body.base_fields[k])) return true;
    }
    return false;
  }
  const base = body.base_updated_at != null ? body.base_updated_at : body.expected_updated_at;
  if (base == null || base === "") return false;
  return String(current.updated_at == null ? "" : current.updated_at) !== String(base);
}
function stripOcc(body) { if (body) { delete body.base_fields; delete body.base_updated_at; delete body.expected_updated_at; } return body; }
function sendConflict(res, current) {
  return res.status(409).json({
    conflict: true,
    error: "他の端末で先に更新されました。画面を一度閉じて最新を確認してから、もう一度お試しください。",
    current,
  });
}
// ─── 組合せ(ブラケット)の楽観ロック ──────────────────────────────
// 抽選/生成/手修正(swap/set-slot)/取込 の同時作業対策。クライアントが base_rev(操作開始時の
// ブラケット版)を送り、現在の版(db.bracketRev)と食い違えば「他の端末が抽選/組合せを変更済み」= 409。
// base_rev 未指定は従来どおり通す(後方互換)。各書込の応答に最新 bracket_rev を返し、続けて操作する
// 端末がローカルの版を更新できるようにする。
function bracketRevStale(tid, event, body) {
  const base = body && body.base_rev;
  if (base == null || base === "") return false;
  return String(db.bracketRev(tid, event)) !== String(base);
}
function sendBracketConflict(res, tid, event) {
  return res.status(409).json({
    conflict: true,
    error: "組合せ(抽選)が他の端末で変更されています。最新を読み込んでから操作してください。",
    bracket_rev: db.bracketRev(tid, event),
  });
}

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
  const cur = db.getPlayer(req.params.id);
  if (!cur) return res.status(404).json({ error: "選手が見つかりません" });
  if (occStale(cur, req.body)) return sendConflict(res, cur);
  const player = db.updatePlayer(req.params.id, stripOcc(req.body));
  if (!player) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(player);
});
// 既存DBから「チーム名と判定される」選手レコードを削除 (admin 専用)
// 一括処理の実行前に自動バックアップを取る(プレビュー=dry_run のときは取らない)。
// 取れなかったら実行しない。取れたら応答に backup(名前)を付け、画面で「戻し方」を案内する。
async function backupBeforeBulk(req, res, next) {
  if (req.body && req.body.dry_run) return next();
  try { const snap = await db.createSnapshot("manual"); req.bulkBackup = snap && snap.name; }
  catch (e) { return res.status(500).json({ error: "実行前のバックアップに失敗したため、中止しました。" }); }
  next();
}
const withBackup = (req, r) => (req.bulkBackup ? { ...r, backup: req.bulkBackup } : r);
app.post("/api/players/cleanup-invalid", requireOwner, backupBeforeBulk, (req, res) => {
  const dry = !!(req.body && req.body.dry_run);
  if (!dry) auditOwner(req, "players_cleanup_invalid", "");
  res.json(withBackup(req, db.cleanupInvalidPlayers({ dry_run: dry })));
});
// 所属(校名)から小/中/高/大カテゴリを一括自動振り分け (#247)
app.post("/api/players/normalize-categories", requireAdmin, backupBeforeBulk, (req, res) => {
  res.json(withBackup(req, db.normalizePlayerCategories({ dry_run: !!(req.body && req.body.dry_run) })));
});
// 支部名の一括整形(取込と同じ normalizeShibuName ルール)。dry_run でプレビュー。
app.post("/api/players/normalize-branches", requireAdmin, backupBeforeBulk, (req, res) => {
  res.json(withBackup(req, db.normalizePlayerBranches({ dry_run: !!(req.body && req.body.dry_run) })));
});
// 空欄の支部を入力済みの選手(所属→支部の多数決)から推測補完。dry_run でプレビュー。
app.post("/api/players/infer-branches", requireAdmin, (req, res) => {
  res.json(db.inferPlayerBranches({ dry_run: !!(req.body && req.body.dry_run) }));
});
// 空欄のふりがなを名字辞書から姓の読みで推測補完。dry_run でプレビュー。
app.post("/api/players/infer-furigana", requireAdmin, (req, res) => {
  res.json(db.inferPlayerFurigana({ dry_run: !!(req.body && req.body.dry_run) }));
});
// 推測補完のうち人が選んだ行だけを確定書き込み(field=branch|furigana, changes=[{id,to}])。
app.post("/api/players/apply-fill", requireAdmin, backupBeforeBulk, (req, res) => {
  const b = req.body || {};
  const r = db.applyInferredFill(b.field, b.changes);
  if (r.error) return res.status(400).json(r);
  res.json(withBackup(req, r));
});
// 所属名の統一(表記ゆれの一括変更 例:鳥取中学→鳥取中学校)。dry_run で件数プレビュー。
app.post("/api/players/rename-team", requireAdmin, backupBeforeBulk, (req, res) => {
  const b = req.body || {};
  const r = db.renameTeam(b.from, b.to, { dry_run: !!b.dry_run });
  if (r.error) return res.status(400).json(r);
  res.json(withBackup(req, r));
});

app.delete("/api/players/:id", requireAdmin, (req, res) => {
  const r = db.deletePlayer(req.params.id);
  if (r && r.error) return res.status(409).json(r);   // 統合済み/リダイレクト先は削除不可
  res.json({ ok: true });
});
// 全選手削除の素の経路もオーナーへ隔離(UIは確認付きの /api/owner/players/delete-all を使う)。
app.delete("/api/players", requireOwnerStrict, (req, res) => {
  auditOwner(req, "players_delete_all_raw", "");
  db.deleteAllPlayers(); res.json({ ok: true });
});
// 選手の重複候補 + 結合 (マージ) #275
app.get("/api/player-merge/candidates", requireAdmin, (req, res) => {
  res.json(db.findDuplicatePlayerCandidates());
});
app.post("/api/players/:id/merge", requireOwner, (req, res) => {
  const operator = ownerAuditCode(req);
  if (!operator) return res.status(400).json({ error: "操作担当コードを入力してください" });
  const r = db.mergePlayers(req.params.id, (req.body || {}).duplicate_id, { operator });
  if (r.error) return res.status(400).json(r);
  auditOwner(req, "players_merge", "survivor=" + req.params.id + " dup=" + ((req.body || {}).duplicate_id || "") +
    " merge_id=" + (r.merge_id || ""));
  res.json(r);
});
// マージ履歴 + 取り消し (リダイレクト方式: 統合元IDは merged_into で残るため正確に分離できる)
app.get("/api/player-merges", requireOwner, (req, res) => {
  res.json({ merges: db.listPlayerMerges(req.query.limit) });
});
app.post("/api/player-merges/:id/undo", requireOwner, (req, res) => {
  const operator = ownerAuditCode(req);
  if (!operator) return res.status(400).json({ error: "操作担当コードを入力してください" });
  const r = db.unmergePlayers(req.params.id, { operator });
  if (r.error) return res.status(400).json(r);
  auditOwner(req, "players_merge_undo", "merge_id=" + req.params.id +
    " survivor=" + (r.survivor_id || "") + " dup=" + (r.dup_id || ""));
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
// 監督コードは本番ではログイン時の一度だけ受け取り、以後はCookieセッションに限定する。
function requireCoach(req, res, next) {
  if (sessionHas(req, "coach")) {
    const coach = db.getCoachAccount(req.auth.principal_id);
    if (!coach) return res.status(401).json({ error: "監督アカウントが見つかりません" });
    req.coach = coach;
    return requireSameOrigin(req, res, next);
  }
  if (IS_PROD) return res.status(401).json({ error: "監督ログインが必要です" });
  const ip = _coachIp(req);
  if (coachBlocked(ip)) return res.status(429).json({ error: COACH_BLOCK_MSG });
  const code = req.get("X-Coach-Code") || (req.body && req.body.coach_code) || req.query.coach_code;
  const coach = db.coachByCode(code);
  if (!coach) { coachFail(ip); return res.status(401).json({ error: "監督ログインが必要です（コードが無効か無効化されています）" }); }
  coachOk(ip);
  req.coach = coach;
  setPrincipal(req, "coach", coach.id, { team: coach.team || "" });
  next();
}
// 監督ログイン (コード→アカウント情報。コード自体は返さない)
app.post("/api/coach/login", (req, res) => {
  const ip = _coachIp(req);
  if (coachBlocked(ip)) return res.status(429).json({ error: COACH_BLOCK_MSG });
  const coach = db.coachByCode((req.body || {}).code);
  if (!coach) { coachFail(ip); return res.status(401).json({ error: "コードが無効です。本部にご確認ください。" }); }
  coachOk(ip);
  // 旧URLもCookieセッションを発行する互換入口にする。ブラウザ側は /api/auth/coach/session を使用する。
  createBrowserSession(req, res, "coach", coach.id, { team: coach.team || "" }, 60 * 60 * 8);
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
  if (!isAllowedPushEndpoint(sub.endpoint))
    return res.status(400).json({ error: "購読エンドポイントが不正です" });   // #8 SSRF対策
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
  // 選手名・所属付きの一覧(#7/#10)。従来の {id, devices} も含むので既存の通知ONバッジ用途とも互換。
  const rows = db.getPushSubscribersDetailed();
  res.json({ players: rows, count: rows.length });
});
// 個別送信(#7): 指定選手のマイ番号端末へ任意メッセージを送る。
app.post("/api/admin/push/players/:playerId/send", requireAdmin, async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "プッシュ通知は無効です" });
  const b = req.body || {};
  const title = String(b.title || "釧路卓球協会").slice(0, 80);
  const body = String(b.body || "").slice(0, 300);
  if (!body) return res.status(400).json({ error: "本文を入力してください" });
  try {
    const devices = await sendPushToPlayer(req.params.playerId, { title, body, url: b.url || "/viewer/", tag: "ktta-admin" });
    res.json({ ok: true, devices });
  } catch (e) { res.status(500).json({ error: "送信に失敗しました: " + (e && e.message || e) }); }
});
// 一括送信(#7): プッシュ登録している全選手の端末へ送る。
app.post("/api/admin/push/broadcast", requireAdmin, async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ error: "プッシュ通知は無効です" });
  const b = req.body || {};
  const title = String(b.title || "釧路卓球協会").slice(0, 80);
  const body = String(b.body || "").slice(0, 300);
  if (!body) return res.status(400).json({ error: "本文を入力してください" });
  const players = db.getPushPlayerIds();
  let devices = 0, failed = 0;
  for (const p of players) {
    try { devices += (await sendPushToPlayer(p.id, { title, body, url: b.url || "/viewer/", tag: "ktta-admin" })) || 0; }
    catch (e) { failed++; }   // 1人分の失敗で全体を止めない(必ず res で応答)
  }
  res.json({ ok: true, players: players.length, devices, failed });
});
// 強制削除(#10): 指定選手のプッシュ登録(全端末)を本部側から解除する。
app.delete("/api/admin/push/players/:playerId", requireAdmin, (req, res) => {
  res.json(db.deletePushSubscriptionsForPlayer(req.params.playerId));
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

// ── 所属履歴 (#298): players.team は現所属キャッシュ、正本はこの履歴 ──
app.get("/api/players/:id/affiliations", requireAdmin, (req, res) => {
  res.json({ affiliations: db.listAffiliations(req.params.id) });
});
app.post("/api/players/:id/affiliations", requireAdmin, (req, res) => {
  const r = db.addAffiliation(req.params.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  res.status(201).json(r);
});
// 所属を締める(クラブ変更・卒業)。body: { end_date } (空=本日)
app.post("/api/affiliations/:id/end", requireAdmin, (req, res) => {
  const r = db.endAffiliation(req.params.id, (req.body || {}).end_date);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.delete("/api/affiliations/:id", requireAdmin, (req, res) => {
  const r = db.deleteAffiliation(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
// 既存選手の team から所属履歴を一括生成(冪等・初回移行用)。
app.post("/api/affiliations/backfill", requireOwner, (req, res) => {
  res.json(db.backfillAffiliations());
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
app.get("/api/tournaments", requireAdmin, (req, res) => {
  // 認証なしでも到達可能な経路。管理キーがあれば完全データ、なければ秘密フィールドを除去 (#1/#14)。
  const list = db.getTournaments();
  if (currentAppMode() === "entry") {
    for (const t of list) t.entry_closed_reason = db.entryClosedReason(t) || "";
  }
  res.json(isAdminAuthed(req) ? list : list.map(sanitizeTournamentPublic));
});
app.get("/api/tournaments/:id", requireAdmin, (req, res) => {
  const t = db.getTournament(req.params.id);
  if (!t) return res.status(404).json({ error: "大会が見つかりません" });
  if (currentAppMode() === "entry") {
    t.entry_summary = summarizeEntries(db.getEntrants(t.id));
    t.entry_closed_reason = db.entryClosedReason(t) || "";
  }
  res.json(isAdminAuthed(req) ? t : sanitizeTournamentPublic(t));
});
app.post("/api/tournaments", requireAdmin, (req, res) => {
  const body = req.body || {};
  // entry-settings と同じ防御: 作成時に event_config を渡せるので、種目 name を必ず
  // 文字列化する (壊れた name=オブジェクトが「[object Object]」になる不具合の予防)。
  if (Array.isArray(body.event_config)) {
    body.event_config = body.event_config.map(e => (e && typeof e === "object") ? { ...e, name: _eventNameStr(e.name) } : e);
  }
  res.status(201).json(db.createTournament(body));
});
app.put("/api/tournaments/:id", requireAdmin, (req, res) => {
  const cur = db.getTournament(req.params.id);
  if (!cur) return res.status(404).json({ error: "大会が見つかりません" });
  if (occStale(cur, req.body)) return sendConflict(res, cur);
  const t = db.updateTournament(req.params.id, stripOcc(req.body));
  if (!t) return res.status(404).json({ error: "大会が見つかりません" });
  res.json(t);
});
app.delete("/api/tournaments/:id", requireOwner, (req, res) => {
  const t = db.getTournament(req.params.id);
  db.deleteTournament(req.params.id);
  auditOwner(req, "tournament_delete");
  res.json({ ok: true });
});

// ═══ 管理API（試合CRUD・セット記録） ═════════════
app.get("/api/tournaments/:id/matches", requireAdmin, (req, res) => {
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
app.get("/api/matches/:id", requireAdmin, (req, res) => {
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
app.get("/api/tournaments/:id/players", requireAdmin, (req, res) => {
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
app.get("/api/tournaments/:id/entrants", requireAdmin, (req, res) => {
  res.json(stripEntrantPII(db.getEntrants(req.params.id, req.query.event)));
});
app.get("/api/public/tournaments/:id/entrants", requirePublicTournament, (req, res) => {
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
// 名簿(出場者)の一括削除(取込やり直し用)。?event=種目 で種目単位 / 省略で大会まるごと。
// 結果入力済みがあれば force 必須。削除前に必ずバックアップを取り、失敗時は中止(復旧点を保証)。
app.delete("/api/tournaments/:id/entrants", requireAdmin, async (req, res) => {
  const event = req.query.event || "";
  const force = req.query.force === "1" || (req.body && req.body.force);
  const st = db.rosterStats(req.params.id, event);
  if (st.entrants === 0) return res.status(400).json({ error: "削除対象の出場者がいません" });
  if (st.completed > 0 && !force) {
    return res.status(409).json({ needs_force: true, completed: st.completed,
      error: "結果入力済みの試合が " + st.completed + " 件あります。削除すると結果も失われます。" });
  }
  try { await db.createSnapshot("manual"); }
  catch (e) { return res.status(500).json({ error: "事前バックアップに失敗したため中止しました: " + e.message }); }
  const r = db.deleteRoster(req.params.id, event);
  res.json(r);
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
  const entryOnly = currentAppMode() === "entry";
  res.send(buildReceptionHTML(t, entryOnly ? entrants.filter(isConfirmedEntry) : entrants, entryOnly));
});

function buildReceptionHTML(t, entrants, entryOnly = false) {
  const yen = (n) => "¥" + (parseInt(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let cfg = [];
  try { cfg = JSON.parse(t.event_config || "[]"); } catch (e) {}
  const feeMap = {};
  (Array.isArray(cfg) ? cfg : []).forEach(c => { if (c && c.name) feeMap[String(c.name).trim()] = parseInt(c.fee) || 0; });
  const feeOf = (ev) => feeMap[String(ev || "").trim()] || 0;
  const byTeam = Object.create(null);
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
        (entryOnly ? "" : `<td class="fee">${fee ? yen(fee) : ""}</td><td class="seal"></td>`) + "</tr>";
    }).join("");
    return `<section class="team-sec"><h3>${_escHtml(team)} <span class="tc">${list.length}件</span></h3>` +
      `<table class="rcp-table"><thead><tr><th class="chk">受付</th><th class="no">No</th>` +
      `<th>氏名（ふりがな）</th><th>種目</th>` +
      (entryOnly ? "" : '<th class="fee">参加料</th><th class="seal">領収印</th>') + "</tr></thead>" +
      `<tbody>${rows}</tbody><tfoot><tr><td colspan="4" class="sub-l">小計（${list.length}件）</td>` +
      (entryOnly ? "" : `<td class="fee">${yen(sub)}</td><td></td>`) + "</tr></tfoot></table></section>";
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
<div class="grand">${entryOnly ? `確定出場 ${grandCount}件 / ${teamNames.length}団体` : `参加料 合計予定額　${yen(grand)}　（全${grandCount}件 / ${teamNames.length}団体）`}</div>
${entryOnly ? "" : '<div class="note">※ 当日受付（紙）用。金額は申込種目の設定料金からの「請求予定額」です。実際の入金・領収の管理はスプレッドシート/紙が正です。受付欄・領収印欄に押印してご利用ください。</div>'}
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

// 進行中(ongoing)の大会はトーナメント表の構造を変更できない(2026-07-17)。
// 従来は管理画面の紙面ビュー(renderPaperBracket)だけのUIガードで、別端末・古いタブ・
// API直叩き・トーナメント管理グリッドからは進行中でも書き換えられた。サーバ側で一律遮断する。
// 対象=構造を変えるルート(生成/抽選/取込/入替/枠設定/配線/シード/削除)。進行そのもの
// (呼出・結果入力・BYE進行)と保護操作(ロック)・氏名同期は対象外。
function blockOngoingBracketEdit(req, res, next) {
  try {
    const t = db.getTournamentMeta(req.params.id);
    if (t && t.status === "ongoing") {
      return res.status(403).json({
        error: "進行中の大会はトーナメント表の構造を変更できません。変更が必要な場合は、大会一覧から進行を一時停止(状態を「予定」へ戻す)してから編集してください。",
        ongoing: true,
      });
    }
  } catch (e) {}
  next();
}

// ═══ 旧・木の直接編集API(案B P8で撤去): 410 Gone ═══════════════════════
// 組合せの正本は割当表(bracket_sheets)に一本化された。木(matches)を直接編集する旧APIは
// 全て「表を編集」(シートops/confirm/patch)に置換済みのため、ここで一律410を返して封鎖する。
// Expressは先に登録したルートが勝つ=下方の旧ハンドラ実装には到達しない(実装の完全削除は次の大掃除で)。
// これにより「matchesの構造書込=シート経由のみ」が経路の数え上げではなく登録順で保証される。
[
  "/api/tournaments/:id/bracket/swap",                 // 選手入替 → シートops(place/モーダル)
  "/api/tournaments/:id/bracket/relink",               // 自由配線 → 廃止(木=割当表の純関数と両立しない)
  "/api/tournaments/:id/bracket/place-entrant",        // 枠へ配置 → シートops(place)
  "/api/tournaments/:id/bracket/set-slot",             // 枠の設定 → シートops(place/clear)
  "/api/tournaments/:id/bracket/set-slot-from-player", // 選手DBから配置 → モーダル(出場追加+place)
  "/api/tournaments/:id/bracket/set-seed-round",       // 登場回戦 → シートops(set_entry_round)
  "/api/tournaments/:id/bracket/swap-match",           // 試合まるごと入替 → シートops(swap×2)
  "/api/tournaments/:id/bracket/add-seed",             // シード追加 → シート(set_size+place+entry_round)
  "/api/tournaments/:id/bracket/promote-seed",         // シード繰り上げ → 同上
].forEach(pth => app.post(pth, requireAdmin, (req, res) => res.status(410).json({
  error: "この操作は「表を編集」(割当表)に統合されました。申込一覧 → 種目タブ → 表を編集 から行ってください。",
  gone: true,
})));

// シード配置でトーナメント生成
// body: { event, regenerate?, entrant_ids? }
app.post("/api/tournaments/:id/bracket/generate", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  if (bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  const r = db.generateBracket(req.params.id, event, {
    regenerate: req.body?.regenerate !== false,
    entrant_ids: req.body?.entrant_ids || null,
    force: !!req.body?.force,   // 結果入力済み試合がある種目の再生成ガードを越える(運営が確認の上)
  });
  if (r?.error) return res.status(400).json(r);
  db.markSheetDirty(req.params.id, event);   // 旧経路の再生成(共存フック)
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, event) });
});
// 抽選ドロー: シードを標準位置に固定 + 非シードをランダム抽選(同一所属/地区を分散) → ブラケット凍結。
// body: { event, draw_seed?, separate_by?('team'|'region'|'none'), force?, preview?, drawn_by? }
//   preview=1(query/body): DBを書かず組合せだけ返す(確定前dry_run)。
//   確定(preview無し)は操作担当コード drawn_by 必須(氏名を監査へ残さない)。
// 同じ draw_seed を指定すれば同一結果を再現できる(検証・引き直し用)。結果入力済みは force ガード。
app.post("/api/tournaments/:id/bracket/draw", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const preview = req.query.preview === "1" || req.body?.preview === true || req.body?.preview === 1;
  const drawnBy = validOperatorCode(req.body?.drawn_by);
  if (!preview && !drawnBy) {
    return res.status(400).json({ error: "操作担当コード(drawn_by)が必要です(英数字・ハイフン・アンダースコア3〜32文字)", needs_drawn_by: true });
  }
  // 確定(非preview)のみ同時作業ガード。preview(dry_run)はDBを書かないので素通し。
  if (!preview && bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  const r = db.drawSingleBracket(req.params.id, event, {
    draw_seed: req.body?.draw_seed,
    separate_by: req.body?.separate_by,
    block_sizes: req.body?.block_sizes,
    force: !!req.body?.force,
    preview,
    drawn_by: drawnBy,
  });
  if (r?.error) return res.status(400).json(r);
  if (!preview) db.markSheetDirty(req.params.id, event);   // 旧経路の抽選確定(共存フック)
  res.json(preview ? r : { ...r, bracket_rev: db.bracketRev(req.params.id, event) });
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
// 組合せ(ブラケット)の現在版。編集UIを開く時に取得し、書込時に base_rev として送る(同時作業の競合検知用)。
app.get("/api/tournaments/:id/bracket/rev", requireAdmin, (req, res) => {
  res.json({ bracket_rev: db.bracketRev(req.params.id, req.query.event || "") });
});
// 書込なしプレビュー: 標準配置(seed+登場回戦)の結果ブラケットを「生成せず」に返す(スーパーシード確認用)。
// DB/Elo/トランザクションに一切触れない。結果入力済みでも現ブラケットを壊さない(non-destructive)。
app.get("/api/tournaments/:id/bracket/preview", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.generateBracket(req.params.id, event, { preview: true });
  if (r && r.error) return res.status(400).json(r);
  res.json(r);   // { preview:true, event, bracket_size, total_rounds, matches:[...] }
});
// 直前の抽選を取り消し、抽選直前のブラケットへ戻す。body: { event }
app.post("/api/tournaments/:id/bracket/undo-draw", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  if (bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  const r = db.undoDraw(req.params.id, event, { force: !!req.body?.force });
  if (r?.error) return res.status(400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, event) });
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
  const setBy = validOperatorCode(req.body?.set_by);
  if (!setBy) return res.status(400).json({ error: "操作担当コード(set_by)が必要です" });
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
// リーグ同率の抽選結果(手動確定順位)の保存(運営限定)。ranks={entrantId: 1..k}。0で解除。
app.post("/api/tournaments/:id/league/tiebreak", requireAdmin, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.setLeagueTiebreak(req.params.id, event, req.body?.ranks);
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});
// トーナメント近接警告の再チェック(手修正後): 同チーム/同支部が番号10以内(釧路支部同士は除外)
app.get("/api/tournaments/:id/bracket/proximity", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.computeBracketProximity(req.params.id, event);
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});
// 名簿(エントリー表)Excel取込: プレビュー(解析のみ・DB非書込)。「男女シングルス」「男女ダブルス」
// シートを行配列に落とし、純関数パーサ(db.parseRosterRows)+支部DB照合(enrichRosterRegions)の結果を返す。
app.post("/api/tournaments/:id/roster/preview", requireAdmin, upload.single("file"), (req, res) => {
  const filePath = req.file && req.file.path;
  try {
    if (!req.file) return res.status(400).json({ error: "ファイルが添付されていません" });
    const XLSX = require("xlsx");
    const wb = XLSX.readFile(filePath);
    // 形式: meibo=大会申込集計(「男女シングルス/男女ダブルス」シート・区分列で種目分け) /
    //       entrylist=タブ=種目のエントリーリスト(区分列なし)。
    // 明示指定を最優先。未指定は「区分」列を持つシートがあれば meibo(=meibo は必ず区分列を持つ・
    // entrylist は持たない=決定的に区別できる。シート名が『シングルス』変種の meibo も正しく判定)。
    let format = req.body && req.body.format;
    if (format !== "meibo" && format !== "entrylist") {
      const hasKubun = wb.SheetNames.some(s => {
        const hdr = (XLSX.utils.sheet_to_json(wb.Sheets[s], { header: 1, defval: "" })[0] || []).map(v => String(v).trim());
        return hdr.includes("区分") && (hdr.includes("氏名") || hdr.includes("氏名1"));
      });
      format = hasKubun ? "meibo" : "entrylist";
    }
    let parsed;
    if (format === "meibo") {
      const sheetRows = (kw) => {
        const n = wb.SheetNames.find(s => s.includes(kw));
        return n ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: "" }) : [];
      };
      const singles = sheetRows("シングルス");
      const doubles = sheetRows("ダブルス");
      if (!singles.length && !doubles.length) {
        return res.status(400).json({ error: "「男女シングルス」「男女ダブルス」シートが見つかりません(シート名を確認してください)" });
      }
      parsed = db.parseRosterRows({ singles, doubles });
    } else {
      const sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: "" }) }));
      parsed = db.parseEntryListSheets(sheets);
      if (!parsed.entries.length) {
        return res.status(400).json({ error: "種目シートが見つかりません(タブ名=種目・1行目に「氏名」と「チーム名」のヘッダが必要)" });
      }
    }
    const dbIssues = db.enrichRosterRegions(parsed.entries);
    res.json({ ok: true, format, entries: parsed.entries, issues: parsed.issues.concat(dbIssues), stats: parsed.stats });
  } catch (e) {
    res.status(400).json({ error: "名簿の解析に失敗しました: " + e.message });
  } finally {
    if (filePath) { try { fs.unlinkSync(filePath); } catch (e) {} }
  }
});
// 名簿取込の確定(プレビューで修正済みの entries を受けて entrants を冪等作成)
app.post("/api/tournaments/:id/roster/commit", requireAdmin, (req, res) => {
  const r = db.importRoster(req.params.id, {
    mode: req.body?.mode, open: req.body?.open === true,
    split_gender: req.body?.split_gender === true,   // direct: 種目名を男子/女子(/混合)に分割
    register_players: req.body?.register_players !== false,   // 既定=初参加を選手DBに登録
    entries: req.body?.entries,
  });
  if (r?.error) return res.status(400).json(r);
  res.json(r);
});
// 予選リーグ→決勝トーナメント通過処理(運営限定)。mode=top(上位N進出)|byrank(順位別T)。
app.post("/api/tournaments/:id/league/playoff", requireAdmin, (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: "event(予選リーグの種目)が必要です" });
  const r = db.generateLeaguePlayoff(req.params.id, event, {
    mode: req.body?.mode,
    advance_n: req.body?.advance_n,
    force: !!req.body?.force,
  });
  if (r?.error) return res.status(400).json(r);
  // 生成した決勝T/順位別T(新種目)を割当表の正本に載せる(案B P7)。migrateBracketSheets は
  // シート未作成の種目だけを冪等に拾い、標準配線なので「第1版(移行)」として即confirmedになる
  // =進行中の大会でも決勝Tに版スタンプ付き印刷がそのまま使える。
  try { db.migrateBracketSheets(req.params.id); } catch (e) {}   // この大会だけ移行(全大会スキャンを避ける・案B 2-5)
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
app.get("/api/public/tournaments/:id/standings", requirePublicTournament, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const block = req.query.block || undefined;
  res.json({ event, block: block || null,
    standings: db.computeLeagueStandings(req.params.id, event, block),
    matches: db.getLeagueMatchResults(req.params.id, event, block) });
});
app.put("/api/entrants/:id", requireAdmin, (req, res) => {
  const cur = db.getEntrant(req.params.id);
  if (cur && occStale(cur, req.body)) return sendConflict(res, cur);
  const e = db.updateEntrant(req.params.id, stripOcc(req.body) || {});
  if (!e) return res.status(404).json({ error: "エントリーが見つかりません" });
  backupFromChange(db.recordAdminEntrantChange(cur, e));
  res.json(e);
});
// 枠の編集グリッドのDB検索編集: 既存 entrant のメンバー(本人/相方)を選手マスタにリンク上書き。
app.post("/api/entrants/:id/member-from-player", requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = db.setEntrantMemberFromPlayer(req.params.id, !!b.is_partner, b.player_id, { applyNameMatches: !!b.apply_name_matches });
  if (r && r.error) return res.status(400).json(r);
  const e = db.getEntrant(req.params.id);
  res.json({ ...r, bracket_rev: e ? db.bracketRev(e.tournament_id, e.event) : null });
});
app.delete("/api/entrants/:id", requireAdmin, (req, res) => {
  // 組合せ画面からの削除は base_rev(クエリ)で楽観ロック。entrant 削除は配置枠も書き換えるため、
  // 他端末が抽選/組合せを変更済みなら 409 で弾く。base_rev 未指定(従来の一覧からの削除)は通す。
  const e = db.getEntrant(req.params.id);
  if (e && req.query && req.query.base_rev && bracketRevStale(e.tournament_id, e.event, req.query)) {
    return sendBracketConflict(res, e.tournament_id, e.event);
  }
  db.deleteEntrant(req.params.id);
  if (e) backupFromChange(db.recordAdminEntrantChange(e, null));
  res.json({ ok: true, bracket_rev: e ? db.bracketRev(e.tournament_id, e.event) : null });
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
app.get("/api/entrants/:id/suggest-player", requireAdmin, (req, res) => {
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
  // 登録団体マスタ(正規化済み)を各パーサへ渡し、団体名を氏名に誤判定しない(発生源で抑止)。
  let regTeams = [];
  try { regTeams = db.registeredTeamNormalizedList() || []; } catch (e) { regTeams = []; }

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
        registeredTeams: regTeams,
      });
      try { fs.unlinkSync(filePath); } catch {}
      if (data.error) return res.status(400).json(data);
      // PDF も単一ブラケット/{brackets:[...]} 形状を返し legacy 描画になるため notices は付けない(#268 と同じ判断)。
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

  // Excel 経由: 主系統=Python 罫線パーサー(openpyxl) / 副系統=JS seed-list / 最終=旧 parse_ktta_bracket。
  // チェーンは parseExcelChain に集約(申込Excel取込 upload-excel と共用)。source は組合せ表取込の識別用。
  try {
    const chain = await parseExcelChain(filePath, { sheet, event, format, regTeams });
    applyRosterCrossCheck(filePath, chain);   // 名簿突合(取りこぼし/過大/表記揺れ)を警告に追加
    const source = chain.kind === "data" ? "kumiawase_chart" : "kumiawase_seedlist";
    return sendChainResult(res, req.params.id, filePath, chain, {
      dryRun,
      importOpts: { regenerate: true, auto_link_to_players: true, auto_create_players: true, placement: "as_drawn" },
      source,
    });
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

// ── Python 罫線パーサー(tools/bracket_parser, openpyxl) の可用性プローブ ──
// 組合せ表取込の主系統(#268 昇格)。本番に python3/openpyxl が無くても JS 主系統で
// 無停止運用するため、プロセス内で一度だけ可用性を検査して結果をキャッシュする。
// テスト/運用で強制 off にしたいときは KTTA_DISABLE_PYTHON_PARSER=1。
let _pyParserAvail = null; // null=未検査 / true|false=検査済み
function pythonParserEnv() {
  const env = Object.assign({}, process.env);
  const paths = [path.join(__dirname, "tools"), path.join(__dirname, ".python-packages")];
  env.PYTHONPATH = paths.join(path.delimiter) + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : "");
  return env;
}
async function pythonParserAvailable() {
  if (process.env.KTTA_DISABLE_PYTHON_PARSER === "1") return false;
  if (_pyParserAvail !== null) return _pyParserAvail;
  try {
    const r = await runChild("python3", ["-c", "import openpyxl, bracket_parser"], { env: pythonParserEnv(), timeoutMs: 8000 });
    _pyParserAvail = r.code === 0;
  } catch { _pyParserAvail = false; }
  console.log(`[startup] Python 罫線パーサー(bracket_parser): ${_pyParserAvail ? "利用可能 → 組合せ表取込の主系統" : "利用不可 → JS 主系統にフォールバック"}`);
  return _pyParserAvail;
}

// Excel を主系統(Python 罫線)→副系統(JS seed-list)→最終FB(旧 parse_ktta_bracket)の順で解析し、
// 正規化した結果を返す共通チェーン。res/DB/unlink は一切触らない(組合せ表取込と申込Excel取込で共用)。
// 返り値 kind:
//   'events' : { events:[{event,format,players,notices}], used_parser }  — Python/JS 主系統(events[] 形状)
//   'data'   : { data, used_parser }                                     — 旧ktta(単一/{brackets:[]} 形状・legacy描画)
//   'none'   : どのパーサも種目を取れなかった(呼び元でエラー応答)
async function parseExcelChain(filePath, { sheet, event, format, regTeams } = {}) {
  const fmtHint = ["singles", "doubles", "team"].includes(format) ? format : null;
  const rt = regTeams || [];

  // JS seed-list パーサーで解析(複数種目シートを sheetSections で分割)。events[] を返す。
  const jsParse = () => {
    if (!(seedListParser && seedListParser.parseSeedList)) return [];
    try {
      const parsed = seedListParser.parseSeedList(filePath, {
        sheet: sheet || null,
        eventHint: (sheet && event) ? event : null,
        formatHint: (sheet && fmtHint) ? fmtHint : null,
        registeredTeams: rt,
      });
      return (parsed.events || []).filter((ev) => (ev.players || []).length >= 2);
    } catch (e) {
      console.warn("[parseExcelChain] seed-list parse failed:", e.message);
      return [];
    }
  };

  // ── 主系統: Python 罫線パーサー ──
  // openpyxl はセル罫線を読めるため組合せ表(両山トーナメント)の構造復元に最も強い。
  if (await pythonParserAvailable()) {
    try {
      const pyEnv = pythonParserEnv();
      try { const j = JSON.stringify(rt); if (j.length < 60000) pyEnv.KTTA_REGISTERED_TEAMS = j; } catch (e) {}
      const pyArgs = ["-m", "bracket_parser", filePath];
      if (sheet) {
        pyArgs.push("--sheet", sheet);
        if (event) pyArgs.push("--event", event);
        if (fmtHint) pyArgs.push("--format", fmtHint);
      }
      const pyRes = await runChild("python3", pyArgs, { env: pyEnv });   // #20: タイムアウト/出力上限つき
      let parsed = null;
      if (pyRes.code === 0 && pyRes.out) { try { parsed = JSON.parse(pyRes.out); } catch { parsed = null; } }
      const pyEvents = (parsed && !parsed.error ? (parsed.events || []) : [])
        .filter((ev) => (ev.players || []).length >= 2);
      if (pyEvents.length) {
        // Python が複数種目シートを1種目に潰していないか検査。潰していて(種目名が2種目を結合)、
        // かつ JS がそのシートを複数種目に分割できるなら JS を採用(ペア/所属/件数の崩れを回避)。
        if (pyEvents.some((e) => importQuality.isMergedEventName(e.event))) {
          const jsEvents = jsParse();
          if (jsEvents.length > pyEvents.length) {
            importQuality.annotateEvents(jsEvents);
            return { kind: "events", events: jsEvents, used_parser: "parse_bracket_seedlist.js (複数種目シート分割)" };
          }
        }
        importQuality.annotateEvents(pyEvents);   // 主系統にも品質警告を後付け(#268 逆転解消)
        return { kind: "events", events: pyEvents, used_parser: "bracket_parser (python)" };
      }
    } catch (e) {
      console.warn("[parseExcelChain] python bracket_parser failed, JS へフォールバック:", e.message);
    }
  }

  // ── 副系統: JS seed-list パーサー ──
  {
    const events = jsParse();
    if (events.length) {
      importQuality.annotateEvents(events);   // seed-list 側は buildEvent で既に付与済み(type単位で重複回避)
      return { kind: "events", events, used_parser: "parse_bracket_seedlist.js" };
    }
  }

  // ── 最終FB: 旧 parse_ktta_bracket (テンプレ/特殊形式向け) ──
  // events[] ではなく単一ブラケット {players,type}/{brackets:[]} 形状。admin では legacy 描画(notices非対応)。
  if (kttaParser && kttaParser.parseWorkbook) {
    const data = kttaParser.parseWorkbook(filePath, {
      formatHint: fmtHint,
      eventHint: event || null,
      sheet: sheet || null,
      allSheets: !sheet,
      verbose: false,
    });
    return { kind: "data", data, used_parser: "parse_ktta_bracket.js" };
  }

  return { kind: "none" };
}

// chain(events 形状)に対し、同じブック内の名簿と突合した警告を後付けする。
// 名簿読取・突合の失敗は握りつぶす(取込・プレビューは絶対に止めない)。events 以外は素通し。
function applyRosterCrossCheck(filePath, chain) {
  if (!chain || chain.kind !== "events") return chain;
  try {
    const roster = rosterReader.extractRoster(filePath, {});
    if (roster && !roster.error && roster.entries && roster.entries.length) {
      importQuality.crossCheck(chain.events, roster.entries);
    }
  } catch (e) {
    console.warn("[roster] 名簿突合に失敗(取込は継続):", e.message);
  }
  return chain;
}

// parseExcelChain の結果を HTTP 応答へ変換する共通処理(組合せ表取込/申込Excel取込で共用)。
// dryRun 時はプレビューを返し(取込まない)、そうでなければ取込む。filePath の unlink はここで行う。
//   opts.dryRun     : プレビューのみ
//   opts.importOpts : db.importBracket へ渡す取込オプション(regenerate/auto_link 等)
//   opts.source     : 応答の source ラベル(任意)
function sendChainResult(res, tid, filePath, chain, { dryRun, importOpts, source } = {}) {
  const done = () => { try { fs.unlinkSync(filePath); } catch {} };
  if (chain.kind === "events") {
    const events = chain.events;
    if (dryRun) {
      done();
      return res.json({
        preview: { events: events.map((e) => ({ event: e.event, format: e.format, count: e.players.length, players: e.players, notices: e.notices || [] })) },
        message: `解析プレビュー: ${events.length}種目 / 計${events.reduce((s, e) => s + e.players.length, 0)}人 (まだ取込されていません)`,
        used_parser: chain.used_parser,
      });
    }
    const imported = [];
    for (const ev of events) {
      const r = db.importBracket(tid, Object.assign({
        format: "tabletennis-seed-list-v1", event: ev.event, players: ev.players,
      }, importOpts));
      imported.push({ event: ev.event, format: ev.format, count: ev.players.length, notices: ev.notices || [], result: r });
    }
    done();
    const out = { ok: true, used_parser: chain.used_parser, imported };
    if (source) out.source = source;
    return res.json(out);
  }
  if (chain.kind === "data") {
    const data = chain.data;
    done();
    if (data.error) return res.status(400).json({ ...data, used_parser: chain.used_parser });
    if (dryRun) return res.json({ preview: data, message: "解析プレビュー (まだ取込されていません)", used_parser: chain.used_parser });
    Object.assign(data, importOpts);
    const r = db.importBracket(tid, data);
    const out = { ...r, used_parser: chain.used_parser };
    if (source) out.source = source;
    return res.json(out);
  }
  // どのパーサも利用できなかった
  done();
  return res.status(500).json({ error: "Excel パーサーが利用できません" });
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
  const dryRun = req.body.dry_run === "1" || req.body.dry_run === "true";
  const format = req.body.format;
  const eventHint = req.body.event || "";
  const originalName = (req.file.originalname || "").toLowerCase();
  const isPdf = originalName.endsWith(".pdf") || req.file.mimetype === "application/pdf";
  // 登録団体マスタ(正規化済み)を各パーサへ渡し、団体名を氏名に誤判定しない(組合せ表取込と同じ扱い)。
  let regTeams = [];
  try { regTeams = db.registeredTeamNormalizedList() || []; } catch (e) { regTeams = []; }

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
        registeredTeams: regTeams,
      });
      try { fs.unlinkSync(xlsxPath); } catch {}
      if (data.error) {
        return res.status(400).json({ ...data, used_parser: "parse_pdf_bracket.js" });
      }
      // PDF は {brackets,type} 形状で legacy 描画のため notices 非対象(#268 と同判断)。
      if (dryRun) return res.json({ preview: data, message: "解析プレビュー (まだ取込されていません)", used_parser: "parse_pdf_bracket.js" });
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
        // テンプレは位置情報を正確に持つため最優先。legacy 描画のため notices 非対象。
        if (dryRun) return res.json({ preview: data, message: "解析プレビュー (まだ取込されていません)", used_parser: "parse_template_bracket.js" });
        data.regenerate = regenerate;
        data.auto_link_to_players = autoLink;
        const r = db.importBracket(req.params.id, data);
        return res.json({ ...r, used_parser: "parse_template_bracket.js" });
      }
    } catch (e) {
      console.warn("[parser] テンプレ判定失敗、汎用パーサーへフォールバック:", e.message);
    }
  }

  // ── 汎用 Excel: 組合せ表取込と同一チェーン(Python 主系統 → JS seed-list → 旧ktta)に統一。──
  // 以前はこの経路だけ 旧ktta→旧jtta.py で、同じファイルでも入口により読取精度が変わっていた(#268 後始末)。
  try {
    const chain = await parseExcelChain(xlsxPath, { sheet: null, event: eventHint, format, regTeams });
    applyRosterCrossCheck(xlsxPath, chain);   // 名簿突合(取りこぼし/過大/表記揺れ)を警告に追加
    return sendChainResult(res, req.params.id, xlsxPath, chain, {
      dryRun,
      // 直接取込(非dryRun)時は申込フォーム側のチェックボックス(置換/自動連携)を尊重しつつ、
      // 紙の並び固定・未登録選手の自動作成は組合せ表取込と揃える。
      importOpts: { regenerate, auto_link_to_players: autoLink, auto_create_players: true, placement: "as_drawn" },
    });
  } catch (e) {
    try { fs.unlinkSync(xlsxPath); } catch {}
    return res.status(500).json({ error: "Excel 解析失敗: " + e.message });
  }
});

// バリデーション (重複/欠落検出)
app.get("/api/tournaments/:id/entrants/validate", requireAdmin, (req, res) => {
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
    // 申込団体ごとの集計+全員の名簿+種目別名簿+領収書差し込み用(lib/entry-workbook.js)。
    // 承認待ち・重複の疑いも名簿に載せ、確認事項欄に理由を出す。
    const data = db.getEntryExport(req.params.id);
    if (data.error) return res.status(404).json(data);
    if (!data.groups.length) return res.status(400).json({ error: "申込がまだありません" });
    const buf = entryWorkbook.buildEntryWorkbook(data);
    // バイナリ転送用に厳格な設定 (圧縮無効・キャッシュ無効・正確な長さ)
    const safeName = (tournament.name || "tournament").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const filename = encodeURIComponent(`申込集計_${safeName}.xlsx`);
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

// ─── リーグ順位表 (星取マトリクス) Excel 出力 ───
// 画面の順位表(TT.leagueTableEl)と同一定義。?event= で1種目に絞れる(未指定=全リーグ種目)。
app.get("/api/tournaments/:id/standings.xlsx", requireAdmin, (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    // リーグ(league_block あり)の種目を列挙(公開 standings API と同じ判定)
    const events = req.query.event ? [String(req.query.event)]
      : db.listLeagueEvents(req.params.id);
    if (!events.length) return res.status(400).json({ error: "リーグ戦(総当たり)の種目がありません" });
    const standingsByEvent = {}, matchesByEvent = {};
    for (const ev of events) {
      const st = db.computeLeagueStandings(req.params.id, ev);   // 全ブロック形 {A:[...]}
      if (!st || !Object.keys(st).length) continue;
      standingsByEvent[ev] = st;
      matchesByEvent[ev] = db.getLeagueMatchResults(req.params.id, ev);
    }
    if (!Object.keys(standingsByEvent).length) return res.status(400).json({ error: "リーグ戦の対戦がまだありません" });
    const buf = reports.buildStandingsXlsx(tournament, standingsByEvent, matchesByEvent);
    const safeName = (tournament.name || "tournament").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const evPart = req.query.event ? "_" + String(req.query.event).replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_") : "";
    const filename = encodeURIComponent(`リーグ順位表_${safeName}${evPart}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buf);
  } catch (e) {
    console.error("standings.xlsx error:", e);
    res.status(500).json({ error: "順位表生成失敗: " + e.message });
  }
});

// ─── 入賞者(表彰)の集計・出力・選手DB登録(大会の締め業務) ───
app.get("/api/tournaments/:id/podium", requireAdmin, (req, res) => {
  const r = db.computeTournamentPodium(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});
// 登録は「プレビュー→人が確認→確定」の確定側。冪等(再実行は skipped)。
app.post("/api/tournaments/:id/podium/register", requireAdmin, (req, res) => {
  const r = db.registerPodiumAchievements(req.params.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
app.get("/api/tournaments/:id/podium.xlsx", requireAdmin, (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    const pod = db.computeTournamentPodium(req.params.id);
    if (pod.error) return res.status(404).json(pod);
    const buf = reports.buildPodiumXlsx(tournament, pod);
    const safeName = (tournament.name || "tournament").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const filename = encodeURIComponent(`入賞者一覧_${safeName}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Content-Length", Buffer.byteLength(buf));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buf);
  } catch (e) {
    console.error("podium.xlsx error:", e);
    res.status(500).json({ error: "入賞者一覧の生成失敗: " + e.message });
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
    // 割当表(編集用)シートと版情報は管理DLのみ(公開DLは印刷用シートだけ)。案B P6。
    const isAdminDL = !String(req.path || "").includes("/api/public/");
    let sheetStates = null;
    if (isAdminDL) {
      sheetStates = {};
      const evs = req.query.event ? [req.query.event]
        : [...new Set(matches.map(m => m.event).filter(Boolean))];
      evs.forEach(ev => {
        try {
          const st = db.getSheetState(req.params.id, ev);
          if (st.confirmed && !st.dirty) sheetStates[ev] = { rev_no: st.confirmed.rev_no };
          db.recordPrintLog(req.params.id, ev, "xlsx");   // 管理者の明示DL=出力履歴に記録
        } catch (e) {}
      });
    }
    const buf = reports.buildBracketXlsx(tournament, matches, entrants,
      { event: req.query.event || "", draw_meta: drawMeta, include_edit_sheet: isAdminDL, sheetStates });
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
app.get("/api/public/tournaments/:id/bracket/export.xlsx", requirePublicTournament, _sendBracketXlsx);

// Excelラウンドトリップ取込: export.xlsx を手修正→再取込して『位置だけ』正本化する(往復ループを閉じる)。
// _import シート(機械可読)を読み、entrantを消さず差分でブラケットを再構成。dry_run=1でプレビュー・force=1で結果上書き。
app.post("/api/tournaments/:id/bracket/import-xlsx", requireAdmin, blockOngoingBracketEdit, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルが添付されていません" });
  const filePath = req.file.path;
  try {
    const XLSX = require("xlsx");
    const wb = XLSX.readFile(filePath);
    // 新形式(案B P6): 「割当表(編集用)」シートがあれば優先。編集する面=読む面(視覚シートを直しても
    // 反映されない従来の自己矛盾を解消)。適用先は下書き=座席表で確認して確定する検収フロー。
    const editSheet = wb.Sheets["割当表(編集用)"];
    if (editSheet) {
      const aoa2 = XLSX.utils.sheet_to_json(editSheet, { header: 1, blankrows: false });
      if (String((aoa2[0] || [])[0]) === "__KTTA_SHEET__") {
        const fileTid = String((aoa2[0] || [])[2] || "");
        if (fileTid && fileTid !== req.params.id) {
          return res.status(400).json({ error: "このExcelは別の大会のファイルです。この大会から出力し直してください。" });
        }
        const hi = aoa2.findIndex(r => (r || [])[0] === "種目");
        if (hi < 0) return res.status(400).json({ error: "割当表(編集用)シートの見出し行が見つかりません。出力し直してください。" });
        // ヘッダ名ベースで列を引く(通常出力とテンプレ=ふりがな/選手2/支部つき の両形式に対応)
        const hd = aoa2[hi].map(x => String(x || "").trim());
        const col = (n) => hd.indexOf(n);
        const gv = (r, n) => { const i = col(n); return i >= 0 ? r[i] : ""; };
        // テンプレ形式=名簿に居ない選手を自動出場登録。判定はメタ行5列目のtype(3種テンプレ共通)
        // またはふりがな列(将来の互換)。通常出力の割当表シートはどちらも無い=従来動作。
        const isTemplate = !!String((aoa2[0] || [])[4] || "") || col("ふりがな") >= 0;
        const rows2 = aoa2.slice(hi + 1).filter(r => r && r.length).map(r => ({
          event: gv(r, "種目"), pos: gv(r, "枠番号"),
          name: gv(r, "選手名") || gv(r, "チーム名"), furigana: gv(r, "ふりがな"),
          team: gv(r, "所属"), region: gv(r, "支部"),
          partner_name: gv(r, "選手2氏名"), partner_furigana: gv(r, "選手2ふりがな"), partner_team: gv(r, "選手2所属"),
          entrant_id: gv(r, "選手ID"), entry_round: gv(r, "登場回戦"), rev: gv(r, "版"),
        }));
        const preview2 = req.query.dry_run === "1" || req.body?.dry_run === "1" || req.body?.dry_run === "true";
        const r2 = db.importSheetRows(req.params.id, rows2, { preview: preview2, create_missing: isTemplate });
        if (r2.error) return res.status(400).json(r2);
        return res.json(r2);   // 下書きへの反映のみ(matches不変)=dirtyフック不要
      }
    }
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
    // 同時作業ガード(本取込のみ): 編集UIで握った base_rev と、対象種目(ev)の現在版が食い違えば 409。
    // (Excel往復取込は当該種目のR1配置を破壊的に再構築するため swap/draw と同じ競合面を持つ。)
    if (!preview && req.body && req.body.base_rev && req.body.ev &&
        bracketRevStale(req.params.id, req.body.ev, { base_rev: req.body.base_rev })) {
      return sendBracketConflict(res, req.params.id, req.body.ev);
    }
    const r = db.importBracketRoundtrip(req.params.id, rows, { force, preview });
    if (r.error) return res.status(400).json(r);
    // 旧経路の往復取込(共存フック): 取り込んだ種目ごとに確定シートをdirtyへ
    if (!preview && Array.isArray(r.results)) {
      r.results.forEach(x => { if (x && x.event && x.success) db.markSheetDirty(req.params.id, x.event); });
    }
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

app.post("/api/settings/seal", requireOwner, upload.single("seal"), (req, res) => {
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
  moveFile(req.file.path, dest);   // 一時フォルダと保存先が別のディスクでも保存できる(EXDEV対策)
  // 公開URL
  const url = SEAL_DIR_PERSISTENT
    ? "/uploads/seal" + ext
    : "/shared/assets/seal" + ext;
  res.json({ ok: true, path: url, size: req.file.size });
});

// ─── 協会ロゴ画像アップロード (領収書ヘッダ用) #272 ───
app.post("/api/settings/logo", requireOwner, upload.single("logo"), (req, res) => {
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
  moveFile(req.file.path, dest);   // 一時フォルダと保存先が別のディスクでも保存できる(EXDEV対策)
  const url = SEAL_DIR_PERSISTENT
    ? "/uploads/logo" + ext
    : "/shared/assets/logo" + ext;
  res.json({ ok: true, path: url, size: req.file.size });
});

// 永続ディスク用 印鑑/ロゴ画像 配信
if (SEAL_DIR_PERSISTENT) {
  app.use("/uploads", express.static(SEAL_DIR_PERSISTENT));
}

// ─── 申込フォーム HTML 生成 ───
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
        // 全キーを保持したうえで既知キーだけ正規化する。
        // fee_student / gender / category / tie_format / grades / division_part /
        // entry_categories / age_check / field_overrides など種目レベルの設定は
        // ここを唯一のチョークポイントとして本番フォーム(/entry/:id)まで通す。
        return cfg.map(e => ({
          ...e,
          name: _eventNameStr(e.name),
          type: e.type || "singles",
          fee: parseInt(e.fee) || 0,
          fee_student: (e.fee_student != null && e.fee_student !== "")
            ? (parseInt(e.fee_student) || 0) : null,
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

// 過去大会で実際に使われた種目カタログ (使用回数順)。新規作成の「よく使う種目」で使用。
// 運営内部情報のため requireAdmin。
app.get("/api/used-events", requireAdmin, (req, res) => {
  res.json({ events: db.getUsedEventsCatalog() });
});

// 申込フォームの events 情報を JSON で取得 (admin UI 用)
app.get("/api/tournaments/:id/entry-form-config", requireOpenEntryOrAdmin, (req, res) => {
  const tournament = req.entryTournament;
  const events = _resolveEvents(tournament);
  res.json({
    tournament: { id: tournament.id, name: tournament.name, date: tournament.date,
                  venue: tournament.venue, status: tournament.status },
    events,
    field_config: db.resolveFieldConfig(tournament),   // 必須項目設定(空なら既定=現行フォーム相当)
    // 受付の制御(P3): 締切日時・定員の現在値と、種目ごとの受付済み枠数
    entry_deadline: tournament.entry_deadline || "",
    entry_deadline_time: tournament.entry_deadline_time || "",
    entry_capacity: tournament.entry_capacity || 0,
    capacity: db.getEntryCapacityState(tournament.id),
    entry_options: db.resolveEntryOptions(tournament),
    entry_payment_note: tournament.entry_payment_note || "",   // 参加料の案内文(大会に保存された値)
  });
});

// 申込団体別 (内訳付き) JSON 出力
app.get("/api/tournaments/:id/applicants", requireAdmin, (req, res) => {
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
app.get("/api/tournaments/:id/entrants/stats", requireAdmin, (req, res) => {
  res.json(db.getEntrantStats(req.params.id));
});

// ═══ 進行管理 (Operations) API ═══════════════════════
app.post("/api/tournaments/:id/bracket", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const { event, regenerate, player_ids, entrant_ids, force } = req.body || {};
  if (!event) return res.status(400).json({ error: "event が必要です" });
  // 旧・生成口も同時作業ガード対象(regenerate でR1総入替する破壊的操作=draw/swap と同じ競合面)
  if (bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  // entrant_ids(新・出場者ID)指定時はその選択を尊重。未指定は種目の全出場者(entrants)で生成。
  const r = db.generateBracket(req.params.id, event, { regenerate, player_ids, entrant_ids, force: !!force });
  if (r.error) return res.status(400).json(r);
  db.markSheetDirty(req.params.id, event);   // 旧経路の生成(共存フック): 確定シートとズレたら要再確定
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, event) });
});

app.get("/api/tournaments/:id/bracket", requireAdmin, (req, res) => {
  res.json(db.getBracket(req.params.id, req.query.event || ""));
});

app.delete("/api/tournaments/:id/bracket", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const event = req.query.event || req.body?.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  if (bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  const r = db.deleteEventMatches(req.params.id, event, { force: !!(req.body?.force || req.query.force) });
  if (r && r.error) return res.status(400).json(r);
  res.json(r);
});

// トーナメント表の構造チェック(生成/抽選/手修正後の整合を機械検証)
app.get("/api/tournaments/:id/bracket/validate", requireAdmin, (req, res) => {
  const event = req.query.event || "";
  if (!event) return res.status(400).json({ error: "event が必要です" });
  res.json(db.validateBracketStructure(req.params.id, event));
});

// 作成済みトーナメント表の全削除(全種目一括・名簿は残す)。結果入力済みがあれば needs_force。
app.delete("/api/tournaments/:id/brackets", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const force = !!(req.body && req.body.force) || req.query.force === "1";
  const r = db.deleteAllBrackets(req.params.id, { force });
  if (r.error) return res.status(r.needs_force ? 409 : 400).json(r);
  res.json(r);
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
    // 待機理由(観戦live/viewerで表示)。内部の locked_by_match(試合UUID) は観戦に不要なので落とす。
    blocks: (m.blocks || []).map(({ locked_by_match, ...b }) => b), is_blocked: m.is_blocked,
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
    vs_prev: st.vs_prev,   // 対昨年 進捗レース(未指定/データ無しは null=フロントはグレースフル)
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

app.get("/api/tournaments/:id/operations", requireAdmin, (req, res) => {
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
app.get("/api/tournaments/:id/team-rosters", requireAdmin, (req, res) => {
  res.json({ rosters: db.getTeamRosters(req.params.id) });
});

// 各種目のベスト8 (準々決勝進出者・氏名+所属) — 進行管理で常時表示 #208
app.get("/api/tournaments/:id/best8", requireAdmin, (req, res) => {
  res.json({ events: db.getAllBest8(req.params.id) });
});

// ─── DB スナップショット (試合中の自動バックアップ + 手動保存/復元) ───────────
// バックアップ/復元/DB全体ダウンロードは「全件PIIを動かす/上書きする」最重要操作のため、
// 普段使いの管理キーではなく上級の OWNER_KEY (requireOwner) の背後へ隔離した。
// 一覧 (名前/サイズ/日時のみ・中身は返さない)
app.get("/api/admin/snapshots", requireOwner, (req, res) => {
  res.json({ snapshots: db.listSnapshots(), auto_enabled: true,
    ongoing: db.hasOngoingTournament() });
});
// 今すぐ保存 (オーナー)
app.post("/api/admin/snapshots", requireOwner, async (req, res) => {
  try { const r = await db.createSnapshot("manual"); auditOwner(req, "backup_create", r && r.name); res.json(r); }
  catch (e) { res.status(500).json({ error: "保存に失敗しました: " + e.message }); }
});
// 機密の .db ファイル送出の共通ヘルパ: 全PIIを含むため共有キャッシュ禁止(no-store)+noindex を硬化。
// send 既定の 'public, max-age=0'+ETag を上書きし、機密DBが中間キャッシュに残らないようにする。
function sendDbFile(res, p, filename) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (filename) res.download(p, filename); else res.download(p);
}
// ダウンロード (オーナー・POST で X-Owner-Key を送らせる。ファイルをそのまま返す=全PII)
app.post("/api/admin/snapshots/download", requireOwner, (req, res) => {
  const name = (req.body && req.body.name) || "";
  const p = db.snapshotPath(name);
  if (!p) return res.status(404).json({ error: "スナップショットが見つかりません" });
  auditOwner(req, "backup_download", name);
  sendDbFile(res, p);
});
// 復元成功時:応答を確実に送り切ってからプロセスを再起動する(systemd が復元後DBで再オープン)。
// 固定msの当て推量ではなく res 'finish'(本体送出完了)を契機にし、復元レスポンス自体の誤502を減らす。
function _restartAfterResponse(res, label) {
  let done = false;
  const go = () => {
    if (done) return; done = true;
    console.log("[restore] " + label + " → プロセスを再起動します");
    setTimeout(() => process.exit(0), 50);
  };
  res.on("finish", go);   // 本体がOSソケットへ送出完了(=nginxが受け取り済)
  res.on("close", go);    // 途中切断でも再起動は必要(冪等)
  setTimeout(go, 3000).unref();   // 保険: finish が来なくても3秒で再起動
}
// 復元 (オーナー・破壊的)。安全網スナップを取ってから差し替え、プロセス再起動。
app.post("/api/admin/snapshots/restore", requireOwner, (req, res) => {
  const name = (req.body && req.body.name) || "";
  // 復元はDB全体(=owner_audit表ごと)を差し替えるため、復元後DBには監査が載らない。
  // ① 名前を先に検証 → ② DBクローズ前に監査を書く(prerestore安全網に残る) →
  // ③ systemd journal にも残す(外部の durable トレイル) → ④ 実行。最も破壊的な操作の証跡を確保。
  if (!db.snapshotPath(name)) return res.status(404).json({ error: "スナップショットが見つかりません" });
  auditOwner(req, "db_restore", name);
  console.log("[owner-audit] db_restore");
  let r;
  try { r = db.restoreSnapshot(name); }
  catch (e) { return res.status(500).json({ error: "復元に失敗しました: " + e.message }); }
  if (r.error) {
    res.status(400).json(r);
    if (r.restart_required) _restartAfterResponse(res, "snapshot:" + name + " (差替失敗)");
    return;
  }
  res.json(r);
  if (r.restart_required) _restartAfterResponse(res, "snapshot:" + name);
});

// ─── オーナー (上級管理者) 専用ルート ───────────────────────────
// 鍵検証だけを行う(UIのロック解除に使用)。成功で操作可能を示す。
app.get("/api/owner/verify", requireOwner, (req, res) => res.json({ ok: true }));
// 運営アプリのモード切替。運営アカウントの通常権限でできる(オーナー確認は要らない)。データは消えない。
app.put("/api/app-mode", requireAdmin, (req, res) => {
  const mode = String((req.body && req.body.mode) || "");
  if (!appMode.MODES.includes(mode)) return res.status(400).json({ error: "mode は full / entry のどちらかです" });
  if (appMode.MODES.includes(process.env.KTTA_APP_MODE)) {
    return res.status(409).json({ error: "サーバーの環境変数 KTTA_APP_MODE で固定されているため、ここでは切り替えられません" });
  }
  db.kvSet(appMode.KV_KEY, mode);
  auditOwner(req, "app_mode:" + mode, mode);
  res.json({ mode });
});
// オーナー機能が構成されているか(鍵不要・真偽のみ)。UIが入口を出すかの判定用。鍵自体は漏らさない。
app.get("/api/owner/configured", (req, res) => res.json({ configured: !!OWNER_KEY }));
// オーナー監査ログ。
app.get("/api/owner/audit", requireOwner, (req, res) => res.json({ log: db.getOwnerAudit(req.query.limit) }));
app.get("/api/owner/access-audit", requireOwner, (req, res) => res.json({ log: db.listAccessAudit(req.query.limit) }));
// DB全体の保存(.dbダウンロード)。一貫スナップショットを生成してそのまま返す=全PIIを含む最重要操作。
app.get("/api/owner/db-download", requireOwner, async (req, res) => {
  try {
    const snap = await db.createSnapshot("manual");   // WAL下でも一貫スナップショット(=バックアップも兼ねる)
    const p = db.snapshotPath(snap.name);
    if (!p) return res.status(500).json({ error: "スナップショット生成に失敗しました" });
    auditOwner(req, "db_download", snap.name);
    sendDbFile(res, p, "tournament-" + snap.name.replace(/^manual_/, ""));
  } catch (e) { res.status(500).json({ error: "DB保存に失敗しました: " + e.message }); }
});
// 全選手の削除 (取り返しのつかない操作)。実行前に自動バックアップ + 件数の打鍵確認 + 担当コードを要求。
app.post("/api/owner/players/delete-all", requireOwnerStrict, async (req, res) => {
  const b = req.body || {};
  const operator = ownerAuditCode(req);
  if (!operator) return res.status(400).json({ error: "操作担当コードを入力してください（監査ログに記録します）。" });
  const total = (db.getPlayers() || []).length;
  if (Number(b.confirm) !== Number(total))
    return res.status(400).json({ error: "確認のため、現在の選手数（" + total + "）を正確に入力してください。", expected: total });
  let backup = null;
  try { backup = await db.createSnapshot("manual"); }   // 実行前に自動バックアップ(復元可能に)
  catch (e) { return res.status(500).json({ error: "事前バックアップに失敗したため中止しました: " + e.message }); }
  try {
    const r = db.deleteAllPlayers ? db.deleteAllPlayers() : null;
    auditOwner(req, "players_delete_all", "deleted=" + total + " backup=" + (backup && backup.name));
    res.json({ ok: true, deleted: total, backup: backup && backup.name });
  } catch (e) { res.status(500).json({ error: "削除に失敗しました: " + e.message }); }
});
// 選手登録台帳(registry.json)と選手DBの統合(2026-11-15・オーナー)。台帳を優先し、削除はしない。
// apply なし=件数と保留の一覧だけ返す(書き込まない)。apply=true は事前バックアップ+担当コード必須。
app.post("/api/owner/player-registry/sync", requireOwner, async (req, res) => {
  const b = req.body || {};
  let reg = b.registry;
  // 選手登録リスト(.xlsx)をそのまま受け付ける(画面から base64 で送る)。読むのは「選手一覧」シートだけ。
  if (!reg && b.xlsx_base64) {
    try {
      const XLSX = require("xlsx");
      const wb = XLSX.read(Buffer.from(String(b.xlsx_base64), "base64"), { type: "buffer" });
      const ws = wb.Sheets["選手一覧"];
      if (!ws) return res.status(400).json({ error: "「選手一覧」シートが見つかりません。選手登録リストのExcelを選んでください" });
      reg = db.registryFromSheetRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }));
      if (reg.error) return res.status(400).json({ error: reg.error });
    } catch (e) { return res.status(400).json({ error: "Excelを読めませんでした: " + e.message }); }
  }
  if (!reg || typeof reg !== "object" || !reg.players || typeof reg.players !== "object")
    return res.status(400).json({ error: "選手登録リスト(.xlsx)か registry.json を選んでください" });
  const brief = (r) => {
    const { plan, ...counts } = r;
    return { ...counts, hold_list: plan.hold.map(h => ({ no: h.no, name: h.name, furigana: h.furigana, team: h.team,
      candidates: h.candidates.map(c => ({ name: c.name, furigana: c.furigana, team: c.team, reason: c.reason })) })) };
  };
  if (!b.apply) {
    try { return res.json(brief(db.syncPlayerRegistry(reg))); }
    catch (e) { return res.status(500).json({ error: "照合に失敗しました: " + e.message }); }
  }
  const operator = ownerAuditCode(req);
  if (!operator) return res.status(400).json({ error: "操作担当コードを入力してください（監査ログに記録します）。" });
  let backup = null;
  try { backup = await db.createSnapshot("manual"); }
  catch (e) { return res.status(500).json({ error: "事前バックアップに失敗したため中止しました: " + e.message }); }
  try {
    const r = brief(db.syncPlayerRegistry(reg, { apply: true, operator }));
    auditOwner(req, "player_registry_sync", `merged=${r.merged_pairs} updated=${r.updated} created=${r.created} prod_only=${r.prod_only} hold=${r.hold} backup=${backup && backup.name}`);
    res.json({ ...r, backup: backup && backup.name, players_now: (db.getPlayers() || []).length });
  } catch (e) { res.status(500).json({ error: "統合に失敗しました(変更は取り消されています): " + e.message, backup: backup && backup.name }); }
});
// アップロードした .db / .db.gz から復元 (DR用・オーナー)。オフサイト退避(お名前ドットコム等)から
// 落としたバックアップを、ローカルスナップショットが無い新サーバでも取り込めるようにする。
// multer のファイル種別エラーは下の (err,req,res,next) で 400 整形。
app.post("/api/owner/restore-upload", requireOwner,
  (req, res, next) => uploadDb.single("file")(req, res, (err) => err ? res.status(400).json({ error: err.message || "アップロードに失敗しました" }) : next()),
  (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ファイルがありません（.db または .db.gz）" });
  const name = req.file.originalname || "upload";
  // 復元はDB全体(=owner_audit表ごと)を差し替えるため、close 前に監査 + journal に残す。
  auditOwner(req, "db_restore_upload", name);
  console.log("[owner-audit] db_restore_upload");
  let r;
  try { r = db.restoreFromUpload(req.file.path, name); }
  catch (e) { r = { error: "復元に失敗しました: " + e.message }; }
  try { fs.rmSync(req.file.path, { force: true }); } catch (e) {}   // アップロード一時ファイルを掃除
  if (r.error) {
    res.status(400).json(r);
    if (r.restart_required) _restartAfterResponse(res, "upload:" + name + " (差替失敗)");
    return;
  }
  res.json(r);
  if (r.restart_required) _restartAfterResponse(res, "upload:" + name);
});

app.get("/api/public/tournaments/:id/live", requirePublicTournament, (req, res) => {
  const entry = getCachedLiveJSON(req.params.id);
  if (!entry) return res.status(404).json({ error: "大会が見つかりません" });
  // 進行fingerprint(entry.key)を ETag 化。未変化のポーリングは 304(本体なし)で返し帯域/再シリアライズを節約。
  // 直列化済み文字列をそのまま返す (再シリアライズなし)。短期ブラウザ/CDNキャッシュも許可。
  if (conditional(req, res, entry.key, "public, max-age=2")) return;
  return res.type("application/json").send(entry.json);
});

// 進行の変化検知用 軽量エンドポイント (クライアントは変化時のみ重い /live を取得)
app.get("/api/public/tournaments/:id/ops-version", requirePublicTournament, (req, res) => {
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
app.get("/api/public/tournaments/:id/match-list", requirePublicTournament, (req, res) => {
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

app.get("/api/public/tournaments/:id/ops-stream", requirePublicTournament, (req, res) => {
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

// 選手個人の試合状況は、本人セッションだけが読める。選手IDの推測では到達できない。
app.get("/api/player/me/live-status", requireSession(["player"]), (req, res) => {
  const status = db.getPlayerLiveStatus(req.auth.principal_id, req.query.tournament_id);
  if (!status) return res.status(404).json({ error: "選手が見つかりません" });
  res.json(status);
});
// 旧URLは選手IDだけで本人の試合状況を取得できたため、明示的に廃止する。
app.all("/api/public/players/:id/live-status", (req, res) => {
  res.status(410).json({ error: "このURLは廃止されました。本人確認後のマイページをご利用ください。" });
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
  if (!sessionHas(req, "player")) return res.status(401).json({ error: "選手本人のログインが必要です" });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get("Origin");
    if (!origin || origin !== appOriginOf(req)) return res.status(403).json({ error: "この操作は同一サイトからのみ実行できます" });
  }
  if (!PUSH_ENABLED) return res.status(503).json({ error: "プッシュ通知は無効です" });
  const { subscription } = req.body || {};
  const player_id = req.auth.principal_id;
  if (!subscription) return res.status(400).json({ error: "subscription が必要です" });
  if (!isAllowedPushEndpoint(subscription.endpoint))
    return res.status(400).json({ error: "購読エンドポイントが不正です" });   // #8 SSRF対策
  const r = db.savePushSubscription(player_id, subscription);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", requireSession(["player"]), (req, res) => {
  const ep = (req.body || {}).endpoint;
  res.json(db.deletePushSubscriptionForPlayer(req.auth.principal_id, ep));
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
  if (r.conflict) return res.status(409).json(r);   // 同時編集の衝突: 別端末が先に別結果で確定済み
  if (r.error) return res.status(400).json(r);      // 入力不整合(団体戦 星取×勝者指定の矛盾 等)
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
app.get("/api/tournaments/:id/op-log", requireAdmin, (req, res) => {
  res.json({ log: db.getOpLog(req.params.id, req.query.limit) });
});
app.post("/api/tournaments/:id/undo-last", requireAdmin, (req, res) => {
  const r = db.undoLastOp(req.params.id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
// 統合Undo(元に戻す): 編集操作(op_log)があればそれを、無ければ種目の抽選(draw_log)を取り消す。
app.post("/api/tournaments/:id/undo", requireAdmin, (req, res) => {
  const r = db.undoLast(req.params.id, req.body?.event || "");
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
// 対昨年 進捗レース: 「昨年の同大会」への手動リンク設定/解除。body: { compare_id?:string(空で解除) }
app.put("/api/admin/tournaments/:id/compare", requireAdmin, (req, res) => {
  const r = db.setCompareTournament(req.params.id, (req.body && req.body.compare_id) || "");
  if (r && r.error) return res.status(400).json(r);
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

// 審判が会場の他端末から到達できる base URL を決める。localhost/127.0.0.1 でアクセスしている
// (本部PCで開いた)場合は、QRに埋めても他端末から繋がらないため LAN IP に自動置換する。?base= で明示も可。
function refBaseUrl(req) {
  const explicit = String((req.query && req.query.base) || "").trim().replace(/\/$/, "");
  if (explicit) return explicit;
  const host = req.get("host") || ("localhost:" + PORT);
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?)/.test(host)) {
    const lan = lanIPv4s()[0];
    if (lan) return "http://" + lan + ":" + PORT;
  }
  return (req.protocol || "http") + "://" + host;
}

// コート別 審判QR: 認証情報はURLフラグメントへ置く。#以降はHTTPリクエスト・プロキシログ・
// Refererに送られず、審判ページが初回だけCookieへ交換した直後に履歴からも消す。
// ローカル生成QR(qrcode 同梱)付きで返す。審判は担当コートのQRをスキャンするだけで入力に入れる
// (長いトークン付きURLの手入力=伝達難易度 を回避)。?courts=N で枚数、?base= で接続先を指定可。
app.get("/api/admin/tournaments/:id/referee-court-qr", requireAdmin, async (req, res) => {
  const links = db.getRefereeCourtLinks(req.params.id);
  if (!links) return res.status(400).json({ error: "審判入力が有効ではありません（先に「有効にする」を押してください）" });
  const t = db.getTournament(req.params.id);
  const base = refBaseUrl(req);
  // 枚数: 指定 > court_count > グリッド。多すぎる無駄を避けるため上限40。
  const want = parseInt(req.query.courts) || (t && t.court_count) || links.count;
  const n = Math.max(1, Math.min(want, links.count, 40));
  const courts = [];
  for (const l of links.links.slice(0, n)) {
    const url = base + "/ref#tid=" + encodeURIComponent(links.tournament_id) + "&court=" + l.court + "&ct=" + l.key;
    let qr = "";
    try { qr = await QRCode.toString(url, { type: "svg", margin: 1, width: 150 }); } catch (e) {}
    courts.push({ court: l.court, url, qr });
  }
  res.json({
    tournament_id: links.tournament_id, tournament_name: links.tournament_name, base, count: n,
    passcode_required: !!(t && t.referee_passcode_required),
    courts,
  });
});

// 管理用 ローカルQR (機密URL向け: 審判トークン等を公開エンドポイントのアクセスログに残さない)。
// 返り値はインラインSVG文字列。<img> ではなくDOMへ直接挿入して使う。
app.get("/api/admin/qr", requireAdmin, async (req, res) => {
  const text = String((req.query && req.query.text) || "");
  if (!text || text.length > 1024) return res.status(400).json({ error: "textが不正です" });
  const size = Math.max(120, Math.min(parseInt(req.query.size) || 240, 480));
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1, width: size });
    res.json({ svg });
  } catch (e) { res.status(500).json({ error: "QR生成に失敗しました" }); }
});

// 公開 ローカルQR (非機密URL向け: 観戦ビュー共有など)。会場オフラインで外部QRサービスに依存しない。
// 濫用対策: 認証なしのため長さ上限+レート制限。出力は純粋な<path>のSVG(スクリプト無)で安全。
app.get("/api/qr.svg",
  rateLimit({ windowMs: 60000, max: 120, message: "リクエストが多すぎます。少し待って再試行してください。" }),
  async (req, res) => {
  const text = String((req.query && req.query.text) || "");
  if (!text || text.length > 512) return res.status(400).type("text/plain").send("bad text");
  const size = Math.max(120, Math.min(parseInt(req.query.size) || 260, 480));
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1, width: size });
    res.set("Content-Type", "image/svg+xml; charset=utf-8");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(svg);
  } catch (e) { res.status(500).type("text/plain").send("qr error"); }
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

// 審判のセットカウント速報 (表示専用の暫定値・観戦画面の「2-1 第4セット」用)。
// finish(最終報告・承認制)とは別経路: 進出処理も承認も無く、確定/呼出/戻すで消える。
// ガード列は finish と同一(パスコード/大会一致/コート一致/on_table)。op_id は冪等ミドルウェアが拾う。
// recordOp は呼ばない(undo対象の結果操作ではない・セット毎の更新でop_logを埋めない)。
app.post("/api/ref/matches/:id/live-score",
  rateLimit({ windowMs: 60000, max: 240, message: "送信が多すぎます。少し待って再試行してください。" }),
  requireReferee, (req, res) => {
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
  if (req.refCourt && Number(m.table_no) !== Number(req.refCourt))
    return res.status(403).json({ error: "このリンクはコート" + req.refCourt + "専用です。担当コートの試合のみ報告できます。" });
  if (m.status !== "on_table")
    return res.status(409).json({ error: "この試合は現在コートに入っていません。" });
  const r = db.setLiveScore(req.params.id, { s1: req.body && req.body.s1, s2: req.body && req.body.s2, by: "referee" });
  if (r && r.error) return res.status(400).json(r);
  res.json({ ok: true, live: r.live });
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
  if (r.conflict) return res.status(409).json(r);   // 同時編集の衝突: 別端末が先に別結果で確定済み
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
app.get("/api/tournaments/:id/bracket/export", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (event) {
    const data = db.exportBracket(req.params.id, event);
    if (!data) {
      // 大会が無い=404。大会はあるが表が未生成=200(error文言で呼出元が「未作成」表示)。
      // 「未生成」を404にすると正常運用でもブラウザのコンソールが404で汚れるため200で返す。
      if (!db.getTournament(req.params.id)) return res.status(404).json({ error: "大会が見つかりません" });
      return res.json({ error: "この種目のトーナメント表はまだありません", no_bracket: true });
    }
    if (data && typeof data === "object" && !Array.isArray(data)) data.bracket_rev = db.bracketRev(req.params.id, event);
    res.json(data);
  } else {
    const data = db.exportAllBrackets(req.params.id);
    if (!data) return res.status(404).json({ error: "大会が見つかりません" });
    res.json(data);
  }
});
// 同じデータを公開API側でも取得可能（読み取り専用）
app.get("/api/public/tournaments/:id/bracket/export", requirePublicTournament, (req, res) => {
  const event = req.query.event;
  if (event) {
    const data = db.exportBracket(req.params.id, event);
    if (!data) {
      // 大会が無い=404。大会はあるが表が未生成=200(error文言で呼出元が「未作成」表示)。
      // 「未生成」を404にすると正常運用でもブラウザのコンソールが404で汚れるため200で返す。
      if (!db.getTournament(req.params.id)) return res.status(404).json({ error: "大会が見つかりません" });
      return res.json({ error: "この種目のトーナメント表はまだありません", no_bracket: true });
    }
    if (data && typeof data === "object" && !Array.isArray(data)) data.bracket_rev = db.bracketRev(req.params.id, event);
    res.json(data);
  } else {
    const data = db.exportAllBrackets(req.params.id);
    if (!data) return res.status(404).json({ error: "大会が見つかりません" });
    res.json(data);
  }
});

app.post("/api/tournaments/:id/bracket/import", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const _ev = req.body && req.body.event;
  if (_ev && bracketRevStale(req.params.id, _ev, req.body)) return sendBracketConflict(res, req.params.id, _ev);
  const r = db.importBracket(req.params.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  if (_ev) db.markSheetDirty(req.params.id, _ev);   // 旧経路の取込(共存フック)
  res.json(_ev ? { ...r, bracket_rev: db.bracketRev(req.params.id, _ev) } : r);
});

// ドラッグ&ドロップ: 1回戦の選手位置を入れ替え
// トーナメント表の手動ロック(種目単位)。ロック中は入替・スロット編集を拒否。
app.post("/api/tournaments/:id/bracket/lock", requireAdmin, (req, res) => {
  const { event, locked } = req.body || {};
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.setBracketLock(req.params.id, event, locked === true);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// エクセル風 枠グリッド用データ(トーナメント管理タブ): 1回戦スロット×entrant 結合
app.get("/api/tournaments/:id/bracket/grid", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const data = db.getBracketGrid(req.params.id, event);
  if (!data) return res.status(404).json({ error: "ブラケットが見つかりません" });
  data.bracket_rev = db.bracketRev(req.params.id, event);
  res.json(data);
});
// 氏名/所属の編集を表(matches の非正規化名)へ波及。割当・結果は変えず name/team のみ再同期。
// 冪等(現entrantの表示名を該当スロットへ反映するだけ)で、スロット移動とは直交するため base_rev ガードは付けない
// (名前編集の本来の楽観ロックは entrant 側 occStale が担う)。同時にスロット入替があっても安全に共存する。
app.post("/api/tournaments/:id/bracket/resync-names", requireAdmin, (req, res) => {
  const event = req.body && req.body.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.syncEntrantsToBracket(req.params.id, event);
  if (r && r.error) return res.status(400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, event) });
});
// ダブルスのペア構成を組み替え(2ペアの相方を交換)。body: { event, a_entrant_id, b_entrant_id, base_rev }
app.post("/api/tournaments/:id/bracket/swap-partner", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const b = req.body || {};
  if (!b.event) return res.status(400).json({ error: "event が必要です" });
  if (bracketRevStale(req.params.id, b.event, b)) return sendBracketConflict(res, req.params.id, b.event);
  const r = db.swapEntrantPartners(req.params.id, b.event, b.a_entrant_id, b.b_entrant_id);
  if (r && r.error) return res.status(400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, b.event) });
});
// 整合性チェック(ダブルス並び): 種目内の全ダブルスの選手1↔選手2を一括入替。body: { event, base_rev }
app.post("/api/tournaments/:id/bracket/swap-doubles-order", requireAdmin, blockOngoingBracketEdit, (req, res) => {
  const event = req.body && req.body.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  if (bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  const r = db.swapDoublesOrder(req.params.id, event);
  if (r && r.error) return res.status(400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, event) });
});

// ═══ 割当表(案B P3-2): 座席表エディタの読み書きAPI ═══════════════════════
// 注意: これらは blockOngoingBracketEdit を通さない(下書き編集はmatchesに触れず、確定の可否は
// confirmSheet が「進行中は新種目の初回確定のみ可」というより正確なルールで判定するため)。
app.get("/api/tournaments/:id/bracket/sheet", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  res.json(db.getSheetState(req.params.id, event));
});
app.post("/api/tournaments/:id/bracket/sheet/draft", requireAdmin, (req, res) => {
  const event = req.body && req.body.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.ensureDraftSheet(req.params.id, event);
  if (r && r.error) return res.status(400).json(r);
  res.json({ ok: true, draft: { ...r, seats: r.seats } });
});
app.post("/api/tournaments/:id/bracket/sheet/ops", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.event) return res.status(400).json({ error: "event が必要です" });
  const r = db.applySheetOps(req.params.id, b.event, b.base_hash || "", b.ops || []);
  if (r && r.conflict) return res.status(409).json(r);
  if (r && r.error) return res.status(400).json(r);
  res.json(r);
});
app.post("/api/tournaments/:id/bracket/sheet/undo", requireAdmin, (req, res) => {
  const event = req.body && req.body.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.undoSheetOp(req.params.id, event);
  if (r && r.error) return res.status(400).json(r);
  res.json(r);
});
// 取込用テンプレExcel(種目タイプ別・番号一致保証)。type未指定は event_config から自動判定。
app.get("/api/tournaments/:id/bracket/roster-template.xlsx", requireAdmin, (req, res) => {
  try {
    const tournament = db.getTournament(req.params.id);
    if (!tournament) return res.status(404).json({ error: "大会が見つかりません" });
    const event = req.query.event || "";
    let type = req.query.type || "";
    if (!type) {
      try {
        const cfg = JSON.parse(tournament.event_config || "[]").find(c => c && c.name === event) || {};
        type = cfg.type === "team" ? "team" : (/ダブルス/.test(event) || cfg.type === "doubles") ? "doubles" : "singles";
      } catch (e) { type = "singles"; }
    }
    const buf = reports.buildRosterTemplateXlsx(tournament, event, type);
    const safe = (s) => String(s || "").replace(/[^\w一-龯ぁ-んァ-ヶー]/g, "_");
    const filename = encodeURIComponent(`取込テンプレ_${safe(event) || type}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) { res.status(500).json({ error: "テンプレ生成に失敗: " + e.message }); }
});
// 白紙トーナメント表(罫線のみ・大会非依存)。人数を入れるだけで手書き記入用の空ブラケットを出す。
app.get("/api/blank-bracket.xlsx", requireAdmin, (req, res) => {
  try {
    const size = Number(req.query.size);   // parseInt だと 16.5 が黙って 16 になるため Number で厳格化
    if (!Number.isInteger(size) || size < 2 || size > 1024) {
      return res.status(400).json({ error: "size は 2〜1024 の整数で指定してください" });
    }
    const buf = reports.buildBlankBracketXlsx({
      size,
      title: String(req.query.title || "").slice(0, 100),
      event: String(req.query.event || "").slice(0, 50),
      date: String(req.query.date || "").slice(0, 20),
      venue: String(req.query.venue || "").slice(0, 100),
      positionsFn: db.bracketPositions,
    });
    const filename = encodeURIComponent(`白紙トーナメント表_${size}名.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${filename}`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) { res.status(500).json({ error: "白紙トーナメント表の生成に失敗: " + e.message }); }
});
// 下書きシートの表プレビュー(統合エディタ用): 「確定するとこうなる」木を書込なしで返す
app.get("/api/tournaments/:id/bracket/sheet/bracket-preview", requireAdmin, (req, res) => {
  const event = req.query.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  const r = db.previewSheetBracket(req.params.id, event);
  if (r && r.error) return res.status(400).json(r);
  res.json(r);
});
// 版間差分(A4差分掲示票の材料): 第from版→第to版の変更一覧
app.get("/api/tournaments/:id/bracket/sheet/diff", requireAdmin, (req, res) => {
  const event = req.query.event;
  const from = parseInt(req.query.from), to = parseInt(req.query.to);
  if (!event || !Number.isInteger(from) || !Number.isInteger(to)) {
    return res.status(400).json({ error: "event, from, to が必要です" });
  }
  const r = db.getSheetDiffBetween(req.params.id, event, from, to);
  if (r && r.error) return res.status(400).json(r);
  res.json(r);
});
// 出力履歴の記録(管理画面の明示的な印刷・出力操作のみが呼ぶ。公開GETは記録しない)
app.post("/api/tournaments/:id/bracket/print-log", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.event) return res.status(400).json({ error: "event が必要です" });
  res.json(db.recordPrintLog(req.params.id, b.event, b.kind || ""));
});
app.post("/api/tournaments/:id/bracket/sheet/confirm", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.event) return res.status(400).json({ error: "event が必要です" });
  const r = db.confirmSheet(req.params.id, b.event, { by: b.by || "", reason: b.reason || "", force: !!b.force });
  if (r && r.needs_force) return res.status(400).json(r);
  if (r && r.error) return res.status(r.ongoing ? 403 : 400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, b.event) });
});
// 当日の変更(進行中でも可): 2枠入替(両者未開始)/補欠差替(未配置→枠)。理由必須・必ず新版採番。
app.post("/api/tournaments/:id/bracket/sheet/patch", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.event) return res.status(400).json({ error: "event が必要です" });
  const r = db.patchSheet(req.params.id, b.event, b);
  if (r && r.error) return res.status(400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, b.event) });
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
  const before = db.getEntrant(req.params.pid);
  const r = db.setEntrantStatus(req.params.pid, status);
  if (r.error) return res.status(404).json(r);
  if (before) backupFromChange(db.recordAdminEntrantChange(before, db.getEntrant(req.params.pid)));
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
app.delete("/api/submissions/:id/pii", requireOwner, (req, res) => {
  const r = db.deleteSubmissionPII(req.params.id, { revoke_tokens: true });
  if (r.error) return res.status(404).json(r);
  auditOwner(req, "pii_delete_one", "submission=" + req.params.id);
  res.json(r);
});
// 保持期間超過の申込原本PIIを手動で一括匿名化(?days=N)。env PII_RETENTION_DAYS 既定。
app.post("/api/admin/purge-submission-pii", requireOwner, (req, res) => {
  const days = req.query.days || req.body?.days || process.env.PII_RETENTION_DAYS;
  const r = db.purgeOldSubmissionPII(days);
  auditOwner(req, "pii_purge_old", "days=" + (days || ""));
  res.json(r);
});
app.post("/api/tournaments/:id/entries/:pid/fix", requireAdmin, (req, res) => {
  const before = db.getEntrant(req.params.pid);
  const r = db.fixEntrant(req.params.pid, req.body || {});
  if (r.error) return res.status(400).json(r);
  if (before) backupFromChange(db.recordAdminEntrantChange(before, db.getEntrant(req.params.pid)));
  res.json(r);
});
// 申込の選手照合(案A): 自動一致・要確認・新規候補の一覧と、人による確定。
app.get("/api/tournaments/:id/player-matches", requireAdmin, (req, res) => {
  res.json(db.getPlayerMatchReview(req.params.id));
});
app.post("/api/tournaments/:id/player-matches/rematch", requireAdmin, (req, res) => {
  res.json(db.rematchTournamentPlayers(req.params.id));
});
app.post("/api/entrants/:id/player-match", requireAdmin, (req, res) => {
  const b = req.body || {};
  const r = db.resolveEntrantPlayerMatch(req.params.id, String(b.slot || ""), String(b.action || ""),
    { player_id: b.player_id, by: b.by });
  if (r.error) return res.status(r.status || 400).json(r);
  res.json(r);
});
app.post("/api/tournaments/:id/entry-issues/bulk-fix", requireAdmin, backupBeforeBulk, (req, res) => {
  res.json(withBackup(req, db.bulkFixEntrantInference(req.params.id, req.body || {})));
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

// ═══ インポート/エクスポート ══════════════════════════
app.get("/api/export/all", requireOwner, (req, res) => { auditOwner(req, "export_all", ""); res.json(db.exportAllData()); });
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
app.get("/api/lan-info", requireAdmin, async (req, res) => {
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
  const ip = clientIp(req);
  if (syncFailBlocked(ip)) return res.status(429).json({ error: "試行回数が多すぎます。しばらく待ってから再試行してください。" });
  // 本番は平文HTTPでのキー受信を拒否(X-Forwarded-Proto 準拠 / #2)。
  const isHttps = req.secure || (req.get("x-forwarded-proto") || "").split(",")[0].trim() === "https";
  if (IS_PROD && !isHttps) return res.status(400).json({ error: "同期はHTTPS必須です" });
  // 送信元IP allowlist(設定時のみ)。本部固定IP/Tunnel からのみ受理 (#3)。
  if (SYNC_ALLOW_IPS.length && !SYNC_ALLOW_IPS.includes(ip))
    return res.status(403).json({ error: "許可されていない送信元です" });
  const key = req.get("X-Sync-Key") || "";
  if (!safeEqualStr(key, SYNC_KEY)) { syncFailMark(ip); return res.status(401).json({ error: "同期キーが不正です" }); }
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
// 動作状況(メモリ・ディスク・エラー履歴)は内部情報なのでオーナーだけが見る
app.get("/api/diagnostics", requireOwner, (req, res) => {
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
app.post("/api/diagnostics/clear", requireOwner, (req, res) => {
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
// デプロイ(サーバ再起動)ごとに変わるバージョンを、index HTML 内の /shared/ と受付台帳のアセット
// 参照に注入する。これにより古い common.js 等がブラウザに残り続ける事故を根絶
// (例: TT.playerStatsSection is not a function)。
const ASSET_VER = Date.now().toString(36);
function _serveVersionedHtml(file, cacheControl = "no-cache") {
  return (req, res) => {
    fs.readFile(file, "utf8", (err, html) => {
      if (err) return res.status(404).type("html").send("<h1>not found</h1>");
      // js/css に加え、ほぼ不変のアイコン(svg/png/webp)・サブディレクトリ(/shared/assets/...)も版付与し
      // immutable 化に乗せる(毎回再検証の往復を消す)。href/src の ?v= 既存分は付け替える。
      const out = html.replace(/(\/shared\/[A-Za-z0-9_.\-/]+\.(?:js|css|svg|png|webp)|\/admin\/entry-desk\.(?:js|css))(\?v=[^"']*)?/g, `$1?v=${ASSET_VER}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", cacheControl);
      res.send(out);
    });
  };
}
app.get(["/admin", "/admin/", "/admin/index.html"], _serveVersionedHtml(path.join(publicDir, "admin", "index.html")));
app.get(["/players", "/players/"], (req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "private, no-store");
  next();
}, requireSession(["admin", "owner"]), _serveVersionedHtml(path.join(__dirname, "lib", "player-directory-preview.html"), "private, no-store"));
app.get(["/viewer", "/viewer/", "/viewer/index.html"], _serveVersionedHtml(path.join(publicDir, "viewer", "index.html")));
app.get(["/viewer/live", "/viewer/live/", "/viewer/live/index.html"], _serveVersionedHtml(path.join(publicDir, "viewer", "live", "index.html")));
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
app.use("/ref", cacheMw, express.static(path.join(publicDir, "ref"), staticOpts)); // 審判結果入力ページ

// 運用マニュアル (Markdown)
for (const docName of ["OPERATIONS.md", "UPDATE_WORKFLOW.md",
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
// 申込集計モードの公開の入口。受付中の大会だけを案内する。通常モードでは閲覧画面があるのでそちらへ。
app.get("/entry", (req, res) => {
  if (currentAppMode() !== "entry") return res.redirect(302, "/viewer");
  res.type("html").send(entryForm.buildEntryLandingHTML(db.getOpenTournaments()));
});

app.get("/entry/status", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // PII を表示するため第三者埋込を許さない(X-Frame-Options:SAMEORIGIN はミドルウェアが付与)。
  res.send(entryForm.buildApplicantStatusHTML());
});

// ── 公開申込フォーム /entry/:id ───────────────────────
// 申込者へはこのURLを案内する(WordPress等への埋込は廃止。リンクで申込フォームへ案内する)。
// 申込フォームの「Excelで一括入力」。テンプレの配布と、記入済みファイルの読み取りだけを行う。
// 読み取り結果はフォームの入力欄へ流し込むだけで、登録は通常の送信(submit-team-entry)に任せる
// =必須チェック・同じ種目の重複・申込番号の発行を二重に持たない。
const entryTemplate = require("./lib/entry-template");
function _templateEvents(tournament) {
  const cap = db.getEntryCapacityState(tournament.id);
  const full = new Set(((cap && cap.events) || []).filter(c => c.full).map(c => c.event));
  return _resolveEvents(tournament).map(e => ({ ...e, full: full.has(e.name) }));
}
app.get("/api/public/tournaments/:id/entry-template.xlsx", entryRateLimit, requireOpenEntryOrAdmin, (req, res) => {
  try {
    const tournament = req.entryTournament;
    const buf = entryTemplate.buildEntryTemplate({ tournament, events: _templateEvents(tournament),
      fieldConfig: db.resolveFieldConfig(tournament) });
    const fname = `申込テンプレート_${String(tournament.name || "大会").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="entry-template.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.send(buf);
  } catch (e) {
    console.error("[entry-template] 作成に失敗:", e && e.message);
    res.status(500).json({ error: "テンプレートを作成できませんでした" });
  }
});
app.post("/api/public/tournaments/:id/entry-template/read",
  entryRateLimit,
  express.text({ limit: "2mb", type: ["text/plain", "application/json"] }),
  requireOpenEntryOrAdmin,
  (req, res) => {
    const origin = req.get("Origin");
    if (origin && origin !== appOriginOf(req) && !CORS_ALLOW_ORIGINS.has(origin)) {
      return res.status(403).json({ error: "許可されていない送信元です" });
    }
    let body = req.body;
    try { if (typeof body === "string") body = JSON.parse(body); } catch (_) { body = null; }
    const b64 = body && typeof body.file === "string" ? body.file.replace(/^data:[^,]*,/, "") : "";
    if (!b64) return res.status(400).json({ error: "ファイルが空です" });
    const buf = Buffer.from(b64, "base64");
    if (!buf.length || buf.length > 1024 * 1024) {
      return res.status(400).json({ error: "ファイルが大きすぎます(1MBまで)。テンプレートの .xlsx を読み込んでください。" });
    }
    // .xlsx は zip(PK)。古い .xls(OLE)も SheetJS で読めるので許す。それ以外は読まない。
    const sig = buf.slice(0, 4).toString("hex");
    if (sig !== "504b0304" && sig !== "d0cf11e0") {
      return res.status(400).json({ error: "Excelファイル(.xlsx)を選んでください。" });
    }
    try {
      const tournament = req.entryTournament;
      const out = entryTemplate.readEntryTemplate(buf, { events: _templateEvents(tournament),
        fieldConfig: db.resolveFieldConfig(tournament) });
      if (out.error) return res.status(400).json({ error: out.error });
      res.setHeader("Cache-Control", "no-store");
      res.json(out);
    } catch (e) {
      console.error("[entry-template] 読み取りに失敗:", e && e.message);
      res.status(400).json({ error: "Excelファイルを読み取れませんでした。" });
    }
  });

// ── 申込フォームの入力補助(チーム名・選手名の候補) ────────────────────
// チーム名は個人情報ではないので出す。選手名は「氏名とふりがなだけ」を、大会ごとのスイッチがONのときだけ出す。
// 公開フォームから誰でも呼べるため、悪用(名簿の総当たり)を難しくする:
//   ・受付中の大会のフォームからだけ(受付していない大会は404)
//   ・フォームを開いたときに発行する短命チケット(30分・200回まで)が要る。チケットは再起動で無効になる
//   ・1分あたり・1日あたりのIP別の回数制限。2文字以上の入力・最大5件
//   ・送信元オリジンの確認(自分のオリジンと許可済みオリジンだけ)
const SUGGEST_KEY = crypto.randomBytes(32);   // プロセスごとに作り直す(再起動で古いチケットは使えなくなる)
const SUGGEST_TICKET_TTL_MS = 30 * 60 * 1000;
const SUGGEST_TICKET_MAX_USE = 200;
const SUGGEST_DAILY_MAX = 1500;
const _suggestUse = new Map();      // nonce → 使った回数
const _suggestDaily = new Map();    // "日付|IP" → 回数
function _suggestSign(body) { return crypto.createHmac("sha256", SUGGEST_KEY).update(body).digest("hex").slice(0, 32); }
function makeSuggestTicket(tournamentId) {
  const body = [tournamentId, Date.now() + SUGGEST_TICKET_TTL_MS, crypto.randomBytes(8).toString("hex")].join(".");
  return Buffer.from(body + "." + _suggestSign(body)).toString("base64url");
}
function useSuggestTicket(ticket, tournamentId) {
  let raw = "";
  try { raw = Buffer.from(String(ticket || ""), "base64url").toString(); } catch (_) { return false; }
  const i = raw.lastIndexOf(".");
  if (i < 0) return false;
  const body = raw.slice(0, i), sig = raw.slice(i + 1);
  const want = _suggestSign(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  const [tid, exp, nonce] = body.split(".");
  if (tid !== String(tournamentId) || Number(exp) < Date.now()) return false;
  const n = (_suggestUse.get(nonce) || 0) + 1;
  if (n > SUGGEST_TICKET_MAX_USE) return false;
  _suggestUse.set(nonce, n);
  return true;
}
setInterval(() => {   // 古い記録を掃除(メモリを増やし続けない)
  if (_suggestUse.size > 5000) _suggestUse.clear();
  const today = new Date().toISOString().slice(0, 10);
  for (const k of _suggestDaily.keys()) if (!k.startsWith(today)) _suggestDaily.delete(k);
}, 10 * 60 * 1000).unref();
const suggestTicketRateLimit = rateLimit({ windowMs: 60000, max: 10 });
const suggestRateLimit = rateLimit({ windowMs: 60000, max: 60 });
function suggestGuard(req, res, next) {
  const origin = req.get("Origin");
  if (origin && origin !== appOriginOf(req) && !CORS_ALLOW_ORIGINS.has(origin)) {
    return res.status(403).json({ error: "許可されていない送信元です" });
  }
  const day = new Date().toISOString().slice(0, 10) + "|" + clientIp(req);
  const used = (_suggestDaily.get(day) || 0) + 1;
  _suggestDaily.set(day, used);
  if (used > SUGGEST_DAILY_MAX) return res.status(429).json({ error: "候補の取得が多すぎます。明日またお試しください。" });
  if (!useSuggestTicket(req.get("X-Suggest-Ticket"), req.params.id)) {
    return res.status(401).json({ error: "候補を使うには、フォームを開き直してください。" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  next();
}
app.post("/api/public/tournaments/:id/suggest-ticket", suggestTicketRateLimit, requireOpenEntryOrAdmin, (req, res) => {
  const origin = req.get("Origin");
  if (origin && origin !== appOriginOf(req) && !CORS_ALLOW_ORIGINS.has(origin)) {
    return res.status(403).json({ error: "許可されていない送信元です" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ ticket: makeSuggestTicket(req.entryTournament.id), players: !!req.entryTournament.entry_suggest_players });
});
app.get("/api/public/tournaments/:id/suggest/teams", suggestRateLimit, requireOpenEntryOrAdmin, suggestGuard, (req, res) => {
  res.json({ items: db.suggestTeams(String(req.query.q || "").slice(0, 40)) });
});
app.get("/api/public/tournaments/:id/suggest/players", suggestRateLimit, requireOpenEntryOrAdmin, suggestGuard, (req, res) => {
  if (!req.entryTournament.entry_suggest_players) return res.status(404).json({ error: "この大会では選手名の候補を出していません" });
  res.json({ items: db.suggestPlayers(String(req.query.q || "").slice(0, 40), String(req.query.team || "").slice(0, 60)) });
});

app.get("/entry/:id", requireOpenEntryOrAdmin, (req, res) => {
  try {
    const tournament = req.entryTournament;
    const events = _resolveEvents(tournament);
    // 送信先は本サーバー。正規オリジン(appOriginOf)を使う。X-Forwarded-Host は信用しない(送信先のすり替え防止)。
    const postUrl = `${appOriginOf(req)}/api/public/tournaments/${tournament.id}/submit-team-entry`;

    const html = entryForm.buildEntryFormHTML(tournament, events, {
      submit_url: postUrl,
      // 締切・参加料の案内は大会の設定だけから作る(URLの引数で書き換えさせない)
      deadline: db.entryDeadlineLabel(tournament) || "",
      payment_note: tournament.entry_payment_note || "",
      turnstile_sitekey: process.env.TURNSTILE_SITEKEY || "",
      field_config: db.resolveFieldConfig(tournament),   // 必須項目設定(空なら既定=現行フォーム相当)
      capacity: db.getEntryCapacityState(tournament.id), // 定員・残り枠(満員種目は選べなくする)
      entry_options: db.resolveEntryOptions(tournament),  // 有料オプション(弁当・懇親会など)
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    // 申込フォームは他サイトに埋め込ませない(frame-ancestors 'self' / X-Frame-Options は共通ヘッダが付ける)。
    // 他の制限(送信先・外部スクリプト)は従来どおり緩めておく: 旧アドレスで開いた申込ページが
    // 新しい正規アドレスへ送信できること、Turnstile を使う場合に外部スクリプトが読めることを保つため。
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self';");
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
app.get("*", (req, res, next) => {   // 未知のURLは閲覧画面に落とす。申込集計モードでは閲覧画面が無いので申込案内へ
  if (currentAppMode() === "entry") return res.redirect(302, ENTRY_LANDING);
  next();
}, _serveVersionedHtml(path.join(publicDir, "viewer", "index.html")));

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
  console.error("[FATAL] uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordError(err, null, null, 500);
  console.error("[FATAL] unhandledRejection");
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
// テスト時(require('../server'))はサーバを起動せず app と内部関数だけ公開する。
// 本番(node server.js)は require.main===module が真になり従来どおり起動・常駐する。
module.exports = { app, _resolveEvents, __test__: { deliverEntryMail, makeSuggestTicket, useSuggestTicket } };

if (require.main === module) {
setInterval(() => scheduleEntryMail(), 15000).unref();
const server = app.listen(PORT, () => {   // host未指定=0.0.0.0(全インターフェース)=LAN内の他端末から到達可能
  console.log(`\n卓球大会運営アプリ 起動中`);
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
} // end if (require.main === module)
