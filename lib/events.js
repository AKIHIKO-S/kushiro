// ═══════════════════════════════════════════════════════
// 種目(イベント)関連の共通ユーティリティ (Node 側)
// ※ entry_form.js / server.js の既存実装と同一（出力を変えないため）。
// ═══════════════════════════════════════════════════════

// 壊れた event_config 救済: name にイベントオブジェクトが入っている場合(過去の保存不具合)、
// 内側の name 文字列を取り出す。これをしないとフォームの種目名に「[object Object]」と表示される。
function eventName(n) {
  while (n && typeof n === "object") n = n.name;
  return n == null ? "" : String(n);
}

module.exports = { eventName };
