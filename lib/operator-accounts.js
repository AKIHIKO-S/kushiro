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
const validPassword = value => boundedPassword(value) && [...value].length >= 15;
const SESSION_MS = 8 * 60 * 60 * 1000;
const INVITE_MS = 24 * 60 * 60 * 1000;

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
  function cancelInvite(token) {
    sql().prepare("UPDATE operator_accounts SET invite_hash=NULL, invite_expires=NULL WHERE invite_hash=?").run(hashToken(token));
  }
  async function accept(token, password) {
    if (!validToken(token)) return {};
    const db = sql();
    const hash = hashToken(token);
    const row = db.prepare("SELECT id FROM operator_accounts WHERE invite_hash=? AND invite_expires>?").get(hash, Date.now());
    if (!row) return {};
    const salt = crypto.randomBytes(16);
    const derived = await derive(password, salt);
    if (!derived) return { busy: true };
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE operator_accounts SET password_hash=?, disabled=0, invite_hash=NULL, invite_expires=NULL
        WHERE id=? AND invite_hash=? AND invite_expires>?`)
        .run(`scrypt1:${salt.toString("hex")}:${derived.toString("hex")}`, row.id, hash, Date.now()).changes;
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
    const row = sql().prepare(`SELECT account_id, expires FROM operator_sessions
      JOIN operator_accounts ON operator_accounts.id=operator_sessions.account_id
      WHERE token_hash=? AND expires>? AND disabled=0`).get(hashToken(token), Date.now());
    return row ? { principal_type: "admin", principal_id: row.account_id, scope: {}, expires_at: new Date(row.expires).toISOString() } : null;
  }
  function logout(token) {
    if (validToken(token) && (db || tournamentDbPath !== ":memory:" && fs.existsSync(tournamentDbPath + ".operators.db"))) {
      sql().prepare("DELETE FROM operator_sessions WHERE token_hash=?").run(hashToken(token));
    }
  }
  function disable(id) {
    const db = sql();
    return db.transaction(() => {
      const result = db.prepare(`UPDATE operator_accounts SET disabled=1, invite_hash=NULL, invite_expires=NULL WHERE id=?`).run(id);
      db.prepare("DELETE FROM operator_sessions WHERE account_id=?").run(id);
      return result.changes > 0;
    })();
  }
  function list() {
    return sql().prepare(`SELECT id, email, CASE WHEN disabled=1 THEN 'disabled'
      WHEN password_hash IS NOT NULL THEN 'active' WHEN invite_expires>? THEN 'invited'
      ELSE 'pending' END AS status FROM operator_accounts ORDER BY email`).all(Date.now());
  }
  return { issue, cancelInvite, accept, login, session, logout, disable, list };
}

module.exports = { createOperatorAccounts, normalizeEmail, validEmail, validPassword, boundedPassword };
