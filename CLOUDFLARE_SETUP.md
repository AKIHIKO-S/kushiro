# Cloudflare 導入ガイド (KTTA Platform)

結果報告の「反応が遅い」の主因は **サーバーCPUではなく地理的な距離 + 無料枠の帯域**。
Cloudflare を前段に置くと、利用者は日本国内のエッジ (東京/大阪) に接続でき、
静的ファイル (admin/viewer の HTML・JS・CSS、`/live` の2秒キャッシュ) が
日本のエッジから返るため体感が大きく改善する。

> サーバー側は **対応済み** (commit `7d9d5b0`)。
> `app.set("trust proxy", true)` と `CF-Connecting-IP` 判定を入れたので、
> Cloudflare を通しても本来のクライアントIPでレート制限が効く。
> **残りはドメインと Cloudflare 側の設定 = ご本人の操作**。

構成は2つ:

| | 構成#1 オラクル前段 | 構成#2 会場PC + Tunnel |
|---|---|---|
| いつ | 今すぐ | 運用本番 |
| サーバー | Oracle Cloud のまま | 会場のPCで動かす |
| 解決する課題 | 距離 (エッジ配信・キャッシュ) | 距離 **+ CPU** の両方 |
| 公開方法 | DNS A レコード (proxied) | Cloudflare Tunnel |
| ドメイン | 必須 | 本番は必須 / テストは不要 |

---

## ⚠ 最重要の前提: 独自ドメインが必須

Cloudflare の無料プラン (proxy / CDN) は **ドメイン単位 (ゾーン)** で動く。
そのドメインのネームサーバーを Cloudflare に向けることで初めて proxy が使える。

- **`140-245-94-114.nip.io` や 素のIPは proxy できない** (nip.io のNSは他人の管理下で変更不可)。
- 既存ドキュメント (`ORACLE_CLOUD_DEPLOY.md`) の想定ドメインは **`ktta.kushirotta.com` (お名前.com)**。

### ケース判定

- **`kushirotta.com` を既にお名前.comで持っている** → 構成#1 ステップ1へ。
- **まだ持っていない** → 先にドメイン取得:
  - お名前.com / Value Domain / ムームードメイン などで `.com` 年1,000〜1,500円程度。
  - Cloudflare Registrar (原価提供・更新も安い) でもよい。アカウント作成後に登録可能。
  - ※ ドメイン購入・支払い・アカウント作成は **ご本人が実施**（こちらでは代行不可）。

---

# 構成#1: Oracle 前段 Cloudflare (今すぐ)

## ステップ1: Cloudflare 無料アカウント + サイト追加

1. https://dash.cloudflare.com/sign-up で無料アカウント作成（ご本人）。
2. 「Add a site」→ `kushirotta.com` を入力。
3. プランは **Free** を選択。
4. Cloudflare が既存DNSを自動スキャン → 一覧が出る。

## ステップ2: ネームサーバーを Cloudflare に変更 (お名前.com 側)

1. ステップ1の最後に Cloudflare が割り当てる NS が2つ表示される
   （例: `xxx.ns.cloudflare.com` / `yyy.ns.cloudflare.com`）。
2. **お名前.com Navi** にログイン → 該当ドメイン → 「ネームサーバー設定」
   → 「その他のネームサーバーを使う」→ 上記2つを入力 → 保存。
3. 反映に最大24時間（多くは数十分）。Cloudflare 側が「Active」になれば完了。

> この時点で DNS の管理は **お名前.com から Cloudflare に移る**。
> 既存レコード（メール用 MX など）があれば、Cloudflare の DNS 画面に
> 同じ内容が引き継がれているか必ず確認すること。

## ステップ3: DNS A レコード (proxied) を追加

Cloudflare ダッシュボード → 対象ドメイン → **DNS** → 「Add record」:

```
Type:    A
Name:    ktta
IPv4:    140.245.94.114
Proxy:   Proxied  (オレンジの雲 ON) ★ここが肝
TTL:     Auto
```

- オレンジ雲 ON = Cloudflare 経由（CDN・キャッシュ・隠蔽が効く）。
- グレー雲 = DNS のみ（proxy なし）。

## ステップ4: SSL/TLS モード

Cloudflare → **SSL/TLS** → 「Overview」:

- 推奨は **Full (strict)**（エッジ⇔オリジン間も暗号化 + 証明書検証）。
- そのためにオリジン (nginx) に有効な証明書が要る → ステップ5。
- まだ証明書が無い段階で接続確認したいだけなら一時的に **Full**（検証なし）でも可。
- **Flexible は使わない**（オリジンが平文 + リダイレクトループの原因）。

## ステップ5: nginx をドメイン対応にする（オリジン証明書）★私が手伝える

proxy 越しでも更新不要で確実なのは **Cloudflare Origin Certificate（15年）**。

1. Cloudflare → SSL/TLS → 「Origin Server」→ 「Create Certificate」
   → ホスト名 `*.kushirotta.com, kushirotta.com` → 発行。
2. 表示された **証明書** と **秘密鍵** を Oracle サーバー上に保存:
   ```bash
   ssh -i ~/.ssh/ktta_oracle ubuntu@140.245.94.114
   sudo mkdir -p /etc/ssl/cloudflare
   sudo nano /etc/ssl/cloudflare/ktta.pem    # 証明書を貼り付け
   sudo nano /etc/ssl/cloudflare/ktta.key    # 秘密鍵を貼り付け
   sudo chmod 600 /etc/ssl/cloudflare/ktta.key
   ```
   > 秘密鍵は **サーバー上だけ**に置く。チャットやリポジトリには貼らない。
3. nginx の server ブロックを編集（`/etc/nginx/sites-available/ktta` 等）:
   ```nginx
   server {
       listen 443 ssl;
       server_name ktta.kushirotta.com;

       ssl_certificate     /etc/ssl/cloudflare/ktta.pem;
       ssl_certificate_key /etc/ssl/cloudflare/ktta.key;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
4. 反映:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. Cloudflare の SSL/TLS を **Full (strict)** に。

> ※ Let's Encrypt を使い続ける場合は、proxy を一時的にグレー雲にして
> `sudo certbot --nginx -d ktta.kushirotta.com` で取得 → オレンジ雲に戻す。
> ただし60日ごとの更新が proxy 越しで失敗しやすいので Origin Certificate 推奨。

## ステップ6: 動作確認 + リンク更新

1. ブラウザで `https://ktta.kushirotta.com/admin/` `…/viewer/` を開いて確認。
2. **Jimdo の埋め込み**・**審判ページのリンク/QR**・**観戦ビューの共有URL** を
   `https://140-245-94-114.nip.io/...` → `https://ktta.kushirotta.com/...` に差し替え。
3. nip.io も当面は生かしておけば、移行中の保険になる。

## ステップ7: 推奨設定（無料枠）

- **SSL/TLS → Edge Certificates → Always Use HTTPS: ON**。
- **Speed → Optimization**: Auto Minify は不要（こちらで配信最適化済み）。
- **Caching**: `/live` や HTML は `Cache-Control` 済みなのでデフォルトでOK。
  さらに攻めるならキャッシュルールで静的拡張子の Edge TTL を延ばす。
- **Security → Bot Fight Mode**: 観戦者が多いイベントでは
  正規利用者を巻き込む誤検知に注意。最初は OFF 推奨。
- **Caching → Configuration → Development Mode**: 設定変更直後の検証時だけ一時ON。

---

# 構成#2: 会場PC + Cloudflare Tunnel (運用本番)

サーバーを **会場のPCで動かし**、Cloudflare Tunnel で公開する。
オリジンが会場（=利用者の近く）かつ Oracle の非力なCPUから解放されるため、
**距離とCPUの両方**が解決する。配信は引き続き Cloudflare エッジ経由。

## まず無料で試す（ドメイン不要）

会場PCにサーバー一式を置いて起動した状態で:

```bash
# cloudflared をインストール後
cloudflared tunnel --url http://localhost:3000
```

→ `https://ランダム.trycloudflare.com` という一時URLが出る。
アカウントもドメインも不要で、その場で動作確認できる
（URLは起動ごとに変わる・本番には使わない）。

## 本番: 名前付きトンネル（同じドメインを再利用）

```bash
cloudflared tunnel login                       # ブラウザでドメイン認可
cloudflared tunnel create ktta-venue           # トンネル作成 (UUID発行)
# 設定ファイル ~/.cloudflared/config.yml
#   tunnel: <UUID>
#   credentials-file: /home/user/.cloudflared/<UUID>.json
#   ingress:
#     - hostname: ktta.kushirotta.com
#       service: http://localhost:3000
#     - service: http_status:404
cloudflared tunnel route dns ktta-venue ktta.kushirotta.com
cloudflared tunnel run ktta-venue              # 常駐はサービス登録 (install)
```

- 構成#1 の A レコードと **同じ `ktta.kushirotta.com` を切り替えるだけ**。
  当日は DNS を Tunnel に向け、終わったら Oracle (#1) に戻す運用も可能。
- DB は SQLite ファイル (`*.db` + `-wal`/`-shm`) を会場PCにコピーして移行。
- **運用上の注意**: 会場PCの電源・ネット断対策、終了後のDBバックアップ、
  当日朝の起動チェックをルーチン化。

---

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| ERR_TOO_MANY_REDIRECTS | SSL を Flexible にしている → **Full / Full(strict)** に変更 |
| 521 Web Server Is Down | オリジン到達不可 → nginx 起動・80/443開放・IP確認 |
| 522 Connection Timed Out | ファイアウォール/Security List で Cloudflare を遮断 |
| 526 Invalid SSL Certificate | Full(strict) で証明書不一致 → Origin Certificate を導入 |
| 反映されない | DNS未浸透 or Development Mode 切り忘れ |

---

## 私 (Claude) ができること / できないこと

**できない（ご本人のみ）**: Cloudflare アカウント作成、ドメイン購入・支払い、
ネームサーバー変更、各種同意・認可。

**手伝える**: nginx 設定の具体的な編集内容、Tunnel の config.yml 作成、
Jimdo/審判/観戦リンクの一括差し替え、DNS切替後の動作検証、DB移行手順。
