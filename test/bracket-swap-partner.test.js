// トーナメント管理タブ Phase3: ダブルスのペア組み替え(swapEntrantPartners)の回帰テスト。
//  - 2ペアの相方(選手2)を交換し、display_name と表(matches)の非正規化名も追従する。
//  - 選手1・seed・1回戦の配置は不変。
// 実行: node --test test/bracket-swap-partner.test.js
process.env.DB_PATH = "/tmp/ktta_swappartner_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");

after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const EV = "混合ダブルス";
let _seq = 0;
function setupPair() {
  const t = db.createTournament({ name: "ペア入替" + (++_seq), date: "2027-09-09" });
  const a = db.createEntrant({ tournament_id: t.id, event: EV, seed: 1, is_doubles: 1,
    surname: "前", given_name: "太", team: "工業", partner_surname: "小山内", partner_given_name: "花", partner_team: "北陽", status: "confirmed" });
  const b = db.createEntrant({ tournament_id: t.id, event: EV, seed: 2, is_doubles: 1,
    surname: "今野", given_name: "健", team: "北陽", partner_surname: "板垣", partner_given_name: "翼", partner_team: "Neo", status: "confirmed" });
  db.generateBracket(t.id, EV, { regenerate: true });
  return { t, a, b };
}
const r1Names = (t, ev) => db.getMatchesByTournament(t.id)
  .filter(m => m.event === ev && m.bracket_round === 1)
  .flatMap(m => [m.player1_name, m.player2_name]).filter(Boolean).join(" / ");

test("swapEntrantPartners: 2ペアの相方を交換し、選手1は保持・display/表も追従", () => {
  const { t, a, b } = setupPair();
  const r = db.swapEntrantPartners(t.id, EV, a.id, b.id);
  assert.ok(r && !r.error, "入替成功: " + JSON.stringify(r));

  const A = db.getEntrants(t.id, EV).find(e => e.id === a.id);
  const B = db.getEntrants(t.id, EV).find(e => e.id === b.id);
  // A=(前, 板垣) / B=(今野, 小山内)
  assert.ok((A.name || "").indexOf("前") >= 0, "Aの選手1は前のまま: " + A.name);
  assert.ok((A.partner_name || "").indexOf("板垣") >= 0, "Aの相方が板垣に: " + A.partner_name);
  assert.ok((B.name || "").indexOf("今野") >= 0, "Bの選手1は今野のまま: " + B.name);
  assert.ok((B.partner_name || "").indexOf("小山内") >= 0, "Bの相方が小山内に: " + B.partner_name);
  // 相方の所属も入れ替わる
  assert.strictEqual(A.partner_team, "Neo", "Aの相方所属がNeoに: " + A.partner_team);
  assert.strictEqual(B.partner_team, "北陽", "Bの相方所属が北陽に: " + B.partner_team);

  const names = r1Names(t, EV);
  assert.ok(names.indexOf("板垣") >= 0 && names.indexOf("小山内") >= 0, "表の表示名がペア組替を反映: " + names);
});

test("swapEntrantPartners: 相方のふりがなも忠実に交換(空のふりがなで旧相方の読みが残らない)", () => {
  const t = db.createTournament({ name: "ふりがな入替" + (++_seq), date: "2027-09-10" });
  const a = db.createEntrant({ tournament_id: t.id, event: EV, seed: 1, is_doubles: 1,
    surname: "前", given_name: "太", team: "工業", partner_surname: "小山内", partner_given_name: "花", partner_furigana: "おさない", partner_team: "北陽", status: "confirmed" });
  const b = db.createEntrant({ tournament_id: t.id, event: EV, seed: 2, is_doubles: 1,
    surname: "今野", given_name: "健", team: "北陽", partner_surname: "板垣", partner_given_name: "翼", partner_furigana: "", partner_team: "Neo", status: "confirmed" });
  // 前提: 板垣 は辞書未登録なので partner_furigana は空のまま
  assert.strictEqual(db.getEntrants(t.id, EV).find(e => e.id === b.id).partner_furigana || "", "", "B相方ふりがなは空");
  db.generateBracket(t.id, EV, { regenerate: true });
  db.swapEntrantPartners(t.id, EV, a.id, b.id);
  const A = db.getEntrants(t.id, EV).find(e => e.id === a.id);
  const B = db.getEntrants(t.id, EV).find(e => e.id === b.id);
  assert.ok((A.partner_name || "").indexOf("板垣") >= 0, "Aの相方=板垣");
  assert.strictEqual(A.partner_furigana || "", "", "Aの相方ふりがなは空(旧相方おさないが残らない): " + A.partner_furigana);
  assert.strictEqual(B.partner_furigana, "おさない", "Bの相方ふりがな=おさない: " + B.partner_furigana);
});

test("swapEntrantPartners: 種目違い/大会違い/不存在/非ダブルス/同一はエラー", () => {
  const { t, a } = setupPair();
  assert.ok(db.swapEntrantPartners(t.id, EV, a.id, "nope").error, "不存在はエラー");
  assert.ok(db.swapEntrantPartners(t.id, EV, a.id, a.id).error, "同一ペアはエラー");
  const single = db.createEntrant({ tournament_id: t.id, event: EV, seed: 3, is_doubles: 0, surname: "単", given_name: "打", team: "X", status: "confirmed" });
  assert.ok(db.swapEntrantPartners(t.id, EV, a.id, single.id).error, "非ダブルスはエラー");
  // 種目違い(同一大会・別種目のダブルス)
  const other = db.createEntrant({ tournament_id: t.id, event: "別種目ダブルス", seed: 1, is_doubles: 1, surname: "他", given_name: "種", team: "Y", partner_surname: "目", partner_given_name: "違", partner_team: "Z", status: "confirmed" });
  assert.ok(/種目/.test(db.swapEntrantPartners(t.id, EV, a.id, other.id).error || ""), "種目違いはエラー");
  // 大会違い(別大会のダブルス)
  const t2 = db.createTournament({ name: "別大会" + (++_seq), date: "2027-09-11" });
  const inB = db.createEntrant({ tournament_id: t2.id, event: EV, seed: 1, is_doubles: 1, surname: "別", given_name: "大", team: "Y", partner_surname: "会", partner_given_name: "場", partner_team: "Z", status: "confirmed" });
  assert.ok(/大会/.test(db.swapEntrantPartners(t.id, EV, a.id, inB.id).error || ""), "大会違いはエラー");
});
