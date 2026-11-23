// 申込フォーム「Excelで一括入力」のテンプレート(lib/entry-template.js)の回帰テスト。
// 守らせる不変条件:
//   ① テンプレートの列は大会のフォーム設定と同じ規則で出し分ける(隠した項目の列は作らない)
//   ② 記入したテンプレートを読むと、種目ごとの行がフォームへ流し込める形で返る
//   ③ 記入方法の行・空行・この大会に無い種目のシートは読み飛ばす(警告は返す)
//   ④ 壊れたファイルは例外にせず、平易なエラーを返す
// 実行: node --test test/entry-template.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const XLSX = require("xlsx-js-style");
const { buildEntryTemplate, readEntryTemplate, eventColumns } = require("../lib/entry-template");

const CFG = {
  fields: { team_name: "required", player_team: "optional", furigana: "required", grade: "optional",
    player_gender: "hidden", supervisor: "optional", advisor: "hidden", coach: "hidden" },
  custom: [{ key: "shirt", label: "Tシャツ", scope: "player", type: "select", options: ["S", "M", "L"] }],
  event_overrides: {}, field_meta: {},
};
const EVENTS = [
  { name: "中学男子シングルス", type: "singles", category: "middle", fee: 500 },
  { name: "一般ダブルス", type: "doubles", category: "general", fee: 1000, fee_student: 600 },
  { name: "団体戦", type: "team", per_team: 4, per_team_min: 3, fee: 2000 },
];
const T = { id: "t1", name: "テスト大会" };

function fill(buf, edits) {
  const wb = XLSX.read(buf, { type: "buffer" });
  for (const [sheet, rows] of Object.entries(edits)) {
    const ws = wb.Sheets[sheet];
    assert.ok(ws, "シートがある: " + sheet);
    rows.forEach(([addr, v]) => { ws[addr] = { t: "s", v }; });
    const r = XLSX.utils.decode_range(ws["!ref"]);
    rows.forEach(([addr]) => { const c = XLSX.utils.decode_cell(addr); r.e.r = Math.max(r.e.r, c.r); r.e.c = Math.max(r.e.c, c.c); });
    ws["!ref"] = XLSX.utils.encode_range(r);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
const headers = (buf, sheet) => {
  const ws = XLSX.read(buf, { type: "buffer" }).Sheets[sheet];
  const r = XLSX.utils.decode_range(ws["!ref"]);
  const out = [];
  for (let c = 0; c <= r.e.c; c++) { const cell = ws[XLSX.utils.encode_cell({ r: 3, c })]; if (cell) out.push(cell.v); }
  return out;
};

test("① 列はフォーム設定どおり(隠した項目は出さない・必須は見出しに書く)", () => {
  const buf = buildEntryTemplate({ tournament: T, events: EVENTS, fieldConfig: CFG });
  const names = XLSX.read(buf, { type: "buffer" }).SheetNames;
  assert.deepStrictEqual(names, ["使い方", "申込者", "中学男子シングルス", "一般ダブルス", "団体戦"]);
  const sg = headers(buf, "中学男子シングルス");
  assert.deepStrictEqual(sg, ["氏名（必須）", "ふりがな（必須）", "所属", "学年", "Tシャツ"]);
  assert.ok(!sg.some(h => /性別/.test(h)), "性別は隠しているので列が無い");
  const db = headers(buf, "一般ダブルス");
  assert.ok(db.includes("選手1 氏名（必須）") && db.includes("選手2 ふりがな（必須）"));
  assert.strictEqual(db[db.length - 1], "参加区分", "中高生料金がある種目は参加区分の列を持つ");
  assert.deepStrictEqual(headers(buf, "団体戦"), ["チーム名（必須）", "メンバー1（必須）", "メンバー2（必須）", "メンバー3（必須）", "メンバー4"]);
  // 申込者シート: 隠した顧問・コーチは出さない
  const cws = XLSX.read(buf, { type: "buffer" }).Sheets["申込者"];
  const labels = [4, 5, 6, 7, 8, 9].map(r => (cws[XLSX.utils.encode_cell({ r, c: 0 })] || {}).v).filter(Boolean);
  assert.deepStrictEqual(labels, ["団体名（必須）", "申込者（氏名）（必須）", "電話番号（必須）", "メールアドレス（必須）", "引率顧問"]);
});

test("② 記入したテンプレを読むと種目ごとの行が返る(列の並べ替えにも強い)", () => {
  const base = buildEntryTemplate({ tournament: T, events: EVENTS, fieldConfig: CFG });
  const buf = fill(base, {
    "申込者": [["B5", "釧路中学校"], ["B6", "申込 花子"], ["B7", "0154-00-0000"], ["B8", "a@example.com"]],
    "中学男子シングルス": [["A6", "釧路 太郎"], ["B6", "くしろ たろう"], ["C6", "釧路中"], ["D6", "中2"], ["E6", "M"],
      ["A8", "根室 次郎"], ["B8", "ねむろ じろう"]],
    "一般ダブルス": [["A6", "選手 一"], ["B6", "せんしゅ いち"], ["F6", "選手 二"], ["G6", "せんしゅ に"], ["K6", "中学生"]],
    "団体戦": [["A6", "釧路A"], ["B6", "甲"], ["C6", "乙"], ["D6", "丙"]],
  });
  const out = readEntryTemplate(buf, { events: EVENTS, fieldConfig: CFG });
  assert.ifError(out.error);
  assert.deepStrictEqual(out.contact, { team_name: "釧路中学校", contact_name: "申込 花子", contact_tel: "0154-00-0000", contact_email: "a@example.com" });
  const sg = out.events.find(e => e.name === "中学男子シングルス");
  assert.strictEqual(sg.rows.length, 2, "空行は飛ばし、記入方法の行は読まない");
  assert.strictEqual(sg.rows[0].name, "釧路 太郎");
  assert.strictEqual(sg.rows[0].grade, "中2");
  assert.strictEqual(sg.rows[0].custom.shirt, "M");
  const dbl = out.events.find(e => e.name === "一般ダブルス").rows[0];
  assert.strictEqual(dbl.p1.name, "選手 一");
  assert.strictEqual(dbl.p2.furigana, "せんしゅ に");
  assert.strictEqual(dbl.division, "中学生");
  const team = out.events.find(e => e.name === "団体戦").rows[0];
  assert.deepStrictEqual(team, { team_name: "釧路A", members: ["甲", "乙", "丙"], division: "" });

  // 列の並べ替え: ふりがなと氏名を入れ替えても見出しで読む
  const wb = XLSX.read(base, { type: "buffer" });
  const ws = wb.Sheets["中学男子シングルス"];
  ws.A4 = { t: "s", v: "ふりがな（必須）" }; ws.B4 = { t: "s", v: "氏名（必須）" };
  ws.A6 = { t: "s", v: "くしろ" }; ws.B6 = { t: "s", v: "釧路 三郎" };
  const out2 = readEntryTemplate(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { events: EVENTS, fieldConfig: CFG });
  assert.strictEqual(out2.events[0].rows[0].name, "釧路 三郎");
  assert.strictEqual(out2.events[0].rows[0].furigana, "くしろ");
});

test("③ 大会に無い種目のシートは読み飛ばして警告する", () => {
  const base = buildEntryTemplate({ tournament: T, events: EVENTS, fieldConfig: CFG });
  const wb = XLSX.read(base, { type: "buffer" });
  const extra = XLSX.utils.aoa_to_sheet([["種目：存在しない種目"], [], [], ["氏名"], [], ["誰か"]]);
  XLSX.utils.book_append_sheet(wb, extra, "存在しない種目");
  const out = readEntryTemplate(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { events: EVENTS, fieldConfig: CFG });
  assert.strictEqual(out.events.length, 0);
  assert.ok(out.warnings.some(w => /存在しない種目/.test(w)));
});

test("④ 壊れたファイルはエラー文を返す", () => {
  const out = readEntryTemplate(Buffer.from("PK\u0003\u0004 broken"), { events: EVENTS, fieldConfig: CFG });
  assert.ok(out.error && /読み取れません/.test(out.error));
});

test("満員の種目はテンプレに出さない・列定義は大会設定から作る", () => {
  const buf = buildEntryTemplate({ tournament: T, events: [{ ...EVENTS[0], full: true }, EVENTS[2]], fieldConfig: CFG });
  assert.ok(!XLSX.read(buf, { type: "buffer" }).SheetNames.includes("中学男子シングルス"));
  const cols = eventColumns({ ...CFG, fields: { ...CFG.fields, player_region: "required" } }, EVENTS[0]);
  assert.ok(cols.some(c => c.key === "region" && c.req));
});

test("本部の一括登録: 列は氏名・ふりがな・所属・区分だけ。読み取り結果を手入力登録の形に変える", () => {
  const { adminTemplateConfig, adminTemplateEvents, toManualPatch } = require("../lib/entry-template");
  const evs = adminTemplateEvents([
    { name: "中学男子シングルス", type: "singles", category: "middle", age_check: { mode: "birthdate" } },
    { name: "一般ダブルス", type: "doubles", entry_categories: [{ value: "general", label: "一般", short: "一般" }, { value: "stu", label: "中高生", short: "中高" }] },
    { name: "団体戦", type: "team", per_team: 3, per_team_min: 2 },
  ]);
  const cfg = adminTemplateConfig(CFG);
  const base = buildEntryTemplate({ tournament: T, events: evs, fieldConfig: cfg, admin: true });
  assert.deepStrictEqual(headers(base, "中学男子シングルス"), ["氏名（必須）", "ふりがな", "所属"], "学年・性別・生年月日などの列は出さない");
  const buf = fill(base, {
    "申込者": [["B5", "釧路中学校"]],
    "中学男子シングルス": [["A6", "釧路 太郎"], ["B6", "くしろ たろう"], ["C6", "釧路中"]],
    "一般ダブルス": [["A6", "甲 一"], ["B6", "こう いち"], ["D6", "乙 二"], ["E6", "おつ に"], ["G6", "中高"]],
    "団体戦": [["A6", "釧路A"], ["B6", "甲"], ["C6", "乙"]],
  });
  const out = readEntryTemplate(buf, { events: evs, fieldConfig: cfg, admin: true });
  const p = toManualPatch(out, evs);
  assert.strictEqual(p.contact.team_name, "釧路中学校");
  assert.deepStrictEqual(p.add[0], { event: "中学男子シングルス", name: "釧路 太郎", furigana: "くしろ たろう", team: "釧路中" });
  assert.strictEqual(p.add[1].division, "stu", "区分の表示名を登録用の値に直す");
  assert.deepStrictEqual([p.add[1].name1, p.add[1].name2], ["甲 一", "乙 二"]);
  assert.deepStrictEqual(p.add[2], { event: "団体戦", team_name: "釧路A", members: ["甲", "乙"] });
  // 連絡先は本部登録では任意(申込者シートの見出しに(必須)が付かない)
  const cws = XLSX.read(base, { type: "buffer" }).Sheets["申込者"];
  assert.ok(!/必須/.test(cws["A6"].v), "責任者は本部登録では必須にしない: " + cws["A6"].v);
});

test("⑤ 学年の列はフォームと同じ並びのドロップダウン。選んだ値も自由入力も読める", () => {
  const { unzipSync, strFromU8 } = require("fflate");
  const buf = buildEntryTemplate({ tournament: T, events: EVENTS, fieldConfig: CFG });
  const files = unzipSync(new Uint8Array(buf));
  const sheetOf = (n) => strFromU8(files["xl/worksheets/sheet" + n + ".xml"]);
  const GRADES = "小1,小2,小3,小4,小5,小6,中1,中2,中3,高1,高2,高3,一般";
  // 中学男子シングルス(3枚目)は4列目(D)が学年
  const s1 = sheetOf(3);
  assert.ok(s1.includes('type="list"') && s1.includes(`<formula1>"${GRADES}"</formula1>`), "リストの並びはフォームと同じ");
  assert.ok(s1.includes('sqref="D6:D25"'));
  assert.ok(s1.indexOf("<dataValidations") > s1.indexOf("</sheetData>") && s1.indexOf("<dataValidations") < s1.indexOf("<pageMargins"), "入力規則はsheetDataのあと印刷設定の前");
  // ダブルスは選手1・選手2の両方
  assert.strictEqual((sheetOf(4).match(/<dataValidation /g) || []).length, 2);
  // 団体戦・申込者には付けない
  assert.ok(!sheetOf(5).includes("dataValidation") && !sheetOf(2).includes("dataValidation"));
  // 壊れていない: SheetJSで読み直せて、選択値も自由入力も取り込める
  const filled = fill(buf, { "中学男子シングルス": [["A6", "架空 太郎"], ["B6", "かくう たろう"], ["D6", "中2"], ["A7", "架空 次郎"], ["B7", "かくう じろう"], ["D7", "中学2年生"]] });
  const r = readEntryTemplate(filled, { events: EVENTS, fieldConfig: CFG });
  assert.ok(!r.error, r.error);
  const rows = JSON.stringify(r);
  assert.ok(rows.includes("中2") && rows.includes("中学2年生"));
});

test("以前の呼び名「申込責任者（氏名）」のテンプレートも読める", () => {
  const buf = buildEntryTemplate({ tournament: T, events: EVENTS, fieldConfig: CFG });
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets["申込者"];
  const addr = Object.keys(ws).find(k => k[0] !== "!" && String(ws[k].v).startsWith("申込者（氏名）"));
  assert.ok(addr, "新しい呼び名の見出し");
  ws[addr].v = "申込責任者（氏名）（必須）";
  const row = XLSX.utils.decode_cell(addr).r;
  ws[XLSX.utils.encode_cell({ r: row, c: 1 })] = { t: "s", v: "旧 担当" };
  const r = readEntryTemplate(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { events: EVENTS, fieldConfig: CFG });
  assert.strictEqual(r.contact && r.contact.contact_name, "旧 担当");
});
