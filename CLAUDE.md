# CLAUDE.md — ktta-platform (釧路卓球協会 大会運営システム)

JTTA風の卓球大会運営Webアプリ。申込→承認→ブラケット生成→当日進行(台割/敗者審判)→結果→選手DB公開 を一気通貫で扱う。
GitHubリポジトリ名は `AKIHIKO-S/kushiro` だが package.json の name は `ktta-platform`。

## 起動・テスト・デプロイ

```bash
npm run dev      # node server.js → http://localhost:3000 (/viewer, /admin)
npm test         # node --test test/*.test.js (現在13件)
npm start        # NODE_ENV=production
npm run backup   # deploy/backup.sh
```

- ローカル Node は v24 だが engines は `22.x`(本番に合わせる)。
- 本番: Oracle Cloud 上で systemd `ktta.service` (User=ktta, WorkingDir=/opt/ktta, DB=/var/data) + nginx リバプロ。SSH鍵 `~/.ssh/ktta_oracle`。env は `/etc/ktta.env`。
- `ADMIN_KEY` 未設定だと本番はフェイルクローズ(503)。主な環境変数: `PORT ADMIN_KEY NODE_ENV TRUST_PROXY DB_PATH SSE_MAX SSE_PER_IP LIVE_FP_TTL_MS SNAPSHOT_INTERVAL_MS PUSH_CONTACT SMTP_* PUBLIC_BASE_URL SYNC_KEY SYNC_CLOUD_URL`。`PUBLIC_BASE_URL`(任意)はメール/フォーム埋込URLの正規オリジン。未設定時は `Host` ヘッダ由来(X-Forwarded-Host は信用しない=ホストヘッダ注入対策)。
- **会場オフライン運用(WiFi断に強い本部ローカル構成)**: 会場WiFiが1時間毎に落ちる環境向け。本部1台が standalone でローカルサーバ=正本、他2〜3台は会場内ローカル網(本部テザリング/モバイルルータ)でLAN接続→会場ネット断に無依存。`app.listen(PORT)`=0.0.0.0 bind。`GET /api/lan-info`(LAN URL+`qrcode`同梱のローカル生成QR=外部QR非依存)→admin「📱端末接続」。`/sw.js`(root scope, network-first・`/shared/sw-cache.js`)でリロード/断でも画面が出る(古コード固着は network-first で回避)。書込は既存 opSend キュー(finish/correct/call)で断中保存→復帰で自動送信、通信バーに「今すぐ送信」。**クラウド同期**: `SYNC_CLOUD_URL`+`SYNC_KEY` 設定で本部→クラウド公開ミラーへ一方向同期(`db.exportPublicSnapshot`/`applyPublicSnapshot`=大会公開フィールド+matchesのみ・PII/entrants/秘匿列は不同期・matchesのFK id は null化、`POST /api/sync/push` X-Sync-Key定時間比較、進行中大会を3分毎自動push)。回帰: `cloud-sync`/`server-smoke(h,i)`。運用手順は `OPERATIONS.md §2.5`。
- デプロイ手順は `ORACLE_CLOUD_DEPLOY.md` / `UPDATE_WORKFLOW.md`、運用は `OPERATIONS.md`。
- 課題管理は GitHub issues 不使用。コミットメッセージの `#番号` が課題ID。

## アーキテクチャ

モノリシックなバックエンド + 素のJS(ビルドなし)フロント。

```
server.js (Express, 3100行) ── db.js (better-sqlite3 DAL, 5700行)
  ├─ reports.js     集計表/領収書/対戦票/両山トーナメント表 (xlsx) + 監督結果HTML
  ├─ mailer.js      申込確認・管理者通知メール (nodemailer, 任意)
  ├─ entry_form.js  埋込申込フォームHTML生成 (依存なし単一HTML)
  └─ lib/           text.js(escape) http-cache.js(ETag/304) lifecycle.js(graceful) events.js
public/
  ├─ viewer/index.html  公開閲覧+選手ポータル (V/L/MP/CO モジュール、SSEでライブ更新)
  ├─ admin/index.html   運営コンソール (A/BR/EF モジュール)
  └─ shared/common.js   TT名前空間: api(オフラインキュー付fetch), h(), esc(), createPoller(), toast()
tools/   Excel/PDF→JSON ブラケットパーサ (Python bracket_parser パッケージ + JS版、subprocessで疎結合)
gas/     Google Apps Script (Jimdo/フォーム連携で entrants を POST)
standalone/  オフライン単機運用ラッパ (start.command/.bat)
```

## DB スキーマ要点 (db.js)

- PRAGMA: WAL / synchronous=NORMAL / busy_timeout=5000 / foreign_keys=ON。
- マイグレーションはバージョン番号なし。`CREATE TABLE IF NOT EXISTS` + 起動時に `PRAGMA table_info` で欠けたカラムを `ALTER TABLE ADD COLUMN`(非破壊)。
- 主要テーブル: `players`(マスタ, Elo rating), `tournaments`(state_json/会場レイアウト/申込設定/審判設定), `matches`(ブラケット情報+進行状態+再コール), `entrants`(**新形式の大会参加者**, シングル/ダブルス/ブロック/選手番号), `tournament_players`(レガシー), `entry_submissions`(**Phase4: 申込原本+申込者トークン**), `achievements`, `coach_accounts`/`coach_*`(監督モード #285〜), `player_requests`(監督→本部の修正申請), `op_log`(Undo用snapshot), `push_subscriptions`, `app_kv`(VAPID鍵等)。
- **entrants と players は分離**。ブラケット生成は entrants 優先(無ければ legacy から自動移行)。
- **団体戦の運営(中スコープ)**: 団体種目は「1チーム=1 entrant=1ブラケット枠」。対戦(tie)は通常の `/finish` に `winner_sets/loser_sets`(=勝った試合数=団体スコア)+ `tie_results`(各個別試合の勝者 JSON, `matches.tie_results` 列)を渡して記録し、勝者チームを既存 `advanceWinnerInline` で次戦へ送る(op_log/undo/correct を流用、team は player_id 無で非Elo)。対戦形式は `event_config[].tie_format`(例 `"S,S,D,S,S"`、空欄なら団体スコア直接入力)。共有パーサ `TT.parseTieFormat`/`TT.tieScore`(common.js)。admin進行管理は団体種目で専用の tie 結果入力モーダル、viewer は対戦詳細で内訳表示。テンプレート「団体戦専用大会」(`team_only`)。回帰テストは `test/team-tie.test.js`。個別試合の台割・選手割当・オーダーはアプリ管理しない(紙運用)。
- **Phase4 (データ形状の完全性)**: `entrants` に `division`(一般/中学生/高校生/student)・`fee`(申込時に event_config から再計算した課金額)・`team_members`(団体メンバーのJSON配列。旧 note の "[団体] メンバー:…" 解析を置換)・`contact_name/email/tel`(連絡先をnoteから分離した構造化列。PIIを名簿表示から切離)・`applied_at`・`submission_id`・`partner_gender` を追加(全て ALTER 追加, `addECol`)。`entry_submissions` は「1回の申込」を丸ごと保存(原本JSON・連絡先・合計・作成entrant群・閲覧トークンのSHA-256ハッシュ)。`createTeamEntry` は entrant 単位で冪等dedup(`dupStmt`)し、申込番号トークン(`_genApplicantToken` 12桁4-4-4, 平文は返却のみ・DBはハッシュ)を発行。**真のDB冪等**: `entry_submissions.op_id` で同一op_idのコールド再送(再起動後)も replay 判定。**部分再送の併合**: 既存entrantと重複する再送は新規分を既存原本へ submission_id で張り替え、`submission_tokens`(トークン→原本の対応表, 1原本に複数トークン可)で旧新どちらの申込番号でも全種目を表示。`getSubmissionByToken` は submission_id から entrants を都度引く。`getTeamRosters`/`getEntries` は `team_members` 列優先で note にフォールバック(`entrantMembers`)。`findEntrantDataIssues`/`bulkFixEntrantInference`/`fixEntrant` で種目名と gender/category の不整合・ふりがな欠落を検出/修正。回帰テストは `test/phase4.test.js`。

## コア進行ロジック (db.js) — 触るとき要注意

- `generateBracket(tid, event, opts)` (~2429): seed昇順→furigana順、2の累乗にBYE埋め、標準シード配置 or `as_drawn`(取込番号維持)。BYEは即完了→`autoAdvanceByes`で連鎖進行。`opts.fixedLeaves`(リーフ配列)を渡すと配置ロジックを全て飛ばしてその並びを round1 に固定する(抽選ドローが使う。seed=シードランクは非破壊)。
- `drawSingleBracket(tid, event, opts)` + `computeDrawLeaves(entrants,size,rng,opts)`: **抽選ドロー**(個人戦)。for_mac.xls マクロ(KUJI2)の本質を縮約=①シードを標準位置に固定 ②非シードを seedable RNG(`lib/rng.js` mulberry32)でシャッフル→**大所属先(most-constrained-first)**で分散スコア(`_drawConflictScore`)最小の空き枠へ配置(同点はRNG一様) ③**R1同所属の swap修復**(種・BYE不動、別所属同士の入替で1回戦の同一所属/地区対戦を分離可能なら0件に) ④`generateBracket({fixedLeaves})`で凍結。BYEは標準位置のランク>Nの枠=上位シードに付与。`draw_seed`を返し**同種=同配置を再現**。`opts.separate_by`='team'(既定)|'region'|'none'。回帰: `test/bracket-draw.test.js`(不均衡だが分離可能な分布もR1同所属0件を断定)。
  - **再現性の前提**: 抽選入力は `id` で決定的整列してから渡す(listByEvent の seed,surname は同姓・seed同値で物理順依存=再現が崩れるため)。
  - **プロセス化(Tier1)**: `checkDrawReadiness`(事前ポカヨケ)→`opts.preview`(dry_run・DB非書込)→確定で `draw_log` に一次記録(誰=drawn_by/種/名簿snapshot+hash/leaves hash、引き直しは superseded 連鎖で全試行保持)→`undoDraw`(抽選専用Undo・op_log非依存)。確定APIは `drawn_by` 必須(単一ADMIN_KEY対策の最小の説明責任)。
  - **Excel往復**: `reports.buildBracketXlsx` は機械可読の隠し `_import` シートを併設し、`db.importBracketRoundtrip`(`POST /bracket/import-xlsx`)が手修正後の表を entrant 非消失・位置差分で正本化(往復ループを閉じる)。
  - **オフライン縮退**: 抽選→Excel経路は外部依存ゼロ=standalone単機で名簿→抽選→Excelまで完結(`test/offline-draw.test.js` がネット遮断下で保証)。
  - **信頼性/正確性(Tier2)**: `getBracketDrawDiff`(確定封印 leaves_hash と現配置を突合し抽選後の手修正を可視化=「原配置からN件」)。ダブルスは所属を**集合**(team+partner_team)で分散判定(`_clubsOverlap`、共有1つでも衝突。単打は[team]の1要素で従来等価)、Excelはペアを上下2段+所属併記。`suggestSeeds`(Elo rating+`achievements`→根拠付きシード候補、自動確定せず人手採否)+ `seed_source/reason/set_by/set_at` 記録(`setEntrantSeed(id,seed,{source,reason,by})`)。
  - API: `POST /bracket/draw`(preview/drawn_by) `GET /bracket/draw-readiness` `POST /bracket/undo-draw` `GET /bracket/draw-log` `GET /bracket/draw-diff` `GET /bracket/export.xlsx` `POST /bracket/import-xlsx` `GET /seed-suggestions` `POST /seed-suggestions/apply`。回帰: `draw-audit`/`bracket-xlsx`/`bracket-roundtrip`/`offline-draw`/`draw-doubles`/`seed-suggest`。
- `finishMatchInternal(matchId, data)` (~2761): 勝者判定→冪等ガード→セット集計→**Eloは両者IDありかつ非BYEのときのみ更新**(`calcElo` K=32, 基準1500, db.js:527)→`advanceWinnerInline`で次戦へ。
- `correctResult` (~2891): 確定済み結果の修正。勝者反転→次戦クリア→再進出を1トランザクション。
- 優先度ロック: 種目優先(団体>混合>ダブルス>シングルス)/審判担当中/対戦中で呼出を拒否、`force`で強制。
- `recordOp`/`undoLastOp`: 影響行の before を `op_log.before_json` に保存、`collectForwardChain` でBYE連鎖もスナップショット対象。

## サーバの横断的関心事 (server.js)

- 認証: `X-Admin-Key`(定時間比較・本番未設定は503)、監督 `X-Coach-Code`(失敗回数でIP一時ブロック)、審判トークン/コート別/パスコード。
- 申込者本人(Phase4): 認証は持たず、申込番号トークンで自分の申込のみ閲覧。`GET /api/public/applicants/:token`(`entryRateLimit`・noindex・PII非開示)+ 閲覧ページ `GET /entry/status?token=…`(`entry_form.buildApplicantStatusHTML`)。修正は本部連絡(閲覧のみ)。品質API は admin限定: `GET /entry-issues` / `POST /entries/:pid/fix` / `POST /entry-issues/bulk-fix`。
- **冪等性ガード** (~168): `op_id`(body/`X-Op-Id`)で finish/correct の二重適用(二重Elo)を防止。TTL 12h。オフライン端末の再送対策。フロントの `api.opSend`/`flushQueue` と対。
- **SSE リアルタイム** (~2363): `/api/public/tournaments/:id/ops-stream`。800msごとに `getOpsFingerprint` 差分検知→`{type:"ops"}`(reload合図のみ, PII無)をbroadcast、5s無変化でping。実データは別途 `/live`(ETag/304)。上限 SSE_MAX=600 / SSE_PER_IP=200。compressionはSSE除外。
- キャッシュ: `/live` `/ops-version` は fingerprint を ETag 化(LIVE_FP_TTL_MS=200msの読取集約)。
- 自動スナップショット: 進行中大会があるとき7分ごと(SNAPSHOT_INTERVAL_MS)。
- アップロード(multer): xlsx/csv/pdf/画像のみ(SVG除外=XSS), 20MB, /tmp。
- graceful shutdown(lib/lifecycle): SIGTERMでSSEを明示close→再接続を促す。
- 診断: `/api/diagnostics`(メモリ/ディスク/エラー履歴)。

## 規約

- セキュリティ重視(PII保護で X-Robots-Tag noindex、CSP、出力は lib/text.js でescape)。
- 大きな2ファイル(server.js / db.js)に集約する方針。新ロジックも基本そこへ。フロントは public/*/index.html にインライン。
- 結果に影響する操作は op_log + undo を通す。
- Elo整合性: finish時に適用差分を `matches.winner_rating_delta`/`loser_rating_delta` に保存し、correct/undo/editMatch は `reverseEloForMatch`/`reapplyEloForMatch` で保存差分を厳密に逆算/再適用する(post-rating再計算によるドリフト禁止)。回帰テストは `test/elo-integrity.test.js`。
- 料金は `tournament.event_config[].fee`(種目別)が正。集計/領収書(reports `feesFromEventConfig`)・確認メール(mailer `authoritativeFees`)はこれを使い、クライアント供給の fee/total は信用しない。
- 未認証レスポンスは `sanitizeTournamentPublic` で referee_token/passcode/entry_gas_url を除去。クライアントIPは `clientIp(req)`(trust proxy準拠)に集約。
- **xlsx は2系統**: 読み込み(.xls/.xlsx パーサ)と大半の帳票は `xlsx`(SheetJS CE 0.20.3)。ただし CE は**セル罫線(スタイル)を書き出せない**(有料機能)。罫線が要る**両山トーナメント表だけ** `reports.buildBracketXlsx` 内で `require("xlsx-js-style")`(罫線対応 drop-in fork)を使う。新たに罫線付き xlsx を書くときは同 fork を使うこと(`cell.s.border` + `cellStyles:true`)。
