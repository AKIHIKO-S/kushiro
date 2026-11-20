// ダブルスの「ペア希望」(選手2が空欄の申込)の回帰テスト。
// 守らせる不変条件:
//   ① 選手1だけでも申込でき、1組として数える(出場数1・参加料は種目の料金)。1人あたり料金の種目は記入人数で計算
//   ② 受付台帳に「ペア希望」の注意が出て、集計Excelの氏名欄に「（ペア希望）」・確認事項に出る
//   ③ 名簿・領収書の金額・組合せの生成が、選手2の空欄で壊れない
//   ④ 選手2だけが書かれていたら選手1として登録する
// 実行: node --test test/pair-wish.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_pairwish_" + process.pid + ".db");
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const XLSX = require("xlsx-js-style");
const db = require("../db");
const { buildEntryWorkbook } = require("../lib/entry-workbook");
const { receiptTeams } = require("../lib/receipt-print");
const { savedEntryFee } = require("../lib/entry-summary");

after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

const EV = "一般男子ダブルス", EVP = "人数割ダブルス";
function setup() {
  const t = db.createTournament({ name: "ペア希望検証大会", date: "2099-12-06" });
  db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "", event_config: [{ name: EV, type: "doubles", fee: 1000 }, { name: EVP, type: "doubles", fee: 600, fee_unit: "person" }] });
  return t;
}
let n = 0;
const pair = (t, team, ev, e) => db.createTeamEntry(t.id, { team_name: team, contact_name: "担当 " + (++n), contact_tel: "1", contact_email: "p@example.com",
  entries: [{ event: ev, type: "doubles", team1: team, team2: team, furigana1: "ぺあ いち", furigana2: "ぺあ に", ...e }] }, "pw" + n, { enforce: false });

test("①②③ 選手1だけの申込: 1組として数え、台帳・Excel・領収書・組合せが壊れない", () => {
  const t = setup();
  const a = pair(t, "ペアA団", EV, { name1: "希望 一郎", name2: "" });
  assert.ok(!a.error, a.error);
  const b = pair(t, "ペアB団", EV, { name1: "完全 太郎", name2: "完全 次郎" });
  assert.ok(!b.error, b.error);
  const c = pair(t, "ペアC団", EVP, { name1: "人数 一", name2: "" });
  const d2 = pair(t, "ペアD団", EVP, { name1: "人数 二", name2: "人数 三" });
  assert.ok(!c.error && !d2.error);

  const desk = db.getEntryDesk(t.id);
  assert.strictEqual(desk.totals.entries, 4, "1組=1出場として数える");
  const rowA = desk.rows.find(r => r.team_name === "ペアA団");
  assert.strictEqual(rowA.entries, 1);
  assert.strictEqual(rowA.players[0].pair_wish, true);
  assert.ok(rowA.issues.some(i => i.title === "ペア希望" && i.type === "other"), "既存の注意バッジの形で出る");
  assert.strictEqual(desk.rows.find(r => r.team_name === "ペアB団").players[0].pair_wish, false);

  // 参加料: 組単位は種目の料金、1人あたりは記入人数
  const fees = db.getEntrants(t.id).reduce((m, e) => { m[e.team + "|" + e.event] = e.fee; return m; }, {});
  assert.strictEqual(fees["ペアA団|" + EV], 1000);
  assert.strictEqual(fees["ペアC団|" + EVP], 600, "1人だけなら1人ぶん");
  assert.strictEqual(fees["ペアD団|" + EVP], 1200);

  // 集計Excel
  const wb = XLSX.read(buildEntryWorkbook(db.getEntryExport(t.id)), { type: "buffer" });
  const cells = []; Object.values(wb.Sheets).forEach(ws => Object.keys(ws).filter(k => k[0] !== "!").forEach(k => cells.push(String(ws[k].v))));
  assert.ok(cells.some(v => v.includes("（ペア希望）")), "氏名欄にペア希望");
  assert.ok(cells.some(v => v.includes("ペア希望(選手2が空欄)")), "確認事項に出る");

  // 領収書の金額: 選手2が空でも団体の合計が出る
  const subs = db.listSubmissionsForTest ? [] : null;
  const r = db.getReceiptTeams(t.id);
  assert.strictEqual(r.teams.find(x => x.name === "ペアA団").amount, 1000);

  // 名簿データ・組合せの生成
  assert.doesNotThrow(() => db.buildRosterData(t.id));
  const g = db.generateBracket(t.id, EV, {});
  assert.ok(g && !g.error, "選手2が空欄でも組合せが作れる: " + (g && g.error));
});

test("④ 選手2だけの記入は選手1として登録する", () => {
  const t = setup();
  const r = pair(t, "逆団", EV, { name1: "", name2: "後ろ 太郎" });
  assert.ok(!r.error, r.error);
  const e = db.getEntrants(t.id)[0];
  assert.strictEqual(e.name, "後ろ 太郎");
  assert.strictEqual(e.partner_name || "", "");
});
