// 運営アプリの表示モード。
//   full  = 従来どおり全機能
//   entry = 申込集計に特化。組合せ・試合・観戦・表彰・統計などの入口だけを閉じる(コードもデータも消さない)
// モードの決め方: 環境変数 KTTA_APP_MODE があればそれを固定値にする > オーナーが管理画面で選んだ値(app_kv) > 既定 entry。
// API は「残すものだけを列挙」する。新しい API を足したとき、入れ忘れても申込集計モードで表に出ないようにするため。
const MODES = ["full", "entry"];
const DEFAULT_MODE = "entry";
const KV_KEY = "app_mode";

function resolveMode(envValue, storedValue) {
  if (MODES.includes(envValue)) return envValue;
  if (MODES.includes(storedValue)) return storedValue;
  return DEFAULT_MODE;
}

const T = "/api/tournaments/[^/]+";
const E = "/api/entrants/[^/]+";
const ENTRY_MODE_API = [
  // 認証(監督・選手・審判の入口は閉じる)と本体の保守
  [/^\/api\/auth\/session$/],
  [/^\/api\/auth\/(admin|owner|applicant)\/session$/],
  [/^\/api\/auth\/admin\/(password|activate)$/, ["POST"]],
  [/^\/api\/app-mode$/],
  [/^\/api\/health$/],
  [/^\/api\/diagnostics(\/clear)?$/],
  [/^\/api\/mail\/(status|test)$/],
  [/^\/api\/owner\//],
  [/^\/api\/admin\/snapshots(\/(download|restore))?$/],
  [/^\/api\/admin\/purge-submission-pii$/],
  [/^\/api\/admin\/qr$/],
  [/^\/api\/export\/all$/],
  [/^\/api\/import\/players$/],
  [/^\/api\/sync\/(push|now|status)$/],   // 試合を直接書き込む sync/matches・sync/tournament は閉じる
  // 公開の申込
  [/^\/api\/public\/open-tournaments$/],
  [/^\/api\/public\/tournaments\/[^/]+\/(entry|submit-team-entry)$/],
  [/^\/api\/forms\/submit$/],
  [/^\/api\/events-catalog$/],
  [/^\/api\/used-events$/],
  // 申込者本人の確認・修正、本部の申込管理
  [/^\/api\/applicant\//],
  [/^\/api\/submissions\//],
  // 大会の作成と申込の集計
  [/^\/api\/tournaments$/],
  [new RegExp(`^${T}$`)],
  [new RegExp(`^${T}/sync/now$`)],
  [new RegExp(`^${T}/(submissions|entry-changes|gas-stats|applicants|applicants\\.xlsx|aggregation\\.xlsx)$`)],
  [new RegExp(`^${T}/gas-sync(/.*)?$`)],
  [new RegExp(`^${T}/desk/manual$`), ["GET", "HEAD", "POST"]],
  [new RegExp(`^${T}/reception\\.html$`), ["GET", "HEAD"]],
  [new RegExp(`^${T}/entry-settings(/.*)?$`)],
  [new RegExp(`^${T}/entry-form(\\.html|-config)$`)],
  [new RegExp(`^${T}/entries$`)],
  [new RegExp(`^${T}/entries/[^/]+/(status|fix)$`)],
  [new RegExp(`^${T}/entry-issues(/bulk-fix)?$`)],
  [new RegExp(`^${T}/entrants$`), ["GET", "HEAD"]],   // 一括削除は組合せのやり直し用なので閉じる
  [new RegExp(`^${T}/entrants/(stats|validate)$`)],
  // 申込一覧からの出場者編集
  [new RegExp(`^${E}$`)],
  [new RegExp(`^${E}/(link|suggest-player|create-player|resolve-branch|member-from-player)$`)],
  // 選手データベース(名寄せ用)
  [/^\/api\/players$/],
  [/^\/api\/players\/(cleanup-invalid|normalize-categories|normalize-branches|infer-branches|infer-furigana|apply-fill|rename-team)$/],
  [/^\/api\/players\/[^/]+$/],
  [/^\/api\/players\/[^/]+\/(merge|affiliations)$/],
  [/^\/api\/affiliations\/(backfill|[^/]+(\/end)?)$/],
  [/^\/api\/player-merge\/candidates$/],
  [/^\/api\/player-merges(\/[^/]+\/undo)?$/],
  [/^\/api\/registered-teams(\/[^/]+)?$/],
];

function isApiAllowedInEntryMode(method, apiPath) {
  const m = String(method || "GET").toUpperCase();
  const p = String(apiPath || "").toLowerCase().replace(/\/+$/, "");
  return ENTRY_MODE_API.some(([re, methods]) => re.test(p) && (!methods || methods.includes(m)));
}

// 申込集計モードで閉じる公開画面。画面の部品(sw.js・manifest・画像)は古い端末の Service Worker 更新に要るので通す。
function isHiddenPageInEntryMode(pagePath) {
  const p = String(pagePath || "").toLowerCase();
  if (p === "/") return true;
  if (!/^\/(viewer|ref|widget)(\/|$)/.test(p)) return false;
  return !/\.(js|webmanifest|json|svg|png|ico|css)$/i.test(p);
}

module.exports = { MODES, DEFAULT_MODE, KV_KEY, resolveMode, isApiAllowedInEntryMode, isHiddenPageInEntryMode };
