// ファイル移動(lib/move-file.js)の回帰テスト。
// 実際に起きた不具合(2026-11-20): 協会ロゴ・印鑑画像のアップロードが 500(EXDEV)で失敗した。
// アップロードの一時保存先(/tmp)と保存先(/var/data/seal)が別のディスクで、rename が使えなかった。
//   ① 同じディスクなら rename で移す
//   ② EXDEV のときだけ、コピーして元を消す(内容が同じ・元が残らない)
//   ③ EXDEV 以外のエラーは握りつぶさない
//   ④ 元の一時ファイルが消せなくても、保存は成功として返る
// 実行: node --test test/move-file.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { moveFile } = require("../lib/move-file");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ktta-move-"));
const mk = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };

test("① 同じディスクなら rename で移す", () => {
  const src = mk("a.png", "AAA"), dest = path.join(dir, "a2.png");
  moveFile(src, dest);
  assert.strictEqual(fs.readFileSync(dest, "utf8"), "AAA");
  assert.ok(!fs.existsSync(src));
});

test("② EXDEV のときだけ、コピーして元を消す", () => {
  const src = mk("b.png", "BBB"), dest = path.join(dir, "b2.png");
  const calls = [];
  const fake = { ...fs, renameSync: () => { calls.push("rename"); const e = new Error("cross-device"); e.code = "EXDEV"; throw e; },
    copyFileSync: (a, b) => { calls.push("copy"); fs.copyFileSync(a, b); }, unlinkSync: (a) => { calls.push("unlink"); fs.unlinkSync(a); } };
  moveFile(src, dest, fake);
  assert.deepStrictEqual(calls, ["rename", "copy", "unlink"]);
  assert.strictEqual(fs.readFileSync(dest, "utf8"), "BBB");
  assert.ok(!fs.existsSync(src));
});

test("③ EXDEV 以外のエラーは握りつぶさない", () => {
  const fake = { ...fs, renameSync: () => { const e = new Error("denied"); e.code = "EACCES"; throw e; } };
  assert.throws(() => moveFile(path.join(dir, "x"), path.join(dir, "y"), fake), /denied/);
});

test("④ 元の一時ファイルが消せなくても、保存は成功する", () => {
  const src = mk("c.png", "CCC"), dest = path.join(dir, "c2.png");
  const fake = { ...fs, renameSync: () => { const e = new Error("x"); e.code = "EXDEV"; throw e; },
    unlinkSync: () => { throw new Error("busy"); } };
  assert.doesNotThrow(() => moveFile(src, dest, fake));
  assert.strictEqual(fs.readFileSync(dest, "utf8"), "CCC");
});
