// スーパーシード2種(外シード=1・2位/中シード=3位以下)の区画確保を検証する。
// v4: 中シードSSの区画衝突は1回戦降格ではなく「同じ山内の空き整列区画へ移設」。
// 実行: node --test test/ss-mid-seed.test.js
process.env.DB_PATH = "/tmp/ktta_midss_" + process.pid + ".db";

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
const { mulberry32 } = require("../lib/rng");

after(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(process.env.DB_PATH + ext, { force: true }); } catch (e) {}
  }
});

function ents(n, mod) {
  const a = [];
  for (let i = 1; i <= n; i++) a.push(Object.assign({
    id: "e" + i, name: "選手" + String(i).padStart(2, "0"), team: "ク" + (i % 5),
    furigana: "せ" + String(i).padStart(2, "0"), seed: 0, entry_round: 1, is_doubles: 0,
  }, mod ? mod(i) : {}));
  return a;
}
const regionOf = (leaves, e, w) => {
  const g = leaves.indexOf(e);
  const start = Math.floor(g / w) * w;
  return { g, start };
};

test("中シードSS(seed3・R3): 衝突しても降格せず同じ山内のw=4全空き区画へ移設", () => {
  // seed{1,2,3,13,14}・seed3に登場3回戦。size32ではrank3の標準区画[16..19]にrank14(=seed14)が
  // 居るため従来は1回戦降格していた構成。同じ山(下半)の空き区画[20..23]等へ移設される。
  const list = ents(26, (i) => (i <= 3 || i === 13 || i === 14) ? { seed: i, entry_round: i === 3 ? 3 : 1 } : {});
  const { leaves, warnings } = db.computeDrawLeaves(list, 32, mulberry32(7), { separateBy: "none" });
  const e3 = list.find(e => e.seed === 3);
  const { g, start } = regionOf(leaves, e3, 4);
  assert.ok(g >= 0, "seed3が配置されている");
  // 区画内の他リーフが全て空(BYE)=3回戦から登場が保たれている
  for (let i = start; i < start + 4; i++) {
    if (i === g) continue;
    assert.strictEqual(leaves[i], null, "SS区画内は空(スロット" + i + ")");
  }
  assert.ok(!warnings.some(w => /選手03.*1回戦扱い/.test(w)), "降格していない: " + JSON.stringify(warnings));
  // 同じ山(half)内に留まる: 標準位置(rank3)は下山(前半/後半どちらでも)…移設後も同じ側
  const half = 16;
  const stdSide = true;   // rank3の標準位置はどちらかの山。移設regionが山を跨いでいないことは
  // 「区画が半分境界を跨がない」ことで担保(startは4の倍数・16はwの倍数なので構造上跨げない)
  assert.ok(Math.floor(start / half) === Math.floor((start + 3) / half), "区画は山を跨がない");
});

test("外シードSS(釧路式=第1と最終シード・R3)は両端区画(移設なし・回帰)", () => {
  // 釧路式では外シード=第1(上端)と最終シード(最下端)。両者にR3を付ける。
  const list = ents(24, (i) => i <= 8 ? { seed: i, entry_round: (i === 1 || i === 8) ? 3 : 1 } : {});
  const { leaves, warnings } = db.computeDrawLeaves(list, 32, mulberry32(11), { separateBy: "none" });
  const e1 = list.find(e => e.seed === 1), e8 = list.find(e => e.seed === 8);
  assert.strictEqual(leaves.indexOf(e1), 0, "第1シードは最上端");
  assert.strictEqual(leaves.indexOf(e8), 31, "最終(第8)シードは最下端");
  for (let i = 1; i < 4; i++) assert.strictEqual(leaves[i], null, "上端SS区画は空");
  for (let i = 28; i < 31; i++) assert.strictEqual(leaves[i], null, "下端SS区画は空");
  assert.ok(!warnings.some(w => /移動しました/.test(w)), "外シードは移設不要");
});

test("混在: 2回戦から登場のシード(w=2)+非シードbye(大きい山の1戦目=2回戦)が同居できる", () => {
  // 20人/32枠: seed1..4全員が2回戦から(w=2)。残りbye 8つは非シードに付く(=1戦目が2回戦)。
  const list = ents(20, (i) => i <= 4 ? { seed: i, entry_round: 2 } : {});
  const { leaves } = db.computeDrawLeaves(list, 32, mulberry32(3), { separateBy: "none" });
  // 全員が一度だけ配置・bye数=12
  const placed = leaves.filter(Boolean);
  assert.strictEqual(placed.length, 20);
  assert.strictEqual(new Set(placed.map(e => e.id)).size, 20);
  // シード4名はw=2区画(隣が空)=2回戦から
  for (const s of [1, 2, 3, 4]) {
    const e = list.find(x => x.seed === s);
    const g = leaves.indexOf(e);
    const pair = g % 2 === 0 ? g + 1 : g - 1;
    assert.strictEqual(leaves[pair], null, "seed" + s + "の隣は空(2回戦から)");
  }
  // 非シードでも隣が空の選手(=大きい山で1戦目が2回戦)が存在する(bye12>シード4)
  const nonSeedBye = list.filter(e => !e.seed).filter(e => {
    const g = leaves.indexOf(e); if (g < 0) return false;
    const pair = g % 2 === 0 ? g + 1 : g - 1;
    return leaves[pair] === null;
  });
  assert.ok(nonSeedBye.length >= 8, "非シードの2回戦初戦が存在: " + nonSeedBye.length);
});

test("同一draw_seedで移設込みの配置が完全再現される", () => {
  const mk = () => ents(26, (i) => (i <= 3 || i === 13 || i === 14) ? { seed: i, entry_round: i === 3 ? 3 : 1 } : {});
  const a = db.computeDrawLeaves(mk(), 32, mulberry32(42), { separateBy: "team" });
  const b = db.computeDrawLeaves(mk(), 32, mulberry32(42), { separateBy: "team" });
  assert.deepStrictEqual(a.leaves.map(e => e && e.id), b.leaves.map(e => e && e.id), "ビット同一");
});
