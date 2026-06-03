// オフライン縮退の保証: 当日サーバ/ネットが落ちても、ローカル単機(=db.js + reports.js を
// require するだけ・HTTPサーバ無し・外部ネットワーク無し)で「名簿→抽選→Excel出力」が完結する。
// これが通る限り、for_mac.xls へ逆戻りせずに済む(ユーザーの真の安心線)。
// 実行: node --test test/offline-draw.test.js
process.env.DB_PATH = "/tmp/ktta_offline_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

// 外部ネットワークを物理的に遮断して『本当にローカルだけで完結する』ことを担保する。
const net = require("net");
const _connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function () { throw new Error("ネットワーク禁止(オフライン縮退テスト)"); };
after(() => { net.Socket.prototype.connect = _connect; });

const db = require("../db");
const reports = require("../reports");
const XLSX = require("xlsx");

after(() => { for (const e of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + e, { force: true }); } catch (x) {} });

test("縮退: 名簿→抽選→両山Excel出力 がサーバ・ネット無しで完結する", () => {
  const EV = "一般男子シングルス";
  // ① 名簿(申込) — DBだけ
  const t = db.createTournament({ name: "停電大会", date: "2027-07-07", venue: "公民館" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: [{ name: EV, type: "singles", fee: 0 }] });
  const entries = [];
  for (let i = 1; i <= 24; i++) entries.push({ event: EV, type: "singles", name: "選手" + String(i).padStart(2, "0"), team: "ク" + (i % 5) });
  db.createTeamEntry(t.id, { team_name: "X", contact_name: "x", contact_email: "x@y.jp", entries });
  db.getEntrants(t.id, EV).slice(0, 4).forEach((e, k) => db.setEntrantSeed(e.id, k + 1));

  // ② 事前検査 → 抽選(確定) — DBだけ
  const rdy = db.checkDrawReadiness(t.id, EV);
  assert.ok(rdy.ok, "事前検査ok");
  const r = db.drawSingleBracket(t.id, EV, { draw_seed: 42, drawn_by: "現地スタッフ" });
  assert.ok(r.success, "抽選確定: " + JSON.stringify(r).slice(0, 100));
  assert.strictEqual(r.bracket_size, 32);

  // ③ 両山Excel出力 — reports だけ(SheetJSローカル)
  const buf = reports.buildBracketXlsx(t, db.getMatchesByTournament(t.id), db.getEntrants(t.id), { event: EV });
  assert.ok(buf && buf.length > 2000 && buf[0] === 0x50 && buf[1] === 0x4b, "有効なxlsx(PKzip)");
  const wb = XLSX.read(buf, { type: "buffer" });
  assert.ok(wb.SheetNames.includes(EV.slice(0, 30)), "種目シートがある");
  assert.ok(wb.SheetNames.includes("_import"), "取込用_importシートもある(往復可能)");
  // 全選手名がExcelに載っている
  const ws = wb.Sheets[EV.slice(0, 30)];
  const text = Object.keys(ws).filter(k => k[0] !== "!").map(k => String(ws[k].v)).join("");
  let found = 0; for (let i = 1; i <= 24; i++) if (text.includes("選手" + String(i).padStart(2, "0"))) found++;
  assert.strictEqual(found, 24, "24名全員が表に載る");
});
