// 申込の控えを Google スプレッドシートへ追記する(バックアップ用)。
//
// 方針:
//   ・アプリのDBが正本。ここは「もう一つの控え」で、失敗しても申込の受付は止めない(呼び出し側で握る)。
//   ・認証はサービスアカウント。キー(JSON)は中身をここで読むだけで、ログにも応答にも出さない。
//     環境変数には「キーのファイルパス」と「シートID」だけを置く(キーそのものを環境変数へ入れない)。
//   ・値は RAW で書く。氏名などが「=」で始まっても数式として解釈されない(式の注入を防ぐ)。
//   ・未設定(環境変数が無い)なら enabled=false で、何も起きない。
//
// 環境変数:
//   GOOGLE_SA_KEY_FILE  サービスアカウントのキー(JSON)のファイルパス(権限600推奨)
//   GOOGLE_SHEET_ID     追記先スプレッドシートのID
//   GOOGLE_SHEET_TAB    追記先のシート(タブ)名。省略時は「申込控え」。無ければ作る
const crypto = require("crypto");
const fs = require("fs");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const DEFAULT_TAB = "申込控え";

// シートの1行目(見出し)。列の並びは buildBackupRows(db.js)と一致させる。
const HEADER = ["種別", "受付日時", "申込番号", "大会名", "団体名", "種目", "選手氏名", "所属", "区分", "金額", "状態", "連絡先メール"];

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function buildJwt(key, nowSec) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600,
  }));
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + claim).sign(key.private_key);
  return head + "." + claim + "." + b64url(sig);
}

function readKey(file, readFile) {
  let raw;
  try { raw = readFile(file, "utf8"); } catch (_) { throw new Error("サービスアカウントのキーファイルを読めません"); }
  let key;
  try { key = JSON.parse(raw); } catch (_) { throw new Error("サービスアカウントのキーが JSON ではありません"); }
  if (!key || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    throw new Error("サービスアカウントのキーに client_email / private_key がありません");
  }
  return key;
}

// opts: { env, fetchFn, readFile, now }  ※テストでは偽の fetch / readFile / 時計を渡す
function create(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const fetchFn = opts.fetchFn || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const readFile = opts.readFile || fs.readFileSync;
  const now = opts.now || (() => Date.now());
  const keyFile = String(env.GOOGLE_SA_KEY_FILE || "").trim();
  const sheetId = String(env.GOOGLE_SHEET_ID || "").trim();
  const tab = String(env.GOOGLE_SHEET_TAB || "").trim() || DEFAULT_TAB;
  const enabled = !!(keyFile && sheetId && fetchFn);

  let key = null;
  let token = null;      // { value, exp(ms) }
  let tabReady = false;

  async function call(url, init, what) {
    let res;
    try { res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(20000) }); }
    catch (e) { throw new Error(what + "に接続できませんでした: " + String((e && e.message) || e).slice(0, 120)); }
    const text = await res.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = null; }
    if (!res.ok) {
      const msg = (body && body.error && (body.error.message || body.error_description || body.error)) || text || ("HTTP " + res.status);
      throw new Error(what + "に失敗(" + res.status + "): " + String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 160));
    }
    return body || {};
  }

  async function accessToken() {
    if (token && token.exp - 60000 > now()) return token.value;
    if (!key) key = readKey(keyFile, readFile);
    const assertion = buildJwt(key, Math.floor(now() / 1000));
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
    const r = await call(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, "Googleの認証");
    if (!r.access_token) throw new Error("Googleの認証で access_token が返りませんでした");
    token = { value: r.access_token, exp: now() + (Number(r.expires_in) || 3600) * 1000 };
    return token.value;
  }

  const auth = async () => ({ Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json" });

  // 追記先のタブが無ければ作り、見出し行を入れる(プロセスにつき最初の1回だけ確かめる)
  async function ensureTab() {
    if (tabReady) return;
    const headers = await auth();
    const meta = await call(`${API}/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`, { headers }, "シート情報の取得");
    const has = (meta.sheets || []).some(s => s.properties && s.properties.title === tab);
    if (!has) {
      await call(`${API}/${encodeURIComponent(sheetId)}:batchUpdate`, {
        method: "POST", headers, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] }),
      }, "シート(タブ)の作成");
      await call(`${API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent("'" + tab + "'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: "POST", headers, body: JSON.stringify({ values: [HEADER] }),
      }, "見出し行の追記");
    }
    tabReady = true;
  }

  // rows: 文字列/数値の2次元配列。成功すれば { ok: true }、失敗は { ok: false, error }。例外は投げない。
  async function append(rows) {
    if (!enabled) return { ok: false, error: "未設定" };
    if (!Array.isArray(rows) || !rows.length) return { ok: true, count: 0 };
    try {
      await ensureTab();
      const headers = await auth();
      await call(`${API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent("'" + tab + "'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: "POST", headers, body: JSON.stringify({ values: rows.map(r => r.map(v => (v == null ? "" : v))) }),
      }, "シートへの追記");
      return { ok: true, count: rows.length };
    } catch (e) {
      token = null;   // 認証切れなどの可能性があるので次回は取り直す
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
    }
  }

  return { enabled, append, tab };
}

module.exports = { create, HEADER, DEFAULT_TAB, buildJwt };
