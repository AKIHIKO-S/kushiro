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
