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

// JS 文字列リテラルとして安全に埋め込む (JSON.stringify ベース)
function escapeJs(s) {
  return JSON.stringify(String(s == null ? "" : s));
}

// JavaScript 識別子として使える文字に変換 (id にハイフン等が入る場合の対策。英数字以外を _ に)
function escapeJsId(s) {
  return String(s || "").replace(/[^a-zA-Z0-9]/g, "_");
}

module.exports = { escapeHtml, escapeJs, escapeJsId };
