// 団体戦オーダー(出場選手)の連続マッチ禁止バリデータ — admin(ブラウザ) / db.js(Node) 共用。
// KTTAルール: 同一選手は隣り合う(マッチ番号の差が1の)2マッチに続けて出場できない。
//   ダブルスはその2選手それぞれが「そのマッチ番号に出場」とみなす(S/Dを区別せず一律判定)。
//   離れたマッチ(差2以上)への重複出場は可。
// 純関数のみ(window/document 非参照)。Node からは require、ブラウザは global.TTTieOrder。
(function (global) {
  "use strict";

  // common.js の TT.parseTieFormat と同じトークン化で slot キー列(=マッチ番号順)を得る。
  // 入力例: "S,S,D,S,S" → ["S1","S2","D1","S3","S4"] / "5" → ["M1".."M5"] / "" → []
  // ※ ロジックを変える場合は public/shared/common.js 側と必ず同期させること(回帰: tie-order)。
  function slotKeysFor(format) {
    const raw = String(format == null ? "" : format).trim();
    if (/^\d+$/.test(raw)) {
      const n = Math.max(1, Math.min(99, parseInt(raw, 10)));
      const keys = [];
      for (let i = 1; i <= n; i++) keys.push("M" + i);
      return keys;
    }
    const toks = raw.split(/[\s,、，･・\/]+/).filter(Boolean);
    let s = 0, d = 0, g = 0;
    return toks.slice(0, 30).map(t => {
      if (/^(s|単|シングルス?)$/i.test(t)) { s++; return "S" + s; }
      if (/^(d|複|ダブルス?|ミックス|混合)$/i.test(t)) { d++; return "D" + d; }
      g++; return "M" + g;
    });
  }

  // 氏名の照合用正規化(全半角スペース除去のみ。旧字等の表記ゆれまでは追わない=紙運用と同等の限界)
  function normName(s) { return String(s == null ? "" : s).replace(/[\s　]+/g, ""); }

  // tie_results(各エントリに任意の home_players/away_players:[氏名…])を検証。
  // 戻り値: 違反の配列(空=OK)。選手名が1人も入っていなければ常に [](紙運用は検証対象外)。
  //  - {type:"adjacent",  side, player, matches:[a,b]} … 連続マッチ禁止違反
  //  - {type:"same_pair", side, player, match}         … 同一ダブルスに同じ選手が重複
  function validateTieOrder(format, tieResults) {
    const keys = slotKeysFor(format);
    const violations = [];
    if (!keys.length) return violations;   // フォーマット未設定(チームスコア直接)は判定不能=スキップ
    const arr = Array.isArray(tieResults) ? tieResults : [];
    ["home", "away"].forEach(side => {     // 両チーム独立(相手チームの同姓同名と混同しない)
      const byPlayer = {};                 // 正規化名 → { name, nums:Set<マッチ番号> }
      arr.forEach(e => {
        if (!e) return;
        const n = keys.indexOf(e.slot) + 1;
        if (!n) return;                    // フォーマット外の slot は位置不明=判定対象外
        const names = (Array.isArray(e[side + "_players"]) ? e[side + "_players"] : [])
          .map(x => String(x == null ? "" : x).trim()).filter(Boolean);
        const seen = new Set();
        names.forEach(name => {
          const k = normName(name);
          if (seen.has(k)) { violations.push({ type: "same_pair", side, player: name, match: n }); return; }
          seen.add(k);
          (byPlayer[k] = byPlayer[k] || { name, nums: new Set() }).nums.add(n);
        });
      });
      Object.keys(byPlayer).forEach(k => {
        const nums = Array.from(byPlayer[k].nums).sort((a, b) => a - b);
        for (let i = 0; i + 1 < nums.length; i++) {
          if (nums[i + 1] - nums[i] === 1) {
            violations.push({ type: "adjacent", side, player: byPlayer[k].name, matches: [nums[i], nums[i + 1]] });
          }
        }
      });
    });
    return violations;
  }

  // 違反1件を日本語1行に整形(admin のインライン表示・サーバのエラー文言で共用)
  function describeViolation(v) {
    if (!v) return "";
    if (v.type === "same_pair") return "第" + v.match + "試合のダブルスに「" + v.player + "」が重複しています";
    return "「" + v.player + "」が第" + v.matches[0] + "試合と第" + v.matches[1] +
      "試合に連続出場しています(連続マッチ禁止)";
  }

  const API = { slotKeysFor, normName, validateTieOrder, describeViolation };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else global.TTTieOrder = API;
})(typeof window !== "undefined" ? window : globalThis);
