// 申込集計Excel(lib/entry-workbook.js)と、公開フォームの同一種目重複チェックの回帰テスト。
// 守らせる不変条件:
//   ① 名簿には個人名が必ず載る(シングルス・ダブルス2人・団体メンバー)
//   ② 承認待ち・重複の疑いがあっても名簿に載せ、確認事項に理由を書く。取消は載せない
//   ③ 集計用は申込団体ごとの参加費。金額は3桁区切り
//   ④ 公開フォームは、同じ種目にすでに申込がある選手を受け付けない(op_id の再送は従来どおり成功扱い)
// 実行: node --test test/entry-export.test.js
process.env.DB_PATH = (process.env.TEST_TMP || "/tmp") + "/ktta_entryexport_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const XLSX = require("xlsx-js-style");
const db = require("../db");
const { buildEntryWorkbook } = require("../lib/entry-workbook");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

const EVENTS = [
  { name: "一般男子シングルス", type: "singles", fee: 1000 },
  { name: "男子ダブルス", type: "doubles", fee: 2000 },
  { name: "団体戦", type: "team", fee: 1000, fee_unit: "person", per_team: 6, per_team_min: 3 },
];

function setup() {
  const t = db.createTournament({ name: "集計検証大会", date: "2027-09-01" });
  db.updateEntrySettings(t.id, { entries_open: 1, event_config: EVENTS,
    field_config: { version: 2, fields: { team_name: "required" }, custom: [], event_overrides: {} } });
  return t;
}
const sub = (t, team, entries, opts, op) => db.createTeamEntry(t.id, {
  team_name: team, contact_name: "担当 一郎", contact_tel: "000", contact_email: "a@example.com", entries,
}, op || ("op-" + Math.random()), opts || {});

function sheetText(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const out = {};
  wb.SheetNames.forEach(n => { out[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false }).map(r => r.join("|")).join("\n"); });
  return { wb, out };
}

test("名簿にシングルス・ダブルス2人・団体メンバーの個人名が載る", () => {
  const t = setup();
  assert.ok(!sub(t, "甲クラブ", [
    { event: "一般男子シングルス", type: "singles", name: "架空 太郎", team: "甲クラブ" },
    { event: "男子ダブルス", type: "doubles", name1: "架空 次郎", name2: "架空 三郎", team1: "甲クラブ" },
    { event: "団体戦", type: "team", team_name: "甲A", members: ["甲 一", "乙 二", "丙 三"] },
  ]).error);
  const { out, wb } = sheetText(buildEntryWorkbook(db.getEntryExport(t.id)));
  const roster = out["選手名簿"];
  ["架空 太郎", "架空 次郎", "架空 三郎", "甲 一", "乙 二", "丙 三"].forEach(n => assert.ok(roster.includes(n), "選手名簿に " + n));
  assert.ok(wb.SheetNames.some(n => n.includes("一般男子シングルス")), "種目別名簿がある");
  assert.ok(out[wb.SheetNames.find(n => n.includes("男子ダブルス"))].includes("架空 三郎"));
  assert.ok(out["集計用"].includes("甲クラブ"));
  assert.ok(/6,000/.test(out["集計用"]), "参加費 1000+2000+1000×3 = 6,000 を3桁区切りで: " + out["集計用"]);
  assert.ok(out["領収書差し込み用"].includes("集計検証大会 参加費として"));
});

test("承認待ち・別団体の重複の疑いも名簿に載り、確認事項に理由が出る。取消は載らない", () => {
  const t = setup();
  const a = sub(t, "甲クラブ", [{ event: "一般男子シングルス", type: "singles", name: "重複 候補", team: "甲クラブ" }]);
  const b = sub(t, "乙クラブ", [{ event: "一般男子シングルス", type: "singles", name: "重複 候補", team: "乙クラブ" }]);
  const c = sub(t, "丙クラブ", [{ event: "一般男子シングルス", type: "singles", name: "取消 予定", team: "丙クラブ" }]);
  assert.ok(!a.error && !b.error && !c.error);
  db.updateEntrant(c.entrant_ids[0], { status: "cancelled" });
  const data = db.getEntryExport(t.id);
  const all = data.groups.flatMap(g => g.entries);
  assert.strictEqual(all.filter(e => e.name_text === "重複 候補").length, 2, "重複の疑いでも両方載る");
  assert.ok(all.every(e => e.name_text !== "取消 予定"), "取消は載らない");
  assert.ok(all.filter(e => e.name_text === "重複 候補").every(e => e.checks.some(x => /重複の疑い/.test(x))));
});

test("公開フォーム: 同じ種目にすでに申込がある選手はエラー。同じ op_id の再送は成功扱い", () => {
  const t = setup();
  const opts = { reject_registered: true, explicit_additions: true };
  const first = sub(t, "甲クラブ", [{ event: "一般男子シングルス", type: "singles", name: "架空 太郎", team: "甲クラブ" }], opts, "op-same");
  assert.ok(!first.error, first.error);
  const again = sub(t, "甲クラブ", [{ event: "一般男子シングルス", type: "singles", name: "架空 太郎", team: "甲クラブ" }], opts, "op-same");
  assert.ok(again.replayed, "同じ op_id の再送は処理済みを返す");
  const other = sub(t, "乙クラブ", [{ event: "一般男子シングルス", type: "singles", name: "架空　太郎", team: "乙クラブ" }], opts);
  assert.match(other.error || "", /すでに申込があります/, "所属違い・全角空白でも止める");
  const pair = sub(t, "乙クラブ", [{ event: "男子ダブルス", type: "doubles", name1: "別人 一", name2: "別人 二" },
    { event: "男子ダブルス", type: "doubles", name1: "別人 一", name2: "別人 三" }], opts);
  assert.match(pair.error || "", /同じ申込の中で重複/);
  const ok = sub(t, "乙クラブ", [{ event: "男子ダブルス", type: "doubles", name1: "架空 太郎", name2: "架空 四郎" }], opts);
  assert.ok(!ok.error, "別の種目なら申し込める: " + ok.error);
});
