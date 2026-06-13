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
- `ADMIN_KEY` 未設定だと本番はフェイルクローズ(503)。主な環境変数: `PORT ADMIN_KEY OWNER_KEY NODE_ENV TRUST_PROXY DB_PATH SSE_MAX SSE_PER_IP LIVE_FP_TTL_MS SNAPSHOT_INTERVAL_MS PUSH_CONTACT VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY SMTP_* PUBLIC_BASE_URL SYNC_KEY SYNC_CLOUD_URL SYNC_ALLOW_IPS`。`OWNER_KEY`(任意)は上級管理者の鍵(未設定なら上級操作は管理キーで可=分離未活性)。`VAPID_*`(任意)は env 注入時 DB 自動生成より優先(両方必須)。`SYNC_ALLOW_IPS`(任意・カンマ区切り)は `/api/sync/push` の送信元IP allowlist。**国外アクセス遮断(任意)**: `GEO_ALLOW_COUNTRIES`(例 `JP`・未設定で無効)で Cloudflare の `CF-IPCountry` を見て許可国以外を 403。`GEO_ALLOW_IPS`(常時許可IP)、`GEO_REQUIRE_COUNTRY_HEADER=1`(ヘッダ無しも拒否)。`/api/health` と `/api/sync/*` は除外。判定ヘッダ無しは既定で通す(本部standalone/ローカルを巻き込まない)。本来の主防御は Cloudflareの国ブロック+オリジンをCloudflare限定、本ミドルウェアは保険。回帰: `geo-block`。`PUBLIC_BASE_URL`(任意)はメール/フォーム埋込URLの正規オリジン。未設定時は `Host` ヘッダ由来(X-Forwarded-Host は信用しない=ホストヘッダ注入対策)。
- **会場オフライン運用(WiFi断に強い本部ローカル構成)**: 会場WiFiが1時間毎に落ちる環境向け。本部1台が standalone でローカルサーバ=正本、他2〜3台は会場内ローカル網(本部テザリング/モバイルルータ)でLAN接続→会場ネット断に無依存。`app.listen(PORT)`=0.0.0.0 bind。`GET /api/lan-info`(LAN URL+`qrcode`同梱のローカル生成QR=外部QR非依存)→admin「📱端末接続」。**QRは全て同梱 `qrcode` でローカル生成**(外部 `api.qrserver.com` は撤去・CSP img-src からも削除済): 機密URL(審判トークン/コート別ct)は `GET /api/admin/qr`(requireAdmin・`{svg}`をDOM直挿入)、非機密(観戦共有)は `GET /api/qr.svg`(公開・rateLimit・長さ上限)。**コート別審判QR**(#229実運用化): `GET /api/admin/tournaments/:id/referee-court-qr` が `HMAC(referee_token,"court:N")` 由来のキーで各台のローカルQR+URL(localhost時はLAN IPへ自動置換=他端末から到達可)を返し、審判はスキャンのみで担当コート限定の入力に入れる。回帰: `server-smoke(k,l,m,n,o,p)`。`/sw.js`(root scope, network-first・`/shared/sw-cache.js`)でリロード/断でも画面が出る(古コード固着は network-first で回避)。書込は既存 opSend キュー(finish/correct/call)で断中保存→復帰で自動送信、通信バーに「今すぐ送信」。**クラウド同期**: `SYNC_CLOUD_URL`+`SYNC_KEY` 設定で本部→クラウド公開ミラーへ一方向同期(`db.exportPublicSnapshot`/`applyPublicSnapshot`=大会公開フィールド+matchesのみ・PII/entrants/秘匿列は不同期・matchesのFK id は null化、`POST /api/sync/push` X-Sync-Key定時間比較、進行中大会を3分毎自動push)。回帰: `cloud-sync`/`server-smoke(h,i)`。運用手順は `OPERATIONS.md §2.5`。
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
tools/   Excel/PDF→JSON ブラケットパーサ。組合せ表取込(/kumiawase/upload)は Python bracket_parser(openpyxlで罫線読取)が主系統・JS版(parse_bracket_seedlist.js)が副系統・旧parse_ktta_bracket.jsが最終FB(#268)。起動時にpython3+openpyxl可用性をプローブし無い環境はJS主系統へ無停止FB(KTTA_DISABLE_PYTHON_PARSER=1で強制無効)。subprocessで疎結合
gas/     Google Apps Script (Jimdo/フォーム連携で entrants を POST)
standalone/  オフライン単機運用ラッパ (start.command/.bat)
```

## DB スキーマ要点 (db.js)

- PRAGMA: WAL / synchronous=NORMAL / busy_timeout=5000 / foreign_keys=ON。
- マイグレーションはバージョン番号なし。`CREATE TABLE IF NOT EXISTS` + 起動時に `PRAGMA table_info` で欠けたカラムを `ALTER TABLE ADD COLUMN`(非破壊)。
- 主要テーブル: `players`(マスタ, Elo rating, `merged_into`=統合先IDリダイレクト), `tournaments`(state_json/会場レイアウト/申込設定/審判設定), `matches`(ブラケット情報+進行状態+再コール), `entrants`(**新形式の大会参加者**, シングル/ダブルス/ブロック/選手番号), `tournament_players`(レガシー), `entry_submissions`(**Phase4: 申込原本+申込者トークン**), `achievements`, `coach_accounts`/`coach_*`(監督モード #285〜), `player_requests`(監督→本部の修正申請), `op_log`(Undo用snapshot), `push_subscriptions`, `app_kv`(VAPID鍵等), **`player_merges`(選手統合台帳・undo用 refs_json)** 。
- **entrants と players は分離**。ブラケット生成は entrants 優先(無ければ legacy から自動移行)。
- **団体戦の運営(中スコープ)**: 団体種目は「1チーム=1 entrant=1ブラケット枠」。対戦(tie)は通常の `/finish` に `winner_sets/loser_sets`(=勝った試合数=団体スコア)+ `tie_results`(各個別試合の勝者 JSON, `matches.tie_results` 列)を渡して記録し、勝者チームを既存 `advanceWinnerInline` で次戦へ送る(op_log/undo/correct を流用、team は player_id 無で非Elo)。対戦形式は `event_config[].tie_format`(例 `"S,S,D,S,S"`、空欄なら団体スコア直接入力)。共有パーサ `TT.parseTieFormat`/`TT.tieScore`(common.js)。admin進行管理は団体種目で専用の tie 結果入力モーダル、viewer は対戦詳細で内訳表示。テンプレート「団体戦専用大会」(`team_only`)。回帰テストは `test/team-tie.test.js`。**オーダー(出場選手)の任意記録+連続マッチ禁止検証**: tie_results 各エントリに任意の `home_players`/`away_players`(S=1名/D=2名)を載せられ、KTTAルール「同一選手は隣接マッチ番号(差1)に連続出場不可(Dはペア2名とも出場扱い)」を共有バリデータ `public/shared/tie-order.js`(UMD・db.jsとadminで同一実装、`TTTieOrder.validateTieOrder`)で検証。サーバは finish/correct の書込み前(`tieOrderViolations`、tieWinnerConflict と同位置)に違反を `needs_force:true` で reject、`force:true` で強制可。選手名なし(紙運用)・tie_format 未設定は素通し。adminは折りたたみ「オーダーを記録—任意」で名簿(datalist)から入力+ライブ赤ハイライト、needs_force は confirm→force 再送。オーダーは**コート上で交換後の事実の記録**(事前確定・公開はしない)。回帰: `test/tie-order.test.js`。台割はアプリ管理しない(紙運用のまま)。
- **選手マージ(リダイレクト方式)**: dup を物理削除せず `merged_into = survivorId` でリダイレクト。`MERGE_REPOINT` 定数(db.js)が付け替えテーブル一覧の正本（**新しい参照テーブルを追加したらここにも追加すること**）: `matches×5列 / achievements / entrants×2列 / push_subscriptions / tournament_players / coach_players / player_requests`。複合PK(tournament_players/coach_players)の衝突行はスナップショット+DELETE→undo時に復元。survivor 空欄補完前の値と付け替え対象行IDを `player_merges.refs_json` / `survivor_before_json` に記録(機械可読の台帳=undo の根拠)。**LIFO制約**: 同選手の関与する新しい未取消マージが残る場合は先に取り消すよう案内する。**undo は台帳に記録された行のみを戻す**（マージ後に survivor に新たに蓄積した成績は dup に移らない=設計上正しい）。KTTAドメインルール「古いID残し」を徹底し、adminの既定 survivor 選択は `created_at` 最古=先登録者。過去に物理削除済みの dup は遡及不能。一覧(`getPlayers`/`getPlayersLite`等)・重複候補・件数集計はすべて `merged_into IS NULL` で除外。`resolvePlayerId(id)` で最大10段のチェーン解決。`getPlayer(dupId)` は survivor を返し `redirected_from` を付与=旧ID公開URLが無改修で生存。`deletePlayer`/`updatePlayer` は merged 行を拒否。API: `POST /api/players/:id/merge`(merge_id 返却)・`GET /api/player-merges`・`POST /api/player-merges/:id/undo`(requireOwner)。回帰: `test/player-merge.test.js`。
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
- 優先度ロック: 種目優先(団体>混合>ダブルス>シングルス)/審判担当中/対戦中で呼出を拒否、`force`で強制。**審判担当中で拘束された場合は呼出行に「審判を解放」ボタン**(#1: 担当試合の審判を解任し呼べるようにする)。**呼出(callMatch)は大会 status='ongoing' のときのみ可**(#9・force不可)。
- **プッシュ通知/マイ選手 管理(#7/#10)**: `GET /api/admin/push/players`(選手名付き一覧) `POST /api/admin/push/players/:id/send`(個別) `POST /api/admin/push/broadcast`(一括) `DELETE /api/admin/push/players/:id`(強制削除)。全 requireAdmin。admin「📲 プッシュ通知/マイ選手」モーダル。`getOpsFingerprint` は審判の割当/解放(refc)も含み他端末へSSE反映。トーナメント表は BYE を非表示(#8・内部の自動進出は維持)、種目色は `TT.eventColor`(男女/形式)＋動的凡例(進行管理&観戦)。
- `recordOp`/`undoLastOp`: 影響行の before を `op_log.before_json` に保存、`collectForwardChain` でBYE連鎖もスナップショット対象。

## サーバの横断的関心事 (server.js)

- 認証: `X-Admin-Key`(定時間比較・本番未設定は503)、**オーナー(上級) `X-Owner-Key`**、監督 `X-Coach-Code`(失敗回数でIP一時ブロック)、審判トークン/コート別/パスコード。
- **オーナー権限(上級管理者)**: `requireOwner`(server.js)。全選手削除/DB全体の.dbダウンロード(`GET /api/owner/db-download`)/バックアップ・復元(`/api/admin/snapshots*`)/**アップロードから復元(`POST /api/owner/restore-upload`=.db/.db.gzを検証→KTTAスキーマ確認→安全網スナップ→差替・DR用)**/全データエクスポート(`/api/export/*`)/PII一括purge/大会削除/選手マージ を、普段使いの `ADMIN_KEY` から **第2の鍵 `OWNER_KEY`** で分離(管理画面の「🔒 システム管理（オーナー）」=普段は隠す危険操作の集約先)。per-IP 失敗ロック+監査ログ(`owner_audit`/`db.logOwnerAction`/`GET /api/owner/audit`、実施者名=自由記入)。**`OWNER_KEY` 未設定時は `requireAdmin` にフォールバック(opt-in=分離未活性・既存フローをロックアウトしない)**。実施者名は日本語可だが HTTP ヘッダは latin1 のため `X-Owner-Operator` は encodeURIComponent 済(サーバで decode)/POST は body.operator 優先。回帰: `server-smoke(q,r,s)`/`owner-fallback`。
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
