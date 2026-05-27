# Render から Oracle Cloud への移行ガイド

KTTA Platform を **Render.com → Oracle Cloud Infrastructure (OCI) Always Free** に移行する手順です。

## 移行のメリット

| 項目 | Render Starter | Oracle Cloud Always Free |
|---|---|---|
| 月額 | $7 (約1,000円) | **0 円** (Always Free 永続) |
| CPU | 0.5 vCPU | **4 OCPU (ARM Ampere A1)** |
| メモリ | 512MB | **24GB** |
| ストレージ | 1GB SSD | **200GB ブロック** |
| 帯域 | 100GB/月 | **10TB/月 (egress)** |
| スリープ | なし | なし |
| HTTPS | 自動 | Let's Encrypt (自動・無料) |
| Python 不要 | ✓ | ✓ |
| 永続 DB | ✓ | ✓ |

## 前提条件

- Oracle Cloud アカウント（無料登録可・クレジットカード認証あり）
- ドメイン名（任意・無くても進められる）

## ステップ 1: Oracle Cloud VM を作る

### 1-1. アカウント作成

1. https://www.oracle.com/cloud/free/ → 「**Start for free**」
2. 国: **Japan** を選択
3. メール・パスワード設定
4. クレジットカード認証（請求は発生しません）
5. 完了後、**OCI コンソール** にログイン

### 1-2. ARM インスタンスを作成（Ampere A1, Always Free）

1. 左上ハンバーガー → **Compute** → **Instances**
2. **Create Instance** をクリック
3. 設定:
   - **Name**: `ktta-platform`
   - **Placement**: Always Free 対応 AD を選択
   - **Image**: **Canonical Ubuntu 22.04**
   - **Shape**: 「**Change shape**」 → **Ampere**
     - **VM.Standard.A1.Flex**
     - OCPU: **2**（Always Free は最大 4 まで可）
     - Memory: **12 GB**
   - **Network**: 既定の VCN/サブネット（Public IP 付き）
   - **SSH keys**: 「**Generate a key pair for me**」→ 秘密鍵をダウンロード
4. **Create** をクリック

⚠ **「Out of capacity」エラー** が出た場合: 別の AD を選択するか、しばらく時間を置いて再試行。Ampere A1 は人気のため枠不足することがあります。

### 1-3. パブリック IP を確認

作成完了後、インスタンス詳細画面で **Public IP** をコピー (例: `132.226.X.X`)。

### 1-4. ファイアウォール許可（重要！）

Oracle のセキュリティリストで 80/443 を開放:

1. 左メニュー → **Networking** → **Virtual Cloud Networks** → 自分の VCN を選択
2. **Security Lists** → **Default Security List** → **Add Ingress Rules**
3. 以下を追加:
   - **Source CIDR**: `0.0.0.0/0`
   - **Destination Port**: `80,443`
   - **Description**: HTTP/HTTPS
4. **Add Ingress Rules** をクリック

## ステップ 2: SSH で接続

### Mac の場合

```bash
chmod 600 ~/Downloads/ssh-key-XXXX.key
ssh -i ~/Downloads/ssh-key-XXXX.key ubuntu@132.226.X.X
```

### Windows (PowerShell)

```powershell
ssh -i C:\Users\xxx\Downloads\ssh-key-XXXX.key ubuntu@132.226.X.X
```

## ステップ 3: ドメイン名の設定（任意）

ドメインがあれば DNS A レコードを VM の IP に向ける。  
ない場合は無料の **sslip.io** や **nip.io** が使えます:

```
ホスト名例 (ドメインなし): 132-226-X-X.sslip.io
ホスト名例 (ドメインあり): ktta.example.jp
```

## ステップ 4: ワンライナーで一括セットアップ

SSH 接続後、以下のコマンドを実行:

```bash
sudo bash -c "$(wget -qO- https://raw.githubusercontent.com/AKIHIKO-S/kushiro/main/deploy/install.sh)" -- ktta.example.jp
```

ドメインを置き換えて実行してください。約 5-10 分で完了します。

スクリプトの内容:
- Node.js 22.x インストール
- アプリを `/opt/ktta` にクローン
- systemd サービス登録 + 起動
- nginx リバースプロキシ設定
- Let's Encrypt HTTPS 化
- ファイアウォール開放
- 毎日 02:00 自動バックアップ Cron

完了時に**管理キー**が表示されます — 必ず控えてください。

## ステップ 5: Render の DB を移行

### 5-1. Render から DB をダウンロード

Render Dashboard → サービス → **Shell** タブ → 以下を実行:

```bash
# DB のバックアップを作成
sqlite3 /var/data/tournament.db ".backup /tmp/backup.db"

# Base64 で出力 (コピペで取得可能)
base64 -w 0 /tmp/backup.db
```

出力された長い文字列をコピーします（数 MB なので長いです）。

### 5-2. Oracle VM で復元

```bash
# サービス停止
sudo systemctl stop ktta

# Base64 を貼り付けて復元
echo "<コピペしたBase64文字列>" | base64 -d | sudo -u ktta tee /var/data/tournament.db > /dev/null

# 権限確認
sudo chown ktta:ktta /var/data/tournament.db

# サービス再開
sudo systemctl start ktta

# 動作確認
curl -s http://localhost:3000/api/health | head
```

## ステップ 6: 動作確認

ブラウザで以下にアクセス:

- 管理画面: `https://ktta.example.jp/admin/`
- 観戦ビュー: `https://ktta.example.jp/viewer/live/`

管理キーを入力してログイン。Render と同じ状態でデータが見られれば成功です。

## ステップ 7: Jimdo / GAS の URL 更新

申込フォームを GAS で運用している場合、その URL は変更不要です。

Jimdo に貼っている iframe（観戦ビュー等）の URL は Oracle のドメインに張り替えてください:
- 旧: `https://kushiro.onrender.com/viewer/live/...`
- 新: `https://ktta.example.jp/viewer/live/...`

## ステップ 8: Render を停止

Oracle で問題なく動作することを確認したら:

1. Render Dashboard → サービス → **Suspend** または **Delete**
2. 月額課金が停止される

## 運用コマンド集

### ログ確認

```bash
sudo journalctl -u ktta -f       # リアルタイム
sudo journalctl -u ktta --since "1 hour ago"
```

### 再起動

```bash
sudo systemctl restart ktta
```

### アプリ更新（GitHub から pull）

```bash
cd /opt/ktta
sudo -u ktta git pull
sudo -u ktta npm install --omit=dev
sudo systemctl restart ktta
```

### 手動バックアップ

```bash
sudo /opt/ktta/deploy/backup.sh
# → /var/data/backups/tournament-YYYYMMDD-HHMMSS.db.gz
```

### 復元

```bash
sudo systemctl stop ktta
sudo /opt/ktta/deploy/restore.sh /var/data/backups/tournament-XXXX.db.gz
sudo systemctl start ktta
```

## トラブルシューティング

### `npm install` が遅い / エラー
ARM 環境で `better-sqlite3` のビルドが必要です。`build-essential` がインストールされているか確認:
```bash
sudo apt install -y build-essential python3
```

### Let's Encrypt 失敗
DNS が伝播していない可能性。1-2時間待って再試行:
```bash
sudo certbot --nginx -d ktta.example.jp
```

### ポート 80/443 にアクセスできない
Oracle の **Security List** だけでなく Ubuntu の `iptables` も開放が必要:
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### メモリ不足
Always Free A1 は 24GB まで利用可。OCPU と Memory を増やしてインスタンスを Edit:
- Compute → Instance → Edit → Shape configuration

## 自動デプロイの追加 (任意)

GitHub から自動 deploy したい場合は **GitHub Actions + SSH** が便利:

```yaml
# .github/workflows/deploy-oracle.yml
name: Deploy to Oracle
on:
  push: { branches: [main] }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.ORACLE_HOST }}
          username: ubuntu
          key: ${{ secrets.ORACLE_SSH_KEY }}
          script: |
            cd /opt/ktta
            sudo -u ktta git pull
            sudo -u ktta npm install --omit=dev
            sudo systemctl restart ktta
```

GitHub リポジトリ Settings → Secrets で `ORACLE_HOST` と `ORACLE_SSH_KEY` を設定。

## まとめ

これで月額 $7 が **0 円** になり、性能も Render Starter の数倍になります。  
**Always Free** なので将来料金が発生することもありません（Oracle が無料枠を継続する限り）。
