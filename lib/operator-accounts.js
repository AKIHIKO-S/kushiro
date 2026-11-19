const crypto = require("node:crypto");
const fs = require("node:fs");
const { promisify } = require("node:util");
const Database = require("better-sqlite3");

const scrypt = promisify(crypto.scrypt);
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const secret = () => crypto.randomBytes(32).toString("base64url");
const validToken = token => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
const normalizeEmail = email => typeof email === "string" ? email.trim().toLowerCase() : "";
const validEmail = email => email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email);
const boundedPassword = value => typeof value === "string" && value.length <= 256 && [...value].length <= 128;
// オーナー方針(2026-11-19): 6文字以上で、英字・数字・記号をそれぞれ1つ以上含む。
// 短さは回数制限(ログイン1分8回/IP・同じメール宛て5分15回)と scrypt で補う。
const PASSWORD_MIN = 6;
// 氏名: 前後と連続の空白を整え、1〜40文字。制御文字と山括弧は入れさせない。
const normalizeName = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const validName = name => [...name].length >= 1 && [...name].length <= 40 && !/[\u0000-\u001f\u007f<>]/.test(name);
const validPassword = value => boundedPassword(value) && [...value].length >= PASSWORD_MIN
  && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && /[!-\/:-@\[-`{-~]/.test(value);
const SESSION_MS = 8 * 60 * 60 * 1000;
const INVITE_MS = 24 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;   // 本人が申し込むパスワード再設定のリンクは1時間だけ有効
// オーナー権限を持てる運営アカウントの上限。「全員オーナー」にならないよう、少数に固定する。
const MAX_OWNER_ACCOUNTS = 2;

function createOperatorAccounts(tournamentDbPath) {
  let db;
  let hashing = 0;
  function sql() {
    if (db) return db;
    // 大会の復元によって、停止済みアカウントやログアウト済みセッションを復活させない。
    const filename = tournamentDbPath === ":memory:" ? ":memory:" : tournamentDbPath + ".operators.db";
    if (filename !== ":memory:") {
      fs.closeSync(fs.openSync(filename, "a", 0o600));
      fs.chmodSync(filename, 0o600);
    }
    db = new Database(filename);
    db.exec(`
      CREATE TABLE IF NOT EXISTS operator_accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT,
        disabled INTEGER NOT NULL DEFAULT 0, invite_hash TEXT UNIQUE, invite_expires INTEGER
      );
      CREATE TABLE IF NOT EXISTS operator_sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES operator_accounts(id),
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operator_sessions_account ON operator_sessions(account_id);
    `);
    // 既存の運営アカウントDBへ非破壊で列を足す(既定は権限なし)。
    const cols = db.prepare("PRAGMA table_info(operator_accounts)").all().map(c => c.name);
    if (!cols.includes("owner_granted")) db.exec("ALTER TABLE operator_accounts ADD COLUMN owner_granted INTEGER NOT NULL DEFAULT 0");
    // 誰のアドレスかを一覧で分かるようにする氏名。招待からの初回登録で本人が入れる。監査ログには使わない。
    if (!cols.includes("display_name")) db.exec("ALTER TABLE operator_accounts ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    return db;
  }
  async function derive(password, salt) {
    if (hashing >= 4) return null;
    hashing++;
    try {
      return await scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    } finally { hashing--; }
  }
  function issue(email) {
    const db = sql();
    const token = secret();
    const account = db.prepare(`
      INSERT INTO operator_accounts (id, email, invite_hash, invite_expires)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET invite_hash=excluded.invite_hash, invite_expires=excluded.invite_expires
      RETURNING id
    `).get(crypto.randomUUID(), email, hashToken(token), Date.now() + INVITE_MS);
    return { id: account.id, token };
  }
  // 本人によるパスワード再設定。利用中(設定済み・停止していない)のアカウントにだけ発行し、新規作成はしない。
  // 発行しても今のパスワードは、本人がリンクから設定し直すまで使える(第三者の申込で締め出されない)。
  function issueReset(email) {
    const db = sql();
    const token = secret();
    const row = db.prepare(`UPDATE operator_accounts SET invite_hash=?, invite_expires=?
      WHERE email=? AND disabled=0 AND password_hash IS NOT NULL RETURNING id`)
      .get(hashToken(token), Date.now() + RESET_MS, email);
    return row ? { id: row.id, token } : null;
  }
  function cancelInvite(token) {
    sql().prepare("UPDATE operator_accounts SET invite_hash=NULL, invite_expires=NULL WHERE invite_hash=?").run(hashToken(token));
  }
  async function accept(token, password, name = "") {
    if (!validToken(token)) return {};
    const db = sql();
    const hash = hashToken(token);
    const row = db.prepare("SELECT id, password_hash FROM operator_accounts WHERE invite_hash=? AND invite_expires>?").get(hash, Date.now());
    if (!row) return {};
    // 初めて登録するときは氏名を必須にする(パスワード再設定のときは今の氏名を残す)
    if (!row.password_hash && !name) return { needName: true };
    const salt = crypto.randomBytes(16);
    const derived = await derive(password, salt);
    if (!derived) return { busy: true };
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE operator_accounts SET password_hash=?, disabled=0, invite_hash=NULL, invite_expires=NULL,
        display_name=CASE WHEN ?<>'' THEN ? ELSE display_name END
        WHERE id=? AND invite_hash=? AND invite_expires>?`)
        .run(`scrypt1:${salt.toString("hex")}:${derived.toString("hex")}`, name, name, row.id, hash, Date.now()).changes;
      if (!changed) return {};
      db.prepare("DELETE FROM operator_sessions WHERE account_id=?").run(row.id);
      return { id: row.id };
    })();
  }
  async function login(email, password) {
    const db = sql();
    const row = db.prepare("SELECT id, password_hash FROM operator_accounts WHERE email=? AND disabled=0").get(email);
    const [, salt, digest] = (row?.password_hash || "").split(":");
    // 存在しないアドレスでも同じ計算量にし、応答時間からアカウントを推測させない。
    const derived = await derive(password, salt ? Buffer.from(salt, "hex") : Buffer.alloc(16));
    if (!derived) return { busy: true };
    if (!digest || !crypto.timingSafeEqual(derived, Buffer.from(digest, "hex"))) return {};
    const token = secret();
    const expires = Date.now() + SESSION_MS;
    db.prepare("DELETE FROM operator_sessions WHERE expires<=?").run(Date.now());
    // 計算中に停止・再設定された場合は、検証済みの古いパスワードでセッションを作らない。
    const saved = db.prepare(`INSERT INTO operator_sessions (token_hash, account_id, expires)
      SELECT ?, id, ? FROM operator_accounts WHERE id=? AND disabled=0 AND password_hash=?`)
      .run(hashToken(token), expires, row.id, row.password_hash);
    return saved.changes ? { id: row.id, token, expires_at: new Date(expires).toISOString() } : {};
  }
  function session(token) {
    if (!validToken(token) || !db && tournamentDbPath !== ":memory:" && !fs.existsSync(tournamentDbPath + ".operators.db")) return null;
    const row = sql().prepare(`SELECT account_id, expires, email, owner_granted, display_name FROM operator_sessions
      JOIN operator_accounts ON operator_accounts.id=operator_sessions.account_id
      WHERE token_hash=? AND expires>? AND disabled=0`).get(hashToken(token), Date.now());
    // email は画面右上の「誰でログイン中か」の表示にだけ使う(本人のセッションにしか返さない)
    // owner_granted は毎回この行から読むため、剥奪・停止はログイン中の端末にも次の通信から効く。
    return row ? { principal_type: row.owner_granted ? "owner" : "admin", principal_id: row.account_id, scope: {}, expires_at: new Date(row.expires).toISOString(), kind: "account", email: row.email || "", name: row.display_name || "" } : null;
  }
  function logout(token) {
    if (validToken(token) && (db || tournamentDbPath !== ":memory:" && fs.existsSync(tournamentDbPath + ".operators.db"))) {
      sql().prepare("DELETE FROM operator_sessions WHERE token_hash=?").run(hashToken(token));
    }
  }
  function disable(id) {
    const db = sql();
    return db.transaction(() => {
      // 停止したアカウントを後で再招待しても、オーナー権限は自動では戻さない。
      const result = db.prepare(`UPDATE operator_accounts SET disabled=1, owner_granted=0, invite_hash=NULL, invite_expires=NULL WHERE id=?`).run(id);
      db.prepare("DELETE FROM operator_sessions WHERE account_id=?").run(id);
      return result.changes > 0;
    })();
  }
  function list() {
    return sql().prepare(`SELECT id, email, CASE WHEN disabled=1 THEN 'disabled'
      WHEN password_hash IS NOT NULL THEN 'active' WHEN invite_expires>? THEN 'invited'
      ELSE 'pending' END AS status, owner_granted, display_name FROM operator_accounts ORDER BY email`).all(Date.now())
      .map(({ owner_granted, display_name, ...row }) => ({ ...row, name: display_name || "", owner: owner_granted === 1 }));
  }
  // 氏名の登録・修正(オーナーが運営アカウントの表示名を直す)。空文字は「未登録」に戻す。
  function setName(id, name) {
    const v = String(name || "").trim();
    if (v && !validName(v)) return { error: "invalid" };
    const changes = sql().prepare("UPDATE operator_accounts SET display_name=? WHERE id=?").run(v, String(id || "")).changes;
    return changes ? { ok: true, name: v } : { error: "not_found" };
  }
  function isOwner(id) {
    return !!sql().prepare("SELECT 1 FROM operator_accounts WHERE id=? AND owner_granted=1").get(String(id || ""));
  }
  // オーナー権限の付与・剥奪。付与は「利用中(パスワード設定済み・停止していない)」のアカウントだけ、上限つき。
  function setOwner(id, granted) {
    const db = sql();
    return db.transaction(() => {
      const row = db.prepare("SELECT id, password_hash, disabled, owner_granted FROM operator_accounts WHERE id=?").get(String(id || ""));
      if (!row) return { error: "not_found" };
      if (!granted) {
        db.prepare("UPDATE operator_accounts SET owner_granted=0 WHERE id=?").run(row.id);
        return { ok: true, changed: row.owner_granted === 1 };
      }
      if (row.disabled || !row.password_hash) return { error: "not_active" };
      if (row.owner_granted === 1) return { ok: true, changed: false };
      const count = db.prepare("SELECT COUNT(*) AS n FROM operator_accounts WHERE owner_granted=1 AND disabled=0").get().n;
      if (count >= MAX_OWNER_ACCOUNTS) return { error: "limit" };
      db.prepare("UPDATE operator_accounts SET owner_granted=1 WHERE id=?").run(row.id);
      return { ok: true, changed: true };
    })();
  }
  return { issue, issueReset, cancelInvite, accept, login, session, logout, disable, list, isOwner, setOwner, setName };
}

module.exports = { MAX_OWNER_ACCOUNTS, PASSWORD_MIN, normalizeName, validName, createOperatorAccounts, normalizeEmail, validEmail, validPassword, boundedPassword };
