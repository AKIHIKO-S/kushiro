// 種目の性別(男子/女子/混合)の判定と、画面・印刷物・Excelで共通の色。
// 判定は種目名(と区分名)の「男子・女子・男・女・混合・ミックス」から行い、判定できないものは "" (=白・無色)。
// ブラウザは window.KTTAEventGender、Node は require() で使う(同じ1つのファイルを全部が読む)。
// 色の値の正本は site-tokens.css の --st-gx-*。ここの値はExcel(CSSを読めない)用の同じ値で、test/event-gender.test.js が一致を確かめる。
(function (root) {
  "use strict";
  var COLORS = {
    male:   { ink: "1D4E89", tint: "EAF1FA", label: "男子" },
    female: { ink: "A3182B", tint: "FCEDEF", label: "女子" },
    mixed:  { ink: "1E6B3A", tint: "E7F3EA", label: "混合" },
  };
  // 種目名(と区分名など)から "male" | "female" | "mixed" | "" を返す
  function of(name, extra) {
    var s = String(name == null ? "" : name) + (extra ? " " + String(extra) : "");
    s = s.normalize ? s.normalize("NFKC") : s;
    if (/混合|ミックス|mixed/i.test(s)) return "mixed";
    var m = /男|メンズ|men's|mens/i.test(s), f = /女|レディース|ladies|ウィメン/i.test(s);
    if (m && f) return "mixed";
    if (f) return "female";
    if (m) return "male";
    if (/混/.test(s)) return "mixed";
    return "";
  }
  var api = { of: of, COLORS: COLORS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KTTAEventGender = api;
})(typeof window !== "undefined" ? window : globalThis);
