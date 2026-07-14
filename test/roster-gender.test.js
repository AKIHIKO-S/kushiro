// 名簿取込の男女分割(entrylist direct + split_gender)と、
// 抽選のシード番号自動補完(登場回戦のみ指定のスーパーシード)を検証する。
// 実行: node --test test/roster-gender.test.js
process.env.DB_PATH = "/tmp/ktta_gender_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

test("entrylist: 区分列(一般女子/高校男子)から性別を判定し split_gender で男子S/女子Sに分割", () => {
  const sheets = [{
    name: "男女シングルス",
    rows: [
      ["氏名", "チーム名", "支部", "区分"],
      ["合成 太郎", "クラブ甲", "釧路", "高校男子"],
      ["合成 花子", "クラブ乙", "根室", "一般女子"],
      ["合成 次郎", "クラブ丙", "釧路", "一般男子"],
    ],
  }];
  const p = db.parseEntryListSheets(sheets);
  assert.strictEqual(p.entries.length, 3);
  assert.deepStrictEqual(p.entries.map(e => e.gender), ["male", "female", "male"], "行の区分から性別判定");
  assert.ok(p.entries.every(e => e.gender_known === true), "区分列があれば判定済み");

  const t = db.createTournament({ name: "男女分割", date: "2027-04-01" });
  const r = db.importRoster(t.id, { mode: "direct", split_gender: true, register_players: false, entries: p.entries });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual([...r.events].sort(), ["女子シングルス", "男子シングルス"].sort(),
    "男女シングルス→男子/女子に分割: " + JSON.stringify(r.events));
  const men = db.getEntrants(t.id, "男子シングルス"), women = db.getEntrants(t.id, "女子シングルス");
  assert.strictEqual(men.length, 2); assert.strictEqual(women.length, 1);
  assert.strictEqual(women[0].gender, "female");
});

test("entrylist: 区分列なし+シート名が男女混在は分割せず警告つきで残す", () => {
  const sheets = [{
    name: "男女シングルス",
    rows: [["氏名", "チーム名"], ["合成 三郎", "クラブ甲"]],
  }];
  const p = db.parseEntryListSheets(sheets);
  assert.strictEqual(p.entries[0].gender_known, false, "判定不能フラグ");
  const t = db.createTournament({ name: "分割不能", date: "2027-04-01" });
  const r = db.importRoster(t.id, { mode: "direct", split_gender: true, register_players: false, entries: p.entries });
  assert.deepStrictEqual(r.events, ["男女シングルス"], "元の種目名のまま");
  assert.ok((r.gender_warnings || []).length === 1, "警告が返る: " + JSON.stringify(r.gender_warnings));
});

test("entrylist: シート名が男子/女子なら区分列なしでも分割に使える(既存挙動維持)", () => {
  const sheets = [
    { name: "女子ダブルス", rows: [["氏名1", "氏名2", "チーム名1", "チーム名2"], ["合成 A子", "合成 B子", "ク甲", "ク乙"]] },
  ];
  const p = db.parseEntryListSheets(sheets);
  assert.strictEqual(p.entries[0].gender, "female");
  assert.strictEqual(p.entries[0].gender_known, true, "シート名に女子=判定済み");
  const t = db.createTournament({ name: "シート名分割", date: "2027-04-01" });
  const r = db.importRoster(t.id, { mode: "direct", split_gender: true, register_players: false, entries: p.entries });
  assert.deepStrictEqual(r.events, ["女子ダブルス"], "既に性別入りはそのまま");
});

test("抽選: 登場回戦のみ指定(シード番号なし)はシード番号を自動補完し区画を確保する", () => {
  const t = db.createTournament({ name: "SS自動補完", date: "2027-04-01" });
  const EV = "男子シングルス";
  const ids = [];
  for (let i = 1; i <= 20; i++) {
    const e = db.createEntrant({ tournament_id: t.id, event: EV,
      name: "選手" + String(i).padStart(2, "0"), team: "ク" + (i % 7), furigana: "せ" + String(i).padStart(2, "0") });
    ids.push(e.id);
  }
  // シード番号は振らず、登場回戦だけ4回戦に(=ユーザーの「SSが設定されない」ケース)
  db.setEntrantEntryRound(ids[0], 4);
  const rdy = db.checkDrawReadiness(t.id, EV);
  assert.strictEqual(rdy.bracket_size, 32, "会計がSS重み(2^3)込み: 19+8=27→32枠");
  const r = db.drawSingleBracket(t.id, EV, { drawn_by: "検証" });
  assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 160));
  assert.ok((r.warnings || []).some(w => /シード番号を自動補完/.test(w)), "自動補完の警告: " + JSON.stringify(r.warnings));
  // SS区画: 選手01 の周囲(重み8の整列区画)の他リーフが全てBYE=4回戦から登場
  const ms = db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1)
    .sort((a, b) => a.bracket_pos - b.bracket_pos);
  const leaf = [];
  ms.forEach(m => { leaf[2 * m.bracket_pos] = m.player1_name; leaf[2 * m.bracket_pos + 1] = m.player2_name; });
  const g = leaf.indexOf("選手01");
  assert.ok(g >= 0, "選手01が配置されている");
  const start = Math.floor(g / 8) * 8;
  for (let i = start; i < start + 8; i++) {
    if (i === g) continue;
    assert.strictEqual(leaf[i], "BYE", "SS区画内はBYE(スロット" + i + "): " + leaf[i]);
  }
  // entrant行のseedは書き換えない(自動補完は抽選入力のみ)
  const e0 = db.getEntrants(t.id, EV).find(x => x.name === "選手01");
  assert.strictEqual(parseInt(e0.seed) || 0, 0, "entrantのseed列は不変");
});
