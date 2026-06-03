// ── 再現可能な擬似乱数 (抽選ドロー用) ───────────────────────────────
// 抽選(くじ)は「同じ種(draw_seed)なら必ず同じ結果」になる必要がある(検証・引き直し・監査)。
// Math.random は種を取れず再現できないため、種を注入できる mulberry32 を使う。
// 32bit 整数の種から決定的に [0,1) の乱数列を生成する軽量PRNG(分布は抽選用途に十分)。
function mulberry32(seed) {
  let a = (seed >>> 0) || 1; // 0 種は退化するので 1 に寄せる
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates: 注入された rng() を使って配列を非破壊シャッフル(元配列は変更しない)。
function shuffle(arr, rng) {
  const a = Array.prototype.slice.call(arr);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// 種未指定時の新しい乱数種(32bit 符号なし整数)。これを保存すれば後で同じ抽選を再現できる。
function randomSeed() {
  return (Math.floor(Math.random() * 0x100000000)) >>> 0;
}

module.exports = { mulberry32, shuffle, randomSeed };
