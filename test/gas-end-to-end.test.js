// 申込フォーム → 本体サーバー → GAS → スプレッドシート までの通し検証。
//
// なぜ必要か: 既存のテストは層ごとに分かれている。
//   gas-write-verify   … GAS の検証ロジック単体
//   gas-relay-verify   … 中継の成否判定単体
// しかし実際に起きた事故は「GASは記録できていないのに、本体は成功として扱い、
// 申込者には受け付けましたと表示した」という**層をまたぐ**取りこぼしだった。
// ここでは実物の doPost を Node 上で動かし、本体が送るのと同じ payload を流して、
// 記録・検証・メール・冪等・失敗時の振る舞いを通しで確かめる。
//
// 守らせる不変条件:
//   ① 正常時 … 台帳と振分けシートに正しく入り、ok:true / verified:true が返り、
//              申込者へ控えが送られ、主催者へ受信確認が送られる
//   ② 記録が壊れた時 … ok:false が返り、**申込者へ控えを送らない**(誤った安心を与えない)
//                      主催者へは【要確認】が必ず届く
//   ③ 再送 … 同じ申込IDは二重登録しない(キャッシュが消えた後もシートを見て弾く)
//   ④ 本体はその ok:false を失敗として扱う(HTTP200に騙されない)
process.env.DB_PATH = "/tmp/ktta_e2e_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const db = require("../db");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

// ── Google スプレッドシートの代役 ────────────────────────────────
// doPost が実際に使う API だけを、本物と同じ振る舞いで実装する
// (行/列は1始まり・appendRow は最終行の次に足す・範囲外の列は例外)。
// 書式まわり(setFontColor など)は結果に影響しないので、実装していないメソッドは
// 自分を返すだけにする。Proxy にしておくと GAS 側が装飾を足しても테スト側が追随不要。
function chainable(obj) {
  // 未実装のメソッドは Proxy 自身を返す。生のオブジェクトを返すと
  // 2つ目以降の連鎖(setFontWeight().setBackground())で落ちる。
  const p = new Proxy(obj, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "string" && /^(set|clear|merge|sort|hide|show|auto|protect|insert|activate|copy|move|update|add|remove|apply|freeze|resize|create|build)/.test(k)) {
        return () => p;
      }
      return undefined;
    },
  });
  return p;
}

function makeSheet(name) {
  const grid = [];
  let maxColumns = 26;
  const sh = {
    _grid: grid,
    getSheetName: () => name,
    getName: () => name,
    getMaxColumns: () => maxColumns,
    getMaxRows: () => Math.max(1000, grid.length),
    insertColumnsAfter(after, n) { maxColumns += n; return sh; },
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    clear() { grid.length = 0; return sh; },
    setFrozenRows: () => sh,
    getDataRange: () => sh.getRange(1, 1, Math.max(1, grid.length), Math.max(1, sh.getLastColumn())),
    getRange(r, c, nr, nc) {
      const rows = nr == null ? 1 : nr, cols = nc == null ? 1 : nc;
      if (c + cols - 1 > maxColumns) throw new Error("範囲外の列: " + (c + cols - 1) + " > " + maxColumns);
      const range = {
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
            const t = grid[r - 1 + i] || (grid[r - 1 + i] = []);
            line.forEach((v, j) => { t[c - 1 + j] = v; });
          });
          return range;
        },
        setValue(v) { const t = grid[r - 1] || (grid[r - 1] = []); t[c - 1] = v; return range; },
      };
      return chainable(range);
    },
    appendRow(row) { grid.push(row.slice()); return sh; },
  };
  return chainable(sh);
}

function makeEnv(opts) {
  opts = opts || {};
  const sheets = {};
  const mails = [];
  const cache = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
    getUrl: () => "https://docs.google.com/spreadsheets/d/TEST",
    getOwner: () => ({ getEmail: () => "owner@example.com" }),
    getSheets: () => Object.keys(sheets).map(k => sheets[k]),
    deleteSheet: (s) => { delete sheets[s.getSheetName()]; },
  };
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    JSON, String, Number, Array, Object, Math, Date, RegExp, Error, isNaN, parseInt, parseFloat,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ({ alert() {}, createMenu: () => ({ addItem: () => ({ addSeparator: () => ({ addItem: () => ({ addToUi() {} }) }) }) }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (opts.props && k in opts.props ? opts.props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    GmailApp: { sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); } },
    MailApp: { sendEmail: (o) => { mails.push(o); } },
    Session: { getEffectiveUser: () => ({ getEmail: () => "me@example.com" }), getActiveUser: () => ({ getEmail: () => "me@example.com" }) },
    Utilities: { formatDate: (d) => String(d), sleep() {} },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (t) => ({ _t: t, setMimeType: () => ({ getContent: () => t }), getContent: () => t }),
    },
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, "..", "gas", "entry_form_handler.gs"), "utf8");
  vm.runInContext(src + "\n;globalThis.__doPost = doPost; globalThis.__doGet = doGet;", sandbox);
  return { sandbox, sheets, mails, ss, post: (payload) => JSON.parse(sandbox.__doPost({ postData: { contents: JSON.stringify(payload) } }).getContent()) };
}

// ── 本体サーバーが GAS へ送るのと同じ payload を作る ────────────────
function makeSubmission() {
  const t = db.createTournament({ name: "通しテスト大会", date: "2027-06-01", venue: "会場" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [
      { name: "男子シングルス", type: "singles", fee: 700, category: "general" },
      { name: "男子ダブルス", type: "doubles", fee: 1000, category: "general" },
    ],
    field_config: { version: 2, fields: { furigana: "required", player_team: "required" }, custom: [], event_overrides: {} },
  });
  const tour = db.getTournament(t.id);
  const opId = "op-e2e-" + Math.random().toString(36).slice(2);
  const form = {
    tournament_id: tour.id, tournament_name: tour.name,
    team_name: "釧路卓球クラブ", contact_name: "担当 太郎",
    contact_tel: "0154-00-0000", contact_email: "applicant@example.com",
    entries: [
      { event: "男子シングルス", type: "singles", name: "甲野 一郎", team: "釧路卓球クラブ", furigana: "こうの いちろう" },
      { event: "男子ダブルス", type: "doubles", name1: "甲野 一郎", name2: "乙川 二郎",
        team1: "釧路卓球クラブ", team2: "釧路卓球クラブ", furigana1: "こうの いちろう", furigana2: "おつかわ じろう" },
    ],
  };
  const r = db.createTeamEntry(tour.id, form, opId);
  assert.ok(!r.error, r.error);
  // server.js の中継と同じ形に組み立てる
  const payload = { ...form, form_schema: db.buildFormSchema(tour), op_id: opId,
    total_amount: r.total_amount, option_items: r.options || [] };
  return { tour, payload, opId, result: r };
}

// ── ① 正常系 ─────────────────────────────────────────────
test("申込がシートに入り、検証を通り、両方のメールが出る", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({ props: { ADMIN_EMAIL: "honbu@example.com" } });
  const res = env.post(payload);

  assert.strictEqual(res.ok, true, "成功: " + JSON.stringify(res.problems || res.error || ""));
  assert.strictEqual(res.verified, true, "書いたものを読み返して確認できている");
  assert.ok(res.ledger_row >= 2, "台帳の行番号が返る");

  // 台帳に1行、シングルスに1行、ダブルスに1行
  const ledger = env.sheets["申込台帳"];
  assert.strictEqual(ledger.getLastRow(), 2, "台帳はヘッダ+1行");
  const head = ledger._grid[0].map(String);
  const row = ledger._grid[1];
  assert.strictEqual(row[head.indexOf("団体名")], "釧路卓球クラブ");
  assert.strictEqual(row[head.indexOf("申込責任者")], "担当 太郎");
  assert.strictEqual(row[head.indexOf("合計金額")], payload.total_amount);
  assert.ok(head.indexOf("申込ID") >= 0, "申込ID列が作られる");
  assert.strictEqual(String(row[head.indexOf("申込ID")]), payload.op_id, "申込IDが記録される");

  assert.strictEqual(env.sheets["シングルス"].getLastRow(), 2, "シングルス1行");
  assert.strictEqual(env.sheets["ダブルス"].getLastRow(), 2, "ダブルス1行");

  // メール2通(申込者への控え + 主催者への受信確認)
  assert.strictEqual(env.mails.length, 2, "控えと受信確認の2通");
  const toApplicant = env.mails.find(m => m.to === "applicant@example.com");
  const toHonbu = env.mails.find(m => m.to === "honbu@example.com");
  assert.ok(toApplicant, "申込者へ控えが届く");
  assert.match(toApplicant.subject, /お申込みを受け付けました/);
  assert.match(toApplicant.body, /甲野 一郎/, "申込内容が本文に入る");
  assert.ok(toHonbu, "主催者へ受信確認が届く");
  assert.match(toHonbu.subject, /【受信確認】/);
  assert.match(toHonbu.body, /記録できたことを確認/, "確認できた事実を書く");
  assert.strictEqual(res.reply_mail, "sent");
});

test("ふりがなが定義されていればシートの列になり、値が入る", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({});
  env.post(payload);
  const sh = env.sheets["シングルス"];
  const head = sh._grid[0].map(String);
  const i = head.indexOf("ふりがな");
  assert.ok(i >= 0, "ふりがな列が作られる: " + JSON.stringify(head));
  assert.strictEqual(String(sh._grid[1][i]), "こうの いちろう");
});

test("受信確認の宛先が未設定でもシート所有者に届く(無通知にしない)", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({});                       // ADMIN_EMAIL 未設定
  env.post(payload);
  assert.ok(env.mails.some(m => m.to === "owner@example.com"), "所有者へ落ちる");
});

// ── ② 記録が壊れた時 ────────────────────────────────────────
test("台帳に書けなかったら失敗を返し、申込者へ控えを送らない", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({ props: { ADMIN_EMAIL: "honbu@example.com" } });
  // 台帳への appendRow を握り潰す = 「書いたつもりで書けていない」状態を作る
  const orig = env.ss.insertSheet;
  env.ss.insertSheet = (n) => {
    const sh = orig(n);
    if (n === "申込台帳") sh.appendRow = () => sh;   // 何も起きない
    return sh;
  };
  const res = env.post(payload);

  assert.strictEqual(res.ok, false, "成功を返さない");
  assert.strictEqual(res.verified, false);
  assert.match(res.error, /記録を確認できませんでした/);
  assert.ok(Array.isArray(res.problems) && res.problems.length, "何が確認できなかったかを返す");

  const toApplicant = env.mails.find(m => m.to === "applicant@example.com");
  assert.strictEqual(toApplicant, undefined, "申込者へ「受け付けました」を送らない(誤った安心を与えない)");
  const toHonbu = env.mails.find(m => m.to === "honbu@example.com");
  assert.ok(toHonbu, "主催者へは必ず知らせる");
  assert.match(toHonbu.subject, /要確認/, "件名で異常と分かる: " + toHonbu.subject);
  assert.match(toHonbu.body, /至急ご確認ください/);
  assert.match(toHonbu.body, /再送/, "どう直すかが書いてある");
});

test("振分けシートに行が入らなかったら失敗にする", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({});
  const orig = env.ss.insertSheet;
  env.ss.insertSheet = (n) => {
    const sh = orig(n);
    if (n === "ダブルス") sh.appendRow = () => sh;
    return sh;
  };
  const res = env.post(payload);
  assert.strictEqual(res.ok, false);
  assert.match(res.problems.join("/"), /ダブルス/);
});

// ── ③ 再送・冪等 ────────────────────────────────────────────
test("同じ申込を再送しても二重登録しない", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({});
  const a = env.post(payload);
  assert.strictEqual(a.ok, true);
  const b = env.post(payload);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.duplicate, true, "再送と分かる");
  assert.strictEqual(env.sheets["申込台帳"].getLastRow(), 2, "台帳は1行のまま");
  assert.strictEqual(env.sheets["シングルス"].getLastRow(), 2, "振分けも増えない");
  assert.strictEqual(env.mails.length, 2, "再送で控えメールを二度送らない");
});

test("キャッシュが消えた後の再送も、台帳の申込IDを見て弾く", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({});
  env.post(payload);
  // CacheService を空にする = 6時間経過や再起動の再現
  env.sandbox.CacheService = { getScriptCache: () => ({ get: () => null, put: () => {} }) };
  const b = env.post(payload);
  assert.strictEqual(b.duplicate, true, "シート自身を正本にして弾く");
  assert.strictEqual(env.sheets["申込台帳"].getLastRow(), 2);
});

test("別の申込は普通に追加される(弾きすぎない)", () => {
  const a = makeSubmission(), b = makeSubmission();
  const env = makeEnv({});
  assert.strictEqual(env.post(a.payload).ok, true);
  assert.strictEqual(env.post(b.payload).ok, true);
  assert.strictEqual(env.sheets["申込台帳"].getLastRow(), 3, "台帳は2行");
});

// ── ④ 本体側の成否判定と噛み合うか ──────────────────────────────
test("本体は GAS の ok:false を失敗として扱う(HTTP200に騙されない)", async () => {
  process.env.ADMIN_KEY = process.env.ADMIN_KEY || "e2e-key";
  const server = require("../server.js");
  const relay = server.__test__.relayEntryToGas;
  const http = require("node:http");

  const { payload } = makeSubmission();
  const env = makeEnv({});
  const orig = env.ss.insertSheet;
  env.ss.insertSheet = (n) => { const sh = orig(n); if (n === "申込台帳") sh.appendRow = () => sh; return sh; };

  // 実物の doPost を HTTP で公開し、本体の中継から叩く
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", c => { b += c; });
    req.on("end", () => {
      const out = env.sandbox.__doPost({ postData: { contents: b } }).getContent();
      res.writeHead(200, { "Content-Type": "application/json" });   // GAS は失敗でも 200
      res.end(out);
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const r = await relay(url, payload);
  srv.close();

  assert.strictEqual(r.ok, false, "本体も失敗と判定する");
  assert.match(r.error, /記録を確認できませんでした/, "GASの理由がそのまま伝わる");
  assert.ok(Array.isArray(r.problems) && r.problems.length, "何が欠けたかも伝わる");
});

test("突合APIが台帳の申込IDを返す(締切前の欠落チェックに使える)", () => {
  const a = makeSubmission(), b = makeSubmission();
  const env = makeEnv({});
  env.post(a.payload);
  env.post(b.payload);
  const out = JSON.parse(env.sandbox.__doGet({
    parameter: { action: "entry_ids", tournament_id: a.payload.tournament_id },
  }).getContent());
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.has_id_column, true);
  assert.strictEqual(out.count, 1, "大会で絞り込める");
  assert.deepStrictEqual(Array.from(out.ids), [a.payload.op_id]);
});

// ══ 実運用に近い形の通し検証 ═══════════════════════════════════════
// 31列バグは「新しいシートで、団体戦を含む申込」で初めて出た。同じ種類の
// 取りこぼし(条件が揃ったときだけ落ちる)を探すため、実際の要項に近い形で流す。

function makeRichSubmission() {
  const t = db.createTournament({ name: "まりもオープン in Akan", date: "2027-09-20", venue: "会場" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [
      { name: "男子シングルス", type: "singles", fee: 700, category: "general" },
      { name: "混合ダブルス", type: "doubles", fee: 1000, category: "general" },
      { name: "一般 団体戦", type: "team", fee: 1000, fee_unit: "person", category: "general",
        per_team: 4, per_team_min: 4 },
    ],
    entry_options: [
      { key: "bento", label: "お弁当", price: 800, unit: "個", max: 10 },
      { key: "party", label: "懇親会", price: 3500, unit: "名", max: 10 },
    ],
    field_config: {
      version: 2,
      fields: { furigana: "required", player_team: "required", grade: "optional" },
      custom: [
        { key: "zekken", label: "ゼッケン番号", type: "text", scope: "player" },
        { key: "bus", label: "送迎バス希望", type: "checkbox", scope: "submission" },
      ],
      event_overrides: {},
    },
  });
  const tour = db.getTournament(t.id);
  const opId = "op-rich-" + Math.random().toString(36).slice(2);
  const form = {
    tournament_id: tour.id, tournament_name: tour.name,
    team_name: "阿寒クラブ", contact_name: "担当 花子",
    contact_tel: "0154-11-2222", contact_email: "akan@example.com",
    supervisor: "引率 一郎", coach: "コーチ 二郎", note: "駐車場を希望します",
    answers: { bus: true },
    options: { bento: 5, party: 3 },
    entries: [
      { event: "男子シングルス", type: "singles", name: "甲野 一郎", team: "阿寒クラブ",
        furigana: "こうの いちろう", extra_json: { grade: "", answers: { zekken: "12" } } },
      { event: "混合ダブルス", type: "doubles", name1: "甲野 一郎", name2: "丙田 花子",
        team1: "阿寒クラブ", team2: "阿寒クラブ",
        furigana1: "こうの いちろう", furigana2: "へいだ はなこ" },
      { event: "一般 団体戦", type: "team", team_name: "阿寒クラブA",
        members: ["甲野 一郎", "乙川 二郎", "丙田 花子", "丁原 三郎"] },
    ],
  };
  const r = db.createTeamEntry(tour.id, form, opId);
  assert.ok(!r.error, r.error);
  const payload = { ...form, form_schema: db.buildFormSchema(tour), op_id: opId,
    total_amount: r.total_amount, option_items: r.options || [] };
  return { tour, payload, result: r };
}

test("団体戦・オプション・自由項目を含む申込が丸ごと記録される", () => {
  const { payload, result } = makeRichSubmission();
  const env = makeEnv({ props: { ADMIN_EMAIL: "honbu@example.com" } });
  const res = env.post(payload);

  assert.strictEqual(res.ok, true, "成功: " + JSON.stringify(res.problems || res.error || ""));
  assert.strictEqual(res.verified, true);

  // 団体は「メンバー1人=1行」で入る(要項の1人1,000円に対応する数え方)
  assert.strictEqual(env.sheets["団体"].getLastRow(), 5, "ヘッダ + メンバー4行");
  assert.strictEqual(env.sheets["シングルス"].getLastRow(), 2);
  assert.strictEqual(env.sheets["ミックス"].getLastRow(), 3, "混合はペアの2名を別行に展開(ヘッダ+2行)");

  // 選手名簿(31列レイアウト)が新規シートでも書けている
  const roster = env.sheets["選手名簿"];
  assert.ok(roster, "選手名簿シートが作られる");
  assert.ok(roster.getLastRow() >= 3, "ヘッダ2行 + データ");

  // 有料オプションが台帳の列になり、数量が入る
  const head = env.sheets["申込台帳"]._grid[0].map(String);
  const row = env.sheets["申込台帳"]._grid[1];
  const bentoCol = head.findIndex(h => h.indexOf("お弁当") === 0);
  assert.ok(bentoCol >= 0, "お弁当の列ができる: " + JSON.stringify(head));
  assert.strictEqual(row[bentoCol], 5, "数量が入る");

  // 申込単位の自由項目も列になる
  assert.ok(head.some(h => h.indexOf("送迎バス希望") >= 0), "自由項目が列になる: " + JSON.stringify(head));

  // 金額はサーバーが確定した値をそのまま使う(GAS側で再計算しない)
  assert.strictEqual(row[head.indexOf("合計金額")], result.total_amount);
});

test("選手ごとの自由項目が種目シートの列になる", () => {
  const { payload } = makeRichSubmission();
  const env = makeEnv({});
  env.post(payload);
  const head = env.sheets["シングルス"]._grid[0].map(String);
  assert.ok(head.some(h => h.indexOf("ゼッケン番号") >= 0), "選手スコープの自由項目が列になる: " + JSON.stringify(head));
});

test("選手名簿の列が足りないシートでも書ける(旧版が作った名簿の救済)", () => {
  const { payload } = makeRichSubmission();
  const env = makeEnv({});
  // ヘッダ2行だけ在って列が26しかない名簿を先に用意する
  const sh = env.ss.insertSheet("選手名簿");
  sh.getRange(1, 1).setValue("団体");
  sh.getRange(2, 1).setValue("申請団体");
  const res = env.post(payload);
  assert.strictEqual(res.ok, true, "列を広げて書ける: " + JSON.stringify(res.problems || res.error || ""));
});

test("控えメールを本体が送る構成では、GASは申込者へ送らない(二重送信の防止)", () => {
  const { payload } = makeRichSubmission();
  const env = makeEnv({ props: { ADMIN_EMAIL: "honbu@example.com" } });
  const res = env.post({ ...payload, suppress_reply_mail: true });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reply_mail, "skipped");
  assert.ok(!env.mails.some(m => m.to === "akan@example.com"), "申込者へは送らない");
  const honbu = env.mails.find(m => m.to === "honbu@example.com");
  assert.ok(honbu, "受信確認は届く");
  assert.match(honbu.body, /本部システムから送信されます/, "なぜ送っていないかを書く");
});

test("フラグが無い旧構成では従来どおりGASが控えを送る(後方互換)", () => {
  const { payload } = makeRichSubmission();
  const env = makeEnv({});
  const res = env.post(payload);                 // suppress_reply_mail 無し
  assert.strictEqual(res.reply_mail, "sent");
  assert.ok(env.mails.some(m => m.to === "akan@example.com"));
});

test("必須項目が欠けた送信は記録せずに断る", () => {
  const { payload } = makeRichSubmission();
  const env = makeEnv({});
  const res = env.post({ ...payload, contact_email: "" });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /必須項目が未入力/);
  assert.strictEqual(env.sheets["申込台帳"], undefined, "シートを触らずに断る");
});

test("出場者ゼロの送信は断る", () => {
  const { payload } = makeRichSubmission();
  const env = makeEnv({});
  const res = env.post({ ...payload, entries: [] });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /出場選手が登録されていません/);
});

test("壊れたJSONでも落ちずに日本語で断る", () => {
  const env = makeEnv({});
  const out = JSON.parse(env.sandbox.__doPost({ postData: { contents: "{壊れている" } }).getContent());
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /JSON 解析失敗/);
});
