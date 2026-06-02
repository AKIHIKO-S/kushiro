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
- `ADMIN_KEY` 未設定だと本番はフェイルクローズ(503)。主な環境変数: `PORT ADMIN_KEY NODE_ENV TRUST_PROXY DB_PATH SSE_MAX SSE_PER_IP LIVE_FP_TTL_MS SNAPSHOT_INTERVAL_MS PUSH_CONTACT SMTP_* PUBLIC_BASE_URL`。`PUBLIC_BASE_URL`(任意)はメール/フォーム埋込URLの正規オリジン。未設定時は `Host` ヘッダ由来(X-Forwarded-Host は信用しない=ホストヘッダ注入対策)。
- デプロイ手順は `ORACLE_CLOUD_DEPLOY.md` / `UPDATE_WORKFLOW.md`、運用は `OPERATIONS.md`。
- 課題管理は GitHub issues 不使用。コミットメッセージの `#番号` が課題ID。

## アーキテクチャ

モノリシックなバックエンド + 素のJS(ビルドなし)フロント。

```
server.js (Express, 3100行) ── db.js (better-sqlite3 DAL, 5700行)
  ├─ reports.js     集計表/領収書/対戦票 (xlsx) + 監督結果HTML
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
- **Phase4 (データ形状の完全性)**: `entrants` に `division`(一般/中学生/高校生/student)・`fee`(申込時に event_config から再計算した課金額)・`team_members`(団体メンバーのJSON配列。旧 note の "[団体] メンバー:…" 解析を置換)・`contact_name/email/tel`(連絡先をnoteから分離した構造化列。PIIを名簿表示から切離)・`applied_at`・`submission_id`・`partner_gender` を追加(全て ALTER 追加, `addECol`)。`entry_submissions` は「1回の申込」を丸ごと保存(原本JSON・連絡先・合計・作成entrant群・閲覧トークンのSHA-256ハッシュ)。`createTeamEntry` は entrant 単位で冪等dedup(`dupStmt`)し、申込番号トークン(`_genApplicantToken` 12桁4-4-4, 平文は返却のみ・DBはハッシュ)を発行。`getTeamRosters`/`getEntries` は `team_members` 列優先で note にフォールバック(`entrantMembers`)。`findEntrantDataIssues`/`bulkFixEntrantInference`/`fixEntrant` で種目名と gender/category の不整合・ふりがな欠落を検出/修正。回帰テストは `test/phase4.test.js`。

## コア進行ロジック (db.js) — 触るとき要注意

- `generateBracket(tid, event, opts)` (~2429): seed昇順→furigana順、2の累乗にBYE埋め、標準シード配置 or `as_drawn`(取込番号維持)。BYEは即完了→`autoAdvanceByes`で連鎖進行。
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
