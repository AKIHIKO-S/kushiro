# Oracle Cloud Free Tier デプロイ手順 — KTTA Platform

**永久無料** で KTTA Platform を運用する完全ガイド。
所要時間: 約 **60〜90分** (初回のみ・Oracleアカウント作成含む)。

---

## なぜ Oracle Cloud か?

| 項目 | Oracle Cloud Free | Render Starter | さくらのVPS |
|---|---|---|---|
| 月額 | **¥0 (永久)** | ¥1,050 | ¥685 |
| CPU | **4 OCPU (ARM Ampere)** | 0.5 vCPU | 1 vCPU |
| メモリ | **24 GB** | 512 MB | 1 GB |
| ディスク | 200 GB | 1 GB | 50 GB SSD |
| トラフィック | 10 TB/月 | 100 GB/月 | 無制限 |
| 場所 | 東京/大阪 | 東京 | 東京/大阪 |
| 自由度 | フル (root) | 制限 | フル (root) |

**Oracle Cloud Free は KTTA Platform 規模なら 100台動かせる程の余裕** があります。

---

## ⚠ 事前注意

1. **クレジットカード必須** (本人確認用・課金されないが事前に登録要)
2. **「Always Free」だけ使う限り完全無料** (有料リソースを誤って作らないよう注意)
3. **地域選択は重要**: アカウント作成時に「Home Region」を **Japan East (Tokyo)** または **Japan Central (Osaka)** に設定 (後から変更不可)
4. **インスタンス容量不足エラー**: 人気リージョンは時間帯によって作成失敗することあり (root cause: 無料枠は他ユーザーと競争)。失敗したら数時間後にリトライ

---

## ステップ1: Oracle Cloud アカウント作成 (20分)

1. https://www.oracle.com/jp/cloud/free/ にアクセス
2. **「無料で始める」** をクリック
3. メール認証 → パスワード設定
4. プロフィール入力:
   - 国: **Japan**
   - 名前 (アルファベット)
   - 住所 (アルファベット)
   - 電話番号 (SMS認証)
5. **ホームリージョン選択**: **「Japan East (Tokyo)」** を強く推奨 (一度決めると変更不可)
6. クレジットカード登録 ($1 のオーソリ確認のみ・実際の請求はなし)
7. ダッシュボードログイン

---

## ステップ2: Compute インスタンス作成 (15分)

### A. SSH公開鍵の生成 (ローカル)

```bash
# Mac/Linux
ssh-keygen -t ed25519 -C "ktta@kushiro" -f ~/.ssh/ktta_oracle
# 何もEnterで OK (パスフレーズ任意)

# 公開鍵を表示 (これをコピー)
cat ~/.ssh/ktta_oracle.pub
```

### B. インスタンス作成

1. Oracle Cloud Console → 左上ハンバーガー → **「Compute」 → 「Instances」**
2. **「Create Instance」** をクリック
3. 設定:
   - **Name**: `ktta-platform`
   - **Image**: **Canonical Ubuntu 22.04** に変更
   - **Shape**: **Change shape** → **Ampere** → **VM.Standard.A1.Flex** を選択
     - OCPU: **2** (4まで無料・最初は2で十分)
     - Memory: **12 GB** (2 OCPU なら 12GB が標準)
   - **Networking**: デフォルト VCN を使用 (Auto)
     - **「Assign a public IPv4 address」** にチェック
   - **SSH keys**:
     - **「Paste public keys」** を選択
     - 上で表示した `cat ~/.ssh/ktta_oracle.pub` の内容を貼付け
   - **Boot volume**: デフォルト (50GB)
4. **Create** をクリック
5. 約2-3分で **「Running」** になる
6. **Public IPv4 Address** をコピー (例: `123.45.67.89`)

### C. 容量不足エラーの対処

`Out of host capacity` エラーが出た場合:
- 数時間後にリトライ (時間帯による)
- もう一方の Japan リージョン (Osaka) を試す
- Shape を A1.Flex (ARM) → VM.Standard.E2.1.Micro (AMD) に変更 (ただし 1GB メモリのみ)

---

## ステップ3: ファイアウォール設定 (10分)

### A. Security List で 80/443 を開放

1. Oracle Cloud Console → **「Networking」 → 「Virtual Cloud Networks」**
2. 自動作成された VCN をクリック (例: `vcn-20260526-...`)
3. 左下 **「Security Lists」 → 「Default Security List」**
4. **「Add Ingress Rules」** をクリック
5. ルール1 (HTTP):
   ```
   Source CIDR:        0.0.0.0/0
   IP Protocol:        TCP
   Destination Port:   80
   Description:        HTTP
   ```
6. もう一度 **「+ Another Ingress Rule」** をクリック → ルール2 (HTTPS):
   ```
   Source CIDR:        0.0.0.0/0
   IP Protocol:        TCP
   Destination Port:   443
   Description:        HTTPS
   ```
7. **Add Ingress Rules** で保存

### B. インスタンス内 iptables/ufw 設定 (Ubuntu)

SSH 接続後、コマンドで OS ファイアウォールも開ける:

```bash
ssh -i ~/.ssh/ktta_oracle ubuntu@<Public IP>

# Ubuntu 22.04 では iptables ルールを永続化
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

---

## ステップ4: KTTA Platform インストール (15分)

SSH 接続したまま以下を実行:

```bash
# 1. Git で取得
sudo apt update && sudo apt install -y git
git clone https://github.com/AKIHIKO-S/kushiro.git /tmp/ktta
sudo mv /tmp/ktta /opt/ktta
cd /opt/ktta

# 2. install.sh を実行 (依存全部入り)
sudo ./deploy/install.sh ktta.kushirotta.com   # ← 後でドメインに変更
```

`install.sh` が以下を自動実行:
- Node.js 20 インストール
- Python 3 + openpyxl
- アプリユーザー `ktta` 作成
- npm install
- /etc/ktta.env (ADMIN_KEY 自動生成)
- systemd ユニット登録 + 自動起動
- Nginx 設定
- crontab で毎日2時バックアップ

注意: ドメイン未設定時は Let's Encrypt の HTTPS 化はスキップされる (後ほど実施)

---

## ステップ5: お名前.com DNS でサブドメイン設定 (5分)

### A. お名前.com 側

1. お名前.com Navi にログイン
2. **「DNS設定」 → 該当ドメイン (例: kushirotta.com)**
3. 「DNSレコード設定を利用する」を選択
4. **A レコード** を追加:
   ```
   ホスト名:  ktta
   タイプ:    A
   TTL:       3600
   値:        <Oracle Cloud の Public IP>
   ```
5. **確認画面へ進む → 設定する**
6. 反映に 5〜60分

### B. 確認

ローカルから:
```bash
dig ktta.kushirotta.com +short
# Oracle の IP が返ればOK
```

---

## ステップ6: Let's Encrypt SSL (5分)

DNS 反映を確認したら Oracle 内で:

```bash
ssh -i ~/.ssh/ktta_oracle ubuntu@<Public IP>
sudo certbot --nginx -d ktta.kushirotta.com
```

- 「Enter email」 → 自分のメール
- 「Agree」 → Y
- 「Newsletter」 → N
- 「Redirect HTTP → HTTPS」 → 2 (Redirect)

完了すれば https://ktta.kushirotta.com で SSL 化される。

---

## ステップ7: KTTA Platform 初期設定 (5分)

1. ブラウザで `https://ktta.kushirotta.com/admin/` を開く
2. **管理キーを確認**:
   ```bash
   ssh -i ~/.ssh/ktta_oracle ubuntu@<Public IP>
   sudo cat /etc/ktta.env | grep ADMIN_KEY
   ```
3. 管理画面の設定 (⚙) → 管理キー入力 → 保存
4. 「本番URL設定」 → `https://ktta.kushirotta.com`
5. 印鑑画像をアップロード
6. 「本番診断パネル」で動作確認

---

## ステップ8: 自動デプロイ設定 (10分・任意)

GitHub push で自動デプロイされるようにする (Oracle Cloud には Render のような自動デプロイがないため、独自設定が必要):

### A. SSH キーを GitHub Actions に登録

```bash
# Oracle 上で
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
# 秘密鍵を表示 (GitHub Secrets に貼付ける)
cat ~/.ssh/github_deploy
```

### B. GitHub リポで Secrets 設定

GitHub リポ → Settings → Secrets and variables → Actions → New repository secret
- `ORACLE_HOST`: Public IP
- `ORACLE_SSH_KEY`: 上記の秘密鍵全文 (`-----BEGIN OPENSSH PRIVATE KEY-----` から `-----END...` まで)

### C. GitHub Actions workflow ファイル

ローカルで `.github/workflows/deploy.yml` を作成:

```yaml
name: Deploy to Oracle Cloud
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: SSH and deploy
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.ORACLE_HOST }}
          username: ubuntu
          key: ${{ secrets.ORACLE_SSH_KEY }}
          script: |
            cd /opt/ktta
            sudo git pull origin main
            sudo -u ktta npm install --omit=dev
            sudo systemctl restart ktta
```

push して反映:
```bash
git add .github/workflows/deploy.yml
git commit -m "ci: Oracle Cloud 自動デプロイ"
git push
```

→ 以後 `git push` で 1分以内に本番反映。

---

## 運用コマンドまとめ

```bash
# SSH 接続
ssh -i ~/.ssh/ktta_oracle ubuntu@<Public IP>

# サービス状態
sudo systemctl status ktta

# ログ確認 (リアルタイム)
sudo journalctl -u ktta -f

# 再起動
sudo systemctl restart ktta

# DB バックアップ (手動)
sudo /opt/ktta/deploy/backup.sh

# DB 復元
sudo /opt/ktta/deploy/restore.sh --list
sudo /opt/ktta/deploy/restore.sh 20260711-020001

# システムアップデート
sudo apt update && sudo apt upgrade -y
```

---

## トラブルシューティング

### インスタンス作成で `Out of host capacity`
- 数時間後リトライ (時間帯による)
- 大阪リージョン (Japan Central) を試す
- A1.Flex (ARM) ではなく E2.1.Micro (AMD) を試す (ただし1GB制限)

### `systemctl start ktta` がエラー
```bash
sudo journalctl -u ktta -n 50
# better-sqlite3 のビルドエラーなら:
cd /opt/ktta && sudo -u ktta npm rebuild better-sqlite3
```

### Nginx 502 Bad Gateway
- Node プロセスが起動していない
- `sudo systemctl restart ktta && sudo systemctl restart nginx`

### Let's Encrypt 失敗
- DNS が反映されていない (dig コマンドで確認)
- ファイアウォール (Security List + iptables 両方) で 80 が開いてない

### Oracle が "Idle Instance" として停止
- Always-Free インスタンスは長期間 CPU 使用率が低いと停止される可能性
- 対策: cron で定期的に何かを動かす
   ```bash
   crontab -e
   # 10分ごとに健全性チェック
   */10 * * * * curl -s http://localhost/api/health > /dev/null
   ```

---

## メリット・デメリット まとめ

### メリット
- **完全無料・期限なし**
- 24GB メモリの余裕
- 完全な root 権限
- 東京/大阪リージョン
- 10TB トラフィックは事実上無制限

### デメリット
- セットアップに 1時間程度
- アカウント作成にクレジットカード要 (オーソリのみ・課金されない)
- 容量不足エラーが時々発生
- 完全に自己管理 (Render のような GUI 管理画面なし)
- 万一トラブル時のサポートは英語

---

## 推奨運用カレンダー

| 時期 | 作業 |
|---|---|
| 毎日 | 02:00 自動バックアップ (設定済) |
| 週1回 | ログ確認 `sudo journalctl -u ktta --since '1 week ago' | grep -i error` |
| 月1回 | `sudo apt update && sudo apt upgrade -y` |
| 年1回 | OS major アップグレード (Ubuntu 22.04 → 24.04 LTS 等) |
| Oracle | 月1回はインスタンスにアクセス (idle detection 回避) |

---

## まとめ

| 項目 | 値 |
|---|---|
| サーバー | Oracle Cloud Always-Free (Ampere ARM 2 OCPU / 12GB) |
| ドメイン | `ktta.kushirotta.com` (お名前.com 管理) |
| アプリ | KTTA Platform (Node.js + SQLite) |
| 自動デプロイ | GitHub Actions (push で1分以内) |
| HTTPS | Let's Encrypt (90日自動更新) |
| バックアップ | 毎日 02:00 自動 (30日保持) |
| **月額** | **¥0** |

サーバーリソースに余裕があるので、将来的に他システム (例: 卓球関連の練習予約・成績統計サイト等) も同じインスタンスで動かせます。
