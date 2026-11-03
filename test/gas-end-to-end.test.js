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

  // 選手名簿(31列・まりもオープン様式)は既定では作らない。
  // 種目構成の違う大会に無条件で作ると、意味の無い枠が並んで読みにくくなるため。
  assert.strictEqual(env.sheets["選手名簿"], undefined,
    "既定では作らない(既にある大会か LEGACY_SUMMARY=1 のときだけ)");
  assert.strictEqual(env.sheets["集計用"], undefined, "集計用も同じ");

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

// ══ 控えメールの差出人 ═════════════════════════════════════════
// Google の制約で、差出人は「Gmailの送信元として登録済み(エイリアス)」でないと変えられない。
// 未登録のアドレスを from に渡すと送信そのものが失敗するので、確かめてから使う。
// 未登録なら差出人は所有者のままにし、返信先(replyTo)だけ希望アドレスに寄せる。
function makeEnvWithGmail(opts) {
  const env = makeEnv(opts);
  const sent = [];
  env.sandbox.GmailApp = {
    getAliases: () => (opts.aliases || []),
    sendEmail: (to, subject, body, o) => { sent.push({ to, subject, body, opts: o || {} }); },
  };
  env.sent = sent;
  return env;
}

test("差出人がGmailに登録済みなら、そのアドレスから送る", () => {
  const { payload } = makeSubmission();
  const env = makeEnvWithGmail({ props: { REPLY_FROM: "entry@kushirotta.jp", ADMIN_EMAIL: "honbu@example.com" },
    aliases: ["entry@kushirotta.jp"] });
  env.post(payload);
  const reply = env.sent.find(m => m.to === "applicant@example.com");
  assert.ok(reply, "申込者へ送っている");
  assert.strictEqual(reply.opts.from, "entry@kushirotta.jp", "差出人を差し替える");
  assert.strictEqual(reply.opts.replyTo, undefined, "差出人を変えられたので返信先の指定は不要");
});

test("未登録のアドレスは差出人にせず、返信先だけ寄せる(送信失敗を避ける)", () => {
  const { payload } = makeSubmission();
  const env = makeEnvWithGmail({ props: { REPLY_FROM: "entry@kushirotta.jp" }, aliases: [] });
  env.post(payload);
  const reply = env.sent.find(m => m.to === "applicant@example.com");
  assert.strictEqual(reply.opts.from, undefined, "登録されていない差出人は使わない");
  assert.strictEqual(reply.opts.replyTo, "entry@kushirotta.jp", "返信先には設定する");
});

test("REPLY_FROM 未設定なら受信確認の宛先を差出人にする", () => {
  const { payload } = makeSubmission();
  const env = makeEnvWithGmail({ props: { ADMIN_EMAIL: "honbu@example.com, sub@example.com" },
    aliases: ["honbu@example.com"] });
  env.post(payload);
  const reply = env.sent.find(m => m.to === "applicant@example.com");
  assert.strictEqual(reply.opts.from, "honbu@example.com", "1つ目を使う");
});

test("差出人が所有者本人なら余計な指定をしない", () => {
  const { payload } = makeSubmission();
  const env = makeEnvWithGmail({ props: { REPLY_FROM: "me@example.com" }, aliases: [] });
  env.post(payload);
  const reply = env.sent.find(m => m.to === "applicant@example.com");
  assert.strictEqual(reply.opts.from, undefined);
  assert.strictEqual(reply.opts.replyTo, undefined);
  assert.ok(reply.opts.name, "差出人名は付ける");
});

test("何も設定していなくても控えメールは送れる", () => {
  const { payload } = makeSubmission();
  const env = makeEnvWithGmail({ props: {}, aliases: [] });
  const res = env.post(payload);
  assert.strictEqual(res.ok, true);
  assert.ok(env.sent.some(m => m.to === "applicant@example.com"));
});

// ══ 集計シートを最低限にする(2026-08-04 オーナー方針) ═══════════════
// 「申込混在状態」の報告を受けての整理。
//   ・その大会に無い種目の空シートを作らない
//   ・弁当・懇親会は基本的に不要(該当の申込があるときだけ)
//   ・選手名簿/集計用(まりもオープン様式)は既定で作らない
//   ・種目シートの各行に「エントリーID」を置き、申込へ紐づけられるようにする
//   ・台帳の固定列は最低限。引率顧問等はフォームで聞いている大会だけ列になる

test("その大会に出てくる種目のシートだけ作る", () => {
  const { payload } = makeSubmission();          // シングルス + ダブルス のみ
  const env = makeEnv({});
  env.post(payload);
  assert.ok(env.sheets["シングルス"], "申込のある種目は作る");
  assert.ok(env.sheets["ダブルス"], "申込のある種目は作る");
  assert.strictEqual(env.sheets["団体"], undefined, "申込の無い種目は作らない");
  assert.strictEqual(env.sheets["ミックス"], undefined);
  assert.strictEqual(env.sheets["ダブルス相手募集者"], undefined, "募集が無ければ作らない");
});

test("弁当・懇親会のシートは該当の申込があるときだけ作る", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({});
  env.post(payload);
  assert.strictEqual(env.sheets["お弁当、懇親会"], undefined, "基本的に不要");

  const { payload: p2 } = makeSubmission();
  const env2 = makeEnv({});
  p2.entries.push({ event: "お弁当", type: "bento", count: 3, name: "釧路クラブ" });
  env2.post(p2);
  assert.ok(env2.sheets["お弁当、懇親会"], "申込があれば作る");
});

test("種目シートの各行にエントリーIDが入る", () => {
  const { payload } = makeSubmission();
  // 本体サーバーが付ける entry_id を再現する
  payload.entries[0].entry_id = "abcd1234-5678-90ef-ghij-klmnopqrstuv";
  payload.entries[1].entry_id = "ffff9999-1111-2222-3333-444455556666";
  const env = makeEnv({});
  env.post(payload);
  const sg = env.sheets["シングルス"];
  const head = sg._grid[0].map(String);
  assert.strictEqual(head[0], "エントリーID", "先頭列に置く(最初に目に入る)");
  assert.strictEqual(String(sg._grid[1][0]), "abcd1234", "先頭8文字に短縮する");
  const db2 = env.sheets["ダブルス"];
  assert.strictEqual(String(db2._grid[1][0]), "ffff9999");
});

test("エントリーIDが無い申込(旧プラットフォーム)でも列は空で通る", () => {
  const { payload } = makeSubmission();          // entry_id を付けない
  const env = makeEnv({});
  const res = env.post(payload);
  assert.strictEqual(res.ok, true, "記録できる");
  assert.strictEqual(String(env.sheets["シングルス"]._grid[1][0]), "", "空欄になるだけ");
});

test("台帳の固定列は最低限で、突合の照合キーは残す", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({});
  env.post(payload);
  const head = env.sheets["申込台帳"]._grid[0].map(String);
  ["受付日時", "大会名", "団体名", "申込責任者", "電話番号", "メールアドレス",
   "申込種目数", "参加人数(述べ)", "合計金額"].forEach(h => {
    assert.ok(head.includes(h), h + " は固定列");
  });
  assert.ok(head.includes("tournament_id"), "突合の絞り込みに使うので残す");
  assert.ok(head.includes("申込ID"), "二重登録の防止と逆引きに使う");
  // 引率顧問・コーチ・備考(通信欄)は「固定列」ではなくなった。
  // 既定のフォームではこれらを聞いているので列にはなるが、出どころは form_schema。
  // 聞いていない大会では列が出ないことは次のテストで確かめる。
  const fixed = head.slice(0, LEDGER_FIXED.length);
  assert.deepStrictEqual(fixed, LEDGER_FIXED, "固定列は最低限の並び");
});
const LEDGER_FIXED = ["受付日時", "大会名", "団体名", "申込責任者", "電話番号", "メールアドレス",
  "申込種目数", "参加人数(述べ)", "合計金額", "tournament_id"];

test("フォームで聞いている項目だけが台帳の列になる", () => {
  const t = db.createTournament({ name: "監督を聞く大会", date: "2027-06-01", venue: "会場" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [{ name: "団体戦", type: "team", fee: 3000 }],
    field_config: { version: 2, fields: { supervisor: "optional", coach: "hidden", note: "hidden" },
      custom: [], event_overrides: {}, field_meta: { supervisor: { label: "監督" } } },
  });
  const cols = db.buildFormSchema(db.getTournament(t.id)).columns.ledger.map(c => c.label);
  assert.ok(cols.includes("監督"), "聞いている項目は列になる: " + JSON.stringify(cols));
  assert.ok(!cols.includes("コーチ"), "聞いていない項目は列にしない");
  assert.ok(!cols.includes("通信欄"));
});

test("まりもオープン様式のシートが既にあれば従来どおり更新する", () => {
  const { payload } = makeSubmission();
  const env = makeEnv({});
  env.ss.insertSheet("選手名簿");                 // その様式で運用している大会を再現
  const res = env.post(payload);
  assert.strictEqual(res.ok, true, res.error || "");
  assert.ok(env.sheets["集計用"], "既存運用は壊さない(集計用も作られる)");
});

// ── entry_categories(ビギナー/サーティ/フォーティ等の年代区分)がシートに反映される ──
// 事故の実態: シートの「区分」列は種目名から男子/女子だけを拾う deriveDivision 固定で、
// entry_categories で選んだ年代区分(division_label)は一切書かれていなかった。
test("entry_categories の区分ラベルがシングルスシートの「区分」列に反映される", () => {
  const t = db.createTournament({
    name: "区分反映大会", date: "2027-06-01", venue: "会場", entries_open: 1,
    event_config: [{
      name: "個人戦 シングルス", type: "singles", fee: 2000, category: "general",
      entry_categories: [
        { value: "beginner", label: "ビギナーの部", short: "ビギナー" },
        { value: "under30", label: "サーティ以下", short: "サーティ以下" },
        { value: "forty", label: "フォーティ", short: "フォーティ" },
      ],
    }],
  });
  const opId = "op-cat-" + Math.random().toString(36).slice(2);
  const form = {
    tournament_id: t.id, tournament_name: t.name,
    team_name: "釧路卓球クラブ", contact_name: "担当 太郎", contact_tel: "0154-00-0000", contact_email: "a@b.jp",
    entries: [
      { event: "個人戦 シングルス", type: "singles", name: "甲野 一郎", team: "釧路卓球クラブ",
        division: "under30", division_label: "サーティ以下" },
      { event: "個人戦 シングルス", type: "singles", name: "乙川 二郎", team: "釧路卓球クラブ",
        division: "forty", division_label: "フォーティ" },
    ],
  };
  const r = db.createTeamEntry(t.id, form, opId);
  assert.ok(!r.error, r.error);
  const payload = { ...form, form_schema: db.buildFormSchema(db.getTournament(t.id)), op_id: opId,
    total_amount: r.total_amount, option_items: r.options || [] };

  const env = makeEnv({});
  const res = env.post(payload);
  assert.strictEqual(res.ok, true, res.error || "");

  const sg = env.sheets["シングルス"];
  const head = sg._grid[0].map(String);
  const divCol = head.indexOf("区分");
  assert.ok(divCol >= 0, "区分列がある");
  const rows = sg._grid.slice(1).map(row => row[divCol]);
  assert.ok(rows.includes("サーティ以下"), "選んだ区分がそのままシートに載る: " + JSON.stringify(rows));
  assert.ok(rows.includes("フォーティ"), "選んだ区分がそのままシートに載る: " + JSON.stringify(rows));
  assert.ok(!rows.includes("一般"), "従来の「一般」固定に戻っていない: " + JSON.stringify(rows));
});

test("entry_categories が無い種目は従来通り種目名から性別区分を維持する(後方互換)", () => {
  const { payload } = makeSubmission();   // "男子シングルス"/"男子ダブルス"(entry_categories無し)
  const env = makeEnv({});
  env.post(payload);
  const sg = env.sheets["シングルス"];
  const head = sg._grid[0].map(String);
  const divCol = head.indexOf("区分");
  assert.strictEqual(String(sg._grid[1][divCol]), "一般男子",
    "entry_categories 未使用の大会は従来どおり種目名由来の区分のまま");
});

test("entry_categories と性別つき種目名を両方持つ場合は併記し、集計の男女判定を壊さない", () => {
  const t = db.createTournament({
    name: "併記大会", date: "2027-06-02", venue: "会場", entries_open: 1,
    event_config: [{
      name: "一般男子 団体戦", type: "team", fee: 3000,
      entry_categories: [{ value: "a", label: "Aブロック", short: "Aブロック" }],
    }],
  });
  const opId = "op-mix-" + Math.random().toString(36).slice(2);
  const form = {
    tournament_id: t.id, tournament_name: t.name,
    team_name: "釧路卓球クラブ", contact_name: "担当 太郎", contact_tel: "0154-00-0000", contact_email: "a@b.jp",
    entries: [{
      event: "一般男子 団体戦", type: "team", team_name: "釧路卓球クラブ",
      division: "a", division_label: "Aブロック",
      members: ["甲野 一郎", "乙川 二郎"],
      members_detail: [{ name: "甲野 一郎", age: 20 }, { name: "乙川 二郎", age: 21 }],
    }],
  };
  const r = db.createTeamEntry(t.id, form, opId);
  assert.ok(!r.error, r.error);
  const payload = { ...form, form_schema: db.buildFormSchema(db.getTournament(t.id)), op_id: opId,
    total_amount: r.total_amount, option_items: r.options || [] };
  const env = makeEnv({});
  const res = env.post(payload);
  assert.strictEqual(res.ok, true, res.error || "");
  const teamSh = env.sheets["団体"];
  const head = teamSh._grid[0].map(String);
  const divCol = head.indexOf("区分");
  const divVal = String(teamSh._grid[1][divCol]);
  assert.strictEqual(divVal, "Aブロック（一般男子）", "区分ラベルに性別を併記する: " + divVal);
  assert.match(divVal, /男/, "集計用シートの男女カウント(/男/.test)が引き続き拾える文字列である");
});

// ── 申込後の修正(action=update) ───────────────────────────────
// 本体で申込を直すと「その申込の今の姿」が届く。GAS は申込ID・エントリーIDで行を探して書き換え、
// 取り消した出場は消さずに「状態=取消」と残し、変更履歴シートに1行ずつ追記する。
function makeEditableSubmission() {
  const t = db.createTournament({ name: "修正反映大会", date: "2027-07-01", venue: "会場" });
  db.updateEntrySettings(t.id, {
    entries_open: 1,
    event_config: [
      { name: "男子シングルス", type: "singles", fee: 700 },
      { name: "高校男子シングルス", type: "singles", fee: 500 },
      { name: "男子ダブルス", type: "doubles", fee: 1000 },
      { name: "団体戦", type: "team", fee: 1000, fee_unit: "person", per_team: 6, per_team_min: 3 },
    ],
  });
  const tour = db.getTournament(t.id);
  const opId = "op-upd-" + Math.random().toString(36).slice(2);
  const form = {
    tournament_id: tour.id, tournament_name: tour.name,
    team_name: "修正クラブ", contact_name: "担当 一郎", contact_tel: "0154-00-1111", contact_email: "a@example.com",
    entries: [
      { event: "男子シングルス", type: "singles", name: "架空 太郎", team: "修正クラブ" },
      { event: "男子ダブルス", type: "doubles", name1: "架空 次郎", name2: "架空 三郎", team1: "修正クラブ", team2: "修正クラブ" },
      { event: "団体戦", type: "team", team_name: "修正A", members: ["甲 一", "乙 二", "丙 三"] },
    ],
  };
  const r = db.createTeamEntry(tour.id, form, opId);
  assert.ok(!r.error, r.error);
  const payload = { ...form, form_schema: db.buildFormSchema(tour), op_id: opId, total_amount: r.total_amount,
    option_items: r.options || [] };
  payload.entries = payload.entries.map(e => ({ ...e }));
  r.created_entries.forEach(ce => { payload.entries[ce.entry_index].entry_id = ce.entry_id; });
  const view = db.getSubmissionEditView(r.submission_id, { admin: true });
  const byEv = (ev) => view.entries.find(e => e.event === ev);
  return { tour, payload, sid: r.submission_id, byEv };
}
const liveRows = (sh) => {
  const head = sh._grid[0].map(String);
  const st = head.indexOf("状態");
  return sh._grid.slice(1).filter(r => st < 0 || String(r[st] || "").indexOf("取消") !== 0);
};

test("修正: 氏名・連絡先の変更で、元の行が書き換わり履歴が残る(行は増えない)", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  assert.strictEqual(env.post(s.payload).ok, true);
  const e = db.editSubmission(s.sid, {
    contact: { contact_name: "担当 二郎" },
    entries: [{ entrant_id: s.byEv("男子シングルス").entry_id, name: "架空 四郎" }],
    reason: "記入ミス",
  }, { actor: "admin" });
  assert.ok(e.ok, e.error);
  const res = env.post(db.buildSheetUpdatePayload(s.sid, e.group));
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.ok(res.updated_rows >= 1);
  assert.deepStrictEqual(res.missing, []);

  const sg = env.sheets["シングルス"];
  assert.strictEqual(sg.getLastRow(), 2, "行は増えない");
  const head = sg._grid[0].map(String);
  assert.strictEqual(sg._grid[1][head.indexOf("氏名")], "架空 四郎");
  const lg = env.sheets["申込台帳"];
  const lh = lg._grid[0].map(String);
  assert.strictEqual(lg.getLastRow(), 2);
  assert.strictEqual(lg._grid[1][lh.indexOf("申込責任者")], "担当 二郎");
  assert.ok(lh.includes("最終修正"));
  assert.ok(!lh.includes("入金状況") && !lh.includes("入金額"), "入金の列は作らない(金銭の収受は扱わない)");

  const hist = env.sheets["変更履歴"];
  assert.ok(hist && hist.getLastRow() >= 2, "変更履歴が残る");
  const hh = hist._grid[0].map(String);
  assert.ok(hist._grid.slice(1).some(r => r[hh.indexOf("理由")] === "記入ミス"));
  assert.ok(hist._grid.slice(1).every(r => r[hh.indexOf("変更者")] === "本部"));
});

test("修正: 同じ変更を再送しても履歴は二重にならず、結果も同じ", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  const e = db.editSubmission(s.sid, { entries: [{ entrant_id: s.byEv("男子シングルス").entry_id, name: "架空 五郎" }] }, { actor: "applicant" });
  const p = db.buildSheetUpdatePayload(s.sid, e.group);
  env.post(p);
  const n = env.sheets["変更履歴"].getLastRow();
  const res2 = env.post(p);
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.duplicate_history, true);
  assert.strictEqual(env.sheets["変更履歴"].getLastRow(), n, "履歴は増えない");
  assert.strictEqual(env.sheets["シングルス"].getLastRow(), 2, "行も増えない");
});

test("修正: 取り消した出場は行を消さず「状態=取消」、種目別の数からも外れる", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  const e = db.editSubmission(s.sid, { entries: [{ entrant_id: s.byEv("男子ダブルス").entry_id, cancel: true }] }, { actor: "admin" });
  assert.ok(e.ok, e.error);
  const res = env.post(db.buildSheetUpdatePayload(s.sid, e.group));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.cancelled_rows, 1);
  const dbl = env.sheets["ダブルス"];
  assert.strictEqual(dbl.getLastRow(), 2, "行は残る");
  assert.strictEqual(liveRows(dbl).length, 0, "取消として扱われる");
  const lh = env.sheets["申込台帳"]._grid[0].map(String);
  assert.strictEqual(env.sheets["申込台帳"]._grid[1][lh.indexOf("合計金額")], db.buildSheetUpdatePayload(s.sid, "").submission.total_amount);
});

test("修正: 団体メンバーが増えれば行を足し、減れば余りを取消にする", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  const tm = s.byEv("団体戦");
  let e = db.editSubmission(s.sid, { entries: [{ entrant_id: tm.entry_id, members: ["甲 一", "乙 二", "丙 三", "丁 四"] }] }, { actor: "admin" });
  assert.ok(e.ok, e.error);
  let res = env.post(db.buildSheetUpdatePayload(s.sid, e.group));
  assert.strictEqual(res.appended_rows, 1);
  assert.strictEqual(liveRows(env.sheets["団体"]).length, 4);
  e = db.editSubmission(s.sid, { entries: [{ entrant_id: tm.entry_id, members: ["甲 一", "乙 二", "丙 三"] }] }, { actor: "admin" });
  res = env.post(db.buildSheetUpdatePayload(s.sid, e.group));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(liveRows(env.sheets["団体"]).length, 3, "余った1行は取消");
  assert.strictEqual(env.sheets["団体"].getLastRow(), 5, "行自体は消さない");
});

test("修正: シートに元の申込が無ければ失敗を返し、勝手に追記しない", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});                       // 元の申込を送っていない
  const e = db.editSubmission(s.sid, { entries: [{ entrant_id: s.byEv("男子シングルス").entry_id, name: "架空 六郎" }] }, { actor: "admin" });
  const res = env.post(db.buildSheetUpdatePayload(s.sid, e.group));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /見つかりません/);
  assert.ok(res.missing.length >= 1);
  assert.ok(!env.sheets["シングルス"] || env.sheets["シングルス"].getLastRow() <= 1, "追記しない");
});

test("修正: 古いGASに届いても新規申込として二重登録されない(必須項目不足で断られる)", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  const e = db.editSubmission(s.sid, { entries: [{ entrant_id: s.byEv("男子シングルス").entry_id, name: "架空 七郎" }] }, { actor: "admin" });
  const p = db.buildSheetUpdatePayload(s.sid, e.group);
  const old = { ...p }; delete old.action;       // action を知らない旧GASの見え方
  const res = env.post(old);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(env.sheets["申込台帳"].getLastRow(), 2, "台帳に行が増えない");
});

test("修正: 修正画面で追加した種目は初回の反映で行を作り、再送しても増えない", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  const e = db.editSubmission(s.sid, { add: [{ event: "高校男子シングルス", name: "架空 追加", team: "修正クラブ" }] }, { actor: "admin" });
  assert.ok(e.ok, e.error);
  const p = db.buildSheetUpdatePayload(s.sid, e.group);
  const res = env.post(p);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.appended_rows, 1);
  assert.deepStrictEqual(res.missing, []);
  const sg = env.sheets["シングルス"];
  assert.strictEqual(liveRows(sg).length, 2);
  const again = env.post(db.buildSheetUpdatePayload(s.sid, ""));
  assert.strictEqual(again.appended_rows, 0);
  assert.strictEqual(liveRows(sg).length, 2, "再送で二重にならない");
});

test("修正: 本部が削除した出場はシートで「取消(削除)」になる", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  const d = db.getEntrant(s.byEv("男子シングルス").entry_id);
  db.deleteEntrant(d.id);
  const rec = db.recordAdminEntrantChange(d, null);
  const res = env.post(db.buildSheetUpdatePayload(s.sid, rec.group));
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const sg = env.sheets["シングルス"];
  const head = sg._grid[0].map(String);
  assert.strictEqual(sg._grid[1][head.indexOf("状態")], "取消(削除)");
  assert.strictEqual(liveRows(sg).length, 0);
});

test("修正: 併合された申込は元の行に全体を書き、後の行は0円にして併合先を残す", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  // 一部重複の再送(=併合)。シートには新しい申込IDの行として届いた想定
  const form2 = { ...s.payload, op_id: "op-merge-2",
    entries: [{ event: "男子シングルス", type: "singles", name: "架空 太郎", team: "修正クラブ" },
      { event: "高校男子シングルス", type: "singles", name: "架空 併合", team: "修正クラブ" }] };
  const r2 = db.createTeamEntry(s.tour.id, form2, "op-merge-2");
  assert.ok(r2.merged);
  const p2 = { ...form2, total_amount: r2.total_amount, option_items: [] };
  p2.entries = form2.entries.slice(1).map(e => ({ ...e, entry_id: r2.created_entries[0].entry_id }));
  assert.strictEqual(env.post(p2).ok, true);
  const lg = env.sheets["申込台帳"];
  assert.strictEqual(lg.getLastRow(), 3);
  const res = env.post(db.buildSheetUpdatePayload(s.sid, ""));
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.merged_rows, 1);
  const lh = lg._grid[0].map(String);
  const total = db.buildSheetUpdatePayload(s.sid, "").submission.total_amount;
  assert.strictEqual(lg._grid[1][lh.indexOf("合計金額")], total, "元の行に申込全体の金額");
  assert.strictEqual(lg._grid[2][lh.indexOf("合計金額")], 0, "後の行は0円(二重に数えない)");
  assert.strictEqual(lg._grid[2][lh.indexOf("併合先申込ID")], s.payload.op_id);
});

// ── 運営ボード ──
const boardText = (env) => env.sheets["運営ボード"]._grid.map(r => r.map(v => String(v == null ? "" : v)).join("|")).join("\n");
const boardRow = (env, first) => env.sheets["運営ボード"]._grid.find(r => String(r[0]) === first);

test("運営ボード: 申込が届くと全体・種目別(定員)が1枚にまとまり、金銭の欄は無い", () => {
  const s = makeEditableSubmission();
  db.updateEntrySettings(s.tour.id, { entry_deadline: "2099-12-31",
    event_config: [
      { name: "男子シングルス", type: "singles", fee: 700, capacity: 2 },
      { name: "高校男子シングルス", type: "singles", fee: 500 },
      { name: "男子ダブルス", type: "doubles", fee: 1000 },
      { name: "団体戦", type: "team", fee: 1000, fee_unit: "person", per_team: 6, per_team_min: 3 },
    ] });
  const env = makeEnv({});
  const res = env.post({ ...s.payload, form_schema: db.buildFormSchema(db.getTournament(s.tour.id)) });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.ok(env.sheets["運営ボード"], "運営ボードができる");
  const txt = boardText(env);
  assert.match(txt, /修正反映大会 運営ボード/);
  assert.match(txt, /締切 2099-12-31 23:59（あと\d+日）/);
  // 全体: 申込1・出場3(団体は1チーム=1出場)・取消0・別団体と重複0・同じ団体で2回0
  const head = env.sheets["運営ボード"]._grid.findIndex(r => r[0] === "申込" && r[1] === "出場");
  const tot = env.sheets["運営ボード"]._grid[head + 1];
  assert.deepStrictEqual(tot.slice(0, 5), [1, 3, 0, 0, 0]);
  assert.doesNotMatch(txt, /入金|未収|請求/, "金銭の収受は扱わない(オーナー方針)");
  // 種目別: 男子シングルスは定員2に対して1、団体戦は人数3
  const ms = boardRow(env, "男子シングルス");
  assert.deepStrictEqual(ms.slice(0, 5), ["男子シングルス", 1, 1, 2, 1]);
  assert.strictEqual(ms[6], "", "定員2の残り1は「残りわずか」にしない(1割以下だけ)");
  assert.deepStrictEqual(boardRow(env, "団体戦").slice(0, 3), ["団体戦", 1, 3]);
  assert.strictEqual(boardRow(env, "男子ダブルス")[2], 2, "ダブルスは2人");
  assert.match(txt, /別の団体から同じ人物・同じ組（0件）/);
});

test("運営ボード: 取消の修正で出場が更新され、直近の変更が出る", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  const e = db.editSubmission(s.sid, { entries: [{ entrant_id: s.byEv("男子シングルス").entry_id, cancel: true }], reason: "けが" }, { actor: "admin" });
  assert.ok(e.ok, e.error);
  const res = env.post(db.buildSheetUpdatePayload(s.sid, e.group));
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const g = env.sheets["運営ボード"]._grid;
  const head = g.findIndex(r => r[0] === "申込" && r[1] === "出場");
  assert.strictEqual(g[head + 1][1], 2, "取消は出場から外れる");
  assert.strictEqual(g[head + 1][2], 1, "取消1");
  assert.match(boardText(env), /けが/, "直近の変更に理由が出る");
  assert.deepStrictEqual(boardRow(env, "男子シングルス").slice(0, 2), ["男子シングルス", 0]);
});

test("運営ボード: 同じ種目に同じ氏名・所属が別の出場で2回あると要確認に出る", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  // 別経路で同じ選手が届いた想定(エントリーIDが違う)
  const p2 = { ...s.payload, op_id: "op-dup-board", entries: [{ ...s.payload.entries[0], entry_id: "zzzzzzzz-dup" }] };
  assert.strictEqual(env.post(p2).ok, true);
  const txt = boardText(env);
  const sec = txt.split("要確認")[1] || "";
  assert.match(sec.split("直近の変更")[0], /男子シングルス\|架空太郎\|修正クラブ/);
});

test("運営ボード: 別の団体から同じ人物・同じ組(順不同)が届くと【注意】に出る。同じチーム名なら出さない", () => {
  const s = makeEditableSubmission();
  const env = makeEnv({});
  env.post(s.payload);
  const other = { ...s.payload, op_id: "op-cross-board", team_name: "別の会",
    entries: [
      { event: "男子シングルス", type: "singles", name: "架空　太郎", team: "別の会", entry_id: "cross0001-s" },
      { event: "男子ダブルス", type: "doubles", name1: "架空 三郎", name2: "架空 次郎", team1: "別の会", team2: "別の会", entry_id: "cross0002-d" },
      // 同じチーム名の別出場は「要確認(同じ団体)」側の担当で、別団体の印は出さない
      { event: "高校男子シングルス", type: "singles", name: "同一 所属", team: "修正クラブ", entry_id: "cross0003-a" },
    ] };
  assert.strictEqual(env.post(other).ok, true);
  const third = { ...s.payload, op_id: "op-cross-3", team_name: "修正クラブ",
    entries: [{ event: "高校男子シングルス", type: "singles", name: "同一 所属", team: "修正クラブ", entry_id: "cross0004-b" }] };
  assert.strictEqual(env.post(third).ok, true);
  const txt = boardText(env);
  const sec = (txt.split("【注意】")[1] || "").split("要確認")[0];
  assert.match(txt, /別の団体から同じ人物・同じ組（2件）/);
  assert.match(sec, /男子シングルス\|[^|]*\|架空　太郎（ふりがな未確認）\|別の会\|修正クラブ/);
  assert.match(sec, /男子ダブルス\|[^|]*\|架空 三郎 \/ 架空 次郎（ふりがな未確認）\|別の会\|修正クラブ/);
  assert.doesNotMatch(sec, /同一 所属/);
  const head = env.sheets["運営ボード"]._grid.findIndex(r => r[0] === "申込" && r[1] === "出場");
  assert.strictEqual(env.sheets["運営ボード"]._grid[head + 1][3], 2);
});

test("運営ボード: 設定が届いていない状態のメニュー実行は作らずに理由を返す", () => {
  const env = makeEnv({});
  const r = env.sandbox.buildOpsBoard(env.ss, null);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /設定/);
});
