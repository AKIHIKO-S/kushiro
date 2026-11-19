// 申込の控え(Google スプレッドシートへの追記)の回帰テスト。実際のGoogleにもキーにも触れない:
// 鍵はテストの中で作る使い捨ての偽物、通信は偽の fetch に差し替える。
//
// 守らせる不変条件:
//   ① 環境変数が無ければ何もしない(enabled=false・追記は失敗扱いで例外を投げない)
//   ② 認証はサービスアカウントの署名つきJWT。値は RAW で送る(「=」で始まる氏名が数式にならない)
//   ③ 追記先のタブが無ければ作り、見出し行を入れる。あれば作らない
//   ④ 通信や認証が失敗しても例外を投げず、エラー文を返す。エラー文にキーの中身が出ない
//   ⑤ 申込を行にする: 申込者の本人確認番号(トークン)・連絡先の中身は載せない
// 実行: node --test test/sheets-backup.test.js
process.env.DB_PATH = "/tmp/ktta_sheetbackup_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const sb = require("../lib/sheets-backup");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} }
});

// テスト専用の使い捨て鍵(どこにも登録されていない)
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_JSON = JSON.stringify({
  client_email: "backup-test@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});
const ENV = { GOOGLE_SA_KEY_FILE: "/fake/key.json", GOOGLE_SHEET_ID: "SHEET123", GOOGLE_SHEET_TAB: "控え" };
const readFile = (f) => { if (f === "/fake/key.json") return KEY_JSON; throw new Error("ENOENT"); };
const json = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });

function fakeGoogle({ hasTab = true, failAppend = false } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok-1", expires_in: 3600 });
    if (u.includes("batchUpdate")) return json({});
    if (u.includes(":append")) return failAppend ? json({ error: { message: "quota" } }, 429) : json({ updates: {} });
    return json({ sheets: hasTab ? [{ properties: { title: "控え" } }] : [{ properties: { title: "Sheet1" } }] });
  };
  return { fetchFn, calls };
}

test("① 環境変数が無ければ無効で、追記は例外を投げず失敗を返す", async () => {
  const b = sb.create({ env: {}, fetchFn: async () => { throw new Error("呼ばれてはいけない"); } });
  assert.strictEqual(b.enabled, false);
  assert.deepStrictEqual(await b.append([["x"]]), { ok: false, error: "未設定" });
});

test("② 署名つきJWTで認証し、値は RAW で追記する(=で始まる氏名もそのまま文字)", async () => {
  const g = fakeGoogle();
  const b = sb.create({ env: ENV, fetchFn: g.fetchFn, readFile, now: () => 1_700_000_000_000 });
  assert.strictEqual(b.enabled, true);
  const r = await b.append([["新規", "2026-11-20 10:00:00", "s1", "大会", "団体", "男子シングルス", "=HYPERLINK(\"x\")", "釧路中", "", 700, "受付済", "あり"]]);
  assert.deepStrictEqual(r, { ok: true, count: 1 });
  const tokenCall = g.calls.find(c => c.url.startsWith("https://oauth2.googleapis.com/token"));
  const form = new URLSearchParams(String(tokenCall.init.body));
  assert.strictEqual(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [h, c, sig] = form.get("assertion").split(".");
  const ok = crypto.createVerify("RSA-SHA256").update(h + "." + c).verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  assert.ok(ok, "署名が正しい");
  const claim = JSON.parse(Buffer.from(c, "base64").toString());
  assert.strictEqual(claim.iss, "backup-test@example.iam.gserviceaccount.com");
  assert.strictEqual(claim.scope, "https://www.googleapis.com/auth/spreadsheets");
  const app = g.calls.find(c2 => c2.url.includes(":append"));
  assert.match(app.url, /valueInputOption=RAW/);
  assert.match(app.url, /insertDataOption=INSERT_ROWS/);
  assert.strictEqual(app.init.headers.Authorization, "Bearer tok-1");
  assert.strictEqual(JSON.parse(app.init.body).values[0][6], "=HYPERLINK(\"x\")", "数式として解釈させない(RAW)");
});

test("③ タブが無ければ作って見出しを入れる。あれば作らない", async () => {
  const none = fakeGoogle({ hasTab: false });
  await sb.create({ env: ENV, fetchFn: none.fetchFn, readFile }).append([["a"]]);
  assert.ok(none.calls.some(c => c.url.includes("batchUpdate")), "タブを作る");
  const headerCall = none.calls.find(c => c.url.includes(":append") && JSON.parse(c.init.body).values[0][0] === sb.HEADER[0]);
  assert.ok(headerCall, "見出し行を入れる");
  const has = fakeGoogle({ hasTab: true });
  await sb.create({ env: ENV, fetchFn: has.fetchFn, readFile }).append([["a"]]);
  assert.ok(!has.calls.some(c => c.url.includes("batchUpdate")), "あれば作らない");
});

test("④ 通信失敗・キー不備でも例外を投げず、キーの中身はエラーに出ない", async () => {
  const g = fakeGoogle({ failAppend: true });
  const r = await sb.create({ env: ENV, fetchFn: g.fetchFn, readFile }).append([["a"]]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /429/);
  const noKey = await sb.create({ env: ENV, fetchFn: g.fetchFn, readFile: () => { throw new Error("EACCES /secret/path"); } }).append([["a"]]);
  assert.strictEqual(noKey.ok, false);
  assert.ok(!/BEGIN PRIVATE KEY|secret\/path/.test(noKey.error), "キーの中身やパスを出さない: " + noKey.error);
  const bad = await sb.create({ env: ENV, fetchFn: g.fetchFn, readFile: () => "not json" }).append([["a"]]);
  assert.strictEqual(bad.ok, false);
  assert.ok(!/not json/.test(bad.error));
});

test("⑤ 申込を行にする: 本人確認番号・連絡先の中身は載せない。件数と再送の対象が数えられる", () => {
  const db = require("../db");
  const t = db.createTournament({ name: "控え検証大会", date: "2099-05-04", venue: "架空会場" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [
    { name: "男子シングルス", type: "singles", fee: 700 }, { name: "男子ダブルス", type: "doubles", fee: 1000 }] });
  const r = db.createTeamEntry(t.id, {
    team_name: "架空クラブ", contact_name: "連絡 太郎", contact_tel: "0154-00-0000", contact_email: "renraku@example.invalid",
    entries: [
      { event: "男子シングルス", type: "singles", name: "架空 一郎", furigana: "かくう いちろう", team: "架空クラブ" },
      { event: "男子ダブルス", type: "doubles", name1: "架空 二郎", furigana1: "かくう じろう", team1: "架空クラブ",
        name2: "架空 三郎", furigana2: "かくう さぶろう", team2: "別クラブ" },
    ] }, "op-sheet-backup-1");
  assert.ok(r.submission_id, JSON.stringify(r));
  const b = db.buildBackupRows(r.submission_id, "新規");
  assert.strictEqual(b.rows.length, 2);
  b.rows.forEach(row => assert.strictEqual(row.length, sb.HEADER.length, "列数が見出しと一致する"));
  const flat = JSON.stringify(b.rows);
  assert.ok(!flat.includes(r.applicant_token || "NO-TOKEN"), "本人確認番号は載せない");
  assert.ok(!/renraku@example|連絡 太郎|0154-00-0000/.test(flat), "連絡先の中身は載せない");
  assert.strictEqual(b.rows[0][11], "あり", "メールは有無だけ");
  const dbl = b.rows.find(x => x[5] === "男子ダブルス");
  assert.strictEqual(dbl[6], "架空 二郎・架空 三郎");
  assert.strictEqual(dbl[7], "架空クラブ／別クラブ");
  // 送信記録: 失敗は再送の対象に残り、成功すれば外れる
  const id = db.recordBackupAttempt(b);
  assert.strictEqual(db.getBackupState(t.id).pending, 1);
  db.finishBackup(id, { ok: false, error: "quota" });
  let st = db.getBackupState(t.id);
  assert.deepStrictEqual([st.failed, st.pending, st.last_error], [1, 0, "quota"]);
  assert.strictEqual(db.listBackupToResend(t.id).length, 1);
  db.finishBackup(id, { ok: true });
  st = db.getBackupState(t.id);
  assert.deepStrictEqual([st.ok, st.failed], [1, 0]);
  assert.strictEqual(db.listBackupToResend(t.id).length, 0);
  // 個人情報の削除で、控えの送信記録(氏名を含む)も消える
  db.deleteSubmissionPII(r.submission_id);
  assert.strictEqual(db.getBackupState(t.id).ok, 0);
});
