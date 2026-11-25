// 申込フォームの最初の画面(1段目の一番上)の「Excelの入力用テンプレートをダウンロード」の回帰テスト。
//   ① 受付中のフォームは、団体名・担当者の欄より前に、入力しなくても押せるダウンロードのリンクがあり、読み込みの場所を1行で案内する
//   ② 受付終了のフォームには出さない
//   ③ テンプレートは、担当者の入力(連絡先)なしでダウンロードできる。ログインも不要
//   ④ 落としたテンプレートに記入して読み込むと、種目の行の内容が返る(フォームの入力欄へ流し込む形)
//   ⑤ ボタンの大きさ(高さ58px・文字17px)。段の表示は1段目
// 実行: node --test test/entry-template-top.test.js
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { IncomingMessage, ServerResponse } = require("http");
const { Socket } = require("net");
const XLSX = require("xlsx-js-style");
process.env.DB_PATH = path.join(process.env.TMPDIR || require("os").tmpdir(), "ktta_tpltop_" + process.pid + ".db");
process.env.KTTA_APP_MODE = "entry";
const db = require("../db");
const ef = require("../entry_form");
const { app } = require("../server");
after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const T = { id: "t1", name: "架空大会", date: "2099-12-06", venue: "市民体育館", entry_deadline: "2099-11-30 17:00", status: "upcoming" };
const EV = [{ name: "一般男子シングルス", type: "singles", fee: 700 }];
const open = ef.buildEntryFormHTML(T, EV, { submit_url: "https://example.invalid/api/public/tournaments/t1/submit-team-entry" });

test("① 最初の画面の一番上(団体名・担当者より前)に、ダウンロードのリンクと読み込みの案内", () => {
  const at = (s) => { const i = open.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('id="xlTop"') < at('name="contact_name"') && at('id="xlTop"') < at('name="team_name"'), "担当者の入力欄より前");
  const block = open.slice(at('id="xlTop"'), at('id="xlImport"'));
  assert.match(block, /<a class="xl-btn primary xl-top-btn" id="xlTopDl" href="[^"]*\/api\/public\/tournaments\/t1\/entry-template\.xlsx" download>Excelの入力用テンプレートをダウンロード<\/a>/);
  assert.match(block, /2段目の「記入したExcelを読み込む」で取り込めます/);
  assert.ok(!/<input|required/.test(block), "入力を求めない");
  assert.match(open, /\[contact, linkP, noteP, document\.getElementById\("xlTop"\)\]\.forEach\(function \(el\) \{ tag\(el, 1\); \}\);/, "1段目に表示");
  assert.ok(open.includes('id="xlFile"') && open.includes("記入したExcelを読み込む"), "2段目の読み込みは従来のまま");
});

test("② 受付終了のフォームには出さない", () => {
  const closed = ef.buildEntryFormHTML(T, EV, { submit_url: "https://example.invalid/x", capacity: { events: [], closed_reason: "締切を過ぎました" } });
  assert.ok(!closed.includes('id="xlTop"') && !closed.includes("Excelの入力用テンプレート</a>"));
});

test("⑤ ボタンの大きさ(高さ58px・文字17px)", () => {
  assert.match(open, /\.xl-top \.xl-top-btn \{ width: 100%; min-height: 58px; font-size: 17px;/);
});

const call = (method, url, headers, body) => new Promise((resolve) => {
  const sock = new Socket(); Object.defineProperty(sock, "remoteAddress", { value: "127.0.0.1" });
  const req = new IncomingMessage(sock); req.method = method; req.url = url; req.headers = { host: "localhost", ...(headers || {}) };
  if (body != null) req.headers["content-length"] = String(Buffer.byteLength(body));
  const res = new ServerResponse(req); res.assignSocket(sock); const ch = [];
  res.write = (c) => { ch.push(Buffer.from(c)); return true; };
  res.end = (c) => { if (c) ch.push(Buffer.from(c)); resolve({ status: res.statusCode, headers: res.getHeaders(), body: Buffer.concat(ch) }); };
  app(req, res); if (body != null) req.push(body); req.push(null);
});

test("③④ 連絡先もログインもなしでダウンロードでき、記入して読み込むと種目の行が返る", async () => {
  const t = db.createTournament({ name: "テンプレ検証大会", date: "2099-12-06" });
  db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "", event_config: EV });
  const dl = await call("GET", `/api/public/tournaments/${t.id}/entry-template.xlsx`);
  assert.equal(dl.status, 200, dl.body.toString().slice(0, 200));
  assert.match(dl.headers["content-type"], /spreadsheetml/);
  assert.match(decodeURIComponent(dl.headers["content-disposition"]), /申込テンプレート_テンプレ検証大会\.xlsx/, "ファイル名は大会名だけ(担当者の情報を使わない)");
  const wb = XLSX.read(dl.body, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames.find(n => n.includes("一般男子"))];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const col = (label) => { for (let c = 0; c <= range.e.c; c++) { const v = (ws[XLSX.utils.encode_cell({ r: 3, c })] || {}).v || ""; if (String(v).includes(label)) return c; } return -1; };
  const nameCol = col("氏名");
  assert.ok(nameCol >= 0, "氏名の列がある");
  ws[XLSX.utils.encode_cell({ r: 5, c: nameCol })] = { t: "s", v: "架空 太郎" };
  const furi = col("ふりがな"); if (furi >= 0) ws[XLSX.utils.encode_cell({ r: 5, c: furi })] = { t: "s", v: "かくう たろう" };
  const filled = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const rd = await call("POST", `/api/public/tournaments/${t.id}/entry-template/read`, { "content-type": "text/plain" }, JSON.stringify({ file: "data:application/octet-stream;base64," + filled.toString("base64") }));
  assert.equal(rd.status, 200, rd.body.toString().slice(0, 200));
  const out = JSON.parse(rd.body.toString());
  assert.ok(JSON.stringify(out).includes("架空 太郎"), "記入した選手が返る");
});
