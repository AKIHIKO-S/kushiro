// GAS 側の「書いたものを読み返して確認する」仕組みの検証。
//
// 背景: 申込は届いていたのにスプレッドシートに記録が無い、という事故が実際に起きた。
// 原因の特定はできなかったが、構造として「書き込んだことを確認せずに成功を返す」造りだと
// 何が起きても気づけない。そこで次の不変条件を守らせる:
//   ① 書いた行を読み返し、大会名・団体名・責任者が一致することを確認する
//   ② 各振分けシートが「この申込の分だけ」増えたことを確認する
//   ③ 台帳に行が無い / 中身が違う / 行が足りない、のいずれでも ok:false になる
//   ④ 申込ID(op_id)を台帳に残し、それを見て二重登録を防ぐ(キャッシュが消えた後も効く)
//   ⑤ 受信確認メールの宛先はカンマ区切りで複数指定でき、未設定ならシート所有者に落ちる
//   ⑥ 突合用の申込ID一覧を返せる(申込ID列が無い旧シートはその旨を返す)
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const GAS_SRC = fs.readFileSync(path.join(__dirname, "..", "gas", "entry_form_handler.gs"), "utf8");

// ── GAS の環境を最小限だけ用意する ────────────────────────────────
let _props = {};
let _owner = "owner@example.com";
let _sheets = {};
const sandbox = {
  console, JSON, String, Number, Array, Object, Math, Date, RegExp,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in _props ? _props[k] : null) }) },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({
      getSheetByName: (n) => _sheets[n] || null,
      getUrl: () => "https://docs.google.com/spreadsheets/d/TEST",
      getOwner: () => (_owner ? { getEmail: () => _owner } : null),
    }),
  },
  Session: { getEffectiveUser: () => ({ getEmail: () => "effective@example.com" }) },
};
vm.createContext(sandbox);
vm.runInContext(GAS_SRC + `
;globalThis.__api = { _verifyWrite, _countRows, _expectedRowDeltas, _findEntryIdRow,
  _notifyRecipients, _buildEntryIds, classifyEntry, COL_ENTRY_ID, SHEETS };
`, sandbox);
const G = sandbox.__api;
const S = {
  LEDGER: G.SHEETS.LEDGER, TEAM: G.SHEETS.TEAM, DOUBLES: G.SHEETS.DOUBLES,
  MIXED: G.SHEETS.MIXED, SINGLES: G.SHEETS.SINGLES,
};

// ── 擬似シート(検証に必要な API だけ) ──────────────────────────────
function sheet(headers, rows) {
  const grid = [headers.slice()].concat((rows || []).map(r => r.slice()));
  return {
    grid,
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(r, c, nr, nc) {
      const rn = nr == null ? 1 : nr, cn = nc == null ? 1 : nc;
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < rn; i++) {
            const src = grid[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < cn; j++) line.push(src[c - 1 + j] == null ? "" : src[c - 1 + j]);
            out.push(line);
          }
          return out;
        },
      };
    },
  };
}
const LEDGER_H = ["受付日時", "大会名", "団体名", "申込責任者", "電話番号", "メールアドレス",
  "引率顧問", "コーチ", "申込種目数", "参加人数(述べ)", "合計金額", "備考", "tournament_id", "申込ID"];
const ledgerRow = (o) => ["2027-06-01", o.tn, o.team, o.contact, "0154", "a@example.com",
  "", "", 1, 1, 1000, "", o.tid || "T1", o.id || ""];

// n行ぶんの空データを持つ振分けシート
const dist = (n) => sheet(["種目", "区分", "氏名"], Array.from({ length: n }, (_, i) => ["e", "d", "p" + i]));

function setup(opts) {
  opts = opts || {};
  _sheets = {
    [S.LEDGER]: sheet(LEDGER_H, opts.ledger || []),
    [S.TEAM]: dist(opts.team || 0),
    [S.DOUBLES]: dist(opts.doubles || 0),
    [S.MIXED]: dist(opts.mixed || 0),
    [S.SINGLES]: dist(opts.singles || 0),
  };
}

const DATA = {
  tournament_name: "テスト大会", team_name: "テスト団体A", contact_name: "山田 太郎",
  op_id: "op-abc-123",
  entries: [
    { event: "一般男子 団体戦", type: "team", members: ["甲", "乙", "丙", "丁"] },
    { event: "一般男子 ダブルス", type: "doubles", name1: "甲", name2: "乙" },
    { event: "混合ダブルス", type: "mixed", name1: "甲", name2: "戊" },
    { event: "一般男子 シングルス", type: "singles", name: "甲" },
  ],
};

// ── ① 期待行数の数え方 ──────────────────────────────────────
test("この申込で何行増えるべきかを種目から数える", () => {
  const d = G._expectedRowDeltas(DATA);
  assert.strictEqual(d[S.TEAM], 4, "団体はメンバー1人=1行");
  assert.strictEqual(d[S.DOUBLES], 1, "ダブルスはペアで1行");
  assert.strictEqual(d[S.MIXED], 1);
  assert.strictEqual(d[S.SINGLES], 1);
});

test("団体は members_detail 優先で数え、空欄は数えない", () => {
  const d = G._expectedRowDeltas({
    entries: [{ event: "団体戦", type: "team", members_detail: [{ name: "甲" }, { name: "" }, { name: "丙" }] }],
  });
  assert.strictEqual(d[S.TEAM], 3 - 1, "空欄の1人を除いて2行");
});

test("弁当・懇親会・相手募集は行数検証の対象にしない(別レイアウトのため)", () => {
  const d = G._expectedRowDeltas({
    entries: [{ event: "お弁当", type: "bento", count: 3 }, { event: "懇親会", type: "party", count: 2 }],
  });
  assert.strictEqual(d[S.TEAM] + d[S.DOUBLES] + d[S.MIXED] + d[S.SINGLES], 0);
});

// ── ② 正常系 ───────────────────────────────────────────────
test("書いた内容が読み返せれば ok:true", () => {
  setup({ team: 0 });
  const before = G._countRows(_sheets && sandbox.SpreadsheetApp.getActiveSpreadsheet());
  // 書き込み後の状態を作る
  setup({
    ledger: [ledgerRow({ tn: "テスト大会", team: "テスト団体A", contact: "山田 太郎", id: "op-abc-123" })],
    team: 4, doubles: 1, mixed: 1, singles: 1,
  });
  const v = G._verifyWrite(sandbox.SpreadsheetApp.getActiveSpreadsheet(), DATA, 2, before);
  assert.ok(v.ok, "検証を通る: " + JSON.stringify(v.problems));
  assert.strictEqual(v.ledger_row, 2);
  assert.ok(v.checks.some(c => c.indexOf("申込台帳") === 0), "台帳の確認が記録される");
});

// ── ③ 異常系(事故の形をひとつずつ再現する) ─────────────────────
test("台帳に行が無ければ ok:false", () => {
  setup({});
  const before = G._countRows(sandbox.SpreadsheetApp.getActiveSpreadsheet());
  const v = G._verifyWrite(sandbox.SpreadsheetApp.getActiveSpreadsheet(), DATA, 0, before);
  assert.strictEqual(v.ok, false);
  assert.match(v.problems.join("/"), /行が追加されていません/);
});

test("台帳の中身が別の申込なら ok:false(行番号だけ合っていても信用しない)", () => {
  setup({});
  const before = G._countRows(sandbox.SpreadsheetApp.getActiveSpreadsheet());
  setup({
    ledger: [ledgerRow({ tn: "テスト大会", team: "よその団体", contact: "山田 太郎" })],
    team: 4, doubles: 1, mixed: 1, singles: 1,
  });
  const v = G._verifyWrite(sandbox.SpreadsheetApp.getActiveSpreadsheet(), DATA, 2, before);
  assert.strictEqual(v.ok, false);
  assert.match(v.problems.join("/"), /団体名が一致しません/);
});

test("振分けシートの行が足りなければ ok:false", () => {
  setup({});
  const before = G._countRows(sandbox.SpreadsheetApp.getActiveSpreadsheet());
  setup({
    ledger: [ledgerRow({ tn: "テスト大会", team: "テスト団体A", contact: "山田 太郎" })],
    team: 2, doubles: 1, mixed: 1, singles: 1,     // 団体は4行入るはずが2行
  });
  const v = G._verifyWrite(sandbox.SpreadsheetApp.getActiveSpreadsheet(), DATA, 2, before);
  assert.strictEqual(v.ok, false);
  assert.match(v.problems.join("/"), /団体シート: 4行入るはずが 2行/);
});

test("他の申込が同時に入って行が多い分には通す(自分の分は入っている)", () => {
  setup({});
  const before = G._countRows(sandbox.SpreadsheetApp.getActiveSpreadsheet());
  setup({
    ledger: [ledgerRow({ tn: "テスト大会", team: "テスト団体A", contact: "山田 太郎" })],
    team: 6, doubles: 1, mixed: 1, singles: 1,
  });
  const v = G._verifyWrite(sandbox.SpreadsheetApp.getActiveSpreadsheet(), DATA, 2, before);
  assert.ok(v.ok, "多い分には落とさない: " + JSON.stringify(v.problems));
});

// ── ④ 申込IDによる二重登録の防止 ───────────────────────────────
test("同じ申込IDが台帳にあれば見つけられる(キャッシュが消えた後も効く)", () => {
  setup({
    ledger: [
      ledgerRow({ tn: "大会", team: "A", contact: "甲", id: "op-1" }),
      ledgerRow({ tn: "大会", team: "B", contact: "乙", id: "op-2" }),
    ],
  });
  const ss = sandbox.SpreadsheetApp.getActiveSpreadsheet();
  assert.strictEqual(G._findEntryIdRow(ss, "op-2"), 3, "2件目は3行目");
  assert.strictEqual(G._findEntryIdRow(ss, "op-9"), 0, "無ければ0");
  assert.strictEqual(G._findEntryIdRow(ss, ""), 0, "IDが空なら判定しない");
});

test("申込ID列が無い旧シートでは重複判定をしない(誤って握り潰さない)", () => {
  _sheets = { [S.LEDGER]: sheet(LEDGER_H.slice(0, 13), [ledgerRow({ tn: "大会", team: "A", contact: "甲" }).slice(0, 13)]) };
  assert.strictEqual(G._findEntryIdRow(sandbox.SpreadsheetApp.getActiveSpreadsheet(), "op-1"), 0);
});

// ── ⑤ 受信確認メールの宛先 ─────────────────────────────────────
test("宛先はカンマ・セミコロン・改行区切りで複数指定できる", () => {
  _props = { ADMIN_EMAIL: "a@example.com, b@example.com;c@example.com\nd@example.com" };
  const to = Array.from(G._notifyRecipients());
  assert.deepStrictEqual(to, ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]);
});

test("宛先が未設定ならシート所有者に送る(設定漏れで無通知にしない)", () => {
  _props = {};
  _owner = "owner@example.com";
  assert.deepStrictEqual(Array.from(G._notifyRecipients()), ["owner@example.com"]);
});

test("所有者も取れなければ実行ユーザーに送る", () => {
  _props = {};
  _owner = "";
  assert.deepStrictEqual(Array.from(G._notifyRecipients()), ["effective@example.com"]);
});

test("メールアドレスとして壊れている値は宛先にしない", () => {
  _props = { ADMIN_EMAIL: "notanemail, , @nope" };
  _owner = "owner@example.com";
  assert.deepStrictEqual(Array.from(G._notifyRecipients()), ["owner@example.com"], "壊れた値は捨てて所有者へ落ちる");
});

// ── ⑥ 突合用の申込ID一覧 ──────────────────────────────────────
test("突合用に申込IDの一覧を返す(大会で絞り込める)", () => {
  _props = {}; _owner = "owner@example.com";
  setup({
    ledger: [
      ledgerRow({ tn: "大会", team: "A", contact: "甲", id: "op-1", tid: "T1" }),
      ledgerRow({ tn: "大会", team: "B", contact: "乙", id: "op-2", tid: "T2" }),
      ledgerRow({ tn: "大会", team: "C", contact: "丙", id: "op-3", tid: "T1" }),
    ],
  });
  const r = G._buildEntryIds("T1");
  assert.strictEqual(r.has_id_column, true);
  assert.strictEqual(r.count, 2, "T1 の2件だけ");
  assert.deepStrictEqual(Array.from(r.ids), ["op-1", "op-3"]);
  assert.strictEqual(Array.from(r.rows)[0].team, "A", "団体名も返す(IDが空の行を人が探せるように)");
});

test("申込ID列が無い旧シートは has_id_column:false を返す(全部欠けていると誤解させない)", () => {
  _sheets = { [S.LEDGER]: sheet(LEDGER_H.slice(0, 13), [ledgerRow({ tn: "大会", team: "A", contact: "甲" }).slice(0, 13)]) };
  const r = G._buildEntryIds("");
  assert.strictEqual(r.has_id_column, false);
  assert.strictEqual(r.count, 1, "行数は数えられる(件数だけの突合に落とせる)");
});

test("台帳が空でも落ちない", () => {
  _sheets = { [S.LEDGER]: sheet(LEDGER_H, []) };
  const r = G._buildEntryIds("");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 0);
});

// ── 種目の判定(検証の土台) ─────────────────────────────────────
test("種目の判定が振分け先と一致する", () => {
  assert.strictEqual(G.classifyEntry({ event: "一般男子 団体戦", type: "team" }), "team");
  assert.strictEqual(G.classifyEntry({ event: "混合ダブルス", type: "doubles" }), "mixed", "混合はダブルスより先に判定");
  assert.strictEqual(G.classifyEntry({ event: "一般男子 ダブルス", type: "doubles" }), "doubles");
  assert.strictEqual(G.classifyEntry({ event: "一般男子 シングルス", type: "singles" }), "singles");
  assert.strictEqual(G.classifyEntry({ event: "お弁当", type: "bento" }), "bento");
});
