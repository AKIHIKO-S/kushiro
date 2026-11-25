// 申込バックアップ/復元のAPI(申込集計モード・オーナー限定)の試験。サーバーを待ち受けさせず、リクエストを直接アプリへ渡す。
//   ・未ログインは弾く / ダウンロードのファイル名は「YYYYMMDD_大会名_申込バックアップ」 / サーバーにファイルを残さない
//   ・プレビュー→復元→2回目は新規0件 / 別の大会は409 / 壊れたファイルは400 / 復元前の自動バックアップ名が返る / 監査ログに残る
// 実行: node --test test/entry-backup-http.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { IncomingMessage, ServerResponse } = require("http");
const { Socket } = require("net");
process.env.DB_PATH = path.join(process.env.TMPDIR || require("os").tmpdir(), "ktta_ebkh_" + process.pid + ".db");
process.env.KTTA_APP_MODE = "entry";
process.env.ADMIN_KEY = "fixture-ebk";
const db = require("../db");
const { app } = require("../server");
after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const call = (method, url, headers, body) => new Promise((resolve) => {
  const sock = new Socket(); Object.defineProperty(sock, "remoteAddress", { value: "127.0.0.1" });
  const req = new IncomingMessage(sock); req.method = method; req.url = url; req.headers = { host: "localhost" };
  Object.entries(headers || {}).forEach(([k, v]) => { req.headers[k.toLowerCase()] = v; });
  if (body != null) req.headers["content-length"] = String(Buffer.byteLength(body));
  const res = new ServerResponse(req); res.assignSocket(sock); const ch = [];
  res.write = (c) => { ch.push(Buffer.from(c)); return true; };
  res.end = (c) => { if (c) ch.push(Buffer.from(c)); resolve({ status: res.statusCode, headers: res.getHeaders(), body: Buffer.concat(ch).toString("utf8") }); };
  app(req, res); if (body != null) req.push(body); req.push(null);
});
const ADM = { "X-Admin-Key": "fixture-ebk" };
const post = (u, body, extra) => call("POST", u, { ...ADM, Origin: "http://localhost", "Content-Type": "text/plain", ...(extra || {}) }, body);

let T, T2, FILE;
test("下ごしらえ", () => {
  T = db.createTournament({ name: "HTTP検証/大会", date: "2099-12-06" });
  const EV = [{ name: "一般男子シングルス", type: "singles", fee: 700 }];
  db.updateEntrySettings(T.id, { entries_open: 1, entry_deadline: "", event_config: EV });
  const r = db.createTeamEntry(T.id, { team_name: "架空クラブ", contact_name: "連絡 担当", contact_tel: "0154-00-0000", contact_email: "bk@example.com",
    entries: [{ event: EV[0].name, type: "singles", name: "架空 太郎", furigana: "かくう たろう", team: "架空クラブ" }] }, "op-http-1", { enforce: true });
  assert.ok(!r.error, r.error);
  T2 = db.createTournament({ name: "別の大会", date: "2099-12-07" });
});

test("ダウンロード: 未ログインは弾く。オーナーだけが、ファイル名つきで保存できる(サーバーには残さない)", async () => {
  const anon = await call("GET", `/api/tournaments/${T.id}/entry-backup.json`);
  assert.ok([401, 403, 503].includes(anon.status), "未ログイン: " + anon.status);
  const r = await call("GET", `/api/tournaments/${T.id}/entry-backup.json`, ADM);
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /application\/json/);
  const cd = decodeURIComponent(r.headers["content-disposition"]);
  assert.match(cd, /^attachment;/); assert.match(cd, /\d{8}_HTTP検証_大会_申込バックアップ\.json/, "YYYYMMDD_大会名_申込バックアップ");
  assert.equal(r.headers["cache-control"], "no-store");
  FILE = r.body;
  const j = JSON.parse(FILE); assert.equal(j.counts.entry_submissions, 1); assert.equal(j.format, "ktta-entry-backup-v1");
  const x = await call("GET", `/api/tournaments/${T.id}/entry-backup.xlsx`, ADM);
  assert.equal(x.status, 200); assert.match(x.headers["content-type"], /spreadsheetml/); assert.match(decodeURIComponent(x.headers["content-disposition"]), /_申込バックアップ\(一覧\)\.xlsx/);
  const audit = db.getOwnerAudit(20).map(a => a.action); assert.ok(audit.some(a => a.startsWith("entry_backup_export:")), "書き出しも監査ログに残る");
});

test("復元: プレビュー(何も変えない)→復元→もう一度は新規0件。復元前の自動バックアップ名と監査ログ", async () => {
  const anon = await post(`/api/tournaments/${T.id}/entry-restore/preview`, FILE, { "X-Admin-Key": "" });
  assert.ok([401, 403, 503].includes(anon.status));
  const db2 = new (require("better-sqlite3"))(process.env.DB_PATH);
  db2.prepare("DELETE FROM entrants WHERE tournament_id=?").run(T.id); db2.prepare("DELETE FROM submission_tokens").run(); db2.prepare("DELETE FROM entry_submissions WHERE tournament_id=?").run(T.id); db2.close();
  const pv = await post(`/api/tournaments/${T.id}/entry-restore/preview?operator=own01`, FILE);
  assert.equal(pv.status, 200); const p = JSON.parse(pv.body);
  assert.equal(p.counts.entry_submissions.new, 1); assert.equal(db.exportEntryBackup(T.id).counts.entry_submissions, 0, "プレビューでは入らない");
  const ap = await post(`/api/tournaments/${T.id}/entry-restore?operator=own01`, FILE);
  assert.equal(ap.status, 200, ap.body); const a = JSON.parse(ap.body);
  assert.ok(a.ok && a.inserted >= 2); assert.ok(a.backup, "復元の直前に、現在のDBの自動バックアップを取っている");
  assert.equal(db.exportEntryBackup(T.id).counts.entry_submissions, 1);
  const again = JSON.parse((await post(`/api/tournaments/${T.id}/entry-restore?operator=own01`, FILE)).body);
  assert.equal(again.inserted, 0, "2回目は二重にならない");
  assert.ok(db.getOwnerAudit(20).some(x => x.action.startsWith("entry_restore:") && x.operator === "own01"), "誰が復元したかが監査ログに残る");
});

test("別の大会のファイルは409で止まる。壊れたファイルは400", async () => {
  const stop = await post(`/api/tournaments/${T2.id}/entry-restore`, FILE);
  assert.equal(stop.status, 409); assert.equal(JSON.parse(stop.body).code, "other_tournament");
  assert.equal(db.exportEntryBackup(T2.id).counts.entry_submissions, 0);
  const notJson = await post(`/api/tournaments/${T.id}/entry-restore/preview`, "これはJSONではない");
  assert.equal(notJson.status, 400); assert.match(JSON.parse(notJson.body).error, /読めませんでした/);
  const j = JSON.parse(FILE); j.tables.entrants[0].name = "改ざん";
  const tampered = await post(`/api/tournaments/${T.id}/entry-restore`, JSON.stringify(j));
  assert.equal(tampered.status, 400); assert.match(JSON.parse(tampered.body).error, /壊れて|書き換え/);
});
