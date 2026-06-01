// ═══════════════════════════════════════════════════════
// 共通エスケープ・ユーティリティ (Node 側)
// entry_form.js / server.js / reports.js などから共有する想定の DRY 基盤。
// ※ 各関数は entry_form.js の既存実装と完全に同一（出力を変えないため）。
// ═══════════════════════════════════════════════════════

// HTML エスケープ (& < > " ' の5文字)
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// インライン <script> 内で安全になるよう、JSON文字列の </script> ブレイクアウトや
// 行区切り(U+2028/2029)を無効化する。値そのものは変わらない(JSはエスケープ列を同じ文字として解釈)。
function scriptSafeJson(json) {
  return String(json)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// JS 文字列リテラルとして安全に埋め込む (JSON.stringify ベース + インラインscript安全化)
function escapeJs(s) {
  return scriptSafeJson(JSON.stringify(String(s == null ? "" : s)));
}

// 任意の値(配列/オブジェクト等)を <script> 内に JSON として安全に埋め込む
function jsonForScript(v) {
  return scriptSafeJson(JSON.stringify(v === undefined ? null : v));
}

// JavaScript 識別子として使える文字に変換 (id にハイフン等が入る場合の対策。英数字以外を _ に)
function escapeJsId(s) {
  return String(s || "").replace(/[^a-zA-Z0-9]/g, "_");
}

module.exports = { escapeHtml, escapeJs, escapeJsId, jsonForScript };
