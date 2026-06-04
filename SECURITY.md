# SECURITY — KTTA Platform セキュリティ要件と多層防御

本書はアプリの認可モデル・レート制限・DDoS 多層防御をまとめる。詳細な Cloudflare 手順は
`CLOUDFLARE_SETUP.md`、デプロイは `ORACLE_CLOUD_DEPLOY.md` を参照。

## 認可モデル（アプリ層）

| 区分 | 認証 | 保護対象 |
|---|---|---|
| 運営者(admin) | `X-Admin-Key` ヘッダ・**定時間比較**・**本番未設定は503フェイルクローズ** | 生成/削除/編集/設定/リーグ生成/**名簿・受付帳票(roster/reception=PII)** |
| 監督(coach) | `X-Coach-Code`(英数字**8〜12桁**)・per-IP 失敗ロック(15回/5分) | 自チームの選手・申請 |
| 審判 | 審判トークン/コート別パスコード・失敗ロック(10回/5分) | 担当コートの結果報告 |
| 申込者 | 申込番号トークン(SHA-256ハッシュ保存・平文返却のみ)・認証なし | **自分の申込のみ**閲覧(PII非開示) |
| 公開(viewer) | なし | 対戦結果・順位表など PII を除いた閲覧データのみ |

- 未認証応答は `sanitizeTournamentPublic` で `referee_token`/`passcode`/`entry_gas_url` を除去。
- 公開順位表(団体リーグ)の `tie_results` は必要フィールドのみ射影し個人名を漏らさない。
- 出力は `lib/text.js` で escape、CSP・`X-Robots-Tag: noindex`。アップロードは xlsx/csv/pdf/画像のみ(SVG除外)・20MB。

## PII の保持・削除（申込連絡先）

申込原本(`entry_submissions`)とそれが作る `entrants` は連絡先(氏名/メール/電話。**未成年=保護者連絡先含む**)を
保持する。生PIIが無期限累積しないよう、以下を備える(構造・件数・集計・トークンは残し、連絡先だけ匿名化):

- **削除依頼(本人/保護者)対応**: `DELETE /api/submissions/:id/pii`(requireAdmin) → 当該申込の連絡先列・
  `payload_json` の連絡先・紐づく entrants の連絡先を匿名化し、閲覧トークンを失効。`db.deleteSubmissionPII`。
- **保持期間 purge**: `/etc/ktta.env` に **`PII_RETENTION_DAYS=N`**(例 90)を設定すると、起動時に「大会日が
  N日より前」の申込原本の連絡先を自動匿名化(`db.purgeOldSubmissionPII`)。**未設定(既定)は無効=自動破壊しない
  オプトイン**。手動実行は `POST /api/admin/purge-submission-pii?days=N`。
- **方針**: 大会レコード自体は選手DB公開のため保持するが、終了大会の連絡先は保持期間で匿名化する。削除依頼は
  上記APIで個別対応。トークンはログ/URLに出さない運用とする。

## レート制限・資源上限（アプリ層）

| 経路 | 上限 | env |
|---|---|---|
| 申込送信 | 10/分・IP | — |
| 申込番号照会 | 40/分・IP | — |
| **検索/全件系**(選手検索・横断検索・全試合検索・対戦比較) | **120/分・IP** | `PUBLIC_SEARCH_MAX` |
| GAS プロキシ | 20/分・IP | — |
| Push 購読 | 30/分・IP | — |
| SSE 同時接続 | 全体600 / IP200 | `SSE_MAX` `SSE_PER_IP` |
| JSON body | 10MB / text 1MB | — |
| ブラケット枠数 | **最大2048枠(約1024名)**・超過は即時拒否 | — |
| 組番号(seed) | 0..9999 にクランプ | — |

**会場NAT配慮**: 全観客が常時叩く大会ビュー(`/matches` `/standings` `/live`)には per-IP 制限を掛けない
(同一IPに最大200人規模の観客が居るため)。濫用向きの occasional な検索系のみ緩く制限する。

## DDoS 多層防御

> **重要**: 真の volumetric/分散DDoS は**アプリ単体では止められない**。一次防御はインフラ層。

1. **エッジ(一次防御・必須)**: **Cloudflare をプロキシ ON** で前段に置く(`CLOUDFLARE_SETUP.md`)。
   - L3/L4 volumetric 吸収、Bot Fight Mode、`Security Level: Medium`、必要に応じて Rate Limiting Rules
     (例: `/api/*` を 1IP あたり ~1000req/min)、攻撃時は **Under Attack Mode**。
   - キャッシュ: 静的(`/shared/*` `/viewer` `/admin`)を Cloudflare キャッシュに載せる。
2. **リバースプロキシ(nginx)**: `limit_req`/`limit_conn` で per-IP の burst を制限、`client_max_body_size 20m`、
   タイムアウト短縮で slow-loris を緩和。SSE(`/ops-stream`)は `proxy_buffering off` かつ長時間接続を許可。
3. **アプリ(二次防御・本リポジトリ)**: 上表のレート制限・資源上限・コスト境界(ブラケット枠数上限・seedクランプ・
   結果の段階取得)。高コストな状態変更(生成/取込)は `requireAdmin` 限定。
4. **OS/インフラ**: Oracle Cloud のセキュリティリスト/ファイアウォールで 80/443 のみ公開、fail2ban 等。

### 推奨 nginx 抜粋(例)
```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
server {
  client_max_body_size 20m;
  location /api/ { limit_req zone=api burst=60 nodelay; proxy_pass http://127.0.0.1:3000; }
  location /api/public/tournaments/ { # SSE を含む大会ビューは緩める
    proxy_pass http://127.0.0.1:3000; proxy_buffering off; proxy_read_timeout 1h;
  }
}
```
※ `rate`/`burst` は会場規模(同一NATの観客数)に合わせて調整。Cloudflare 経由なら `set_real_ip_from` で
真のクライアントIPを復元してから `limit_req` を効かせること(`TRUST_PROXY` と整合)。

## 外部API連携のリスクレジスタと対策（2026-06）

外部連携5種(① GAS申込中継 ② SMTPメール ③ Web Push ④ クラウド同期 ⑤ 外部QR)を次元別(security/availability/PII/abuse/offline/integrity)に多エージェントで構造化(33件)。会場オフライン/本部ローカル正本/小規模運営の文脈で優先度付けし、自己完結・高価値・低回帰の対策を実装した。

実装済みの対策:
- **[Critical] 外部QRの撲滅(オフライン破壊+トークン平文流出)**: 審判トークン入りURLが外部QR(`api.qrserver.com`)へGETクエリで平文送信され第三者ログに残る最重大リスクを解消。QRを同梱 `qrcode` でローカル生成に統一 — 機密URL(審判トークン/コート別ct)は `GET /api/admin/qr`(requireAdmin・`{svg}`をDOMへ直挿入=公開アクセスログにトークンを残さない)、非機密URL(観戦共有)は `GET /api/qr.svg`(公開・rateLimit 120/分・長さ上限512・純粋path SVG)。CSP `img-src` から `api.qrserver.com` を削除(grep 0件を回帰テストで固定)。会場オフラインでQR生成不可だった可用性欠陥も同時に解消。
- **[High] gas-statsプロキシの踏み台化**: 未認証で誰でもサーバを出口プロキシ化し `script.google.com` を任意GET+502 raw反射できた → `requireAdmin` 付与・集計URLは大会設定 `entry_gas_url` を正本化(クライアント供給URLは未設定大会の後方互換のみ)・本番は raw 非反射。
- **[High] クラウド同期チャネル**: 本番は平文HTTP同期を拒否(送信`pushTournamentToCloud`/受信`/api/sync/push` 双方・受信は `X-Forwarded-Proto` 準拠)、`/api/sync/push` に per-IP 失敗ロック(10回/5分→429)と任意の送信元IP allowlist(`SYNC_ALLOW_IPS`)、`SYNC_KEY<32`文字を起動時警告。
- **[High] Web Push のSSRF**: 購読 `endpoint` を検証(`isAllowedPushEndpoint`: https必須・既知プッシュhost(FCM/Mozilla/Apple/Windows)のみ・生IP/localhost/内部拒否)を `/api/push/subscribe` と `/api/coach/push/subscribe` に適用。VAPID秘密鍵は env 注入(`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`)を優先しDB平文保存を回避(未設定時のみ従来どおりDB自動生成)。
- **[Medium] 公開申込レスポンスのサニタイズ**: CORS全開放の `submit-team-entry` 応答から SMTP生エラー/GAS生応答を除去(成否boolのみ)。申込番号 `applicant_token` は本人閲覧に必要なため保持。
- **[Low] Turnstile検証のハング防止**: siteverify fetch に `AbortSignal.timeout(5000)`(到達不能時は従来どおり申込漏れ防止のフェイルオープン)。

過剰回避(YAGNI・見送り): mTLS/クライアント証明書同期、選手ポータルのフルID基盤、push endpointの能動probe、GAS連携の双方向同期化、メール送信の専用ジョブ基盤、Turnstileのfail-close化(会場WiFi断で正規申込を落とすため方針に反する)、全PIIのat-rest暗号化基盤。これらは小規模本部運営の脅威モデルに対し運用負荷過大と判断。

積み残し(運用/別系統・要手当): GAS Web App の匿名公開受け口(共有秘密なし)はアプリ層スパム対策を直POSTで全バイパスし得る → GAS側 `doPost` への共有シークレット検証(後方互換で追加可)を推奨。GASスプレッドシート/送信済メールに残るPIIは KTTA DB の purge 対象外 → ミラー先の同期削除・保持期間文書化が残課題。

## コート別 審判QR（#229 実運用化, 2026-06）

審判が台ごとに「自分のコートだけ」結果報告できる仕組みを実運用化。マスタ `referee_token`(サーバ内秘密)から各コートのキーを `HMAC-SHA256(referee_token, "court:N")` で導出(個別発行不要)。`GET /api/admin/tournaments/:id/referee-court-qr` がコート別の **ローカル生成QR + 到達可能なURL** を返す。`refBaseUrl` は本部PCが `localhost/127.0.0.1` でアクセスしている場合に会場LAN IPへ自動置換(QRを他端末から開けるように)。審判は担当コートのQRをスキャンするだけで入力画面へ(長いトークン付きURLの手入力=伝達難易度を回避)。別コートのキーでは `resolveRefereeCourt` のHMAC不一致で弾かれ、報告も `m.table_no === req.refCourt` で担当コート限定(E2E: コート1トークンでコート2詐称→403)。会場パスコード(#261)と併用で、リンク拡散時も会場外からは報告不可。管理UIに全コートQRの一覧表示+台掲示用の印刷シート(`_printCourtQR`)。

## オーナー権限（上級管理者・危険操作の隔離, 2026-06）

単一 `ADMIN_KEY` では、その鍵を持つ全員が**全選手削除・DB全体のエクスポート/.dbダウンロード・バックアップ/復元・PII一括purge・大会削除**をワンクリックで実行でき、事故でも悪意でも全消去/全PII持ち出しが可能だった。これらを第2の強い鍵 `OWNER_KEY` の背後へ隔離。

- **`requireOwner`(server.js)**: `OWNER_KEY` 設定時はオーナーキー必須(定時間比較 `safeEqualStr`・per-IP 失敗ロック 8回/10分→429)。`X-Owner-Key`(または body.owner_key)で受ける。
- **後方互換フォールバック**: `OWNER_KEY` 未設定時は `requireAdmin` にフォールバック(分離は opt-in=未活性)。**セキュリティは今より弱くならない**(無認証は常に拒否)/このコードが入った瞬間に既存のバックアップ・大会削除等がロックアウトされない。`GET /api/owner/configured` で分離が有効かを真偽だけ返し(鍵は漏らさない)、UIは未設定時にオーナー入力を求めない。
- **隔離した操作**: `/api/admin/snapshots*`(バックアップ/保存/DLは全PIIの.db/復元)・`/api/export/all`・`/api/export/players`・`DELETE /api/players`(全削除)・`/api/players/cleanup-invalid`・`/api/players/:id/merge`・`DELETE /api/tournaments/:id`・`DELETE /api/submissions/:id/pii`・`/api/admin/purge-submission-pii`。新設 `GET /api/owner/db-download`(一貫スナップショットを生成し `no-store`+`noindex` で.db返却=DB保存)・`POST /api/owner/players/delete-all`(**実施者名必須＋現在の選手数の打鍵確認＋実行前に自動バックアップ**)。
- **監査ログ `owner_audit`**: 上級操作を「いつ・何を・実施者(自由記入)・IP」で記録(`db.logOwnerAction`/`GET /api/owner/audit`)。共有鍵では個人識別できないため実施者名で最小の説明責任(draw_log と同思想)。
- **管理UI**: 「🔒 システム管理（オーナー）」に危険操作を集約(普段は隠す)。鍵はタブの sessionStorage に保持(閉じれば消える)。日本語の実施者名は HTTP ヘッダ(latin1)に直接入れられないため `X-Owner-Operator` は encodeURIComponent 済/POST は UTF-8 の body.operator 優先。
- 回帰: `server-smoke(q,r,s)`(隔離契約・.db返却・全削除の確認/バックアップ/監査)・`owner-fallback`(未設定時の後方互換と無認証拒否)。
- **運用**: 本番で分離を有効化するには `/etc/ktta.env` に `OWNER_KEY=<長い乱数>` を追記し `systemctl restart ktta`。ADMIN_KEY とは別の値にする。

## 監査履歴

2026-06 多エージェント敵対的監査(6次元×独立検証)で確定3件を修正:
- **[High]** 帳票群の認可漏れ(PII/金額露出): roster/reception に加え、追加点検で **receipts.xlsx/html/json
  (氏名+参加料)・aggregation.xlsx(集計)・match-cards.xlsx(対戦組)** も `requireAdmin` 欠落と判明 → 全8帳票に
  `requireAdmin` を付与。admin UI は直 `window.open(URL)`/`a.href` を廃し、管理キー付き fetch→Blob で
  開く/DLする `openAuthedHtmlWindow`/`downloadAuthedFile` に統一(従来 applicants.xlsx は ADMIN_KEY 設定時に
  DLが壊れていたが本修正で解消)。`entry-form.html`(埋込申込フォーム)のみ意図的に公開。
- **[High]** ブラケット生成の seed 無制限による配列爆発/OOM(DoS) → 枠数上限2048・seedクランプ・回帰テスト。
- **[Low]** 監督コード最短4文字 → 8文字に統一(生成器と同等エントロピー)。

良好な点(過剰修正回避): requireAdmin のフェイルクローズ・定時間比較、監督コード生成器の高エントロピー、
per-IP 失敗ロック、申込者トークンの SHA-256 ハッシュ保存、未認証レスポンスの PII 除去 は適切。

2026-06 抽選ドローの監査証跡(異業種=宝くじ/選挙レンズ):
- **抽選の一次記録 `draw_log`**: 誰(`drawn_by`)・いつ・どの種(`draw_seed`)・どの名簿(`entrants_snapshot`+SHA-256)・
  どの配置(`leaves_hash`)で引いたかを保存。引き直しは `superseded` 連鎖で**全試行を保持**(「気に入る並びが出るまで
  引き直したのでは」という最頻の疑念に件数で反証可能)。確定APIは `drawn_by` 必須(単一 `ADMIN_KEY` で個人識別
  できないための最小の説明責任)。`undoDraw` で誤抽選を可逆に。
- **過剰回避(YAGNI)**: アマ地区大会の脅威モデルとして commit-reveal/サーバ秘密種による grinding 防止は**実装しない**
  (記録・件数公開で十分。当日の正当なやり直しを硬直させない)。再現性(同種=同配置)は `id` 決定的整列で前提保証。
