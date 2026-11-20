// 集計表Excelの体裁の回帰テスト(できあがった xlsx を読み戻して確かめる)。
//
// 守らせる不変条件:
//   ① No. の列は通貨(円)ではなく数値の書式(0)。人数の列は桁区切り、金額だけが「円」
//   ② 区分は内部値(general など)ではなく日本語の区分名で出る
//   ③ 種目の見出しに参加料を併記する(学生料金・参加区分の料金があればそれも)。料金が未設定なら併記しない
// 実行: node --test test/entry-workbook-format.test.js
process.env.DB_PATH = require("path").join(require("os").tmpdir(), "ktta_wbfmt_" + process.pid + ".db");
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const XLSX = require("xlsx-js-style");
const db = require("../db");
const { buildEntryWorkbook } = require("../lib/entry-workbook");

after(() => { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {} } });

test("No.は数値書式・区分は日本語・種目見出しに参加料を併記", () => {
  const t = db.createTournament({ name: "体裁検証大会", date: "2099-12-06" });
  db.updateEntrySettings(t.id, { entries_open: 1, entry_deadline: "", event_config: [
    { name: "男子シングルス", type: "singles", fee: 2000 },
    { name: "一般ダブルス", type: "doubles", fee: 1500, fee_student: 1000 },
    { name: "小学生シングルス", type: "singles", fee: 500, entry_categories: [
      { value: "hopes", label: "ホープス(4年以下)", short: "ホープス", fee_override: 400 }, { value: "cub", label: "カブ", short: "カブ", fee_override: 300 }] },
    { name: "料金未設定シングルス", type: "singles" },
  ] });
  let n = 0;
  const go = (team, entry) => {
    const r = db.createTeamEntry(t.id, { team_name: team, contact_name: "担当 " + (++n), contact_tel: "1", contact_email: "a@b.co", entries: [entry] }, "wb" + n, {});
    assert.ok(!r.error, r.error);
    return r;
  };
  go("A団", { event: "男子シングルス", type: "singles", name: "甲 一", furigana: "こう いち", team: "A団", division: "general" });
  go("B団", { event: "一般ダブルス", type: "doubles", name1: "乙 一", name2: "乙 二", furigana1: "おつ いち", furigana2: "おつ に", team1: "B団", team2: "B団", division: "middle" });
  go("C団", { event: "小学生シングルス", type: "singles", name: "丙 一", furigana: "へい いち", team: "C団", division: "hopes" });
  go("D団", { event: "料金未設定シングルス", type: "singles", name: "丁 一", furigana: "てい いち", team: "D団" });

  const buf = buildEntryWorkbook(db.getEntryExport(t.id));
  const wb = XLSX.read(buf, { type: "buffer", cellNF: true });
  const sh = wb.Sheets["集計用"];
  // ① No.列(A5〜)
  for (const a of ["A5", "A6", "A7", "A8"]) { assert.strictEqual(sh[a].z, "0", a + " は数値書式: " + sh[a].z); assert.ok(!/円/.test(sh[a].w), a + ": " + sh[a].w); }
  // 金額の列だけが円
  const feeHead = XLSX.utils.decode_range(sh["!ref"]).e.c - 1;
  assert.match(sh[XLSX.utils.encode_cell({ r: 4, c: feeHead })].z, /円/);
  // ③ 見出し
  const heads = []; for (let c = 0; c <= XLSX.utils.decode_range(sh["!ref"]).e.c; c++) { const x = sh[XLSX.utils.encode_cell({ r: 3, c })]; heads.push(x ? x.v : ""); }
  const joined = heads.join("|");
  assert.ok(joined.includes("(¥2,000)"), joined);
  assert.ok(joined.includes("¥1,500（学生 ¥1,000）"));
  assert.ok(joined.includes("¥500（ホープス ¥400・カブ ¥300）"));
  const none = heads.find(h => h.startsWith("料金未設定"));
  assert.ok(none && !/[¥(]/.test(none), "料金が未設定なら併記しない: " + none);
  // ② 区分(選手名簿の区分の列)
  const ros = wb.Sheets["選手名簿"];
  const texts = []; Object.keys(ros).filter(k => k[0] !== "!").forEach(k => texts.push(String(ros[k].v)));
  assert.ok(texts.includes("一般") && texts.includes("中学生") && texts.includes("ホープス"), "区分は日本語: " + texts.filter(x => x.length < 8).join(","));
  assert.ok(!texts.some(x => /^(general|middle|high|hopes|student)$/.test(x)), "内部値が出ていない");
});
