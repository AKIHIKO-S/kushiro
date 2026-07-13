// Phase 1 回帰テスト: _resolveEvents が種目レベルの全設定キーを本番フォームまで通すこと。
//  - 土台バグ: 旧 _resolveEvents は {name,type,fee,per_team,note} に削り落とし、admin で設定した
//    fee_student(中高生料金)/gender/category/entry_categories 等を /entry/:id へ渡していなかった。
//  - 修正後: event_config の全キーを保持し、既知キー(name/type/fee/fee_student/per_team)だけ正規化する。
//  - 後方互換: event_config が無い大会はフォールバック再構築が従来どおり動く。
//  - end-to-end: fee_student が一般と異なる種目は生成HTMLに参加区分セグメント(中学生)が出る。
// 実行: node --test test/entry-form-resolve.test.js
process.env.DB_PATH = "/tmp/ktta_efresolve_" + process.pid + ".db";
process.env.SNAPSHOT_DIR = "/tmp/ktta_efresolve_snaps_" + process.pid;

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { _resolveEvents } = require("../server");
const entryForm = require("../entry_form");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
  try { fs.rmSync(process.env.SNAPSHOT_DIR, { recursive: true, force: true }); } catch (e) {}
});

test("_resolveEvents: event_config の種目レベル全キーを保持して通す(fee_student/gender/category/entry_categories)", () => {
  const events = _resolveEvents({
    event_config: JSON.stringify([
      {
        name: "中学男子シングルス", type: "singles", fee: 700, fee_student: 500,
        gender: "male", category: "middle", tie_format: "",
        entry_categories: [{ value: "hopes", label: "ホープス" }],
        age_check: { mode: "off", as_of: "" },
      },
      { name: "一般シングルス", type: "singles", fee: 1000 }, // fee_student 未設定
      { name: "男子団体", type: "team", fee: 0, tie_format: "S,S,D,S,S", per_team: 5 },
    ]),
  });
  const mid = events[0];
  assert.strictEqual(mid.fee_student, 500, "fee_student が本番まで通る(土台バグ修正の核)");
  assert.strictEqual(mid.gender, "male", "gender 通過");
  assert.strictEqual(mid.category, "middle", "category 通過");
  assert.ok(Array.isArray(mid.entry_categories) && mid.entry_categories[0].value === "hopes", "entry_categories 通過");
  assert.ok(mid.age_check && mid.age_check.mode === "off", "age_check 通過");

  assert.strictEqual(events[1].fee_student, null, "fee_student 未設定は null(=一般と同額扱い)");

  const team = events[2];
  assert.strictEqual(team.tie_format, "S,S,D,S,S", "団体の tie_format 通過");
  assert.strictEqual(team.per_team, 5, "per_team は明示値を尊重");
});

test("_resolveEvents: event_config が無い大会はフォールバック再構築が従来どおり動く(後方互換)", () => {
  // matches/entrants を引くフォールバック経路。DBは空なので entry_events だけから復元される。
  const events = _resolveEvents({
    id: "no_such_tournament_zzz",
    entry_events: JSON.stringify(["一般男子シングルス", "一般男子ダブルス"]),
  });
  const names = events.map(e => e.name).sort();
  assert.deepStrictEqual(names, ["一般男子シングルス", "一般男子ダブルス"].sort(), "entry_events から種目名を復元");
  const dbl = events.find(e => e.name === "一般男子ダブルス");
  assert.strictEqual(dbl.type, "doubles", "名前からダブルスを推定");
  assert.ok(typeof dbl.fee === "number" && dbl.fee > 0, "既定料金が付く");
});

// 注: 参加区分セグメントの描画は addEntry(クライアントJS)として常にHTMLへ埋め込まれるため、
// 「中学生」等のラベル文字列は fee_student の有無に関わらず存在する。区分表示の実際の分岐は
// 埋め込まれる種目データ(eventsJson)の fee_student 値で決まる。よってここでは「フォームを駆動する
// データに fee_student が正しく乗るか」を検証する(これが土台バグ修正の end-to-end 証明)。
test("buildEntryFormHTML: fee_student が一般と異なる種目は種目データに fee_student が埋め込まれる", () => {
  const t = { id: "t1", name: "テスト大会", entries_open: 1 };
  const withStu = [{ name: "中学男子シングルス", type: "singles", fee: 700, fee_student: 500 }];
  const html = entryForm.buildEntryFormHTML(t, withStu, {});
  assert.ok(/"fee_student":\s*500/.test(html), "フォームを駆動する種目データに fee_student:500 が乗る");
});

test("buildEntryFormHTML: fee_student 未設定の種目はデータ上 null(既存挙動維持=区分は出ない)", () => {
  const t = { id: "t2", name: "テスト大会2", entries_open: 1 };
  const noStu = [{ name: "一般シングルス", type: "singles", fee: 1000 }];
  const html = entryForm.buildEntryFormHTML(t, noStu, {});
  assert.ok(!/"fee_student":\s*1000/.test(html), "一般料金が fee_student に化けない");
  assert.ok(/"fee_student":\s*null/.test(html), "fee_student 未設定はデータ上 null(区分セグメント非表示の条件)");
});
